import { createHash } from "node:crypto";
import { LruMap } from "../utils/lru-map";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ProviderRegistry } from "../providers/registry";
import type {
  ChatMessage,
  ProviderResult,
  ReasoningEffort,
  UnifiedToolDefinition,
} from "../types";
import { makeId } from "../utils/ids";
import { extractTextContent } from "../utils/prompt";
import { resolveReasoningEffort } from "../utils/reasoning";
import { normalizeAssistantResult, parseAssistantPayloadText } from "../utils/assistant-output";
import {
  chatCompletionsRequestSchema,
  responsesRequestSchema,
  imageGenerationsRequestSchema,
  documentGenerationsRequestSchema,
  audioSpeechRequestSchema,
  audioTranscriptionsRequestSchema,
} from "../validation";

// Cache tool definitions for sessions. n8n occasionally drops them on subsequent turns.
const multiTurnToolsCache = new LruMap<string, UnifiedToolDefinition[]>(100);

export function getSessionSignature(messages: ChatMessage[]): string {
  const firstSystem = messages.find((m) => m.role === "system")?.content || "";
  const firstUser = messages.find((m) => m.role === "user")?.content || "";
  const content = `${typeof firstSystem === "string" ? firstSystem : JSON.stringify(firstSystem)}|${typeof firstUser === "string" ? firstUser : JSON.stringify(firstUser)}`;
  return createHash("sha256").update(content).digest("hex");
}

interface OpenAiRoutesOptions {
  registry: ProviderRegistry;
  n8nApiKeys: Set<string>;
  defaultReasoningEffort?: ReasoningEffort;
}

