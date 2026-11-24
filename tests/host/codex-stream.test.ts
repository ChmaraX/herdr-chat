// Codex through the real host: streaming text and thinking, what the chat shows for a turn.
import { test } from "node:test";
import assert from "node:assert/strict";
import { idle } from "./harness.ts";
import { codexHost } from "../fake-codex/host.ts";

const answered = (text: RegExp) => (x: any) => idle(x) && x.items.some((i: any) => i.kind === "assistant" && text.test(i.text) && !i.streaming);

test("codex: thinking and text stream into their items, then the turn settles with model, usage and capabilities", async () => {
  const long = "Here is a longer answer that streams in small chunks, so the chat sees it grow. ".repeat(6);
  const h = await codexHost({
    name: "cx-stream", speed: 1,
    // Thinking streams for about half a second (11 chunks, 40 ms apart): long past the host's 50 ms batching,
    // so a slow machine still sees it mid-stream.
    scenario: { prompts: [{ match: "explain", steps: [{ reasoning: ["**Planning the answer**", "Checking the details"], chunk: 4, every: 40 }, { text: long, chunk: 6, every: 15 }] }] },
  });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    assert.equal(c.state.provider, "codex");
    assert.equal(c.state.providerName, "Codex");
    assert.equal(c.state.agentVersion, "0.163.0");
    assert.deepEqual(c.state.model, { provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6-Luna", reasoning: true, contextWindow: null, input: ["text", "image"] });
    assert.equal(c.state.thinking, "low");
    const caps = c.state.capabilities;
    assert.deepEqual(caps.thinkingLevels, ["low", "medium", "high", "xhigh", "max"]);
    assert.equal(caps.steer, true);
    assert.equal(caps.followUp, true);
    assert.equal(caps.permissions, true);
    assert.equal(caps.extensionUi, false);
    assert.equal(caps.cost, false);
    assert.equal(caps.images, true);
    assert.equal(caps.tui, true);
    assert.deepEqual(caps.permissionModes.map((m: any) => m.id), ["untrusted", "read-only", "auto", "auto-review", "full", "plan"]);
    assert.equal(c.state.permissionMode, "auto");
    assert.equal(c.state.sessionFile, null, "no rollout before the first turn");

    // Watch before sending: the streaming states are passing, and a watcher started after `send` returns can miss them.
    let workingWhileStreaming = false;
    const thinkingStreams = c.waitFor((x) => x.items.some((i) => i.kind === "thinking" && i.streaming && i.text.length > 0), 5000, "thinking streams");
    const textStreams = c.waitFor((x) => {
      const streaming = x.items.some((i) => i.kind === "assistant" && i.streaming && i.text.length > 10 && i.text.length < long.length);
      if (streaming) workingWhileStreaming = x.state.phase === "working";
      return streaming;
    }, 5000, "text streams");
    await c.req("send", { text: "Please explain streaming" });
    await thinkingStreams;
    await textStreams;
    assert.ok(workingWhileStreaming, "the chat is working while the answer streams");
    await c.waitFor(answered(/longer answer/), 10_000);
    const [user, thinking, assistant] = c.items;
    assert.deepEqual(c.items.map((i) => i.kind), ["user", "thinking", "assistant"]);
    assert.equal(user.source, "composer");
    assert.equal(thinking.text, "**Planning the answer**\n\nChecking the details");
    assert.equal(thinking.streaming, false);
    assert.equal(assistant.text, long);
    assert.equal(assistant.stopReason, "stop");
    assert.equal(assistant.model, "openai/gpt-5.6-luna");
    assert.ok(assistant.usage.input > 0 && assistant.usage.cost === null, "usage without cost");
    await c.waitFor((x) => x.state.usage?.contextTokens > 0 && x.state.usage.contextWindow === 258400, 3000, "context usage");
    assert.equal(c.state.usage.cost, null);
    assert.equal(c.state.model.contextWindow, 258400);
    assert.match(c.state.sessionFile, /rollout-.*\.jsonl$/, "the rollout is the session file once the first turn ran");
    await h.waitStatus(/^done/);
    assert.ok(h.statuses.includes("working"));
    assert.match(h.screen, /\u001b\]7501;state=done:app=codex/);
    await h.waitTranscript(/^> Please explain streaming$/m);
    h.artifact("codex-stream");
  } finally {
    await h.stop();
  }
});

