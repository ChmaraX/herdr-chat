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
    await h.client.waitFor(idle, 10_000, "started");
    assert.equal(h.client.state.model.id, "gpt-5.6-luna", "from the real records");
    assert.equal(h.client.state.permissionMode, "untrusted");
    await promptShowsAtOnce(h, "Reply with exactly: hello from codex", /hello from codex/);
    await h.client.waitFor((x) => x.state.usage?.contextTokens === 16838, 3000, "usage from the real record");
    h.artifact("codex-fixture-text");
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

test("pi: an expanded prompt template's echo updates the shown item; a prompt Pi rejects leaves the timeline", async () => {
  const expanded = "Review this diff carefully:\n\nsrc/x.ts";
  const h = await startHost({
    name: "echo-pi", speed: 1,
    scenario: { expandPrompts: { "^/review (.*)$": expanded.replace("src/x.ts", "$1") }, rejectPrompts: "^nope", default: [{ assistant: { text: "done" } }] },
  });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000, "started");
    await c.req("send", { text: "/review src/x.ts" });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.kind === "assistant" && i.text === "done"), 10_000, "answered");
    const users = c.items.filter((i) => i.kind === "user");
    assert.deepEqual(users.map((u) => [u.text, u.source]), [[expanded, "composer"]], "one item, with the text Pi expanded");

    const before = c.items.map((i) => i.id);
    await assert.rejects(c.req("send", { text: "nope, not this" }), /Rejected: nope/);
    await c.waitFor((x) => x.items.some((i) => i.kind === "notice" && /rejected the message/.test(i.text)), 3000, "the error notice");
    assert.deepEqual(c.items.filter((i) => i.kind !== "notice").map((i) => i.id), before, "the rejected prompt's item is gone");
    assert.equal(c.state.phase, "idle");
    assert.equal(c.state.editorText, null, "fast rejection errors send directly, without also setting editorText");
  } finally {
    await h.stop();
  }
});

test("pi: a rejection after send returned pending restores a composer draft via editorText, not external sends, and doesn't duplicate drained follow-ups", async () => {
  const h = await startHost({
    name: "echo-pi-late-reject", speed: 1,
    scenario: {
      rejectPrompts: "^nope",
      rejectDelayMs: 1700,
      prompts: [
        {
          match: "^work",
          once: false,
          steps: [
            { assistant: { text: "Working.", tools: [{ name: "bash", args: { command: "sleep 1" } }] } },
            { tool: { name: "bash", duration: 600, output: "ok\n" } },
            { assistant: { text: "Worked." } },
          ],
        },
      ],
    },
  });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000, "started");

    // 1. Composer send that rejects after SEND_REPLY_WAIT_MS: send returns pending, so the host restores via editorText.
    const res = await c.req("send", { text: "nope later" });
    assert.equal(res.disposition, "pending");
    await c.waitFor((x) => x.state.editorText === "nope later", 3000, "late rejection restores draft via editorText");
    await c.waitFor((x) => x.items.some((i) => i.kind === "notice" && /Rejected: nope later/.test(i.text)), 2000, "the error notice");
    assert.equal(c.items.filter((i) => i.kind === "user").length, 0, "the rejected prompt's item is gone");
    assert.equal(c.state.phase, "idle");
    await c.req("ack_editor_text");
    await c.waitFor((x) => x.state.editorText === null, 2000);

    // 2. External send (e.g. hc send) that rejects late must not land in the user's composer.
    const ext = await c.req("send", { text: "nope external", source: "external", from: "reviewer" });
    assert.equal(ext.disposition, "pending");
    await c.waitFor((x) => x.items.some((i) => i.kind === "notice" && /Rejected: nope external/.test(i.text)), 3000, "external error notice");
    assert.equal(c.state.editorText, null, "external send never populates editorText");

    // 3. A held follow-up drained by the host that rejects late is returned via editorText once (not duplicated).
    await c.req("send", { text: "work first" });
    await c.waitFor((x) => x.items.some((i) => i.kind === "tool" && i.status === "running"), 5000, "tool running");
    assert.equal((await c.req("send", { text: "nope followup", mode: "followUp" })).disposition, "queued");
    await c.waitFor((x) => x.items.some((i) => i.kind === "notice" && /Rejected: nope followup/.test(i.text)), 8000, "follow-up rejected");
    await c.waitFor((x) => x.state.editorText === "nope followup", 2000, "follow-up restored");
    await c.waitFor(idle, 5000, "the run settled");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(c.state.editorText, "nope followup", "returned once, not twice");
  } finally {
    await h.stop();
  }
});
