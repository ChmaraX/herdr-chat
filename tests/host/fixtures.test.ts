// Recorded real Pi 1.5 sessions (tests/fixtures/*.jsonl), replayed by fake-pi through the real host.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startHost, idle } from "./harness.ts";

const answered = (text: RegExp) => (x: any) => idle(x) && x.items.some((i: any) => i.kind === "assistant" && text.test(i.text) && !i.streaming);

test("fixture text-only: thinking then the answer", async () => {
  const h = await startHost({ name: "fx-text", replay: "text-only.jsonl", speed: 4 });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    assert.equal(c.state.model.id, "claude-haiku-4-5");
    assert.equal(c.state.thinking, "low");
    await c.req("send", { text: "Reply with exactly: hello from pi" });
    await c.waitFor(answered(/hello from pi/), 10_000);
    assert.deepEqual(c.items.map((i) => i.kind), ["user", "thinking", "assistant"]);
    assert.equal(c.items[2].stopReason, "stop");
    await c.waitFor((x) => x.state.usage?.contextTokens > 0, 3000, "usage after the turn");
    h.artifact("fixture-text-only");
  } finally {
    await h.stop();
  }
});

test("fixture bash-read: two tools in parallel, interleaved updates, both finish", async () => {
  const h = await startHost({ name: "fx-bash", replay: "bash-read.jsonl", speed: 4 });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "Use the bash tool to run `ls`, then use the read tool on README.md, then reply with just the word done." });
    await c.waitFor(answered(/done/i), 10_000);
    const tools = c.items.filter((i) => i.kind === "tool");
    assert.deepEqual(tools.map((t) => [t.title, t.status]), [["$ ls", "done"], ["Read README.md", "done"]]);
    assert.equal(tools[0].detail.exitCode, 0);
    assert.match(tools[0].output, /README\.md/);
    assert.match(tools[1].output, /^# Fixture project/);
    await h.waitTranscript(/^· \$ ls ✓$/m);
    h.artifact("fixture-bash-read");
  } finally {
    await h.stop();
  }
});

test("fixture edit: the card carries Pi's unified patch", async () => {
  const h = await startHost({ name: "fx-edit", replay: "edit.jsonl", speed: 4 });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "Use the edit tool on notes.txt to replace the word apple with banana. Do not read it first. Then reply with just the word done." });
    await c.waitFor(answered(/done/i), 10_000);
    const edit = c.items.find((i) => i.kind === "tool");
    assert.equal(edit.title, "Edit notes.txt");
    assert.equal(edit.status, "done");
    assert.match(edit.detail.diff, /^-I like apple pie\.$/m);
    assert.match(edit.detail.diff, /^\+I like banana pie\.$/m);
    h.artifact("fixture-edit");
  } finally {
    await h.stop();
  }
});

test("fixture steer: a steer during sleep 3 lands after the tool and is answered", async () => {
  const h = await startHost({ name: "fx-steer", replay: "steer.jsonl", speed: 2 });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "Use the bash tool to run `sleep 3 && echo slept`, then reply with its output." });
    await c.waitFor((x) => x.items.some((i) => i.kind === "tool" && i.status === "running"), 10_000, "tool running");
    assert.equal((await c.req("send", { text: "Also end your reply with the word steered." })).disposition, "queued");
    await c.waitFor((x) => x.state.queue.steering.length === 1, 5000, "queued");
    await c.waitFor(answered(/steered/i), 15_000);
    assert.deepEqual(c.items.filter((i) => i.kind !== "thinking").map((i) => i.kind + (i.source ? `:${i.source}` : "")), ["user:composer", "tool", "user:queued", "assistant"]);
    h.artifact("fixture-steer");
  } finally {
    await h.stop();
  }
});

