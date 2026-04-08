import process from "node:process";
import { parseAssistantPayloadText } from "../utils/assistant-output.js";
import { extractTextContentOrJson } from "../utils/prompt.js";
import { resolveReasoningEffort } from "../utils/reasoning.js";
import { normalizeToolAlias, normalizeToolName } from "../utils/tools.js";

type FinishReason = "stop" | "tool_calls" | "length" | "error";

interface GatewayMessage {
  role?: unknown;
  content?: unknown;
  name?: unknown;
  tool_call_id?: unknown;
}

interface GatewayToolDefinition {
  type?: unknown;
  function?: {
    name?: unknown;
    description?: unknown;
    parameters?: unknown;
  };
}

interface GatewayRequest {
  prompt?: unknown;
  messages?: unknown;
  tools?: unknown;
  reasoningEffort?: unknown;
  metadata?: unknown;
}

interface JsonContract {
  output_text: string;
  tool_calls?: Array<{
    id: string;
    name: string;
    arguments: string;
  }>;
  finish_reason: FinishReason;
}

interface OllamaFunctionTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: unknown;
  };
}

interface OllamaToolCall {
  id: string;
  name: string;
  arguments: string;
}

type OllamaChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string;
  tool_name?: string;
  tool_calls?: Array<{
    function: {
      name: string;
      arguments: Record<string, unknown>;
    };
  }>;
};

type OllamaBridgeArgs = {
  model: string;
};

export function parseOllamaBridgeArgs(argv: string[]): OllamaBridgeArgs {
  let model = "";

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--model") {
      model = argv[i + 1] ?? "";
      i += 1;
    }
  }

  if (!model.trim()) {
    throw new Error("Missing required --model argument.");
  }

  return { model: model.trim() };
}

export function parseGatewayRequest(input: string): GatewayRequest {
  const trimmed = input.trim();
  if (!trimmed) {
    return {};
  }

  const parsed = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Ollama bridge expected a JSON object on stdin.");
  }

  return parsed as GatewayRequest;
}

export function buildOllamaChatRequest(
  request: GatewayRequest,
  model: string,
): Record<string, unknown> {
  const metadata = asRecord(request.metadata);
  const tools = extractAllowedTools(request.tools);
  const body: Record<string, unknown> = {
    model,
    stream: false,
    messages: buildOllamaMessages(request.messages),
  };

  if (tools.length > 0) {
    body.tools = tools;
  }

  const think = resolveThinkValue(request, metadata);
  if (think !== undefined) {
    body.think = think;
  }

  const keepAlive = resolveKeepAlive(metadata);
  if (keepAlive !== undefined) {
    body.keep_alive = keepAlive;
  }

  const format = resolveResponseFormat(metadata);
  if (format !== undefined) {
    body.format = format;
  }

  const options = buildOllamaOptions(metadata);
  if (Object.keys(options).length > 0) {
    body.options = options;
  }

  return body;
}

export function buildOllamaMessages(rawMessages: unknown): OllamaChatMessage[] {
  const messages = normalizeMessages(rawMessages);
  const toolNameById = new Map<string, string>();
  const out: OllamaChatMessage[] = [];

  for (const message of messages) {
    const role = normalizeRole(message.role);
    if (!role) {
      continue;
    }

    const content = extractTextContentOrJson(message.content).trim();
    if (role === "assistant") {
      const parsed = splitAssistantToolContext(content);
      const toolCalls = parsed.toolCalls.map((call) => {
        if (call.id) {
          toolNameById.set(call.id, call.name);
        }
        return {
          function: {
            name: call.name,
            arguments: safeJsonParseObject(call.arguments),
          },
        };
      });

      if (!parsed.content && toolCalls.length === 0) {
        continue;
      }

      const assistantMessage: OllamaChatMessage = {
        role,
      };
      if (parsed.content) {
        assistantMessage.content = parsed.content;
      }
      if (toolCalls.length > 0) {
        assistantMessage.tool_calls = toolCalls;
      }
      out.push(assistantMessage);
      continue;
    }

    if (role === "tool") {
      if (!content) {
        continue;
      }

      const toolMessage: OllamaChatMessage = {
        role,
        content,
      };
      const callId =
        typeof message.tool_call_id === "string" && message.tool_call_id.trim()
          ? message.tool_call_id.trim()
          : "";
      const toolName =
        (callId && toolNameById.get(callId)) ||
        (typeof message.name === "string" && message.name.trim() ? message.name.trim() : "");
      if (toolName) {
        toolMessage.tool_name = toolName;
      }
      out.push(toolMessage);
      continue;
    }

    if (!content) {
      continue;
    }

    out.push({
      role,
      content,
    });
  }

  return out;
}

