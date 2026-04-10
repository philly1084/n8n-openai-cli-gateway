import type {
  AuthStatusResult,
  LoginJobSummary,
  ProviderConfig,
  ProviderModelConfig,
  ProviderRateLimits,
  ProviderResult,
  ProviderStreamEvent,
  UnifiedRequest,
} from "../types";
import type { JobManager } from "../jobs/job-manager";

export interface Provider {
  readonly id: string;
  readonly description?: string;
  readonly config: ProviderConfig;
  readonly models: ProviderModelConfig[];

  run(request: UnifiedRequest): Promise<ProviderResult>;
  runStream?(request: UnifiedRequest): AsyncIterable<ProviderStreamEvent>;
  supportsStreaming?(): boolean;
  startLoginJob(jobManager: JobManager): Promise<LoginJobSummary>;
  checkAuthStatus(): Promise<AuthStatusResult>;
  /** Check rate limits/quota for this provider */
  checkRateLimits(): Promise<ProviderRateLimits>;
}
