/**
 * CLI Execution Manager
 * 
 * Handles execution of shell commands for software development workflows.
 * Tracks execution jobs, handles timeouts, and captures output.
 */

import { spawn } from "node:child_process";
import { makeId } from "../utils/ids";

export interface CliExecJob {
  id: string;
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
  status: "running" | "completed" | "failed" | "timed_out";
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  stdout: string;
  stderr: string;
  durationMs?: number;
}

interface CliExecJobInternal extends CliExecJob {
  maxOutputBytes: number;
  stdoutLineCount: number;
  stderrLineCount: number;
}

const MAX_OUTPUT_LINES = 1000;
const DEFAULT_TIMEOUT_MS = 300000; // 5 minutes

// Whitelist of allowed commands for security
const ALLOWED_COMMANDS = new Set([
  // Git
  "git",
  // Docker
  "docker",
  "docker-compose",
  // Kubernetes
  "kubectl",
  "helm",
  // Build tools
  "npm",
  "node",
  "npx",
  "yarn",
  "pnpm",
  "make",
  "cmake",
  // Languages
  "python",
  "python3",
  "go",
  "cargo",
  "rustc",
  "javac",
  "java",
  // Shell
  "sh",
  "bash",
  "zsh",
  // Utilities
  "curl",
  "wget",
  "tar",
  "zip",
  "unzip",
  "mkdir",
  "rm",
  "cp",
  "mv",
  "ls",
  "cat",
  "echo",
  "grep",
  "awk",
  "sed",
  "find",
  "xargs",
  "chmod",
  "chown",
  // Terraform
  "terraform",
  // AWS
  "aws",
  // GCP
  "gcloud",
  // Azure
  "az",
]);

// Commands that can modify system state (require extra caution)
const MUTATING_COMMANDS = new Set([
  "docker", "kubectl", "helm", "terraform", "aws", "gcloud", "az",
  "rm", "cp", "mv", "chmod", "chown", "git",
]);

export class CliExecManager {
  private readonly jobs = new Map<string, CliExecJobInternal>();

  /**
   * Execute a CLI command.
   * Returns immediately with a job ID. Poll the job for results.
   */
  async execute(
    command: string,
    args: string[],
    options: {
      cwd?: string;
      env?: Record<string, string>;
      timeoutMs?: number;
      maxOutputLines?: number;
    } = {},
  ): Promise<CliExecJob> {
    // Validate command is allowed
    const baseCommand = command.split("/").pop() ?? command;
    if (!ALLOWED_COMMANDS.has(baseCommand)) {
      throw new Error(
        `Command '${baseCommand}' is not in the allowed list. ` +
        `Allowed commands: ${[...ALLOWED_COMMANDS].slice(0, 10).join(", ")}...`,
      );
    }

    const id = makeId("cli");
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxOutputBytes = (options.maxOutputLines ?? MAX_OUTPUT_LINES) * 200; // ~200 bytes per line

    const record: CliExecJobInternal = {
      id,
      command,
      args: [...args],
      cwd: options.cwd,
      env: options.env ?? {},
      status: "running",
      startedAt: new Date().toISOString(),
      stdout: "",
      stderr: "",
      maxOutputBytes,
      stdoutLineCount: 0,
      stderrLineCount: 0,
    };

    this.jobs.set(id, record);

    // Start execution in background
    this.runCommand(record, timeoutMs).catch((error) => {
      if (record.status === "running") {
        record.status = "failed";
        record.stderr += `\n[system] Execution error: ${error instanceof Error ? error.message : String(error)}`;
        record.finishedAt = new Date().toISOString();
      }
    });

    return this.toPublic(record);
  }

  /**
   * Get job by ID.
   */
  getJob(jobId: string): CliExecJob | undefined {
    const record = this.jobs.get(jobId);
    if (!record) {
      return undefined;
    }
    return this.toPublic(record);
  }

  /**
   * List recent jobs.
   */
  listJobs(limit = 50): CliExecJob[] {
    const values = [...this.jobs.values()];
    values.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    return values.slice(0, Math.max(1, limit)).map((job) => this.toPublic(job));
  }

