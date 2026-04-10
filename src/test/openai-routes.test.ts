import test from "node:test";
import assert from "node:assert/strict";
import type { ChatMessage } from "../types";
import type { AppConfig, ProviderResult, ProviderStreamEvent, UnifiedRequest } from "../types";
import type { ProviderRegistry } from "../providers/registry";
import { buildServer } from "../server";
import {
  buildResponseInputItems,
  buildResponseOutputItems,
  getSessionSignature,
  normalizeChatMessages,
  normalizeResponsesInput,
} from "../routes/openai";

test("getSessionSignature prefers explicit session identifiers when available", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "You are a helper." },
    { role: "user", content: "Find the weather." },
  ];

  const sigA = getSessionSignature(messages, {
    session_id: "session-a",
    user: "demo-user",
  });
  const sigB = getSessionSignature(messages, {
    session_id: "session-b",
    user: "demo-user",
  });

  assert.notEqual(sigA, sigB);
});

test("getSessionSignature falls back to prompt content when no session id is present", () => {
  const baseMessages: ChatMessage[] = [
    { role: "system", content: "You are a helper." },
    { role: "user", content: "Find the weather." },
  ];
  const changedMessages: ChatMessage[] = [
    { role: "system", content: "You are a helper." },
    { role: "user", content: "Find the stock price." },
  ];

  assert.notEqual(getSessionSignature(baseMessages), getSessionSignature(changedMessages));
});

test("getSessionSignature stays stable across short approval turns when nested thread metadata is present", () => {
  const originalTurn: ChatMessage[] = [
    { role: "user", content: "Build the app remotely." },
  ];
  const approvalTurn: ChatMessage[] = [
    { role: "user", content: "you can use remote command" },
  ];

  const originalSig = getSessionSignature(originalTurn, {
    metadata: {
      thread_id: "thread-123",
    },
  });
  const approvalSig = getSessionSignature(approvalTurn, {
    metadata: {
      thread_id: "thread-123",
    },
  });

  assert.equal(originalSig, approvalSig);
});

test("normalizeResponsesInput infers assistant role for output_text messages without role", () => {
  const messages = normalizeResponsesInput({
    type: "message",
    content: [
      {
        type: "output_text",
        text: {
          value: "Tool work completed successfully.",
        },
      },
    ],
  });

  assert.deepStrictEqual(messages, [
    {
      role: "assistant",
      content: "Tool work completed successfully.",
    },
  ]);
});

test("normalizeChatMessages drops synthetic assistant failure history", () => {
  const messages = normalizeChatMessages([
    {
      role: "assistant",
      content:
        "I completed the request, but the final answer could not be synthesized from the model response.",
    },
    {
      role: "user",
      content: "hi",
    },
  ]);

  assert.deepStrictEqual(messages, [
    {
      role: "user",
      content: "hi",
    },
  ]);
});

test("normalizeResponsesInput drops synthetic assistant failure history", () => {
  const messages = normalizeResponsesInput([
    {
      role: "assistant",
      content:
        "I completed the request, but the final answer could not be synthesized from the model response.",
    },
    {
      role: "user",
      content: "what is the server ip?",
    },
  ]);

  assert.deepStrictEqual(messages, [
    {
      role: "user",
      content: "what is the server ip?",
    },
  ]);
});

test("buildResponseInputItems preserves user and tool item ordering", () => {
  const items = buildResponseInputItems([
    { role: "user", content: "Question one" },
    { role: "tool", content: "{\"ok\":true}", tool_call_id: "call_123" },
    { role: "assistant", content: "Existing answer" },
  ]);

  assert.equal(items.length, 3);
  assert.equal(items[0]?.type, "message");
  assert.equal(items[0]?.role, "user");
  assert.deepEqual(items[0]?.content, [{ type: "input_text", text: "Question one" }]);
  assert.equal(items[1]?.type, "function_call_output");
  assert.equal(items[1]?.call_id, "call_123");
  assert.equal(items[2]?.type, "message");
  assert.equal(items[2]?.role, "assistant");
});

