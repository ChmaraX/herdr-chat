// One host process per chat. The chat's mod can start two hosts for one chat
// at the same moment (a restart's two paths, two views, a stale terminal list):
// the hosts themselves must make sure only one serves it. The others refuse
// before they touch the registry or start an agent on the session.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Host, idle, sleep, ARTIFACTS } from "./harness.ts";
import { readRegistry, readLock, lockPath } from "../../host/registry.ts";
import { claimDir } from "../../host/claim.ts";

const N = 6;
const answered = (text: string) => (x: any) => idle(x) && x.items.some((i: any) => i.kind === "assistant" && i.text === `ok: ${text}`);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Every fake-pi the hosts started: its pid, the host that started it (ppid), and the session it opened (its --session). */
function agents(log: string): { pid: number; ppid: number; session: string | null }[] {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.type === "_start")
    .map((r) => ({ pid: r.pid, ppid: r.ppid, session: r.argv.includes("--session") ? r.argv[r.argv.indexOf("--session") + 1] : null }));
}

function artifact(name: string, data: unknown): string {
  mkdirSync(ARTIFACTS, { recursive: true });
  const path = join(ARTIFACTS, `${name}.json`);
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
  return path;
}

/** A chat with one turn on its session, then its host stopped: the state a restart starts from. */
async function chatWithSession(name: string): Promise<{ dir: string; chat: string; session: string }> {
  const a = await new Host({ name, chat: "c-race" }).start();
  try {
    await a.client.waitFor(idle, 10_000);
    await a.client.req("send", { text: "before the restart" });
    await a.client.waitFor(answered("before the restart"), 5000);
    return { dir: a.dir, chat: a.chat, session: a.client.state.sessionFile! };
  } finally {
    await a.stop();
  }
}

/** Starts `n` hosts of one chat at the same moment; resolves once every one has either registered or exited. */
async function race(o: { dir: string; chat: string; session: string; name: string; n: number }): Promise<Host[]> {
  const hosts = Array.from({ length: o.n }, (_, i) => new Host({ name: `${o.name}-${i}`, dir: o.dir, chat: o.chat, session: o.session }));
  for (const h of hosts) h.spawn();
  const t0 = Date.now();
  for (;;) {
    const reg = readRegistry(hosts[0]!.stateDir, o.chat);
    const settled = hosts.every((h) => h.exitCode !== null || (reg?.pid === h.proc.pid && reg?.port));
    if (settled && hosts.filter((h) => h.exitCode === null).length <= 1) break;
    if (Date.now() - t0 > 15_000) break;
    await sleep(50);
  }
  return hosts;
}

test("one host per chat: N hosts started at once for one chat: one serves, the registry names it, the rest refuse; one agent on the session", async () => {
  const { dir, chat, session } = await chatWithSession("race");
  const piLog = join(dir, "pi-commands.jsonl");
  const before = agents(piLog).length;
  const hosts = await race({ dir, chat, session, name: "race", n: N });
  try {
    const serving = hosts.filter((h) => h.exitCode === null);
    const refused = hosts.filter((h) => h.exitCode !== null);
    const reg = readRegistry(hosts[0]!.stateDir, chat);
    // Give a duplicate that got through the time to start its agent too.
    await sleep(1000);
    const started = agents(piLog).slice(before);
    const data = {
      test: "one-host-race",
      hosts: hosts.map((h) => ({ pid: h.proc.pid, exitCode: h.exitCode, out: h.transcript.trim().split("\n").filter((l) => /herdr-chat-host:/.test(l)) })),
      registry: reg && { pid: reg.pid, terminal: reg.terminal, port: reg.port },
      lock: readLock(session),
      agentsStarted: started,
    };
    const path = artifact("one-host-race", data);
    assert.equal(serving.length, 1, `exactly one host serves (${path})`);
    const winner = serving[0]!;
    assert.equal(reg?.pid, winner.proc.pid, "the registry names the serving host");
    for (const h of refused) {
      assert.notEqual(h.exitCode, 0, "a refused host exits non-zero");
      assert.match(h.transcript, new RegExp(`chat ${chat} already has a host \\(pid ${winner.proc.pid}\\)`), "and says which host has the chat");
    }
    assert.deepEqual(started.map((a) => a.ppid), [winner.proc.pid], "one agent process, the serving host's");
    assert.deepEqual(started.map((a) => a.session), [session], "on the chat's session");
    assert.equal(readLock(session)?.pid, winner.proc.pid, "the session lock is the serving host's");
    // The chat still works, through the registry, on its history.
    winner.client = await winner.connect();
    await winner.client.waitFor((x) => idle(x) && x.items.some((i) => i.text === "ok: before the restart"), 10_000, "the session's history");
    await winner.client.req("send", { text: "after the race" });
    await winner.client.waitFor(answered("after the race"), 5000);
    winner.artifact("one-host-race-winner", { race: data });
  } finally {
    for (const h of hosts) await h.stop();
  }
});

