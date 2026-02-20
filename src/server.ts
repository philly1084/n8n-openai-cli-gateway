import Fastify from "fastify";
import type { AppConfig } from "./types";
import { adminRoutes } from "./routes/admin";
import { openAiRoutes } from "./routes/openai";
import { JobManager } from "./jobs/job-manager";
import { ProviderRegistry } from "./providers/registry";

export function buildServer(config: AppConfig, registry: ProviderRegistry) {
  const app = Fastify({
    logger: {
      level: config.logLevel,
    },
  });

  const jobManager = new JobManager(config.maxJobLogLines);

  app.get("/healthz", async () => ({
    ok: true,
    ts: new Date().toISOString(),
  }));

  app.register(openAiRoutes, {
    prefix: "/v1",
    registry,
    n8nApiKeys: config.n8nApiKeys,
  });

  app.register(openAiRoutes, {
    prefix: "/openai/v1",
    registry,
    n8nApiKeys: config.n8nApiKeys,
  });

  app.register(adminRoutes, {
    prefix: "/admin",
    registry,
    jobManager,
    adminApiKey: config.adminApiKey,
  });

  app.setErrorHandler((error, _request, reply) => {
    requestLogger(error);
    if (reply.sent) {
      return;
    }
    reply.status(500).send({
      error: {
        message: "Internal server error.",
      },
    });
  });

  return app;
}

function requestLogger(error: unknown): void {
  // Keep this as a plain stderr fallback in case logger setup fails.
  // Fastify logger still receives structured output for route-level errors.
  if (error instanceof Error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    return;
  }

  process.stderr.write(`${String(error)}\n`);
}