export const openAiRoutes: FastifyPluginAsync<OpenAiRoutesOptions> = async (
  app,
  options,
) => {
  app.addHook("preHandler", async (request, reply) => {
    if (!isAuthorized(request, options.n8nApiKeys)) {
      sendOpenAiError(reply, 401, "Invalid API key.", "invalid_api_key");
      return reply;
    }
  });

  app.get("/models", async () => ({
    object: "list",
    data: options.registry.listModels().map((model) => ({
      id: model.id,
      object: "model",
      created: 0,
      owned_by: model.providerId,
    })),
  }));

  app.post("/chat/completions", async (request, reply) => {
    const validationResult = validateBody(request.body, chatCompletionsRequestSchema);
    if (!validationResult.success) {
      request.log.warn(
        {
          error: validationResult.error,
          body: typeof request.body === "object" ? JSON.stringify(request.body).slice(0, 2000) : String(request.body)
        },
        "Chat completions validation failed"
      );
      return sendOpenAiError(reply, 400, validationResult.error, "invalid_request_error");
    }
    return await handleChatCompletionsRequest(
      validationResult.data,
      reply,
      options.registry,
      options.defaultReasoningEffort,
    );
  });

  app.post("/messages", async (request, reply) => {
    const validationResult = validateBody(request.body, chatCompletionsRequestSchema);
    if (!validationResult.success) {
      return sendOpenAiError(reply, 400, validationResult.error, "invalid_request_error");
    }
    return await handleChatCompletionsRequest(
      validationResult.data,
      reply,
      options.registry,
      options.defaultReasoningEffort,
    );
  });

  app.post("/message", async (request, reply) => {
    const validationResult = validateBody(request.body, chatCompletionsRequestSchema);
    if (!validationResult.success) {
      return sendOpenAiError(reply, 400, validationResult.error, "invalid_request_error");
    }
    return await handleChatCompletionsRequest(
      validationResult.data,
      reply,
      options.registry,
      options.defaultReasoningEffort,
    );
  });

  app.post("/responses", async (request, reply) => {
    const validationResult = validateBody(request.body, responsesRequestSchema);
    if (!validationResult.success) {
      // Log the failing request body for debugging
      request.log.warn(
        {
          error: validationResult.error,
          body: typeof request.body === "object" ? JSON.stringify(request.body).slice(0, 2000) : String(request.body)
        },
        "Responses API validation failed"
      );
      return sendOpenAiError(reply, 400, validationResult.error, "invalid_request_error");
    }

    const body = validationResult.data;

    // We do support a basic pseudo-stream now
    const isStream = Boolean(body.stream);

    const inputMessages = normalizeResponsesInput(body.input);
    const instructions = sanitizeInstructions(body.instructions);

    const messages: ChatMessage[] = [];
    if (instructions) {
      messages.push({
        role: "system",
        content: instructions,
      });
    }
    messages.push(...inputMessages);

    if (messages.length === 0) {
      return sendOpenAiError(reply, 400, "input or instructions must be provided.");
    }

    const rawTools = body.tools ?? body.functions ?? [];
    const tools = normalizeTools(rawTools);
    if (tools.length === 0 && rawTools.length > 0) {
      app.log.warn(
        {
          model: body.model,
          tool_payload_type: "array",
        },
        "No tools normalized from /responses request payload.",
      );
    }

    const sessionSig = getSessionSignature(messages);
    if (tools.length > 0) {
      multiTurnToolsCache.set(sessionSig, tools);
    } else if (messages.length > 2) {
      const cachedTools = multiTurnToolsCache.get(sessionSig);
      if (cachedTools && cachedTools.length > 0) {
        tools.push(...cachedTools);
        app.log.debug(
          { model: body.model, sessionSig, cachedToolsCount: cachedTools.length },
          "Restored multi-turn tools from cache for /responses request.",
        );
      }
    }

    // Debug: trace when tools are missing on multi-turn responses requests
    if (tools.length === 0) {
      const hasToolResults = inputMessages.some(m => m.role === "tool" || m.tool_call_id);
      if (hasToolResults || inputMessages.some(m => m.role === "assistant")) {
        app.log.debug(
          {
            model: body.model,
            messageCount: inputMessages.length + messages.length,
            hasToolResults,
            rawToolsLength: rawTools.length,
          },
          "Multi-turn /responses request has no tools defined — tool calls from provider will pass through un-normalized.",
        );
      }
    }

    try {
      const reasoningEffort = resolveReasoningEffort(body, options.defaultReasoningEffort);
      const result = normalizeAssistantResult(await options.registry.runModel(body.model, {
        requestId: makeId("req"),
        messages,
        tools,
        reasoningEffort,
        metadata: body as Record<string, unknown>,
      }));
      logBlankAssistantResult(app.log.warn.bind(app.log), body.model, result, "/responses");

      const output: unknown[] = [];
      if (result.outputText) {
        output.push({
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: result.outputText,
            },
          ],
        });
      }

      for (const call of result.toolCalls) {
        // Log tool calls for debugging
        app.log.debug(
          {
            tool_call_id: call.id,
            tool_name: call.name,
            tool_arguments: call.arguments.slice(0, 500),
          },
          "Returning tool call"
        );
        output.push({
          type: "function_call",
          id: call.id,
          call_id: call.id,
          name: call.name,
          arguments: call.arguments,
        });
      }

      if (isStream) {
        reply.raw.setHeader("Content-Type", "text/event-stream");
        reply.raw.setHeader("Cache-Control", "no-cache");
        reply.raw.setHeader("Connection", "keep-alive");

        const chunkData = {
          id: makeId("resp"),
          object: "response.chunk",
          created_at: Math.floor(Date.now() / 1000),
          status: "completed",
          model: body.model,
          output_text: result.outputText,
          output,
        };

        reply.raw.write(`data: ${JSON.stringify(chunkData)}\n\n`);
        reply.raw.write("data: [DONE]\n\n");
        reply.raw.end();
        return reply;
      }

      return {
        id: makeId("resp"),
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        status: "completed",
        model: body.model,
        output_text: result.outputText,
        output,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
        },
      };
    } catch (error) {
      return handleModelError(reply, error);
    }
  });

  app.post("/images/generations", async (request, reply) => {
    const validationResult = validateBody(request.body, imageGenerationsRequestSchema);
    if (!validationResult.success) {
      return sendOpenAiError(reply, 400, validationResult.error, "invalid_request_error");
    }

    const body = validationResult.data;
    const prompt = extractTextContent(body.prompt);

    if (!prompt.trim()) {
      return sendOpenAiError(reply, 400, "prompt is required.");
    }

    const n = Math.min(body.n ?? 1, 10);

    try {
      const result = await options.registry.runModel(body.model, {
        requestId: makeId("req"),
        messages: [{ role: "user", content: prompt }],
        tools: [],
        metadata: body as Record<string, unknown>,
      });

      const images = parseImageGenerations(result.outputText);
      if (images.length === 0) {
        return sendOpenAiError(
          reply,
          500,
          "Provider returned no parseable image data.",
          "provider_error",
        );
      }

      return {
        created: Math.floor(Date.now() / 1000),
        data: images.slice(0, n),
      };
    } catch (error) {
      return handleModelError(reply, error);
    }
  });

  const handleDocumentGenerations = async (request: FastifyRequest, reply: FastifyReply) => {
    const validationResult = validateBody(request.body, documentGenerationsRequestSchema);
    if (!validationResult.success) {
      return sendOpenAiError(reply, 400, validationResult.error, "invalid_request_error");
    }

    const body = validationResult.data;
    const prompt = extractTextContent(body.prompt);

    if (!prompt.trim()) {
      return sendOpenAiError(reply, 400, "prompt is required.");
    }

    const n = Math.min(body.n ?? 1, 10);

    try {
      const result = normalizeAssistantResult(await options.registry.runModel(body.model, {
        requestId: makeId("req"),
        messages: [{ role: "user", content: prompt }],
        tools: [],
        metadata: body as Record<string, unknown>,
      }));

      const documents = parseDocumentGenerations(result.outputText, {
        fileType: body.file_type,
        filename: body.filename,
      });
      if (documents.length === 0) {
        return sendOpenAiError(
          reply,
          500,
          "Provider returned no parseable document data.",
          "provider_error",
        );
      }

      return {
        created: Math.floor(Date.now() / 1000),
        data: documents.slice(0, n),
      };
    } catch (error) {
      return handleModelError(reply, error);
    }
  };

  app.post("/documents/generations", handleDocumentGenerations);
  app.post("/files/generations", handleDocumentGenerations);

  // Audio Speech (TTS) endpoint
  app.post("/audio/speech", async (request, reply) => {
    const validationResult = validateBody(request.body, audioSpeechRequestSchema);
    if (!validationResult.success) {
      return sendOpenAiError(reply, 400, validationResult.error, "invalid_request_error");
    }

    const body = validationResult.data;

    try {
      const result = await options.registry.runModel(body.model, {
        requestId: makeId("req"),
        messages: [{ role: "user", content: body.input }],
        tools: [],
        metadata: body as Record<string, unknown>,
      });

      const audioData = parseAudioResponse(result.outputText);
      if (!audioData) {
        return sendOpenAiError(
          reply,
          500,
          "Provider returned no parseable audio data.",
          "provider_error",
        );
      }

      // Return audio data as binary or JSON depending on format
      if (audioData.format === "json") {
        return reply.type("application/json").send({
          audio: audioData.audio,
          format: audioData.format_type || "wav",
        });
      }

      const contentType = getAudioContentType(audioData.format_type || "wav");
      return reply
        .type(contentType)
        .header("Content-Disposition", `inline; filename="speech.${audioData.format_type || "wav"}"`)
        .send(Buffer.from(audioData.audio, "base64"));
    } catch (error) {
      return handleModelError(reply, error);
    }
  });

  // Audio Transcriptions (STT) endpoint
  app.post("/audio/transcriptions", async (request, reply) => {
    const validationResult = validateBody(request.body, audioTranscriptionsRequestSchema);
    if (!validationResult.success) {
      return sendOpenAiError(reply, 400, validationResult.error, "invalid_request_error");
    }

    const body = validationResult.data;

    try {
      const result = await options.registry.runModel(body.model, {
        requestId: makeId("req"),
        messages: [{ role: "user", content: body.file }],
        tools: [],
        metadata: body as Record<string, unknown>,
      });

      const transcription = extractTranscriptionText(result.outputText);
      const format = body.response_format || "json";

      if (format === "text") {
        return reply.type("text/plain").send(transcription);
      }

      return {
        text: transcription,
      };
    } catch (error) {
      return handleModelError(reply, error);
    }
  });

  // Audio Translations endpoint
  app.post("/audio/translations", async (request, reply) => {
    const validationResult = validateBody(request.body, audioTranscriptionsRequestSchema);
    if (!validationResult.success) {
      return sendOpenAiError(reply, 400, validationResult.error, "invalid_request_error");
    }

    const body = validationResult.data;

    try {
      const result = await options.registry.runModel(body.model, {
        requestId: makeId("req"),
        messages: [{ role: "user", content: body.file }],
        tools: [],
        metadata: { ...body, task: "translate" } as Record<string, unknown>,
      });

      const transcription = extractTranscriptionText(result.outputText);
      const format = body.response_format || "json";

      if (format === "text") {
        return reply.type("text/plain").send(transcription);
      }

      return {
        text: transcription,
      };
    } catch (error) {
      return handleModelError(reply, error);
    }
  });
};

