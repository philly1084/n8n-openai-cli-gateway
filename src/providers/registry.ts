import type {
  ModelCapability,
  ProviderConfig,
  ProviderResult,
  ProviderStreamEvent,
  UnifiedRequest,
} from "../types";
import type {
  ModelStatsModelSnapshot,
  ModelStatsSnapshot,
} from "../stats/model-stats";
import { ModelStatsTracker } from "../stats/model-stats";
import { CliProvider } from "./cli-provider";
import { OpenAiCompatibleProvider } from "./openai-compatible-provider";
import type { Provider } from "./provider";
import { trackProvider, trackFallback } from "../metrics";
import { isSyntheticAssistantOutputText, normalizeAssistantResult } from "../utils/assistant-output";
import { extractTextContent } from "../utils/prompt";

const AUTO_MODEL_ID = "auto";
const AUTO_PROVIDER_ID = "gateway";

interface ModelBinding {
  modelId: string;
  providerModel: string;
  provider: Provider;
  description?: string;
  fallbackModelIds: string[];
  capabilities: ModelCapability[];
}

export class ProviderRegistry {
  private readonly providers = new Map<string, Provider>();
  private readonly models = new Map<string, ModelBinding>();
  private readonly modelStats = new ModelStatsTracker();

  private constructor() {}

  static async create(configs: ProviderConfig[]): Promise<ProviderRegistry> {
    const registry = new ProviderRegistry();
    for (const config of configs) {
      const provider =
        config.type === "cli"
          ? new CliProvider(config)
          : await OpenAiCompatibleProvider.create(config);
      if (registry.providers.has(provider.id)) {
        throw new Error(`Duplicate provider id: ${provider.id}`);
      }
      registry.providers.set(provider.id, provider);

      for (const model of provider.models) {
        if (model.id === AUTO_MODEL_ID) {
          throw new Error(`Model id ${AUTO_MODEL_ID} is reserved for gateway auto routing.`);
        }
        if (registry.models.has(model.id)) {
          throw new Error(`Duplicate model id: ${model.id}`);
        }
        registry.models.set(model.id, {
          modelId: model.id,
          providerModel: model.providerModel || model.id,
          provider,
          description: model.description,
          fallbackModelIds: model.fallbackModels || [],
          capabilities: normalizeModelCapabilities(model.capabilities),
        });
        registry.modelStats.registerModel({
          modelId: model.id,
          providerId: provider.id,
          providerModel: model.providerModel || model.id,
          description: model.description,
          fallbackModels: model.fallbackModels || [],
        });
      }
    }

    if (registry.providers.size === 0) {
      throw new Error("No providers configured.");
    }

    return registry;
  }

  listModels(): Array<{
    id: string;
    description?: string;
    providerId: string;
    providerModel: string;
    fallbackModels: string[];
    capabilities: ModelCapability[];
  }> {
    return [
      {
        id: AUTO_MODEL_ID,
        description: "Gateway-native auto router across all configured compatible models.",
        providerId: AUTO_PROVIDER_ID,
        providerModel: "gateway/auto",
        fallbackModels: [],
        capabilities: [
          "chat",
          "responses",
          "tools",
          "streaming",
          "reasoning",
          "structured_outputs",
          "image_generation",
        ],
      },
      ...[...this.models.values()].map((binding) => ({
        id: binding.modelId,
        description: binding.description,
        providerId: binding.provider.id,
        providerModel: binding.providerModel,
        fallbackModels: binding.fallbackModelIds,
        capabilities: binding.capabilities,
      })),
    ];
  }

  listProviders(): Provider[] {
    return [...this.providers.values()];
  }

  resolvePreferredImageGenerationModel(requestedModelId?: string): string | undefined {
    const requestedBinding = requestedModelId ? this.models.get(requestedModelId) : undefined;
    if (requestedBinding && bindingSupportsImageGeneration(requestedBinding)) {
      return requestedBinding.modelId;
    }

    for (const binding of this.models.values()) {
      if (bindingSupportsImageGeneration(binding)) {
        return binding.modelId;
      }
    }

    if (requestedBinding?.provider.prefersImageGeneration?.()) {
      return requestedBinding.modelId;
    }

    for (const binding of this.models.values()) {
      if (binding.provider.prefersImageGeneration?.()) {
        return binding.modelId;
      }
    }

    return requestedBinding?.modelId;
  }

  getProvider(providerId: string): Provider | undefined {
    return this.providers.get(providerId);
  }

