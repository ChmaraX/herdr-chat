// The sub-agent launcher (bin/pi-chat-subagent → pi-chat-host run), started the
// way herdr-core starts a template's command for a parent's `hc run`: in the
// terminal's folder, with HC_TERMINAL_ID and the core's environment (no login
// PATH: the agent comes from the chat mod's config.json). The parent's side is
// what core does with the terminal: wait for the first OSC 7501 status, paste
// "<body>\n\n<task>" + Enter, `hc wait` (status leaves working), `hc read` (the
// transcript), `hc send` (a paste with an <hc from> envelope), `hc kill` (SIGHUP).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ChatClient } from "../../host/client.ts";
import { readRegistry } from "../../host/registry.ts";
import { FAKE_PI, ROOT, SCENARIOS, plain, sleep } from "./harness.ts";

const LAUNCHER = join(ROOT, "bin", "pi-chat-subagent");
const FAKE_HC = join(ROOT, "tests", "fake-hc", "hc.mjs");
// Each wait's budget. A host start or a turn takes ~0.3 s alone, but the
// suite runs four files at once, and on a busy machine a 10 s budget failed
// now and then. A real hang still fails, and prints the transcript.
const LOAD_MS = 45_000;
const statuses = (s: string) => [...s.matchAll(/\u001b\]7501;state=(\w+):app=(\w+)/g)].map((m) => `${m[1]}:${m[2]}`);

