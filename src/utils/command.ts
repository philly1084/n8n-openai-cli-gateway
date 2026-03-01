import { spawn } from "node:child_process";
import type { CommandSpec } from "../types";
import { applyTemplate, applyTemplateRecord, checkShellSafety, type TemplateOptions } from "./template.js";

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

export interface ResolveCommandOptions extends TemplateOptions {
  /** Optional logger for shell safety warnings */
  logger?: {
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

export function resolveCommand(
  spec: CommandSpec,
  vars: Record<string, string>,
  options: ResolveCommandOptions = {},
): ResolvedCommand {
  const { logger, ...templateOptions } = options;

  // Check for shell safety issues and log warnings
  if (logger) {
    const warnings = checkShellSafety(vars);
    for (const warning of warnings) {
      logger.warn(warning.warning, {
        variable: warning.key,
        valuePreview: warning.value,
      });
    }
  }

  return {
    executable: applyTemplate(spec.executable, vars, templateOptions),
    args: spec.args.map((arg) => applyTemplate(arg, vars, templateOptions)),
    env: applyTemplateRecord(spec.env, vars, templateOptions),
    cwd: spec.cwd ? applyTemplate(spec.cwd, vars, templateOptions) : undefined,
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
