import { readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { AppConfig, ProvidersFile } from "./types";

const commandSchema = z.object({
  executable: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).optional(),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().positive().default(180000),
});

const providersFileSchema = z.object({
  providers: z
    .array(
      z.object({
        id: z.string().min(1),
        type: z.literal("cli"),
        description: z.string().optional(),
        models: z
          .array(
            z.object({
              id: z.string().min(1),
              providerModel: z.string().optional(),
              description: z.string().optional(),
            }),
          )
          .min(1),
        responseCommand: commandSchema.extend({
          output: z.enum(["text", "json_contract"]).default("text"),
          input: z.enum(["prompt_stdin", "request_json_stdin"]).default("prompt_stdin"),
        }),
        auth: z
          .object({
            loginCommand: commandSchema.optional(),
            statusCommand: commandSchema.optional(),
          })
          .optional(),
      }),
    )
    .min(1),
});

function parseApiKeys(): Set<string> {
  const keys = new Set<string>();

  const single = process.env.N8N_API_KEY?.trim();
  if (single) {
    keys.add(single);
  }

  const multi = process.env.N8N_API_KEYS;
  if (multi) {
    for (const key of multi.split(",")) {
      const value = key.trim();
      if (value) {
        keys.add(value);
      }
    }
  }

  if (keys.size === 0) {
    throw new Error("Set N8N_API_KEY or N8N_API_KEYS.");
  }

  return keys;
}

export function loadAppConfig(): AppConfig {
  const adminApiKey = process.env.ADMIN_API_KEY?.trim();
  if (!adminApiKey) {
    throw new Error("Set ADMIN_API_KEY.");
  }

  const host = process.env.HOST?.trim() || "0.0.0.0";
  const portRaw = process.env.PORT?.trim() || "8080";
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid PORT: ${portRaw}`);
  }

  const providersPath = path.resolve(
    process.cwd(),
    process.env.PROVIDERS_CONFIG_PATH?.trim() || "config/providers.yaml",
  );

  const logLevel = (process.env.LOG_LEVEL?.trim() as AppConfig["logLevel"] | undefined) || "info";
  const maxJobLogLinesRaw = process.env.MAX_JOB_LOG_LINES?.trim() || "300";
  const maxJobLogLines = Number(maxJobLogLinesRaw);
  if (!Number.isInteger(maxJobLogLines) || maxJobLogLines < 50) {
    throw new Error(`Invalid MAX_JOB_LOG_LINES: ${maxJobLogLinesRaw}`);
  }

  return {
    host,
    port,
    providersPath,
    n8nApiKeys: parseApiKeys(),
    adminApiKey,
    logLevel,
    maxJobLogLines,
  };
}

export function loadProvidersFile(providersPath: string): ProvidersFile {
  let raw = "";
  try {
    raw = readFileSync(providersPath, "utf8");
  } catch (error) {
    throw new Error(
      `Unable to read providers config at ${providersPath}. Copy config/providers.example.yaml to this path and edit it.`,
      { cause: error },
    );
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (error) {
    throw new Error(`Invalid YAML in ${providersPath}.`, { cause: error });
  }

  return providersFileSchema.parse(parsed);
}