export function parseOllamaChatResponse(payload: unknown, toolsInput: unknown): JsonContract {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Ollama API returned a non-object response.");
  }

  const record = payload as Record<string, unknown>;
  const message =
    record.message && typeof record.message === "object" && !Array.isArray(record.message)
      ? (record.message as Record<string, unknown>)
      : null;

  if (!message) {
    throw new Error("Ollama API response is missing message.");
  }

  const tools = extractAllowedTools(toolsInput);
  const toolNameResolver = createAllowedToolNameResolver(tools);
  const toolCalls = normalizeOllamaToolCalls(message.tool_calls, toolNameResolver);
  const outputText = extractTextContentOrJson(message.content).trim();

  return {
    output_text: toolCalls.length > 0 ? "" : outputText,
    tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    finish_reason: normalizeFinishReason(record.done_reason, toolCalls.length > 0),
  };
}

async function main(): Promise<void> {
  const args = parseOllamaBridgeArgs(process.argv.slice(2));
  const stdin = await readStdin();
  const request = parseGatewayRequest(stdin);
  const body = buildOllamaChatRequest(request, args.model);
  const response = await requestOllamaJson("/chat", body);
  const contract = parseOllamaChatResponse(response, request.tools);
  process.stdout.write(JSON.stringify(contract));
}

async function requestOllamaJson(
  pathname: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const baseUrl = resolveBaseUrl();
  const url = new URL(pathname.replace(/^\//, ""), ensureTrailingSlash(baseUrl));
  const apiKey = process.env.OLLAMA_API_KEY?.trim();
  const timeoutMs = parseInteger(process.env.OLLAMA_HTTP_TIMEOUT_MS) ?? 540000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Ollama API ${response.status}: ${extractApiError(text)}`);
    }

    if (!text.trim()) {
      throw new Error("Ollama API returned an empty response body.");
    }

    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

function resolveBaseUrl(): string {
  const raw = process.env.OLLAMA_BASE_URL?.trim() || "http://127.0.0.1:11434/api";
  return raw.endsWith("/api") || raw.endsWith("/api/") ? raw : `${raw.replace(/\/+$/, "")}/api`;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function extractApiError(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "empty error response";
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const errorMessage = (parsed as { error?: unknown }).error;
      if (typeof errorMessage === "string" && errorMessage.trim()) {
        return errorMessage.trim();
      }
    }
  } catch {
    // Fall back to raw text.
  }

  return trimmed;
}

function normalizeMessages(raw: unknown): GatewayMessage[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.filter((item): item is GatewayMessage => Boolean(item && typeof item === "object"));
}

function normalizeRole(value: unknown): OllamaChatMessage["role"] | undefined {
  return value === "system" || value === "user" || value === "assistant" || value === "tool"
    ? value
    : undefined;
}

function splitAssistantToolContext(content: string): { content: string; toolCalls: OllamaToolCall[] } {
  const marker = "\n\nTOOL_CALLS:\n";
  const fallbackMarker = "TOOL_CALLS:\n";
  const markerIndex = content.indexOf(marker);
  const splitIndex = markerIndex >= 0 ? markerIndex : content.indexOf(fallbackMarker);
  const markerLength = markerIndex >= 0 ? marker.length : fallbackMarker.length;
  const baseContent = splitIndex >= 0 ? content.slice(0, splitIndex).trim() : content.trim();
  const toolCallsRaw = splitIndex >= 0 ? content.slice(splitIndex + markerLength).trim() : "";

  const parsedBase = parseAssistantPayloadText(baseContent);
  const parsedToolCalls = normalizeEmbeddedToolCalls(toolCallsRaw);
  const toolCalls = dedupeToolCalls([...parsedBase.toolCalls, ...parsedToolCalls]);

  return {
    content: parsedBase.outputText || baseContent,
    toolCalls,
  };
}

function normalizeEmbeddedToolCalls(raw: string): OllamaToolCall[] {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.flatMap((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return [];
      }

      const record = item as Record<string, unknown>;
      const name = typeof record.name === "string" ? record.name.trim() : "";
      if (!name) {
        return [];
      }

      const id =
        typeof record.id === "string" && record.id.trim() ? record.id.trim() : `call_${index + 1}`;
      return [
        {
          id,
          name,
          arguments: stringifyArguments(record.arguments),
        },
      ];
    });
  } catch {
    return [];
  }
}

function dedupeToolCalls(toolCalls: Array<{ id?: string; name: string; arguments: string }>): OllamaToolCall[] {
  const out: OllamaToolCall[] = [];
  const seen = new Set<string>();

  for (const call of toolCalls) {
    const name = typeof call.name === "string" ? call.name.trim() : "";
    if (!name) {
      continue;
    }

    const id = typeof call.id === "string" && call.id.trim() ? call.id.trim() : `call_${out.length + 1}`;
    const argumentsText = stringifyArguments(call.arguments);
    const key = `${id}|${name}|${argumentsText}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push({
      id,
      name,
      arguments: argumentsText,
    });
  }

  return out;
}

function extractAllowedTools(raw: unknown): OllamaFunctionTool[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }

    const record = item as GatewayToolDefinition;
    const fn =
      record.function && typeof record.function === "object" && !Array.isArray(record.function)
        ? record.function
        : undefined;
    const name = typeof fn?.name === "string" ? fn.name.trim() : "";
    if (!name) {
      return [];
    }

    const tool: OllamaFunctionTool = {
      type: "function",
      function: {
        name,
      },
    };

    if (typeof fn?.description === "string" && fn.description.trim()) {
      tool.function.description = fn.description.trim();
    }

    if (fn?.parameters !== undefined) {
      tool.function.parameters = fn.parameters;
    }

    return [tool];
  });
}