interface ValidationResult<T> {
  success: true;
  data: T;
}

interface ValidationError {
  success: false;
  error: string;
}

function validateBody<T>(
  body: unknown,
  schema: z.ZodSchema<T>,
): ValidationResult<T> | ValidationError {
  const result = schema.safeParse(body);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "root";
      return `${path}: ${issue.message}`;
    });
    return { success: false, error: issues.join("; ") };
  }
  return { success: true, data: result.data };
}

async function handleChatCompletionsRequest(
  body: z.infer<typeof chatCompletionsRequestSchema>,
  reply: FastifyReply,
  registry: ProviderRegistry,
  defaultReasoningEffort?: ReasoningEffort,
) {
  const isStream = Boolean(body.stream);

  const messages = normalizeChatMessages(body.messages);
  if (messages.length === 0) {
    return sendOpenAiError(reply, 400, "messages must include at least one item.");
  }

  const rawTools = body.tools ?? body.functions ?? [];
  const tools = normalizeTools(rawTools);
  if (tools.length === 0 && rawTools.length > 0) {
    reply.log.warn(
      {
        model: body.model,
        tool_payload_type: "array",
      },
      "No tools normalized from chat request payload.",
    );
  }
  const sessionSig = getSessionSignature(messages);
  if (tools.length > 0) {
    multiTurnToolsCache.set(sessionSig, tools);
  } else if (messages.length > 2) {
    const cachedTools = multiTurnToolsCache.get(sessionSig);
    if (cachedTools && cachedTools.length > 0) {
      tools.push(...cachedTools);
      reply.log.debug(
        { model: body.model, sessionSig, cachedToolsCount: cachedTools.length },
        "Restored multi-turn tools from cache for /chat/completions request.",
      );
    }
  }

  // Debug: trace when tools are missing on multi-turn requests that contain
  // tool results, which is often the signal that n8n is not re-sending tools.
  if (tools.length === 0) {
    const hasToolMessages = messages.some(m => m.role === "tool" || m.tool_call_id);
    const hasAssistantMessages = messages.some(m => m.role === "assistant");
    if (hasToolMessages || hasAssistantMessages) {
      reply.log.debug(
        {
          model: body.model,
          messageCount: messages.length,
          hasToolMessages,
          hasAssistantMessages,
          rawToolsLength: rawTools.length,
        },
        "Multi-turn chat request has no tools defined - tool calls from provider will pass through un-normalized.",
      );
    }
  }

  try {
    const reasoningEffort = resolveReasoningEffort(body, defaultReasoningEffort);
    const result = normalizeAssistantResult(await registry.runModel(body.model, {
      requestId: makeId("req"),
      messages,
      tools,
      reasoningEffort,
      metadata: body as Record<string, unknown>,
    }));
    logBlankAssistantResult(reply.log.warn.bind(reply.log), body.model, result, "/chat/completions");

    // Log tool calls for debugging
    if (result.toolCalls.length > 0) {
      for (const call of result.toolCalls) {
        reply.log.debug(
          {
            tool_call_id: call.id,
            tool_name: call.name,
            tool_arguments: call.arguments.slice(0, 500),
          },
          "Returning chat completion tool call"
        );
      }
    }

    if (isStream) {
      reply.raw.setHeader("Content-Type", "text/event-stream");
      reply.raw.setHeader("Cache-Control", "no-cache");
      reply.raw.setHeader("Connection", "keep-alive");

      const respId = makeId("chatcmpl");
      const created = Math.floor(Date.now() / 1000);

      const chunkData = {
        id: respId,
        object: "chat.completion.chunk",
        created,
        model: body.model,
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              content: result.outputText || null,
              tool_calls: result.toolCalls.map((call) => ({
                id: call.id,
                type: "function",
                function: {
                  name: call.name,
                  arguments: call.arguments,
                },
              })),
            },
            finish_reason: result.toolCalls.length > 0 ? "tool_calls" : result.finishReason,
          },
        ],
      };

      reply.raw.write(`data: ${JSON.stringify(chunkData)}\n\n`);
      reply.raw.write("data: [DONE]\n\n");
      reply.raw.end();
      return reply;
    }

    return {
      id: makeId("chatcmpl"),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: body.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: result.outputText || null,
            tool_calls: result.toolCalls.map((call) => ({
              id: call.id,
              type: "function",
              function: {
                name: call.name,
                arguments: call.arguments,
              },
            })),
          },
          finish_reason:
            result.toolCalls.length > 0 ? "tool_calls" : result.finishReason,
        },
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    };
  } catch (error) {
    return handleModelError(reply, error);
  }
}

