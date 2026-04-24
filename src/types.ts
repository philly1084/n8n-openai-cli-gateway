export type ChatRole = "system" | "user" | "assistant" | "tool";
export type AssistantPhase = "commentary" | "final_answer";
export const REASONING_EFFORT_VALUES = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;
export type ReasoningEffort = (typeof REASONING_EFFORT_VALUES)[number];

export interface ChatMessage {
  role: ChatRole;
  content: string;
  phase?: AssistantPhase;
  name?: string;
  tool_call_id?: string;
}

export interface UnifiedToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: unknown;
  };
}

export interface UnifiedRequest {
  requestId: string;
  model: string;
  providerModel: string;
  messages: ChatMessage[];
  tools: UnifiedToolDefinition[];
  stream?: boolean;
  requestKind?: string;
  reasoningEffort?: ReasoningEffort;
  metadata?: Record<string, unknown>;
}

export interface ProviderToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ProviderResult {
  outputText: string;
  toolCalls: ProviderToolCall[];
  finishReason: "stop" | "tool_calls" | "length" | "error";
  reasoningText?: string;
  raw?: unknown;
}

export type ProviderStreamEvent =
  | {
    type: "reasoning_delta";
    delta: string;
  }
  | {
    type: "output_text_delta";
    delta: string;
  }
  | {
    type: "tool_call";
    toolCall: ProviderToolCall;
  }
  | {
    type: "done";
    finishReason: ProviderResult["finishReason"];
    outputText?: string;
    reasoningText?: string;
  };

export type CommandOutputMode =
  | "text"
  | "text_plain"
  | "text_contract_final_line"
  | "json_contract";
export type CommandInputMode = "prompt_stdin" | "request_json_stdin";
export type SessionPtyMode = "auto" | "pipe" | "script";
export type ProviderSessionMode = "interactive" | "login";
export type ProviderSessionStatus =
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "terminated"
  | "timed_out";

export interface CommandSpec {
  executable: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs: number;
}

export interface SessionCommandConfig {
  executable: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  loginArgs?: string[];
  supportsModelSelection?: boolean;
  modelFlag?: string;
  supportsWorkingDirectory?: boolean;
  idleTimeoutMs?: number;
  maxLifetimeMs?: number;
  ptyMode?: SessionPtyMode;
}

export interface AuthConfig {
  loginCommand?: CommandSpec;
  statusCommand?: CommandSpec;
  /** Command to check rate limits/quota for this provider */
  rateLimitCommand?: CommandSpec;
}

export interface ProviderModelConfig {
  id: string;
  providerModel?: string;
  description?: string;
  fallbackModels?: string[];
  capabilities?: ModelCapability[];
}

export type ModelCapability = "image_generation";

export interface ModelDiscoveryConfig {
  enabled?: boolean;
  include?: string[];
  exclude?: string[];
}

export interface CliProviderConfig {
  id: string;
  type: "cli";
  description?: string;
  models: ProviderModelConfig[];
  responseCommand: CommandSpec & {
    output: CommandOutputMode;
    input: CommandInputMode;
  };
  sessionCommand?: SessionCommandConfig;
  auth?: AuthConfig;
}

export interface OpenAiCompatibleProviderConfig {
  id: string;
  type: "openai";
  description?: string;
  baseUrl: string;
  apiKeyEnv: string;
  timeoutMs?: number;
  models?: ProviderModelConfig[];
  discovery?: ModelDiscoveryConfig;
}

export type ProviderConfig = CliProviderConfig | OpenAiCompatibleProviderConfig;

export interface ProvidersFile {
  providers: ProviderConfig[];
}

export interface AppConfig {
  host: string;
  port: number;
  n8nApiKeys: Set<string>;
  adminApiKey: string;
  frontendApiKeys: Set<string>;
  frontendAllowedCwds: string[];
  providersPath: string;
  logLevel: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
  maxJobLogLines: number;
  // Graceful shutdown timeout in milliseconds
  shutdownTimeoutMs: number;
  // Rate limiting configuration
  rateLimitMax: number;
  rateLimitWindowMs: number;
  // Request body size limit in bytes
  maxRequestBodySize: number;
  // Default reasoning effort when callers omit it
  defaultReasoningEffort?: ReasoningEffort;
}

export interface AuthStatusResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface LoginJobSummary {
  id: string;
  providerId: string;
  command: string;
  args: string[];
  status: "running" | "completed" | "failed";
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  urls: string[];
  logs: string[];
}

// Rate limit tracking types
export interface RateLimitInfo {
  /** Provider ID */
  providerId: string;
  /** Model ID (if model-specific) */
  modelId?: string;
  /** Type of limit */
  limitType: "requests" | "tokens" | "credits" | "billing" | "unknown";
  /** Current usage (if available) */
  currentUsage?: number;
  /** Maximum allowed (if available) */
  maxAllowed?: number;
  /** Remaining quota (if available) */
  remaining?: number;
  /** When the limit resets (ISO timestamp) */
  resetAt?: string;
  /** Time when this data was fetched */
  checkedAt: string;
  /** Whether the check was successful */
  ok: boolean;
  /** Error message if check failed */
  error?: string;
  /** Raw output from the provider command */
  raw?: unknown;
}

export interface ProviderRateLimits {
  providerId: string;
  providerDescription?: string;
  /** Overall provider status */
  status: "healthy" | "degraded" | "rate_limited" | "auth_error" | "unknown";
  /** Rate limit info for this provider */
  limits: RateLimitInfo[];
  /** When all limits were last checked */
  lastCheckedAt?: string;
}

export interface ProviderSessionCapability {
  providerId: string;
  providerDescription?: string;
  providerType: ProviderConfig["type"];
  supportsSessions: boolean;
  supportsLoginSessions: boolean;
  supportsModelSelection: boolean;
  supportsWorkingDirectory: boolean;
  ptyMode?: SessionPtyMode;
  models: ProviderModelConfig[];
}

export interface ProviderSessionSummary {
  id: string;
  providerId: string;
  providerDescription?: string;
  mode: ProviderSessionMode;
  status: ProviderSessionStatus;
  model?: string;
  cwd?: string;
  cols: number;
  rows: number;
  createdAt: string;
  startedAt: string;
  lastActivityAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  supportsResize: boolean;
  streamToken: string;
}

export type ProviderSessionEvent =
  | {
    type: "output";
    cursor: number;
    ts: string;
    data: string;
  }
  | {
    type: "status";
    cursor: number;
    ts: string;
    status: ProviderSessionStatus;
    message?: string;
  }
  | {
    type: "exit";
    cursor: number;
    ts: string;
    exitCode: number | null;
  };
