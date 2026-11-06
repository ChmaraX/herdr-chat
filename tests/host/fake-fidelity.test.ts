// The fakes answer a prompt in the same order as the real agents: when the
// prompt's echo comes against the turn's start and the first answer. Each check
// reads a real recording in tests/fixtures and a live run of the fake, so a fake
// that drifts from the recording fails here (a fake that echoed at once hid a
// late prompt in Claude chats).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FIXTURES, FAKE_PI } from "./harness.ts";
import { FAKE_CLAUDE } from "../fake-claude/host.ts";
import { FAKE_CODEX } from "../fake-codex/host.ts";

type Rec = Record<string, any>;
/** A record with when it arrived, ms after the prompt. */
type Timed = { t: number; rec: Rec };

/** Runs a fake on stdio: `send` writes one JSON line; `until` collects what it printed after the last send until `done`. */
function run(cmd: string, args: string[], env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "pich-fidelity-"));
  const p = spawn(process.execPath, [cmd, ...args], { cwd: dir, env: { ...process.env, ...env, HOME: dir }, stdio: ["pipe", "pipe", "inherit"] });
  let buf = "";
  let t0 = Date.now();
  const recs: Timed[] = [];
  let wake: (() => void) | null = null;
  p.stdout!.on("data", (d) => {
    buf += d.toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        recs.push({ t: Date.now() - t0, rec: JSON.parse(line) });
      } catch {}
      wake?.();
    }
  });
  return {
    dir,
    send(rec: Rec) {
      t0 = Date.now();
      recs.length = 0;
      p.stdin!.write(JSON.stringify(rec) + "\n");
    },
    async until(done: (r: Rec) => boolean, ms = 10_000): Promise<Timed[]> {
      const end = Date.now() + ms;
      while (!recs.some((x) => done(x.rec))) {
        if (Date.now() > end) throw new Error(`fake ${cmd}: timed out; got ${recs.map((x) => x.rec.type ?? x.rec.method).join(",")}`);
        await new Promise<void>((r) => {
          wake = r;
          setTimeout(r, 50);
        });
      }
      return [...recs];
    },
    stop: () => p.kill("SIGKILL"),
  };
}

