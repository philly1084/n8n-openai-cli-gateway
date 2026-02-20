import type { CliProviderConfig, ProviderResult, UnifiedRequest } from "../types";
import { CliProvider } from "./cli-provider";
import type { Provider } from "./provider";

interface ModelBinding {
  modelId: string;
  providerModel: string;
  provider: Provider;
  description?: string;
}

export class ProviderRegistry {
  private readonly providers = new Map<string, Provider>();
  private readonly models = new Map<string, ModelBinding>();

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
  }> {
    return [...this.models.values()].map((binding) => ({
      id: binding.modelId,
      description: binding.description,
      providerId: binding.provider.id,
      providerModel: binding.providerModel,
    }));
  }

  listProviders(): Provider[] {
    return [...this.providers.values()];
  }

  getProvider(providerId: string): Provider | undefined {
    return this.providers.get(providerId);
  }

  async runModel(
    modelId: string,
    request: Omit<UnifiedRequest, "model" | "providerModel">,
  ): Promise<ProviderResult> {
    const binding = this.models.get(modelId);
    if (!binding) {
      throw new Error(`Unknown model: ${modelId}`);
    }

    return await binding.provider.run({
      ...request,
      model: binding.modelId,
      providerModel: binding.providerModel,
    });
  }
}
