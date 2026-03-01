export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string;
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
  raw?: unknown;
}

export type CommandOutputMode =
  | "text"
  | "text_plain"
  | "text_contract_final_line"
  | "json_contract";
export type CommandInputMode = "prompt_stdin" | "request_json_stdin";

export interface CommandSpec {
  executable: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs: number;
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
  auth?: AuthConfig;
}

export interface ProvidersFile {
  providers: CliProviderConfig[];
}

export interface AppConfig {
  host: string;
  port: number;
  n8nApiKeys: Set<string>;
  adminApiKey: string;
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
