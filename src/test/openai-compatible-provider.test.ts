import test from "node:test";
import assert from "node:assert/strict";
import { OpenAiCompatibleProvider } from "../providers/openai-compatible-provider";

type CapturedRequestBody = {
  session_id?: string;
  thread_id?: string;
  clientSurface?: string;
  taskType?: string;
  metadata?: Record<string, unknown>;
};

test("OpenAiCompatibleProvider forwards remote session metadata and approval flags", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.TEST_REMOTE_API_KEY;
  let capturedBody: CapturedRequestBody = {};
  let didCaptureBody = false;

  process.env.TEST_REMOTE_API_KEY = "test-key";
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body ?? "{}")) as CapturedRequestBody;
    didCaptureBody = true;
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: "ok",
            },
            finish_reason: "stop",
          },
        ],
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  }) as typeof fetch;

  try {
    const provider = await OpenAiCompatibleProvider.create({
      id: "remote-router",
      type: "openai",
      baseUrl: "https://example.invalid",
      apiKeyEnv: "TEST_REMOTE_API_KEY",
      models: [
        {
          id: "gpt-remote",
        },
      ],
    });

    const result = await provider.run({
      requestId: "req_1",
      model: "gpt-remote",
      providerModel: "gpt-remote",
      messages: [
        {
          role: "user",
          content: "you can use remote command",
        },
      ],
      tools: [],
      metadata: {
        session_id: "session-123",
        clientSurface: "chatgpt",
        taskType: "remote-build",
        metadata: {
          thread_id: "thread-456",
          remoteBuildAutonomyApproved: true,
        },
      },
    });

    assert.equal(result.outputText, "ok");
    if (!didCaptureBody) {
      throw new Error("Expected provider request body to be captured.");
    }
    assert.equal(capturedBody.session_id, "session-123");
    assert.equal(capturedBody.thread_id, "thread-456");
    assert.equal(capturedBody.clientSurface, "chatgpt");
    assert.equal(capturedBody.taskType, "remote-build");
    assert.deepStrictEqual(capturedBody.metadata, {
      session_id: "session-123",
      thread_id: "thread-456",
      clientSurface: "chatgpt",
      taskType: "remote-build",
      remoteBuildAutonomyApproved: true,
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.TEST_REMOTE_API_KEY;
    } else {
      process.env.TEST_REMOTE_API_KEY = originalApiKey;
    }
  }
});

test("OpenAiCompatibleProvider rejects deepseek-reasoner tool turns", async () => {
  const originalApiKey = process.env.TEST_REMOTE_API_KEY;
  process.env.TEST_REMOTE_API_KEY = "test-key";

  try {
    const provider = await OpenAiCompatibleProvider.create({
      id: "deepseek-api",
      type: "openai",
      baseUrl: "https://api.deepseek.com",
      apiKeyEnv: "TEST_REMOTE_API_KEY",
      models: [
        {
          id: "deepseek-reasoner",
          providerModel: "deepseek-reasoner",
        },
      ],
    });

    await assert.rejects(
      provider.run({
        requestId: "req_2",
        model: "deepseek-reasoner",
        providerModel: "deepseek-reasoner",
        messages: [
          {
            role: "user",
            content: "Use the tool if needed.",
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "check_status",
            },
          },
        ],
      }),
      /requires DeepSeek reasoning_content round-tripping during tool use/i,
    );
  } finally {
    if (originalApiKey === undefined) {
      delete process.env.TEST_REMOTE_API_KEY;
    } else {
      process.env.TEST_REMOTE_API_KEY = originalApiKey;
    }
  }
});