function normalizeTools(raw: unknown[]): UnifiedToolDefinition[] {
  const items = normalizeToolItems(raw);
  if (items.length === 0) {
    return [];
  }

  const tools: UnifiedToolDefinition[] = [];
  const seenNames = new Set<string>();
  for (const item of items) {
    const parsed = parseToolDefinition(item);
    if (!parsed) {
      continue;
    }
    const dedupeKey = parsed.name.toLowerCase();
    if (seenNames.has(dedupeKey)) {
      continue;
    }
    seenNames.add(dedupeKey);
    tools.push({
      type: "function",
      function: {
        name: parsed.name,
        description: parsed.description,
        parameters: parsed.parameters,
      },
    });
  }

  return tools;
}

function normalizeToolItems(raw: unknown[]): unknown[] {
  if (Array.isArray(raw)) {
    return raw;
  }

  if (!raw || typeof raw !== "object") {
    return [];
  }

  const record = raw as Record<string, unknown>;
  if (Array.isArray(record.tools)) {
    return record.tools;
  }
  if (Array.isArray(record.functions)) {
    return record.functions;
  }

  return [];
}

function parseToolDefinition(
  value: unknown,
): { name: string; description?: string; parameters?: unknown } | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const fnRecord =
    record.function && typeof record.function === "object"
      ? (record.function as Record<string, unknown>)
      : undefined;
  const nestedToolRecord =
    record.tool && typeof record.tool === "object"
      ? (record.tool as Record<string, unknown>)
      : undefined;

  const name = firstNonEmptyString(
    record.name,
    record.functionName,
    record.function_name,
    record.toolName,
    record.tool_name,
    typeof record.function === "string" ? record.function : undefined,
    fnRecord?.name,
    nestedToolRecord?.name,
  );
  if (!name) {
    return null;
  }

  const description = firstNonEmptyString(
    record.description,
    fnRecord?.description,
    nestedToolRecord?.description,
  );

  const parameters = firstDefined(
    fnRecord?.parameters,
    fnRecord?.input_schema,
    fnRecord?.inputSchema,
    record.parameters,
    record.input_schema,
    record.inputSchema,
    nestedToolRecord?.parameters,
    nestedToolRecord?.input_schema,
    nestedToolRecord?.inputSchema,
  );

  return {
    name,
    description,
    parameters,
  };
}

function firstNonEmptyString(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      const trimmed = candidate.trim();
      if (trimmed) {
        return trimmed;
      }
    }
  }
  return undefined;
}

function firstDefined(...candidates: unknown[]): unknown {
  for (const candidate of candidates) {
    if (candidate !== undefined) {
      return candidate;
    }
  }
  return undefined;
}

function normalizeChatMessages(raw: unknown[]): ChatMessage[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const messages: ChatMessage[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const record = item as Record<string, unknown>;
    const role = asRole(record.role);
    if (!role) {
      continue;
    }

    const content = normalizeMessageContentForRole(
      role,
      record.content,
      record.tool_calls ?? record.tool_call ?? record.function_call,
    );
    messages.push({
      role,
      content,
      name: typeof record.name === "string" ? record.name : undefined,
      tool_call_id:
        typeof record.tool_call_id === "string" ? record.tool_call_id : undefined,
    });
  }
  return messages;
}

