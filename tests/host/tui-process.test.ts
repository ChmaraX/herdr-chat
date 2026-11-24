// Continue as chat on a terminal whose own command started the agent (`fish -ic 'claude --resume …; exec fish -i'`):
// the terminal reports a shell as its foreground, and `herdr-chat-host tui-session --terminal <hc get json>` finds
// the agent under it, then `tui-busy` says whether that shell went on to run something once the agent is gone.
// Real process trees, each under its own shell (a process group of its own, as a terminal's command without job
// control). How it can go wrong, and the case that catches it:
// - a non-interpreter naming the agent in its arguments (`less pi.js`) taken for it: "viewer";
// - a script path with a space (`My Tools/pi`) missed: "path with a space";
// - two agents in the group, one picked and signalled: "two";
// - a background job (`set -m`) taken for the TUI on screen: "job";
// - the agent as Herdr's foreground (any program whose argv[0] or argv[1] names it) lost to the walk: "foreground";
// - the foreground gone: "gone";
// - the shell's next command (`pi; sleep`) or a process already in the group (`sleep & pi`) not seen: "busy";
// - the agent's own leftovers (an MCP server outliving it) or the interactive shell's helper (its own job) seen
//   as the shell running something: "idle".
// Every case's answer and the process table under its shell go to tests/artifacts/host/tui-process.log.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ARTIFACTS, HOST_ENTRY, HOST_NODE } from "./harness.ts";

const d = realpathSync(mkdtempSync(join(tmpdir(), "herdr-chat-tuiproc-")));
const session = join(d, "pi.jsonl");
writeFileSync(session, JSON.stringify({ type: "session", id: "s" }) + "\n");
// Each fake records "<pid> <tag>" in $TUC_PIDS once it runs (a titled one after it has its title).
const record = 'require("node:fs").appendFileSync(process.env.TUC_PIDS, `${process.pid} ${process.env.TUC_TAG ?? "-"}\\n`);';
// A Pi as npm installs it: node with the title "pi".
const titled = join(d, "titled.cjs");
writeFileSync(titled, `process.title = "pi"; ${record} setInterval(() => {}, 1000);\n`);
// The same, leaving a child behind when it quits (an MCP server outliving it).
const leaver = join(d, "leaver.cjs");
writeFileSync(leaver, `process.title = "pi"; const k = require("node:child_process").spawn("/bin/sleep", ["600"], { stdio: "ignore" }); require("node:fs").appendFileSync(process.env.TUC_PIDS, \`\${k.pid} leftover\\n\`); ${record} setInterval(() => {}, 1000);\n`);
// No title: found by its program's name or its script's.
const idle = join(d, "pi.cjs");
writeFileSync(idle, `${record} setInterval(() => {}, 1000);\n`);
mkdirSync(join(d, "My Tools"));
symlinkSync(HOST_NODE, join(d, "My Tools", "pi"));
symlinkSync(HOST_NODE, join(d, "less"));

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const node = q(HOST_NODE);
const roots: ChildProcess[] = [];
const pidFiles: string[] = [];
/** Every shell's group, and each recorded process's group: a `set -m` job, or a helper, has one of its own. */
function cleanup() {
  for (const r of roots) try { process.kill(-r.pid!, "SIGKILL"); } catch {}
  for (const f of pidFiles) for (const p of recorded(f)) try { process.kill(-p, "SIGKILL"); } catch { try { process.kill(p, "SIGKILL"); } catch {} }
}
const LOG = join(ARTIFACTS, "tui-process.log");
mkdirSync(ARTIFACTS, { recursive: true });
writeFileSync(LOG, "");
let n = 0;

/** A terminal's command: `sh -c <script>` in a process group of its own; resolves with its pid once `count` fakes have recorded themselves. */
async function terminal(script: string, count: number): Promise<{ sh: number; pids: string }> {
  const pids = join(d, `pids-${++n}`);
  writeFileSync(pids, "");
  pidFiles.push(pids);
  const sh = spawn("/bin/sh", ["-c", script], { detached: true, stdio: "ignore", env: { ...process.env, TUC_PIDS: pids } });
  roots.push(sh);
  for (let i = 0; i < 200 && readFileSync(pids, "utf8").split("\n").filter(Boolean).length < count; i++) await new Promise((r) => setTimeout(r, 50));
  return { sh: sh.pid!, pids };
}
const recorded = (pids: string, tag?: string) =>
  readFileSync(pids, "utf8").split("\n").filter(Boolean).map((l) => l.split(" ")).filter(([, t]) => !tag || t === tag).map(([p]) => Number(p));

