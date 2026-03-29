import type { JobManager } from "../jobs/job-manager";
import type {
  AuthStatusResult,
  LoginJobSummary,
  OpenAiCompatibleProviderConfig,
  ProviderModelConfig,
  ProviderRateLimits,
  ProviderResult,
  ProviderToolCall,
  UnifiedRequest,
} from "../types";
import { normalizeAssistantResult } from "../utils/assistant-output";
import type { Provider } from "./provider";

const DEFAULT_TIMEOUT_MS = 240000;
const DEFAULT_DISCOVERY_EXCLUDES = [
  "*whisper*",
  "*transcribe*",
  "*transcription*",
  "*speech*",
  "*tts*",
  "*guard*",
];

type ApiMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id?: string;
    type: "function";
    function: {
      name: string;
      arguments: string;
    };
  }>;
};

type ProviderRequestInit = {
  method: string;
  body?: string;
  headers?: Record<string, string>;
};

export class OpenAiCompatibleProvider implements Provider {
  readonly id: string;
  readonly description?: string;
  readonly config: OpenAiCompatibleProviderConfig;
  readonly models: ProviderModelConfig[];

  private constructor(config: OpenAiCompatibleProviderConfig, models: ProviderModelConfig[]) {
    this.id = config.id;
    this.description = config.description;
    this.config = config;
    this.models = models;
  }

  static async create(
    config: OpenAiCompatibleProviderConfig,
  ): Promise<OpenAiCompatibleProvider> {
    const models = await resolveProviderModels(config);
    if (models.length === 0) {
      throw new Error(`Provider ${config.id} resolved zero models.`);
    }
    return new OpenAiCompatibleProvider(config, models);
  }

  async run(request: UnifiedRequest): Promise<ProviderResult> {
    const modelConfig = this.models.find((model) => model.id === request.model);
    if (!modelConfig) {
      throw new Error(`Provider ${this.id} does not expose model ${request.model}.`);
    }

    const providerModel = modelConfig.providerModel || request.providerModel;
    const suppressGroqLocalToolCalling = shouldSuppressGroqLocalToolCalling(
      this.config.baseUrl,
      providerModel,
    );
    const body: Record<string, unknown> = {
      model: providerModel,
      messages: buildApiMessages(request.messages, {
        suppressLocalToolCalling: suppressGroqLocalToolCalling,
      }),
      stream: false,
    };

    const metadata = request.metadata;
    copyNumberMetadata(body, metadata, "temperature");
    copyNumberMetadata(body, metadata, "top_p");
    copyNumberMetadata(body, metadata, "presence_penalty");
    copyNumberMetadata(body, metadata, "frequency_penalty");
    copyIntegerMetadata(body, metadata, "max_tokens");
    copyStringMetadata(body, metadata, "user");
    copyStringMetadata(body, metadata, "reasoning_format");
    copyBooleanMetadata(body, metadata, "include_reasoning");

    const groqReasoningEffort = normalizeGroqReasoningEffort(
      this.config.baseUrl,
      providerModel,
      request.reasoningEffort,
    );
    if (groqReasoningEffort) {
      body.reasoning_effort = groqReasoningEffort;
    }

    const toolChoice = metadata && "tool_choice" in metadata ? metadata.tool_choice : undefined;
    if (request.tools.length > 0 && !suppressGroqLocalToolCalling) {
      body.tools = request.tools;
      if (toolChoice !== undefined) {
        body.tool_choice = toolChoice;
      }
    }

    const response = await this.requestJson("/chat/completions", {
      method: "POST",
      body: JSON.stringify(body),
    });

    return parseChatCompletionResponse(response);
  }

  async startLoginJob(_jobManager: JobManager): Promise<LoginJobSummary> {
    throw new Error(
      `Provider ${this.id} uses API keys and does not support login jobs. Set ${this.config.apiKeyEnv} in the environment.`,
    );
  }

