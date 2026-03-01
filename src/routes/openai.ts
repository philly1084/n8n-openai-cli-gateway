import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ProviderRegistry } from "../providers/registry";
import type { ChatMessage, UnifiedToolDefinition } from "../types";
import { makeId } from "../utils/ids";
import { extractTextContent } from "../utils/prompt";
import {
  chatCompletionsRequestSchema,
  responsesRequestSchema,
  imageGenerationsRequestSchema,
} from "../validation";

interface OpenAiRoutesOptions {
  registry: ProviderRegistry;
  n8nApiKeys: Set<string>;
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
    return await handleChatCompletionsRequest(validationResult.data, reply, options.registry);
  });

  app.post("/messages", async (request, reply) => {
    const validationResult = validateBody(request.body, chatCompletionsRequestSchema);
    if (!validationResult.success) {
      return sendOpenAiError(reply, 400, validationResult.error, "invalid_request_error");
    }
    return await handleChatCompletionsRequest(validationResult.data, reply, options.registry);
  });

  app.post("/message", async (request, reply) => {
    const validationResult = validateBody(request.body, chatCompletionsRequestSchema);
    if (!validationResult.success) {
      return sendOpenAiError(reply, 400, validationResult.error, "invalid_request_error");
    }
    return await handleChatCompletionsRequest(validationResult.data, reply, options.registry);
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

    if (body.stream) {
      return sendOpenAiError(
        reply,
        400,
        "stream=true is not implemented in this gateway yet.",
      );
    }

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

    const rawTools = body.tools ?? [];
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

    try {
      const result = await options.registry.runModel(body.model, {
        requestId: makeId("req"),
        messages,
        tools,
        metadata: body as Record<string, unknown>,
      });

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
) {
  if (body.stream) {
    return sendOpenAiError(
      reply,
      400,
      "stream=true is not implemented in this gateway yet.",
    );
  }

  const messages = normalizeChatMessages(body.messages);
  if (messages.length === 0) {
    return sendOpenAiError(reply, 400, "messages must include at least one item.");
  }

  const rawTools = body.tools ?? [];
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

  try {
    const result = await registry.runModel(body.model, {
      requestId: makeId("req"),
      messages,
      tools,
      metadata: body as Record<string, unknown>,
    });

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

    const content = extractTextContent(record.content);
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

function normalizeResponsesInput(raw: unknown): ChatMessage[] {
  if (typeof raw === "string") {
    return [{ role: "user", content: raw }];
  }

  if (raw === null || raw === undefined) {
    return [];
  }

  if (Array.isArray(raw)) {
    const out: ChatMessage[] = [];
    for (const item of raw) {
      out.push(...normalizeResponsesInput(item));
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
    const content = extractTextContent(record.content);
    return [{ role, content }];
  }

  if ("content" in record) {
    const content = extractTextContent(record.content);
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
