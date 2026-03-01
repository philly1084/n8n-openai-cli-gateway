import type {
  AuthStatusResult,
  CliProviderConfig,
  LoginJobSummary,
  ProviderModelConfig,
  ProviderRateLimits,
  ProviderResult,
  UnifiedRequest,
} from "../types";
import type { JobManager } from "../jobs/job-manager";

export interface Provider {
  readonly id: string;
  readonly description?: string;
  readonly config: CliProviderConfig;
  readonly models: ProviderModelConfig[];

  run(request: UnifiedRequest): Promise<ProviderResult>;
  startLoginJob(jobManager: JobManager): Promise<LoginJobSummary>;
  checkAuthStatus(): Promise<AuthStatusResult>;
  /** Check rate limits/quota for this provider */
  checkRateLimits(): Promise<ProviderRateLimits>;
}
