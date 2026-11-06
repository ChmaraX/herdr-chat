// Codex process and session lifecycle through the real host: resume, TUI hand-off, sessions, compaction, crash, stall.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { idle, HERDR_HOOK_ENV } from "./harness.ts";
import { codexHost, FAKE_CODEX } from "../fake-codex/host.ts";

const answered = (text: RegExp) => (x: any) => idle(x) && x.items.some((i: any) => i.kind === "assistant" && text.test(i.text) && !i.streaming);

/** What a user sees of an item, without ids, times and per-request stats. */
function seen(items: any[]): any[] {
  const index = new Map(items.map((i, n) => [i.id, n]));
  return items
    .filter((i) => i.kind !== "notice")
    .map((i) => {
      const { id: _id, ts: _ts, durationMs: _d, usage: _u, model: _m, outputLines: _o, blocks: _b, parent, images, imagePaths, ...rest } = i;
      return { ...rest, ...(parent ? { parent: index.get(parent) } : {}), ...(images ? { images: images.length } : {}), ...(imagePaths ? { imagePaths: imagePaths.length } : {}) };
    });
}

const RICH = {
  approvalPolicy: "untrusted",
  prompts: [
    {
      match: "^do the work",
      steps: [
        { reasoning: ["**Looking around**", "Then editing"] },
        { text: "Checking first.", phase: "commentary" },
        { command: "cat README.md", output: "# Project\n", actions: [{ type: "read", command: "cat README.md", name: "README.md", path: "README.md" }] },
        { command: "npm test", output: ["1 failing\n"], exitCode: 1 },
        { command: "rm -rf /", approval: { availableDecisions: ["accept", "decline"] } },
        { fileChange: [{ path: "notes.txt", kind: "add", diff: "one\n" }] },
        { fileChange: [{ path: "notes.txt", kind: "update", diff: "@@ -1 +1 @@\n-one\n+two\n" }] },
        { mcp: { server: "echo", tool: "echo", arguments: { text: "x" }, content: [{ type: "text", text: "echo: x" }] } },
        { webSearch: { query: "codex", results: [{ title: "Codex", url: "https://openai.com" }] } },
        { subagent: { prompt: "Say 4", steps: [{ text: "4" }], answer: "4" } },
        { text: "All done." },
      ],
    },
    { match: "^watch", steps: [{ command: "tail -f log", until: "interrupt", tick: "t{n}\n", every: 50 }] },
  ],
};

test("codex: resume rebuilds the same items as live (tools, thinking, a declined command, a subagent, an interrupted turn)", async () => {
  const h = await codexHost({ name: "cx-resume", scenario: RICH });
  let live: any[];
  let file: string;
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "do the work" });
    await c.waitFor((x) => x.state.dialog?.method === "permission", 5000);
    await c.req("dialog_answer", { dialog: c.state.dialog.id, choice: "decline" });
    await c.waitFor(answered(/All done\./), 10_000);
    await c.req("send", { text: "watch it" });
    await c.waitFor((x) => x.items.some((i) => i.kind === "tool" && i.status === "running" && /t2/.test(i.output)), 5000);
    await c.req("abort");
    await c.waitFor(idle, 5000);
    live = seen(c.items);
    file = c.state.sessionFile;
    assert.match(file, /rollout-.*\.jsonl$/);
    h.artifact("codex-resume-live");
  } finally {
    await h.stop();
  }
  // A new host on the same chat: the registry names the session, Codex resumes it.
  const again = await codexHost({ name: "cx-resume2", scenario: RICH, dir: h.dir });
  try {
    const c = again.client;
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.kind === "tool"), 10_000, "history");
    assert.equal(c.state.sessionFile, file);
    const resumed = seen(c.items);
    again.artifact("codex-resume-history", { live, resumed });
    // The interrupted command's output was streamed live; history has what Codex recorded.
    const liveTail = live.at(-1);
    const resumedTail = resumed.at(-1);
    assert.equal(resumedTail.title, "$ tail -f log");
    assert.equal(resumedTail.status, "error");
    assert.match(resumedTail.output, /Interrupted\.$/);
    assert.deepEqual(resumed.slice(0, -1), live.slice(0, -1));
    assert.equal(liveTail.status, resumedTail.status);
    const resume = again.requests("thread/resume")[0].params;
    assert.equal(resume.excludeTurns, true, "never the full-history resume");
    assert.equal(resume.path, file);
    // Subagent items come back nested under the spawn card.
    const spawnAt = resumed.findIndex((i) => i.kind === "tool" && i.title === "Agent Say 4");
    assert.deepEqual(resumed.filter((i) => i.parent === spawnAt).map((i) => i.kind), ["user", "assistant"]);
  } finally {
    await again.stop();
  }
});

