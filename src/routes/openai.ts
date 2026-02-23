import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { ProviderRegistry } from "../providers/registry";
import type { ChatMessage, UnifiedToolDefinition } from "../types";
import { makeId } from "../utils/ids";
import { extractTextContent } from "../utils/prompt";

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

  app.get("/models", async () => {
    return {
      object: "list",
      data: options.registry.listModels().map((model) => ({
        id: model.id,
        object: "model",
        created: 0,
        owned_by: model.providerId,
      })),
    };
  });

  app.post("/chat/completions", async (request, reply) => {
    const body = request.body as Record<string, unknown> | undefined;
    return await handleChatCompletionsRequest(body, reply, options.registry);
  });

  app.post("/messages", async (request, reply) => {
    const body = request.body as Record<string, unknown> | undefined;
    return await handleChatCompletionsRequest(body, reply, options.registry);
  });

  app.post("/message", async (request, reply) => {
    const body = request.body as Record<string, unknown> | undefined;
    return await handleChatCompletionsRequest(body, reply, options.registry);
  });

  app.post("/responses", async (request, reply) => {
    const body = request.body as Record<string, unknown> | undefined;
    if (!body) {
      return sendOpenAiError(reply, 400, "Body is required.");
    }

    const model = typeof body.model === "string" ? body.model : "";
    if (!model) {
      return sendOpenAiError(reply, 400, "model is required.");
    }

    const stream = body.stream === true;
    if (stream) {
      return sendOpenAiError(
        reply,
        400,
        "stream=true is not implemented in this gateway yet.",
      );
    }

    const inputMessages = normalizeResponsesInput(body.input);
    const instructions =
      typeof body.instructions === "string" ? body.instructions.trim() : "";

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

    const rawTools = body.tools ?? body.functions;
    const tools = normalizeTools(rawTools ?? body);
    if (tools.length === 0 && rawTools !== undefined) {
      app.log.warn(
        {
          model,
          tool_payload_type: Array.isArray(rawTools) ? "array" : typeof rawTools,
        },
        "No tools normalized from /responses request payload.",
      );
    }

    try {
      const result = await options.registry.runModel(model, {
        requestId: makeId("req"),
        messages,
        tools,
        metadata: body,
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
        model,
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
};

async function handleChatCompletionsRequest(
  body: Record<string, unknown> | undefined,
  reply: FastifyReply,
  registry: ProviderRegistry,
) {
  if (!body) {
    return sendOpenAiError(reply, 400, "Body is required.");
  }

  const model = typeof body.model === "string" ? body.model : "";
  if (!model) {
    return sendOpenAiError(reply, 400, "model is required.");
  }

  const stream = body.stream === true;
  if (stream) {
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

  const rawTools = body.tools ?? body.functions;
  const tools = normalizeTools(rawTools ?? body);
  if (tools.length === 0 && rawTools !== undefined) {
    reply.log.warn(
      {
        model,
        tool_payload_type: Array.isArray(rawTools) ? "array" : typeof rawTools,
      },
      "No tools normalized from chat request payload.",
    );
  }

  try {
    const result = await registry.runModel(model, {
      requestId: makeId("req"),
      messages,
      tools,
      metadata: body,
    });

    return {
      id: makeId("chatcmpl"),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
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

function normalizeTools(raw: unknown): UnifiedToolDefinition[] {
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

function normalizeToolItems(raw: unknown): unknown[] {
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

function normalizeChatMessages(raw: unknown): ChatMessage[] {
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
