const TEMPLATE_REGEX = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export function applyTemplate(value: string, vars: Record<string, string>): string {
  return value.replace(TEMPLATE_REGEX, (_full, key: string) => vars[key] ?? "");
}

export function applyTemplateRecord(
  source: Record<string, string> | undefined,
  vars: Record<string, string>,
): Record<string, string> | undefined {
  if (!source) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(source).map(([k, v]) => [k, applyTemplate(v, vars)]),
  );
}
