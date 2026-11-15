// Codex runs through the real host: abort mid-tool, steer and follow-up mid-run, a plan, retries and failed turns.
import { test } from "node:test";
import assert from "node:assert/strict";
import { idle, sleep } from "./harness.ts";
import { codexHost } from "../fake-codex/host.ts";

const answered = (text: RegExp) => (x: any) => idle(x) && x.items.some((i: any) => i.kind === "assistant" && text.test(i.text) && !i.streaming);

const SCENARIO = {
  prompts: [
    { match: "^watch", steps: [{ text: "Watching.", phase: "commentary" }, { command: "tail -f log", output: ["line 1\n"], until: "interrupt", tick: "tick {n}\n", every: 60 }] },
    { match: "^build", steps: [{ command: "make", output: ["cc a.c\n", "cc b.c\n"], every: 250 }, { text: "Built." }] },
    { match: "also say steered", steps: [{ text: "Steered too." }] },
    { match: "^then test", steps: [{ command: "make test", output: "ok\n" }, { text: "Tests pass." }] },
  ],
};

test("codex: Esc mid-tool interrupts the turn; the open command is closed, queued text comes back, the chat is idle", async () => {
  const h = await codexHost({ name: "cx-abort", scenario: SCENARIO, speed: 2 });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "watch the log" });
    await c.waitFor((x) => x.items.some((i) => i.kind === "tool" && i.status === "running" && /tick 2/.test(i.output)), 5000, "tool ticking");
    assert.equal((await c.req("send", { text: "then test it", mode: "followUp" })).disposition, "queued");
    await c.waitFor((x) => x.state.queue.followUp.length === 1, 3000, "queued follow-up");
    const r = await c.req("abort");
    assert.deepEqual(r.restored, ["then test it"]);
    await c.waitFor(idle, 5000, "idle after abort");
    const tool = c.items.find((i) => i.kind === "tool");
    assert.equal(tool.title, "$ tail -f log");
    assert.equal(tool.status, "error");
    assert.match(tool.output, /^line 1\ntick 1\n[\s\S]*\nInterrupted\.$/);
    assert.deepEqual(c.state.queue, { steering: [], followUp: [] });
    const interrupts = h.requests("turn/interrupt");
    assert.equal(interrupts.length, 1);
    // Sent as the turn settles; fake-codex logs it a moment later.
    for (const t0 = Date.now(); !h.requests("thread/backgroundTerminals/clean").length; await sleep(20)) {
      assert.ok(Date.now() - t0 < 3000, "background terminals cleaned after the interrupt");
    }
    assert.equal(h.requests("turn/start").length, 1, "the restored follow-up was not sent");
    await h.waitStatus(/^idle$/);
    // The chat works after an abort.
    await c.req("send", { text: "build it" });
    await c.waitFor(answered(/Built\./), 5000);
    h.artifact("codex-abort-mid-tool");
  } finally {
    await h.stop();
  }
});

test("codex: a steer mid-run lands in the same turn; a follow-up (held by the host) starts the next turn after it, with no done between", async () => {
  const h = await codexHost({ name: "cx-steer", scenario: SCENARIO, speed: 1 });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "build the project" });
    await c.waitFor((x) => x.items.some((i) => i.kind === "tool" && i.status === "running"), 5000, "building");
    assert.equal((await c.req("send", { text: "also say steered" })).disposition, "queued");
    await c.waitFor((x) => x.state.queue.steering[0] === "also say steered", 3000, "steer queued");
    assert.equal((await c.req("send", { text: "then test it", mode: "followUp" })).disposition, "queued");
    await c.waitFor((x) => x.state.queue.followUp[0] === "then test it", 3000, "follow-up queued");
    await c.waitFor(answered(/Tests pass\./), 10_000);
    const kinds = c.items.filter((i) => i.kind !== "notice").map((i) => i.kind + (i.kind === "user" ? `:${i.source}:${i.text}` : i.kind === "tool" ? `:${i.title}` : `:${i.text}`));
    assert.deepEqual(kinds, [
      "user:composer:build the project",
      "tool:$ make",
      "user:queued:also say steered",
      "assistant:Steered too.",
      "assistant:Built.",
      "user:queued:then test it",
      "tool:$ make test",
      "assistant:Tests pass.",
    ]);
    // One turn for the steer (turn/steer), a second turn for the follow-up; one run from the user's view.
    assert.equal(h.requests("turn/steer").length, 1);
    assert.equal(h.requests("turn/start").length, 2);
    assert.ok(!c.items.some((i) => i.kind === "notice" && /on its own/.test(i.text)), "the follow-up turn is not an autonomous run");
    await h.waitStatus(/^done/);
    assert.deepEqual(h.statuses.filter((s, i, a) => s !== a[i - 1]).slice(-2), ["working", "done"]);
    h.artifact("codex-steer-follow-up");
  } finally {
    await h.stop();
  }
});

