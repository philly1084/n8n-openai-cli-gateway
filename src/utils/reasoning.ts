import type { ReasoningEffort } from "../types";

const REASONING_EFFORT_SET = new Set<ReasoningEffort>([
  "low",
  "medium",
  "high",
  "xhigh",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export function parseReasoningEffort(value: unknown): ReasoningEffort | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized || !REASONING_EFFORT_SET.has(normalized as ReasoningEffort)) {
    return undefined;
  }

  return normalized as ReasoningEffort;
}

export function resolveReasoningEffort(
  value: unknown,
  fallback?: ReasoningEffort,
): ReasoningEffort | undefined {
  const record = asRecord(value);
  if (!record) {
    return fallback;
  }

  const nestedReasoning = asRecord(record.reasoning);

  return (
    parseReasoningEffort(record.reasoning_effort) ??
    parseReasoningEffort(record.reasoningEffort) ??
    parseReasoningEffort(nestedReasoning?.effort) ??
    fallback
  );
}
