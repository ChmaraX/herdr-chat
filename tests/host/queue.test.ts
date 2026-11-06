// The two lanes above the composer, through the real host: steering goes to
// the agent as before; follow-ups are held by the host and sent as the next
// prompt when the run settles, one per run. Remove, edit and move work on both
// lanes where the agent lets the host take a steer back (Pi: clear and re-add;
// Claude Code: cancel_async_message; Codex: not at all).
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync, crc32 } from "node:zlib";
import { startHost, idle, sleep } from "./harness.ts";
import type { Host } from "./harness.ts";
import { startClaude } from "../fake-claude/host.ts";
import { codexHost } from "../fake-codex/host.ts";

const SCENARIO = {
  prompts: [
    {
      match: "^work",
      once: false,
      steps: [
        { assistant: { text: "Working.", tools: [{ name: "bash", args: { command: "sleep 2" } }] } },
        { tool: { name: "bash", duration: 2000, output: "slept\n" } },
        { assistant: { text: "Worked." } },
      ],
    },
    {
      match: "^long",
      once: false,
      steps: [
        { assistant: { text: "Running the long build.", tools: [{ name: "bash", args: { command: "make build" } }] } },
        { tool: { name: "bash", until: "abort", every: 100, tick: "compiling unit {n}\n" } },
        { assistant: { text: "unreachable" } },
      ],
    },
  ],
};

const running = (x: any) => x.items.some((i: any) => i.kind === "tool" && i.status === "running");
const answered = (re: RegExp) => (x: any) => idle(x) && x.items.some((i: any) => i.kind === "assistant" && re.test(i.text) && !i.streaming);
const users = (c: any) => c.items.filter((i: any) => i.kind === "user").map((i: any) => `${i.source}:${i.text}`);
const prompts = (h: Host) => h.piCommands().filter((x) => x.type === "prompt");
/** OSC 7501 states with repeats folded: one run from the user's view is working once, then done. */
const runs = (h: Host) => h.statuses.map((s) => s.replace(/\(.*/, "")).filter((s, i, a) => s !== a[i - 1]);

async function pi(name: string): Promise<Host> {
  const h = await startHost({ name, scenario: SCENARIO, speed: 1 });
  await h.client.waitFor(idle, 10_000);
  return h;
}

test("follow-up (pi): held by the host while working, then sent as the next prompt when the run settles", async () => {
  const h = await pi("q-followup");
  try {
    const c = h.client;
    await c.req("send", { text: "work for a while" });
    await c.waitFor(running, 5000, "tool running");
    assert.equal((await c.req("send", { text: "fu one", mode: "followUp" })).disposition, "queued");
    await c.waitFor((x) => x.state.queue.followUp[0] === "fu one", 2000, "follow-up lane");
    const q = c.state.queue;
    assert.equal(typeof q.followUpIds?.[0], "string", "the follow-up has the host's id");
    assert.deepEqual(q.followUpRemovable, [true]);
    assert.ok(!prompts(h).some((p) => p.message === "fu one"), "not handed to Pi while the run is on");
    assert.ok(!users(c).includes("queued:fu one"), "not in the timeline while held");
    await c.waitFor(answered(/^ok: fu one/), 10_000, "follow-up answered");
    assert.deepEqual(users(c), ["composer:work for a while", "queued:fu one"]);
    const sent = prompts(h);
    assert.equal(sent.length, 2);
    assert.equal(sent[1].message, "fu one");
    assert.equal(sent[1].streamingBehavior, undefined, "a new prompt after the run, not Pi's follow-up queue");
    assert.deepEqual(c.state.queue, { steering: [], followUp: [] });
    assert.ok(!c.items.some((i: any) => i.kind === "notice" && /on its own/.test(i.text)), "the follow-up's run is the user's, not autonomous");
    await h.waitStatus(/^done/);
    assert.deepEqual(runs(h), ["idle", "working", "done"], "no done between the run and its follow-up");
    h.artifact("queue-followup");
  } finally {
    await h.stop();
  }
});

test("abort (pi): a held follow-up is not sent; it comes back to the composer after the steers", async () => {
  const h = await pi("q-abort");
  try {
    const c = h.client;
    await c.req("send", { text: "long build" });
    await c.waitFor((x) => x.items.some((i: any) => i.kind === "tool" && /unit 2/.test(i.output)), 5000, "ticking");
    await c.req("send", { text: "fu after", mode: "followUp" });
    await c.req("send", { text: "steer now" });
    await c.waitFor((x) => x.state.queue.steering.length === 1 && x.state.queue.followUp.length === 1, 2000, "both lanes");
    const { restored } = await c.req("abort");
    assert.deepEqual(restored, ["steer now", "fu after"]);
    await c.waitFor(idle, 5000, "idle after abort");
    await sleep(500); // would the follow-up start a run?
    assert.equal(c.state.phase, "idle");
    assert.deepEqual(c.state.queue, { steering: [], followUp: [] });
    assert.deepEqual(users(c), ["composer:long build"]);
    assert.ok(!prompts(h).some((p) => p.message === "fu after"), "the follow-up never reached Pi");
    h.artifact("queue-abort");
  } finally {
    await h.stop();
  }
});

test("two follow-ups (pi): one per run, in the order they were queued", async () => {
  const h = await pi("q-two");
  try {
    const c = h.client;
    await c.req("send", { text: "work first" });
    await c.waitFor(running, 5000, "tool running");
    await c.req("send", { text: "fu one", mode: "followUp" });
    await c.req("send", { text: "fu two", mode: "followUp" });
    await c.waitFor((x) => x.state.queue.followUp.length === 2, 2000, "two held");
    assert.deepEqual(c.state.queue.followUp, ["fu one", "fu two"]);
    await c.waitFor(answered(/^ok: fu two/), 15_000, "both answered");
    const seen = c.items.filter((i: any) => i.kind === "user" || i.kind === "assistant").map((i: any) => `${i.kind}:${i.text}`);
    assert.deepEqual(seen.slice(-4), ["user:fu one", "assistant:ok: fu one", "user:fu two", "assistant:ok: fu two"]);
    // Each went as its own prompt, after the run before it settled.
    const types = h.piCommands().map((x) => (x.type === "prompt" ? `prompt:${x.message}` : x.type));
    assert.deepEqual(types.filter((t) => t.startsWith("prompt:")), ["prompt:work first", "prompt:fu one", "prompt:fu two"]);
    assert.deepEqual(c.state.queue, { steering: [], followUp: [] });
    h.artifact("queue-two-followups");
  } finally {
    await h.stop();
  }
});

/** A w×h grayscale PNG. */
function png(w: number, h: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.alloc((w + 1) * h))), chunk("IEND", Buffer.alloc(0))]);
}