test("codex: a turn left by a dead process reads back interrupted; resume while another process holds the thread is explained", async () => {
  const id = "019a0000-0000-7000-8000-000000000001";
  const history = [{
    id: "turn-1", rootTurnId: "turn-1", itemsView: "full", status: "interrupted", error: null, startedAt: 1793700000, completedAt: null, durationMs: null,
    items: [
      { type: "userMessage", id: "u1", clientId: null, content: [{ type: "text", text: "run the server", text_elements: [] }] },
      { type: "commandExecution", id: "c1", command: "/bin/zsh -lc 'npm start'", cwd: "/x", processId: null, source: "agent", status: "inProgress", commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null },
    ],
  }];
  const h = await codexHost({ name: "cx-leftover", scenario: { history }, session: join("/tmp", `rollout-2026-11-03T10-00-00-${id}.jsonl`) });
  try {
    const c = h.client;
    await c.waitFor((x) => idle(x) && x.items.length >= 2, 10_000);
    assert.deepEqual(seen(c.items).map((i) => [i.kind, i.text ?? i.title, i.status ?? i.source]), [["user", "run the server", "composer"], ["tool", "$ npm start", "error"]]);
    assert.match(c.items[1].output, /Interrupted\./);
    assert.equal(c.state.sessionName, null);
  } finally {
    await h.stop();
  }
  const w = await codexHost({ name: "cx-writer", scenario: { resumeError: { code: -32600, message: `thread-store conflict: thread ${id} already has an active writer` } }, session: join("/tmp", `rollout-x-${id}.jsonl`) });
  try {
    const c = w.client;
    await c.waitFor((x) => x.state.phase === "conflict", 10_000);
    assert.deepEqual(c.state.conflict, { chat: null, terminal: null, pid: null }, "Codex's own guard: no chat to go to");
    assert.ok(c.items.some((i) => i.kind === "notice" && /open in another Codex process/.test(i.text) && /outside a chat\. Quit it there, then use resume\./.test(i.text)));
    await assert.rejects(c.req("take_over"), /outside a chat/);
    w.artifact("codex-active-writer");
  } finally {
    await w.stop();
  }
});

test("codex: TUI hand-off runs `codex resume --no-daemon <thread>` and the chat resumes after it", async () => {
  const h = await codexHost({ name: "cx-tui", scenario: { default: [{ text: "pong" }] }, env: HERDR_HOOK_ENV });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await assert.rejects(c.req("handoff"), /no session file/, "nothing to hand off before the first turn");
    await c.req("send", { text: "ping" });
    await c.waitFor(answered(/pong/), 5000);
    const thread = h.requests("turn/start")[0].params.threadId;
    const r = await c.req("handoff");
    assert.deepEqual(r.argv, [FAKE_CODEX, "resume", "--no-daemon", thread]);
    assert.equal(r.sessionFile, c.state.sessionFile);
    await c.waitFor((x) => x.state.phase === "handoff", 3000);
    await assert.rejects(c.req("send", { text: "while away" }), /terminal UI/);
    await c.req("resume");
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.kind === "assistant" && i.text === "pong"), 10_000, "history after the hand-off");
    assert.equal(h.requests("thread/resume").at(-1).params.threadId, thread);
    assert.equal(h.requests("initialize").length, 2, "a fresh app-server after the TUI");
    const starts = h.codexMessages().filter((m) => m._start);
    assert.ok(starts.every((s) => s.argv.join(" ") === "-c notify=[] app-server"), "launched with notify off, no sandbox flags");
    for (const s of starts) assert.deepEqual([s.env.HERDR_PANE_ID, s.env.HERDR_SOCKET_PATH, s.env.HERDR_ENV], [null, null, null], "Herdr's hook variables are stripped");
    h.artifact("codex-tui-handoff");
  } finally {
    await h.stop();
  }
});

