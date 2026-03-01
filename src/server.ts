import Fastify from "fastify";
import type { AppConfig } from "./types";
import { adminRoutes } from "./routes/admin";
import { openAiRoutes } from "./routes/openai";
import { JobManager } from "./jobs/job-manager";
import { ProviderRegistry } from "./providers/registry";

// Simple in-memory rate limit store
interface RateLimitEntry {
  count: number;
  resetTime: number;
}

const rateLimitStore = new Map<string, RateLimitEntry>();

function getRateLimitKey(request: { headers: Record<string, unknown> }): string {
  // Use API key as the rate limit identifier
  const xApiKey = request.headers["x-api-key"];
  const xApiKeyValue = Array.isArray(xApiKey) ? xApiKey[0] : xApiKey;
  if (typeof xApiKeyValue === "string") {
    return xApiKeyValue.trim();
  }

  const auth = request.headers.authorization;
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice("bearer ".length).trim();
  }

  // Fallback to IP (not available in all environments, but good enough)
  return "anonymous";
}

function checkRateLimit(key: string, max: number, windowMs: number): { allowed: boolean; retryAfter?: number } {
  const now = Date.now();
  const entry = rateLimitStore.get(key);

  if (!entry || now > entry.resetTime) {
    // New window
    rateLimitStore.set(key, {
      count: 1,
      resetTime: now + windowMs,
    });
    return { allowed: true };
  }

  if (entry.count >= max) {
    // Rate limit exceeded
    return {
      allowed: false,
      retryAfter: Math.ceil((entry.resetTime - now) / 1000),
    };
  }

  // Increment count
  entry.count++;
  return { allowed: true };
}

// Periodic cleanup of expired rate limit entries
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore.entries()) {
    if (now > entry.resetTime) {
      rateLimitStore.delete(key);
    }
  }
}, 60000); // Clean up every minute

export function buildServer(config: AppConfig, registry: ProviderRegistry) {
  const app = Fastify({
    logger: {
      level: config.logLevel,
    },
    // Request body size limit
    bodyLimit: config.maxRequestBodySize,
  });

  const jobManager = new JobManager(config.maxJobLogLines);

  // Rate limiting hook for OpenAI routes
  app.addHook("preHandler", async (request, reply) => {
    // Only rate limit OpenAI routes (not admin routes or health)
    if (!request.url.startsWith("/v1/") && !request.url.startsWith("/openai/v1/")) {
      return;
    }

    const key = getRateLimitKey(request);
    const result = checkRateLimit(key, config.rateLimitMax, config.rateLimitWindowMs);

    if (!result.allowed) {
      reply.header("Retry-After", result.retryAfter?.toString() ?? "60");
      return reply.status(429).send({
        error: {
          message: "Rate limit exceeded. Please try again later.",
          type: "rate_limit_error",
          code: 429,
        },
      });
    }
  });

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

  app.setErrorHandler((error, request, reply) => {
    request.log.error(error);
    if (reply.sent) {
      return;
    }

    // Handle validation errors
    const statusCode = error && typeof error === "object" && "statusCode" in error
      ? (error as { statusCode?: number }).statusCode
      : undefined;
    if (statusCode === 413) {
      return reply.status(413).send({
        error: {
          message: "Request body too large.",
          type: "invalid_request_error",
          code: 413,
        },
      });
    }

    reply.status(500).send({
      error: {
        message: "Internal server error.",
      },
    });
  });

  return {
    app,
    /**
     * Closes the server gracefully, waiting for existing connections to complete
     * up to the specified timeout.
     */
    async close(): Promise<void> {
      app.log.info("Starting graceful shutdown...");

      // Stop accepting new connections
      await app.close();

      app.log.info("Graceful shutdown complete.");
    },
  };
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
