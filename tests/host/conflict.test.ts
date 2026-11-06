// One live host per session: a session another chat's host (or the agent's own
// guard) holds is not opened; take_over moves it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, realpathSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { startHost, idle, sleep, Host } from "./harness.ts";
import { readLock, lockPath } from "../../host/registry.ts";
import { startClaude } from "../fake-claude/host.ts";

const answered = (text: string) => (x: any) => idle(x) && x.items.some((i: any) => i.kind === "assistant" && i.text === `ok: ${text}`);

test("conflict: a second chat on a session is refused; take_over closes the first chat and opens it", async () => {
  const a = await startHost({ name: "cf-a", chat: "c-a", speed: 4 });
  let b: Host | null = null;
  try {
    await a.client.waitFor(idle, 10_000);
    await a.client.req("send", { text: "from chat A" });
    await a.client.waitFor(answered("from chat A"), 5000);
    const file = a.client.state.sessionFile;

    b = await new Host({ name: "cf-b", dir: a.dir, chat: "c-b", session: file, speed: 4 }).start();
    const c = b.client;
    await c.waitFor((x) => x.state.phase === "conflict", 10_000, "conflict");
    assert.deepEqual(c.state.conflict, { chat: "c-a", terminal: null, pid: a.proc.pid });
    assert.equal(c.state.sessionFile, file);
    assert.equal(readLock(file)!.chat, "c-a", "chat A keeps the session");
    await assert.rejects(c.req("send", { text: "from chat B" }), /open in another chat\. Go to that chat, or use take_over/);
    await assert.rejects(c.req("handoff"), /take_over/);
    await c.req("resume"); // still held: resume re-checks and stays in conflict
    assert.equal(c.state.phase, "conflict");
    assert.equal(c.items.filter((i) => i.kind === "notice" && /open in another chat/.test(i.text)).length, 1, "one notice, not one per retry");

    await c.req("take_over");
    assert.equal(await Promise.race([a.exited, sleep(5000).then(() => "timeout")]), 0, "chat A's host shut down cleanly");
    assert.equal(a.client.bye?.reason, "shutdown");
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.text === "ok: from chat A"), 10_000, "chat B has the session's history");
    assert.equal(c.state.conflict, null);
    assert.equal(readLock(file)!.chat, "c-b");
    await c.req("send", { text: "from chat B" });
    await c.waitFor(answered("from chat B"), 5000);
    b.artifact("conflict-take-over");
  } finally {
    await b?.stop();
    await a.stop();
  }
});

test("conflict: switch_session into another chat's session is refused; new_session leaves the conflict", async () => {
  const a = await startHost({ name: "cf-sw-a", chat: "c-a", speed: 4 });
  let b: Host | null = null;
  try {
    await a.client.waitFor(idle, 10_000);
    await a.client.req("send", { text: "A's turn" });
    await a.client.waitFor(answered("A's turn"), 5000);
    const fileA = a.client.state.sessionFile;
    b = await new Host({ name: "cf-sw-b", dir: a.dir, chat: "c-b", speed: 4 }).start();
    const c = b.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "B's turn" });
    await c.waitFor(answered("B's turn"), 5000);
    const fileB = c.state.sessionFile;

    await c.req("switch_session", { path: fileA });
    assert.equal(c.state.phase, "conflict");
    assert.deepEqual(c.state.conflict, { chat: "c-a", terminal: null, pid: a.proc.pid });
    assert.deepEqual(c.items.filter((i) => i.kind !== "notice"), [], "B's old timeline is gone, A's isn't shown");
    assert.equal(readLock(fileA)!.chat, "c-a");
    assert.equal(readLock(fileB), null, "B let go of its own session");

    await c.req("new_session");
    await c.waitFor(idle, 10_000);
    assert.equal(c.state.conflict, null);
    await c.req("send", { text: "fresh" });
    await c.waitFor(answered("fresh"), 5000);
    assert.notEqual(c.state.sessionFile, fileA);
    assert.equal(a.client.state.phase, "idle", "chat A is untouched");
    b.artifact("conflict-switch-session");
  } finally {
    await b?.stop();
    await a.stop();
  }
});

test("conflict: a lock naming the holder's terminal is refused with it; Pi opens the session once the holder lets go", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pich-cf-lock-")));
  const session = join(dir, "sessions", "chat.jsonl");
  mkdirSync(join(dir, "sessions"), { recursive: true });
  // Another live chat (this test process) holds the lock, from terminal t9.
  writeFileSync(lockPath(session), JSON.stringify({ pid: process.pid, chat: "c-other", terminal: "t9", startedAt: 1 }));
  const h = await startHost({ name: "cf-lock", dir, speed: 4, session });
  try {
    const c = h.client;
    await c.waitFor((x) => x.state.phase === "conflict", 10_000, "conflict");
    assert.deepEqual(c.state.conflict, { chat: "c-other", terminal: "t9", pid: process.pid });
    assert.equal(h.piCommands().length, 0, "Pi never started");
    await assert.rejects(c.req("send", { text: "hi" }), /open in another chat \(terminal t9\)\. Go to that chat, or use take_over/);
    rmSync(lockPath(session)); // the other chat closed
    await c.req("resume");
    await c.waitFor(idle, 10_000);
    assert.equal(c.state.conflict, null);
    assert.equal(readLock(session)!.chat, "c-test", "the host holds it now");
    await c.req("send", { text: "after the holder left" });
    await c.waitFor(answered("after the holder left"), 5000);
    h.artifact("conflict-lock-released");
  } finally {
    await h.stop();
  }
});

test("conflict: Claude Code's own registry guards its sessions too", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pich-cf-claude-")));
  const id = randomUUID();
  const holder = join(dir, "claude-config", "sessions", "4242.json");
  mkdirSync(join(dir, "claude-config", "sessions"), { recursive: true });
  // A live Claude Code (this test process) has the session open, outside any chat.
  writeFileSync(holder, JSON.stringify({ pid: process.pid, sessionId: id, kind: "interactive" }));
  const h = await startClaude({ name: "cf-claude", dir, session: join(dir, `${id}.jsonl`) });
  try {
    const c = h.client;
    await c.waitFor((x) => x.state.phase === "conflict", 10_000);
    assert.deepEqual(c.state.conflict, { chat: null, terminal: null, pid: process.pid });
    await assert.rejects(c.req("take_over"), /open in Claude Code outside a chat \(pid \d+\)\. Quit it there, then use resume/);
    assert.equal(h.inputs().length, 0, "Claude Code never started");
    rmSync(holder); // it quit
    await c.req("resume");
    await c.waitFor(idle, 10_000);
    assert.equal(c.state.conflict, null);
    h.artifact("conflict-claude-guard");
  } finally {
    await h.stop();
  }
});
