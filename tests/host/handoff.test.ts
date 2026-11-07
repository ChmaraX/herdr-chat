// The host owns the TUI hand-off: it watches the TUI's terminal (hc get) or,
// with no terminal reported, the TUI's process, and resumes by itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { startHost, idle, sleep, ROOT, FAKE_PI } from "./harness.ts";
import type { Host } from "./harness.ts";
import { readLock } from "../../host/registry.ts";

const FAKE_HC = join(ROOT, "tests", "fake-hc", "hc.mjs");

async function handoffHost(name: string, graceMs = 60_000): Promise<{ h: Host; hc: string }> {
  const { realpathSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `pich-${name}-`)));
  const hc = join(dir, "hc");
  mkdirSync(hc, { recursive: true });
  const h = await startHost({
    name, dir, speed: 4,
    env: { HERDR_CHAT_HC: FAKE_HC, FAKE_HC_DIR: hc, HERDR_CHAT_HANDOFF_POLL_MS: "100", HERDR_CHAT_HANDOFF_GRACE_MS: String(graceMs) },
  });
  return { h, hc };
}

/** The terminal's `hc get` state; null = no such terminal. */
function setTerminal(hc: string, address: string, state: "live" | "finished" | null): void {
  const f = join(hc, `${address}.json`);
  if (state) writeFileSync(f, JSON.stringify({ state }));
  else rmSync(f, { force: true });
}

/** Runs the hand-off argv (fake-pi standing in for Pi's TUI, `env K=V` prefix honoured) and drives it over RPC. */
function runTui(h: Host, argv: string[], opts: { reportSession?: boolean } = {}): { proc: ChildProcess; send: (cmd: object) => void; settled: (n: number) => Promise<void> } {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), FAKE_PI_SPEED: "4" };
  delete env.HERDR_CHAT_HOST;
  let i = 0;
  if (argv[0] === "env") for (i = 1; argv[i]!.includes("="); i++) {
    const [k, ...v] = argv[i]!.split("=");
    if (opts.reportSession !== false) env[k!] = v.join("=");
  }
  const [prog, ...args] = argv.slice(i);
  assert.equal(prog, FAKE_PI);
  const proc = spawn(prog!, ["--mode", "rpc", ...args, "--session-dir", join(h.dir, "sessions")], { stdio: ["pipe", "pipe", "inherit"], env, cwd: h.cwd });
  let out = "";
  proc.stdout!.on("data", (d) => (out += d));
  return {
    proc,
    send: (cmd) => proc.stdin!.write(JSON.stringify(cmd) + "\n"),
    settled: async (n) => {
      const t0 = Date.now();
      while ((out.match(/"agent_settled"/g) ?? []).length < n) {
        if (Date.now() - t0 > 5000) throw new Error(`the TUI never settled ${n}x:\n${out}`);
        await sleep(20);
      }
    },
  };
}

const exited = (p: ChildProcess) => (p.exitCode !== null || p.signalCode !== null ? Promise.resolve() : new Promise<void>((r) => p.on("exit", () => r())));
const users = (h: Host) => h.items("user").map((i) => i.text);

test("hand-off: the TUI forks and exits; the host resumes by itself on the session the TUI ended on", async () => {
  const { h, hc } = await handoffHost("ho-exit");
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "before the hand-off" });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.kind === "assistant"), 5000);
    const original = c.state.sessionFile;

    const { argv } = await c.req("handoff");
    const report = join(h.stateDir, "handoff", "c-test.json");
    assert.deepEqual(argv, ["env", `HERDR_CHAT_HANDOFF=${report}`, FAKE_PI, "--session", original]);
    assert.equal(c.state.phase, "handoff");
    assert.equal(readLock(original), null, "lock released for the TUI");
    assert.deepEqual({ ...c.state.handoff, since: typeof c.state.handoff.since }, { argv, terminal: null, since: "number" });

    setTerminal(hc, "t-tui", "live");
    assert.deepEqual(await c.req("handoff_started", { terminal: "t-tui" }), {});
    await c.waitFor((x) => x.state.handoff?.terminal === "t-tui", 2000);

    const tui = runTui(h, argv);
    tui.send({ id: "1", type: "new_session" });
    tui.send({ id: "2", type: "prompt", message: "typed in the new session" });
    await tui.settled(1);
    tui.proc.stdin!.end();
    await exited(tui.proc);
    await sleep(600);
    assert.equal(c.state.phase, "handoff", "the terminal is still live (hc says so): keep waiting");

    setTerminal(hc, "t-tui", "finished");
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.text === "typed in the new session"), 10_000, "resumed by the host");
    const forked = c.state.sessionFile;
    assert.notEqual(forked, original);
    assert.deepEqual(users(h), ["typed in the new session"]);
    assert.equal(c.state.handoff, null);
    assert.equal(h.registry!.sessionFile, forked, "registry follows the TUI's session");
    assert.equal(readLock(forked)!.chat, "c-test");
    assert.ok(!existsSync(report), "the report is consumed");
    assert.ok(c.items.some((i) => i.kind === "notice" && /session the terminal UI ended on/.test(i.text)));
    h.artifact("handoff-tui-exits");
  } finally {
    await h.stop();
  }
});