test("one host per chat: a host killed with SIGKILL leaves a stale claim; the next host takes it over, and once only when several race for it", async () => {
  const { dir, chat, session } = await chatWithSession("stale");
  const first = await new Host({ name: "stale-first", dir, chat, session }).start();
  await first.client.waitFor(idle, 10_000);
  first.proc.kill("SIGKILL");
  await first.exited;
  const agent = agents(join(dir, "pi-commands.jsonl")).find((a) => a.ppid === first.proc.pid);
  // The agent is in its own process group: a SIGKILLed host leaves it (it exits once its stdin closes).
  for (let i = 0; i < 50 && agent && alive(agent.pid); i++) await sleep(100);
  const stale = readRegistry(first.stateDir, chat);
  assert.equal(stale?.pid, first.proc.pid, "the killed host's registry entry stays (it never cleaned up)");

  const before = agents(join(dir, "pi-commands.jsonl")).length;
  const hosts = await race({ dir, chat, session, name: "stale-race", n: 4 });
  try {
    const serving = hosts.filter((h) => h.exitCode === null);
    await sleep(1000);
    const started = agents(join(dir, "pi-commands.jsonl")).slice(before);
    const path = artifact("one-host-stale", {
      test: "one-host-stale", killed: first.proc.pid,
      hosts: hosts.map((h) => ({ pid: h.proc.pid, exitCode: h.exitCode })),
      registry: readRegistry(first.stateDir, chat), agentsStarted: started,
    });
    assert.equal(serving.length, 1, `one of the racers takes over the dead host's claim (${path})`);
    assert.equal(readRegistry(first.stateDir, chat)?.pid, serving[0]!.proc.pid);
    assert.deepEqual(started.map((a) => a.ppid), [serving[0]!.proc.pid], "one agent process");
    serving[0]!.client = await serving[0]!.connect();
    await serving[0]!.client.waitFor((x) => idle(x) && x.items.some((i) => i.text === "ok: before the restart"), 10_000, "the session's history");
  } finally {
    for (const h of hosts) await h.stop();
  }
});

test("one host per chat: a claim whose pid now runs another process (pid reuse) is stale", async () => {
  const { dir, chat, session } = await chatWithSession("reuse");
  // The newest claim names a live process that is not a host: this test runner, as a host that
  // died would leave it once its pid went to another process (another start time).
  const folder = claimDir(join(dir, "state"), chat);
  const newest = Math.max(...readdirSync(folder).filter((n) => /^\d+\.json$/.test(n)).map((n) => parseInt(n, 10)));
  writeFileSync(join(folder, `${newest + 1}.json`), JSON.stringify({ pid: process.pid, started: "Thu Jan  1 00:00:00 1970", terminal: "t-gone", at: 0 }) + "\n");
  const h = await new Host({ name: "reuse-b", dir, chat, session }).start();
  try {
    await h.client.waitFor((x) => idle(x) && x.items.some((i) => i.text === "ok: before the restart"), 10_000, "serves the chat");
    assert.equal(readRegistry(h.stateDir, chat)?.pid, h.proc.pid);
    assert.match(readFileSync(join(dir, "state", "logs", `${chat}.log`), "utf8"), new RegExp(`took over the claim of a host that died \\(pid ${process.pid}\\)`));
  } finally {
    artifact("one-host-pid-reuse", { test: "one-host-pid-reuse", fakeClaim: process.pid, host: h.proc.pid, registry: readRegistry(h.stateDir, chat), log: readFileSync(join(dir, "state", "logs", `${chat}.log`), "utf8").split("\n") });
    await h.stop();
  }
});

