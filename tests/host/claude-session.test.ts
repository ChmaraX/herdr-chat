// Claude Code sessions: resume rebuilds the live timeline from the transcript,
// local commands and /compact, images, sessions/switch/new, the TUI hand-off.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { idle } from "./harness.ts";
import { startClaude } from "../fake-claude/host.ts";
import { lockPath } from "../../host/registry.ts";

/** What a user sees of an item: no ids, times, live-only streaming details or usage. */
function seen(items: any[]): any[] {
  const ids = new Map(items.map((i) => [i.id, i]));
  return items
    .filter((i) => i.kind !== "notice")
    .map((i) => {
      const { id, ts, durationMs, usage, source, parent, images, imagePaths, ...rest } = i;
      void id, ts, durationMs, usage, source;
      return { ...rest, ...(parent ? { parent: ids.get(parent)?.title } : {}), ...(images || imagePaths ? { images: (images ?? imagePaths).length } : {}) };
    });
}

const SCENARIO = {
  turns: [
    {
      match: "Look around",
      steps: [
        { thinking: "Start with the files." },
        { text: "Let me look." },
        { tool: "Bash", ask: false, input: { command: "ls" }, result: { content: "app.ts\nREADME.md" } },
        { tool: "Edit", ask: false, input: { file_path: "/w/app.ts", old_string: "a", new_string: "b" }, result: { content: "updated", tool_use_result: { structuredPatch: [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, lines: ["-a", "+b"] }] } } },
        { tool: "Bash", input: { command: "rm README.md" } },
        { subagent: { description: "Check tests", type: "Explore", steps: [{ tool: "Bash", input: { command: "ls test" }, result: { content: "app.test.ts" } }], report: "One test file." } },
        { todos: [{ content: "Write docs", status: "pending", activeForm: "Writing" }] },
        { text: "Done looking." },
      ],
    },
    { match: "second", steps: [{ text: "Second answer with `code`." }] },
  ],
};