test("remove, edit, move (pi): × drops a follow-up, a click takes it back with its image, ⇄ makes it a steer now", async () => {
  const h = await pi("q-ops");
  try {
    const c = h.client;
    const shot = join(h.cwd, "shot.png");
    writeFileSync(shot, png(8, 8));
    await c.req("send", { text: "work on it" });
    await c.waitFor(running, 5000, "tool running");
    await c.req("send", { text: "fu keep", mode: "followUp" });
    await c.req("send", { text: "fu drop", mode: "followUp" });
    await c.req("send", { text: "fu edit", images: [shot], mode: "followUp" });
    await c.waitFor((x) => x.state.queue.followUp.length === 3, 2000, "three held");
    const [keep, drop, edit] = c.state.queue.followUpIds;
    await c.req("queue_remove", { message: drop });
    await c.waitFor((x) => x.state.queue.followUp.length === 2, 2000, "removed");
    assert.deepEqual(c.state.queue.followUp, ["fu keep", "fu edit"]);
    const back = await c.req("queue_edit", { message: edit });
    assert.deepEqual(back, { text: "fu edit", images: [shot] });
    await c.waitFor((x) => x.state.queue.followUp.length === 1, 2000, "edited out");
    await c.req("queue_move", { message: keep, to: "steer" });
    await c.waitFor((x) => x.state.queue.followUp.length === 0, 2000, "moved out of the follow-ups");
    const steer = prompts(h).find((p) => p.message === "fu keep");
    assert.equal(steer?.streamingBehavior, "steer", "moved to Pi's steering queue");
    await assert.rejects(c.req("queue_remove", { message: drop }), /no longer queued/);
    await c.waitFor(answered(/^Worked\./), 10_000, "run over");
    await sleep(400); // nothing left to send
    assert.deepEqual(users(c), ["composer:work on it", "queued:fu keep"]);
    assert.deepEqual(prompts(h).map((p) => p.message), ["work on it", "fu keep"]);
    h.artifact("queue-ops");
  } finally {
    await h.stop();
  }
});

test("steer removal (pi): × on a steer clears Pi's queue and re-adds the others, in order", async () => {
  const h = await pi("q-pi-steer");
  try {
    const c = h.client;
    await c.req("send", { text: "work it" });
    await c.waitFor(running, 5000, "tool running");
    for (const t of ["steer A", "steer B", "steer C"]) await c.req("send", { text: t });
    await c.waitFor((x) => x.state.queue.steering.length === 3, 2000, "three steers");
    assert.deepEqual(c.state.queue.steeringRemovable, [true, true, true]);
    const b = c.state.queue.steeringIds[1];
    await c.req("queue_remove", { message: b });
    await c.waitFor((x) => x.state.queue.steering.length === 2, 2000, "B removed");
    assert.deepEqual(c.state.queue.steering, ["steer A", "steer C"]);
    await c.waitFor(answered(/^Worked\./), 10_000, "run over");
    assert.deepEqual(users(c), ["composer:work it", "queued:steer A", "queued:steer C"]);
    const types = h.piCommands().map((x) => (x.type === "prompt" ? `prompt:${x.message}` : x.type));
    const ci = types.indexOf("clear_queue");
    assert.ok(ci > 0, "clear_queue sent");
    assert.deepEqual(types.slice(ci + 1).filter((t) => t.startsWith("prompt:")), ["prompt:steer A", "prompt:steer C"]);
    h.artifact("queue-pi-steer-remove");
  } finally {
    await h.stop();
  }
});

