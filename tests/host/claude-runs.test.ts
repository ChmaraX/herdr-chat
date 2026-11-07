// Claude Code runs: abort mid-tool with a queue, steer and follow-up mid-run,
// model/effort/permission-mode switching, a crash, a stall, a wedged CLI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { idle, sleep } from "./harness.ts";
import { startClaude } from "../fake-claude/host.ts";

const ticking = (n: number, everyMs = 400) => ({ tool: "Bash", ask: false, input: { command: "make build", description: "Build" }, task: { lines: Array.from({ length: n }, (_, i) => `compiling unit ${i + 1}`), everyMs } });

test("claude: abort mid-tool with a steer and a follow-up queued: both come back, the tool is stopped, nothing runs after", async () => {
  const h = await startClaude({ name: "claude-abort", speed: 1, scenario: { turns: [{ match: "Build", steps: [ticking(20), { text: "Built." }] }, { match: "quick", steps: [{ text: "Quick answer." }] }] } });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "Build it" });
    await c.waitFor((x) => x.items.some((i) => i.kind === "tool" && i.status === "running" && i.output.includes("unit 2")), 8000, "tool ticking");
    await c.req("send", { text: "quick: then run the tests", mode: "followUp" });
    await c.req("send", { text: "quick: and use verbose output" });
    await c.waitFor((x) => x.state.queue.followUp.length === 1 && x.state.queue.steering.length === 1, 2000, "two queued");
    const { restored } = await c.req("abort");
    assert.deepEqual(restored.sort(), ["quick: and use verbose output", "quick: then run the tests"]);
    await c.waitFor(idle, 5000, "idle after abort");
    await sleep(500);
    assert.equal(c.state.phase, "idle");
    const tool = c.items.find((i) => i.kind === "tool");
    assert.equal(tool.status, "error");
    // The live output the card showed stays, with the CLI's rejection under it (as Pi and Codex keep theirs).
    assert.match(tool.output, /^compiling unit 1\ncompiling unit 2\n(compiling unit \d+\n)*The user doesn't want to proceed with this tool use\./);
    assert.ok(!c.items.some((i) => i.text === "Quick answer."), "no queued run after the abort");
    assert.equal(c.items.filter((i) => i.kind === "user").length, 1, "queued texts never became timeline items");
    assert.deepEqual(c.state.queue, { steering: [], followUp: [] });
    const interrupt = h.controls("interrupt");
    assert.equal(interrupt.length, 1);
    assert.equal(interrupt[0].request.cancel_queued, true);
    await h.waitStatus(/^idle$/);
    h.artifact("claude-abort");
  } finally {
    await h.stop();
  }
});

test("claude: a steer folds into the running turn at the next tool boundary; a follow-up (held by the host) runs after it", async () => {
  const h = await startClaude({
    name: "claude-steer", speed: 1,
    scenario: { turns: [{ match: "Build", steps: [ticking(4, 300), { text: "Built. Also: {steers}" }] }, { match: "after", steps: [{ text: "And now: {prompt}" }] }] },
  });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "Build it" });
    await c.waitFor((x) => x.items.some((i) => i.kind === "tool" && i.status === "running"), 5000);
    await c.req("send", { text: "say BANANA" });
    await c.req("send", { text: "after that, list files", mode: "followUp" });
    await c.waitFor((x) => x.state.queue.steering.length === 1 && x.state.queue.followUp.length === 1, 2000, "queued");
    await c.waitFor((x) => idle(x) && x.items.some((i) => /^And now/.test(i.text ?? "")), 10_000, "both done");
    const seen = c.items.filter((i) => i.kind !== "thinking").map((i) => i.kind + (i.kind === "user" ? `:${i.source}:${i.text}` : i.kind === "assistant" ? `:${i.text}` : ""));
    assert.deepEqual(seen, [
      "user:composer:Build it",
      "tool",
      "user:queued:say BANANA",
      "assistant:Built. Also: say BANANA",
      "user:queued:after that, list files",
      "assistant:And now: after that, list files",
    ]);
    // The host holds the follow-up and sends it as a prompt once the turn's run settled: never the CLI's "later".
    const prompts = h.inputs().filter((r) => r.type === "user");
    assert.deepEqual(prompts.map((p) => p.priority), ["next", "next", "next"]);
    assert.deepEqual(c.state.queue, { steering: [], followUp: [] });
    // One run from the user's view: working once, then done.
    assert.deepEqual(h.statuses.filter((s, i, a) => s.replace(/\(.*/, "") !== a[i - 1]?.replace(/\(.*/, "")).map((s) => s.replace(/\(.*/, "")), ["idle", "working", "done"]);
    h.artifact("claude-steer-followup");
  } finally {
    await h.stop();
  }
});

