// Antigravity (`agy acp`) through the real host and a real client, on tests/fake-agy. Its HOME is
// the test's own temp dir: the conversation "files" (and the chat's locks beside them) live under
// $HOME/.gemini/antigravity-cli/conversations/, never in the runner's home.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Host, idle, sleep, ROOT } from "./harness.ts";
import type { HostOptions } from "./harness.ts";
import { lockPath } from "../../host/registry.ts";

const FAKE_AGY = join(ROOT, "tests", "fake-agy", "fake-agy.mjs");
chmodSync(FAKE_AGY, 0o755);

const running = (x: any) => x.items.some((i: any) => i.kind === "tool" && i.status === "running");
const answered = (re: RegExp) => (x: any) => idle(x) && x.items.some((i: any) => i.kind === "assistant" && re.test(i.text) && !i.streaming);
const users = (c: any) => c.items.filter((i: any) => i.kind === "user").map((i: any) => `${i.source}:${i.text}`);
const errors = (c: any) => c.items.filter((i: any) => i.kind === "notice" && i.level === "error").map((i: any) => i.text);

/** The host on fake-agy, HOME (and agy's settings.json: default model and mode) in its own temp dir. */
async function start(name: string, settings?: object, more: Partial<HostOptions> = {}): Promise<Host> {
  const h = new Host({ name, provider: "agy", agent: FAKE_AGY, ...more });
  const home = join(h.dir, "home");
  const agyDir = join(home, ".gemini", "antigravity-cli");
  mkdirSync(agyDir, { recursive: true });
  if (settings) writeFileSync(join(agyDir, "settings.json"), JSON.stringify(settings));
  h.opts.env = { HOME: home, AGY_SETTINGS_PATH: join(agyDir, "settings.json"), ...(more.env ?? {}) };
  await h.start();
  await h.client.waitFor(idle, 10_000);
  return h;
}

test("agy: a turn streams, its tool card ends, and the conversation becomes resumable (file, lock) only at its first turn", async () => {
  const h = await start("agy-turn", { model: "Orchestrator (Neon)", agentMode: "accept-edits" });
  try {
    const c = h.client;
    assert.equal(c.state.provider, "agy");
    assert.equal(c.state.capabilities.steer, false);
    // agy's own defaults, applied before turn 1 (agy acp ignores its settings.json).
    assert.equal(c.state.model?.id, "gemini-pro-orchestrator-neon");
    assert.equal(c.state.permissionMode, "accept-edits");
    assert.equal(c.state.sessionFile, null, "no conversation file before the first turn: a restart now starts a new one");
    await c.req("send", { text: "check the repo" });
    await c.waitFor(answered(/Hello world!/), 10_000, "answered");
    const home = h.opts.env!.HOME!;
    const file = join(home, ".gemini", "antigravity-cli", "conversations", "sess-new-1.db");
    assert.equal(c.state.sessionFile, file, "the file is announced at the first turn");
    assert.ok(existsSync(lockPath(file)), "the chat's lock is in the test's HOME");
    const tool = c.items.find((i: any) => i.kind === "tool");
    assert.equal(tool?.status, "done");
    assert.deepEqual(users(c), ["composer:check the repo"]);
    assert.equal(c.state.permissionMode, "accept-edits", "a config update after the turn keeps the mode");
    assert.deepEqual(errors(c), []);
    h.artifact("agy-turn");
  } finally {
    await h.stop();
  }
});

test("agy: the mode set from the chip survives a later model change (agy's config update)", async () => {
  const h = await start("agy-mode");
  try {
    const c = h.client;
    await c.req("set_permission_mode", { mode: "plan" });
    await c.waitFor((x) => x.state.permissionMode === "plan", 3000, "plan");
    await c.req("set_model", { model: "antigravity/gemini-3.8-flash" });
    await c.waitFor((x) => x.state.model?.id === "gemini-3.8-flash", 3000, "model changed");
    await sleep(200);
    assert.equal(c.state.permissionMode, "plan", "the model change didn't put the old mode back");
    h.artifact("agy-mode");
  } finally {
    await h.stop();
  }
});