test("claude: resume from the transcript shows the same timeline as live (tools, diffs, declines, nested steps, plan, /context)", async () => {
  const live = await startClaude({ name: "claude-resume-live", speed: 4, scenario: SCENARIO });
  let liveItems: any[];
  let file: string;
  try {
    const c = live.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "Look around" });
    await c.waitFor((x) => x.state.dialog?.method === "permission", 5000);
    await c.req("dialog_answer", { dialog: c.state.dialog.id, choice: "deny", message: "keep the readme" });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.text === "Done looking."), 10_000);
    await c.req("send", { text: "And a second prompt" });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.text === "Second answer with `code`."), 5000);
    await c.req("send", { text: "/context" });
    await c.waitFor((x) => idle(x) && x.items.some((i) => /^## Context Usage/.test(i.text ?? "")), 5000, "local command answer");
    assert.equal(c.items.filter((i) => i.kind === "user").at(-1).text, "/context", "the command shows as the user's message");
    assert.equal(c.items.filter((i) => /^## Context Usage/.test(i.text ?? "")).length, 1, "the local command's answer shows once");
    liveItems = structuredClone(c.items);
    file = c.state.sessionFile;
    assert.ok(existsSync(file), "the CLI wrote its transcript");
    live.artifact("claude-resume-live");
  } finally {
    await live.stop();
  }
  assert.ok(!existsSync(lockPath(file)), "lock released");
  assert.equal(live.registry!.provider, "claude");

  // Same state dir and chat, no --provider: the registry's provider and session come back.
  const again = await startClaude({ name: "claude-resume-again", speed: 4, scenario: SCENARIO, dir: live.dir });
  try {
    const c = again.client;
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.kind === "tool"), 10_000, "history loaded");
    assert.equal(c.state.sessionFile, file);
    assert.equal(c.state.provider, "claude");
    const start = again.inputs().filter((r) => r.type === "_start").at(-1);
    assert.equal(start.argv[start.argv.indexOf("--resume") + 1], file.replace(/^.*\//, "").replace(/\.jsonl$/, ""));
    assert.deepEqual(seen(c.items), seen(liveItems));
    again.artifact("claude-resume-history", { liveItems: seen(liveItems) });
  } finally {
    await again.stop();
  }
});

// Claude Code 2.1.x's task tools, with the results its own code writes (2.1.319's TaskCreate, TaskUpdate and TaskList).
const taskCreate = (id: string, subject: string) => ({
  tool: "TaskCreate", ask: false, input: { subject, description: `Do: ${subject}`, activeForm: subject },
  result: { content: `Task #${id} created successfully: ${subject}`, tool_use_result: { task: { id, subject, description: `Do: ${subject}` } } },
});
const taskUpdate = (taskId: string, change: Record<string, string>, from = "pending") => {
  const fields = Object.keys(change).map((k) => (k === "status" && change[k] === "deleted" ? "deleted" : k));
  const statusChange = change.status ? { statusChange: { from, to: change.status } } : {};
  return {
    tool: "TaskUpdate", ask: false, input: { taskId, ...change },
    result: { content: `Updated task #${taskId} ${fields.join(", ")}`, tool_use_result: { success: true, taskId, updatedFields: fields, ...statusChange } },
  };
};
const taskList = (tasks: { id: string; subject: string; status: string }[]) => ({
  tool: "TaskList", ask: false, input: {},
  result: {
    content: tasks.length ? tasks.map((t) => `#${t.id} [${t.status}] ${t.subject}`).join("\n") : "No tasks found",
    tool_use_result: { tasks: tasks.map((t) => ({ ...t, blockedBy: [] })) },
  },
});
const plans = (items: any[]) => items.filter((i) => i.kind === "plan").map((p) => p.steps.map((s: any) => [s.text, s.status]));
const TASK_TOOLS = ["TaskCreate", "TaskUpdate", "TaskList"];
const taskRows = (items: any[]) => items.filter((i) => i.kind === "tool" && !i.parent && TASK_TOOLS.includes(i.name)).length;
const taskSteps = (turns: { steps: any[] }[]) => turns.flatMap((t) => t.steps).filter((s) => TASK_TOOLS.includes(s.tool)).length;

const TASKS = {
  turns: [
    { match: "Any tasks", steps: [taskList([]), { text: "None yet." }] },
    {
      match: "Plan the work",
      steps: [
        { text: "A task list first." },
        taskCreate("1", "Map the input paths"),
        taskCreate("2", "Wire the composer"),
        taskCreate("3", "Write a throwaway note"),
        taskUpdate("1", { status: "in_progress" }),
        { subagent: { description: "Map inputs", type: "general-purpose", steps: [taskUpdate("1", { status: "completed" }, "in_progress")], report: "Mapped." } },
        { tool: "TaskUpdate", ask: false, input: { taskId: "9", status: "completed" }, result: { content: "Task not found", tool_use_result: { success: false, taskId: "9", updatedFields: [], error: "Task not found" } } },
        taskUpdate("3", { status: "deleted" }),
        taskUpdate("2", { subject: "Wire the composer to hc send", status: "in_progress" }),
        { text: "Under way." },
      ],
    },
    {
      match: "Check the list",
      steps: [
        taskList([{ id: "2", subject: "Wire the composer to the host", status: "completed" }, { id: "4", subject: "Check the transcript", status: "in_progress" }]),
        taskUpdate("4", { status: "completed" }, "in_progress"),
        { text: "Checked." },
      ],
    },
    { match: "Finish", steps: [taskCreate("5", "Write the docs"), taskUpdate("5", { status: "in_progress" }), { text: "Finished." }] },
  ],
};

test("claude: the task list (TaskCreate/TaskUpdate/TaskList) is one plan card, live, on resume, and after a resume", async () => {
  const live = await startClaude({ name: "claude-tasks-live", speed: 4, scenario: TASKS });
  let liveItems: any[];
  try {
    const c = live.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "Any tasks?" });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.text === "None yet."), 10_000);
    assert.deepEqual(plans(c.items), [], "an empty task list makes no card");

    await c.req("send", { text: "Plan the work" });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.text === "Under way."), 10_000);
    assert.deepEqual(plans(c.items), [[["Map the input paths", "completed"], ["Wire the composer to hc send", "in_progress"]]],
      "one card: the subagent's update counts, the unknown task and the deleted one don't show, the rename does");

    await c.req("send", { text: "Check the list" });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.text === "Checked."), 10_000);
    assert.deepEqual(plans(c.items), [[["Wire the composer to the host", "completed"], ["Check the transcript", "completed"]]],
      "TaskList's list replaces the card, and an update to a task only TaskList showed lands on it");
    assert.equal(taskRows(c.items), taskSteps(TASKS.turns.slice(0, 3)), "every top-level task call keeps its row");
    liveItems = structuredClone(c.items);
    live.artifact("claude-tasks-live");
  } finally {
    await live.stop();
  }

  const again = await startClaude({ name: "claude-tasks-resumed", speed: 4, scenario: TASKS, dir: live.dir });
  try {
    const c = again.client;
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.kind === "plan"), 10_000, "history loaded");
    assert.deepEqual(seen(c.items), seen(liveItems), "the transcript rebuilds the same card");
    await c.req("send", { text: "Finish" });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.text === "Finished."), 10_000);
    assert.deepEqual(plans(c.items), [[["Wire the composer to the host", "completed"], ["Check the transcript", "completed"], ["Write the docs", "in_progress"]]],
      "after the resume the same card keeps updating, from the list TaskList gave");
    again.artifact("claude-tasks-resumed");
  } finally {
    await again.stop();
  }
});