test("fixture abort: abort mid-bash with a message in Pi's queue", async () => {
  const h = await startHost({ name: "fx-abort", replay: "abort.jsonl", speed: 2 });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "Use the bash tool to run `for i in 1 2 3 4 5 6 7 8 9 10; do echo tick $i; sleep 1; done`." });
    await c.waitFor((x) => x.items.some((i) => i.kind === "tool" && /tick 2/.test(i.output)), 10_000, "ticking");
    // The recording queued it as Pi's follow-up. The host holds its own follow-ups now (queue.test.ts),
    // so it goes as a steer, which hands it to Pi's queue as the recording did.
    await c.req("send", { text: "Then say hi.", mode: "steer" });
    const { restored } = await c.req("abort");
    assert.deepEqual(restored, ["Then say hi."]);
    await c.waitFor(idle, 10_000, "idle after abort");
    const tool = c.items.find((i) => i.kind === "tool");
    assert.equal(tool.status, "error");
    assert.match(tool.output, /tick 2[\s\S]*Command aborted$/);
    assert.equal(tool.detail.exitCode, null);
    // Pi ends an aborted run with an empty assistant message.
    const last = c.items.filter((i) => i.kind === "assistant").at(-1);
    assert.equal(last.stopReason, "aborted");
    assert.equal(last.error, "This operation was aborted");
    await h.waitStatus(/^idle$/);
    h.artifact("fixture-abort");
  } finally {
    await h.stop();
  }
});

test("fixture dialog: /rpc-input outside a run, then a select from a tool_call hook", async () => {
  const h = await startHost({ name: "fx-dialog", replay: "dialog.jsonl", speed: 2 });
  try {
    const c = h.client;
    await c.waitFor((x) => idle(x) && x.state.widgets.length === 1, 10_000);
    assert.equal(c.state.title, "pi RPC Demo");
    await c.waitFor((x) => x.state.commands.some((y: any) => y.name === "rpc-input" && y.source === "extension"), 3000, "extension commands");
    void c.req("send", { text: "/rpc-input" });
    await c.waitFor((x) => x.state.dialog?.method === "input", 5000, "input");
    assert.equal(c.state.dialog.title, "Enter a value");
    await c.req("dialog_answer", { dialog: c.state.dialog.id, value: "Ada" });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.text === "You entered: Ada"), 5000, "handled");
    await c.req("send", { text: "Use the bash tool to run exactly `rm -rf ./tmpdir`. If it is blocked, reply with just the word blocked." });
    await c.waitFor((x) => x.state.dialog?.method === "select", 10_000, "select");
    assert.equal(c.state.dialog.title, "Dangerous command: rm -rf ./tmpdir");
    await h.waitStatus(/^blocked\(Dangerous command: rm -rf \.\/tmpdir\)$/);
    await c.req("dialog_answer", { dialog: c.state.dialog.id, value: "Block" });
    await c.waitFor(answered(/blocked/i), 10_000);
    const tool = c.items.find((i) => i.kind === "tool");
    assert.equal(tool.status, "error");
    assert.equal(tool.output, "Blocked by user");
    assert.ok(c.state.statuses.some((s: any) => s.key === "rpc-demo" && s.spans[0].text === "Turn 2 done"));
    h.artifact("fixture-dialog");
  } finally {
    await h.stop();
  }
});

test("fixture resume: --session history (get_messages) becomes the same items, then a new turn", async () => {
  const h = await startHost({ name: "fx-resume", replay: "resume.jsonl", speed: 4, session: "/tmp/pi-fixture/sessions/recorded.jsonl" });
  try {
    const c = h.client;
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.kind === "tool"), 10_000, "history");
    const hist = c.items.map((i) => (i.kind === "tool" ? `tool:${i.title}:${i.status}` : i.kind));
    assert.deepEqual(hist.filter((k) => k !== "thinking"), ["user", "tool:$ echo kiwi:done", "assistant"]);
    assert.equal(c.items.find((i) => i.kind === "tool").detail.exitCode, 0);
    await c.req("send", { text: "What word did the command print? Reply with just that word." });
    await c.waitFor(answered(/kiwi/i), 10_000);
    h.artifact("fixture-resume");
  } finally {
    await h.stop();
  }
});
