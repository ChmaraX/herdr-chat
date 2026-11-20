// Claude Code sessions: resume rebuilds the live timeline from the transcript,
// local commands and /compact, images, sessions/switch/new, the TUI hand-off.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { idle, strip, markers } from "./harness.ts";
import { startClaude } from "../fake-claude/host.ts";
import { lockPath } from "../../host/registry.ts";

/** What a user sees of an item: no ids, times, live-only streaming details or usage. */
function seen(items: any[]): any[] {
  const ids = new Map(items.map((i) => [i.id, i]));
  return items
    .filter((i) => i.kind !== "notice" || i.source === "plan")
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
        {
          subagent: {
            description: "Check tests", type: "Explore", report: "One test file.",
            steps: [
              { tool: "Bash", input: { command: "ls test" }, result: { content: "app.test.ts" } },
              { tool: "TodoWrite", input: { todos: [{ content: "List the tests", status: "in_progress", activeForm: "Listing" }] }, result: { content: "Todos have been modified successfully." } },
            ],
          },
        },
        { todos: [{ content: "Write docs", status: "completed", activeForm: "Writing" }] },
        { text: "Done looking." },
      ],
    },
    { match: "second", steps: [{ text: "Second answer with `code`." }] },
  ],
};

const cards = (items: any[]) => items.filter((i) => i.kind === "plan");

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
    assert.deepEqual(strip(c), [["Write docs", "completed"]], "the TodoWrite list is the chat's plan, done");
    assert.deepEqual(markers(c.items), ["Plan created · 1 step"], "the transcript marks where it started");
    const agent = c.items.find((i) => i.kind === "tool" && i.name === "Agent");
    assert.deepEqual(cards(c.items).map((p) => [p.parent, p.steps]), [[agent.id, [{ text: "List the tests", status: "in_progress" }]]],
      "the subagent's own list is a card in its group, not the chat's plan");
    await c.req("send", { text: "And a second prompt" });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.text === "Second answer with `code`."), 5000);
    await c.req("send", { text: "/context" });
    await c.waitFor((x) => idle(x) && x.items.some((i) => /^## Context Usage/.test(i.text ?? "")), 5000, "local command answer");
    assert.equal(c.items.filter((i) => i.kind === "user").at(-1).text, "/context", "the command shows as the user's message");
    assert.equal(c.items.filter((i) => /^## Context Usage/.test(i.text ?? "")).length, 1, "the local command's answer shows once");
    assert.equal(c.state.plan, null, "a finished plan goes when the next message is sent");
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
    assert.equal(c.state.plan, null, "the history clears the finished plan at the next message too");
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

test("claude: the task list (TaskCreate/TaskUpdate/TaskList) is the chat's plan, live, on resume, and after a resume", async () => {
  const live = await startClaude({ name: "claude-tasks-live", speed: 4, scenario: TASKS });
  let liveItems: any[];
  let livePlan: any;
  try {
    const c = live.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "Any tasks?" });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.text === "None yet."), 10_000);
    assert.equal(c.state.plan, null, "an empty task list is no plan");
    assert.deepEqual(markers(c.items), []);

    await c.req("send", { text: "Plan the work" });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.text === "Under way."), 10_000);
    assert.deepEqual(strip(c), [["Map the input paths", "completed"], ["Wire the composer to hc send", "in_progress"]],
      "the subagent's update counts, the unknown task and the deleted one don't show, the rename does");
    assert.deepEqual(markers(c.items), ["Plan created · 2 steps"], "one marker for the turn, whatever the calls did in it");

    await c.req("send", { text: "Check the list" });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.text === "Checked."), 10_000);
    assert.deepEqual(strip(c), [["Wire the composer to the host", "completed"], ["Check the transcript", "completed"]],
      "TaskList's list replaces the plan, and an update to a task only TaskList showed lands on it");
    assert.deepEqual(markers(c.items), ["Plan created · 2 steps", "Plan created · 2 steps"], "no step carried over, so it's a new plan");
    assert.deepEqual(cards(c.items), [], "no plan card in the transcript");
    assert.equal(taskRows(c.items), taskSteps(TASKS.turns.slice(0, 3)), "every top-level task call keeps its row");
    liveItems = structuredClone(c.items);
    livePlan = structuredClone(c.state.plan);
    live.artifact("claude-tasks-live");
  } finally {
    await live.stop();
  }

  const again = await startClaude({ name: "claude-tasks-resumed", speed: 4, scenario: TASKS, dir: live.dir });
  try {
    const c = again.client;
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.text === "Checked."), 10_000, "history loaded");
    assert.deepEqual(c.state.plan, livePlan, "the transcript rebuilds the same plan, still done");
    assert.deepEqual(seen(c.items), seen(liveItems), "and the same markers");
    await c.req("send", { text: "Finish" });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.text === "Finished."), 10_000);
    assert.deepEqual(strip(c), [["Wire the composer to the host", "completed"], ["Check the transcript", "completed"], ["Write the docs", "in_progress"]],
      "after the resume the plan carries on from the list TaskList gave");
    assert.equal(markers(c.items).at(-1), "Plan created · 3 steps", "the done plan went with the message, so the next one is new");
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

