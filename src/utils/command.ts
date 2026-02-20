import { spawn } from "node:child_process";
import type { CommandSpec } from "../types";
import { applyTemplate, applyTemplateRecord } from "./template";

export interface ResolvedCommand {
  executable: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs: number;
}

export interface CommandOutput {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

export function resolveCommand(
  spec: CommandSpec,
  vars: Record<string, string>,
): ResolvedCommand {
  return {
    executable: applyTemplate(spec.executable, vars),
    args: spec.args.map((arg) => applyTemplate(arg, vars)),
    env: applyTemplateRecord(spec.env, vars),
    cwd: spec.cwd ? applyTemplate(spec.cwd, vars) : undefined,
    timeoutMs: spec.timeoutMs,
  };
}

export async function runCommand(
  command: ResolvedCommand,
  stdinData?: string,
): Promise<CommandOutput> {
  return await new Promise<CommandOutput>((resolve, reject) => {
    const child = spawn(command.executable, command.args, {
      env: {
        ...process.env,
        ...command.env,
      },
      cwd: command.cwd,
      stdio: "pipe",
    });

    let stdout = "";
    let stderr = "";
    let finished = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000);
    }, command.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (err) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (exitCode, signal) => {
      if (finished) {
        return;
      }

      finished = true;
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode,
        signal,
        timedOut,
      });
    });

    if (stdinData !== undefined) {
      child.stdin.write(stdinData);
    }
    child.stdin.end();
  });
}
