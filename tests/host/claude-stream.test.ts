// Claude Code: what a user sees while text and thinking stream, and the chat state around it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { idle, HERDR_HOOK_ENV } from "./harness.ts";
import { startClaude } from "../fake-claude/host.ts";

test("claude: thinking then text stream into items; state shows the provider, model, effort, mode and usage", async () => {
  const h = await startClaude({
    name: "claude-stream", speed: 0.5,
    scenario: { turns: [{ match: "pelican", steps: [{ thinking: "The user wants a pelican fact. Keep it short." }, { text: "Pelicans have a throat pouch that holds about **11 litres** of water.\n\n```js\nconst pouch = 11;\n```" }] }] },
    args: ["--model", "haiku"],
    env: HERDR_HOOK_ENV,
  });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000, "started");
    const s = c.state;
    assert.equal(s.provider, "claude");
    assert.equal(s.providerName, "Claude Code");
    assert.equal(s.piVersion, "2.1.303");
    assert.deepEqual(s.model && { id: s.model.id, name: s.model.name, provider: s.model.provider }, { id: "haiku", name: "Haiku 5.5", provider: "anthropic" });
    assert.deepEqual(s.capabilities.thinkingLevels, ["low", "medium", "high"], "the model's own effort levels");
    assert.equal(s.capabilities.permissions, true);
    assert.deepEqual(s.capabilities.permissionModes.map((m: any) => m.id), ["default", "acceptEdits", "plan", "auto"]);
    assert.equal(s.permissionMode, "default");
    assert.match(s.sessionFile, /claude-config\/projects\/.+\/[0-9a-f-]{36}\.jsonl$/);
    assert.ok(s.commands.some((x: any) => x.name === "review"), "the agent's commands are in the menu");
    assert.ok(!s.commands.some((x: any) => x.name === "doctor"), "terminal-only commands are hidden");

    await c.req("send", { text: "Tell me a pelican fact" });
    // While it streams: a thinking item first, then the answer growing.
    await c.waitFor((x) => x.items.some((i) => i.kind === "thinking" && i.streaming && i.text.length > 0), 5000, "thinking streams");
    await c.waitFor((x) => x.items.some((i) => i.kind === "assistant" && i.streaming && i.text.length > 0), 5000, "text streams");
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.kind === "assistant" && !i.streaming), 5000, "settled");
    const kinds = c.items.map((i) => i.kind);
    assert.deepEqual(kinds, ["user", "thinking", "assistant"]);
    const [user, thinking, answer] = c.items;
    assert.equal(user.source, "composer");
    assert.equal(thinking.text, "The user wants a pelican fact. Keep it short.");
    assert.equal(thinking.streaming, false);
    assert.match(answer.text, /^Pelicans have a throat pouch/);
    assert.equal(answer.stopReason, "stop");
    assert.equal(answer.model, "claude-haiku-5-5");
    assert.ok(answer.usage && answer.usage.output > 0, "usage on the answer");
    assert.ok(answer.blocks.some((b: any) => b.type === "code" && b.lang === "js"), "code blocks are split out and highlighted like Pi's");
    await c.waitFor((x) => x.state.usage?.cost > 0 && x.state.usage.contextTokens > 0, 3000, "usage after the turn");
    assert.equal(c.state.usage.contextWindow, 1000000);
    assert.ok(c.state.usage.cost > 0);
    // The CLI got the recommended argv and env.
    const start = h.inputs()[0];
    for (const f of ["--input-format", "--include-partial-messages", "--replay-user-messages", "--permission-prompt-tool", "--thinking-display"]) assert.ok(start.argv.includes(f), f);
    assert.equal(start.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS, "1");
    assert.deepEqual([start.env.HERDR_PANE_ID, start.env.HERDR_SOCKET_PATH, start.env.HERDR_ENV], [null, null, null], "Herdr's hook variables are stripped");
    const prompt = h.inputs().find((r) => r.type === "user");
    assert.equal(prompt.priority, "next", "priority is always set");
    assert.match(prompt.uuid, /^[0-9a-f-]{36}$/);
    await h.waitStatus(/^done/);
    assert.ok(h.statuses.some((x) => x.startsWith("working")));
    assert.match(h.screen, /\u001b\]7501;state=done:app=claude/);
    await h.waitTranscript(/^Pelicans have a throat pouch/m);
    h.artifact("claude-stream");
  } finally {
    await h.stop();
  }
});