test("codex: a plan item and a todo list; a retried error, then a failed turn shows its error", async () => {
  const h = await codexHost({
    name: "cx-plan",
    scenario: {
      prompts: [
        {
          match: "plan",
          steps: [
            { todo: { explanation: "Two steps", plan: [{ step: "Pick a word", status: "inProgress" }, { step: "Say it", status: "pending" }] } },
            { reasoning: ["**Planning**"] },
            { todo: { plan: [{ step: "Pick a word", status: "completed" }, { step: "Say it", status: "inProgress" }] } },
            { plan: "# Greeting\n\n1. Pick a word\n2. Say it\n" },
          ],
        },
        { match: "flaky", steps: [{ error: "stream disconnected", willRetry: true, details: "retrying 1/5" }, { wait: 100 }, { text: "Recovered." }] },
        { match: "broken", steps: [{ text: "Starting…", phase: "commentary" }, { error: "usage limit reached", willRetry: false }, { fail: "You've hit your usage limit." }] },
      ],
    },
  });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "make a plan" });
    await c.waitFor(answered(/^# Greeting/), 5000);
    assert.deepEqual(c.state.plan, { steps: [{ text: "Pick a word", status: "completed" }, { text: "Say it", status: "in_progress" }] }, "the todo list is the chat's plan, the last update's");
    assert.equal(c.items.filter((i) => i.kind === "plan").length, 0, "no card in the transcript");
    const proposal = c.items.find((i) => i.kind === "assistant");
    assert.match(proposal.text, /1\. Pick a word/);
    assert.equal(proposal.blocks[0].type, "markdown");

    await c.req("send", { text: "flaky request" });
    await c.waitFor(answered(/Recovered\./), 5000);
    const retry = c.items.find((i) => i.kind === "notice" && i.source === "retry");
    assert.match(retry.text, /Retry succeeded/);

    await c.req("send", { text: "broken request" });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.kind === "assistant" && i.stopReason === "error"), 5000);
    const failed = c.items.filter((i) => i.kind === "assistant").at(-1);
    assert.equal(failed.error, "You've hit your usage limit.");
    await h.waitStatus(/^error/);
    h.artifact("codex-plan-retry-fail");
  } finally {
    await h.stop();
  }
});

const strip = (c: { state: any }) => c.state.plan?.steps.map((s: any) => [s.text, s.status]) ?? null;
const markers = (items: any[]) => items.filter((i) => i.kind === "notice" && i.source === "plan").map((i) => i.text);
const PLANS = {
  prompts: [
    {
      match: "^make a plan",
      steps: [
        { todo: { explanation: "Two steps", plan: [{ step: "Pick a word", status: "inProgress" }, { step: "Say it", status: "pending" }] } },
        { text: "Picking." },
        { todo: { plan: [{ step: "Pick a word", status: "completed" }, { step: "Say it", status: "inProgress" }] } },
        { text: "Picked." },
      ],
    },
    {
      match: "^use an agent",
      steps: [{ subagent: { prompt: "Count to 4", steps: [{ todo: { plan: [{ step: "Count", status: "inProgress" }] } }, { text: "1 2 3 4" }], answer: "1 2 3 4" } }, { text: "Counted." }],
    },
    { match: "^add a step", steps: [{ todo: { plan: [{ step: "Pick a word", status: "completed" }, { step: "Say it", status: "completed" }, { step: "Wave", status: "inProgress" }] } }, { text: "Waving." }] },
    { match: "^finish", steps: [{ todo: { plan: [{ step: "Pick a word", status: "completed" }, { step: "Say it", status: "completed" }, { step: "Wave", status: "completed" }] } }, { text: "Done." }] },
  ],
};