function normalizeResponsesInput(raw: unknown, depth = 0): ChatMessage[] {
  if (depth > 10) return [];

  if (typeof raw === "string") {
    return [{ role: "user", content: raw }];
  }

  if (raw === null || raw === undefined) {
    return [];
  }

  if (Array.isArray(raw)) {
    const out: ChatMessage[] = [];
    for (const item of raw) {
      out.push(...normalizeResponsesInput(item, depth + 1));
    }
    return out;
  }

  if (!raw || typeof raw !== "object") {
    return [];
  }

  const record = raw as Record<string, unknown>;
  const role = asRole(record.role) || "user";

  if (record.type === "input_text" && typeof record.text === "string") {
    return [{ role: "user", content: record.text }];
  }

  if (record.type === "function_call_output") {
    const callId =
      typeof record.call_id === "string"
        ? record.call_id
        : typeof record.tool_call_id === "string"
          ? record.tool_call_id
          : typeof record.id === "string"
            ? record.id
            : undefined;
    const outputText = extractTextContent(
      record.output ?? record.content ?? record.text ?? "",
    );
    return [
      {
        role: "tool",
        content: outputText,
        tool_call_id: callId,
      },
    ];
  }

  if (record.type === "function_call") {
    const callId =
      typeof record.call_id === "string"
        ? record.call_id
        : typeof record.tool_call_id === "string"
          ? record.tool_call_id
          : typeof record.id === "string"
            ? record.id
            : undefined;
    const toolCallText = extractToolCallContext({
      id: callId,
      name: record.name,
      arguments: record.arguments ?? record.input,
    });
    if (!toolCallText) {
      return [];
    }
    return [
      {
        role: "assistant",
        content: toolCallText,
      },
    ];
  }

  // Handle tool role directly (n8n sometimes sends this)
  if (role === "tool" || record.type === "tool_result") {
    const callId =
      typeof record.tool_call_id === "string"
        ? record.tool_call_id
        : typeof record.call_id === "string"
          ? record.call_id
          : typeof record.id === "string"
            ? record.id
            : undefined;
    const outputText = extractTextContent(
      record.content ?? record.output ?? record.text ?? "",
    );
    return [
      {
        role: "tool",
        content: outputText,
        tool_call_id: callId,
      },
    ];
  }

  if (record.type === "message") {
    const content = normalizeMessageContentForRole(
      role,
      record.content,
      record.tool_calls ?? record.tool_call ?? record.function_call,
    );
    return [{ role, content }];
  }

  if ("content" in record) {
    const content = normalizeMessageContentForRole(
      role,
      record.content,
      record.tool_calls ?? record.tool_call ?? record.function_call,
    );
    return [{ role, content }];
  }

  if (typeof record.text === "string") {
    return [{ role: "user", content: record.text }];
  }

  return [];
}

function asRole(value: unknown): ChatMessage["role"] | undefined {
  if (
    value === "system" ||
    value === "user" ||
    value === "assistant" ||
    value === "tool"
  ) {
    return value;
  }

  return undefined;
}

function mergeMessageContent(content: string, extra: string): string {
  const base = content.trim();
  const appended = extra.trim();
  if (!base) {
    return appended;
  }
  if (!appended) {
    return base;
  }
  return `${base}\n\n${appended}`;
}

function normalizeMessageContentForRole(
  role: ChatMessage["role"],
  content: unknown,
  toolContext: unknown,
): string {
  const explicitToolCalls = normalizeToolCallContext(toolContext);
  if (role !== "assistant") {
    return mergeMessageContent(extractTextContent(content), renderToolCallContext(explicitToolCalls));
  }

  const parsed = parseAssistantPayloadText(extractTextContent(content));
  const combinedToolCalls = dedupeToolCallContext([
    ...parsed.toolCalls,
    ...explicitToolCalls,
  ]);
  return mergeMessageContent(parsed.outputText, renderToolCallContext(combinedToolCalls));
}

function extractToolCallContext(value: unknown): string {
  const normalized = normalizeToolCallContext(value);
  return renderToolCallContext(normalized);
}

function renderToolCallContext(
  normalized: Array<{ id?: string; name: string; arguments: string }>,
): string {
  if (normalized.length === 0) {
    return "";
  }
  return `TOOL_CALLS:\n${JSON.stringify(normalized)}`;
}

function normalizeToolCallContext(
  value: unknown,
): Array<{ id?: string; name: string; arguments: string }> {
  const items = Array.isArray(value) ? value : value ? [value] : [];
  const out: Array<{ id?: string; name: string; arguments: string }> = [];

  for (const item of items) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const record = item as Record<string, unknown>;
    const fn =
      record.function && typeof record.function === "object"
        ? (record.function as Record<string, unknown>)
        : undefined;

    const name =
      firstNonEmptyString(
        record.name,
        record.tool_name,
        record.toolName,
        fn?.name,
      ) ?? "";
    if (!name) {
      continue;
    }

    const id = firstNonEmptyString(record.id, record.call_id, record.tool_call_id);
    const argsRaw =
      firstDefined(
        record.arguments,
        record.args,
        record.parameters,
        record.input,
        fn?.arguments,
        fn?.args,
      ) ?? {};
    out.push({
      id,
      name,
      arguments: stringifyToolContextArguments(argsRaw),
    });
  }

  return out;
}

