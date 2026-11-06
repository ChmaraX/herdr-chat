import { test } from "node:test";
import assert from "node:assert/strict";
import { startHost, idle, sleep } from "./harness.ts";

test("steer during a tool: queued in the strip, then delivered once as a queued user message", async () => {
  const h = await startHost({ name: "steer", scenario: "steer.json", speed: 2 });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "Sleep, then report" });
    await c.waitFor((x) => x.items.some((i) => i.kind === "tool" && i.status === "running"), 5000, "tool running");
    const r = await c.req("send", { text: "Actually, stop sleeping and list files" });
    assert.equal(r.disposition, "queued");
    await c.waitFor((x) => x.state.queue.steering.length === 1, 2000, "queue strip");
    assert.deepEqual(c.state.queue.steering, ["Actually, stop sleeping and list files"]);
    assert.equal(c.items.filter((i) => i.kind === "user").length, 1, "not in the timeline while queued");
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.kind === "assistant" && i.text.startsWith("Slept.")), 10_000, "answer");
    const users = c.items.filter((i) => i.kind === "user");
    assert.deepEqual(users.map((u) => [u.text, u.source]), [
      ["Sleep, then report", "composer"],
      ["Actually, stop sleeping and list files", "queued"],
    ]);
    // The steer lands after the tool, before the next model call.
    const kinds = c.items.map((i) => i.kind);
    assert.deepEqual(kinds, ["user", "assistant", "tool", "user", "assistant"]);
    assert.deepEqual(c.state.queue, { steering: [], followUp: [] });
    const sent = h.piCommands().filter((x) => x.type === "prompt");
    assert.equal(sent[1].streamingBehavior, "steer");
    h.artifact("steer-during-tool");
  } finally {
    await h.stop();
  }
});

test("abort mid-tool with a queue: clear_queue then abort, queued text restored, nothing runs after", async () => {
  const h = await startHost({ name: "abort", scenario: "abort.json", speed: 1 });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "Build it" });
    await c.waitFor((x) => x.items.some((i) => i.kind === "tool" && i.status === "running" && i.output.includes("unit 2")), 5000, "tool ticking");
    await c.req("send", { text: "quick: then run the tests", mode: "followUp" });
    await c.req("send", { text: "quick: and use verbose output" });
    await c.waitFor((x) => x.state.queue.followUp.length === 1 && x.state.queue.steering.length === 1, 2000, "two queued");
    const { restored } = await c.req("abort");
    assert.deepEqual(restored.sort(), ["quick: and use verbose output", "quick: then run the tests"]);
    await c.waitFor(idle, 5000, "idle after abort");
    await sleep(400); // Would a queued message start a new run?
    assert.equal(c.state.phase, "idle");
    const tool = c.items.find((i) => i.kind === "tool");
    assert.equal(tool.status, "error");
    assert.match(tool.output, /compiling unit 2[\s\S]*Command aborted/);
    assert.ok(!c.items.some((i) => i.kind === "assistant" && i.text === "Quick answer."), "no queued run after the abort");
    assert.equal(c.items.filter((i) => i.kind === "user").length, 1, "queued texts never became timeline items");
    assert.deepEqual(c.state.queue, { steering: [], followUp: [] });
    const types = h.piCommands().map((x) => x.type);
    const ci = types.indexOf("clear_queue");
    assert.ok(ci >= 0 && types.indexOf("abort") > ci, `clear_queue before abort: ${types.join(",")}`);
    await h.waitStatus(/^idle$/);
    await h.waitTranscript(/^· \$ make build ✗$/m);
    h.artifact("abort-mid-tool-with-queue");
  } finally {
    await h.stop();
  }
});

test("Esc while a dialog is open cancels the dialog and stops the run", async () => {
  const h = await startHost({ name: "abort-dialog", scenario: "dialogs.json", speed: 1 });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "Delete the build folder" });
    await c.waitFor((x) => x.state.dialog?.method === "select", 5000, "select open");
    await c.req("abort");
    await c.waitFor((x) => idle(x) && x.state.dialog === null, 5000, "idle, no dialog");
    const answered = h.piCommands().filter((x) => x.type === "extension_ui_response");
    assert.ok(answered.length >= 1 && answered.every((x) => x.cancelled === true), "every open dialog cancelled");
    assert.equal(answered[0].id, "dlg-1", "the select first");
    h.artifact("abort-cancels-dialog");
  } finally {
    await h.stop();
  }
});

test("a subagent report (hc send) mid-run is queued with its sender, then lands as a user item from it", async () => {
  const h = await startHost({ name: "steer-report", scenario: "steer.json", speed: 2 });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "Sleep, then report" });
    await c.waitFor((x) => x.items.some((i) => i.kind === "tool" && i.status === "running"), 5000, "tool running");
    h.writeStdin('\u001b[200~<hc from="t7 review">Two bugs in x.rs</hc>\u001b[201~\r');
    await c.waitFor((x) => x.state.queue.steering.length === 1, 2000, "queue strip");
    const q = c.state.queue;
    assert.deepEqual([q.steering, q.steeringFrom, q.followUp, q.followUpFrom], [["Two bugs in x.rs"], ["t7 review"], [], []]);
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.kind === "assistant" && i.text.startsWith("Slept.")), 10_000, "answer");
    const report = c.items.find((i) => i.kind === "user" && i.text === "Two bugs in x.rs");
    assert.deepEqual([report.source, report.from], ["queued", "t7 review"]);
    assert.deepEqual(c.state.queue, { steering: [], followUp: [] });
    h.artifact("steer-report");
  } finally {
    await h.stop();
  }
});