  async checkAuthStatus(): Promise<AuthStatusResult> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      return {
        ok: false,
        exitCode: 1,
        stdout: "",
        stderr: `${this.config.apiKeyEnv} is not set`,
      };
    }

    try {
      await this.requestJson("/models", { method: "GET" });
      return {
        ok: true,
        exitCode: 0,
        stdout: "ok",
        stderr: "",
      };
    } catch (error) {
      return {
        ok: false,
        exitCode: 1,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async checkRateLimits(): Promise<ProviderRateLimits> {
    return {
      providerId: this.id,
      providerDescription: this.description,
      status: "unknown",
      limits: [],
      lastCheckedAt: new Date().toISOString(),
    };
  }

  private getApiKey(): string {
    return process.env[this.config.apiKeyEnv]?.trim() || "";
  }

  private async requestJson(pathname: string, init: ProviderRequestInit): Promise<unknown> {
    return await requestProviderJson(this.config, pathname, init);
  }
}

async function resolveProviderModels(
  config: OpenAiCompatibleProviderConfig,
): Promise<ProviderModelConfig[]> {
  const configuredModels = config.models ?? [];
  const shouldDiscover = config.discovery?.enabled ?? configuredModels.length === 0;
  if (!shouldDiscover) {
    return configuredModels;
  }

  try {
    const discoveredModels = await fetchDiscoveredModelIds(config);
    return mergeConfiguredAndDiscoveredModels(configuredModels, discoveredModels);
  } catch (error) {
    if (configuredModels.length > 0) {
      return configuredModels;
    }
    throw new Error(
      `Provider ${config.id} model discovery failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function fetchDiscoveredModelIds(
  config: OpenAiCompatibleProviderConfig,
): Promise<string[]> {
  const payload = await requestProviderJson(config, "/models", { method: "GET" });
  const data = extractModelList(payload);
  const includePatterns = config.discovery?.include ?? [];
  const excludePatterns =
    config.discovery?.exclude && config.discovery.exclude.length > 0
      ? config.discovery.exclude
      : DEFAULT_DISCOVERY_EXCLUDES;

  const discovered: string[] = [];
  for (const item of data) {
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!id) {
      continue;
    }

    if (item.active === false) {
      continue;
    }

    if (includePatterns.length > 0 && !includePatterns.some((pattern) => matchesPattern(id, pattern))) {
      continue;
    }

    if (excludePatterns.some((pattern) => matchesPattern(id, pattern))) {
      continue;
    }

    if (!discovered.includes(id)) {
      discovered.push(id);
    }
  }

  return discovered;
}

function mergeConfiguredAndDiscoveredModels(
  configuredModels: ProviderModelConfig[],
  discoveredModelIds: string[],
): ProviderModelConfig[] {
  const configuredByProviderModel = new Map<string, ProviderModelConfig>();
  const configuredById = new Map<string, ProviderModelConfig>();

  for (const model of configuredModels) {
    configuredByProviderModel.set(model.providerModel || model.id, model);
    configuredById.set(model.id, model);
  }

  const merged: ProviderModelConfig[] = [];
  const usedConfigured = new Set<ProviderModelConfig>();

  for (const discoveredId of discoveredModelIds) {
    const configured =
      configuredByProviderModel.get(discoveredId) ?? configuredById.get(discoveredId);
    if (configured) {
      merged.push(configured);
      usedConfigured.add(configured);
      continue;
    }

    merged.push({
      id: discoveredId,
      providerModel: discoveredId,
    });
  }

  for (const model of configuredModels) {
    if (!usedConfigured.has(model)) {
      merged.push(model);
    }
  }

  return merged;
}

function extractModelList(payload: unknown): Array<{ id?: unknown; active?: unknown }> {
  if (!payload || typeof payload !== "object") {
    throw new Error("Provider /models response must be an object.");
  }

  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    throw new Error("Provider /models response is missing a data array.");
  }

  return data
    .filter((item): item is { id?: unknown; active?: unknown } => Boolean(item && typeof item === "object"));
}

function buildApiMessages(
  messages: UnifiedRequest["messages"],
  options?: { suppressLocalToolCalling?: boolean },
): ApiMessage[] {
  const suppressLocalToolCalling = Boolean(options?.suppressLocalToolCalling);
  return messages.flatMap((message) => {
    if (message.role === "assistant") {
      const parsed = splitAssistantToolContext(message.content);
      if (!suppressLocalToolCalling && parsed.toolCalls.length > 0) {
        return {
          role: "assistant",
          content: parsed.content || null,
          tool_calls: parsed.toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: {
              name: call.name,
              arguments: call.arguments,
            },
          })),
        };
      }

      return {
        role: "assistant",
        content: parsed.content || message.content || null,
      };
    }

    if (message.role === "tool") {
      if (suppressLocalToolCalling) {
        const toolResult = message.content.trim();
        if (!toolResult) {
          return [];
        }
        return {
          role: "user",
          content: `Context from a previous tool result:\n${toolResult}`,
        };
      }

      return {
        role: "tool",
        content: message.content,
        tool_call_id: message.tool_call_id,
      };
    }

    return {
      role: message.role,
      content: message.content,
    };
  });
}

function splitAssistantToolContext(content: string): {
  content: string;
  toolCalls: ProviderToolCall[];
} {
  const marker = "\n\nTOOL_CALLS:\n";
  const markerIndex = content.indexOf(marker);
  const fallbackMarker = "TOOL_CALLS:\n";
  const splitIndex = markerIndex >= 0 ? markerIndex : content.indexOf(fallbackMarker);
  if (splitIndex < 0) {
    return { content, toolCalls: [] };
  }

  const toolCallsRaw = content
    .slice(splitIndex + (markerIndex >= 0 ? marker.length : fallbackMarker.length))
    .trim();
  const baseContent = content.slice(0, splitIndex).trim();
  const parsed = tryParseJson(toolCallsRaw);
  if (!Array.isArray(parsed)) {
    return { content, toolCalls: [] };
  }

  const toolCalls: ProviderToolCall[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (!name) {
      continue;
    }

    const id = typeof record.id === "string" ? record.id : undefined;
    const argumentsValue = normalizeToolArguments(record.arguments);
    toolCalls.push({
      id: id || `call_${toolCalls.length + 1}`,
      name,
      arguments: argumentsValue,
    });
  }

  return {
    content: baseContent,
    toolCalls,
  };
}

function parseChatCompletionResponse(payload: unknown): ProviderResult {
  if (!payload || typeof payload !== "object") {
    throw new Error("Provider API returned a non-object response.");
  }

  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error("Provider API returned no choices.");
  }

  const firstChoice = choices[0];
  if (!firstChoice || typeof firstChoice !== "object") {
    throw new Error("Provider API choice is invalid.");
  }

  const choice = firstChoice as Record<string, unknown>;
  const message = choice.message && typeof choice.message === "object"
    ? (choice.message as Record<string, unknown>)
    : undefined;

  const toolCalls = normalizeApiToolCalls(message?.tool_calls);
  const finishReason = normalizeFinishReason(choice.finish_reason, toolCalls.length > 0);

  return normalizeAssistantResult({
    outputText: extractMessageText(payload, choice, message),
    toolCalls,
    finishReason,
    raw: payload,
  });
}

function shouldSuppressGroqLocalToolCalling(baseUrl: string, providerModel: string): boolean {
  if (!isGroqBaseUrl(baseUrl)) {
    return false;
  }

  return /^groq\/compound(?:-mini)?$/i.test(providerModel.trim());
}

function isGroqBaseUrl(baseUrl: string): boolean {
  return /api\.groq\.com/i.test(baseUrl);
}

function normalizeApiToolCalls(raw: unknown): ProviderToolCall[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const toolCalls: ProviderToolCall[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const record = item as Record<string, unknown>;
    const fn = record.function && typeof record.function === "object"
      ? (record.function as Record<string, unknown>)
      : undefined;
    const name = typeof fn?.name === "string" ? fn.name.trim() : "";
    if (!name) {
      continue;
    }

    toolCalls.push({
      id: typeof record.id === "string" && record.id ? record.id : `call_${toolCalls.length + 1}`,
      name,
      arguments: normalizeToolArguments(fn?.arguments),
    });
  }

  return toolCalls;
}

function extractMessageText(
  payload: unknown,
  choice: Record<string, unknown>,
  message?: Record<string, unknown>,
): string {
  const directCandidates = [
    message?.content,
    message?.text,
    message?.output_text,
    message?.refusal,
    choice.text,
    choice.output_text,
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>).output_text
      : undefined,
  ];

  for (const candidate of directCandidates) {
    const extracted = extractTextCandidate(candidate);
    if (extracted) {
      return extracted;
    }
  }

  return "";
}

function extractTextCandidate(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }

  if (content && typeof content === "object" && !Array.isArray(content)) {
    const record = content as Record<string, unknown>;
    const direct = [
      record.text,
      record.content,
      record.output_text,
      record.refusal,
    ];
    for (const candidate of direct) {
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate.trim();
      }
    }
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const record = item as Record<string, unknown>;
    if (typeof record.text === "string" && record.text.trim()) {
      parts.push(record.text.trim());
      continue;
    }

    if (
      record.type === "output_text" &&
      typeof record.text === "string" &&
      record.text.trim()
    ) {
      parts.push(record.text.trim());
    }
  }

  return parts.join("\n\n").trim();
}

function normalizeFinishReason(
  value: unknown,
  hasToolCalls: boolean,
): ProviderResult["finishReason"] {
  if (
    value === "stop" ||
    value === "tool_calls" ||
    value === "length" ||
    value === "error"
  ) {
    return value;
  }

  return hasToolCalls ? "tool_calls" : "stop";
}

function normalizeToolArguments(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

async function requestProviderJson(
  config: OpenAiCompatibleProviderConfig,
  pathname: string,
  init: ProviderRequestInit,
): Promise<unknown> {
  const apiKey = process.env[config.apiKeyEnv]?.trim();
  if (!apiKey) {
    throw new Error(`${config.apiKeyEnv} is not set.`);
  }

  const controller = new AbortController();
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(buildProviderUrl(config.baseUrl, pathname), {
      ...init,
      headers: buildRequestHeaders(apiKey, init.headers),
      signal: controller.signal,
    });

    const text = await response.text();
    const payload = tryParseJson(text);

    if (!response.ok) {
      const message =
        extractApiErrorMessage(payload) ||
        text.trim() ||
        `${response.status} ${response.statusText}`;
      throw new Error(`Provider API request failed (${response.status}): ${message}`);
    }

    if (payload === null) {
      throw new Error("Provider API returned invalid JSON.");
    }

    return payload;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Provider API request timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function buildProviderUrl(baseUrl: string, pathname: string): string {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${normalizedBaseUrl}${normalizedPath}`;
}

function buildRequestHeaders(
  apiKey: string,
  headers?: Record<string, string>,
): Record<string, string> {
  const merged: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  for (const [key, value] of Object.entries(headers ?? {})) {
    merged[key] = value;
  }

  return merged;
}

function copyNumberMetadata(
  target: Record<string, unknown>,
  metadata: UnifiedRequest["metadata"],
  key: string,
): void {
  const value = metadata && key in metadata ? metadata[key] : undefined;
  if (typeof value === "number") {
    target[key] = value;
  }
}

function copyIntegerMetadata(
  target: Record<string, unknown>,
  metadata: UnifiedRequest["metadata"],
  key: string,
): void {
  const value = metadata && key in metadata ? metadata[key] : undefined;
  if (typeof value === "number" && Number.isInteger(value)) {
    target[key] = value;
  }
}

function copyStringMetadata(
  target: Record<string, unknown>,
  metadata: UnifiedRequest["metadata"],
  key: string,
): void {
  const value = metadata && key in metadata ? metadata[key] : undefined;
  if (typeof value === "string" && value.trim()) {
    target[key] = value;
  }
}

function copyBooleanMetadata(
  target: Record<string, unknown>,
  metadata: UnifiedRequest["metadata"],
  key: string,
): void {
  const value = metadata && key in metadata ? metadata[key] : undefined;
  if (typeof value === "boolean") {
    target[key] = value;
  }
}

function normalizeGroqReasoningEffort(
  baseUrl: string,
  providerModel: string,
  reasoningEffort: UnifiedRequest["reasoningEffort"],
): "low" | "medium" | "high" | undefined {
  if (!reasoningEffort) {
    return undefined;
  }

  if (!/api\.groq\.com/i.test(baseUrl) || !/^openai\/gpt-oss-(20b|120b)$/i.test(providerModel)) {
    return undefined;
  }

  if (reasoningEffort === "xhigh") {
    return "high";
  }

  return reasoningEffort === "low" || reasoningEffort === "medium" || reasoningEffort === "high"
    ? reasoningEffort
    : undefined;
}

function extractApiErrorMessage(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  const error = (payload as { error?: unknown }).error;
  if (!error || typeof error !== "object") {
    return "";
  }

  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message.trim() : "";
}

function tryParseJson(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function matchesPattern(value: string, pattern: string): boolean {
  const escaped = escapeRegExp(pattern).replace(/\\\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