test("hand-off: the TUI's terminal is killed; the host waits for the TUI process, then resumes the same session", async () => {
  const { h, hc } = await handoffHost("ho-killed");
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    const file = c.state.sessionFile;
    const { argv } = await c.req("handoff");
    setTerminal(hc, "t-k", "live");
    await c.req("handoff_started", { terminal: "t-k" });
    const tui = runTui(h, argv);
    tui.send({ id: "1", type: "prompt", message: "said in the TUI" });
    await tui.settled(1);

    setTerminal(hc, "t-k", null); // the terminal is gone (hc: not_found)…
    await sleep(600);
    assert.equal(c.state.phase, "handoff", "…but its Pi still runs (the pid it reported): don't open a second writer");
    tui.proc.kill("SIGKILL");
    await exited(tui.proc);
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.text === "said in the TUI"), 10_000, "resumed after the TUI died");
    assert.equal(c.state.sessionFile, file);
    h.artifact("handoff-terminal-killed");
  } finally {
    await h.stop();
  }
});

test("hand-off: the mod goes away before reporting a terminal; the host watches the TUI process and resumes", async () => {
  const { h } = await handoffHost("ho-nomod", 800);
  try {
    let c = h.client;
    await c.waitFor(idle, 10_000);
    const { argv } = await c.req("handoff");
    c.close(); // the mod is gone: nobody will report a terminal, nobody will send resume
    // Pi's TUI without the lock extension: no report file, found by its argv.
    const tui = runTui(h, argv, { reportSession: false });
    tui.send({ id: "1", type: "prompt", message: "nobody watching" });
    await tui.settled(1);
    await sleep(1500);
    c = await h.connect();
    assert.equal(c.state.phase, "handoff", "past the grace period, but `pi --session <file>` is running");
    c.close();
    tui.proc.stdin!.end();
    await exited(tui.proc);
    const t0 = Date.now();
    for (;;) {
      c = await h.connect();
      if (c.state.phase === "idle") break;
      c.close();
      if (Date.now() - t0 > 10_000) throw new Error(`never resumed: ${c.state.phase}`);
      await sleep(200);
    }
    assert.ok(c.items.some((i) => i.text === "nobody watching"));
    h.client = c;
    h.artifact("handoff-mod-gone");
  } finally {
    await h.stop();
  }
});

test("hand-off: a reloaded mod sees the hand-off, ops name the way out, resume works while the TUI runs", async () => {
  const { h, hc } = await handoffHost("ho-reload");
  try {
    const first = h.client;
    await first.waitFor(idle, 10_000);
    const { argv } = await first.req("handoff");
    setTerminal(hc, "t-r", "live");
    await first.req("handoff_started", { terminal: "t-r" });
    first.close(); // the mod reloads

    const c = await h.connect("mod");
    h.client = c;
    assert.equal(c.state.phase, "handoff");
    assert.equal(c.state.handoff.terminal, "t-r", "the snapshot carries the hand-off");
    assert.deepEqual((await c.req("handoff")).argv, argv, "asking again returns the same hand-off");
    await c.req("handoff_started", { terminal: "t-r" });
    await assert.rejects(c.req("send", { text: "hi" }), /open in the terminal UI \(terminal t-r\)\. Quit it there, or use resume/);
    await assert.rejects(c.req("models"), /use resume/);

    const tui = runTui(h, argv);
    await sleep(300);
    await c.req("resume"); // "Return to chat" while the TUI still runs
    await c.waitFor(idle, 10_000);
    assert.equal(c.state.handoff, null);
    assert.ok(c.items.some((i) => i.kind === "notice" && i.level === "warning" && /terminal UI is still running \(pid \d+\)/.test(i.text)));
    await assert.rejects(c.req("handoff_started", { terminal: "t-r" }), /not open in its terminal UI/);
    tui.proc.kill();
    h.artifact("handoff-mod-reloaded");
  } finally {
    await h.stop();
  }
});
