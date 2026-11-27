// ClaudeBackground on its own: Claude Code's background_tasks_changed and
// task_started records → the list the chat shows above the composer.
// Records as Claude Code 2.1 sends them (recorded 2026-11-27).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeBackground } from "../../host/providers/claude/background.ts";

const changed = (tasks: unknown[]) => ({ type: "system", subtype: "background_tasks_changed", tasks });
const started = (task_id: string, tool_use_id: string, extra: object = {}) =>
  ({ type: "system", subtype: "task_started", task_id, tool_use_id, is_backgrounded: true, ...extra });

const BASH = { task_id: "bnyns351x", run_id: "r1", task_type: "local_bash", description: "Sleep 25 seconds then echo bash-done" };
const MONITOR = { task_id: "bla262e2d", run_id: "r2", task_type: "local_bash", description: "Tick counter three times" };
const AGENT = { task_id: "a0911dac5f01e4231", run_id: "r3", task_type: "local_agent", subagent_type: "general-purpose", description: "Count to three" };

function setup(tools: Record<string, string> = {}) {
  let now = 1_000;
  const bg = new ClaudeBackground((callId) => tools[callId], () => now);
  return { bg, tick: (ms: number) => { now += ms; } };
}

test("background_tasks_changed: each task with what runs it, what it does, and when it was first seen", () => {
  const { bg, tick } = setup();
  assert.deepEqual(bg.onSystem(changed([BASH])), [
    { id: "bnyns351x", kind: "Bash", label: "Sleep 25 seconds then echo bash-done", startedAt: 1_000 },
  ]);
  tick(5_000);
  const two = bg.onSystem(changed([BASH, AGENT]));
  assert.deepEqual(two, [
    { id: "bnyns351x", kind: "Bash", label: "Sleep 25 seconds then echo bash-done", startedAt: 1_000 },
    { id: "a0911dac5f01e4231", kind: "general-purpose agent", label: "Count to three", startedAt: 6_000 },
  ], "a task keeps the time it was first seen");
  assert.deepEqual(bg.onSystem(changed([AGENT])), [two![1]], "a finished task leaves the list");
  assert.deepEqual(bg.onSystem(changed([])), [], "an empty list clears it");
  assert.deepEqual(bg.tasks, []);
});

test("task_started names the tool that started a task: a Monitor is a local_bash task too", () => {
  const { bg } = setup({ toolu_mon: "Monitor", toolu_bash: "Bash" });
  assert.equal(bg.onSystem(changed([BASH, MONITOR]))![1]!.kind, "Bash", "before task_started, by its task_type");
  const after = bg.onSystem(started(MONITOR.task_id, "toolu_mon"));
  assert.equal(after![1]!.kind, "Monitor");
  assert.equal(bg.onSystem(started(BASH.task_id, "toolu_bash")), null, "nothing changed: no new list");
});

test("task_started before the task is listed is remembered for when it is", () => {
  const { bg } = setup({ toolu_mon: "Monitor" });
  assert.equal(bg.onSystem(started(MONITOR.task_id, "toolu_mon")), null, "a task not in the list changes nothing");
  assert.equal(bg.onSystem(changed([MONITOR]))![0]!.kind, "Monitor");
});

test("an agent is named by its subagent type; other task types by a readable name", () => {
  const { bg } = setup();
  const list = bg.onSystem(changed([
    { task_id: "a1", task_type: "local_agent", description: "Review" },
    { task_id: "w1", task_type: "local_workflow", description: "Fan out" },
    { task_id: "x1", task_type: "something_new" },
  ]));
  assert.deepEqual(list!.map((t) => [t.kind, t.label]), [["Agent", "Review"], ["Workflow", "Fan out"], ["something_new", "something_new"]]);
});

test("malformed records change nothing; tasks without an id are skipped", () => {
  const { bg } = setup();
  bg.onSystem(changed([BASH]));
  assert.equal(bg.onSystem({ type: "system", subtype: "background_tasks_changed" }), null, "no tasks array");
  assert.equal(bg.onSystem({ type: "system", subtype: "background_tasks_changed", tasks: "x" }), null);
  assert.equal(bg.onSystem({ type: "system", subtype: "task_notification", task_id: BASH.task_id, status: "completed" }), null, "only the list says what runs");
  assert.deepEqual(bg.onSystem(changed([null, { description: "no id" }, BASH, 5])), null, "the same one task: unchanged");
  assert.equal(bg.tasks.length, 1);
});

test("the same list again is not a change", () => {
  const { bg, tick } = setup();
  bg.onSystem(changed([BASH]));
  tick(1_000);
  assert.equal(bg.onSystem(changed([BASH])), null);
});

test("reset: the agent's process is gone, and its tasks with it", () => {
  const { bg, tick } = setup();
  assert.equal(bg.reset(), null, "nothing to clear");
  bg.onSystem(changed([BASH]));
  assert.deepEqual(bg.reset(), []);
  assert.deepEqual(bg.tasks, []);
  tick(10_000);
  assert.equal(bg.onSystem(changed([BASH]))![0]!.startedAt, 11_000, "seen again after a reset: a new start time");
});

test("the list handed out is a copy: changing it doesn't change the tracker", () => {
  const { bg } = setup();
  const list = bg.onSystem(changed([BASH]))!;
  (list as unknown as object[]).push({});
  assert.equal(bg.tasks.length, 1);
});