test("buildResponseOutputItems emits assistant text before tool calls", () => {
  const items = buildResponseOutputItems({
    outputText: "Answer",
    toolCalls: [
      {
        id: "call_1",
        name: "lookup_weather",
        arguments: "{\"city\":\"Halifax\"}",
      },
    ],
    finishReason: "tool_calls",
  });

  assert.equal(items.length, 2);
  assert.equal(items[0]?.type, "message");
  assert.equal(items[0]?.role, "assistant");
  assert.deepEqual(items[0]?.content, [{ type: "output_text", text: "Answer" }]);
  assert.equal(items[1]?.type, "function_call");
  assert.equal(items[1]?.call_id, "call_1");
});

test("buildResponseOutputItems includes reasoning blocks when available", () => {
  const items = buildResponseOutputItems({
    outputText: "Answer",
    reasoningText: "Checked the prior tool outputs before answering.",
    toolCalls: [],
    finishReason: "stop",
  });

  assert.equal(items.length, 2);
  assert.equal(items[0]?.type, "message");
  assert.equal(items[1]?.type, "reasoning");
  assert.equal((items[1] as { text?: string }).text, "Checked the prior tool outputs before answering.");
});

test("responses route stores ordered input items and hydrates previous_response_id state", async () => {
  const capturedRequests: Array<Omit<UnifiedRequest, "model" | "providerModel">> = [];
  let callCount = 0;
  const server = createTestServer(async (_model, request) => {
    capturedRequests.push(request);
    callCount += 1;
    return {
      outputText: callCount === 1 ? "First answer" : "Second answer",
      toolCalls: [],
      finishReason: "stop",
    };
  });

  try {
    const first = await server.app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: {
        authorization: "Bearer test-key",
      },
      payload: {
        model: "demo-model",
        input: "First question",
      },
    });

    assert.equal(first.statusCode, 200);
    const firstBody = first.json() as Record<string, unknown>;
    assert.equal(Array.isArray(firstBody.input), true);
    assert.equal((firstBody.input as Array<Record<string, unknown>>)[0]?.type, "message");

    const firstId = typeof firstBody.id === "string" ? firstBody.id : "";
    assert.equal(Boolean(firstId), true);

    const inputItems = await server.app.inject({
      method: "GET",
      url: `/v1/responses/${firstId}/input_items?order=asc`,
      headers: {
        authorization: "Bearer test-key",
      },
    });

    assert.equal(inputItems.statusCode, 200);
    const inputItemsBody = inputItems.json() as Record<string, unknown>;
    const data = inputItemsBody.data as Array<Record<string, unknown>>;
    assert.equal(data.length, 1);
    assert.equal(data[0]?.role, "user");
    assert.deepEqual(data[0]?.content, [{ type: "input_text", text: "First question" }]);

    const second = await server.app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: {
        authorization: "Bearer test-key",
      },
      payload: {
        model: "demo-model",
        previous_response_id: firstId,
        input: "Second question",
      },
    });

    assert.equal(second.statusCode, 200);
    assert.equal(capturedRequests.length, 2);
    assert.deepEqual(
      capturedRequests[1]?.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      [
        { role: "user", content: "First question" },
        { role: "assistant", content: "First answer" },
        { role: "user", content: "Second question" },
      ],
    );
  } finally {
    await server.close();
  }
});

test("chat completions response includes reasoning when provider returns it", async () => {
  const server = createTestServer(async () => ({
    outputText: "Final answer",
    reasoningText: "Reasoned carefully first.",
    toolCalls: [],
    finishReason: "stop",
  }));

  try {
    const response = await server.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: "Bearer test-key",
      },
      payload: {
        model: "demo-model",
        messages: [{ role: "user", content: "Hi" }],
      },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json() as Record<string, unknown>;
    const choices = body.choices as Array<Record<string, unknown>>;
    const message = choices[0]?.message as Record<string, unknown>;
    assert.equal(message.reasoning, "Reasoned carefully first.");
  } finally {
    await server.close();
  }
});

test("chat completions stream emits incremental Codex chunks", async () => {
  const server = createTestServer(
    async () => ({
      outputText: "",
      toolCalls: [],
      finishReason: "stop",
    }),
    async function* () {
      yield { type: "reasoning_delta", delta: "Think 1. " } satisfies ProviderStreamEvent;
      yield { type: "output_text_delta", delta: "Hello" } satisfies ProviderStreamEvent;
      yield { type: "output_text_delta", delta: " world" } satisfies ProviderStreamEvent;
      yield { type: "done", finishReason: "stop" } satisfies ProviderStreamEvent;
    },
  );

  try {
    const response = await server.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: "Bearer test-key",
      },
      payload: {
        model: "demo-model",
        stream: true,
        messages: [{ role: "user", content: "Hi" }],
      },
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.payload, /: stream-open/);
    assert.match(response.payload, /"reasoning":"Think 1\. "/);
    assert.match(response.payload, /"content":"Hello"/);
    assert.match(response.payload, /"content":" world"/);
    assert.match(response.payload, /"finish_reason":"stop"/);
    assert.match(response.payload, /\[DONE\]/);
  } finally {
    await server.close();
  }
});