test("one host per chat: a restart (the old host shuts down, then a new one starts) and a restart racing a second start", async () => {
  const { dir, chat, session } = await chatWithSession("restart");
  const a = await new Host({ name: "restart-a", dir, chat, session }).start();
  await a.client.waitFor(idle, 10_000);
  // What the mod's replaceHost does: shutdown, then a new host once the old one is gone.
  await a.client.req("shutdown");
  assert.equal(await Promise.race([a.exited, sleep(5000).then(() => "timeout")]), 0, "the old host exits cleanly");
  assert.equal(readRegistry(a.stateDir, chat)?.pid, null, "and clears its registry entry");
  const hosts = await race({ dir, chat, session, name: "restart-b", n: 2 });
  const record = () => artifact("one-host-restart", { test: "one-host-restart", old: a.proc.pid, racers: hosts.map((h) => ({ pid: h.proc.pid, exitCode: h.exitCode })), registry: readRegistry(a.stateDir, chat), log: readFileSync(join(dir, "state", "logs", `${chat}.log`), "utf8").split("\n") });
  try {
    const serving = hosts.filter((h) => h.exitCode === null);
    assert.equal(serving.length, 1, "the replacement serves, a second start at the same moment refuses");
    const b = serving[0]!;
    b.client = await b.connect();
    await b.client.waitFor((x) => idle(x) && x.items.some((i) => i.text === "ok: before the restart"), 10_000, "the same session's history");
    await b.client.req("send", { text: "after the restart" });
    await b.client.waitFor(answered("after the restart"), 5000);
    // The restart after this one: a SIGTERM (the mod's kill) frees the chat too.
    await b.stop();
    const c = await new Host({ name: "restart-c", dir, chat, session }).start();
    try {
      await c.client.waitFor((x) => idle(x) && x.items.some((i) => i.text === "ok: after the restart"), 10_000, "a third host after a SIGTERM");
    } finally {
      await c.stop();
    }
  } finally {
    record();
    for (const h of hosts) await h.stop();
  }
});

test("one host per chat: a host from before the claim (none on disk) still runs the chat: a new host of it doesn't open the session beside it", async () => {
  const { dir, chat, session } = await chatWithSession("legacy");
  const old = await new Host({ name: "legacy-old", dir, chat, session }).start();
  let b: Host | null = null;
  try {
    await old.client.waitFor(idle, 10_000);
    // A host before 0.6 made no claim: the old host's goes, as if it never made one.
    rmSync(claimDir(old.stateDir, chat), { recursive: true, force: true });
    const before = agents(join(dir, "pi-commands.jsonl")).length;
    b = await new Host({ name: "legacy-new", dir, chat, session }).start();
    await b.client.waitFor((x) => x.state.phase === "conflict", 10_000, "conflict");
    assert.deepEqual(b.client.state.conflict, { chat, terminal: null, pid: old.proc.pid });
    assert.equal(readLock(session)?.pid, old.proc.pid, "the old host keeps the session");
    assert.deepEqual(agents(join(dir, "pi-commands.jsonl")).slice(before), [], "the new host started no agent");
    // Once the old one is gone (the mod's sweep ends it), resume opens the session.
    await old.stop();
    await b.client.req("resume");
    await b.client.waitFor((x) => idle(x) && x.items.some((i) => i.text === "ok: before the restart"), 10_000, "opened after resume");
  } finally {
    artifact("one-host-legacy-duplicate", { test: "one-host-legacy-duplicate", old: old.proc.pid, new: b?.proc.pid ?? null, state: b?.client?.state ?? null, items: b?.client?.items ?? null, lock: readLock(session) });
    await b?.stop();
    await old.stop();
  }
});