function createAllowedToolNameResolver(
  tools: OllamaFunctionTool[],
): (rawName: string) => string {
  const exact = new Map<string, string>();
  const normalized = new Map<string, string>();
  const aliases = new Map<string, string>();

  for (const tool of tools) {
    const name = tool.function.name;
    exact.set(name, name);
    normalized.set(normalizeToolName(name), name);
    aliases.set(normalizeToolAlias(name), name);
  }

  return (rawName: string): string => {
    const trimmed = rawName.trim();
    return (
      exact.get(trimmed) ??
      normalized.get(normalizeToolName(trimmed)) ??
      aliases.get(normalizeToolAlias(trimmed)) ??
      trimmed
    );
  };
}

function normalizeOllamaToolCalls(
  raw: unknown,
  toolNameResolver: (rawName: string) => string,
): OllamaToolCall[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.flatMap((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }

    const record = item as Record<string, unknown>;
    const fn =
      record.function && typeof record.function === "object" && !Array.isArray(record.function)
        ? (record.function as Record<string, unknown>)
        : null;
    const rawName =
      typeof fn?.name === "string"
        ? fn.name.trim()
        : typeof record.name === "string"
          ? record.name.trim()
          : "";
    if (!rawName) {
      return [];
    }

    const id =
      typeof record.id === "string" && record.id.trim() ? record.id.trim() : `call_${index + 1}`;
    return [
      {
        id,
        name: toolNameResolver(rawName),
        arguments: stringifyArguments(fn?.arguments ?? record.arguments ?? {}),
      },
    ];
  });
}

function normalizeFinishReason(doneReason: unknown, hasToolCalls: boolean): FinishReason {
  if (hasToolCalls) {
    return "tool_calls";
  }

  if (doneReason === "length") {
    return "length";
  }
  if (doneReason === "error") {
    return "error";
  }

  return "stop";
}

