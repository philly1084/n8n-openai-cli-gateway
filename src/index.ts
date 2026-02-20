import { loadAppConfig, loadProvidersFile } from "./config";
import { ProviderRegistry } from "./providers/registry";
import { buildServer } from "./server";

async function main(): Promise<void> {
  const config = loadAppConfig();
  const providersFile = loadProvidersFile(config.providersPath);
  const registry = new ProviderRegistry(providersFile.providers);
  const app = buildServer(config, registry);

  const stop = async () => {
    await app.close();
    process.exit(0);
  };

  process.on("SIGTERM", () => void stop());
  process.on("SIGINT", () => void stop());

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
    },
    "gateway listening",
  );
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
