// The user's prompt is on the timeline as soon as it is sent, for every provider.
// Claude replays it only when the model starts answering (with `message_start`,
// 0.6–3.5 s later in the recordings), and Codex after its UserPromptSubmit hooks
// (1.5 s+ in the recordings), so a chat that waited for the echo showed the
// prompt late. The echo confirms the same item; it never adds a second one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { idle, startHost } from "./harness.ts";
import type { Host } from "./harness.ts";
import { startClaude } from "../fake-claude/host.ts";
import { codexHost } from "../fake-codex/host.ts";

const SHOWN_MS = 150;

/** Sends `text` to an idle chat; the prompt must show within SHOWN_MS, before any answer; one user item once settled. */
async function promptShowsAtOnce(h: Host, text: string, answered: RegExp): Promise<void> {
  const c = h.client;
  await c.waitFor(idle, 10_000, "started");
  const t0 = Date.now();
  const sent = c.req("send", { text });
  await c.waitFor((x) => x.items.some((i) => i.kind === "user"), SHOWN_MS, `the prompt on the timeline within ${SHOWN_MS} ms`);
  const shown = c.items.find((i) => i.kind === "user");
  assert.equal(shown.text, text);
  assert.equal(shown.source, "composer");
  assert.deepEqual(c.items.filter((i) => i.kind !== "notice").map((i) => i.kind), ["user"], `nothing of the answer yet (${Date.now() - t0} ms)`);
  await sent;
  await c.waitFor((x) => idle(x) && x.items.some((i) => i.kind === "assistant" && answered.test(i.text)), 15_000, "answered");
  const users = c.items.filter((i) => i.kind === "user");
  assert.deepEqual(users.map((u) => [u.id, u.text]), [[shown.id, text]], "the echo confirmed the shown item");
}

test("claude (scripted, the echo at the turn's start): the prompt shows at once, and the echo confirms it", async () => {
  const h = await startClaude({ name: "echo-claude", speed: 1, scenario: { turns: [{ match: "pelican", steps: [{ text: "Pelicans fly." }] }] } });
  try {
    await promptShowsAtOnce(h, "Tell me a pelican fact", /Pelicans fly/);
    h.artifact("echo-claude");
  } finally {
    await h.stop();
  }
});

test("claude (fixture extra.jsonl, the real CLI's echo timing): the prompt shows before the replay", async () => {
  const h = await startClaude({ name: "echo-claude-fx", speed: 1, replay: "extra.jsonl" });
  try {
    await promptShowsAtOnce(h, "Use the TodoWrite tool (load it with ToolSearch if needed) to record two todos: 'alpha' in_progress and 'beta' pending. Then stop.", /alpha/);
  } finally {
    await h.stop();
  }
});

test("codex (fixture text.jsonl, the echo after the prompt hooks): the prompt shows at once", async () => {
  const h = await codexHost({ name: "echo-codex-fx", replay: "text.jsonl", speed: 1 });
  try {
    await promptShowsAtOnce(h, "Reply with exactly: hello from codex", /hello from codex/);
  } finally {
    await h.stop();
  }
});

test("claude: Esc before the turn starts keeps the sent prompt (once), and the next prompt runs", async () => {
  const h = await startClaude({ name: "echo-claude-abort", speed: 1, scenario: { turnStartMs: 1500, default: [{ text: "ok: {prompt}" }] } });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000, "started");
    await c.req("send", { text: "first" });
    await c.waitFor((x) => x.items.some((i) => i.kind === "user"), SHOWN_MS, "the prompt shown");
    await c.req("abort", {});
    await c.waitFor(idle, 5000, "aborted");
    await c.req("send", { text: "second" });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.kind === "assistant" && i.text === "ok: second"), 10_000, "the next prompt answered");
    assert.deepEqual(c.items.filter((i) => i.kind === "user").map((u) => u.text), ["first", "second"]);
    assert.ok(!c.items.some((i) => i.kind === "assistant" && /first/.test(i.text)), "the aborted prompt never ran");
  } finally {
    await h.stop();
  }
});

test("pi: a skill's echo (Pi's expanded text) updates the shown item; a prompt Pi rejects leaves the timeline", async () => {
  const skill = '<skill name="diagnose">Reproduce first.</skill>\n\nthe crash';
  const h = await startHost({
    name: "echo-pi", speed: 1,
    scenario: { expandPrompts: { "^/skill:diagnose (.*)$": skill.replace("the crash", "$1") }, rejectPrompts: "^nope", default: [{ assistant: { text: "done" } }] },
  });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000, "started");
    await c.req("send", { text: "/skill:diagnose the crash" });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.kind === "assistant" && i.text === "done"), 10_000, "answered");
    const users = c.items.filter((i) => i.kind === "user");
    assert.deepEqual(users.map((u) => [u.text, u.source]), [[skill, "composer"]], "one item, with the text Pi expanded");

    const before = c.items.map((i) => i.id);
    await assert.rejects(c.req("send", { text: "nope, not this" }), /Rejected: nope/);
    await c.waitFor((x) => x.items.some((i) => i.kind === "notice" && /rejected the message/.test(i.text)), 3000, "the error notice");
    assert.deepEqual(c.items.filter((i) => i.kind !== "notice").map((i) => i.id), before, "the rejected prompt's item is gone");
    assert.equal(c.state.phase, "idle");
  } finally {
    await h.stop();
  }
});