function dedupeToolCallContext(
  toolCalls: Array<{ id?: string; name: string; arguments: string }>,
): Array<{ id?: string; name: string; arguments: string }> {
  const out: Array<{ id?: string; name: string; arguments: string }> = [];
  const seen = new Set<string>();

  for (const call of toolCalls) {
    const name = typeof call.name === "string" ? call.name.trim() : "";
    if (!name) {
      continue;
    }
    const id = typeof call.id === "string" ? call.id.trim() : "";
    const argumentsText = typeof call.arguments === "string" ? call.arguments : "{}";
    const key = `${id}|${name}|${argumentsText}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push({
      id: id || undefined,
      name,
      arguments: argumentsText,
    });
  }

  return out;
}

function stringifyToolContextArguments(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

function isAuthorized(request: FastifyRequest, allowedKeys: Set<string>): boolean {
  const xApiKey = request.headers["x-api-key"];
  const xApiKeyValue = Array.isArray(xApiKey) ? xApiKey[0] : xApiKey;
  if (typeof xApiKeyValue === "string" && allowedKeys.has(xApiKeyValue.trim())) {
    return true;
  }

  const header = request.headers.authorization;
  if (!header || !header.toLowerCase().startsWith("bearer ")) {
    return false;
  }
  const token = header.slice("bearer ".length).trim();
  return allowedKeys.has(token);
}

function sendOpenAiError(
  reply: FastifyReply,
  statusCode: number,
  message: string,
  type = "invalid_request_error",
): FastifyReply {
  return reply.status(statusCode).send({
    error: {
      message,
      type,
      code: statusCode,
    },
  });
}

function handleModelError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof Error && error.message.startsWith("Unknown model:")) {
    return sendOpenAiError(reply, 404, error.message, "invalid_model");
  }

  const message =
    error instanceof Error ? error.message : "Unexpected provider execution error.";
  return sendOpenAiError(reply, 500, message, "provider_error");
}

type OpenAiImageItem = {
  url?: string;
  b64_json?: string;
  revised_prompt?: string;
};

type OpenAiDocumentItem = {
  filename?: string;
  mime_type?: string;
  b64_data: string;
};

function parseImageGenerations(text: string): OpenAiImageItem[] {
  const direct = normalizeImagePayload(text.trim());
  if (direct.length > 0) {
    return direct;
  }

  for (const candidate of extractJsonCandidates(text)) {
    const parsed = normalizeImagePayload(candidate);
    if (parsed.length > 0) {
      return parsed;
    }
  }

  return [];
}

function extractJsonCandidates(input: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      return;
    }
    seen.add(trimmed);
    out.push(trimmed);
  };

  push(input);

  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(input)) !== null) {
    push(match[1] ?? "");
  }

  const start = input.indexOf("{");
  const end = input.lastIndexOf("}");
  if (start !== -1 && end > start) {
    push(input.slice(start, end + 1));
  }

  return out;
}

function normalizeImagePayload(raw: unknown): OpenAiImageItem[] {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) {
      return [];
    }

    const parsed = tryParseJson(trimmed);
    if (parsed !== null) {
      return normalizeImagePayload(parsed);
    }

    const dataUrlMatch = /^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/i.exec(trimmed);
    if (dataUrlMatch && dataUrlMatch[1]) {
      return [{ b64_json: dataUrlMatch[1] }];
    }

    if (/^https?:\/\//i.test(trimmed)) {
      return [{ url: trimmed }];
    }

    return [];
  }

  if (Array.isArray(raw)) {
    return raw.flatMap((item) => normalizeImageItem(item)).filter(isImageItem);
  }

  if (!raw || typeof raw !== "object") {
    return [];
  }

  const obj = raw as Record<string, unknown>;
  if (Array.isArray(obj.data)) {
    return obj.data.flatMap((item) => normalizeImageItem(item)).filter(isImageItem);
  }

  if (Array.isArray(obj.images)) {
    return obj.images.flatMap((item) => normalizeImageItem(item)).filter(isImageItem);
  }

  const single = normalizeImageItem(obj);
  return single ? [single] : [];
}

function normalizeImageItem(raw: unknown): OpenAiImageItem | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const obj = raw as Record<string, unknown>;
  const url = typeof obj.url === "string" ? obj.url.trim() : "";
  const b64 =
    typeof obj.b64_json === "string"
      ? obj.b64_json.trim()
      : typeof obj.base64 === "string"
        ? obj.base64.trim()
        : "";
  const revisedPrompt =
    typeof obj.revised_prompt === "string"
      ? obj.revised_prompt
      : typeof obj.revisedPrompt === "string"
        ? obj.revisedPrompt
        : undefined;

  if (!url && !b64) {
    return null;
  }

  return {
    url: url || undefined,
    b64_json: b64 || undefined,
    revised_prompt: revisedPrompt,
  };
}

function isImageItem(value: OpenAiImageItem | null): value is OpenAiImageItem {
  return Boolean(value && (value.url || value.b64_json));
}

function parseDocumentGenerations(
  text: string,
  defaults?: { fileType?: string; filename?: string },
): OpenAiDocumentItem[] {
  const direct = normalizeDocumentPayload(text.trim(), defaults);
  if (direct.length > 0) {
    return direct;
  }

  for (const candidate of extractJsonCandidates(text)) {
    const parsed = normalizeDocumentPayload(candidate, defaults);
    if (parsed.length > 0) {
      return parsed;
    }
  }

  return [];
}

function normalizeDocumentPayload(
  raw: unknown,
  defaults?: { fileType?: string; filename?: string },
): OpenAiDocumentItem[] {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) {
      return [];
    }

    const parsed = tryParseJson(trimmed);
    if (parsed !== null) {
      return normalizeDocumentPayload(parsed, defaults);
    }

    const dataUrlMatch = /^data:([^;]+);base64,(.+)$/i.exec(trimmed);
    if (dataUrlMatch && dataUrlMatch[1] && dataUrlMatch[2]) {
      return [{
        filename: normalizeDocumentFilename(defaults?.filename, defaults?.fileType, dataUrlMatch[1]),
        mime_type: dataUrlMatch[1],
        b64_data: dataUrlMatch[2],
      }];
    }

    const compact = trimmed.replace(/\s/g, "");
    if (/^[A-Za-z0-9+/]{100,}={0,2}$/.test(compact)) {
      const mimeType = inferDocumentMimeType(defaults?.fileType, defaults?.filename);
      return [{
        filename: normalizeDocumentFilename(defaults?.filename, defaults?.fileType, mimeType),
        mime_type: mimeType,
        b64_data: compact,
      }];
    }

    return [];
  }

  if (Array.isArray(raw)) {
    return raw.flatMap((item) => normalizeDocumentItem(item, defaults)).filter(isDocumentItem);
  }

  if (!raw || typeof raw !== "object") {
    return [];
  }

  const obj = raw as Record<string, unknown>;
  if (Array.isArray(obj.data)) {
    return obj.data.flatMap((item) => normalizeDocumentItem(item, defaults)).filter(isDocumentItem);
  }

  if (Array.isArray(obj.documents)) {
    return obj.documents.flatMap((item) => normalizeDocumentItem(item, defaults)).filter(isDocumentItem);
  }

  if (Array.isArray(obj.files)) {
    return obj.files.flatMap((item) => normalizeDocumentItem(item, defaults)).filter(isDocumentItem);
  }

  const single = normalizeDocumentItem(obj, defaults);
  return single ? [single] : [];
}

function normalizeDocumentItem(
  raw: unknown,
  defaults?: { fileType?: string; filename?: string },
): OpenAiDocumentItem | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const obj = raw as Record<string, unknown>;
  const base64ValueRaw =
    typeof obj.b64_data === "string"
      ? obj.b64_data.trim()
      : typeof obj.b64_json === "string"
        ? obj.b64_json.trim()
        : typeof obj.base64 === "string"
          ? obj.base64.trim()
          : typeof obj.data === "string"
            ? extractBase64FromDataUrl(obj.data.trim()) ?? obj.data.trim()
            : "";
  const base64Value = base64ValueRaw.replace(/\s/g, "");
  if (!isLikelyBase64(base64Value)) {
    return null;
  }

  const mimeType =
    typeof obj.mime_type === "string"
      ? obj.mime_type.trim()
      : typeof obj.mimeType === "string"
        ? obj.mimeType.trim()
        : typeof obj.content_type === "string"
          ? obj.content_type.trim()
          : typeof obj.contentType === "string"
            ? obj.contentType.trim()
            : inferDocumentMimeType(defaults?.fileType, typeof obj.filename === "string" ? obj.filename : typeof obj.name === "string" ? obj.name : defaults?.filename);

  const filename =
    typeof obj.filename === "string"
      ? obj.filename.trim()
      : typeof obj.name === "string"
        ? obj.name.trim()
        : normalizeDocumentFilename(defaults?.filename, defaults?.fileType, mimeType);

  return {
    filename,
    mime_type: mimeType,
    b64_data: base64Value,
  };
}

function isDocumentItem(value: OpenAiDocumentItem | null): value is OpenAiDocumentItem {
  return Boolean(value && value.b64_data);
}

function extractBase64FromDataUrl(value: string): string | null {
  const match = /^data:([^;]+);base64,(.+)$/i.exec(value);
  return match && match[2] ? match[2] : null;
}

function isLikelyBase64(value: string): boolean {
  return /^[A-Za-z0-9+/]{100,}={0,2}$/.test(value);
}

function normalizeDocumentFilename(
  filename: string | undefined,
  fileType: string | undefined,
  mimeType: string | undefined,
): string {
  const trimmedFilename = typeof filename === "string" ? filename.trim() : "";
  if (trimmedFilename) {
    return trimmedFilename;
  }

  const extension = inferDocumentExtension(fileType, mimeType);
  return `document.${extension}`;
}

function inferDocumentMimeType(fileType?: string, filename?: string): string {
  const extension = inferDocumentExtension(fileType, undefined, filename);
  const mimeTypes: Record<string, string> = {
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pdf: "application/pdf",
    txt: "text/plain",
    html: "text/html",
    csv: "text/csv",
    json: "application/json",
  };
  return mimeTypes[extension] || "application/octet-stream";
}

function inferDocumentExtension(
  fileType?: string,
  mimeType?: string,
  filename?: string,
): string {
  const fromFileType = typeof fileType === "string" ? fileType.trim().toLowerCase().replace(/^\./, "") : "";
  if (fromFileType) {
    return fromFileType;
  }

  const fromFilename =
    typeof filename === "string" && filename.includes(".")
      ? filename.slice(filename.lastIndexOf(".") + 1).trim().toLowerCase()
      : "";
  if (fromFilename) {
    return fromFilename;
  }

  const fromMimeType = typeof mimeType === "string" ? mimeType.trim().toLowerCase() : "";
  if (fromMimeType.includes("presentationml.presentation")) {
    return "pptx";
  }
  if (fromMimeType.includes("wordprocessingml.document")) {
    return "docx";
  }
  if (fromMimeType.includes("spreadsheetml.sheet")) {
    return "xlsx";
  }
  if (fromMimeType.includes("/pdf")) {
    return "pdf";
  }
  if (fromMimeType.includes("/html")) {
    return "html";
  }
  if (fromMimeType.includes("/csv")) {
    return "csv";
  }
  if (fromMimeType.includes("/json")) {
    return "json";
  }
  if (fromMimeType.includes("/plain")) {
    return "txt";
  }

  return "bin";
}

function tryParseJson(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * Sanitizes the instructions field to prevent injection attacks.
 * - Trims whitespace
 * - Limits length to 10000 characters
 * - Removes null bytes
 */
function sanitizeInstructions(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  const trimmed = value.trim();

  // Remove null bytes
  const noNulls = trimmed.replace(/\x00/g, "");

  // Limit length to prevent abuse
  const maxLength = 10000;
  if (noNulls.length > maxLength) {
    return noNulls.slice(0, maxLength);
  }

  return noNulls;
}

// Audio response parsing types
interface AudioResponse {
  audio: string;
  format: "base64" | "json";
  format_type?: string;
}

function parseAudioResponse(text: string): AudioResponse | null {
  const trimmed = text.trim();

  // Try to parse as JSON first
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed.audio === "string") {
      return {
        audio: parsed.audio,
        format: "base64",
        format_type: parsed.format || "wav",
      };
    }
  } catch {
    // Not valid JSON, try other formats
  }

  // Check if it's a data URL
  const dataUrlMatch = /^data:audio\/([a-zA-Z0-9.+-]+);base64,(.+)$/i.exec(trimmed);
  if (dataUrlMatch && dataUrlMatch[1] && dataUrlMatch[2]) {
    return {
      audio: dataUrlMatch[2],
      format: "base64",
      format_type: dataUrlMatch[1],
    };
  }

  // Check if it's raw base64 (at least 100 chars to avoid false positives)
  if (/^[A-Za-z0-9+/]{100,}={0,2}$/.test(trimmed.replace(/\s/g, ""))) {
    return {
      audio: trimmed.replace(/\s/g, ""),
      format: "base64",
      format_type: "wav",
    };
  }

  return null;
}

function getAudioContentType(format: string): string {
  const mimeTypes: Record<string, string> = {
    mp3: "audio/mpeg",
    opus: "audio/opus",
    aac: "audio/aac",
    flac: "audio/flac",
    wav: "audio/wav",
    pcm: "audio/pcm",
    ogg: "audio/ogg",
    webm: "audio/webm",
  };
  return mimeTypes[format.toLowerCase()] || "audio/wav";
}

function extractTranscriptionText(text: string): string {
  const trimmed = text.trim();

  // Try to parse as JSON first
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed.text === "string") {
      return parsed.text;
    }
  } catch {
    // Not JSON, return as-is
  }

  return trimmed;
}

function logBlankAssistantResult(
  warn: (obj: Record<string, unknown>, msg?: string) => void,
  model: string,
  result: ProviderResult,
  endpoint: string,
): void {
  if (result.outputText || result.toolCalls.length > 0) {
    return;
  }

  const debug = extractProviderDebugData(result.raw);
  warn(
    {
      endpoint,
      model,
      normalized_finish_reason: result.finishReason,
      provider_response_id: debug.responseId,
      provider_finish_reason: debug.finishReason,
      provider_message: debug.message,
      provider_executed_tools: debug.executedTools,
      provider_reasoning: debug.reasoning,
      provider_x_groq: debug.xGroq,
    },
    "Provider returned a blank assistant completion.",
  );
}

function extractProviderDebugData(payload: unknown): {
  responseId?: string;
  finishReason?: string;
  message?: Record<string, unknown>;
  xGroq?: Record<string, unknown>;
  executedTools?: unknown[];
  reasoning?: unknown;
} {
  if (!payload || typeof payload !== "object") {
    return {};
  }

  const record = payload as Record<string, unknown>;
  const choice =
    Array.isArray(record.choices) && record.choices[0] && typeof record.choices[0] === "object"
      ? (record.choices[0] as Record<string, unknown>)
      : undefined;
  const message =
    choice?.message && typeof choice.message === "object"
      ? (choice.message as Record<string, unknown>)
      : undefined;
  const xGroq =
    record.x_groq && typeof record.x_groq === "object"
      ? (record.x_groq as Record<string, unknown>)
      : undefined;
  const executedTools = Array.isArray(message?.executed_tools)
    ? message.executed_tools
    : undefined;
  const reasoning =
    message && Object.prototype.hasOwnProperty.call(message, "reasoning")
      ? message.reasoning
      : undefined;

  return {
    responseId: typeof record.id === "string" ? record.id : undefined,
    finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : undefined,
    message,
    xGroq,
    executedTools,
    reasoning,
  };
}
