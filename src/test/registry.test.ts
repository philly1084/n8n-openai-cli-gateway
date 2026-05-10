import test from "node:test";
import assert from "node:assert/strict";
import type { CliProviderConfig } from "../types";
import { ProviderRegistry } from "../providers/registry";

function cliProvider(
  id: string,
  models: CliProviderConfig["models"],
  bridgeScript = "dist/scripts/gemini-cli-bridge.js",
): CliProviderConfig {
  return {
    id,
    type: "cli",
    models,
    responseCommand: {
      executable: "node",
      args: [bridgeScript],
      input: "request_json_stdin",
      output: "json_contract",
      timeoutMs: 1000,
    },
  };
}

test("image generation resolver prefers explicit OpenAI image model over Gemini image-like request", async () => {
  const registry = await ProviderRegistry.create([
    cliProvider("gemini-cli", [
      {
        id: "gemini-image",
        providerModel: "gemini-image",
      },
    ]),
    cliProvider(
      "codex-cli",
      [
        {
          id: "codex-latest",
          providerModel: "codex-latest",
        },
        {
          id: "gpt-image-2",
          providerModel: "codex-latest",
          capabilities: ["image_generation"],
        },
      ],
      "dist/scripts/codex-appserver-bridge.js",
    ),
  ]);

  assert.equal(registry.resolvePreferredImageGenerationModel("gemini-image"), "gpt-image-2");
  assert.equal(registry.resolvePreferredImageGenerationModel("gpt-image-2"), "gpt-image-2");
});

test("registry allows image generation raw payloads with blank output text", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.TEST_REGISTRY_IMAGE_API_KEY;
  process.env.TEST_REGISTRY_IMAGE_API_KEY = "test-key";

  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        created: 1,
        data: [
          {
            b64_json: "abc123",
          },
        ],
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      },
    )) as typeof fetch;

  try {
    const registry = await ProviderRegistry.create([
      {
        id: "openai-image-api",
        type: "openai",
        baseUrl: "https://api.openai.test/v1",
        apiKeyEnv: "TEST_REGISTRY_IMAGE_API_KEY",
        models: [
          {
            id: "gpt-image-test",
            providerModel: "gpt-image-test",
            capabilities: ["image_generation"],
          },
        ],
      },
    ]);

    const result = await registry.runModel("gpt-image-test", {
      requestId: "req_img_1",
      messages: [{ role: "user", content: "A small product hero image." }],
      tools: [],
      requestKind: "images_generations",
      metadata: {
        prompt: "A small product hero image.",
      },
    });

    assert.equal(result.outputText, "");
    assert.deepEqual(result.raw, {
      created: 1,
      data: [
        {
          b64_json: "abc123",
        },
      ],
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.TEST_REGISTRY_IMAGE_API_KEY;
    } else {
      process.env.TEST_REGISTRY_IMAGE_API_KEY = originalApiKey;
    }
  }
});

test("registry allows nested inline image raw payloads with blank output text", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.TEST_REGISTRY_IMAGE_API_KEY;
  const imageData = "b".repeat(120);
  process.env.TEST_REGISTRY_IMAGE_API_KEY = "test-key";

  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                {
                  inlineData: {
                    mimeType: "image/png",
                    data: imageData,
                  },
                },
              ],
            },
          },
        ],
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      },
    )) as typeof fetch;

  try {
    const registry = await ProviderRegistry.create([
      {
        id: "openai-image-api",
        type: "openai",
        baseUrl: "https://api.openai.test/v1",
        apiKeyEnv: "TEST_REGISTRY_IMAGE_API_KEY",
        models: [
          {
            id: "gpt-image-test",
            providerModel: "gpt-image-test",
            capabilities: ["image_generation"],
          },
        ],
      },
    ]);

    const result = await registry.runModel("gpt-image-test", {
      requestId: "req_img_inline",
      messages: [{ role: "user", content: "A small product hero image." }],
      tools: [],
      requestKind: "images_generations",
      metadata: {
        prompt: "A small product hero image.",
      },
    });

    assert.equal(result.outputText, "");
    assert.deepEqual(result.raw, {
      candidates: [
        {
          content: {
            parts: [
              {
                inlineData: {
                  mimeType: "image/png",
                  data: imageData,
                },
              },
            ],
          },
        },
      ],
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.TEST_REGISTRY_IMAGE_API_KEY;
    } else {
      process.env.TEST_REGISTRY_IMAGE_API_KEY = originalApiKey;
    }
  }
});

