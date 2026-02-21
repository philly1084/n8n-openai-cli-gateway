import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { JobManager } from "../jobs/job-manager";
import type { ProviderRegistry } from "../providers/registry";

interface AdminRoutesOptions {
  registry: ProviderRegistry;
  jobManager: JobManager;
  adminApiKey: string;
}

export const adminRoutes: FastifyPluginAsync<AdminRoutesOptions> = async (app, options) => {
  app.addHook("preHandler", async (request, reply) => {
    if (!isAdminAuthorized(request, options.adminApiKey)) {
      reply.status(401).send({
        error: "Unauthorized",
      });
      return reply;
    }
  });

  app.get("/providers", async (request) => {
    const query = request.query as Record<string, unknown>;
    const checkAuth = query.check === "true" || query.check === true;

    const data = await Promise.all(
      options.registry.listProviders().map(async (provider) => {
        const statusConfigured = Boolean(provider.config.auth?.statusCommand);
        const loginConfigured = Boolean(provider.config.auth?.loginCommand);

        let authStatus:
          | {
              ok: boolean;
              exitCode: number | null;
              stdout: string;
              stderr: string;
            }
          | undefined;

        if (checkAuth && statusConfigured) {
          authStatus = await provider.checkAuthStatus();
        }

        return {
          id: provider.id,
          description: provider.description,
          models: provider.models,
          auth: {
            loginConfigured,
            statusConfigured,
            status: authStatus,
          },
        };
      }),
    );

    return { data };
  });

  app.post("/providers/:providerId/login", async (request, reply) => {
    const params = request.params as { providerId?: string };
    const providerId = params.providerId?.trim() || "";
    const provider = options.registry.getProvider(providerId);
    if (!provider) {
      return reply.status(404).send({
        error: `Unknown provider: ${providerId}`,
      });
    }

    try {
      const job = await provider.startLoginJob(options.jobManager);
      return {
        job,
        message:
          "Login command started. Poll /admin/jobs/{id} to capture URL/code output over SSH.",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start login job.";
      return reply.status(400).send({ error: message });
    }
  });

  app.post("/providers/:providerId/status", async (request, reply) => {
    const params = request.params as { providerId?: string };
    const providerId = params.providerId?.trim() || "";
    const provider = options.registry.getProvider(providerId);
    if (!provider) {
      return reply.status(404).send({
        error: `Unknown provider: ${providerId}`,
      });
    }

    const status = await provider.checkAuthStatus();
    return {
      providerId,
      status,
    };
  });

  app.get("/jobs", async (request) => {
    const query = request.query as Record<string, unknown>;
    const limitRaw = typeof query.limit === "string" ? Number(query.limit) : 50;
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? limitRaw : 50;
    return {
      data: options.jobManager.listJobs(Math.min(limit, 200)),
    };
  });

  app.get("/jobs/:jobId", async (request, reply) => {
    const params = request.params as { jobId?: string };
    const jobId = params.jobId?.trim() || "";
    const job = options.jobManager.getJob(jobId);
    if (!job) {
      return reply.status(404).send({
        error: `Unknown job: ${jobId}`,
      });
    }
    return job;
  });

  app.get("/stats/models", async () => {
    return options.registry.getModelStats();
  });

  app.get("/stats/models/:modelId", async (request, reply) => {
    const params = request.params as { modelId?: string };
    const modelId = params.modelId?.trim() || "";
    const snapshot = options.registry.getModelStatsById(modelId);
    if (!snapshot) {
      return reply.status(404).send({
        error: `Unknown model: ${modelId}`,
      });
    }
    return snapshot;
  });
};

function isAdminAuthorized(request: FastifyRequest, adminApiKey: string): boolean {
  const xAdmin = request.headers["x-admin-key"];
  if (typeof xAdmin === "string" && xAdmin === adminApiKey) {
    return true;
  }

  const authorization = request.headers.authorization;
  if (authorization && authorization.toLowerCase().startsWith("bearer ")) {
    const token = authorization.slice("bearer ".length).trim();
    if (token === adminApiKey) {
      return true;
    }
  }

  return false;
}
