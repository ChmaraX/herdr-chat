// LIVE=1: /fork on the real agents (the user's logins, the cheapest models, a
// temp dir). Two words to remember, a fork before the second, then the
// question: the fork knows only the first. A wrong fork point, or a chat
// still on the old session, answers with both.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { idle, startHost, Host } from "./harness.ts";
import { codexHost } from "../fake-codex/host.ts";

const LIVE = process.env.LIVE === "1";
const last = (c: any) => c.items.filter((i: any) => i.kind === "assistant" && !i.streaming && i.text).at(-1)?.text ?? "";

async function ask(c: any, text: string): Promise<string> {
  const n = c.items.filter((i: any) => i.kind === "assistant").length;
  await c.req("send", { text });
  await c.waitFor((x: any) => idle(x) && x.items.filter((i: any) => i.kind === "assistant" && !i.streaming).length > n, 180_000, `the answer to "${text}"`);
  return last(c);
}

async function forkRecall(h: Host): Promise<void> {
  const c = h.client;
  await ask(c, "Remember the word APPLE. Reply with just OK.");
  await ask(c, "Also remember the word BANANA. Reply with just OK.");
  const { points } = await c.req("fork_points", {});
  assert.match(points[0].text, /BANANA/);
  const r = await c.req("fork", { point: points[0].id });
  assert.match(r.text, /BANANA/, "the message comes back for the composer");
  const answer = await ask(c, "Which words did I ask you to remember? Reply with the words only, in capitals.");
  assert.match(answer, /APPLE/);
  assert.doesNotMatch(answer, /BANANA/, `the fork knows only what came before: ${answer}`);
}

test("live: Claude Code forks before a message", { skip: !LIVE, timeout: 300_000 }, async () => {
  const h = await startHost({ name: "fork-live-claude", provider: "claude", agent: process.env.HERDR_CHAT_CLAUDE ?? "claude", piArgs: ["--model", "haiku"] });
  try {
    await h.client.waitFor(idle, 60_000, "claude started");
    await forkRecall(h);
    h.artifact("fork-live-claude");
  } finally {
    await h.stop();
  }
});

test("live: Codex forks before a message", { skip: !LIVE, timeout: 400_000 }, async () => {
  const h = await codexHost({ name: "fork-live-codex", agent: process.env.CODEX_BIN ?? "codex" });
  try {
    const c = h.client;
    await c.waitFor(idle, 60_000, "Codex started");
    await c.req("set_model", { provider: "openai", modelId: "gpt-5.6-luna" });
    await c.req("set_thinking", { level: "low" });
    await forkRecall(h);
    assert.equal(c.state.thinking, "low", "the fork kept the effort");
    h.artifact("fork-live-codex");
  } finally {
    await h.stop();
  }
});

test("live: Pi forks before a message", { skip: !LIVE, timeout: 300_000 }, async () => {
  const h = new Host({ name: "fork-live-pi", pi: process.env.PI_BIN ?? "pi", piArgs: [] });
  h.opts.piArgs = ["--model", "anthropic/claude-haiku-4-5", "--thinking", "low", "--session-dir", join(h.dir, "sessions")];
  await h.start();
  try {
    await h.client.waitFor(idle, 60_000, "pi started");
    await forkRecall(h);
    h.artifact("fork-live-pi");
  } finally {
    await h.stop();
  }
});