test("registry falls back when image generation raw payload has no image data", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.TEST_REGISTRY_IMAGE_API_KEY;
  const requestedProviderModels: string[] = [];
  process.env.TEST_REGISTRY_IMAGE_API_KEY = "test-key";

  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
    requestedProviderModels.push(body.model ?? "");
    const payload =
      body.model === "empty-image-model"
        ? { created: 1, data: [] }
        : { created: 1, data: [{ url: "https://example.com/generated.png" }] };

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }) as typeof fetch;

  try {
    const registry = await ProviderRegistry.create([
      {
        id: "openai-image-api",
        type: "openai",
        baseUrl: "https://api.openai.test/v1",
        apiKeyEnv: "TEST_REGISTRY_IMAGE_API_KEY",
        models: [
          {
            id: "empty-image",
            providerModel: "empty-image-model",
            fallbackModels: ["working-image"],
            capabilities: ["image_generation"],
          },
          {
            id: "working-image",
            providerModel: "working-image-model",
            capabilities: ["image_generation"],
          },
        ],
      },
    ]);

    const result = await registry.runModel("empty-image", {
      requestId: "req_img_2",
      messages: [{ role: "user", content: "A lighthouse." }],
      tools: [],
      requestKind: "images_generations",
      metadata: {
        prompt: "A lighthouse.",
      },
    });

    assert.deepEqual(requestedProviderModels, ["empty-image-model", "working-image-model"]);
    assert.deepEqual(result.raw, {
      created: 1,
      data: [
        {
          url: "https://example.com/generated.png",
        },
      ],
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.TEST_REGISTRY_IMAGE_API_KEY;
    } else {
      process.env.TEST_REGISTRY_IMAGE_API_KEY = originalApiKey;
    }
  }
});

test("registry rejects image-only models for chat requests", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.TEST_REGISTRY_IMAGE_API_KEY;
  process.env.TEST_REGISTRY_IMAGE_API_KEY = "test-key";
  let providerCalled = false;

  globalThis.fetch = (async () => {
    providerCalled = true;
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: "This should not be called.",
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
    const registry = await ProviderRegistry.create([
      {
        id: "openai-image-api",
        type: "openai",
        baseUrl: "https://api.openai.test/v1",
        apiKeyEnv: "TEST_REGISTRY_IMAGE_API_KEY",
        models: [
          {
            id: "gpt-image-test",
            providerModel: "gpt-image-test",
            capabilities: ["image_generation"],
          },
        ],
      },
    ]);

    await assert.rejects(
      registry.runModel("gpt-image-test", {
        requestId: "req_chat_image_only",
        messages: [{ role: "user", content: "Hello." }],
        tools: [],
        requestKind: "chat_completions",
      }),
      /does not support chat requests/i,
    );
    assert.equal(providerCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.TEST_REGISTRY_IMAGE_API_KEY;
    } else {
      process.env.TEST_REGISTRY_IMAGE_API_KEY = originalApiKey;
    }
  }
});

test("registry skips text-only fallbacks for image generation requests", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.TEST_REGISTRY_IMAGE_API_KEY;
  const requestedProviderModels: string[] = [];
  process.env.TEST_REGISTRY_IMAGE_API_KEY = "test-key";

  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
    requestedProviderModels.push(body.model ?? "");
    return new Response(JSON.stringify({ created: 1, data: [] }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }) as typeof fetch;

  try {
    const registry = await ProviderRegistry.create([
      {
        id: "openai-image-api",
        type: "openai",
        baseUrl: "https://api.openai.test/v1",
        apiKeyEnv: "TEST_REGISTRY_IMAGE_API_KEY",
        models: [
          {
            id: "empty-image",
            providerModel: "empty-image-model",
            fallbackModels: ["text-only", "working-image"],
            capabilities: ["image_generation"],
          },
          {
            id: "text-only",
            providerModel: "text-only-model",
          },
          {
            id: "working-image",
            providerModel: "working-image-model",
            capabilities: ["image_generation"],
          },
        ],
      },
    ]);

    await assert.rejects(
      registry.runModel("empty-image", {
        requestId: "req_img_skip_text_fallback",
        messages: [{ role: "user", content: "A lighthouse." }],
        tools: [],
        requestKind: "images_generations",
        metadata: {
          prompt: "A lighthouse.",
        },
      }),
      /Model execution failed after fallback chain/i,
    );
    assert.deepEqual(requestedProviderModels, ["empty-image-model", "working-image-model"]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.TEST_REGISTRY_IMAGE_API_KEY;
    } else {
      process.env.TEST_REGISTRY_IMAGE_API_KEY = originalApiKey;
    }
  }
});