test("codex: commentary, a tool and the final answer of one turn are separate items in order; empty reasoning is dropped", async () => {
  const h = await codexHost({
    name: "cx-order",
    scenario: {
      prompts: [{
        match: "count",
        steps: [
          { reasoning: [] },
          { text: "I'll count the files first.", phase: "commentary" },
          { command: "ls | wc -l", output: "3\n", actions: [{ type: "unknown", command: "ls | wc -l" }] },
          { reasoning: [] },
          { text: "There are 3 files." },
        ],
      }],
    },
  });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "count the files" });
    await c.waitFor(answered(/3 files/), 10_000);
    assert.deepEqual(c.items.map((i) => i.kind), ["user", "assistant", "tool", "assistant"]);
    assert.equal(c.items[1].text, "I'll count the files first.");
    assert.equal(c.items[1].stopReason, "toolUse");
    assert.equal(c.items[2].title, "$ ls | wc -l");
    const u = c.items.filter((i) => i.kind === "assistant").map((i) => i.usage?.output ?? 0);
    assert.ok(u[1]! > 0);
    h.artifact("codex-turn-order");
  } finally {
    await h.stop();
  }
});

test("codex fixture reasoning-websearch (11): summaries stream as thinking, a web search card, three turns", async () => {
  const h = await codexHost({ name: "cx-fx-web", replay: "reasoning-websearch.jsonl", speed: 8 });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "Think step by step, then answer: what is 17*23? Reply with only the number." });
    await c.waitFor(answered(/391/), 10_000);
    await c.req("send", { text: "First call your plan tool (update_plan) with a 3-step plan for writing a haiku about rain, update it as you complete each step, then write the haiku. Do not use the shell." });
    await c.waitFor(answered(/Puddles/), 10_000);
    const thinking = c.items.filter((i) => i.kind === "thinking");
    assert.equal(thinking[0].text, "**Noting unavailable plan update tool**\n\n**Deciding to respond with haiku only**");
    await c.req("send", { text: "Use web search to find the current stable version of Node.js listed on nodejs.org. Reply in one line." });
    await c.waitFor(answered(/Node\.js v26/), 10_000);
    const web = c.items.find((i) => i.kind === "tool" && i.name === "webSearch");
    assert.equal(web.title, "Search the web for site:nodejs.org current stable version Node.js");
    assert.deepEqual(web.detail, { type: "web", tool: "search", query: "site:nodejs.org current stable version Node.js" });
    assert.equal(web.status, "done");
    assert.match(web.output, /nodejs\.org/);
    h.artifact("codex-fixture-reasoning-websearch");
  } finally {
    await h.stop();
  }
});

test("codex: an image prompt goes as a localImage and shows on the user item; a text-only model gets the path instead", async () => {
  const { writeFileSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const h = await codexHost({ name: "cx-image", scenario: { default: [{ text: "red" }] } });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    const png = join(h.dir, "red.png");
    writeFileSync(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
    await c.req("send", { text: "What colour?", images: [png] });
    await c.waitFor(answered(/red/), 5000);
    const input = h.requests("turn/start")[0].params.input;
    assert.deepEqual(input.map((p: any) => p.type), ["text", "localImage"]);
    assert.deepEqual(readFileSync(input[1].path), readFileSync(png));
    const user = c.items.find((i) => i.kind === "user");
    assert.equal(user.images, 1);
    assert.equal(user.imagePaths.length, 1);

    await c.req("set_model", { provider: "openai", modelId: "gpt-text-only" });
    await c.waitFor((x) => x.state.capabilities.images === false, 3000);
    await c.req("send", { text: "And now?", images: [png] });
    await c.waitFor((x) => idle(x) && x.items.filter((i) => i.kind === "assistant").length === 2, 5000);
    const second = h.requests("turn/start")[1].params.input;
    assert.deepEqual(second.map((p: any) => p.type), ["text"]);
    assert.match(second[0].text, /\[Image available at: .*red\.png\]/);
    h.artifact("codex-image-prompt");
  } finally {
    await h.stop();
  }
});
