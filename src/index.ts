import { loadAppConfig, loadProvidersFile } from "./config";
import { ProviderRegistry } from "./providers/registry";
import { buildServer } from "./server";

async function main(): Promise<void> {
  const config = loadAppConfig();
  const providersFile = loadProvidersFile(config.providersPath);
  const registry = new ProviderRegistry(providersFile.providers);
  const { app, close } = buildServer(config, registry);

  // Track active connections for graceful shutdown
  let isShuttingDown = false;

  const gracefulShutdown = async (signal: string) => {
    if (isShuttingDown) {
      app.log.warn(`Received ${signal} while already shutting down, forcing exit...`);
      process.exit(1);
    }

    isShuttingDown = true;
    app.log.info(`Received ${signal}, starting graceful shutdown...`);

    // Set a hard timeout to force exit
    const forceExitTimeout = setTimeout(() => {
      app.log.error(`Graceful shutdown timed out after ${config.shutdownTimeoutMs}ms, forcing exit.`);
      process.exit(1);
    }, config.shutdownTimeoutMs);

    try {
      await close();
      clearTimeout(forceExitTimeout);
      app.log.info("Server closed successfully.");
      process.exit(0);
    } catch (error) {
      clearTimeout(forceExitTimeout);
      app.log.error(error, "Error during graceful shutdown");
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => void gracefulShutdown("SIGINT"));

  await app.listen({
    host: config.host,
    port: config.port,
  });

  app.log.info(
    {
      host: config.host,
      port: config.port,
      providersPath: config.providersPath,
      models: registry.listModels().map((item) => item.id),
      rateLimitMax: config.rateLimitMax,
      rateLimitWindowMs: config.rateLimitWindowMs,
      maxRequestBodySize: config.maxRequestBodySize,
      shutdownTimeoutMs: config.shutdownTimeoutMs,
    },
    "gateway listening",
  );
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
