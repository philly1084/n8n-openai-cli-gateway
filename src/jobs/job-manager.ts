import { spawn } from "node:child_process";
import { makeId } from "../utils/ids";
import { resolveCommand } from "../utils/command";
import type { CommandSpec, LoginJobSummary } from "../types";

interface LoginJobRecord extends LoginJobSummary {
  maxLogLines: number;
}

const URL_REGEX = /https?:\/\/[^\s]+/gi;

export class JobManager {
  private readonly jobs = new Map<string, LoginJobRecord>();

  constructor(private readonly maxLogLines: number) {}

  async startCommand(
    providerId: string,
    commandSpec: CommandSpec,
    vars: Record<string, string>,
  ): Promise<LoginJobSummary> {
    const id = makeId("job");
    const resolved = resolveCommand(commandSpec, vars);

    const record: LoginJobRecord = {
      id,
      providerId,
      command: resolved.executable,
      args: resolved.args,
      status: "running",
      startedAt: new Date().toISOString(),
      logs: [],
      urls: [],
      maxLogLines: this.maxLogLines,
    };

    this.jobs.set(id, record);

    const child = spawn(resolved.executable, resolved.args, {
      env: {
        ...process.env,
        ...resolved.env,
      },
      cwd: resolved.cwd,
      stdio: "pipe",
    });

    let finished = false;

    const timeout = setTimeout(() => {
      this.pushLog(record, "[system] command timed out");
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000);
    }, resolved.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      this.pushChunk(record, "stdout", chunk);
    });

    child.stderr.on("data", (chunk: string) => {
      this.pushChunk(record, "stderr", chunk);
    });

    child.on("error", (err) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timeout);
      record.status = "failed";
      record.finishedAt = new Date().toISOString();
      record.exitCode = null;
      this.pushLog(record, `[system] failed to start process: ${err.message}`);
    });

    child.on("close", (exitCode) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timeout);
      record.finishedAt = new Date().toISOString();
      record.exitCode = exitCode;
      record.status = exitCode === 0 ? "completed" : "failed";
      this.pushLog(record, `[system] process exited with code ${exitCode ?? "null"}`);
    });

    return this.toPublic(record);
  }

  getJob(jobId: string): LoginJobSummary | undefined {
    const record = this.jobs.get(jobId);
    if (!record) {
      return undefined;
    }
    return this.toPublic(record);
  }

  listJobs(limit = 50): LoginJobSummary[] {
    const values = [...this.jobs.values()];
    values.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    return values.slice(0, Math.max(1, limit)).map((job) => this.toPublic(job));
  }

  private toPublic(record: LoginJobRecord): LoginJobSummary {
    return {
      id: record.id,
      providerId: record.providerId,
      command: record.command,
      args: [...record.args],
      status: record.status,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      exitCode: record.exitCode,
      urls: [...record.urls],
      logs: [...record.logs],
    };
  }

  private pushChunk(record: LoginJobRecord, stream: "stdout" | "stderr", chunk: string): void {
    for (const rawLine of chunk.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }
      this.pushLog(record, `[${stream}] ${line}`);
    }
  }

  private pushLog(record: LoginJobRecord, line: string): void {
    record.logs.push(line);
    if (record.logs.length > record.maxLogLines) {
      record.logs.splice(0, record.logs.length - record.maxLogLines);
    }

    const urls = line.match(URL_REGEX) ?? [];
    for (const url of urls) {
      if (!record.urls.includes(url)) {
        record.urls.push(url);
      }
    }
  }
}
