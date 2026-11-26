import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { startHost, idle, Host, SCENARIOS } from "./harness.ts";
import { lockPath } from "../../host/registry.ts";

/** What a user sees of an item, without ids, timestamps and live-only timing. */
function seen(items: any[]): any[] {
  return items
    .filter((i) => i.kind !== "notice")
    .map((i) => {
      const { id, ts, durationMs, source, ...rest } = i;
      void id, ts, source;
      if (i.kind === "tool") return { ...rest, ran: durationMs !== undefined };
      return rest;
    });
}

test("resume from history: a restarted host on the same session shows the same timeline as live", async () => {
  const live = await startHost({ name: "resume-live", scenario: "tools.json", speed: 5 });
  let liveItems: any[];
  let file: string;
  try {
    const c = live.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "Look around the repo" });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.kind === "assistant" && i.text.startsWith("Done.")), 15_000);
    await c.req("send", { text: "And a second prompt" });
    await c.waitFor((x) => idle(x) && x.items.filter((i) => i.kind === "user").length === 2 && x.items.at(-1).kind === "assistant" && !x.items.at(-1).streaming, 5000);
    liveItems = structuredClone(c.items);
    file = c.state.sessionFile;
    live.artifact("resume-live");
  } finally {
    await live.stop();
  }
  // A clean exit keeps the session in the registry, clears pid/port, releases the lock.
  const reg = live.registry!;
  assert.equal(reg.pid, null);
  assert.equal(reg.port, null);
  assert.equal(reg.sessionFile, file);
  assert.ok(!existsSync(lockPath(file)));

  // Same state dir and chat, no --session: the host reopens the registry's session.
  const again = await new Host({ name: "resume-again", scenario: "tools.json", speed: 5, dir: live.dir }).start();
  try {
    const c = again.client;
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.kind === "tool"), 10_000, "history loaded");
    assert.equal(c.state.sessionFile, file);
    assert.ok(existsSync(lockPath(file)), "lock retaken");
    assert.deepEqual(seen(c.items), seen(liveItems));
    // Thinking timing is live-only; everything else matches, including tool durations.
    assert.ok(c.items.filter((i) => i.kind === "tool").every((t) => typeof t.durationMs === "number"));
    again.artifact("resume-from-history", { liveItems: seen(liveItems) });
  } finally {
    await again.stop();
  }
});

test("resume a session whose history is over 8 MiB: every turn comes back, no warning", async () => {
  // A long working session as Pi writes it: 60 turns, each a bash call with ~190 KiB of output,
  // so Pi's get_messages reply is ~11 MiB on one line (a real chat's was 11,149,836 bytes).
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pich-big-history-")));
  const file = join(dir, "sessions", "big.jsonl");
  mkdirSync(dirname(file), { recursive: true });
  const lines = [JSON.stringify({ type: "session", version: 3, id: "big-session", timestamp: new Date().toISOString(), cwd: join(dir, "cwd") })];
  let parent: string | null = null;
  const entry = (message: object) => {
    const id = `e${lines.length}`;
    lines.push(JSON.stringify({ type: "message", id, parentId: parent, timestamp: new Date().toISOString(), message }));
    parent = id;
  };
  const TURNS = 60;
  const output = (n: number) => `turn ${n}\n` + `log line of turn ${n} `.repeat(9000);
  for (let n = 1; n <= TURNS; n++) {
    entry({ role: "user", content: [{ type: "text", text: `Run step ${n}` }], timestamp: Date.now() });
    entry({ role: "assistant", content: [{ type: "toolCall", id: `call_${n}`, name: "bash", arguments: { command: `./step ${n}` } }], stopReason: "toolUse", timestamp: Date.now() });
    entry({ role: "toolResult", toolCallId: `call_${n}`, toolName: "bash", content: [{ type: "text", text: output(n) }], isError: false, timestamp: Date.now() });
    entry({ role: "assistant", content: [{ type: "text", text: `Step ${n} done.` }], stopReason: "stop", timestamp: Date.now() });
  }
  writeFileSync(file, lines.join("\n") + "\n");
  assert.ok(statSync(file).size > 10 * 1024 * 1024, "the session is over 10 MiB");

  const h = await new Host({ name: "big-history", scenario: { prompts: [] }, dir, session: file }).start();
  try {
    const c = h.client;
    await c.waitFor((x) => idle(x), 30_000, "started");
    const warnings = c.items.filter((i) => i.kind === "notice" && i.level !== "info").map((i) => i.text);
    assert.deepEqual(warnings, [], "no startup warning");
    // Every turn, in order, each with its tool call and answer.
    assert.deepEqual(c.items.filter((i) => i.kind === "user").map((i) => i.text), Array.from({ length: TURNS }, (_, k) => `Run step ${k + 1}`));
    assert.deepEqual(c.items.filter((i) => i.kind === "tool").map((i) => i.title), Array.from({ length: TURNS }, (_, k) => `$ ./step ${k + 1}`));
    assert.equal(c.items.filter((i) => i.kind === "assistant").at(-1)?.text, `Step ${TURNS} done.`);
    h.artifact("resume-big-history", { sessionBytes: statSync(file).size });
  } finally {
    await h.stop();
  }
});

test("a restarted host that is still reading the history says so: the first snapshot without historyPending has it all", async () => {
  // Pi reading a long session takes seconds; a client that connects meanwhile gets an empty
  // timeline and must be able to tell it from an empty conversation.
  const live = await startHost({ name: "pending-live", scenario: "tools.json", speed: 5 });
  let users: string[];
  try {
    const c = live.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "Look around the repo" });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.kind === "assistant" && i.text.startsWith("Done.")), 15_000);
    users = c.items.filter((i) => i.kind === "user").map((i) => i.text);
  } finally {
    await live.stop();
  }
  const again = await new Host({ name: "pending-again", scenario: { ...JSON.parse(readFileSync(join(SCENARIOS, "tools.json"), "utf8")), historyDelayMs: 1500 }, dir: live.dir }).start();
  try {
    const c = again.client;
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.kind === "user"), 10_000, "history loaded");
    const snaps = c.records.filter((r) => r.t === "snapshot");
    const pending = snaps.filter((r) => r.state.historyPending);
    assert.ok(pending.length >= 1, "the first snapshot came while the history was pending");
    assert.ok(pending.every((r) => !r.items.some((i: any) => i.kind === "user")), "pending snapshots have no conversation");
    const first = snaps.find((r) => !r.state.historyPending);
    assert.deepEqual(first.items.filter((i: any) => i.kind === "user").map((i: any) => i.text), users, "the first snapshot after it has the whole conversation");
    // No patch ends historyPending ahead of the history.
    const early = c.records.find((r) => r.t === "patch" && r.state?.historyPending === false);
    assert.equal(early, undefined, "historyPending ends with the history's snapshot, not in a patch");
    again.artifact("resume-history-pending", { snapshots: snaps.map((r) => ({ historyPending: r.state.historyPending, phase: r.state.phase, users: r.items.filter((i: any) => i.kind === "user").length })) });
  } finally {
    await again.stop();
  }
});
