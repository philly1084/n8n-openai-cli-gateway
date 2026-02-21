import type { CliProviderConfig, ProviderResult, UnifiedRequest } from "../types";
import type {
  ModelStatsModelSnapshot,
  ModelStatsSnapshot,
} from "../stats/model-stats";
import { ModelStatsTracker } from "../stats/model-stats";
import { CliProvider } from "./cli-provider";
import type { Provider } from "./provider";

interface ModelBinding {
  modelId: string;
  providerModel: string;
  provider: Provider;
  description?: string;
  fallbackModelIds: string[];
}

export class ProviderRegistry {
  private readonly providers = new Map<string, Provider>();
  private readonly models = new Map<string, ModelBinding>();
  private readonly modelStats = new ModelStatsTracker();

  constructor(configs: CliProviderConfig[]) {
    for (const config of configs) {
      const provider = new CliProvider(config);
      if (this.providers.has(provider.id)) {
        throw new Error(`Duplicate provider id: ${provider.id}`);
      }
      this.providers.set(provider.id, provider);

      for (const model of provider.models) {
        if (this.models.has(model.id)) {
          throw new Error(`Duplicate model id: ${model.id}`);
        }
        this.models.set(model.id, {
          modelId: model.id,
          providerModel: model.providerModel || model.id,
          provider,
          description: model.description,
          fallbackModelIds: model.fallbackModels || [],
        });
        this.modelStats.registerModel({
          modelId: model.id,
          providerId: provider.id,
          providerModel: model.providerModel || model.id,
          description: model.description,
          fallbackModels: model.fallbackModels || [],
        });
      }
    }

    if (this.providers.size === 0) {
      throw new Error("No providers configured.");
    }
  }

  listModels(): Array<{
    id: string;
    description?: string;
    providerId: string;
    providerModel: string;
    fallbackModels: string[];
  }> {
    return [...this.models.values()].map((binding) => ({
      id: binding.modelId,
      description: binding.description,
      providerId: binding.provider.id,
      providerModel: binding.providerModel,
      fallbackModels: binding.fallbackModelIds,
    }));
  }

  listProviders(): Provider[] {
    return [...this.providers.values()];
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
        const result = await binding.provider.run({
          ...request,
          model: binding.modelId,
          providerModel: binding.providerModel,
        });
        this.modelStats.recordSuccess({
          modelId: binding.modelId,
          requestedModelId: modelId,
          providerId: binding.provider.id,
          providerModel: binding.providerModel,
          attemptIndex,
          durationMs: Date.now() - startedAt,
        });
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
        const nextModelId = binding.fallbackModelIds.find((fallback) => !visited.has(fallback));
        if (!nextModelId) {
          break;
        }
        this.modelStats.recordFallback({
          requestedModelId: modelId,
          fromModelId: binding.modelId,
          toModelId: nextModelId,
          reason: failureKind,
        });
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
}
