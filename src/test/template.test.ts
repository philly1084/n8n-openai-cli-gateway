import { describe, it } from "node:test";
import assert from "node:assert";
import { applyTemplate, applyTemplateRecord, checkShellSafety } from "../utils/template";

describe("applyTemplate", () => {
  it("should replace template variables", () => {
    const result = applyTemplate("Hello {{name}}!", { name: "World" });
    assert.strictEqual(result, "Hello World!");
  });

  it("should replace multiple variables", () => {
    const result = applyTemplate("{{greeting}} {{name}}!", { greeting: "Hello", name: "World" });
    assert.strictEqual(result, "Hello World!");
  });

  it("should handle unknown variables as empty string", () => {
    const result = applyTemplate("Hello {{name}}!", {});
    assert.strictEqual(result, "Hello !");
  });

  it("should handle spaces in template syntax", () => {
    const result = applyTemplate("Hello {{ name }}!", { name: "World" });
    assert.strictEqual(result, "Hello World!");
  });

  it("should handle empty template", () => {
    const result = applyTemplate("", { name: "World" });
    assert.strictEqual(result, "");
  });

  it("should handle template with no variables", () => {
    const result = applyTemplate("Hello World!", { name: "ignored" });
    assert.strictEqual(result, "Hello World!");
  });

  it("should shell-escape prompt variable by default", () => {
    const result = applyTemplate("{{prompt}}", { prompt: "hello; rm -rf /" });
    // Single quotes are escaped by ending the string, adding an escaped quote, then starting a new string
    assert.ok(result.startsWith("'"));
    assert.ok(result.includes(";"));
    assert.ok(result.includes("rm"));
  });

  it("should not shell-escape when escapeShell is false", () => {
    const result = applyTemplate("{{prompt}}", { prompt: "hello" }, { escapeShell: false });
    assert.strictEqual(result, "hello");
  });

  it("should not escape non-user-controlled variables", () => {
    const result = applyTemplate("{{model}}", { model: "gpt-4" });
    assert.strictEqual(result, "gpt-4");
  });
});

describe("applyTemplateRecord", () => {
  it("should apply template to all values", () => {
    const result = applyTemplateRecord(
      { key1: "{{var1}}", key2: "{{var2}}" },
      { var1: "a", var2: "b" }
    );
    assert.deepStrictEqual(result, { key1: "a", key2: "b" });
  });

  it("should return undefined for undefined input", () => {
    const result = applyTemplateRecord(undefined, { var: "value" });
    assert.strictEqual(result, undefined);
  });

  it("should handle empty record", () => {
    const result = applyTemplateRecord({}, { var: "value" });
    assert.deepStrictEqual(result, {});
  });

  it("should pass options through", () => {
    const result = applyTemplateRecord(
      { key: "{{prompt}}" },
      { prompt: "hello; cmd" },
      { escapeShell: false }
    );
    assert.deepStrictEqual(result, { key: "hello; cmd" });
  });
});

describe("checkShellSafety", () => {
  it("should return empty array for safe input", () => {
    const result = checkShellSafety({ prompt: "safe text" });
    assert.deepStrictEqual(result, []);
  });

  it("should warn for semicolon in prompt", () => {
    const result = checkShellSafety({ prompt: "hello; cmd" });
    assert.strictEqual(result.length, 1);
    const warning = result[0]!;
    assert.strictEqual(warning.key, "prompt");
    assert.ok(warning.warning.includes("shell metacharacters"));
  });

  it("should warn for backticks in prompt", () => {
    const result = checkShellSafety({ prompt: "hello `cmd`" });
    assert.strictEqual(result.length, 1);
  });

  it("should warn for $() in prompt", () => {
    const result = checkShellSafety({ prompt: "hello $(cmd)" });
    assert.strictEqual(result.length, 1);
  });

  it("should truncate long values in warning", () => {
    const longValue = "a".repeat(200);
    const result = checkShellSafety({ prompt: longValue + ";" });
    const warning = result[0]!;
    assert.ok(warning.value.length < 150);
    assert.ok(warning.value.endsWith("..."));
  });

  it("should only check user-controlled variables", () => {
    const result = checkShellSafety({ model: "gpt-4; rm -rf /" });
    // model is not in USER_CONTROLLED_VARS
    assert.deepStrictEqual(result, []);
  });
});
