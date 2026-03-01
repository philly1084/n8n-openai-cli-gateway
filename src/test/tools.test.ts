import { describe, it } from "node:test";
import assert from "node:assert";
import { normalizeToolName, normalizeToolAlias, normalizeArgumentKey } from "../utils/tools";

describe("normalizeToolName", () => {
  it("should convert camelCase to snake_case", () => {
    assert.strictEqual(normalizeToolName("myToolName"), "my_tool_name");
  });

  it("should convert PascalCase to snake_case", () => {
    assert.strictEqual(normalizeToolName("MyToolName"), "my_tool_name");
  });

  it("should convert spaces to underscores", () => {
    assert.strictEqual(normalizeToolName("my tool name"), "my_tool_name");
  });

  it("should convert hyphens to underscores", () => {
    assert.strictEqual(normalizeToolName("my-tool-name"), "my_tool_name");
  });

  it("should convert dots to underscores", () => {
    assert.strictEqual(normalizeToolName("my.tool.name"), "my_tool_name");
  });

  it("should remove special characters", () => {
    assert.strictEqual(normalizeToolName("my@tool#name"), "my_tool_name");
  });

  it("should trim leading/trailing underscores", () => {
    assert.strictEqual(normalizeToolName("_my_tool_name_"), "my_tool_name");
  });

  it("should collapse multiple underscores", () => {
    assert.strictEqual(normalizeToolName("my__tool___name"), "my_tool_name");
  });

  it("should convert to lowercase", () => {
    assert.strictEqual(normalizeToolName("MY_TOOL_NAME"), "my_tool_name");
  });

  it("should handle empty string", () => {
    assert.strictEqual(normalizeToolName(""), "");
  });

  it("should handle single word", () => {
    assert.strictEqual(normalizeToolName("tool"), "tool");
  });
});

describe("normalizeToolAlias", () => {
  it("should remove tool_ prefix", () => {
    assert.strictEqual(normalizeToolAlias("tool_search_docs"), "search_docs");
  });

  it("should remove function_ prefix", () => {
    assert.strictEqual(normalizeToolAlias("function_search_docs"), "search_docs");
  });

  it("should remove fn_ prefix", () => {
    assert.strictEqual(normalizeToolAlias("fn_search_docs"), "search_docs");
  });

  it("should remove _tool suffix", () => {
    assert.strictEqual(normalizeToolAlias("search_docs_tool"), "search_docs");
  });

  it("should remove _function suffix", () => {
    assert.strictEqual(normalizeToolAlias("search_docs_function"), "search_docs");
  });

  it("should remove _api suffix", () => {
    assert.strictEqual(normalizeToolAlias("search_docs_api"), "search_docs");
  });

  it("should remove multiple prefixes and suffixes", () => {
    assert.strictEqual(normalizeToolAlias("tool_fn_search_docs_tool_api"), "search_docs");
  });

  it("should still normalize the base name", () => {
    assert.strictEqual(normalizeToolAlias("tool_searchDocs"), "search_docs");
  });
});

describe("normalizeArgumentKey", () => {
  it("should use same logic as normalizeToolName", () => {
    // normalizeArgumentKey is an alias for normalizeToolName
    assert.strictEqual(normalizeArgumentKey("myArg"), "my_arg");
    assert.strictEqual(normalizeArgumentKey("my-arg"), "my_arg");
    assert.strictEqual(normalizeArgumentKey("my arg"), "my_arg");
  });
});
