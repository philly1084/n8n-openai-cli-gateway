/**
 * Escapes a string for safe use in shell commands.
 * Handles single quotes by using the '"'"' trick.
 */
export function shellEscape(str: string): string {
  if (!str) {
    return "''";
  }
  // Replace single quotes with '"'"' (close quote, insert literal quote, reopen quote)
  return `'${str.replace(/'/g, "'\"'\"'")}'`;
}

/**
 * Checks if a string contains potentially dangerous shell metacharacters.
 * This is a defense-in-depth check for logging/warning purposes.
 */
export function containsShellMetacharacters(str: string): boolean {
  // Pattern matches: backticks, $(), ${}, |, ;, &, <, >, *, ?, [, ], {, }, ~, #, !
  const dangerousPattern = /[`|;&<>*?\[\]{}~#!$()]/;
  return dangerousPattern.test(str);
}
