import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AgyAdapter, agySessionPath } from "../../host/providers/agy/adapter.ts";
import { AGY_TOOLS } from "../../host/providers/agy/tools.ts";
import { AgyMapper } from "../../host/providers/agy/mapper.ts";
import { presentTool, applyResult } from "../../host/tools.ts";
import type { AdapterHost, NormalizedEvent } from "../../host/providers/types.ts";

const FAKE_AGY = resolve(fileURLToPath(new URL("../fake-agy/fake-agy.mjs", import.meta.url)));
chmodSync(FAKE_AGY, 0o755);

function makeHost(): { host: AdapterHost; events: NormalizedEvent[]; waitFor: (pred: (ev: NormalizedEvent) => boolean, ms?: number) => Promise<NormalizedEvent> } {
  const events: NormalizedEvent[] = [];
  const waiters: { pred: (ev: NormalizedEvent) => boolean; resolve: (ev: NormalizedEvent) => void; timer: NodeJS.Timeout }[] = [];
  const host: AdapterHost = {
    emit(ev) {
      events.push(ev);
      for (let i = waiters.length - 1; i >= 0; i--) {
        const w = waiters[i]!;
        if (w.pred(ev)) {
          clearTimeout(w.timer);
          waiters.splice(i, 1);
          w.resolve(ev);
        }
      }
    },
    log() {},
    get running() { return false; },
    get working() { return false; },
  };
  const waitFor = (pred: (ev: NormalizedEvent) => boolean, ms = 5000): Promise<NormalizedEvent> => {
    const existing = events.find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for event (saw: ${events.map((e) => e.type).join(", ")})`)), ms);
      waiters.push({ pred, resolve, timer });
    });
  };
  return { host, events, waitFor };
}

test("AGY_TOOLS classifies Antigravity tools and exit codes", () => {
  const bash = presentTool(AGY_TOOLS, "run_command", { CommandLine: "echo hi" }, "/repo");
  assert.equal(bash.title, "$ echo hi");
  assert.equal(bash.detail.type, "bash");
  const bashDone = applyResult(AGY_TOOLS, "run_command", bash.detail, { exit_code: 2 }, true, "fail", "/repo");
  assert.equal(bashDone.type, "bash");
  if (bashDone.type === "bash") assert.equal(bashDone.exitCode, 2);

  const read = presentTool(AGY_TOOLS, "read_file", { Path: "/repo/a.ts", StartLine: 10, EndLine: 20 }, "/repo");
  assert.equal(read.title, "Read a.ts:10-20");

  const edit = presentTool(AGY_TOOLS, "edit_file", { Path: "/repo/a.ts", Target: "old", Replacement: "new" }, "/repo");
  assert.equal(edit.title, "Edit a.ts");
  assert.equal(edit.detail.type, "edit");
  if (edit.detail.type === "edit") assert.match(edit.detail.diff ?? "", /-old\n\+new/);

  const search = presentTool(AGY_TOOLS, "grep_search", { Query: "foo", SearchPath: "/repo/src" }, "/repo");
  assert.equal(search.title, "Grep foo in src");

  const mcp = presentTool(AGY_TOOLS, "call_mcp_tool", { ServerName: "revu", ToolName: "revu_review" }, "/repo");
  assert.equal(mcp.title, "mcp revu · revu_review");
});

test("AgyMapper maps thinking, tool calls, text, and replay turns", () => {
  const m = new AgyMapper();
  const ev1 = m.onUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } });
  assert.deepEqual(ev1.map((e) => e.type), ["assistant_start", "assistant_block_start", "assistant_delta"]);

  const ev2 = m.onUpdate({ sessionUpdate: "tool_call", toolCallId: "c1", name: "run_command", args: { CommandLine: "ls" }, status: "in_progress" });
  assert.deepEqual(ev2.map((e) => e.type), ["assistant_block_end", "tool_call", "tool_started"]);

  const ev3 = m.onUpdate({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed", content: [{ type: "content", content: { type: "text", text: "a.txt" } }] });
  assert.equal(ev3[0]?.type, "tool_ended");

  const ev4 = m.onUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } });
  assert.deepEqual(ev4.map((e) => e.type), ["assistant_block_start", "assistant_delta"]);

  const end = m.finishTurn({ stopReason: "stop" });
  assert.deepEqual(end.map((e) => e.type), ["assistant_block_end", "assistant_end"]);
});

test("AgyAdapter full lifecycle: start, prompt, model/effort/mode, permissions, resume, and abort", async () => {
  const prevSettings = process.env.AGY_SETTINGS_PATH;
  process.env.AGY_SETTINGS_PATH = join(tmpdir(), `herdr-chat-nonexistent-${Date.now()}.json`);
  const { host, events, waitFor } = makeHost();
  const adapter = new AgyAdapter({ cwd: "/tmp", command: FAKE_AGY, args: [], log() {} });
  try {
    const started = await adapter.start(null, host);
    assert.deepEqual(started, { streaming: false, hasHistory: false });
    assert.equal(adapter.alive, true);
    assert.ok(events.some((e) => e.type === "version" && e.version === "1.5.14-test"));
    assert.ok(events.some((e) => e.type === "session" && e.id === "sess-new-1" && e.file === agySessionPath("sess-new-1")));
    assert.ok(events.some((e) => e.type === "model" && e.model.id === "gemini-4-neon"));
    assert.ok(events.some((e) => e.type === "thinking" && e.level === "high"));
    assert.deepEqual(adapter.tuiCommand(agySessionPath("sess-new-1")), [FAKE_AGY, "--conversation", "sess-new-1"]);

    // Wait briefly for available_commands_update notification
    await new Promise((r) => setTimeout(r, 50));
    const cmds = await adapter.commands();
    assert.ok(cmds.some((c) => c.name === "plan"));

    // 1. Prompt with thinking + tool + text + usage
    const disp = await adapter.prompt({ id: "m1", text: "Say hello", images: [], mode: "auto", busy: false });
    assert.equal(disp.disposition, "started");
    await waitFor((e) => e.type === "run_settled");
    assert.ok(events.some((e) => e.type === "user_message" && e.clientId === "m1"));
    assert.ok(events.some((e) => e.type === "tool_ended" && e.callId === "call_1" && e.output.includes("hi")));
    assert.ok(events.some((e) => e.type === "assistant_end" && e.stopReason === "stop"));
    const usage = await adapter.usage();
    assert.equal(usage.contextTokens, 1500);
    assert.equal(usage.contextWindow, 1048576);

    // 2. Settings: model, thinking, mode
    const models = await adapter.listModels();
    assert.ok(models.some((m) => m.id === "gemini-3.8-flash"));
    await adapter.setModel("antigravity", "gemini-3.8-flash");
    await adapter.setThinking("medium");
    await adapter.setPermissionMode("plan");
    assert.ok(events.some((e) => e.type === "model" && e.model.id === "gemini-3.8-flash"));
    assert.ok(events.some((e) => e.type === "thinking" && e.level === "medium"));
    assert.ok(events.some((e) => e.type === "permission_mode" && e.mode === "plan"));

    // 3. Interactive permission request
    events.length = 0;
    await adapter.prompt({ id: "m2", text: "ASK_PERM", images: [], mode: "auto", busy: false });
    const askEv = await waitFor((e) => e.type === "ask");
    assert.equal(askEv.type, "ask");
    assert.equal(askEv.ask.kind, "permission");
    adapter.answer(askEv.ask.id, { choice: "allow_once" });
    await waitFor((e) => e.type === "run_settled");
    assert.ok(events.some((e) => e.type === "tool_ended" && e.callId === "call_perm_1" && !e.isError && !e.declined));

    // 4. Session list + switchSession + history replay
    assert.equal(adapter.sessions.kind, "agent");
    const list = await adapter.sessions.list("cwd");
    assert.equal(list.length, 1);
    assert.equal(list[0]!.path, agySessionPath("sess-old-1"));
    await adapter.switchSession(list[0]!.path);
    const hist = await adapter.history();
    assert.ok(hist.some((e) => e.type === "user_message" && e.text === "Old question"));
    assert.ok(hist.some((e) => e.type === "tool_ended" && e.callId === "call_hist_1"));
    assert.ok(hist.some((e) => e.type === "assistant_end"));

    // 5. Abort mid-turn
    events.length = 0;
    await adapter.prompt({ id: "m3", text: "HANG", images: [], mode: "auto", busy: false });
    await waitFor((e) => e.type === "assistant_delta");
    adapter.abort();
    const settled = await waitFor((e) => e.type === "run_settled");
    assert.equal(settled.type, "run_settled");
    assert.equal(settled.aborted, true);
  } finally {
    await adapter.dispose();
    assert.equal(adapter.alive, false);
    if (prevSettings === undefined) delete process.env.AGY_SETTINGS_PATH;
    else process.env.AGY_SETTINGS_PATH = prevSettings;
  }
});

test("AgyAdapter applies default model and agentMode from settings.json on new sessions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-chat-agy-settings-"));
  const settingsFile = join(dir, "settings.json");
  const prevSettings = process.env.AGY_SETTINGS_PATH;
  process.env.AGY_SETTINGS_PATH = settingsFile;

  try {
    // 1. Config option label + agentMode
    writeFileSync(settingsFile, JSON.stringify({ model: "Orchestrator (Neon)", agentMode: "accept-edits" }));
    {
      const { host, events } = makeHost();
      const adapter = new AgyAdapter({ cwd: "/tmp", command: FAKE_AGY, args: [], log() {} });
      try {
        await adapter.start(null, host);
        const lastModel = [...events].reverse().find((e) => e.type === "model");
        const lastMode = [...events].reverse().find((e) => e.type === "permission_mode");
        assert.equal(lastModel?.type, "model");
        if (lastModel?.type === "model") assert.equal(lastModel.model.id, "gemini-pro-orchestrator-neon");
        assert.equal(lastMode?.type, "permission_mode");
        if (lastMode?.type === "permission_mode") assert.equal(lastMode.mode, "accept-edits");
      } finally {
        await adapter.dispose();
      }
    }

    // 2. availableModels label with effort (calls session/set_model + emits config_option_update)
    writeFileSync(settingsFile, JSON.stringify({ model: "Gemini 3.8 Flash (Low)" }));
    {
      const { host, events, waitFor } = makeHost();
      const adapter = new AgyAdapter({ cwd: "/tmp", command: FAKE_AGY, args: [], log() {} });
      try {
        await adapter.start(null, host);
        await waitFor((e) => e.type === "model" && e.model.id === "gemini-3.8-flash");
        await waitFor((e) => e.type === "thinking" && e.level === "low");
        const lastModel = [...events].reverse().find((e) => e.type === "model");
        assert.equal(lastModel?.type, "model");
        if (lastModel?.type === "model") assert.equal(lastModel.model.id, "gemini-3.8-flash");
      } finally {
        await adapter.dispose();
      }
    }

    // 3. Unknown/stale model is ignored cleanly without failing session start
    writeFileSync(settingsFile, JSON.stringify({ model: "Nonexistent Model 99" }));
    {
      const { host, events } = makeHost();
      const adapter = new AgyAdapter({ cwd: "/tmp", command: FAKE_AGY, args: [], log() {} });
      try {
        await adapter.start(null, host);
        const lastModel = [...events].reverse().find((e) => e.type === "model");
        assert.equal(lastModel?.type, "model");
        if (lastModel?.type === "model") assert.equal(lastModel.model.id, "gemini-4-neon");
      } finally {
        await adapter.dispose();
      }
    }
  } finally {
    if (prevSettings === undefined) delete process.env.AGY_SETTINGS_PATH;
    else process.env.AGY_SETTINGS_PATH = prevSettings;
    rmSync(dir, { recursive: true, force: true });
  }
});
