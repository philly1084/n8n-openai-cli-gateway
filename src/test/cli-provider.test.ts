import test from "node:test";
import assert from "node:assert/strict";
import { CliProvider } from "../providers/cli-provider";
import type { CliProviderConfig, UnifiedRequest } from "../types";

function createRequest(): UnifiedRequest {
  return {
    requestId: "req_1",
    model: "demo-model",
    providerModel: "demo-model",
    messages: [
      {
        role: "user",
        content: "Check the provider output.",
      },
    ],
    tools: [],
  };
}

function createProvider(script: string): CliProvider {
  const config: CliProviderConfig = {
    id: "demo-cli",
    type: "cli",
    models: [
      {
        id: "demo-model",
        providerModel: "demo-model",
      },
    ],
    responseCommand: {
      executable: process.execPath,
      args: ["-e", script],
      input: "request_json_stdin",
      output: "json_contract",
      timeoutMs: 1000,
    },
  };

  return new CliProvider(config);
}

test("CliProvider preserves top-level summary_text as reasoningText", async () => {
  const provider = createProvider(
    "process.stdout.write(JSON.stringify({ output_text: 'ok', summary_text: 'Checked the prior tool output.', finish_reason: 'stop' }))",
  );

  const result = await provider.run(createRequest());

  assert.equal(result.outputText, "ok");
  assert.equal(result.reasoningText, "Checked the prior tool output.");
});

test("CliProvider preserves top-level reasoning_content arrays as reasoningText", async () => {
  const provider = createProvider(
    "process.stdout.write(JSON.stringify({ output_text: 'ok', reasoning_content: [{ type: 'summary_text', text: 'Planned the next step first.' }], finish_reason: 'stop' }))",
  );

  const result = await provider.run(createRequest());

  assert.equal(result.outputText, "ok");
  assert.equal(result.reasoningText, "Planned the next step first.");
});
