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
        if (registry.models.has(model.id)) {
          throw new Error(`Duplicate model id: ${model.id}`);
        }
        registry.models.set(model.id, {
          modelId: model.id,
          providerModel: model.providerModel || model.id,
          provider,
          description: model.description,
          fallbackModelIds: model.fallbackModels || [],
          capabilities: model.capabilities || [],
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
    return [...this.models.values()].map((binding) => ({
      id: binding.modelId,
      description: binding.description,
      providerId: binding.provider.id,
      providerModel: binding.providerModel,
      fallbackModels: binding.fallbackModelIds,
      capabilities: binding.capabilities,
    }));
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
    if (!this.models.has(modelId)) {
      throw new Error(`Unknown model: ${modelId}`);
    }

    const attempted: string[] = [];
    const visited = new Set<string>();
    let currentModelId: string | undefined = modelId;
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
        return result;
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
        const nextModelId = binding.fallbackModelIds.find(
          (fallback) =>
            !visited.has(fallback) &&
            (!isImageGenerationRequest(request) || this.modelSupportsImageGeneration(fallback)),
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

  async *runModelStream(
    modelId: string,
    request: Omit<UnifiedRequest, "model" | "providerModel">,
  ): AsyncIterable<ProviderStreamEvent> {
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