function buildOllamaOptions(metadata: Record<string, unknown> | null): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  const mappings: Array<{
    target: string;
    metadataKeys: string[];
    envKey: string;
    integer?: boolean;
  }> = [
    { target: "num_ctx", metadataKeys: ["num_ctx"], envKey: "OLLAMA_NUM_CTX", integer: true },
    {
      target: "num_predict",
      metadataKeys: ["num_predict", "max_tokens"],
      envKey: "OLLAMA_NUM_PREDICT",
      integer: true,
    },
    { target: "temperature", metadataKeys: ["temperature"], envKey: "OLLAMA_TEMPERATURE" },
    { target: "top_p", metadataKeys: ["top_p"], envKey: "OLLAMA_TOP_P" },
    { target: "top_k", metadataKeys: ["top_k"], envKey: "OLLAMA_TOP_K", integer: true },
    { target: "seed", metadataKeys: ["seed"], envKey: "OLLAMA_SEED", integer: true },
    {
      target: "repeat_penalty",
      metadataKeys: ["repeat_penalty"],
      envKey: "OLLAMA_REPEAT_PENALTY",
    },
  ];

  for (const mapping of mappings) {
    const rawValue = firstDefined(...mapping.metadataKeys.map((key) => metadata?.[key]));
    const resolved =
      rawValue !== undefined
        ? mapping.integer
          ? parseInteger(rawValue)
          : parseNumber(rawValue)
        : mapping.integer
          ? parseInteger(process.env[mapping.envKey])
          : parseNumber(process.env[mapping.envKey]);
    if (resolved !== undefined) {
      options[mapping.target] = resolved;
    }
  }

  const stop = resolveStop(metadata);
  if (stop.length > 0) {
    options.stop = stop;
  }

  return options;
}

function resolveStop(metadata: Record<string, unknown> | null): string[] {
  const rawStop = metadata?.stop;
  if (typeof rawStop === "string" && rawStop.trim()) {
    return [rawStop];
  }
  if (!Array.isArray(rawStop)) {
    return [];
  }

  return rawStop.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function resolveKeepAlive(metadata: Record<string, unknown> | null): string | number | undefined {
  const raw = firstDefined(metadata?.keep_alive, metadata?.keepAlive, process.env.OLLAMA_KEEP_ALIVE);
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) {
      return undefined;
    }
    const numeric = Number(trimmed);
    return Number.isFinite(numeric) ? numeric : trimmed;
  }
  return undefined;
}

function resolveResponseFormat(metadata: Record<string, unknown> | null): unknown {
  const directFormat = metadata?.format;
  if (directFormat !== undefined) {
    return directFormat;
  }

  const responseFormat = metadata?.response_format;
  if (!responseFormat || typeof responseFormat !== "object" || Array.isArray(responseFormat)) {
    return undefined;
  }

  const record = responseFormat as Record<string, unknown>;
  if (record.type === "json_object") {
    return "json";
  }
  if (record.type === "json_schema") {
    const schemaRecord =
      record.json_schema && typeof record.json_schema === "object" && !Array.isArray(record.json_schema)
        ? (record.json_schema as Record<string, unknown>)
        : null;
    return schemaRecord?.schema;
  }

  return undefined;
}

function resolveThinkValue(
  request: GatewayRequest,
  metadata: Record<string, unknown> | null,
): boolean | undefined {
  const explicit = firstDefined(metadata?.ollama_think, metadata?.think, metadata?.include_reasoning);
  const explicitBoolean = parseBoolean(explicit);
  if (explicitBoolean !== undefined) {
    return explicitBoolean;
  }

  const reasoningEffort = resolveReasoningEffort(request);
  if (!reasoningEffort) {
    return undefined;
  }

  return reasoningEffort !== "low";
}

function safeJsonParseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function stringifyArguments(value: unknown): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return "{}";
    }

    try {
      const reparsed = JSON.parse(trimmed);
      return JSON.stringify(reparsed);
    } catch {
      return JSON.stringify({ value: trimmed });
    }
  }

  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") {
    return false;
  }
  return undefined;
}

function parseNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseInteger(value: unknown): number | undefined {
  const parsed = parseNumber(value);
  return parsed !== undefined && Number.isInteger(parsed) ? parsed : undefined;
}

function firstDefined<T>(...values: T[]): T | undefined {
  for (const value of values) {
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

async function readStdin(): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

if (require.main === module) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
