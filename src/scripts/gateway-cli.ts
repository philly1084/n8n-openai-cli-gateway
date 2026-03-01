#!/usr/bin/env node
/**
 * Gateway CLI Tool
 * 
 * A command-line interface for querying the n8n OpenAI CLI Gateway.
 * Provides commands to check health, rate limits, and provider status.
 * 
 * Usage:
 *   npx tsx src/scripts/gateway-cli.ts [command] [options]
 * 
 * Commands:
 *   health              Check gateway health
 *   providers           List all providers
 *   rate-limits         Check rate limits for all providers or a specific one
 *   stats               Show model statistics
 * 
 * Options:
 *   --url, -u           Gateway URL (default: http://localhost:8080)
 *   --admin-key, -k     Admin API key (required for most commands)
 *   --provider, -p      Provider ID (for provider-specific commands)
 *   --format, -f        Output format: json, table (default: table)
 *   --help, -h          Show help
 */

import { request } from "http";

interface CliOptions {
  url: string;
  adminKey?: string;
  provider?: string;
  format: "json" | "table";
}

function parseArgs(): { command: string; options: CliOptions } {
  const args = process.argv.slice(2);
  const options: CliOptions = {
    url: process.env.GATEWAY_URL || "http://localhost:8080",
    adminKey: process.env.ADMIN_API_KEY,
    format: "table",
  };
  let command = "";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;

    if (arg === "--help" || arg === "-h") {
      showHelp();
      process.exit(0);
    } else if (arg === "--url" || arg === "-u") {
      const nextArg = args[++i];
      if (nextArg) {
        options.url = nextArg;
      }
    } else if (arg === "--admin-key" || arg === "-k") {
      options.adminKey = args[++i];
    } else if (arg === "--provider" || arg === "-p") {
      options.provider = args[++i];
    } else if (arg === "--format" || arg === "-f") {
      const format = args[++i];
      if (format === "json" || format === "table") {
        options.format = format;
      }
    } else if (!arg.startsWith("-")) {
      if (!command) {
        command = arg;
      }
    }
  }

  if (!command) {
    console.error("Error: No command specified");
    showHelp();
    process.exit(1);
  }

  return { command, options };
}

function showHelp(): void {
  console.log(`
Gateway CLI Tool

A command-line interface for querying the n8n OpenAI CLI Gateway.

Usage:
  gateway-cli [command] [options]

Commands:
  health              Check gateway health
  providers           List all providers
  rate-limits         Check rate limits for all providers or a specific one
  stats               Show model statistics

Options:
  --url, -u           Gateway URL (default: http://localhost:8080 or GATEWAY_URL env)
  --admin-key, -k     Admin API key (default: ADMIN_API_KEY env)
  --provider, -p      Provider ID (for provider-specific commands)
  --format, -f        Output format: json, table (default: table)
  --help, -h          Show help

Environment Variables:
  GATEWAY_URL         Default gateway URL
  ADMIN_API_KEY       Default admin API key

Examples:
  # Check health
  gateway-cli health

  # List all providers
  gateway-cli providers -k sk-admin-xxx

  # Check rate limits for all providers
  gateway-cli rate-limits -k sk-admin-xxx

  # Check rate limits for specific provider
  gateway-cli rate-limits -k sk-admin-xxx -p gemini-cli

  # Output as JSON
  gateway-cli rate-limits -k sk-admin-xxx -f json
`);
}