// A background agent works alongside the main thread on the session's one list. A
// TaskCreated hook holds task 2's result back, so task 3's lands first.
const SHARED = {
  turns: [
    {
      match: "Fix the flaky tests",
      steps: [
        taskCreate("1", "Find the flaky tests"),
        {
          subagent: {
            description: "Fix flakes", type: "general-purpose", background: true, report: "Fixed.",
            steps: [{ sleep: 600 }, taskCreate("3", "Note the cause"), { sleep: 1400 }, taskUpdate("2", { status: "completed" })],
          },
        },
        { ...taskCreate("2", "Fix the flaky tests"), durationMs: 1600 },
        { text: "The agent is on it." },
      ],
    },
    { match: "Thanks", steps: [{ text: "You're welcome." }] },
    { match: "Start over", steps: [taskCreate("1", "Reproduce the flake first"), { text: "Starting over." }] },
  ],
};
const SHARED_CARD = [["Find the flaky tests", "pending"], ["Fix the flaky tests", "completed"], ["Note the cause", "pending"]];

test("claude: a background agent's task changes land on the session's card in task order, live and resumed; a fork's new list replaces it", async () => {
  const live = await startClaude({ name: "claude-tasks-shared", speed: 4, scenario: SHARED });
  try {
    const c = live.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "Fix the flaky tests" });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.text === "The agent is on it."), 10_000);
    assert.deepEqual(plans(c.items), [SHARED_CARD], "the agent's update follows the main thread's create, and the steps are in task order");
    await c.req("send", { text: "Thanks" });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.text === "You're welcome."), 10_000);
    live.artifact("claude-tasks-shared-live");
  } finally {
    await live.stop();
  }

  const again = await startClaude({ name: "claude-tasks-shared-resumed", speed: 4, scenario: SHARED, dir: live.dir });
  try {
    const c = again.client;
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.kind === "plan"), 10_000, "history loaded");
    assert.deepEqual(plans(c.items), [SHARED_CARD], "the transcript replays the agent's steps in time, not where its card is");

    const { points } = await c.req("fork_points", {});
    await c.req("fork", { point: points.find((p: any) => p.text === "Thanks").id });
    await c.waitFor((x) => idle(x) && plans(x.items).length === 1, 10_000, "the fork's history loaded");
    await c.req("send", { text: "Start over" });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.text === "Starting over."), 10_000);
    assert.deepEqual(plans(c.items), [[["Reproduce the flake first", "pending"]]], "the fork's CLI list starts empty, so its first task replaces the card");
    again.artifact("claude-tasks-fork-live");
  } finally {
    await again.stop();
  }

  const fork = await startClaude({ name: "claude-tasks-fork-resumed", speed: 4, scenario: SHARED, dir: live.dir });
  try {
    const c = fork.client;
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.text === "Starting over."), 10_000, "the fork's history loaded");
    assert.deepEqual(plans(c.items), [[["Reproduce the flake first", "pending"]]], "the fork's transcript, which holds the original's tasks, rebuilds the same card");
    fork.artifact("claude-tasks-fork-resumed");
  } finally {
    await fork.stop();
  }
});