test("agy: Enter while it works is held as a follow-up (agy takes no steers), sent after the run, below the reply before it", async () => {
  const h = await start("agy-hold");
  try {
    const c = h.client;
    await c.req("send", { text: "SLOW first" });
    await c.waitFor(running, 5000, "tool running");
    assert.equal((await c.req("send", { text: "ECHO: second" })).disposition, "queued");
    await c.waitFor((x) => x.state.queue.followUp.length === 1, 2000, "held");
    assert.deepEqual(c.state.queue.steering, []);
    assert.deepEqual(c.state.queue.followUpRemovable, [true], "the chat holds it: it can still be taken back");
    await assert.rejects(c.req("queue_move", { message: c.state.queue.followUpIds[0], to: "steer" }), /takes no steers/);
    assert.deepEqual(c.state.queue.followUp, ["ECHO: second"], "a refused move leaves it held");
    await c.waitFor(answered(/^ok: second/), 10_000, "the held one answered after the run");
    const seen = c.items.filter((i: any) => i.kind === "user" || i.kind === "assistant").map((i: any) => `${i.kind}:${i.text}`);
    assert.deepEqual(seen, ["user:SLOW first", "assistant:ok: SLOW first", "user:ECHO: second", "assistant:ok: second"]);
    assert.deepEqual(errors(c), [], "no prompt sent while one ran (fake-agy refuses a second one)");
    h.artifact("agy-hold");
  } finally {
    await h.stop();
  }
});

test("agy: Esc with a held message gives it back unsent, and the run ends aborted", async () => {
  const h = await start("agy-abort");
  try {
    const c = h.client;
    await c.req("send", { text: "HANG" });
    await c.waitFor((x) => x.state.phase === "working" && x.items.some((i: any) => i.kind === "thinking"), 5000, "thinking");
    await c.req("send", { text: "after the hang" });
    await c.waitFor((x) => x.state.queue.followUp.length === 1, 2000, "held");
    const { restored } = await c.req("abort");
    assert.deepEqual(restored, ["after the hang"]);
    await c.waitFor(idle, 5000, "idle after abort");
    await sleep(300);
    assert.deepEqual(users(c), ["composer:HANG"], "never sent");
    assert.deepEqual(c.state.queue, { steering: [], followUp: [] });
    assert.equal(c.items.filter((i: any) => i.kind === "assistant").at(-1)?.stopReason, "aborted");
    assert.deepEqual(errors(c), []);
    h.artifact("agy-abort");
  } finally {
    await h.stop();
  }
});

test("agy: a permission card answered, then the run settles", async () => {
  const h = await start("agy-perm");
  try {
    const c = h.client;
    await c.req("send", { text: "ASK_PERM" });
    await c.waitFor((x) => x.state.dialog?.method === "permission", 5000, "card");
    await c.req("dialog_answer", { dialog: c.state.dialog.id, choice: "allow_once" });
    await c.waitFor(answered(/Allowed and ran/), 5000, "ran");
    assert.equal(c.items.find((i: any) => i.kind === "tool")?.status, "done");
    h.artifact("agy-perm");
  } finally {
    await h.stop();
  }
});

test("agy: agy exits mid-turn: the run closes with the exit, a held message comes back, the next send restarts it", async () => {
  const h = await start("agy-crash");
  try {
    const c = h.client;
    await c.req("send", { text: "CRASH now" });
    await c.waitFor((x) => x.state.phase === "exited", 8000, "exited");
    assert.match(c.state.error ?? "", /crashing mid-turn|exited/);
    assert.ok(c.items.every((i: any) => !i.streaming), "nothing left streaming");
    const r = await c.req("send", { text: "ECHO: back" });
    assert.ok(["started", "pending"].includes(r.disposition));
    await c.waitFor(answered(/^ok: back/), 10_000, "answered after the restart");
    h.artifact("agy-crash");
  } finally {
    await h.stop();
  }
});

test("agy: /resume replays a conversation's history and names the chat with its title", async () => {
  const h = await start("agy-resume");
  try {
    const c = h.client;
    let list = await c.req("sessions", { scope: "cwd" });
    for (let i = 0; list.loading && i < 50; i++) {
      await sleep(50);
      list = await c.req("sessions", { scope: "cwd" });
    }
    const s = list.sessions.find((x: any) => /sess-old-1\.db$/.test(x.path));
    assert.ok(s, `listed: ${JSON.stringify(list).slice(0, 300)}`);
    await c.req("switch_session", { path: s.path });
    await c.waitFor((x) => x.items.some((i: any) => i.kind === "user" && i.text === "Old question"), 5000, "history");
    assert.equal(c.state.sessionName, "Previous Session");
    assert.ok(c.items.some((i: any) => i.kind === "assistant" && /Old answer/.test(i.text)));
    h.artifact("agy-resume");
  } finally {
    await h.stop();
  }
});