  getModelStats(): ModelStatsSnapshot {
    return this.modelStats.snapshot();
  }

  getModelStatsById(modelId: string): ModelStatsModelSnapshot | undefined {
    return this.modelStats.snapshotModel(modelId);
  }

  async runModel(
    modelId: string,
    request: Omit<UnifiedRequest, "model" | "providerModel">,
  ): Promise<ProviderResult> {
    const autoSelection = modelId === AUTO_MODEL_ID
      ? this.selectAutoModel(request)
      : undefined;

    if (!autoSelection && !this.models.has(modelId)) {
      throw new Error(`Unknown model: ${modelId}`);
    }

    const attempted: string[] = [];
    const visited = new Set<string>();
    let currentModelId: string | undefined = autoSelection?.modelId ?? modelId;
    const autoFallbackModelIds = autoSelection?.fallbackModelIds ?? [];
    let lastError: unknown;

    while (currentModelId) {
      if (visited.has(currentModelId)) {
        break;
      }
      visited.add(currentModelId);
      attempted.push(currentModelId);
      const attemptIndex = attempted.length - 1;

      const binding = this.models.get(currentModelId);
      if (!binding) {
        lastError = new Error(`Fallback model not found: ${currentModelId}`);
        this.modelStats.recordAttempt({
          modelId: currentModelId,
          requestedModelId: modelId,
          providerId: "unknown",
          providerModel: currentModelId,
          attemptIndex,
        });
        this.modelStats.recordFailure({
          modelId: currentModelId,
          requestedModelId: modelId,
          providerId: "unknown",
          providerModel: currentModelId,
          attemptIndex,
          durationMs: 0,
          error: lastError,
        });
        break;
      }

      const startedAt = Date.now();
      this.modelStats.recordAttempt({
        modelId: binding.modelId,
        requestedModelId: modelId,
        providerId: binding.provider.id,
        providerModel: binding.providerModel,
        attemptIndex,
      });

      try {
        const requiredCapability = requiredCapabilityForRequest(request);
        if (requiredCapability && !bindingSupportsCapability(binding, requiredCapability)) {
          throw new Error(
            `Model ${binding.modelId} does not support ${requiredCapability} requests.`,
          );
        }

        const rawResult = await binding.provider.run({
          ...request,
          model: binding.modelId,
          providerModel: binding.providerModel,
        });
        const result = normalizeAssistantResult(rawResult);
        if (isInvalidProviderResult(result, request)) {
          throw new Error(buildInvalidProviderResultError(binding.provider.id, binding.modelId, result));
        }
        this.modelStats.recordSuccess({
          modelId: binding.modelId,
          requestedModelId: modelId,
          providerId: binding.provider.id,
          providerModel: binding.providerModel,
          attemptIndex,
          durationMs: Date.now() - startedAt,
        });
        trackProvider(binding.provider.id, binding.modelId, true, Date.now() - startedAt);
        return {
          ...result,
          resolvedModel: result.resolvedModel ?? binding.modelId,
        };
      } catch (error) {
        lastError = error;
        const failureKind = this.modelStats.recordFailure({
          modelId: binding.modelId,
          requestedModelId: modelId,
          providerId: binding.provider.id,
          providerModel: binding.providerModel,
          attemptIndex,
          durationMs: Date.now() - startedAt,
          error,
        });
        trackProvider(binding.provider.id, binding.modelId, false, Date.now() - startedAt);
        const nextModelId =
          binding.fallbackModelIds.find(
            (fallback) =>
              !visited.has(fallback) &&
              this.modelSupportsRequest(fallback, request),
          ) ??
          autoFallbackModelIds.find(
            (fallback) =>
              !visited.has(fallback) &&
              this.modelSupportsRequest(fallback, request),
          );
        if (!nextModelId) {
          break;
        }
        this.modelStats.recordFallback({
          requestedModelId: modelId,
          fromModelId: binding.modelId,
          toModelId: nextModelId,
          reason: failureKind,
        });
        trackFallback(binding.provider.id, nextModelId, failureKind);
        currentModelId = nextModelId;
      }
    }

    if (attempted.length <= 1) {
      throw lastError instanceof Error
        ? lastError
        : new Error("Model execution failed with an unknown provider error.");
    }

    const lastErrorMessage =
      lastError instanceof Error ? lastError.message : "Unknown provider error.";
    throw new Error(
      `Model execution failed after fallback chain: ${attempted.join(" -> ")}.\nLast error: ${lastErrorMessage}`,
    );
  }

