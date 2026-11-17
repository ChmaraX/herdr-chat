// /resume's list for every agent: two chats in two folders share one agent
// store (Pi's one --session-dir, Claude's config dir, Codex's home). `sessions`
// lists this folder's; `{scope: "all"}` both, each with its folder and whether
// it's this chat's (`here`: the client switches to it in place, else it opens a
// chat in that folder). A query is searched the same way for every agent: words
// in the name, first message or folder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname, basename } from "node:path";
import { writeFileSync, rmSync, utimesSync } from "node:fs";
import { startHost, idle, Host } from "./harness.ts";
import type { ChatClient } from "../../host/client.ts";
import { startClaude } from "../fake-claude/host.ts";
import { codexHost } from "../fake-codex/host.ts";

const answered = (c: ChatClient) => idle(c) && c.items.some((i) => i.kind === "assistant" && !i.streaming);

/** The whole list, as the picker gets it: asked again while the host is still reading. */
async function list(c: ChatClient, args: Record<string, unknown> = {}): Promise<{ sessions: any[]; polls: number }> {
  for (let polls = 1; ; polls++) {
    const d = await c.req("sessions", args);
    if (!d.loading) return { sessions: d.sessions, polls };
    assert.ok(d.loading.done <= d.loading.total || d.loading.total === 0, `progress ${JSON.stringify(d.loading)}`);
    args = { ...args, refresh: false };
    await new Promise((r) => setTimeout(r, 100));
  }
}

// What /resume shows of a session, its path aside.
const row = (s: any) => ({ first: s.firstMessage, messages: s.messageCount, cwd: s.cwd, here: s.here });

type Start = (o: { name: string; dir?: string; cwd?: string; chat?: string }) => Promise<Host>;

async function twoFolders(name: string, start: Start, firstElsewhere: string) {
  const a = await start({ name });
  const other = join(a.dir, "other");
  let b: Host | null = null;
  try {
    await a.client.waitFor(idle, 10_000);
    await a.client.req("send", { text: "plan the release" });
    await a.client.waitFor(answered, 10_000);
    b = await start({ name, dir: a.dir, cwd: other, chat: "c-other" });
    await b.client.waitFor(idle, 10_000);
    await b.client.req("send", { text: firstElsewhere });
    await b.client.waitFor(answered, 10_000);
    const here = (await list(a.client, { refresh: true })).sessions;
    const all = (await list(a.client, { scope: "all", refresh: true })).sessions;
    const fromB = (await list(b.client, { refresh: true })).sessions;
    // The same search for every agent: every word, in the name or first message, else (every
    // folder's list) the folder. In this folder's list a word of its path matches nothing.
    const search = async (query: string, scope = "all") => (await list(a.client, { scope, query })).sessions.map((s: any) => s.firstMessage);
    const found = { release: await search("RELEASE"), both: await search("plan release"), folder: await search("other"), none: await search("plan flaky"), ownFolder: await search(basename(a.cwd), "cwd") };
    a.artifact(`${name}-a`, { here, all, found });
    b.artifact(`${name}-b`, { fromB });
    return { a, other, here, all, fromB, found, aFile: a.client.state.sessionFile, bFile: b.client.state.sessionFile };
  } finally {
    await b?.stop();
    await a.stop();
  }
}

test("pi: one --session-dir for two folders; this folder's, then all; a `pi @brief.md` session reads as typed", async () => {
  // `pi @brief.md go` sends the file inline; the list shows what was typed.
  const brief = '<file name="/tmp/review/brief.task.md">\nRead the diff.\nReport back.\n</file>\ngo';
  const r = await twoFolders("sessions-pi", (o) => startHost({ ...o, speed: 5 }), brief);
  assert.deepEqual(r.here.map((s: any) => s.path), [r.aFile], "this folder's only, though the folder holds both");
  assert.deepEqual(r.all.map(row), [
    { first: "@/tmp/review/brief.task.md go", messages: 2, cwd: r.other, here: false },
    { first: "plan the release", messages: 2, cwd: r.a.cwd, here: true },
  ]);
  assert.deepEqual(r.fromB.map((s: any) => s.path), [r.bFile]);
  assert.deepEqual(r.found, { release: ["plan the release"], both: ["plan the release"], folder: ["@/tmp/review/brief.task.md go"], none: [], ownFolder: [] });
});

test("claude: two project folders; all lists both, each with its folder", async () => {
  const r = await twoFolders("sessions-claude", (o) => startClaude(o), "fix the flaky test");
  assert.deepEqual(r.here.map((s: any) => s.path), [r.aFile]);
  assert.deepEqual(r.all.map(row), [
    { first: "fix the flaky test", messages: 2, cwd: r.other, here: false },
    { first: "plan the release", messages: 2, cwd: r.a.cwd, here: true },
  ]);
  assert.deepEqual(r.found, { release: ["plan the release"], both: ["plan the release"], folder: ["fix the flaky test"], none: [], ownFolder: [] });
});