test("responses stream emits incremental chunks and stores reasoning in final output", async () => {
  const server = createTestServer(
    async () => ({
      outputText: "",
      toolCalls: [],
      finishReason: "stop",
    }),
    async function* () {
      yield { type: "reasoning_delta", delta: "Plan first. " } satisfies ProviderStreamEvent;
      yield { type: "output_text_delta", delta: "Done" } satisfies ProviderStreamEvent;
      yield { type: "done", finishReason: "stop" } satisfies ProviderStreamEvent;
    },
  );

  try {
    const response = await server.app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: {
        authorization: "Bearer test-key",
      },
      payload: {
        model: "demo-model",
        stream: true,
        input: "Hi",
      },
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.payload, /: stream-open/);
    assert.match(response.payload, /"reasoning_delta":"Plan first\. "/);
    assert.match(response.payload, /"output_text_delta":"Done"/);
    assert.match(response.payload, /"type":"reasoning"/);
    assert.match(response.payload, /\[DONE\]/);
  } finally {
    await server.close();
  }
});

test("chat completions stream can flush final snapshots from done events", async () => {
  const server = createTestServer(
    async () => ({
      outputText: "",
      toolCalls: [],
      finishReason: "stop",
    }),
    async function* () {
      yield {
        type: "done",
        finishReason: "stop",
        outputText: "Hello world",
        reasoningText: "Planned first.",
      } satisfies ProviderStreamEvent;
    },
  );

  try {
    const response = await server.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: "Bearer test-key",
      },
      payload: {
        model: "demo-model",
        stream: true,
        messages: [{ role: "user", content: "Hi" }],
      },
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.payload, /"reasoning":"Planned first\."/);
    assert.match(response.payload, /"content":"Hello world"/);
    assert.match(response.payload, /"finish_reason":"stop"/);
  } finally {
    await server.close();
  }
});

test("images route parses image data from provider raw payload", async () => {
  const server = createTestServer(async () => ({
    outputText: "",
    toolCalls: [],
    finishReason: "stop",
    raw: {
      data: [
        {
          url: "https://example.com/image.png",
        },
      ],
    },
  }));

  try {
    const response = await server.app.inject({
      method: "POST",
      url: "/v1/images/generations",
      headers: {
        authorization: "Bearer test-key",
      },
      payload: {
        model: "demo-model",
        prompt: "A lighthouse",
      },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json() as Record<string, unknown>;
    const data = body.data as Array<Record<string, unknown>>;
    assert.equal(data[0]?.url, "https://example.com/image.png");
  } finally {
    await server.close();
  }
});

function createTestServer(
  runModel: (
    modelId: string,
    request: Omit<UnifiedRequest, "model" | "providerModel">,
  ) => Promise<ProviderResult>,
  runModelStream?: (
    modelId: string,
    request: Omit<UnifiedRequest, "model" | "providerModel">,
  ) => AsyncIterable<ProviderStreamEvent>,
) {
  const registry = {
    listModels: () => [
      {
        id: "demo-model",
        providerId: "demo-provider",
        providerModel: "demo-model",
        fallbackModels: [],
      },
    ],
    listProviders: () => [],
    runModel,
    canStreamModel: () => Boolean(runModelStream),
    runModelStream: runModelStream ?? (async function* () {}) ,
  } as unknown as ProviderRegistry;

  const config: AppConfig = {
    host: "127.0.0.1",
    port: 0,
    n8nApiKeys: new Set(["test-key"]),
    adminApiKey: "admin-key",
    frontendApiKeys: new Set(),
    frontendAllowedCwds: [],
    providersPath: "config/providers.yaml",
    logLevel: "error",
    maxJobLogLines: 10,
    shutdownTimeoutMs: 1000,
    rateLimitMax: 100,
    rateLimitWindowMs: 60_000,
    maxRequestBodySize: 1024 * 1024,
  };

  return buildServer(config, registry);
}
