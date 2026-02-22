import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import process from "node:process";

interface GatewayMessage {
  role?: unknown;
  content?: unknown;
}

interface GatewayRequest {
  prompt?: unknown;
  messages?: unknown;
  tools?: unknown;
  metadata?: unknown;
}

interface JsonRpcResponse {
  id?: unknown;
  result?: unknown;
  error?: {
    code?: unknown;
    message?: unknown;
    data?: unknown;
  };
}

interface JsonRpcRequest {
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

type FinishReason = "stop" | "tool_calls" | "length" | "error";

interface JsonContract {
  output_text: string;
  tool_calls?: Array<{
    id: string;
    name: string;
    arguments: string;
  }>;
  finish_reason: FinishReason;
}

class JsonRpcStdioClient {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private readonly queue: unknown[] = [];
  private readonly waiters: Array<(value: unknown | null) => void> = [];
  private readonly child: ReturnType<typeof spawn>;
  private buffer = "";
  private ended = false;

  constructor(child: ReturnType<typeof spawn>) {
    this.child = child;

    if (!child.stdout || !child.stdin) {
      throw new Error("codex app-server stdio streams are unavailable.");
    }

    child.stdout.on("data", (chunk: Buffer | string) => {
      const data = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      this.buffer += data;
      this.drainBuffer();
    });

    child.on("error", (error) => {
      const err = error instanceof Error ? error : new Error(String(error));
      this.rejectAll(err);
    });

    child.on("close", () => {
      this.ended = true;
      this.rejectAll(new Error("codex app-server process closed."));
    });
  }