test("claude: model, effort and permission mode switch live and reach the CLI", async () => {
  const h = await startClaude({ name: "claude-settings", speed: 4, scenario: { default: [{ text: "model={model} effort={effort} mode={mode}" }] } });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    const { models } = await c.req("models");
    assert.deepEqual(models.map((m: any) => m.id), ["default", "opus", "sonnet", "haiku"]);
    assert.deepEqual(models[2], { provider: "anthropic", id: "sonnet", name: "Sonnet 5.5", reasoning: true, enabled: true });
    await c.req("set_model", { provider: "anthropic", modelId: "haiku" });
    await c.waitFor((x) => x.state.model?.id === "haiku", 2000);
    assert.equal(c.state.model.name, "Haiku 5.5");
    assert.deepEqual(c.state.capabilities.thinkingLevels, ["low", "medium", "high"]);
    await c.req("send", { text: "/model anthropic/sonnet" });
    await c.waitFor((x) => x.state.model?.id === "sonnet", 2000);
    assert.deepEqual(c.state.capabilities.thinkingLevels, ["low", "medium", "high", "xhigh", "max"]);
    await c.req("set_thinking", { level: "xhigh" });
    assert.equal(c.state.thinking, "xhigh");
    await assert.rejects(c.req("set_thinking", { level: "off" }), /effort levels/);
    await c.req("set_permission_mode", { mode: "acceptEdits" });
    await c.waitFor((x) => x.state.permissionMode === "acceptEdits", 2000);
    await assert.rejects(c.req("set_permission_mode", { mode: "yolo" }), /Not one of the permission modes/);
    await c.req("send", { text: "what are you?" });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.kind === "assistant"), 5000);
    assert.equal(c.items.find((i) => i.kind === "assistant").text, "model=sonnet effort=xhigh mode=acceptEdits");
    assert.equal(c.items.find((i) => i.kind === "assistant").model, "claude-sonnet-5-5");
    assert.deepEqual(h.controls("apply_flag_settings").map((r) => r.request.settings), [{ effortLevel: "xhigh" }]);
    await c.req("set_name", { name: "Pelican research" });
    await c.waitFor((x) => x.state.sessionName === "Pelican research", 2000);
    await h.waitTitle("Pelican research");
    h.artifact("claude-settings");
  } finally {
    await h.stop();
  }
});

test("claude: a crash mid-run shows the error; the next message restarts the CLI on the same session", async () => {
  const h = await startClaude({
    name: "claude-crash", speed: 4,
    scenario: { turns: [{ match: "first", once: true, steps: [{ text: "First answer." }] }, { match: "crash", once: true, steps: [ticking(2, 100), { crash: 3, stderr: "fatal: lost the API connection\n" }] }], default: [{ text: "Back: {prompt}" }] },
  });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "first" });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.text === "First answer."), 5000);
    const file = c.state.sessionFile;
    await c.req("send", { text: "now crash" });
    await c.waitFor((x) => x.state.phase === "exited", 8000, "exited");
    assert.match(c.state.error, /Claude Code exited \(code 3\): fatal: lost the API connection/);
    await h.waitStatus(/^error/);
    assert.ok(c.items.every((i) => !(i.kind === "tool" && (i.status === "running" || i.status === "pending"))), "open tools closed");
    await c.req("send", { text: "are you back?" });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.text === "Back: are you back?"), 10_000, "restarted");
    assert.equal(c.state.sessionFile, file);
    const starts = h.inputs().filter((r) => r.type === "_start");
    assert.equal(starts.length, 2);
    assert.ok(starts[1].argv.includes("--resume"), "resumed the same session");
    assert.equal(starts[1].argv[starts[1].argv.indexOf("--resume") + 1], file.replace(/^.*\//, "").replace(/\.jsonl$/, ""));
    assert.ok(c.items.some((i) => i.text === "First answer."), "the history came back from the transcript");
    h.artifact("claude-crash");
  } finally {
    await h.stop();
  }
});