  canStreamModel(modelId: string): boolean {
    const binding = this.models.get(modelId);
    return Boolean(binding?.provider.runStream && (binding.provider.supportsStreaming?.() ?? true));
  }

  private modelSupportsImageGeneration(modelId: string): boolean {
    const binding = this.models.get(modelId);
    return Boolean(
      binding &&
      (bindingSupportsImageGeneration(binding) || binding.provider.prefersImageGeneration?.()),
    );
  }

  private modelSupportsRequest(
    modelId: string,
    request: Omit<UnifiedRequest, "model" | "providerModel">,
  ): boolean {
    if (isImageGenerationRequest(request)) {
      return this.modelSupportsImageGeneration(modelId);
    }

    const requiredCapability = requiredCapabilityForRequest(request);
    if (!requiredCapability) {
      return true;
    }

    const binding = this.models.get(modelId);
    return Boolean(binding && bindingSupportsCapability(binding, requiredCapability));
  }

  private selectAutoModel(
    request: Omit<UnifiedRequest, "model" | "providerModel">,
  ): { modelId: string; fallbackModelIds: string[] } {
    const candidates = this.rankAutoCandidates(request);
    const selected = candidates[0];
    if (!selected) {
      throw new Error("Auto routing could not find a compatible model.");
    }

    return {
      modelId: selected.binding.modelId,
      fallbackModelIds: candidates.slice(1).map((candidate) => candidate.binding.modelId),
    };
  }

  private rankAutoCandidates(
    request: Omit<UnifiedRequest, "model" | "providerModel">,
  ): Array<{ binding: ModelBinding; score: number; index: number }> {
    const promptText = requestTextForScoring(request);
    const complexity = scorePromptComplexity(promptText);
    const codingSignal = hasCodingSignal(promptText, request.metadata);
    const hasTools = request.tools.length > 0;
    const wantsStrongReasoning =
      request.reasoningEffort === "high" || request.reasoningEffort === "xhigh";
    const requiredCapability = requiredCapabilityForRequest(request);

    return [...this.models.values()]
      .map((binding, index) => {
        if (!this.modelSupportsRequest(binding.modelId, request)) {
          return undefined;
        }

        const stats = this.modelStats.snapshotModel(binding.modelId);
        let score = 100 - index * 0.01;
        score += scoreModelHealth(stats);
        score += scoreModelName(binding, {
          complexity,
          codingSignal,
          hasTools,
          wantsStrongReasoning,
          requiredCapability,
          requestKind: request.requestKind,
        });

        return { binding, score, index };
      })
      .filter((candidate): candidate is { binding: ModelBinding; score: number; index: number } =>
        Boolean(candidate),
      )
      .sort((a, b) => b.score - a.score || a.index - b.index);
  }

  async *runModelStream(
    modelId: string,
    request: Omit<UnifiedRequest, "model" | "providerModel">,
  ): AsyncIterable<ProviderStreamEvent> {
    if (modelId === AUTO_MODEL_ID) {
      throw new Error("Auto model routing does not support provider-native streaming.");
    }
    const binding = this.models.get(modelId);
    if (!binding) {
      throw new Error(`Unknown model: ${modelId}`);
    }
    if (!binding.provider.runStream) {
      throw new Error(`Model ${modelId} does not support streaming.`);
    }
    if (binding.provider.supportsStreaming && !binding.provider.supportsStreaming()) {
      throw new Error(`Model ${modelId} does not support streaming.`);
    }

    const attemptIndex = 0;
    const startedAt = Date.now();
    this.modelStats.recordAttempt({
      modelId: binding.modelId,
      requestedModelId: modelId,
      providerId: binding.provider.id,
      providerModel: binding.providerModel,
      attemptIndex,
    });

    try {
      for await (const event of binding.provider.runStream({
        ...request,
        model: binding.modelId,
        providerModel: binding.providerModel,
      })) {
        yield event;
      }
      this.modelStats.recordSuccess({
        modelId: binding.modelId,
        requestedModelId: modelId,
        providerId: binding.provider.id,
        providerModel: binding.providerModel,
        attemptIndex,
        durationMs: Date.now() - startedAt,
      });
      trackProvider(binding.provider.id, binding.modelId, true, Date.now() - startedAt);
    } catch (error) {
      this.modelStats.recordFailure({
        modelId: binding.modelId,
        requestedModelId: modelId,
        providerId: binding.provider.id,
        providerModel: binding.providerModel,
        attemptIndex,
        durationMs: Date.now() - startedAt,
        error,
      });
      trackProvider(binding.provider.id, binding.modelId, false, Date.now() - startedAt);
      throw error;
    }
  }
}