test("one host per chat: a session lock left by a host of this chat that died, its pid now another process's, is stale: the next host opens the session", async () => {
  const { dir, chat, session } = await chatWithSession("stale-lock");
  // What a SIGKILLed host of this chat leaves: its session lock. Its pid went to an unrelated process
  // (this test runner): once as a 0.6 lock (a start time that isn't the runner's), once as a pre-0.6
  // lock (no start time: the runner isn't a host of this chat).
  for (const [label, lock] of [
    ["0.6", { pid: process.pid, chat, terminal: "t-dead", startedAt: 0, stamp: "Thu Jan  1 00:00:00 1970" }],
    ["pre-0.6", { pid: process.pid, chat, terminal: "t-dead", startedAt: 0 }],
  ] as const) {
    writeFileSync(lockPath(session), JSON.stringify(lock) + "\n");
    const h = await new Host({ name: `stale-lock-${label}`, dir, chat, session }).start();
    try {
      await h.client.waitFor((x) => (idle(x) && x.items.some((i) => i.text === "ok: before the restart")) || x.state.phase === "conflict", 10_000, "opened or conflict");
      artifact(`one-host-stale-lock-${label}`, { test: "one-host-stale-lock", label, lockBefore: lock, host: h.proc.pid, state: h.client.state, lockAfter: readLock(session) });
      assert.notEqual(h.client.state.phase, "conflict", `${label}: no conflict with a dead host's lock`);
      assert.equal(readLock(session)?.pid, h.proc.pid, `${label}: the new host holds the session`);
    } finally {
      await h.stop();
    }
  }
});

test("one host per chat: the serving host keeps the registry naming it: an entry overwritten (a 0.5.0 duplicate's exit) or deleted is written back, and a client can reach it again", async () => {
  const { dir, chat, session } = await chatWithSession("repair");
  const h = await new Host({ name: "repair", dir, chat, session, env: { HERDR_CHAT_REGISTRY_CHECK_MS: "200" } }).start();
  const seen: unknown[] = [];
  try {
    await h.client.waitFor(idle, 10_000);
    const mine = readRegistry(h.stateDir, chat)!;
    // A 0.5.0 duplicate's exit: its own entry, cleared, over the live host's.
    const wiped = { ...mine, pid: null, port: null, wsPort: null, terminal: "t-dup", token: "0".repeat(64) };
    writeFileSync(join(h.stateDir, "chats", `${chat}.json`), JSON.stringify(wiped));
    seen.push({ after: "overwritten", registry: readRegistry(h.stateDir, chat) });
    const back = async (why: string) => {
      const t0 = Date.now();
      while (readRegistry(h.stateDir, chat)?.pid !== h.proc.pid) {
        if (Date.now() - t0 > 5000) throw new Error(`the host didn't write its entry back after: ${why}`);
        await sleep(50);
      }
      seen.push({ after: why, registry: readRegistry(h.stateDir, chat) });
    };
    await back("overwritten");
    assert.deepEqual(readRegistry(h.stateDir, chat), mine, "the same entry: port, token, terminal, session");
    rmSync(join(h.stateDir, "chats", `${chat}.json`));
    await back("deleted");
    // A client finds it through the registry and works.
    const c = await h.connect();
    await c.req("send", { text: "after the repair" });
    await c.waitFor(answered("after the repair"), 5000);
  } finally {
    artifact("one-host-registry-repair", { test: "one-host-registry-repair", pid: h.proc.pid, seen });
    await h.stop();
  }
});