test("codex: thread/list with and without cwd, a page at a time; no message count (Codex doesn't give one)", async () => {
  // One thread per page: a list that stopped after the first page would show one session.
  const r = await twoFolders("sessions-codex", (o) => codexHost({ ...o, scenario: { default: [{ text: "noted" }] }, env: { FAKE_CODEX_PAGE: "1" } }), "fix the flaky test");
  assert.deepEqual(r.here.map((s: any) => s.path), [r.aFile]);
  assert.deepEqual(r.all.map(row), [
    { first: "fix the flaky test", messages: null, cwd: r.other, here: false },
    { first: "plan the release", messages: null, cwd: r.a.cwd, here: true },
  ]);
  assert.deepEqual(r.found, { release: ["plan the release"], both: ["plan the release"], folder: ["fix the flaky test"], none: [], ownFolder: [] });
});

/** A Pi session file as Pi writes it (header, then entries), last written at `t`. */
function piSession(path: string, cwd: string, t: string, messages: object[]): void {
  const entries = messages.map((message, i) => ({ type: "message", id: `m${i}`, parentId: i ? `m${i - 1}` : null, timestamp: t, message }));
  writeFileSync(path, [{ type: "session", version: 3, id: basename(path), timestamp: t, cwd }, ...entries].map((e) => JSON.stringify(e)).join("\n") + "\n");
  utimesSync(path, new Date(t), new Date(t));
}
const text = (role: string, t: string) => ({ role, content: [{ type: "text", text: t }], timestamp: 1 });

// Pi's store as it grows: hundreds of sessions (the list used to stop at the 100 newest),
// one with lines bigger than a read (a 1.5 MiB brief inlined in the first message, 3 MB
// of tool output), a rename, a deleted file, a new one. The host remembers what it read;
// `refresh` notices what changed on disk.
test("pi: every session (not the newest 100), long lines, renamed, deleted and new ones on refresh", async () => {
  const h = await startHost({ name: "sessions-pi-many", speed: 5 });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "plan the release" });
    await c.waitFor(answered, 10_000);
    const dir = dirname(c.state.sessionFile);
    const seeded: string[] = [];
    for (let i = 0; i < 400; i++) {
      const p = join(dir, `2025-01-01T00-00-${String(i).padStart(3, "0")}Z_old-${i}.jsonl`);
      piSession(p, h.cwd, new Date(Date.UTC(2025, 0, 1, 0, 0, i)).toISOString(), [text("user", `old task ${i}`), text("assistant", "lorem ipsum ".repeat(400))]);
      seeded.push(p);
    }
    // Multi-byte text, so characters straddle the reads' boundaries too.
    const brief = "zażółć gęślą jaźń ".repeat(70_000);
    const big = join(dir, "2025-01-02T00-00-000Z_big.jsonl");
    piSession(big, h.cwd, "2025-01-02T00:00:00.000Z", [
      text("user", `<file name="/tmp/big.md">\n${brief}\n</file>\nsummarise it`),
      { role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "x".repeat(3_000_000) }], timestamp: 2 },
      text("assistant", "summarised"),
      text("user", "thanks"),
    ]);
    const first = await list(c, { refresh: true });
    const old = await list(c, { query: "old task 399" });
    const long = await list(c, { query: "summarise" });

    await c.req("set_name", { name: "Release checklist" });
    await c.waitFor((x) => x.state.sessionName === "Release checklist", 3000);
    rmSync(seeded[0]!);
    piSession(join(dir, "2026-01-01T00-00-000Z_new.jsonl"), h.cwd, new Date().toISOString(), [text("user", "a new one")]);
    const stale = await list(c, { query: "checklist" });
    const again = await list(c, { refresh: true });
    h.artifact("sessions-pi-many", { first: first.sessions.slice(0, 5), firstCount: first.sessions.length, long: long.sessions, again: again.sessions.slice(0, 5), againCount: again.sessions.length });

    assert.equal(first.sessions.length, 402, "every session, not the newest 100");
    assert.deepEqual(first.sessions.slice(0, 3).map((s: any) => s.firstMessage), ["plan the release", "@/tmp/big.md summarise it", "old task 399"], "newest first");
    assert.deepEqual(old.sessions.map((s: any) => s.firstMessage), ["old task 399"], "an old one is searchable");
    assert.deepEqual(long.sessions.map((s: any) => [s.firstMessage, s.messageCount]), [["@/tmp/big.md summarise it", 3]], "long lines: the inlined brief as typed; 3 messages (tool output isn't one)");
    assert.deepEqual(stale.sessions, [], "without refresh: what was read before");
    assert.equal(again.sessions.length, 402, "one deleted, one new");
    // (Written in the same moment: which sorts first isn't the point.)
    assert.deepEqual(again.sessions.slice(0, 2).map((s: any) => s.name ?? s.firstMessage).sort(), ["Release checklist", "a new one"], "the renamed one and the new one, newest");
    assert.ok(!again.sessions.some((s: any) => s.path === seeded[0]), "the deleted file is gone");
  } finally {
    await h.stop();
  }
});