const ticking = (n: number, everyMs = 300) => ({ tool: "Bash", ask: false, input: { command: "make build", description: "Build" }, task: { lines: Array.from({ length: n }, (_, i) => `compiling unit ${i + 1}`), everyMs } });

test("steer removal (claude): × cancels the steer by uuid; ⇄ moves a steer to the follow-ups", async () => {
  const h = await startClaude({
    name: "q-claude", speed: 1,
    scenario: { turns: [{ match: "Build", steps: [ticking(8), { text: "Built. Also: {steers}" }] }, { match: "after", steps: [{ text: "And now: {prompt}" }] }] },
  });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "Build it" });
    await c.waitFor(running, 5000, "tool running");
    for (const t of ["say A", "say B", "after C"]) await c.req("send", { text: t });
    await c.waitFor((x) => x.state.queue.steering.length === 3, 2000, "three steers");
    assert.deepEqual(c.state.queue.steeringRemovable, [true, true, true]);
    const [a, , cc] = c.state.queue.steeringIds;
    await c.req("queue_remove", { message: a });
    await c.req("queue_move", { message: cc, to: "followUp" });
    await c.waitFor((x) => x.state.queue.steering.length === 1 && x.state.queue.followUp.length === 1, 2000, "one steer, one follow-up");
    assert.deepEqual([c.state.queue.steering, c.state.queue.followUp], [["say B"], ["after C"]]);
    assert.deepEqual(h.controls("cancel_async_message").map((r) => r.request.message_uuid), [a, cc]);
    await c.waitFor(answered(/^And now: after C/), 15_000, "both done");
    const seen = c.items.filter((i: any) => i.kind === "user" || i.kind === "assistant").map((i: any) => `${i.kind}:${i.text}`);
    assert.deepEqual(seen, ["user:Build it", "user:say B", "assistant:Built. Also: say B", "user:after C", "assistant:And now: after C"]);
    assert.deepEqual(runs(h), ["idle", "working", "done"]);
    h.artifact("queue-claude-steer-remove");
  } finally {
    await h.stop();
  }
});

const CODEX = {
  prompts: [
    { match: "^build", steps: [{ command: "make", output: ["cc a.c\n", "cc b.c\n", "cc c.c\n"], every: 400 }, { text: "Built." }] },
    { match: "also say steered", steps: [{ text: "Steered too." }] },
  ],
};

test("steer removal (codex): a sent steer can't be taken back (no ×); a held follow-up can", async () => {
  const h = await codexHost({ name: "q-codex", scenario: CODEX, speed: 1 });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "build the project" });
    await c.waitFor(running, 5000, "building");
    await c.req("send", { text: "also say steered" });
    await c.req("send", { text: "then lint", mode: "followUp" });
    await c.waitFor((x) => x.state.queue.steering.length === 1 && x.state.queue.followUp.length === 1, 3000, "both lanes");
    assert.deepEqual(c.state.queue.steeringRemovable, [false]);
    assert.deepEqual(c.state.queue.followUpRemovable, [true]);
    await assert.rejects(c.req("queue_remove", { message: c.state.queue.steeringIds[0] }), /can't take back/);
    await c.req("queue_remove", { message: c.state.queue.followUpIds[0] });
    await c.waitFor((x) => x.state.queue.followUp.length === 0, 2000, "follow-up removed");
    await c.waitFor(answered(/Built\./), 10_000);
    await sleep(300);
    assert.equal(h.requests("turn/start").length, 1, "the removed follow-up never started a turn");
    h.artifact("queue-codex");
  } finally {
    await h.stop();
  }
});

test("reconnect (pi): a client that connects mid-run sees the held follow-ups in its snapshot", async () => {
  const h = await pi("q-reconnect");
  try {
    const c = h.client;
    await c.req("send", { text: "long build" });
    await c.waitFor(running, 5000, "tool running");
    await c.req("send", { text: "fu held", mode: "followUp" });
    await c.waitFor((x) => x.state.queue.followUp.length === 1, 2000, "held");
    c.close();
    const d = await h.connect("again");
    await d.waitFor((x) => x.state.queue?.followUp?.length === 1, 2000, "snapshot has it");
    assert.deepEqual(d.state.queue.followUp, ["fu held"]);
    assert.deepEqual(d.state.queue.followUpRemovable, [true]);
    const { restored } = await d.req("abort");
    assert.deepEqual(restored, ["fu held"]);
    h.client = d;
    h.artifact("queue-reconnect");
  } finally {
    await h.stop();
  }
});