function launch(name: string, opts: { args?: string[]; env?: Record<string, string>; dir?: string } = {}) {
  const dir = opts.dir ?? realpathSync(mkdtempSync(join(tmpdir(), `pi-chat-sub-${name}-`)));
  const app = join(dir, "app");
  const cwd = join(dir, "repo");
  const hcDir = join(dir, "hc");
  const piLog = join(dir, `fake-pi-${Date.now()}.log`);
  mkdirSync(join(app, "mods", "chat"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  mkdirSync(hcDir, { recursive: true });
  // What install.sh writes (plus test plumbing in "env", as the e2e config has).
  writeFileSync(join(app, "mods", "chat", "config.json"), JSON.stringify({
    host: join(ROOT, "bin", "pi-chat-host"), node: process.execPath, hc: FAKE_HC, pi: FAKE_PI,
    piArgs: ["--session-dir", join(dir, "sessions")],
    env: { FAKE_PI_SCENARIO: join(SCENARIOS, "abort.json"), FAKE_PI_SPEED: "2", FAKE_PI_LOG: piLog, FAKE_HC_DIR: hcDir },
  }));
  // A core terminal's environment: no HERDR_*/HC_* of the runner, the app home, its own address.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("HC_") && !k.startsWith("HERDR_") && !k.startsWith("PI_CHAT_")) env[k] = v;
  Object.assign(env, { HERDR_APP_HOME: app, HC_TERMINAL_ID: "t99" }, opts.env ?? {});
  const proc = spawn(LAUNCHER, opts.args ?? [], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  let screen = "";
  proc.stdout!.on("data", (d) => (screen += d.toString("utf8")));
  proc.stderr!.on("data", (d) => (screen += d.toString("utf8")));
  let exitCode: number | null | undefined;
  const exited = new Promise<number | null>((r) => proc.on("exit", (c) => { exitCode = c; r(c); }));
  const stateDir = join(app, "data", "pi-chat");
  const h = {
    dir, app, cwd, hcDir, piLog, stateDir, proc, exited,
    get screen() { return screen; },
    get transcript() { return plain(screen); },
    get statuses() { return statuses(screen); },
    chat(): string | null {
      const files = existsSync(join(stateDir, "chats")) ? readdirSync(join(stateDir, "chats")).filter((f) => f.endsWith(".json")) : [];
      for (const f of files) if (readRegistry(stateDir, f.slice(0, -5))?.pid === proc.pid || plain(screen).includes(`chat ${f.slice(0, -5)} `)) return f.slice(0, -5);
      return null;
    },
    async waitStatus(re: RegExp, ms = LOAD_MS, what = String(re)) {
      const t0 = Date.now();
      while (!re.test(statuses(screen).at(-1) ?? "")) {
        if (exitCode !== undefined) throw new Error(`exited ${exitCode} before ${what}:\n${plain(screen)}`);
        if (Date.now() - t0 > ms) throw new Error(`status ${statuses(screen).at(-1)} never matched ${what}\n${plain(screen)}`);
        await sleep(15);
      }
    },
    labelCalls(): { terminal: string; labels: string[] }[] {
      const f = join(hcDir, "label.log");
      return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    },
    stop() { if (exitCode === undefined) proc.kill("SIGKILL"); },
  };
  return h;
}

test("a template launch of pi-chat-subagent: own labels, the app's state dir, config's agent and args first; the parent's paste, wait, read, send and kill work", async () => {
  const h = launch("template", { args: ["--", "--model", "fake/sub-model"] });
  try {
    // Core waits for the first status, then pastes the template's body and the task, and presses Enter.
    await h.waitStatus(/^idle:pi$/, LOAD_MS, "first status");
    const body = "You run as a sub-agent. Report back with hc send when done.";
    const task = "quick: review src/x.rs only.";
    h.proc.stdin!.write(`\u001b[200~${body}\n\n${task}\u001b[201~\r`);
    await h.waitStatus(/^working/, LOAD_MS, "working after the pasted task");
    await h.waitStatus(/^(done|idle)/, LOAD_MS, "the turn ended (hc wait returns)");

    const chat = h.chat();
    assert.ok(chat && /^c-[0-9a-f]{8}$/.test(chat), `a fresh c-<hex> chat id, in the app's state dir (${chat})`);
    const reg = readRegistry(h.stateDir, chat)!;
    assert.equal(reg.terminal, "t99");
    assert.equal(reg.cwd, h.cwd, "the terminal's folder ($PWD) is the chat's");
    assert.equal(reg.provider, "pi");

    // Its own terminal labeled once: the mod finds it by pi-chat.chat, sweepOrphans skips role=subagent.
    assert.deepEqual(h.labelCalls(), [{ terminal: "t99", labels: [`pi-chat.chat=${chat}`, "pi-chat.role=subagent", "pi-chat.provider=pi"] }]);

    // The agent from config.json, its config args first, then the caller's.
    const start = JSON.parse(readFileSync(h.piLog, "utf8").split("\n")[0]!);
    const argv: string[] = start.argv;
    const at = (x: string) => argv.indexOf(x);
    assert.ok(at("--session-dir") >= 0 && at("--model") > at("--session-dir"), `argv ${argv.join(" ")}`);
    assert.equal(argv[at("--model") + 1], "fake/sub-model");
    assert.equal(start.env.HC_TERMINAL_ID, "t99");

    // hc read: the header, the hint, the prompt and the answer.
    const lines = h.transcript.split("\n");
    assert.match(lines[0]!, new RegExp(`^pi-chat-host · chat ${chat} · `));
    assert.match(lines[1]!, /right-click → Open as chat/);
    assert.match(h.transcript, /^> You run as a sub-agent\./m);
    assert.match(h.transcript, /^Quick answer\.$/m);

    // A chat view (the mod in the peek dialog) sees the same turn.
    const c = await ChatClient.connect(reg.port!, reg.token, "mod");
    try {
      await c.waitFor((x) => x.state.phase === "idle" && x.items.some((i) => i.kind === "assistant" && !i.streaming), LOAD_MS, "idle with an answer");
      const user = c.items.find((i) => i.kind === "user")!;
      assert.equal(user.text, `${body}\n\n${task}`);
      assert.equal(user.source, "external");
      // hc send from the parent: an envelope, a message "from t59 lead".
      h.proc.stdin!.write(`\u001b[200~<hc from="t59 lead">quick: recheck the error path</hc>\u001b[201~\r`);
      await c.waitFor((x) => x.items.filter((i) => i.kind === "assistant" && !i.streaming).length === 2 && x.state.phase === "idle", LOAD_MS, "the second answer");
      assert.equal(c.items.filter((i) => i.kind === "user")[1]!.from, "t59 lead");
    } finally {
      c.close();
    }
    assert.deepEqual(h.statuses.filter((s, i, a) => s !== a[i - 1]).slice(0, 3), ["idle:pi", "working:pi", "done:pi"]);

    // A second launch from the same parent is another chat (a reused id would resume this one's session).
    const h2 = launch("second", { dir: h.dir });
    try {
      await h2.waitStatus(/^idle:pi$/, LOAD_MS, "second first status");
      const chat2 = /chat (c-[0-9a-f]{8}) /.exec(h2.transcript)?.[1];
      assert.ok(chat2 && chat2 !== chat, `a fresh id: ${chat2} vs ${chat}`);
    } finally {
      h2.proc.kill("SIGHUP");
      await h2.exited;
    }

    // hc kill / the parent's end: SIGHUP, exit 0, the registry cleared.
    h.proc.kill("SIGHUP");
    assert.equal(await h.exited, 0);
    const after = readRegistry(h.stateDir, chat)!;
    assert.equal(after.pid, null);
    assert.equal(after.port, null);
  } finally {
    h.stop();
  }
});

test("pi-chat-subagent: a failed self-label is a warning on the transcript, the host still serves; --chat is refused", async () => {
  const h = launch("nolabel", { env: { FAKE_HC_LABEL_FAIL: "1" } });
  try {
    await h.waitStatus(/^idle:pi$/, LOAD_MS, "first status");
    await sleep(100);
    assert.match(h.transcript, /^! hc label t99: /m);
    h.proc.stdin!.write("\u001b[200~quick: hello\u001b[201~\r");
    const t0 = Date.now();
    while (!/^Quick answer\.$/m.test(h.transcript)) {
      assert.ok(Date.now() - t0 < LOAD_MS, `no answer:\n${h.transcript}`);
      await sleep(20);
    }
    assert.ok(h.statuses.includes("working:pi"));
  } finally {
    h.proc.kill("SIGHUP");
    await h.exited;
  }
  const bad = launch("chatflag", { args: ["--chat", "c-12345678"] });
  assert.equal(await bad.exited, 2);
  assert.match(bad.transcript, /makes its own chat id/);
});

// Continue as chat (mod new-chat's continueAsChat): a Pi TUI sub-agent's session, handed to the launcher.
test("pi-chat-subagent --session <file>: the host resumes that session (its history in the chat), and the next prompt goes on in the same file", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-chat-sub-resume-")));
  const session = join(dir, "tui-session.jsonl");
  const msg = (role: string, text: string, i: number) => JSON.stringify({ type: "message", id: `m${i}`, parentId: i ? `m${i - 1}` : null, timestamp: new Date().toISOString(),
    message: role === "user" ? { role, content: [{ type: "text", text }], timestamp: Date.now() }
      : { role, content: [{ type: "text", text }], api: "fake", provider: "fake", model: "fake", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() } });
  writeFileSync(session, [JSON.stringify({ type: "session", version: 3, id: "tui-1", timestamp: new Date().toISOString(), cwd: dir }),
    msg("user", "review the parser (asked in the TUI)", 0), msg("assistant", "The parser drops a trailing comma.", 1)].join("\n") + "\n");
  const h = launch("resume", { dir, args: ["--provider", "pi", "--session", session] });
  try {
    await h.waitStatus(/^idle:pi$/, LOAD_MS, "first status");
    for (const t0 = Date.now(); !existsSync(h.piLog) && Date.now() - t0 < LOAD_MS;) await sleep(20);
    const start = JSON.parse(readFileSync(h.piLog, "utf8").split("\n")[0]!);
    assert.equal(start.argv[start.argv.indexOf("--session") + 1], session, "Pi gets the TUI's session file");
    const chat = h.chat()!;
    assert.equal(readRegistry(h.stateDir, chat)!.sessionFile, session);
    const c = await ChatClient.connect(readRegistry(h.stateDir, chat)!.port!, readRegistry(h.stateDir, chat)!.token, "mod");
    try {
      await c.waitFor((x) => x.items.some((i) => i.kind === "assistant" && /trailing comma/.test(i.text ?? "")), LOAD_MS, "the TUI's answer in the chat");
      assert.equal(c.items.find((i) => i.kind === "user")!.text, "review the parser (asked in the TUI)");
      h.proc.stdin!.write("\u001b[200~quick: and the lexer?\u001b[201~\r");
      await c.waitFor((x) => x.items.filter((i) => i.kind === "assistant" && !i.streaming).length === 2 && x.state.phase === "idle", LOAD_MS, "the new answer");
    } finally {
      c.close();
    }
    assert.match(readFileSync(session, "utf8"), /quick: and the lexer\?/, "the chat writes on in the TUI's session file");
  } finally {
    h.proc.kill("SIGHUP");
    await h.exited;
  }
});
