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
