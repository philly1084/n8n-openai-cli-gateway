import test from "node:test";
import assert from "node:assert/strict";
import type { ChatMessage } from "../types";
import { getSessionSignature, normalizeResponsesInput } from "../routes/openai";

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