  async request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++;
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`JSON-RPC request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    const payload =
      params === undefined
        ? { jsonrpc: "2.0", method }
        : { jsonrpc: "2.0", method, params };
    this.send(payload);
  }

  respond(id: unknown, result: unknown): void {
    this.send({ jsonrpc: "2.0", id, result });
  }

  async nextMessage(timeoutMs: number): Promise<unknown | null> {
    if (this.queue.length > 0) {
      return this.queue.shift() ?? null;
    }
    if (this.ended) {
      return null;
    }

    return await new Promise<unknown | null>((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(resolve);
        if (idx >= 0) {
          this.waiters.splice(idx, 1);
        }
        resolve(null);
      }, timeoutMs);
      this.waiters.push((value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  }

  private send(payload: unknown): void {
    if (!this.child.stdin) {
      throw new Error("codex app-server stdin is unavailable.");
    }

    // codex app-server stdio transport expects one JSON-RPC message per line.
    const line = `${JSON.stringify(payload)}\n`;
    this.child.stdin.write(line, "utf8");
  }

  private drainBuffer(): void {
    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }

      const rawLine = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      const line = rawLine.replace(/\r$/, "").trim();
      if (!line) {
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      const maybeResponse = parsed as JsonRpcResponse;
      if (
        typeof maybeResponse.id === "number" &&
        (Object.prototype.hasOwnProperty.call(maybeResponse, "result") ||
          Object.prototype.hasOwnProperty.call(maybeResponse, "error"))
      ) {
        const pending = this.pending.get(maybeResponse.id);
        if (!pending) {
          continue;
        }
        this.pending.delete(maybeResponse.id);
        clearTimeout(pending.timer);
        if (maybeResponse.error) {
          const message =
            typeof maybeResponse.error.message === "string"
              ? maybeResponse.error.message
              : "Unknown JSON-RPC error.";
          pending.reject(new Error(message));
        } else {
          pending.resolve(maybeResponse.result);
        }
        continue;
      }

      this.pushQueue(parsed);
    }
  }

  private pushQueue(value: unknown): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(value);
      return;
    }
    this.queue.push(value);
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.(null);
    }
  }
}

function normalizeValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value ?? "");
  } catch {
    return String(value ?? "");
  }
}

function parseRequest(input: string): GatewayRequest {
  return JSON.parse(input) as GatewayRequest;
}

function buildPrompt(request: GatewayRequest): string {
  if (typeof request.prompt === "string" && request.prompt.trim()) {
    return request.prompt;
  }

  const rawMessages = Array.isArray(request.messages) ? request.messages : [];
  const messages = rawMessages as GatewayMessage[];
  const messageText = messages
    .map((msg) => {
      const role =
        typeof msg.role === "string" && msg.role.trim() ? msg.role : "user";
      return `${role.toUpperCase()}:\n${normalizeValue(msg.content)}`;
    })
    .join("\n\n");

  const tools = Array.isArray(request.tools) ? request.tools : [];
  if (tools.length === 0) {
    return messageText;
  }

  const metadata =
    request.metadata && typeof request.metadata === "object"
      ? (request.metadata as Record<string, unknown>)
      : {};
  const toolChoice = metadata.tool_choice;
  const forcedToolName =
    toolChoice &&
    typeof toolChoice === "object" &&
    (toolChoice as Record<string, unknown>).type === "function" &&
    (toolChoice as Record<string, unknown>).function &&
    typeof (toolChoice as Record<string, unknown>).function === "object" &&
    typeof ((toolChoice as Record<string, unknown>).function as Record<string, unknown>)
      .name === "string"
      ? String(
          ((toolChoice as Record<string, unknown>).function as Record<string, unknown>)
            .name,
        )
      : undefined;

  const toolJson = JSON.stringify(tools, null, 2);
  const instruction = [
    "You are connected through an OpenAI-compatible gateway.",
    "The tools listed in AVAILABLE_TOOLS_JSON are the only tools you can use in this turn.",
    "Do not claim that tools are unavailable when AVAILABLE_TOOLS_JSON is non-empty.",
    "Do not use any internal tools, shell commands, filesystem access, web browsing, or MCP tools.",
    forcedToolName
      ? `tool_choice is set. You MUST call exactly this function name: ${forcedToolName}.`
      : "If the user asks to use/call a tool and AVAILABLE_TOOLS_JSON is non-empty, you MUST return a tool_calls response.",
    "If a tool is needed, return raw JSON only:",
    '{"output_text":"","tool_calls":[{"id":"call_1","name":"tool_name","arguments":{"arg":"value"}}],"finish_reason":"tool_calls"}',
    "If no tool is needed, return raw JSON only:",
    '{"output_text":"<assistant reply>","finish_reason":"stop"}',
  ].join("\n");

  return [messageText, "", "AVAILABLE_TOOLS_JSON:", toolJson, "", instruction].join(
    "\n",
  );
}

function asToolCallArguments(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

function parseToolCallFromRawItem(item: unknown):
  | {
      id: string;
      name: string;
      arguments: string;
    }
  | null {
  if (!item || typeof item !== "object") {
    return null;
  }
  const record = item as Record<string, unknown>;
  if (
    record.type !== "function_call" &&
    record.type !== "custom_tool_call"
  ) {
    return null;
  }

  const name =
    typeof record.name === "string" && record.name ? record.name : undefined;
  if (!name) {
    return null;
  }

  const id =
    typeof record.call_id === "string" && record.call_id
      ? record.call_id
      : `call_${randomUUID()}`;

  const argsRaw = record.type === "custom_tool_call" ? record.input : record.arguments;
  return {
    id,
    name,
    arguments: asToolCallArguments(argsRaw),
  };
}

function collectAssistantTextFromRawItem(item: unknown): string {
  if (!item || typeof item !== "object") {
    return "";
  }
  const record = item as Record<string, unknown>;
  if (record.type !== "message" || record.role !== "assistant") {
    return "";
  }
  const content = Array.isArray(record.content) ? record.content : [];
  const parts: string[] = [];
  for (const entry of content) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const part = entry as Record<string, unknown>;
    if (typeof part.text === "string" && part.text) {
      parts.push(part.text);
      continue;
    }
    if (typeof part.output_text === "string" && part.output_text) {
      parts.push(part.output_text);
    }
  }
  return parts.join("\n").trim();
}

function collectAssistantTextFromThreadItem(item: unknown): string {
  if (!item || typeof item !== "object") {
    return "";
  }
  const record = item as Record<string, unknown>;
  if (record.type !== "agentMessage") {
    return "";
  }
  return typeof record.text === "string" ? record.text.trim() : "";
}

function normalizeTextForComparison(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function appendUniqueTextPart(textParts: string[], candidate: string): void {
  const trimmed = candidate.trim();
  if (!trimmed) {
    return;
  }

  const previous = textParts[textParts.length - 1];
  if (
    typeof previous === "string" &&
    normalizeTextForComparison(previous) === normalizeTextForComparison(trimmed)
  ) {
    return;
  }

  textParts.push(trimmed);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isFinishReason(value: unknown): value is FinishReason {
  return (
    value === "stop" ||
    value === "tool_calls" ||
    value === "length" ||
    value === "error"
  );
}

function normalizeToolCallsFromContract(raw: unknown): NonNullable<JsonContract["tool_calls"]> {
  if (!Array.isArray(raw) || raw.length === 0) {
    return [];
  }

  const calls: NonNullable<JsonContract["tool_calls"]> = [];
  for (const entry of raw) {
    if (!isObjectRecord(entry)) {
      continue;
    }

    const fn = isObjectRecord(entry.function) ? entry.function : undefined;
    const name =
      (typeof entry.name === "string" && entry.name) ||
      (fn && typeof fn.name === "string" ? fn.name : "");
    if (!name) {
      continue;
    }

    const id =
      typeof entry.id === "string" && entry.id
        ? entry.id
        : `call_${calls.length + 1}`;
    const argsRaw = entry.arguments ?? (fn ? fn.arguments : undefined);

    calls.push({
      id,
      name,
      arguments: asToolCallArguments(argsRaw),
    });
  }

  return calls;
}

function parseJsonContractFromText(raw: string): JsonContract | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const seen = new Set<string>();
  const queue: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value !== "string") {
      return;
    }
    const text = value.trim();
    if (!text || seen.has(text)) {
      return;
    }
    seen.add(text);
    queue.push(text);
  };
  const pushDerived = (value: string): void => {
    const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
    let match: RegExpExecArray | null;
    while ((match = fence.exec(value)) !== null) {
      push(match[1]);
    }

    const start = value.indexOf("{");
    const end = value.lastIndexOf("}");
    if (start !== -1 && end > start) {
      push(value.slice(start, end + 1));
    }
  };
  const isContractObject = (value: Record<string, unknown>): boolean => {
    return (
      "output_text" in value ||
      "tool_calls" in value ||
      "finish_reason" in value ||
      "text" in value ||
      "content" in value
    );
  };
  const toContract = (value: Record<string, unknown>): JsonContract | null => {
    if (!isContractObject(value)) {
      return null;
    }

    const toolCalls = normalizeToolCallsFromContract(value.tool_calls);
    const outputText =
      typeof value.output_text === "string"
        ? value.output_text
        : typeof value.text === "string"
          ? value.text
          : typeof value.content === "string"
            ? value.content
            : "";
    const finishReason: FinishReason = isFinishReason(value.finish_reason)
      ? value.finish_reason
      : toolCalls.length > 0
        ? "tool_calls"
        : "stop";

    return {
      output_text: outputText.trim(),
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      finish_reason: finishReason,
    };
  };

  push(trimmed);
  pushDerived(trimmed);

  let best: JsonContract | null = null;
  for (let i = 0; i < queue.length && i < 80; i += 1) {
    const current = queue[i];
    if (typeof current !== "string") {
      continue;
    }
    pushDerived(current);

    let parsed: unknown = null;
    try {
      parsed = JSON.parse(current);
    } catch {
      continue;
    }
    if (!isObjectRecord(parsed)) {
      continue;
    }

    const contract = toContract(parsed);
    if (contract) {
      if (!best) {
        best = contract;
      }
      if (contract.output_text) {
        push(contract.output_text);
        pushDerived(contract.output_text);
      }
      if (contract.tool_calls && contract.tool_calls.length > 0) {
        return contract;
      }
    }

    if (typeof parsed.response === "string") {
      push(parsed.response);
      pushDerived(parsed.response);
    }
    const maybeMessage = parsed.message;
    if (isObjectRecord(maybeMessage) && typeof maybeMessage.content === "string") {
      push(maybeMessage.content);
      pushDerived(maybeMessage.content);
    }
  }

  return best;
}

function parseModelArg(argv: string[]): string {
  for (let i = 0; i < argv.length; i += 1) {
    const next = argv[i + 1];
    if (argv[i] === "--model" && typeof next === "string") {
      return next;
    }
  }
  const positional = argv.find((arg) => !arg.startsWith("-"));
  if (positional) {
    return positional;
  }
  if (
    typeof process.env.PROVIDER_MODEL === "string" &&
    process.env.PROVIDER_MODEL.trim()
  ) {
    return process.env.PROVIDER_MODEL.trim();
  }
  throw new Error("Missing model argument for codex-appserver-bridge.");
}

function parseTimeoutMs(): number {
  const raw =
    typeof process.env.CODEX_APPSERVER_TIMEOUT_MS === "string"
      ? Number(process.env.CODEX_APPSERVER_TIMEOUT_MS)
      : NaN;
  if (Number.isFinite(raw) && raw > 0) {
    return Math.trunc(raw);
  }
  return 240_000;
}

function parseInitializeTimeoutMs(totalTimeoutMs: number): number {
  const raw =
    typeof process.env.CODEX_APPSERVER_INITIALIZE_TIMEOUT_MS === "string"
      ? Number(process.env.CODEX_APPSERVER_INITIALIZE_TIMEOUT_MS)
      : NaN;
  if (Number.isFinite(raw) && raw > 0) {
    return Math.min(Math.trunc(raw), totalTimeoutMs);
  }
  return Math.min(60_000, totalTimeoutMs);
}

function parseStartupRequestTimeoutMs(totalTimeoutMs: number): number {
  const raw =
    typeof process.env.CODEX_APPSERVER_START_TIMEOUT_MS === "string"
      ? Number(process.env.CODEX_APPSERVER_START_TIMEOUT_MS)
      : NaN;
  if (Number.isFinite(raw) && raw > 0) {
    return Math.min(Math.trunc(raw), totalTimeoutMs);
  }
  return Math.min(45_000, totalTimeoutMs);
}

function parseModelProvider(): string {
  if (
    typeof process.env.CODEX_APPSERVER_MODEL_PROVIDER === "string" &&
    process.env.CODEX_APPSERVER_MODEL_PROVIDER.trim()
  ) {
    return process.env.CODEX_APPSERVER_MODEL_PROVIDER.trim();
  }
  return "openai";
}

function parseChatGptFallbackModel(): string {
  if (
    typeof process.env.CODEX_APPSERVER_CHATGPT_FALLBACK_MODEL === "string" &&
    process.env.CODEX_APPSERVER_CHATGPT_FALLBACK_MODEL.trim()
  ) {
    return process.env.CODEX_APPSERVER_CHATGPT_FALLBACK_MODEL.trim();
  }
  return "gpt-5.2-codex";
}

function isChatGptCodexLatestUnsupportedError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : String(error ?? "");
  const lower = message.toLowerCase();
  return (
    lower.includes("codex-latest") &&
    lower.includes("not supported") &&
    lower.includes("chatgpt account")
  );
}

function readStdin(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function run(): Promise<void> {
  const model = parseModelArg(process.argv.slice(2));
  const timeoutMs = parseTimeoutMs();
  const initializeTimeoutMs = parseInitializeTimeoutMs(timeoutMs);
  const startupRequestTimeoutMs = parseStartupRequestTimeoutMs(timeoutMs);
  const modelProvider = parseModelProvider();
  const chatGptFallbackModel = parseChatGptFallbackModel();
  const startedAt = Date.now();

  const requestJson = await readStdin();
  if (!requestJson.trim()) {
    const empty: JsonContract = { output_text: "", finish_reason: "stop" };
    process.stdout.write(JSON.stringify(empty));
    return;
  }

  const request = parseRequest(requestJson);
  const prompt = buildPrompt(request);

  const appServer = spawn("codex", ["app-server", "--listen", "stdio://"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });
  let childStderr = "";

  if (appServer.stderr) {
    appServer.stderr.setEncoding("utf8");
    appServer.stderr.on("data", (chunk: string) => {
      childStderr += chunk;
    });
  }

  const rpc = new JsonRpcStdioClient(appServer);

  try {
    let initialized = false;
    let initializeError: unknown = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        await rpc.request(
          "initialize",
          {
            clientInfo: { name: "n8n-openai-cli-gateway", version: "0.1.0" },
            capabilities: { experimentalApi: true },
          },
          initializeTimeoutMs,
        );
        initialized = true;
        break;
      } catch (error) {
        initializeError = error;
        if (attempt < 2) {
          await delay(750);
        }
      }
    }
    if (!initialized) {
      if (initializeError instanceof Error) {
        throw initializeError;
      }
      throw new Error("JSON-RPC request timed out: initialize");
    }
    rpc.notify("initialized");

    let selectedModel = model;
    let threadStartResult: Record<string, unknown>;
    try {
      threadStartResult = (await rpc.request(
        "thread/start",
        {
          model: selectedModel,
          modelProvider,
          approvalPolicy: "never",
          sandbox: "read-only",
          experimentalRawEvents: true,
          persistExtendedHistory: false,
        },
        startupRequestTimeoutMs,
      )) as Record<string, unknown>;
    } catch (error) {
      if (
        selectedModel === "codex-latest" &&
        chatGptFallbackModel !== selectedModel &&
        isChatGptCodexLatestUnsupportedError(error)
      ) {
        selectedModel = chatGptFallbackModel;
        process.stderr.write(
          `codex-appserver-bridge: model codex-latest rejected for ChatGPT account; retrying with ${selectedModel}\n`,
        );
        threadStartResult = (await rpc.request(
          "thread/start",
          {
            model: selectedModel,
            modelProvider,
            approvalPolicy: "never",
            sandbox: "read-only",
            experimentalRawEvents: true,
            persistExtendedHistory: false,
          },
          startupRequestTimeoutMs,
        )) as Record<string, unknown>;
      } else {
        throw error;
      }
    }

    const thread =
      threadStartResult &&
      typeof threadStartResult === "object" &&
      threadStartResult.thread &&
      typeof threadStartResult.thread === "object"
        ? (threadStartResult.thread as Record<string, unknown>)
        : null;
    const threadId = thread && typeof thread.id === "string" ? thread.id : null;
    if (!threadId) {
      throw new Error("codex app-server did not return thread id.");
    }

    const turnStartResult = (await rpc.request(
      "turn/start",
      {
        threadId,
        input: [{ type: "text", text: prompt }],
        model: selectedModel,
      },
      startupRequestTimeoutMs,
    )) as Record<string, unknown>;

    const turn =
      turnStartResult &&
      typeof turnStartResult === "object" &&
      turnStartResult.turn &&
      typeof turnStartResult.turn === "object"
        ? (turnStartResult.turn as Record<string, unknown>)
        : null;
    const turnId = turn && typeof turn.id === "string" ? turn.id : null;

    const toolCalls: NonNullable<JsonContract["tool_calls"]> = [];
    const toolCallIds = new Set<string>();
    const textParts: string[] = [];
    let turnCompleted = false;
    let turnFailedMessage = "";
    let toolCallSeenAt = 0;

    while (Date.now() - startedAt < timeoutMs) {
      const incoming = await rpc.nextMessage(1000);
      if (!incoming || typeof incoming !== "object") {
        if (turnCompleted) {
          break;
        }
        continue;
      }

      const message = incoming as JsonRpcRequest;
      const method = typeof message.method === "string" ? message.method : "";
      const params =
        message.params && typeof message.params === "object"
          ? (message.params as Record<string, unknown>)
          : undefined;

      if (method === "item/tool/call" && params) {
        const callId =
          typeof params.callId === "string" && params.callId
            ? params.callId
            : `call_${randomUUID()}`;
        const name =
          typeof params.tool === "string" && params.tool
            ? params.tool
            : "tool";
        const args = asToolCallArguments(params.arguments);
        if (!toolCallIds.has(callId)) {
          toolCallIds.add(callId);
          toolCalls.push({ id: callId, name, arguments: args });
          toolCallSeenAt = Date.now();
        }
        if (Object.prototype.hasOwnProperty.call(message, "id")) {
          rpc.respond(message.id, {
            success: false,
            contentItems: [
              {
                type: "inputText",
                text: "Tool execution is delegated to an external orchestrator.",
              },
            ],
          });
        }
        continue;
      }

      if (method === "rawResponseItem/completed" && params) {
        const incomingThreadId =
          typeof params.threadId === "string" ? params.threadId : "";
        if (incomingThreadId && incomingThreadId !== threadId) {
          continue;
        }

        const incomingTurnId =
          typeof params.turnId === "string" ? params.turnId : "";
        if (turnId && incomingTurnId && incomingTurnId !== turnId) {
          continue;
        }

        const call = parseToolCallFromRawItem(params.item);
        if (call && !toolCallIds.has(call.id)) {
          toolCallIds.add(call.id);
          toolCalls.push(call);
          toolCallSeenAt = Date.now();
          continue;
        }

        const text = collectAssistantTextFromRawItem(params.item);
        appendUniqueTextPart(textParts, text);
        continue;
      }

      if (method === "item/completed" && params) {
        const incomingThreadId =
          typeof params.threadId === "string" ? params.threadId : "";
        if (incomingThreadId && incomingThreadId !== threadId) {
          continue;
        }
        const incomingTurnId =
          typeof params.turnId === "string" ? params.turnId : "";
        if (turnId && incomingTurnId && incomingTurnId !== turnId) {
          continue;
        }
        const text = collectAssistantTextFromThreadItem(params.item);
        appendUniqueTextPart(textParts, text);
        continue;
      }

      if (method === "error" && params) {
        const incomingTurnId =
          typeof params.turnId === "string" ? params.turnId : "";
        if (turnId && incomingTurnId && incomingTurnId !== turnId) {
          continue;
        }
        const errorObj =
          params.error && typeof params.error === "object"
            ? (params.error as Record<string, unknown>)
            : null;
        const msg =
          errorObj && typeof errorObj.message === "string"
            ? errorObj.message
            : "";
        const willRetry = params.willRetry === true;
        if (!willRetry && msg) {
          turnFailedMessage = msg;
        }
        continue;
      }

      if (method === "turn/completed" && params) {
        const incomingThreadId =
          typeof params.threadId === "string" ? params.threadId : "";
        if (incomingThreadId && incomingThreadId !== threadId) {
          continue;
        }
        const turnObj =
          params.turn && typeof params.turn === "object"
            ? (params.turn as Record<string, unknown>)
            : null;
        if (turnObj && turnId && typeof turnObj.id === "string" && turnObj.id !== turnId) {
          continue;
        }
        const status = turnObj && typeof turnObj.status === "string" ? turnObj.status : "";
        if (status === "failed" && !turnFailedMessage) {
          const errorObj =
            turnObj &&
            turnObj.error &&
            typeof turnObj.error === "object"
              ? (turnObj.error as Record<string, unknown>)
              : null;
          if (errorObj && typeof errorObj.message === "string") {
            turnFailedMessage = errorObj.message;
          }
        }
        turnCompleted = true;
      }

      if (toolCallSeenAt && Date.now() - toolCallSeenAt > 1200) {
        break;
      }
      if (turnCompleted) {
        break;
      }
    }

    let outputText = textParts.join("\n").trim();
    let finishReason: FinishReason = "stop";

    const parsedContract = parseJsonContractFromText(outputText);
    if (parsedContract) {
      outputText = parsedContract.output_text || outputText;
      finishReason = parsedContract.finish_reason;

      const parsedToolCalls = Array.isArray(parsedContract.tool_calls)
        ? parsedContract.tool_calls
        : [];
      for (const call of parsedToolCalls) {
        if (!toolCallIds.has(call.id)) {
          toolCallIds.add(call.id);
          toolCalls.push(call);
        }
      }
    }

    if (toolCalls.length > 0) {
      const out: JsonContract = {
        output_text: outputText,
        tool_calls: toolCalls,
        finish_reason: "tool_calls",
      };
      process.stdout.write(JSON.stringify(out));
      return;
    }

    if (!outputText && turnFailedMessage) {
      throw new Error(turnFailedMessage);
    }

    if (finishReason === "tool_calls") {
      finishReason = "stop";
    }

    const out: JsonContract = {
      output_text: outputText,
      finish_reason: finishReason,
    };
    process.stdout.write(JSON.stringify(out));
  } finally {
    try {
      appServer.stdin?.end();
    } catch {
      // no-op
    }
    try {
      appServer.kill("SIGTERM");
    } catch {
      // no-op
    }
    setTimeout(() => {
      try {
        appServer.kill("SIGKILL");
      } catch {
        // no-op
      }
    }, 1500).unref();

    const trimmedErr = childStderr.trim();
    if (trimmedErr) {
      process.stderr.write(`${trimmedErr}\n`);
    }
  }
}

run().catch((error) => {
  const message =
    error instanceof Error ? error.message : `Unexpected error: ${String(error)}`;
  if (message) {
    process.stderr.write(`${message}\n`);
  }
  process.exit(1);
});
