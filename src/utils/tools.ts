/**
 * Normalizes a tool name to a consistent format.
 * Converts to snake_case and removes special characters.
 */
export function normalizeToolName(name: string): string {
  return name
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s\-./]+/g, "_")
    .replace(/[^A-Za-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

/**
 * Normalizes a tool alias by removing common prefixes and suffixes.
 */
export function normalizeToolAlias(name: string): string {
  return normalizeToolName(name)
    .replace(/^(tool_|function_|fn_)+/, "")
    .replace(/(_tool|_function|_fn|_api|_call)+$/, "");
}

/**
 * Normalizes an argument key using the same rules as tool names.
 */
export function normalizeArgumentKey(name: string): string {
  return normalizeToolName(name);
}