  /**
   * Clean up old completed jobs.
   */
  cleanup(maxAgeMs: number): number {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, job] of this.jobs.entries()) {
      if (job.status !== "running") {
        const finishedAt = job.finishedAt ? new Date(job.finishedAt).getTime() : 0;
        if (finishedAt > 0 && now - finishedAt > maxAgeMs) {
          this.jobs.delete(id);
          cleaned++;
        }
      }
    }
    return cleaned;
  }

  private async runCommand(record: CliExecJobInternal, timeoutMs: number): Promise<void> {
    const startedAt = Date.now();

    const child = spawn(record.command, record.args, {
      env: {
        ...process.env,
        ...record.env,
      },
      cwd: record.cwd,
      stdio: "pipe",
      shell: false, // Don't use shell for security
    });

    let finished = false;
    let sigkillTimer: ReturnType<typeof setTimeout> | undefined;

    const timeout = setTimeout(() => {
      if (!finished) {
        finished = true;
        record.status = "timed_out";
        record.finishedAt = new Date().toISOString();
        record.durationMs = Date.now() - startedAt;
        child.kill("SIGTERM");
        sigkillTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
      }
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      this.appendOutput(record, "stdout", chunk);
    });

    child.stderr.on("data", (chunk: string) => {
      this.appendOutput(record, "stderr", chunk);
    });

    return new Promise((resolve) => {
      child.on("error", (err) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        if (sigkillTimer) clearTimeout(sigkillTimer);
        record.status = "failed";
        record.exitCode = null;
        record.stderr += `\n[system] Failed to start: ${err.message}`;
        record.finishedAt = new Date().toISOString();
        record.durationMs = Date.now() - startedAt;
        resolve();
      });

      child.on("close", (exitCode) => {
        if (finished) {
          // Already handled by timeout — clean up SIGKILL timer
          if (sigkillTimer) clearTimeout(sigkillTimer);
          resolve();
          return;
        }
        finished = true;
        clearTimeout(timeout);
        if (sigkillTimer) clearTimeout(sigkillTimer);
        record.exitCode = exitCode;
        record.status = exitCode === 0 ? "completed" : "failed";
        record.finishedAt = new Date().toISOString();
        record.durationMs = Date.now() - startedAt;
        resolve();
      });
    });
  }

  private appendOutput(record: CliExecJobInternal, stream: "stdout" | "stderr", chunk: string): void {
    // Cap total output size to prevent OOM
    if (stream === "stdout") {
      if (record.stdout.length < record.maxOutputBytes) {
        record.stdout += chunk;
        record.stdoutLineCount += (chunk.match(/\n/g) || []).length;
      } else if (!record.stdout.endsWith("\n[...output truncated]\n")) {
        record.stdout += "\n[...output truncated]\n";
      }
    } else {
      if (record.stderr.length < record.maxOutputBytes) {
        record.stderr += chunk;
        record.stderrLineCount += (chunk.match(/\n/g) || []).length;
      } else if (!record.stderr.endsWith("\n[...output truncated]\n")) {
        record.stderr += "\n[...output truncated]\n";
      }
    }
  }

  private toPublic(record: CliExecJobInternal): CliExecJob {
    return {
      id: record.id,
      command: record.command,
      args: [...record.args],
      cwd: record.cwd,
      env: { ...record.env },
      status: record.status,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      exitCode: record.exitCode,
      stdout: record.stdout,
      stderr: record.stderr,
      durationMs: record.durationMs,
    };
  }
}

// Cleanup old jobs periodically. Use unref() so timer doesn't block shutdown.
const cleanupInterval = setInterval(() => {
  const manager = globalCliExecManager;
  if (manager) {
    const cleaned = manager.cleanup(3600000); // Clean jobs older than 1 hour
    if (cleaned > 0) {
      console.log(`[CliExecManager] Cleaned up ${cleaned} old jobs`);
    }
  }
}, 600000);
cleanupInterval.unref();

let globalCliExecManager: CliExecManager | null = null;

export function getCliExecManager(): CliExecManager {
  if (!globalCliExecManager) {
    globalCliExecManager = new CliExecManager();
  }
  return globalCliExecManager;
}