test("claude: a stall gets a warning and Esc recovers; a CLI that ignores the interrupt is stopped and restarted", async () => {
  const h = await startClaude({
    name: "claude-stall", speed: 1,
    env: { HERDR_CHAT_CLAUDE_STALL_MS: "700", HERDR_CHAT_CLAUDE_INTERRUPT_MS: "800" },
    scenario: { turns: [{ match: "stall", once: true, steps: [{ hang: true }] }, { match: "wedge", once: true, steps: [{ hang: true, ignoreInterrupt: true }] }], default: [{ text: "ok: {prompt}" }] },
  });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "stall please" });
    await c.waitFor((x) => x.items.some((i) => i.kind === "notice" && /hasn't sent anything for \d+ s/.test(i.text)), 4000, "stall warning");
    assert.equal(c.state.phase, "working");
    await c.req("abort");
    await c.waitFor(idle, 3000, "Esc ended it");
    await c.req("send", { text: "still there?" });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.text === "ok: still there?"), 5000);
    assert.equal(h.inputs().filter((r) => r.type === "_start").length, 1, "same process");
  } finally {
    await h.stop();
  }
  const w = await startClaude({
    name: "claude-wedged", speed: 1,
    env: { HERDR_CHAT_CLAUDE_STALL_MS: "60000", HERDR_CHAT_CLAUDE_INTERRUPT_MS: "800" },
    scenario: { ignoreInterrupt: true, turns: [{ match: "wedge", once: true, steps: [{ hang: true, ignoreInterrupt: true }] }], default: [{ text: "ok: {prompt}" }] },
  });
  try {
    const c = w.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "wedge yourself" });
    await sleep(300);
    await c.req("abort");
    await c.waitFor((x) => x.items.some((i) => i.kind === "notice" && /didn't stop when asked/.test(i.text)), 3000);
    await c.waitFor((x) => x.state.phase === "exited", 3000, "stopped");
    await c.req("send", { text: "hello again" });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.text === "ok: hello again"), 10_000, "restarted");
    w.artifact("claude-wedged");
  } finally {
    await w.stop();
  }
});

test("claude: an API error (signed out) ends the turn with the error and a sign-in hint; OSC reports error", async () => {
  const h = await startClaude({ name: "claude-api-error", speed: 4, scenario: { default: [{ apiError: "authentication_failed", text: "Invalid API key · Please run /login" }] } });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "hello?" });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.kind === "assistant" && i.stopReason === "error"), 5000);
    const a = c.items.find((i) => i.kind === "assistant");
    assert.match(a.error, /^Invalid API key · Please run \/login Sign in with `claude auth login`/);
    assert.equal(c.items.filter((i) => i.kind === "assistant").length, 1, "one error, not one per record");
    await h.waitStatus(/^error/);
  } finally {
    await h.stop();
  }
});

test("claude: a turn nobody sent (a background task wakes the agent) shows as an autonomous run", async () => {
  const h = await startClaude({
    name: "claude-autonomous", speed: 4,
    scenario: { turns: [{ match: "^start", steps: [{ text: "Started a watcher." }, { autonomous: "<task-notification>build finished</task-notification>", afterMs: 600 }] }, { match: "task-notification", steps: [{ text: "The build finished." }] }] },
  });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "start watching" });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.text === "The build finished."), 8000, "the autonomous turn");
    const notice = c.items.find((i) => i.kind === "notice" && i.source === "host");
    assert.equal(notice.text, "Started by a background task.");
    const wake = c.items.find((i) => i.kind === "user" && /task-notification/.test(i.text));
    assert.equal(wake.source, "extension", "not the user's message");
    assert.equal(c.items.find((i) => i.text === "The build finished.").autonomous, true);
  } finally {
    await h.stop();
  }
});