test("codex: sessions list and switch, rename, compact, new session", async () => {
  const h = await codexHost({ name: "cx-sessions", scenario: { default: [{ text: "noted" }], compactMs: 300 } });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "first session" });
    await c.waitFor(answered(/noted/), 5000);
    const first = c.state.sessionFile;
    await c.req("set_name", { name: "First" });
    await c.waitFor((x) => x.state.sessionName === "First", 3000);
    await c.req("compact");
    await c.waitFor((x) => x.items.some((i) => i.kind === "notice" && i.text === "Compacted the conversation."), 5000);
    await c.waitFor(idle, 3000);
    assert.ok(!c.items.some((i) => i.kind === "notice" && /on its own/.test(i.text)), "the compaction turn is not a run");

    await c.req("new_session");
    await c.waitFor((x) => idle(x) && x.items.filter((i) => i.kind !== "notice").length === 0, 5000);
    assert.equal(c.state.sessionFile, null);
    await c.req("send", { text: "second session" });
    await c.waitFor(answered(/noted/), 5000);
    const second = c.state.sessionFile;
    assert.notEqual(second, first);

    const { sessions } = await c.req("sessions");
    assert.deepEqual(sessions.map((s: any) => [s.path, s.name, s.firstMessage]), [[second, null, "second session"], [first, "First", "first session"]]);
    await c.req("switch_session", { path: first });
    await c.waitFor((x) => x.state.sessionFile === first && x.items.some((i) => i.kind === "user" && i.text === "first session"), 5000);
    assert.equal(c.state.sessionName, "First");
    assert.deepEqual(c.items.filter((i) => i.kind !== "notice").map((i) => i.kind), ["user", "assistant", ]);
    assert.ok(c.items.some((i) => i.kind === "notice" && i.source === "compaction"), "the compaction is in the history");
    h.artifact("codex-sessions");
  } finally {
    await h.stop();
  }
});

test("codex: a crash mid-turn is reported and the next message restarts Codex on the session", async () => {
  const h = await codexHost({
    name: "cx-crash",
    scenario: { prompts: [{ match: "^boom", steps: [{ crash: 3, stderrBefore: "thread 'main' panicked: out of memory" }] }], default: [{ text: "back" }] },
  });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "warm up" });
    await c.waitFor(answered(/back/), 5000);
    await c.req("send", { text: "boom now" });
    await c.waitFor((x) => x.state.phase === "exited", 5000);
    assert.match(c.state.error, /^Codex exited \(code 3\): thread 'main' panicked: out of memory/);
    assert.ok(c.items.some((i) => i.kind === "notice" && i.level === "error" && /\/reload/.test(i.text)));
    await h.waitStatus(/^error/);
    await c.req("send", { text: "are you back" });
    await c.waitFor((x) => idle(x) && x.items.filter((i) => i.kind === "assistant" && i.text === "back").length === 2, 10_000, "restarted");
    assert.equal(h.requests("thread/resume").length, 1, "restarted on the same thread");
    h.artifact("codex-crash");
  } finally {
    await h.stop();
  }
});

test("codex: a silent stall gets the watchdog's notice; a turn Codex never completes is settled by the probe", async () => {
  const h = await codexHost({ name: "cx-stall", stallMs: 800, speed: 1, scenario: { prompts: [{ match: "^stall", steps: [{ text: "Starting.", phase: "commentary" }, { hang: true }] }] } });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "stall please" });
    await c.waitFor((x) => x.items.some((i) => i.kind === "notice" && /has sent nothing for \d+ s\. It may be stalled/.test(i.text)), 5000, "stall notice");
    assert.equal(c.state.phase, "working", "a stall is not a settle: Codex says the turn is active");
    await c.req("abort");
    await c.waitFor(idle, 5000);
    h.artifact("codex-stall");
  } finally {
    await h.stop();
  }
  const lost = await codexHost({ name: "cx-lost", stallMs: 800, speed: 1, scenario: { readStatus: { type: "idle" }, prompts: [{ match: "^lost", steps: [{ text: "Answer without an end." }, { hang: true }] }] } });
  try {
    const c = lost.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "lost turn" });
    await c.waitFor(answered(/Answer without an end/), 5000);
    await lost.waitStatus(/^done/);
    lost.artifact("codex-settle-probe");
  } finally {
    await lost.stop();
  }
});

