import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { JobManager } from "../jobs/job-manager";
import type {
  AuthStatusResult,
  CliProviderConfig,
  LoginJobSummary,
  ProviderResult,
  ProviderToolCall,
  UnifiedRequest,
  UnifiedToolDefinition,
} from "../types";
import { runCommand, resolveCommand } from "../utils/command";
import { buildPrompt } from "../utils/prompt";
import type { Provider } from "./provider";

interface JsonContract {
  output_text?: string;
  text?: string;
  content?: string;
  tool_calls?: unknown[];
  finish_reason?: "stop" | "tool_calls" | "length" | "error";
}

export class CliProvider implements Provider {
  readonly id: string;
  readonly description?: string;
  readonly config: CliProviderConfig;
  readonly models: CliProviderConfig["models"];

  constructor(config: CliProviderConfig) {
    this.id = config.id;
    this.description = config.description;
    this.config = config;
    this.models = config.models;
  }

  async run(request: UnifiedRequest): Promise<ProviderResult> {
    const modelConfig = this.models.find((model) => model.id === request.model);
    if (!modelConfig) {
      throw new Error(`Provider ${this.id} does not expose model ${request.model}.`);
    }

    const basePrompt = buildPrompt(request.messages);
    const prompt =
      this.config.responseCommand.input === "prompt_stdin"
        ? buildPromptWithTools(basePrompt, request.tools)
        : basePrompt;
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "n8n-openai-gateway-"));
    const promptFile = path.join(tmpDir, "prompt.txt");
    const requestFile = path.join(tmpDir, "request.json");

    const requestPayload = {
      ...request,
      prompt,
    };

    await writeFile(promptFile, prompt, "utf8");
    await writeFile(requestFile, JSON.stringify(requestPayload, null, 2), "utf8");

    const vars = {
      request_id: request.requestId,
      provider_id: this.id,
      model: request.model,
      provider_model: modelConfig.providerModel || request.providerModel,
      prompt,
      prompt_file: promptFile,
      request_file: requestFile,
    };

    try {
      const resolved = resolveCommand(this.config.responseCommand, vars);
      const stdinPayload =
        this.config.responseCommand.input === "request_json_stdin"
          ? JSON.stringify(requestPayload)
          : prompt;

      const output = await runCommand(resolved, stdinPayload);
      if (output.timedOut) {
        throw new Error(`Provider command timed out after ${resolved.timeoutMs}ms.`);
      }

      if (output.exitCode !== 0) {
        throw new Error(
          [
            `Provider command exited with code ${output.exitCode}.`,
            output.stderr ? `stderr: ${output.stderr.trim()}` : "",
            output.stdout ? `stdout: ${output.stdout.trim()}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        );
      }

      const parsed = this.parseOutput(output.stdout);
      return normalizeResultToolCalls(parsed, request.tools);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }

  async startLoginJob(jobManager: JobManager): Promise<LoginJobSummary> {
    const command = this.config.auth?.loginCommand;
    if (!command) {
      throw new Error(`Provider ${this.id} does not define auth.loginCommand.`);
    }

    return await jobManager.startCommand(this.id, command, {
      provider_id: this.id,
    });
  }

  async checkAuthStatus(): Promise<AuthStatusResult> {
    const command = this.config.auth?.statusCommand;
    if (!command) {
      return {
        ok: false,
        exitCode: null,
        stdout: "",
        stderr: "auth.statusCommand not configured",
      };
    }

    const resolved = resolveCommand(command, {
      provider_id: this.id,
    });
    const output = await runCommand(resolved);
    return {
      ok: output.exitCode === 0 && !output.timedOut,
      exitCode: output.exitCode,
      stdout: output.stdout,
      stderr: output.stderr,
    };
  }

  private parseOutput(stdout: string): ProviderResult {
    const mode = this.config.responseCommand.output;
    if (mode === "text") {
      // Allow text-mode providers to opt into tool calling by emitting the JSON contract.
      const contract = tryParseJsonContractSoft(stdout);
      if (contract && (contract.output_text || contract.text || contract.content || contract.tool_calls?.length)) {
        const toolCalls = normalizeToolCalls(contract.tool_calls);
        return {
          outputText: (contract.output_text ?? contract.text ?? contract.content ?? "").trim(),
          toolCalls,
          finishReason:
            contract.finish_reason ?? (toolCalls.length > 0 ? "tool_calls" : "stop"),
          raw: contract,
        };
      }

      return {
        outputText: stdout.trim(),
        toolCalls: [],
        finishReason: "stop",
      };
    }

    const json = tryParseJsonContract(stdout);
    const toolCalls = normalizeToolCalls(json.tool_calls);

    const outputText = (json.output_text ?? json.text ?? json.content ?? "").trim();
    const finishReason =
      json.finish_reason ??
      (toolCalls.length > 0 ? "tool_calls" : "stop");

    return {
      outputText,
      toolCalls,
      finishReason,
      raw: json,
    };
  }
}

function normalizeResultToolCalls(
  result: ProviderResult,
  tools: UnifiedToolDefinition[],
): ProviderResult {
  const allowedTools = extractAllowedTools(tools);
  if (result.toolCalls.length === 0) {
    return result;
  }

  if (allowedTools.size === 0) {
    return {
      ...result,
      toolCalls: [],
      finishReason: result.finishReason === "tool_calls" ? "stop" : result.finishReason,
    };
  }

  const mappedToolCalls: ProviderToolCall[] = [];
  for (const call of result.toolCalls) {
    const toolMeta = allowedTools.get(normalizeToolName(call.name));
    if (!toolMeta) {
      continue;
    }
    mappedToolCalls.push({
      ...call,
      name: toolMeta.name,
      arguments: canonicalizeArgumentsForTool(call.arguments, toolMeta.argumentKeyMap),
    });
  }

  return {
    ...result,
    toolCalls: mappedToolCalls,
    finishReason:
      mappedToolCalls.length > 0
        ? result.finishReason
        : result.finishReason === "tool_calls"
          ? "stop"
          : result.finishReason,
  };
}

type AllowedToolMeta = {
  name: string;
  argumentKeyMap: Map<string, string>;
};

function extractAllowedTools(tools: UnifiedToolDefinition[]): Map<string, AllowedToolMeta> {
  const out = new Map<string, AllowedToolMeta>();
  for (const item of tools) {
    if (!item || item.type !== "function") {
      continue;
    }
    const name = typeof item.function.name === "string" ? item.function.name.trim() : "";
    if (!name) {
      continue;
    }
    out.set(normalizeToolName(name), {
      name,
      argumentKeyMap: buildArgumentKeyMap(item.function.parameters),
    });
  }
  return out;
}

function normalizeToolName(name: string): string {
  return name
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s\-./]+/g, "_")
    .replace(/[^A-Za-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function normalizeArgumentKey(name: string): string {
  return normalizeToolName(name);
}

function buildArgumentKeyMap(parameters: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!parameters || typeof parameters !== "object") {
    return out;
  }
  const props = (parameters as Record<string, unknown>).properties;
  if (!props || typeof props !== "object" || Array.isArray(props)) {
    return out;
  }
  for (const key of Object.keys(props as Record<string, unknown>)) {
    if (!key) {
      continue;
    }
    out.set(normalizeArgumentKey(key), key);
  }
  return out;
}

function canonicalizeArgumentsForTool(
  rawArgs: string,
  argumentKeyMap: Map<string, string>,
): string {
  if (argumentKeyMap.size === 0) {
    return rawArgs;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArgs);
  } catch {
    return rawArgs;
  }

  const sanitized = sanitizeArgumentKeys(parsed);
  if (!sanitized || typeof sanitized !== "object" || Array.isArray(sanitized)) {
    try {
      return JSON.stringify(sanitized ?? {});
    } catch {
      return rawArgs;
    }
  }

  const out: Record<string, unknown> = {};
  for (const [rawKey, value] of Object.entries(sanitized as Record<string, unknown>)) {
    const trimmedKey = String(rawKey ?? "").trim();
    const canonicalKey =
      argumentKeyMap.get(normalizeArgumentKey(trimmedKey)) ?? trimmedKey;
    out[canonicalKey] = value;
  }

  try {
    return JSON.stringify(out);
  } catch {
    return rawArgs;
  }
}

function buildPromptWithTools(prompt: string, tools: UnifiedToolDefinition[]): string {
  if (!tools.length) {
    return prompt;
  }

  const toolSpec = JSON.stringify(tools, null, 2);
  return [
    prompt,
    "",
    "AVAILABLE_TOOLS_JSON:",
    toolSpec,
    "",
    "If a tool is needed, respond ONLY with valid JSON in this exact shape:",
    '{"output_text":"","tool_calls":[{"id":"call_1","name":"tool_name","arguments":"{\\"key\\":\\"value\\"}"}],"finish_reason":"tool_calls"}',
    "",
    'If no tool is needed, respond ONLY with valid JSON: {"output_text":"...","finish_reason":"stop"}',
  ].join("\n");
}

function tryParseJsonContract(stdout: string): JsonContract {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error("Provider returned empty output while json_contract mode is enabled.");
  }

  try {
    return normalizeContract(JSON.parse(trimmed));
  } catch {
    const lines = trimmed.split(/\r?\n/).reverse();
    for (const line of lines) {
      const candidate = line.trim();
      if (!candidate) {
        continue;
      }
      try {
        return normalizeContract(JSON.parse(candidate));
      } catch {
        continue;
      }
    }
  }

  throw new Error("Unable to parse provider JSON output. Check responseCommand.output mode.");
}

function tryParseJsonContractSoft(stdout: string): JsonContract | null {
  try {
    return tryParseJsonContract(stdout);
  } catch {
    return null;
  }
}

function normalizeContract(value: unknown): JsonContract {
  if (!value || typeof value !== "object") {
    throw new Error("Provider JSON output must be an object.");
  }

  const source = value as Record<string, unknown>;
  return {
    output_text:
      typeof source.output_text === "string" ? source.output_text : undefined,
    text: typeof source.text === "string" ? source.text : undefined,
    content: typeof source.content === "string" ? source.content : undefined,
    tool_calls: Array.isArray(source.tool_calls) ? source.tool_calls : undefined,
    finish_reason:
      source.finish_reason === "stop" ||
      source.finish_reason === "tool_calls" ||
      source.finish_reason === "length" ||
      source.finish_reason === "error"
        ? source.finish_reason
        : undefined,
  };
}

function normalizeToolCalls(rawToolCalls: unknown[] | undefined): ProviderToolCall[] {
  if (!rawToolCalls || rawToolCalls.length === 0) {
    return [];
  }

  const calls: ProviderToolCall[] = [];
  for (const entry of rawToolCalls) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const obj = entry as Record<string, unknown>;
    const functionObj =
      obj.function && typeof obj.function === "object"
        ? (obj.function as Record<string, unknown>)
        : undefined;

    const idCandidate =
      (typeof obj.id === "string" && obj.id) ||
      (typeof obj.call_id === "string" && obj.call_id) ||
      (typeof obj.tool_id === "string" && obj.tool_id) ||
      (typeof obj.toolId === "string" && obj.toolId) ||
      undefined;
    const nameCandidate =
      (typeof obj.name === "string" && obj.name) ||
      (typeof obj.tool_name === "string" && obj.tool_name) ||
      (typeof obj.toolName === "string" && obj.toolName) ||
      (functionObj && typeof functionObj.name === "string" ? functionObj.name : undefined);
    const argsRaw =
      obj.arguments ??
      obj.args ??
      obj.parameters ??
      (functionObj ? functionObj.arguments : undefined) ??
      (functionObj ? functionObj.args : undefined) ??
      "{}";

    const nested = extractNestedToolCall(argsRaw);
    if (nested) {
      calls.push({
        id: idCandidate ?? nested.id ?? `call_${calls.length + 1}`,
        name: nested.name || nameCandidate || "tool",
        arguments: nested.arguments,
      });
      continue;
    }

    if (!nameCandidate) {
      continue;
    }

    const args = asToolCallArguments(argsRaw);

    calls.push({
      id: idCandidate ?? `call_${calls.length + 1}`,
      name: nameCandidate,
      arguments: args,
    });
  }

  return calls;
}

function sanitizeArgumentKeys(value: unknown, depth = 0): unknown {
  if (depth > 20) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeArgumentKeys(item, depth + 1));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [rawKey, rawVal] of Object.entries(value as Record<string, unknown>)) {
      const trimmedKey = String(rawKey ?? "").trim();
      const key = trimmedKey || String(rawKey ?? "");
      out[key] = sanitizeArgumentKeys(rawVal, depth + 1);
    }
    return out;
  }
  return value;
}

function asToolCallArguments(value: unknown): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed && (trimmed.startsWith("{") || trimmed.startsWith("["))) {
      try {
        return JSON.stringify(sanitizeArgumentKeys(JSON.parse(trimmed)));
      } catch {
        return value;
      }
    }
    return value;
  }
  try {
    return JSON.stringify(sanitizeArgumentKeys(value ?? {}));
  } catch {
    return "{}";
  }
}

function extractNestedToolCall(
  value: unknown,
): { id?: string; name: string; arguments: string } | null {
  const queue: unknown[] = [value];
  const seen = new Set<string>();

  for (let i = 0; i < queue.length && i < 80; i += 1) {
    const current = queue[i];
    if (!current) {
      continue;
    }

    if (typeof current === "string") {
      const text = current.trim();
      if (!text || seen.has(text)) {
        continue;
      }
      seen.add(text);

      for (const candidate of jsonCandidates(text)) {
        if (seen.has(candidate)) {
          continue;
        }
        seen.add(candidate);
        let parsed: unknown;
        try {
          parsed = JSON.parse(candidate);
        } catch {
          continue;
        }
        queue.push(parsed);
      }
      continue;
    }

    if (typeof current !== "object") {
      continue;
    }

    const obj = current as Record<string, unknown>;
    const toolCalls = normalizeToolCallsShallow(
      Array.isArray(obj.tool_calls) ? obj.tool_calls : undefined,
    );
    if (toolCalls.length > 0) {
      const first = toolCalls[0];
      if (first) {
        return first;
      }
    }

    if (typeof obj.response === "string") {
      queue.push(obj.response);
    }
    if (
      obj.message &&
      typeof obj.message === "object" &&
      typeof (obj.message as Record<string, unknown>).content === "string"
    ) {
      queue.push((obj.message as Record<string, unknown>).content);
    }
    if (typeof obj.output_text === "string") {
      queue.push(obj.output_text);
    }
    if (typeof obj.text === "string") {
      queue.push(obj.text);
    }
    if (typeof obj.content === "string") {
      queue.push(obj.content);
    }

    for (const v of Object.values(obj)) {
      if (typeof v === "string") {
        queue.push(v);
      }
    }
  }

  return null;
}

function jsonCandidates(input: string): string[] {
  const out: string[] = [];
  const trimmed = input.trim();
  if (trimmed) {
    out.push(trimmed);
  }

  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(input)) !== null) {
    const candidate = match[1]?.trim();
    if (candidate) {
      out.push(candidate);
    }
  }

  const start = input.indexOf("{");
  const end = input.lastIndexOf("}");
  if (start !== -1 && end > start) {
    const body = input.slice(start, end + 1).trim();
    if (body) {
      out.push(body);
    }
  }

  return out;
}

function normalizeToolCallsShallow(
  rawToolCalls: unknown[] | undefined,
): Array<{ id?: string; name: string; arguments: string }> {
  if (!rawToolCalls || rawToolCalls.length === 0) {
    return [];
  }

  const out: Array<{ id?: string; name: string; arguments: string }> = [];
  for (const entry of rawToolCalls) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const obj = entry as Record<string, unknown>;
    const fn =
      obj.function && typeof obj.function === "object"
        ? (obj.function as Record<string, unknown>)
        : undefined;
    const name =
      (typeof obj.name === "string" && obj.name) ||
      (typeof obj.tool_name === "string" && obj.tool_name) ||
      (typeof obj.toolName === "string" && obj.toolName) ||
      (fn && typeof fn.name === "string" ? fn.name : "");
    if (!name) {
      continue;
    }
    const argsRaw =
      obj.arguments ??
      obj.args ??
      obj.parameters ??
      (fn ? fn.arguments : undefined) ??
      (fn ? fn.args : undefined) ??
      {};
    out.push({
      id:
        (typeof obj.id === "string" && obj.id) ||
        (typeof obj.call_id === "string" && obj.call_id) ||
        (typeof obj.tool_id === "string" && obj.tool_id) ||
        (typeof obj.toolId === "string" && obj.toolId) ||
        undefined,
      name,
      arguments: asToolCallArguments(argsRaw),
    });
  }

  return out;
}
