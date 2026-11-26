// Continue as chat on Windows (host/providers/tui.ts tuiProcess): no process groups there, so an
// agent found under the terminal's shell has no group to watch (the mod asks Herdr's foreground
// instead), and npm's agents run as `node …\node_modules\<package>\cli.js`, found by the
// package's bins. tui-process.test.ts covers macOS and Linux (process groups, job control).
// On any OS: the host acts for Windows (HERDR_CHAT_PLATFORM), with the process table given.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Proc } from "../../host/providers/tui.ts";

process.env.HERDR_CHAT_PLATFORM = "win32";
const { tuiProcess } = await import("../../host/providers/tui.ts");
const NODE = "C:\\Program Files\\nodejs\\node.exe";
const PWSH = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
const proc = (pid: number, ppid: number, program: string, script = ""): Proc => ({ pid, ppid, pgid: 0, tpgid: 0, program, script });

test("windows: claude typed in pwsh, under the terminal's shell: that process, with no group", () => {
  const table = [proc(10, 1, PWSH), proc(11, 10, "C:\\Users\\me\\.local\\bin\\claude.exe"), proc(12, 11, NODE, "C:\\mcp\\server.js")];
  const found = tuiProcess({ terminal: { foreground: { pid: 10, argv: [PWSH] }, own: { pid: 10, argv: [PWSH] } }, command: "claude", label: "Claude Code", processes: () => table });
  assert.deepEqual(found, { pid: 11, group: null });
});

test("windows: an npm agent (node and its package's cli.js) is found by the package's bins, as the foreground or under the shell", () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-chat-npm-"));
  try {
    const pkg = join(dir, "node_modules", "@anthropic-ai", "claude-code");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-code", bin: { claude: "cli.js" } }));
    const cli = join(pkg, "cli.js");
    writeFileSync(cli, "");

    const fg = tuiProcess({ terminal: { foreground: { pid: 20, argv: [NODE, cli] }, own: { pid: 19, argv: [PWSH] } }, command: "claude", label: "Claude Code", processes: () => [] });
    assert.deepEqual(fg, { pid: 20, group: null }, "the foreground is the agent");

    const table = [proc(30, 1, PWSH), proc(31, 30, NODE, cli)];
    const under = tuiProcess({ terminal: { foreground: { pid: 30, argv: [PWSH] }, own: { pid: 30, argv: [PWSH] } }, command: "claude", label: "Claude Code", processes: () => table });
    assert.deepEqual(under, { pid: 31, group: null }, "the agent under the shell");

    assert.throws(() => tuiProcess({ terminal: { foreground: { pid: 30, argv: [PWSH] }, own: null }, command: "codex", label: "Codex", processes: () => table }), /no Codex process/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
