import type { ProviderTokenUsage } from "../types";

export function normalizeProviderUsage(value: unknown, source?: string): ProviderTokenUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const usage: ProviderTokenUsage = {
    inputTokens: firstNumber(record.input_tokens, record.inputTokens, record.prompt_tokens, record.promptTokens),
    outputTokens: firstNumber(record.output_tokens, record.outputTokens, record.completion_tokens, record.completionTokens),
    totalTokens: firstNumber(record.total_tokens, record.totalTokens),
    promptTokens: firstNumber(record.prompt_tokens, record.promptTokens, record.input_tokens, record.inputTokens),
    completionTokens: firstNumber(
      record.completion_tokens,
      record.completionTokens,
      record.output_tokens,
      record.outputTokens,
    ),
    promptTokensDetails: asRecord(record.prompt_tokens_details ?? record.promptTokensDetails),
    completionTokensDetails: asRecord(record.completion_tokens_details ?? record.completionTokensDetails),
    inputTokensDetails: asRecord(record.input_tokens_details ?? record.inputTokensDetails),
    outputTokensDetails: asRecord(record.output_tokens_details ?? record.outputTokensDetails),
    estimated: typeof record.estimated === "boolean" ? record.estimated : undefined,
    source: typeof record.source === "string" ? record.source : source,
  };

  if (usage.totalTokens === undefined && usage.inputTokens !== undefined && usage.outputTokens !== undefined) {
    usage.totalTokens = usage.inputTokens + usage.outputTokens;
  }
  if (usage.promptTokens === undefined && usage.inputTokens !== undefined) {
    usage.promptTokens = usage.inputTokens;
  }
  if (usage.completionTokens === undefined && usage.outputTokens !== undefined) {
    usage.completionTokens = usage.outputTokens;
  }

  return hasAnyUsageCount(usage) ? usage : undefined;
}

export function mergeProviderUsage(
  items: Array<ProviderTokenUsage | undefined>,
): ProviderTokenUsage | undefined {
  const present = items.filter((item): item is ProviderTokenUsage => Boolean(item));
  if (present.length === 0) {
    return undefined;
  }

  const sum = (selector: (item: ProviderTokenUsage) => number | undefined): number | undefined => {
    let total = 0;
    let seen = false;
    for (const item of present) {
      const value = selector(item);
      if (typeof value === "number") {
        total += value;
        seen = true;
      }
    }
    return seen ? total : undefined;
  };

  const usage: ProviderTokenUsage = {
    inputTokens: sum((item) => item.inputTokens),
    outputTokens: sum((item) => item.outputTokens),
    totalTokens: sum((item) => item.totalTokens),
    promptTokens: sum((item) => item.promptTokens),
    completionTokens: sum((item) => item.completionTokens),
    estimated: present.some((item) => item.estimated),
    source: present.every((item) => item.source === present[0]?.source) ? present[0]?.source : "mixed",
  };

  if (usage.totalTokens === undefined && usage.inputTokens !== undefined && usage.outputTokens !== undefined) {
    usage.totalTokens = usage.inputTokens + usage.outputTokens;
  }

  return hasAnyUsageCount(usage) ? usage : undefined;
}

export function buildChatUsage(usage: ProviderTokenUsage | undefined): Record<string, unknown> {
  const promptTokens = usage?.promptTokens ?? usage?.inputTokens ?? 0;
  const completionTokens = usage?.completionTokens ?? usage?.outputTokens ?? 0;
  const totalTokens = usage?.totalTokens ?? promptTokens + completionTokens;
  return stripUndefined({
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    prompt_tokens_details: usage?.promptTokensDetails ?? usage?.inputTokensDetails,
    completion_tokens_details: usage?.completionTokensDetails ?? usage?.outputTokensDetails,
    estimated: usage?.estimated,
    source: usage?.source,
  });
}

export function buildResponsesUsage(usage: ProviderTokenUsage | undefined): Record<string, unknown> {
  const inputTokens = usage?.inputTokens ?? usage?.promptTokens ?? 0;
  const outputTokens = usage?.outputTokens ?? usage?.completionTokens ?? 0;
  const totalTokens = usage?.totalTokens ?? inputTokens + outputTokens;
  return stripUndefined({
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    input_tokens_details: usage?.inputTokensDetails ?? usage?.promptTokensDetails,
    output_tokens_details: usage?.outputTokensDetails ?? usage?.completionTokensDetails,
    estimated: usage?.estimated,
    source: usage?.source,
  });
}

export function estimateTokensFromText(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) {
    return 0;
  }
  const wordish = trimmed.split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(Math.max(wordish, trimmed.length / 4)));
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return Math.round(value);
    }
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function hasAnyUsageCount(usage: ProviderTokenUsage): boolean {
  return (
    usage.inputTokens !== undefined ||
    usage.outputTokens !== undefined ||
    usage.totalTokens !== undefined ||
    usage.promptTokens !== undefined ||
    usage.completionTokens !== undefined
  );
}

function stripUndefined(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}
