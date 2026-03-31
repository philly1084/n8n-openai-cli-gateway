import test from "node:test";
import assert from "node:assert/strict";
import { extractTextContent, extractTextContentOrJson } from "../utils/prompt";

test("extractTextContentOrJson preserves structured tool payloads", () => {
  const payload = {
    status: "ok",
    cpu: 0.42,
    checks: ["db", "api"],
  };

  assert.equal(extractTextContent(payload), "");
  assert.equal(
    extractTextContentOrJson(payload),
    JSON.stringify(payload),
  );
});

test("extractTextContentOrJson still prefers textual content blocks", () => {
  const payload = [{ type: "input_text", input_text: "server healthy" }];
  assert.equal(extractTextContentOrJson(payload), "server healthy");
});

test("extractTextContent unwraps nested output_text blocks", () => {
  const payload = [
    {
      type: "message",
      content: [
        {
          type: "output_text",
          text: {
            value: "final synthesized answer",
          },
        },
      ],
    },
  ];

  assert.equal(extractTextContent(payload), "final synthesized answer");
});
