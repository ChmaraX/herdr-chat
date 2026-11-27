// What the agent left running in the background (state.background) through the
// real host: Claude Code's background_tasks_changed and task_started, as the
// strip above the composer shows them. The records' shapes are Claude Code
// 2.1's (background-unit.test.ts has the recorded ones).
import { test } from "node:test";
import assert from "node:assert/strict";
import { idle } from "./harness.ts";
import { startClaude } from "../fake-claude/host.ts";

const answered = (text: string) => (x: any) => idle(x) && x.items.some((i: any) => i.kind === "assistant" && i.text === text && !i.streaming);

const changed = (tasks: object[]) => ({ emit: { type: "system", subtype: "background_tasks_changed", tasks } });
const WATCH = { task_id: "bla262e2d", run_id: "r1", task_type: "local_bash", description: "Watch the deploys every 30 s" };
const AGENT = { task_id: "a0911dac5f01e4231", run_id: "r2", task_type: "local_agent", subagent_type: "Explore", description: "Find the callers" };

test("claude: background tasks show while they run, past the end of the run, and go when they end or the agent restarts", async () => {
  const h = await startClaude({
    name: "claude-background",
    speed: 4,
    scenario: {
      turns: [
        {
          match: "watch",
          steps: [
            // As Claude Code sends it: the Monitor call, the list, then task_started naming the call.
            { tool: "Monitor", ask: false, input: { command: "until deployed; do sleep 30; done", description: WATCH.description, timeout_ms: 600000 },
              result: { content: "Monitor started (task bla262e2d)." } },
            changed([WATCH]),
            { emit: { type: "system", subtype: "task_started", task_id: WATCH.task_id, tool_use_id: "{lastToolId}", description: WATCH.description, is_backgrounded: true, task_type: "local_bash" } },
            { text: "watching" },
          ],
        },
        { match: "agent", steps: [changed([WATCH, AGENT]), { text: "agent too" }] },
        { match: "done", steps: [changed([AGENT]), changed([]), { text: "all done" }] },
        { match: "again", steps: [changed([WATCH]), { text: "again" }] },
      ],
    },
  });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    assert.deepEqual(c.state.background, [], "nothing running before the first run");

    const before = Date.now();
    await c.req("send", { text: "watch" });
    await c.waitFor(answered("watching"), 10_000);
    const [watch] = c.state.background;
    assert.deepEqual({ ...watch, startedAt: 0 }, { id: WATCH.task_id, kind: "Monitor", label: WATCH.description, startedAt: 0 }, "named by the tool that started it");
    assert.ok(watch.startedAt >= before && watch.startedAt <= Date.now());
    assert.equal(c.state.phase, "idle", "the run is over, the task still shows");

    await c.req("send", { text: "agent" });
    await c.waitFor(answered("agent too"), 10_000);
    assert.deepEqual(c.state.background.map((t: any) => [t.id, t.kind, t.label]), [
      [WATCH.task_id, "Monitor", WATCH.description],
      [AGENT.task_id, "Explore agent", AGENT.description],
    ]);
    assert.equal(c.state.background[0].startedAt, watch.startedAt, "a task keeps its start across lists");

    await c.req("send", { text: "done" });
    await c.waitFor(answered("all done"), 10_000);
    assert.deepEqual(c.state.background, []);

    await c.req("send", { text: "again" });
    await c.waitFor(answered("again"), 10_000);
    assert.equal(c.state.background.length, 1);
    const file = c.state.sessionFile;
    await c.req("new_session");
    await c.waitFor((x) => idle(x) && x.state.sessionFile !== file, 10_000, "a new session");
    assert.deepEqual(c.state.background, [], "a new session restarts Claude Code, and its tasks end with it");
    h.artifact("claude-background");
  } finally {
    await h.stop();
  }
});