async function makeRequest(
  url: string,
  path: string,
  adminKey?: string,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(path, url);
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === "https:" ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: "GET",
      headers: adminKey
        ? { "x-admin-key": adminKey }
        : {},
    };

    const req = request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${JSON.stringify(parsed)}`));
          } else {
            resolve(parsed);
          }
        } catch {
          resolve(data);
        }
      });
    });

    req.on("error", reject);
    req.end();
  });
}

// Formatting functions
function formatHealth(data: { ok: boolean; ts: string }): string {
  const status = data.ok ? "✓ Healthy" : "✗ Unhealthy";
  return `${status} (checked at ${data.ts})`;
}

interface ProviderInfo {
  id: string;
  description?: string;
  auth?: {
    loginConfigured?: boolean;
    statusConfigured?: boolean;
    rateLimitConfigured?: boolean;
    status?: { ok: boolean };
  };
}

function formatProviders(data: { data: ProviderInfo[] }): string {
  const lines: string[] = ["PROVIDERS", "=========", ""];

  for (const provider of data.data) {
    const auth = provider.auth || {};
    const status = auth.status
      ? auth.status.ok
        ? "✓ Auth OK"
        : "✗ Auth Failed"
      : "? Auth Unknown";

    lines.push(`${provider.id}`);
    lines.push(`  Description: ${provider.description || "N/A"}`);
    lines.push(`  Auth Status: ${status}`);
    lines.push(
      `  Features: ` +
        `login:${auth.loginConfigured ? "✓" : "✗"} ` +
        `status:${auth.statusConfigured ? "✓" : "✗"} ` +
        `rate-limit:${auth.rateLimitConfigured ? "✓" : "✗"}`,
    );
    lines.push("");
  }

  return lines.join("\n");
}

interface RateLimitInfo {
  limitType: string;
  currentUsage?: number;
  maxAllowed?: number;
  remaining?: number;
  resetAt?: string;
  checkedAt: string;
  ok: boolean;
  error?: string;
}

interface ProviderRateLimits {
  providerId: string;
  providerDescription?: string;
  status: "healthy" | "degraded" | "rate_limited" | "auth_error" | "unknown";
  limits: RateLimitInfo[];
  lastCheckedAt?: string;
}

function formatRateLimits(data: { data: ProviderRateLimits[]; summary: Record<string, number> }): string {
  const lines: string[] = ["RATE LIMITS", "===========", ""];

  // Summary
  lines.push("Summary:");
  for (const [key, value] of Object.entries(data.summary)) {
    lines.push(`  ${key}: ${value}`);
  }
  lines.push("");

  // Details for each provider
  for (const provider of data.data) {
    const statusIcon =
      provider.status === "healthy"
        ? "✓"
        : provider.status === "degraded"
          ? "⚠"
          : provider.status === "rate_limited"
            ? "✗"
            : "?";

    lines.push(`${statusIcon} ${provider.providerId}`);
    lines.push(`  Status: ${provider.status}`);

    if (provider.limits.length === 0) {
      lines.push("  No limit data available");
    } else {
      for (const limit of provider.limits) {
        if (limit.error) {
          lines.push(`  Error: ${limit.error}`);
          continue;
        }

        const parts: string[] = [];
        parts.push(`Type: ${limit.limitType}`);

        if (limit.remaining !== undefined) {
          parts.push(`Remaining: ${limit.remaining}`);
        }
        if (limit.maxAllowed !== undefined) {
          parts.push(`Max: ${limit.maxAllowed}`);
        }
        if (limit.currentUsage !== undefined) {
          parts.push(`Used: ${limit.currentUsage}`);
        }
        if (limit.resetAt) {
          const resetTime = new Date(limit.resetAt);
          const now = new Date();
          const minutesUntil = Math.ceil((resetTime.getTime() - now.getTime()) / 60000);
          if (minutesUntil > 0) {
            parts.push(`Resets in: ${minutesUntil}m`);
          }
        }

        lines.push(`  ${parts.join(" | ")}`);
      }
    }

    lines.push(`  Checked: ${provider.lastCheckedAt || "N/A"}`);
    lines.push("");
  }

  return lines.join("\n");
}

function formatRateLimitSingle(provider: ProviderRateLimits): string {
  const lines: string[] = [`RATE LIMITS: ${provider.providerId}`, "===========", ""];

  const statusIcon =
    provider.status === "healthy"
      ? "✓"
      : provider.status === "degraded"
        ? "⚠"
        : provider.status === "rate_limited"
          ? "✗"
          : "?";

  lines.push(`Status: ${statusIcon} ${provider.status}`);
  lines.push("");

  if (provider.limits.length === 0) {
    lines.push("No limit data available");
  } else {
    for (const limit of provider.limits) {
      if (limit.error) {
        lines.push(`Error: ${limit.error}`);
        continue;
      }

      lines.push(`Type: ${limit.limitType}`);

      if (limit.remaining !== undefined) {
        const percent = limit.maxAllowed
          ? Math.round((limit.remaining / limit.maxAllowed) * 100)
          : 0;
        lines.push(`  Remaining: ${limit.remaining} (${percent}%)`);
      }
      if (limit.maxAllowed !== undefined) {
        lines.push(`  Max Allowed: ${limit.maxAllowed}`);
      }
      if (limit.currentUsage !== undefined) {
        lines.push(`  Current Usage: ${limit.currentUsage}`);
      }
      if (limit.resetAt) {
        const resetTime = new Date(limit.resetAt);
        lines.push(`  Resets At: ${resetTime.toLocaleString()}`);
      }
      lines.push(`  Checked: ${new Date(limit.checkedAt).toLocaleString()}`);
      lines.push("");
    }
  }

  return lines.join("\n");
}

// Command handlers
async function healthCommand(options: CliOptions): Promise<void> {
  try {
    const data = await makeRequest(options.url, "/healthz") as { ok: boolean; ts: string };

    if (options.format === "json") {
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(formatHealth(data));
    }
  } catch (error) {
    console.error("Health check failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

async function providersCommand(options: CliOptions): Promise<void> {
  if (!options.adminKey) {
    console.error("Error: Admin API key required. Use --admin-key or ADMIN_API_KEY env.");
    process.exit(1);
  }

  try {
    const data = await makeRequest(options.url, "/admin/providers", options.adminKey) as { data: ProviderInfo[] };

    if (options.format === "json") {
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(formatProviders(data));
    }
  } catch (error) {
    console.error("Failed to get providers:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

async function rateLimitsCommand(options: CliOptions): Promise<void> {
  if (!options.adminKey) {
    console.error("Error: Admin API key required. Use --admin-key or ADMIN_API_KEY env.");
    process.exit(1);
  }

  try {
    const path = options.provider
      ? `/admin/rate-limits/${encodeURIComponent(options.provider)}`
      : "/admin/rate-limits";

    const data = await makeRequest(options.url, path, options.adminKey) as
      | { data: ProviderRateLimits[]; summary: Record<string, number> }
      | ProviderRateLimits;

    if (options.format === "json") {
      console.log(JSON.stringify(data, null, 2));
    } else {
      if ("summary" in data) {
        console.log(formatRateLimits(data));
      } else {
        console.log(formatRateLimitSingle(data));
      }
    }
  } catch (error) {
    console.error("Failed to get rate limits:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

async function statsCommand(options: CliOptions): Promise<void> {
  if (!options.adminKey) {
    console.error("Error: Admin API key required. Use --admin-key or ADMIN_API_KEY env.");
    process.exit(1);
  }

  try {
    const data = await makeRequest(options.url, "/admin/stats/models", options.adminKey);

    if (options.format === "json") {
      console.log(JSON.stringify(data, null, 2));
    } else {
      // Simple table format for stats
      console.log(JSON.stringify(data, null, 2));
    }
  } catch (error) {
    console.error("Failed to get stats:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

// Main
async function main(): Promise<void> {
  const { command, options } = parseArgs();

  switch (command) {
    case "health":
      await healthCommand(options);
      break;
    case "providers":
      await providersCommand(options);
      break;
    case "rate-limits":
      await rateLimitsCommand(options);
      break;
    case "stats":
      await statsCommand(options);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      showHelp();
      process.exit(1);
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