test("codex fixture resume-approvals (06): a real resume and paged turns rebuild the session, then approvals accept / decline / retry", async () => {
  const thread = "08ea03b5-cdee-75eb-b603-562895f4af09";
  const h = await codexHost({ name: "cx-fx-resume", replay: "resume-approvals.jsonl", speed: 8, session: join("/tmp", `rollout-2026-11-03T17-25-06-${thread}.jsonl`) });
  try {
    const c = h.client;
    await c.waitFor((x) => idle(x) && x.items.length > 0, 10_000, "history");
    const seenItems = seen(c.items).map((i) => [i.kind, i.kind === "tool" ? i.title : i.text, i.status ?? i.source ?? i.stopReason]);
    assert.deepEqual(seenItems, [
      ["user", "Reply with exactly: hello from codex", "composer"],
      ["assistant", "hello from codex", "stop"],
      ["user", "What is the dominant color of the attached image? Answer in one word.", "composer"],
      ["assistant", "red", "stop"],
      ["user", "Use the shell to run `ls -la` in the current directory and tell me how many entries it lists. Do nothing else.", "composer"],
      ["tool", "List .", "done"],
      ["assistant", "4", "stop"],
      ["user", "Create a file notes.txt containing two lines 'one' and 'two'. Then edit it so the second line is 'three'. Use your file editing tool, not the shell.", "composer"],
      ["assistant", "I’ll create `notes.txt` with the requested initial contents, then update its second line using the file editing tool.", "toolUse"],
      ["tool", "Write notes.txt", "done"],
      ["tool", "Edit notes.txt", "done"],
      ["assistant", "Done.", "stop"],
      ["user", "Run exactly this shell command: `mkdir -p sub && echo hi > sub/x.txt`. Then run exactly `rm -rf sub2; mkdir sub2`. Report the outcome of each.", "composer"],
    ]);
    assert.equal(c.items.find((i) => i.kind === "user" && /dominant color/.test(i.text)).images, 1, "the image prompt keeps its image count");
    assert.equal(c.state.permissionMode, "untrusted");
    assert.equal(c.state.thinking, "low");

    await c.req("send", { text: "Run exactly this shell command: `mkdir -p sub && echo hi > sub/x.txt`. Then run exactly `rm -rf sub2; mkdir sub2`. Report the outcome of each." });
    for (const choice of ["accept", "decline", "accept", "accept"]) {
      await c.waitFor((x) => x.state.dialog?.method === "permission", 10_000, `ask for ${choice}`);
      await c.req("dialog_answer", { dialog: c.state.dialog.id, choice });
      await c.waitFor((x) => x.state.dialog === null || x.state.dialog.method !== "permission" || x.state.dialog.id !== c.state.dialog?.id, 3000);
    }
    await c.waitFor(answered(/succeeded\./), 10_000);
    const tools = c.items.filter((i) => i.kind === "tool").slice(-4);
    assert.deepEqual(tools.map((t) => [t.title, t.status]), [
      ["$ mkdir -p sub && echo hi > sub/x.txt", "done"],
      ["$ rm -rf sub2; mkdir sub2", "declined"],
      ["$ mkdir -p sub && echo hi > sub/x.txt", "done"],
      ["$ rm -rf sub2; mkdir sub2", "done"],
    ]);
    h.artifact("codex-fixture-resume-approvals");
  } finally {
    await h.stop();
  }
});

test("codex: MCP servers that fail at startup make one notice, once, after the slow ones finish", async () => {
  const st = (name: string, status: string, error: string | null = null, failureReason: string | null = null) =>
    ({ method: "mcpServer/startupStatus/updated", params: { threadId: "{thread}", name, status, error, failureReason } });
  const auth = (n: string) => st(n, "failed", `The ${n} MCP server requires OAuth reauthentication. Run \`codex mcp login ${n}\`.`, "reauthenticationRequired");
  const startup = [
    ...["zeta_repl", "alpha_mcp", "beta", "delta_mcp", "slow"].map((n) => st(n, "starting")),
    st("zeta_repl", "ready"), auth("alpha_mcp"), auth("delta_mcp"), auth("beta"),
    { wait: 300 }, st("slow", "ready"),
  ];
  const h = await codexHost({ name: "cx-mcp", speed: 1, scenario: { startupNotifications: startup, default: [{ text: "ok" }] } });
  try {
    const c = h.client;
    const mcpNotices = () => c.items.filter((i) => i.kind === "notice" && /MCP server/.test(i.text));
    await c.waitFor(() => mcpNotices().length > 0, 10_000, "the MCP notice");
    await c.req("send", { text: "hi" });
    await c.waitFor(answered(/ok/), 5000);
    assert.equal(mcpNotices().length, 1, "one notice, not one per server");
    const n = mcpNotices()[0];
    assert.equal(n.level, "warning");
    assert.equal(n.text, [
      "3 MCP servers didn't start: alpha_mcp, delta_mcp, beta (OAuth sign-in needed: codex mcp login <name>)",
      "alpha_mcp: The alpha_mcp MCP server requires OAuth reauthentication. Run `codex mcp login alpha_mcp`.",
      "delta_mcp: The delta_mcp MCP server requires OAuth reauthentication. Run `codex mcp login delta_mcp`.",
      "beta: The beta MCP server requires OAuth reauthentication. Run `codex mcp login beta`.",
    ].join("\n"));
    h.artifact("codex-mcp-startup");
    // A new thread starts its servers again: the same failures aren't repeated.
    await c.req("new_session");
    await c.req("send", { text: "again" });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.kind === "assistant" && i.text === "ok"), 5000);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(mcpNotices().length, 0, "not again for the next thread");
  } finally {
    await h.stop();
  }
});