test("claude: a background agent's task changes land on the session's plan in task order, live and resumed; a fork's new list replaces it", async () => {
  const live = await startClaude({ name: "claude-tasks-shared", speed: 4, scenario: SHARED });
  try {
    const c = live.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "Fix the flaky tests" });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.text === "The agent is on it."), 10_000);
    assert.deepEqual(strip(c), SHARED_CARD, "the agent's update follows the main thread's create, and the steps are in task order");
    await c.req("send", { text: "Thanks" });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.text === "You're welcome."), 10_000);
    live.artifact("claude-tasks-shared-live");
  } finally {
    await live.stop();
  }

  const again = await startClaude({ name: "claude-tasks-shared-resumed", speed: 4, scenario: SHARED, dir: live.dir });
  try {
    const c = again.client;
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.text === "You're welcome."), 10_000, "history loaded");
    assert.deepEqual(strip(c), SHARED_CARD, "the transcript replays the agent's steps in time, not where its call is");

    const { points } = await c.req("fork_points", {});
    await c.req("fork", { point: points.find((p: any) => p.text === "Thanks").id });
    await c.waitFor((x) => idle(x) && x.state.plan !== null, 10_000, "the fork's history loaded");
    await c.req("send", { text: "Start over" });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.text === "Starting over."), 10_000);
    assert.deepEqual(strip(c), [["Reproduce the flake first", "pending"]], "the fork's CLI list starts empty, so its first task replaces the plan");
    again.artifact("claude-tasks-fork-live");
  } finally {
    await again.stop();
  }

  const fork = await startClaude({ name: "claude-tasks-fork-resumed", speed: 4, scenario: SHARED, dir: live.dir });
  try {
    const c = fork.client;
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.text === "Starting over."), 10_000, "the fork's history loaded");
    assert.deepEqual(strip(c), [["Reproduce the flake first", "pending"]], "the fork's transcript, which holds the original's tasks, rebuilds the same plan");
    fork.artifact("claude-tasks-fork-resumed");
  } finally {
    await fork.stop();
  }
});

// A background agent that outlives its turn finishes the task list after the
// next message, while TodoWrite's list (a second source of the chat's plan) was
// the plan in between. An orphan subagent's TodoWrite has no card to land on.
const LATE = {
  turns: [
    {
      match: "Start the work",
      steps: [
        taskCreate("1", "Find the flaky tests"),
        taskCreate("2", "Fix them"),
        {
          subagent: {
            description: "Fix flakes", type: "general-purpose", background: "outlives", report: "Fixed.",
            steps: [{ sleep: 2400 }, taskUpdate("1", { status: "completed" }), taskUpdate("2", { status: "completed" })],
          },
        },
        { todos: [{ content: "Review the fix", status: "pending", activeForm: "Reviewing" }] },
        {
          emit: {
            type: "assistant", parent_tool_use_id: "toolu_gone",
            message: { model: "claude-opus-4-8", id: "msg_orphan", type: "message", role: "assistant", stop_reason: null, content: [{ type: "tool_use", id: "toolu_orphan_todo", name: "TodoWrite", input: { todos: [{ content: "Lost", status: "pending", activeForm: "Losing" }] } }] },
          },
        },
        { text: "On it." },
      ],
    },
    { match: "Thanks", steps: [{ text: "You're welcome." }] },
  ],
};

