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
    const prompt = buildPromptWithTools(basePrompt, request.tools);
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

      return this.parseOutput(output.stdout);
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

    const idCandidate = typeof obj.id === "string" && obj.id ? obj.id : undefined;
    const nameCandidate =
      (typeof obj.name === "string" && obj.name) ||
      (functionObj && typeof functionObj.name === "string" ? functionObj.name : undefined);
    const argsRaw =
      obj.arguments ??
      (functionObj ? functionObj.arguments : undefined) ??
      "{}";

    if (!nameCandidate) {
      continue;
    }

    const args =
      typeof argsRaw === "string" ? argsRaw : JSON.stringify(argsRaw ?? {});

    calls.push({
      id: idCandidate ?? `call_${calls.length + 1}`,
      name: nameCandidate,
      arguments: args,
    });
  }

  return calls;
}