test("codex: each turn's plan updates the chat's one plan; a subagent's is a card; the plan comes back from the rollout", async () => {
  const h = await codexHost({ name: "cx-plans", scenario: PLANS });
  let livePlan: any;
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "make a plan" });
    await c.waitFor(answered(/^Picked\./), 5000);
    assert.deepEqual(strip(c), [["Pick a word", "completed"], ["Say it", "in_progress"]]);
    assert.deepEqual(markers(c.items), ["Plan created · 2 steps"], "a status change makes no marker");

    await c.req("send", { text: "use an agent" });
    await c.waitFor(answered(/^Counted\./), 5000);
    const spawn = c.items.find((i) => i.kind === "tool" && i.title === "Agent Count to 4");
    assert.deepEqual(c.items.filter((i) => i.kind === "plan").map((p) => [p.parent, p.steps]), [[spawn.id, [{ text: "Count", status: "in_progress" }]]],
      "the subagent's plan is a card in its group");
    assert.deepEqual(strip(c), [["Pick a word", "completed"], ["Say it", "in_progress"]], "and leaves the chat's plan alone");
    livePlan = structuredClone(c.state.plan);
    h.artifact("codex-plans-live");
  } finally {
    await h.stop();
  }

  const again = await codexHost({ name: "cx-plans-resumed", scenario: PLANS, dir: h.dir });
  try {
    const c = again.client;
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.text === "Counted."), 10_000, "history");
    assert.deepEqual(c.state.plan, livePlan, "the rollout's update_plan calls rebuild the plan");
    assert.deepEqual(markers(c.items), ["Plan created · 2 steps"], "and its marker");

    await c.req("send", { text: "add a step" });
    await c.waitFor(answered(/^Waving\./), 5000);
    assert.deepEqual(markers(c.items), ["Plan created · 2 steps", "Plan updated · 3 steps"], "a new step is worth a marker");
    await c.req("send", { text: "finish" });
    await c.waitFor(answered(/^Done\./), 5000);
    assert.deepEqual(strip(c), [["Pick a word", "completed"], ["Say it", "completed"], ["Wave", "completed"]], "done: it stays until the next message");
    await c.req("send", { text: "thanks" });
    await c.waitFor(answered(/^ok: thanks/), 5000);
    assert.equal(c.state.plan, null, "the next message clears a finished plan");
    assert.equal(markers(c.items).length, 2);
    again.artifact("codex-plans-resumed");
  } finally {
    await again.stop();
  }
});

test("codex fixtures interrupt (07) and steer (08): the real records", async () => {
  const h = await codexHost({ name: "cx-fx-int", replay: "interrupt.jsonl", speed: 4 });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "Run exactly this shell command and wait for it: `sleep 30; echo finished`" });
    await c.waitFor((x) => x.state.dialog?.method === "permission", 10_000);
    await c.req("dialog_answer", { dialog: c.state.dialog.id, choice: "accept" });
    await c.waitFor((x) => x.items.some((i) => i.kind === "tool" && i.status === "running") && x.state.dialog === null, 5000, "sleeping");
    await c.req("abort");
    await c.waitFor(idle, 10_000);
    const tool = c.items.find((i) => i.kind === "tool");
    assert.equal(tool.title, "$ sleep 30; echo finished");
    assert.equal(tool.status, "error");
    assert.match(tool.output, /Interrupted\./);
  } finally {
    await h.stop();
  }
  const s = await codexHost({ name: "cx-fx-steer", replay: "steer.jsonl", speed: 4 });
  try {
    const c = s.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "Write the numbers from 1 to 300 as English words, one per line. No tools." });
    await c.waitFor((x) => x.items.some((i) => i.kind === "assistant" && i.streaming && i.text.length > 0), 10_000, "streaming");
    assert.equal((await c.req("send", { text: "Stop. Instead reply only with the word STEERED." })).disposition, "queued");
    await c.waitFor(answered(/^STEERED$/), 10_000);
    const users = c.items.filter((i) => i.kind === "user");
    assert.deepEqual(users.map((u) => u.source), ["composer", "queued"]);
    assert.deepEqual(c.state.queue.steering, []);
    s.artifact("codex-fixture-steer");
  } finally {
    await s.stop();
  }
});
