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