function bindingSupportsImageGeneration(binding: ModelBinding): boolean {
  return binding.capabilities.includes("image_generation");
}

function bindingSupportsCapability(
  binding: ModelBinding,
  capability: ModelCapability,
): boolean {
  return binding.capabilities.includes(capability);
}

function normalizeModelCapabilities(
  capabilities: ModelCapability[] | undefined,
): ModelCapability[] {
  if (capabilities && capabilities.length > 0) {
    return [...new Set(capabilities)];
  }

  return ["chat", "responses", "tools", "reasoning", "structured_outputs"];
}

function requiredCapabilityForRequest(
  request: Omit<UnifiedRequest, "model" | "providerModel">,
): ModelCapability | undefined {
  if (request.requestKind === "images_generations") {
    return "image_generation";
  }

  if (request.requestKind === "chat_completions") {
    return "chat";
  }

  if (request.requestKind === "responses") {
    return "responses";
  }

  return undefined;
}

function isImageGenerationRequest(
  request: Omit<UnifiedRequest, "model" | "providerModel">,
): boolean {
  return request.requestKind === "images_generations";
}

function isInvalidProviderResult(
  result: ProviderResult,
  request: Omit<UnifiedRequest, "model" | "providerModel">,
): boolean {
  if (isImageGenerationRequest(request)) {
    return isBlankImageGenerationResult(result) || isSyntheticFailureProviderResult(result);
  }

  return isBlankProviderResult(result) || isSyntheticFailureProviderResult(result);
}

function isBlankProviderResult(result: ProviderResult): boolean {
  return result.toolCalls.length === 0 && result.outputText.trim().length === 0;
}

function isBlankImageGenerationResult(result: ProviderResult): boolean {
  return (
    result.toolCalls.length === 0 &&
    result.outputText.trim().length === 0 &&
    !hasPotentialImageGenerationPayload(result.raw)
  );
}