test("claude: a background agent's last task change after the next message, and TodoWrite's list in between, resume as they went live", async () => {
  const live = await startClaude({ name: "claude-tasks-late", speed: 4, scenario: LATE });
  let liveItems: any[];
  let livePlan: any;
  try {
    const c = live.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "Start the work" });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.text === "On it."), 10_000);
    assert.deepEqual(strip(c), [["Review the fix", "pending"]], "TodoWrite's list replaced the task list");
    assert.deepEqual(cards(c.items), [], "the orphan subagent's list is no card");
    await c.req("send", { text: "Thanks" });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.text === "You're welcome."), 10_000);
    await c.waitFor((x) => strip(x)?.every(([, st]) => st === "completed") ?? false, 10_000, "the agent finished the task list");
    assert.deepEqual(strip(c), [["Find the flaky tests", "completed"], ["Fix them", "completed"]]);
    assert.deepEqual(markers(c.items), ["Plan created · 1 step", "Plan created · 2 steps"], "the agent's list is a new plan in the turn it came in");
    liveItems = structuredClone(c.items);
    livePlan = structuredClone(c.state.plan);
    live.artifact("claude-tasks-late-live");
  } finally {
    await live.stop();
  }

  const again = await startClaude({ name: "claude-tasks-late-resumed", speed: 4, scenario: LATE, dir: live.dir });
  try {
    const c = again.client;
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.text === "You're welcome."), 10_000, "history loaded");
    assert.deepEqual(c.state.plan, livePlan, "the agent's late changes replay after the message that came before them");
    assert.deepEqual(seen(c.items).filter((i) => i.kind === "notice" || i.kind === "user"), seen(liveItems).filter((i) => i.kind === "notice" || i.kind === "user"), "the markers sit in the same turns");
    again.artifact("claude-tasks-late-resumed");
  } finally {
    await again.stop();
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

/**
 * A session started in Code Mode, in the shapes Claude Code 2.1.329 writes
 * (made up, not copied): its `repl-mode` record, one round trip calling REPL
 * and Poll, the REPL's "(dispatched #1)", the Poll's event, the call the code
 * made as virtual records (no message of the model's), then the answer.
 */
function codeModeTranscript(id: string, cwd: string): string {
  const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
  const rec = (uuid: string, parentUuid: string | null, s: number, more: object) => ({ uuid, parentUuid, sessionId: id, cwd, isSidechain: false, timestamp: at(s), ...more });
  const model = (mid: string, content: object[], stop_reason: string) => ({ type: "assistant", message: { id: mid, role: "assistant", model: "claude-opus-5-5", content, stop_reason } });
  const rows = [
    { type: "repl-mode", replMode: true, sessionId: id },
    rec("u1", null, 0, { type: "user", message: { role: "user", content: "Count the files" } }),
    rec("a1", "u1", 1, model("msg_1", [{ type: "tool_use", id: "toolu_repl", name: "REPL", input: { code: "const out = await $`ls`.text();\nout.split('\\n').length", description: "Count the files" } }], "tool_use")),
    rec("a2", "a1", 1, model("msg_1", [{ type: "tool_use", id: "toolu_poll", name: "Poll", input: {} }], "tool_use")),
    rec("u2", "a1", 2, { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_repl", content: "(dispatched #1)", is_error: false }] }, toolUseResult: { code: "…", result: "(dispatched #1)", stdout: "", stderr: "", evalId: 1, asyncDispatched: true } }),
    rec("u3", "a2", 3, { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_poll", content: '<event nonce="n1" kind="repl-eval" eval="1" status="settled">\n<result>2</result>\n</event>', is_error: false }] } }),
    rec("v1", "u3", 3, { type: "assistant", isVirtual: true, madeBy: "other", message: { id: "virtual-1", role: "assistant", model: "<synthetic>", content: [{ type: "tool_use", id: "repl_1", name: "Bash", input: { command: "ls" } }], stop_reason: "stop_sequence" } }),
    rec("v2", "v1", 3, { type: "user", isVirtual: true, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "repl_1", content: "", is_error: false }] }, toolUseResult: { stdout: "a.ts\nb.ts", stderr: "" } }),
    rec("a3", "v2", 4, model("msg_2", [{ type: "text", text: "Two files." }], "end_turn")),
  ];
  return rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

test("claude: a Code Mode session is listed by its messages, and switching to it is refused (Claude Code resumes it only in its terminal)", async () => {
  const h = await startClaude({ name: "claude-code-mode", speed: 4, scenario: { default: [{ text: "ok: {prompt}" }] } });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "plan the release" });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.text === "ok: plan the release"), 5000);
    const own = c.state.sessionFile;
    const id = "c0de0000-0000-4000-8000-000000000001";
    const file = join(dirname(own), `${id}.jsonl`);
    writeFileSync(file, codeModeTranscript(id, h.cwd));

    let listed: any;
    for (let i = 0; i < 50 && !listed; i++) {
      const d = await c.req("sessions", { refresh: i === 0 });
      if (!d.loading) listed = d.sessions;
      else await new Promise((r) => setTimeout(r, 100));
    }
    const row = listed.find((s: any) => s.path === file);
    assert.deepEqual([row?.firstMessage, row?.messageCount], ["Count the files", 3], "the prompt and the model's two messages: the call its code made isn't one");

    await assert.rejects(c.req("switch_session", { path: file }), new RegExp(`Code Mode, which Claude Code resumes only in its terminal for now: CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1 claude --resume ${id}$`));
    assert.equal(c.state.sessionFile, own, "the chat stays on its own session");
    await c.req("send", { text: "still here" });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.text === "ok: still here"), 5000, "the chat's agent still answers");
  } finally {
    await h.stop();
  }
});