const lines = (file: string): Rec[] => readFileSync(join(FIXTURES, file), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

/** The records after the first prompt sent in a recording, with times relative to it. */
function afterPrompt(recs: Rec[], isPrompt: (r: Rec) => boolean, out: (r: Rec) => Rec | null): Timed[] {
  const i = recs.findIndex(isPrompt);
  assert.ok(i >= 0, "the recording has a prompt");
  const t0 = recs[i]!.t;
  return recs.slice(i + 1).flatMap((r) => {
    const rec = out(r);
    return rec ? [{ t: r.t - t0, rec }] : [];
  });
}

// ---------------------------------------------------------------- Claude

/** The order of the turn's start (init), the prompt's replay and the answer's message_start; and whether the replay waited for the model. */
function claudeShape(recs: Timed[]): { order: string[]; echoWaitsForModel: boolean } {
  const order: string[] = [];
  let echoAt = -1;
  for (const { t, rec } of recs) {
    const k = rec.type === "system" && rec.subtype === "init" ? "init"
      : rec.type === "user" && rec.isReplay ? "echo"
      : rec.type === "stream_event" && rec.event?.type === "message_start" && !rec.parent_tool_use_id ? "message_start"
      : null;
    if (!k || order.includes(k)) continue;
    order.push(k);
    if (k === "echo") echoAt = t;
    if (k === "message_start") break;
  }
  return { order, echoWaitsForModel: echoAt >= 400 };
}

test("fake-claude: the prompt's replay comes when the model starts answering, as in the real CLI (v2.jsonl)", async () => {
  const real = claudeShape(afterPrompt(lines("claude/v2.jsonl"), (r) => r.dir === "in" && r.rec.type === "user", (r) => (r.dir === "out" ? r.rec : null)));
  assert.deepEqual(real, { order: ["init", "echo", "message_start"], echoWaitsForModel: true }, "the recording");
  const f = run(FAKE_CLAUDE, ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--replay-user-messages"], { CLAUDE_CONFIG_DIR: join(tmpdir(), "pich-fidelity-claude") });
  try {
    f.send({ type: "control_request", request_id: "r1", request: { subtype: "initialize" } });
    await f.until((r) => r.type === "control_response");
    f.send({ type: "user", message: { role: "user", content: "hello" }, parent_tool_use_id: null, uuid: "aaaaaaaa-0000-4000-8000-000000000001", priority: "next" });
    assert.deepEqual(claudeShape(await f.until((r) => r.type === "result")), real, "the fake");
  } finally {
    f.stop();
  }
});

// ---------------------------------------------------------------- Codex

/** The order of turn/started, the prompt's userMessage echo and the first answer item. */
function codexShape(recs: Timed[]): string[] {
  const order: string[] = [];
  for (const { rec } of recs) {
    const item = rec.params?.item;
    const k = rec.method === "turn/started" ? "turn/started"
      : rec.method === "item/completed" && item?.type === "userMessage" ? "echo"
      : rec.method === "item/started" && (item?.type === "agentMessage" || item?.type === "reasoning") ? "answer"
      : null;
    if (k && !order.includes(k)) order.push(k);
  }
  return order;
}

test("fake-codex: the prompt's echo comes after turn/started and before the answer, as in the real app-server (text.jsonl)", async () => {
  const real = codexShape(afterPrompt(lines("codex/text.jsonl"), (r) => r.dir === "out" && r.msg?.method === "turn/start", (r) => (r.dir === "in" && r.msg && typeof r.msg === "object" ? r.msg : null)));
  assert.deepEqual(real, ["turn/started", "echo", "answer"], "the recording");
  const home = mkdtempSync(join(tmpdir(), "pich-fidelity-codex-"));
  const f = run(FAKE_CODEX, ["app-server"], { FAKE_CODEX_HOME: home });
  try {
    f.send({ method: "initialize", id: 0, params: { clientInfo: { name: "fidelity", version: "1" } } });
    await f.until((r) => r.id === 0);
    f.send({ method: "thread/start", id: 1, params: { cwd: f.dir } });
    const thread = (await f.until((r) => r.id === 1)).find((x) => x.rec.id === 1)!.rec.result.thread.id;
    f.send({ method: "turn/start", id: 2, params: { threadId: thread, input: [{ type: "text", text: "hello", text_elements: [] }] } });
    assert.deepEqual(codexShape(await f.until((r) => r.method === "turn/completed")), real, "the fake");
  } finally {
    f.stop();
  }
});

// ---------------------------------------------------------------- Pi

/** The order of the prompt's reply, agent_start, the user echo and the answer's message_start. */
function piShape(recs: Timed[]): string[] {
  const order: string[] = [];
  for (const { rec } of recs) {
    const k = rec.type === "response" && rec.command === "prompt" ? "reply"
      : rec.type === "agent_start" ? "agent_start"
      : rec.type === "message_start" && rec.message?.role === "user" ? "echo"
      : rec.type === "message_start" && rec.message?.role === "assistant" ? "answer"
      : null;
    if (k && !order.includes(k)) order.push(k);
  }
  return order;
}

test("fake-pi: the prompt's echo comes at once, before the answer, as in the real Pi (text-only.jsonl)", async () => {
  const real = piShape(afterPrompt(lines("text-only.jsonl"), (r) => r.dir === "in" && r.rec.type === "prompt", (r) => (r.dir === "out" ? r.rec : null)));
  assert.deepEqual(real, ["reply", "agent_start", "echo", "answer"], "the recording");
  const f = run(FAKE_PI, ["--mode", "rpc", "--session-dir", join(tmpdir(), "pich-fidelity-pi")], {});
  try {
    f.send({ id: "p1", type: "prompt", message: "hello" });
    assert.deepEqual(piShape(await f.until((r) => r.type === "agent_end")), real, "the fake");
  } finally {
    f.stop();
  }
});