test("registry does not treat Codex chat models as image fallbacks without capability", async () => {
  const registry = await ProviderRegistry.create([
    {
      id: "codex-cli",
      type: "cli",
      models: [
        {
          id: "gpt-5.5",
          providerModel: "gpt-5.5",
          fallbackModels: ["gpt-5.4"],
        },
        {
          id: "gpt-5.4",
          providerModel: "gpt-5.4",
        },
      ],
      responseCommand: {
        executable: process.execPath,
        args: ["-e", "process.exit(1)"],
        input: "request_json_stdin",
        output: "json_contract",
        timeoutMs: 1000,
      },
    },
  ]);

  assert.equal(registry.resolvePreferredImageGenerationModel("gpt-5.5"), "gpt-5.5");
  await assert.rejects(
    registry.runModel("gpt-5.5", {
      requestId: "req_img_no_codex_chat_fallback",
      messages: [{ role: "user", content: "A lighthouse." }],
      tools: [],
      requestKind: "images_generations",
      metadata: {
        prompt: "A lighthouse.",
      },
    }),
    /Model gpt-5\.5 does not support image_generation requests\./,
  );
});

test("registry exposes auto as a virtual gateway model", async () => {
  const registry = await ProviderRegistry.create([
    cliProvider("local-cli", [
      {
        id: "fast-model",
        providerModel: "fast-model",
      },
    ]),
  ]);

  const models = registry.listModels();
  assert.equal(models[0]?.id, "auto");
  assert.equal(models[0]?.providerId, "gateway");
});

test("registry auto routing prefers coding models for coding prompts", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.TEST_REGISTRY_AUTO_API_KEY;
  const requestedProviderModels: string[] = [];
  process.env.TEST_REGISTRY_AUTO_API_KEY = "test-key";

  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
    requestedProviderModels.push(body.model ?? "");
    return new Response(
      JSON.stringify({
        model: body.model,
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
    const registry = await ProviderRegistry.create([
      {
        id: "openai-compatible",
        type: "openai",
        baseUrl: "https://api.example.test/v1",
        apiKeyEnv: "TEST_REGISTRY_AUTO_API_KEY",
        models: [
          {
            id: "general-flash",
            providerModel: "general-flash",
          },
          {
            id: "kimi-for-coding",
            providerModel: "kimi-for-coding",
          },
        ],
      },
    ]);

    const result = await registry.runModel("auto", {
      requestId: "req_auto_code",
      messages: [{ role: "user", content: "Fix this TypeScript API endpoint and write tests." }],
      tools: [],
      requestKind: "chat_completions",
    });

    assert.deepEqual(requestedProviderModels, ["kimi-for-coding"]);
    assert.equal(result.resolvedModel, "kimi-for-coding");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.TEST_REGISTRY_AUTO_API_KEY;
    } else {
      process.env.TEST_REGISTRY_AUTO_API_KEY = originalApiKey;
    }
  }
});

test("registry auto routing prefers image-capable models for image requests", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.TEST_REGISTRY_AUTO_API_KEY;
  const requestedProviderModels: string[] = [];
  process.env.TEST_REGISTRY_AUTO_API_KEY = "test-key";

  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
    requestedProviderModels.push(body.model ?? "");
    return new Response(JSON.stringify({ created: 1, data: [{ b64_json: "abc123" }] }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }) as typeof fetch;

  try {
    const registry = await ProviderRegistry.create([
      {
        id: "openai-compatible",
        type: "openai",
        baseUrl: "https://api.example.test/v1",
        apiKeyEnv: "TEST_REGISTRY_AUTO_API_KEY",
        models: [
          {
            id: "general-chat",
            providerModel: "general-chat",
          },
          {
            id: "gpt-image-test",
            providerModel: "gpt-image-test",
            capabilities: ["image_generation"],
          },
        ],
      },
    ]);

    const result = await registry.runModel("auto", {
      requestId: "req_auto_image",
      messages: [{ role: "user", content: "A small product hero image." }],
      tools: [],
      requestKind: "images_generations",
      metadata: {
        prompt: "A small product hero image.",
      },
    });

    assert.deepEqual(requestedProviderModels, ["gpt-image-test"]);
    assert.equal(result.resolvedModel, "gpt-image-test");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.TEST_REGISTRY_AUTO_API_KEY;
    } else {
      process.env.TEST_REGISTRY_AUTO_API_KEY = originalApiKey;
    }
  }
});

