import { describe, it } from "node:test";
import assert from "node:assert";
import {
  chatCompletionsRequestSchema,
  responsesRequestSchema,
} from "../validation";

describe("request schema compatibility", () => {
  it("preserves alternate tool definition fields for downstream normalization", () => {
    const parsed = chatCompletionsRequestSchema.parse({
      model: "gpt-test",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          tool: {
            name: "search_docs",
            description: "Search docs",
            input_schema: {
              type: "object",
              properties: {
                query: { type: "string" },
              },
            },
          },
        },
        {
          type: "function",
          function: {
            name: "fetch_url",
            input_schema: {
              type: "object",
              properties: {
                url: { type: "string" },
              },
            },
          },
        },
      ],
      tool_choice: {
        type: "function",
        function: { name: "search_docs" },
      },
    }) as Record<string, unknown>;

    const tools = parsed.tools as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(tools));
    assert.ok(tools[0]?.tool);
    assert.ok((tools[1]?.function as Record<string, unknown>)?.input_schema);
    assert.ok(parsed.tool_choice);
  });

  it("accepts a single responses input object", () => {
    const parsed = responsesRequestSchema.parse({
      model: "gpt-test",
      input: {
        type: "function_call_output",
        call_id: "call_123",
        output: "done",
      },
    });

    assert.deepStrictEqual(parsed.input, {
      type: "function_call_output",
      call_id: "call_123",
      output: "done",
    });
  });

  it("accepts assistant tool-call messages without content", () => {
    const parsed = chatCompletionsRequestSchema.parse({
      model: "gpt-test",
      messages: [
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_123",
              type: "function",
              function: {
                name: "search_docs",
                arguments: "{\"query\":\"oauth\"}",
              },
            },
          ],
        },
      ],
    });

    assert.strictEqual(parsed.messages[0]?.role, "assistant");
  });

  it("accepts reasoning effort aliases on chat completions requests", () => {
    const parsed = chatCompletionsRequestSchema.parse({
      model: "gpt-test",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "high",
      reasoningEffort: "medium",
    });

    assert.strictEqual(parsed.reasoning_effort, "high");
    assert.strictEqual(parsed.reasoningEffort, "medium");
  });

  it("accepts nested reasoning config on responses requests", () => {
    const parsed = responsesRequestSchema.parse({
      model: "gpt-test",
      input: "hi",
      reasoning: {
        effort: "xhigh",
      },
    });

    assert.deepStrictEqual(parsed.reasoning, { effort: "xhigh" });
  });
});
