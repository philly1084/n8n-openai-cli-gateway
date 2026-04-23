import test from "node:test";
import assert from "node:assert/strict";
import { buildImageGenerationPrompt } from "../scripts/codex-appserver-bridge";

test("buildImageGenerationPrompt explicitly invokes Codex image workflow", () => {
  const prompt = buildImageGenerationPrompt({
    messages: [{ role: "user", content: "Create a crisp pixel-art lighthouse at sunset." }],
    requestKind: "images_generations",
    metadata: {
      n: 2,
      size: "1024x1024",
      quality: "high",
      style: "vivid",
      background: "transparent",
    },
  });

  assert.match(prompt, /\$imagegen/);
  assert.match(prompt, /built-in image generation or editing workflow/i);
  assert.match(prompt, /Image count: 2/);
  assert.match(prompt, /Size: 1024x1024/);
  assert.match(prompt, /Quality: high/);
  assert.match(prompt, /Style: vivid/);
  assert.match(prompt, /Background: transparent/);
  assert.match(prompt, /Respond with raw JSON only/i);
});
