import test from "node:test";
import assert from "node:assert/strict";
import {
  getCodexExecutableCandidates,
  getPreferredCodexExecutable,
  withRuntimeTemplateVars,
} from "../utils/runtime-template-vars";

test("runtime template vars prefer CODEX_EXECUTABLE override", () => {
  assert.deepEqual(
    getCodexExecutableCandidates(
      {
        CODEX_EXECUTABLE: "C:\\tools\\codex.exe",
      } as NodeJS.ProcessEnv,
      "win32",
    ),
    ["C:\\tools\\codex.exe", "codex.cmd", "codex"],
  );
});

test("runtime template vars default to codex.cmd on Windows", () => {
  assert.equal(
    getPreferredCodexExecutable({} as NodeJS.ProcessEnv, "win32"),
    "codex.cmd",
  );
});

test("runtime template vars inject codex_executable without dropping existing vars", () => {
  assert.deepEqual(
    withRuntimeTemplateVars(
      {
        provider_id: "codex-cli",
      },
      {} as NodeJS.ProcessEnv,
      "linux",
    ),
    {
      provider_id: "codex-cli",
      codex_executable: "codex",
    },
  );
});
