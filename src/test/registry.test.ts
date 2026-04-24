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
