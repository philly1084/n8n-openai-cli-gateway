export function getCodexExecutableCandidates(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const candidates: string[] = [];
  const override = env.CODEX_EXECUTABLE?.trim();
  if (override) {
    candidates.push(override);
  }

  if (platform === "win32") {
    candidates.push("codex.cmd");
  }

  candidates.push("codex");

  return [...new Set(candidates.filter(Boolean))];
}

export function getPreferredCodexExecutable(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  return getCodexExecutableCandidates(env, platform)[0] ?? "codex";
}

export function withRuntimeTemplateVars(
  vars: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  return {
    codex_executable: getPreferredCodexExecutable(env, platform),
    ...vars,
  };
}
