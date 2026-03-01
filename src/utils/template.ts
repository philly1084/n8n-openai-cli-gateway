import { shellEscape } from "./shell.js";

const TEMPLATE_REGEX = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/**
 * Variables that contain user input and should be shell-escaped
 * to prevent command injection when used in shell contexts.
 */
const USER_CONTROLLED_VARS = new Set(["prompt"]);

export interface TemplateOptions {
  /** Whether to shell-escape user-controlled variables (prompt, etc.) */
  escapeShell?: boolean;
}

export function applyTemplate(
  value: string,
  vars: Record<string, string>,
  options: TemplateOptions = {},
): string {
  const { escapeShell = true } = options;

  return value.replace(TEMPLATE_REGEX, (_full, key: string) => {
    const rawValue = vars[key] ?? "";
    // Shell-escape user-controlled variables when escapeShell is enabled
    if (escapeShell && USER_CONTROLLED_VARS.has(key)) {
      return shellEscape(rawValue);
    }
    return rawValue;
  });
}

export function applyTemplateRecord(
  source: Record<string, string> | undefined,
  vars: Record<string, string>,
  options: TemplateOptions = {},
): Record<string, string> | undefined {
  if (!source) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(source).map(([k, v]) => [k, applyTemplate(v, vars, options)]),
  );
}

/**
 * Checks if any user-controlled template variables contain shell metacharacters.
 * Returns an array of warnings for logging purposes.
 */
export function checkShellSafety(
  vars: Record<string, string>,
): Array<{ key: string; value: string; warning: string }> {
  const warnings: Array<{ key: string; value: string; warning: string }> = [];

  for (const key of USER_CONTROLLED_VARS) {
    const value = vars[key];
    if (value && /[`|;&<>*?\[\]{}~#!$()]/.test(value)) {
      warnings.push({
        key,
        value: value.slice(0, 100) + (value.length > 100 ? "..." : ""),
        warning: `Variable '${key}' contains shell metacharacters. ` +
          `Consider using 'request_json_stdin' input mode instead of 'prompt_stdin' for untrusted input, ` +
          `or ensure your command template uses shell escaping.`,
      });
    }
  }

  return warnings;
}