test("registry startup benchmarks record small and medium token timing snapshots", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.TEST_REGISTRY_BENCHMARK_API_KEY;
  const requestedProviderModels: string[] = [];
  process.env.TEST_REGISTRY_BENCHMARK_API_KEY = "test-key";

  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
    requestedProviderModels.push(body.model ?? "");
    return new Response(
      JSON.stringify({
        model: body.model,
        choices: [
          {
            message: {
              content: "benchmark output with a few tokens",
            },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 7,
          completion_tokens: 6,
          total_tokens: 13,
        },
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
    const registry = await ProviderRegistry.create([
      {
        id: "openai-compatible",
        type: "openai",
        baseUrl: "https://api.example.test/v1",
        apiKeyEnv: "TEST_REGISTRY_BENCHMARK_API_KEY",
        models: [
          {
            id: "groq-balanced",
            providerModel: "groq-balanced",
          },
        ],
      },
    ]);

    const benchmarks = await registry.runStartupBenchmarks({
      timeoutMs: 1000,
      maxModels: 1,
      concurrency: 1,
    });
    const benchmark = benchmarks.find((item) => item.modelId === "groq-balanced");

    assert.deepEqual(requestedProviderModels, ["groq-balanced", "groq-balanced"]);
    assert.equal(benchmark?.status, "succeeded");
    assert.equal(benchmark?.small?.measuredUsage?.completionTokens, 6);
    assert.equal(benchmark?.medium?.promptKind, "medium");
    assert.ok((benchmark?.score ?? 0) > 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.TEST_REGISTRY_BENCHMARK_API_KEY;
    } else {
      process.env.TEST_REGISTRY_BENCHMARK_API_KEY = originalApiKey;
    }
  }
});

test("registry auto routing prefers Groq DeepSeek Kimi lane for medium tasks", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.TEST_REGISTRY_MEDIUM_API_KEY;
  const requestedProviderModels: string[] = [];
  process.env.TEST_REGISTRY_MEDIUM_API_KEY = "test-key";

  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
    requestedProviderModels.push(body.model ?? "");
    return new Response(
      JSON.stringify({
        model: body.model,
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
    const registry = await ProviderRegistry.create([
      {
        id: "openai-compatible",
        type: "openai",
        baseUrl: "https://api.example.test/v1",
        apiKeyEnv: "TEST_REGISTRY_MEDIUM_API_KEY",
        models: [
          {
            id: "general-balanced",
            providerModel: "general-balanced",
          },
          {
            id: "groq-balanced",
            providerModel: "groq-balanced",
          },
        ],
      },
    ]);

    const result = await registry.runModel("auto", {
      requestId: "req_auto_medium",
      messages: [{ role: "user", content: "Analyze this API gateway routing behavior and propose a practical fix." }],
      tools: [],
      requestKind: "chat_completions",
    });

    assert.deepEqual(requestedProviderModels, ["groq-balanced"]);
    assert.equal(result.resolvedModel, "groq-balanced");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.TEST_REGISTRY_MEDIUM_API_KEY;
    } else {
      process.env.TEST_REGISTRY_MEDIUM_API_KEY = originalApiKey;
    }
  }
});

test("registry explains auto routing prompt profile and ranked candidates", async () => {
  const registry = await ProviderRegistry.create([
    cliProvider("local-cli", [
      {
        id: "general-flash",
        providerModel: "general-flash",
      },
      {
        id: "kimi-coder",
        providerModel: "kimi-coder",
      },
    ]),
  ]);

  const decision = registry.explainAutoRouting({
    messages: [{ role: "user", content: "Refactor this TypeScript endpoint and add tests." }],
    tools: [],
    requestKind: "chat_completions",
  });

  assert.equal(decision.selectedModelId, "kimi-coder");
  assert.equal(decision.promptProfile.codingSignal, true);
  assert.ok(decision.promptProfile.signals.includes("coding"));
  assert.deepEqual(
    decision.candidates.map((candidate) => candidate.modelId),
    ["kimi-coder", "general-flash"],
  );
  assert.equal(decision.candidates[0]?.benchmarkStatus, "pending");
});
