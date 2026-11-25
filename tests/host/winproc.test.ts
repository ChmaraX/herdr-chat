// What the host reads and builds for Windows, checked on any OS: npm's .cmd shims as npm writes them, command
// lines split as Windows does, and the hand-off's env wrapper (process.ts withEnv), which must run its program
// with the variable set and read back to the same program (processHolder, a resumed hand-off).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { npmShimTarget, splitCommandLine } from "../../host/winproc.ts";
import { unwrapEnv } from "../../host/process.ts";
import { ROOT } from "./harness.ts";

// npm's cmd-shim (npm 7+), byte for byte apart from the package: the IF EXIST line names node.exe first.
const SCRIPT_SHIM = [
  "@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0", "",
  'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ") ELSE (", '  SET "_prog=node"', "  SET PATHEXT=%PATHEXT:;.JS;=;%", ")", "",
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*', "",
].join("\r\n");
const EXE_SHIM = ["@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0",
  '"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.exe"   %*', ""].join("\r\n");

test("npm shims: the script or binary the shim runs, never the node.exe its IF EXIST names; a .cmd that isn't one: none", () => {
  assert.equal(npmShimTarget(SCRIPT_SHIM), "node_modules\\@anthropic-ai\\claude-code\\cli.js");
  assert.equal(npmShimTarget(EXE_SHIM), "node_modules\\@openai\\codex\\bin\\codex.exe");
  assert.equal(npmShimTarget('@echo off\r\n"%dp0%\\node.exe" %*\r\n'), null, "a shim that only runs node: no target");
  assert.equal(npmShimTarget("@echo off\r\nstart code %*\r\n"), null);
});

test("command lines: split as Windows' C runtime does (quoted spaces, \\\" and literal backslashes)", () => {
  assert.deepEqual(splitCommandLine('"C:\\Program Files\\nodejs\\node.exe" C:\\x\\cli.js --session "C:\\Users\\me\\a b.jsonl"'),
    ["C:\\Program Files\\nodejs\\node.exe", "C:\\x\\cli.js", "--session", "C:\\Users\\me\\a b.jsonl"]);
  assert.deepEqual(splitCommandLine('a\\\\"b c" d\\"e ""'), ["a\\b c", 'd"e', ""]);
  assert.deepEqual(splitCommandLine("  pi   --resume\tx  "), ["pi", "--resume", "x"]);
});

/** process.ts withEnv as the host builds it on `platform`. */
function withEnvOn(platform: string, env: Record<string, string>, command: string, args: string[]): string[] {
  const code = `const m = await import(${JSON.stringify(pathToFileURL(join(ROOT, "host", "process.ts")).href)});`
    + `process.stdout.write(JSON.stringify(m.withEnv(${JSON.stringify(env)}, ${JSON.stringify(command)}, ${JSON.stringify(args)})));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", env: { ...process.env, HERDR_CHAT_PLATFORM: platform } });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

for (const platform of ["win32", "linux"]) {
  test(`hand-off env wrapper (${platform}): the program runs with the variable set, and reads back to that program and env`, () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-chat-withenv-"));
    try {
      const prog = join(dir, "tui.mjs");
      writeFileSync(prog, "process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), handoff: process.env.HERDR_CHAT_HANDOFF }));\n");
      const report = join(dir, "handoff $x & y.json");
      const env = { HERDR_CHAT_HANDOFF: report };
      // The program as resolveCommand gives it on Windows: node and the script.
      const argv = withEnvOn(platform, env, process.execPath, [prog, "--session", "s=1.jsonl"]);
      if (platform === "win32") assert.equal(argv[0], process.execPath, "no env program on Windows: node sets it");
      else assert.deepEqual(argv.slice(0, 2), ["env", `HERDR_CHAT_HANDOFF=${report}`]);

      assert.deepEqual(unwrapEnv(argv), { env, argv: [process.execPath, prog, "--session", "s=1.jsonl"] });
      const r = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(JSON.parse(r.stdout), { argv: ["--session", "s=1.jsonl"], handoff: report });
      assert.deepEqual(withEnvOn(platform, {}, "pi", ["--session", "s"]), ["pi", "--session", "s"], "no env: the plain command");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
