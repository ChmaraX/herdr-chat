// Continue as chat on a terminal whose own command started the agent (`fish -ic 'claude --resume …; exec fish -i'`):
// the terminal reports a shell as its foreground, and `herdr-chat-host tui-session --foreground <pid>` finds the
// agent under it. Real process trees, each under its own shell (a process group of its own, as a terminal's
// command without job control): only an agent in that group counts, a background job (`set -m`) doesn't, two are
// refused, and a program that merely names the agent in its arguments (`less pi.js`) isn't one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HOST_ENTRY, HOST_NODE } from "./harness.ts";

const d = realpathSync(mkdtempSync(join(tmpdir(), "herdr-chat-tuiproc-")));
const session = join(d, "pi.jsonl");
writeFileSync(session, JSON.stringify({ type: "session", id: "s" }) + "\n");
// A Pi as npm installs it: node with the title "pi". Another run by its path, "My Tools/pi" (a link to node).
const titled = join(d, "titled.mjs");
writeFileSync(titled, 'process.title = "pi"; setInterval(() => {}, 1000);\n');
const idle = join(d, "pi.mjs");
writeFileSync(idle, "setInterval(() => {}, 1000);\n");
mkdirSync(join(d, "My Tools"));
symlinkSync(HOST_NODE, join(d, "My Tools", "pi"));
symlinkSync(HOST_NODE, join(d, "less"));

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const roots: ChildProcess[] = [];

/** A terminal's command: `sh -c <script>` in a process group of its own; resolves once `count` processes are under it. */
async function terminal(script: string, count: number): Promise<number> {
  const sh = spawn("/bin/sh", ["-c", script], { detached: true, stdio: "ignore" });
  roots.push(sh);
  for (let i = 0; i < 100; i++) {
    const kids = spawnSync("pgrep", ["-P", String(sh.pid)], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
    if (kids.length >= count) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  await new Promise((r) => setTimeout(r, 300)); // process.title takes a moment
  return sh.pid!;
}

function ask(foreground: number) {
  const r = spawnSync(HOST_NODE, [HOST_ENTRY, "tui-session", "--provider", "pi", "--foreground", String(foreground), "--terminal-pid", String(foreground), "--cwd", d, "--label", session], { encoding: "utf8" });
  return r.status === 0 ? { ok: JSON.parse(r.stdout) } : { error: r.stderr.trim() };
}
const childOf = (pid: number) => spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).stdout.split("\n").filter(Boolean).map(Number);

test("tui-session --foreground: the agent its terminal's command started, in the terminal's foreground group only", async (t) => {
  t.after(() => { for (const r of roots) try { process.kill(-r.pid!, "SIGKILL"); } catch {} });
  const node = q(HOST_NODE);

  // A Pi with its title, two levels down (sh → sh → pi), and a viewer naming a pi.js beside it.
  let fg = await terminal(`${q(join(d, "less"))} ${q(idle)} & /bin/sh -c "${node} ${titled}; true"; wait`, 2);
  let r = ask(fg);
  const viewer = childOf(fg).find((p) => spawnSync("ps", ["-o", "comm=", "-p", String(p)], { encoding: "utf8" }).stdout.trim().endsWith("/less"))!;
  assert.ok(r.ok, r.error);
  assert.notEqual(r.ok.pid, viewer, "a non-interpreter naming pi.js isn't Pi");
  assert.match(spawnSync("ps", ["-o", "args=", "-p", String(r.ok.pid)], { encoding: "utf8" }).stdout, /^pi/);
  assert.equal(r.ok.session, session);

  // Run by its path, spaces and all, as node's script: one, so it's found.
  fg = await terminal(`${q(join(d, "My Tools", "pi"))} ${q(idle)} & wait`, 1);
  assert.equal(ask(fg).ok?.pid, childOf(fg)[0]);

  // Two Pis under one command: refused, and the message says why.
  fg = await terminal(`${node} ${q(idle)} & ${node} ${q(titled)} & wait`, 2);
  r = ask(fg);
  assert.match(r.error ?? "", /2 Pi processes under the terminal's command \(pids \d+, \d+\): not sure which is the TUI, so none is stopped/);

  // A Pi in a job of its own (job control: a background or stopped job) isn't the TUI on screen.
  fg = await terminal(`set -m; ${node} ${q(titled)} & wait`, 1);
  assert.match(ask(fg).error ?? "", /no Pi process in the terminal \(its foreground is \/bin\/sh, and none runs under it\)/);
});
