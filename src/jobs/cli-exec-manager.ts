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
  maxOutputLines: number;
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
    const maxOutputLines = options.maxOutputLines ?? MAX_OUTPUT_LINES;

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
      maxOutputLines,
    };

    this.jobs.set(id, record);

    // Start execution in background
    this.runCommand(record, timeoutMs).catch((error) => {
      record.status = "failed";
      record.stderr += `\n[system] Execution error: ${error.message}`;
      record.finishedAt = new Date().toISOString();
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

    const timeout = setTimeout(() => {
      if (!finished) {
        finished = true;
        record.status = "timed_out";
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5000);
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
        record.status = "failed";
        record.exitCode = null;
        record.stderr += `\n[system] Failed to start: ${err.message}`;
        record.finishedAt = new Date().toISOString();
        record.durationMs = Date.now() - startedAt;
        resolve();
      });

      child.on("close", (exitCode) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        record.exitCode = exitCode;
        record.status = exitCode === 0 ? "completed" : "failed";
        record.finishedAt = new Date().toISOString();
        record.durationMs = Date.now() - startedAt;
        resolve();
      });
    });
  }

  private appendOutput(record: CliExecJobInternal, stream: "stdout" | "stderr", chunk: string): void {
    const lines = chunk.split("\n");
    for (const line of lines) {
      if (stream === "stdout") {
        record.stdout += line + "\n";
      } else {
        record.stderr += line + "\n";
      }
    }

    // Trim output if too long
    const stdoutLines = record.stdout.split("\n");
    if (stdoutLines.length > record.maxOutputLines) {
      record.stdout = stdoutLines.slice(-record.maxOutputLines).join("\n");
      record.stdout = `[...trimmed]\n` + record.stdout;
    }

    const stderrLines = record.stderr.split("\n");
    if (stderrLines.length > record.maxOutputLines) {
      record.stderr = stderrLines.slice(-record.maxOutputLines).join("\n");
      record.stderr = `[...trimmed]\n` + record.stderr;
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

// Cleanup old jobs every 10 minutes
setInterval(() => {
  const manager = globalCliExecManager;
  if (manager) {
    const cleaned = manager.cleanup(3600000); // Clean jobs older than 1 hour
    if (cleaned > 0) {
      console.log(`[CliExecManager] Cleaned up ${cleaned} old jobs`);
    }
  }
}, 600000);

let globalCliExecManager: CliExecManager | null = null;

export function getCliExecManager(): CliExecManager {
  if (!globalCliExecManager) {
    globalCliExecManager = new CliExecManager();
  }
  return globalCliExecManager;
}