test("claude: /compact, an image prompt, sessions + switch + new, and the TUI hand-off argv", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC", "base64");
  const h = await startClaude({ name: "claude-session-ops", speed: 4, scenario: { turns: [{ match: "colour", steps: [{ text: "Red." }] }], default: [{ text: "ok: {prompt}" }] } });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    const img = join(h.dir, "red.png");
    writeFileSync(img, png);
    await c.req("send", { text: "What colour is this?", images: [img] });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.text === "Red."), 5000);
    const user = c.items.find((i) => i.kind === "user");
    assert.equal(user.images, 1);
    assert.deepEqual(readFileSync(user.imagePaths[0]), png, "the user item shows what Claude got");
    const sent = h.inputs().find((r) => r.type === "user").message.content;
    assert.deepEqual(sent.map((b: any) => b.type), ["image", "text"]);
    assert.equal(sent[0].source.media_type, "image/png");

    await c.req("send", { text: "/compact keep the colours" });
    await c.waitFor((x) => x.items.some((i) => i.kind === "notice" && /^Compacted the conversation: \d+k → 3k tokens\.$/.test(i.text)), 5000, "compaction notice");
    await c.waitFor(idle, 3000);
    assert.ok(!c.items.some((i) => i.kind === "notice" && /on its own/.test(i.text)), "our /compact is not an autonomous run");
    assert.equal(h.inputs().filter((r) => r.type === "user").at(-1).message.content, "/compact keep the colours");
    const first = c.state.sessionFile;

    const { argv, sessionFile } = await c.req("handoff");
    assert.equal(sessionFile, first);
    const id = first.replace(/^.*\//, "").replace(/\.jsonl$/, "");
    assert.deepEqual(argv.slice(1), ["--resume", id]);
    assert.match(argv[0], /fake-claude\.mjs$/);
    assert.equal(c.state.phase, "handoff");
    await c.req("resume");
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.text === "Red."), 5000, "back from the TUI");

    await c.req("new_session");
    await c.waitFor((x) => idle(x) && x.state.sessionFile !== first, 5000);
    assert.deepEqual(c.items, []);
    await c.req("send", { text: "fresh start" });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.text === "ok: fresh start"), 5000);
    const { sessions } = await c.req("sessions");
    assert.deepEqual(sessions.map((s: any) => [s.firstMessage, s.path === first]).sort(), [["What colour is this?", true], ["fresh start", false]]);
    await c.req("switch_session", { path: first });
    await c.waitFor((x) => idle(x) && x.state.sessionFile === first && x.items.some((i) => i.text === "Red."), 5000);
    assert.ok((c.items as any[]).some((i) => i.kind === "notice" && /^Compacted the conversation \(\d+k tokens before\)\.$/.test(i.text)), "the compaction shows in history");
    h.artifact("claude-session-ops");
  } finally {
    await h.stop();
  }
});