function hasPotentialImageGenerationPayload(value: unknown, depth = 0): boolean {
  if (depth > 8 || value === undefined || value === null) {
    return false;
  }

  if (typeof value === "string") {
    return value.trim().length > 0;
  }

  if (Array.isArray(value)) {
    return value.some((item) => hasPotentialImageGenerationPayload(item, depth + 1));
  }

  if (typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  for (const key of [
    "data",
    "images",
    "image",
    "inline_data",
    "inlineData",
    "output",
    "outputs",
    "content",
    "contentItems",
    "candidates",
    "parts",
    "items",
    "attachments",
    "artifact",
    "artifacts",
    "file",
    "files",
    "result",
    "url",
    "image_url",
    "imageUrl",
    "output_url",
    "outputUrl",
    "download_url",
    "downloadUrl",
    "b64_json",
    "b64_data",
    "base64",
    "base64_data",
    "image_base64",
    "imageBase64",
    "b64",
  ]) {
    if (
      Object.prototype.hasOwnProperty.call(record, key) &&
      hasPotentialImageGenerationPayload(record[key], depth + 1)
    ) {
      return true;
    }
  }

  return false;
}

function isSyntheticFailureProviderResult(result: ProviderResult): boolean {
  if (result.toolCalls.length > 0) {
    return false;
  }

  return isSyntheticAssistantOutputText(result.outputText);
}

function buildInvalidProviderResultError(
  providerId: string,
  modelId: string,
  result: ProviderResult,
): string {
  const raw = result.raw && typeof result.raw === "object"
    ? (result.raw as Record<string, unknown>)
    : undefined;
  const choice =
    raw && Array.isArray(raw.choices) && raw.choices[0] && typeof raw.choices[0] === "object"
      ? (raw.choices[0] as Record<string, unknown>)
      : undefined;
  const responseId = raw && typeof raw.id === "string" ? raw.id : undefined;
  const providerFinishReason =
    choice && typeof choice.finish_reason === "string" ? choice.finish_reason : undefined;

  const details = [
    `provider=${providerId}`,
    `model=${modelId}`,
    `normalized_finish_reason=${result.finishReason}`,
    providerFinishReason ? `provider_finish_reason=${providerFinishReason}` : undefined,
    responseId ? `response_id=${responseId}` : undefined,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ");

  if (isBlankProviderResult(result)) {
    return `Provider returned a blank assistant completion. ${details}`.trim();
  }

  const excerpt = result.outputText.trim().replace(/\s+/g, " ").slice(0, 160);
  return `Provider returned a synthetic failure assistant completion. ${details} output_excerpt=${JSON.stringify(excerpt)}`.trim();
}

function requestTextForScoring(
  request: Omit<UnifiedRequest, "model" | "providerModel">,
): string {
  const metadataPrompt =
    request.metadata && "prompt" in request.metadata
      ? extractTextContent(request.metadata.prompt).trim()
      : "";
  const messagesText = request.messages
    .map((message) => message.content)
    .filter(Boolean)
    .join("\n\n");
  return `${metadataPrompt}\n\n${messagesText}`.trim();
}

function scorePromptComplexity(text: string): number {
  const length = text.length;
  let score = 0;
  if (length > 12000) {
    score += 3;
  } else if (length > 4000) {
    score += 2;
  } else if (length > 1200) {
    score += 1;
  }

  if (/debug|refactor|architect|security|reason|analy[sz]e|compare|plan|multi[- ]step/i.test(text)) {
    score += 1;
  }

  return score;
}

function hasCodingSignal(
  text: string,
  metadata: Record<string, unknown> | undefined,
): boolean {
  const metadataText = metadata ? extractTextContent(metadata) : "";
  return /code|typescript|javascript|python|react|node|repo|git|diff|patch|bug|stack trace|kubectl|docker|build|test|deploy|function|class|api|endpoint/i.test(
    `${text}\n${metadataText}`,
  );
}

function scoreModelHealth(stats: ModelStatsModelSnapshot | undefined): number {
  if (!stats) {
    return 0;
  }

  let score = 0;
  if (stats.suggestedState === "healthy") {
    score += 8;
  } else if (stats.suggestedState === "degraded") {
    score -= 15;
  } else if (
    stats.suggestedState === "cooldown" ||
    stats.suggestedState === "rate_limited" ||
    stats.suggestedState === "capacity_exhausted" ||
    stats.suggestedState === "quota_exhausted" ||
    stats.suggestedState === "auth_blocked"
  ) {
    score -= 120;
  }

  if (stats.successes > 0) {
    score += Math.min(12, stats.successRate * 12);
  }
  score -= Math.min(18, stats.consecutiveFailures * 6);
  score -= Math.min(8, stats.averageSuccessLatencyMs / 15000);

  return score;
}

function scoreModelName(
  binding: ModelBinding,
  context: {
    complexity: number;
    codingSignal: boolean;
    hasTools: boolean;
    wantsStrongReasoning: boolean;
    requiredCapability?: ModelCapability;
    requestKind?: string;
  },
): number {
  const name = `${binding.modelId} ${binding.providerModel} ${binding.description ?? ""}`.toLowerCase();
  let score = 0;

  const isStrong = /gpt-5\.5|gpt-5\.4|opus|sonnet|gemini.*pro|deepseek.*(r1|reason|v4-pro)|reasoner|120b|k2|pro-preview|pro\b/.test(name);
  const isFast = /flash|mini|lite|instant|haiku|8b|20b|free|compound-mini/.test(name);
  const isCoding = /kimi|codex|coder|codestral|deepseek|qwen|gpt-5|claude|sonnet/.test(name);

  if (context.requestKind === "images_generations") {
    score += bindingSupportsImageGeneration(binding) ? 100 : -100;
  }

  if (context.hasTools) {
    score += bindingSupportsCapability(binding, "tools") ? 24 : -80;
    if (/compound(?:-mini)?|openrouter\/free/.test(name)) {
      score -= 12;
    }
  }

  if (context.requiredCapability && bindingSupportsCapability(binding, context.requiredCapability)) {
    score += 10;
  }

  if (context.codingSignal) {
    score += isCoding ? 28 : 0;
    score -= /whisper|speech|tts|image/.test(name) ? 60 : 0;
  }

  if (context.wantsStrongReasoning || context.complexity >= 2) {
    score += isStrong ? 24 : 0;
    score -= isFast && !isStrong ? 8 : 0;
  } else if (context.complexity === 0) {
    score += isFast ? 16 : 0;
  }

  if (/openrouter/.test(name)) {
    score += 4;
  }

  return score;
}