function host(name: string, args: string[]) {
  const r = spawnSync(HOST_NODE, [HOST_ENTRY, ...args], { encoding: "utf8" });
  appendFileSync(LOG, `## ${name}\n$ herdr-chat-host ${args.join(" ")}\nexit ${r.status}\n${r.stdout}${r.stderr}\n`);
  return r.status === 0 ? { ok: JSON.parse(r.stdout) } : { error: r.stderr.trim() };
}
/** tui-session for a terminal as Herdr reports it: its own program and foreground, each {pid, argv}. */
function ask(name: string, sh: number, script: string, foreground?: { pid: number; argv: string[] }) {
  const own = { pid: sh, argv: ["/bin/sh", "-c", script] };
  const table = spawnSync("ps", ["-A", "-o", "pid,ppid,pgid,tpgid,comm,args"], { encoding: "utf8" }).stdout.split("\n");
  appendFileSync(LOG, `## ${name}: the table under ${sh} (and its group)\n${table.filter((l, i) => i === 0 || new RegExp(`^\\s*\\d+\\s+\\d+\\s+${sh}\\s`).test(l)).join("\n")}\n`);
  return host(name, ["tui-session", "--provider", "pi", "--terminal", JSON.stringify({ ...own, foreground: foreground ?? own }), "--cwd", d, "--label", session]);
}
const busy = (name: string, group: unknown, within = 0) => host(`${name}: tui-busy`, ["tui-busy", "--group", JSON.stringify(group), "--within", String(within)]);
const gone = async (pid: number) => {
  for (let i = 0; i < 100; i++) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`pid ${pid} didn't quit`);
};
const comm = (pid: number) => spawnSync("ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();

test("tui-session --terminal: the agent its terminal's command started, in the terminal's foreground group only", async (t) => {
  t.after(cleanup);

  // viewer: a Pi with its title, two levels down (sh → sh → pi), and a viewer naming a pi.cjs beside it.
  let s = `TUC_TAG=viewer ${q(join(d, "less"))} ${q(idle)} & TUC_TAG=pi /bin/sh -c "${node} ${titled}; true"; wait`;
  let fg = await terminal(s, 2);
  let r = ask("viewer", fg.sh, s);
  assert.ok(r.ok, r.error);
  assert.notEqual(r.ok.pid, recorded(fg.pids, "viewer")[0], "a non-interpreter naming pi.cjs isn't Pi");
  assert.equal(r.ok.pid, recorded(fg.pids, "pi")[0]);
  assert.equal(comm(r.ok.pid), "pi");
  assert.equal(r.ok.session, session);
  assert.equal(r.ok.group.shell, fg.sh);

  // path with a space: run by its path, as node's script: one, so it's found.
  s = `${q(join(d, "My Tools", "pi"))} ${q(idle)} & wait`;
  fg = await terminal(s, 1);
  assert.equal(ask("path with a space", fg.sh, s).ok?.pid, recorded(fg.pids)[0]);

  // two: two Pis under one command: refused, and the message says why.
  s = `${node} ${q(idle)} & ${node} ${q(titled)} & wait`;
  fg = await terminal(s, 2);
  assert.match(ask("two", fg.sh, s).error ?? "", /2 Pi processes under the terminal's command \(pids \d+, \d+\): not sure which is the TUI, so none is stopped/);

  // job: a Pi in a job of its own (job control: a background or stopped job) isn't the TUI on screen.
  s = `set -m; ${node} ${q(titled)} & wait`;
  fg = await terminal(s, 1);
  assert.match(ask("job", fg.sh, s).error ?? "", /no Pi process in the terminal \(its foreground is \/bin\/sh, and none runs under it\)/);

  // foreground: Herdr's foreground runs pi as its argv[1] (a shell script `pi` run by sh, a shim), whatever the
  // program: that's the TUI, as before the walk, and there's no group to watch.
  const shim = join(d, "bin", "pi");
  mkdirSync(join(d, "bin"));
  writeFileSync(shim, `#!/bin/sh\n${node} ${q(idle)}\n`);
  chmodSync(shim, 0o755);
  s = `/bin/sh ${q(shim)} & wait`;
  fg = await terminal(s, 1);
  const shimPid = Number(spawnSync("pgrep", ["-P", String(fg.sh)], { encoding: "utf8" }).stdout.trim());
  r = ask("foreground", fg.sh, s, { pid: shimPid, argv: ["/bin/sh", shim] });
  assert.deepEqual([r.ok?.pid, r.ok?.group], [shimPid, null], r.error);

  // gone: the foreground Herdr reported has exited.
  r = ask("gone", 999_999, "true", { pid: 999_999, argv: ["/bin/zsh"] });
  assert.match(r.error ?? "", /no Pi process in the terminal \(its foreground, 999999, is gone\)/);
});

test("tui-busy: once the agent is gone, what its terminal's command went on to run, not the shell's helpers or the agent's leftovers", async (t) => {
  t.after(cleanup);
  const stop = async (name: string, script: string, count = 1) => {
    const fg = await terminal(script, count);
    const r = ask(name, fg.sh, script);
    assert.ok(r.ok?.group, r.error ?? "no group");
    assert.equal(r.ok.group.shell, fg.sh);
    process.kill(r.ok.pid, "SIGTERM");
    await gone(r.ok.pid);
    return { ...fg, group: r.ok.group };
  };

  // busy: the command goes on after Pi (`pi; sleep`): the shell's new child.
  let s = `TUC_TAG=pi ${node} ${q(titled)}; /bin/sleep 30; true`;
  let fg = await stop("busy: next command", s);
  assert.match(busy("busy: next command", fg.group, 1000).ok?.running ?? "", /sleep$/);

  // busy: a process that was in the group already, not the agent's, and no longer the shell's child (a subshell
  // left it running: `(sleep &); pi`).
  s = `(/bin/sleep 30 &); TUC_TAG=pi ${node} ${q(titled)}; wait`;
  fg = await stop("busy: already there", s);
  assert.match(busy("busy: already there", fg.group).ok?.running ?? "", /sleep$/);

  // idle: the shell, after `exec`, at its prompt with a helper in a job of its own (as `zsh -i` starts its rc's
  // `… &`); and a Pi that left a child behind (reparented, no longer the shell's).
  s = `${node} ${q(leaver)}; exec /bin/sh -c 'set -m; /bin/sleep 600 & echo "$! helper" >> "$TUC_PIDS"; echo > "$TUC_PIDS.helper"; wait'`;
  fg = await stop("idle", s, 2);
  for (let i = 0; i < 100 && !existsSync(`${fg.pids}.helper`); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(existsSync(`${fg.pids}.helper`), "the shell started its helper");
  assert.deepEqual(busy("idle", fg.group).ok, { running: null });

  // A group that isn't one: refused before it reads anything.
  assert.match(busy("bad group", { id: -1, shell: 1, before: [] }).error ?? "", /tui-busy needs --group/);
});
