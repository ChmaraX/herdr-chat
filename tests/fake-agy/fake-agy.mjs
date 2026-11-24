#!/usr/bin/env node
// Minimal fake `agy acp` stdio JSON-RPC 2.0 server for unit/integration tests.
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

let currentModel = "gemini-4-neon";
let currentThought = "high";
let currentMode = "default";
let activePromptId = null;
let activeSessionId = null;
let activeToolCallId = null;
let activeTimer = null;
let pendingPermission = null;
let steeredTexts = [];
let lastPromptParams = null;

function configOptions() {
  const opts = [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: currentModel,
      options: [
        { value: "gemini-4-neon", name: "Gemini 4 Neon" },
        { value: "gemini-pro-orchestrator-neon", name: "Orchestrator (Neon)" },
        { value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
        { value: "claude-opus-5-5", name: "Claude Opus 5.5" },
      ],
    },
  ];
  if (currentModel !== "gemini-pro-orchestrator-neon") {
    opts.push({
      id: "thought_level",
      name: "Thinking Level",
      category: "thought_level",
      type: "select",
      currentValue: currentThought,
      options: [
        { value: "low", name: "Low" },
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" },
        { value: "xhigh", name: "Extra" },
      ],
    });
  }
  opts.push({
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue: currentMode,
    options: [
      { value: "default", name: "Default" },
      { value: "accept-edits", name: "Accept edits" },
      { value: "auto", name: "Auto" },
      { value: "plan", name: "Plan" },
    ],
  });
  return opts;
}

function sessionResult(sessionId) {
  return {
    sessionId,
    models: {
      currentModelId: currentModel === "gemini-pro-orchestrator-neon" ? currentModel : `${currentModel}-${currentThought}`,
      availableModels: [
        { modelId: "gemini-4-neon-high", name: "Gemini 4 Neon (High)" },
        { modelId: "gemini-pro-orchestrator-neon", name: "Orchestrator (Neon)" },
        { modelId: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
      ],
    },
    modes: {
      currentModeId: currentMode,
      availableModes: [
        { id: "default", name: "Default", description: "Ask before edits and commands" },
        { id: "accept-edits", name: "Accept edits", description: "Approve edits" },
        { id: "auto", name: "Auto", description: "Approve safe actions" },
        { id: "plan", name: "Plan", description: "Plan only" },
      ],
    },
    configOptions: configOptions(),
  };
}

function update(sessionId, payload) {
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: payload } });
}

rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  // Client response to our session/request_permission
  if (msg.id && !msg.method && pendingPermission && msg.id === pendingPermission.rpcId) {
    const { sessionId, slow } = pendingPermission;
    pendingPermission = null;
    const outcome = msg.result?.outcome;
    const allowed = outcome?.outcome === "selected" && outcome?.optionId?.startsWith("allow");
    const finishPerm = () => {
      activeToolCallId = null;
      if (activePromptId === null) return;
      update(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "call_perm_1",
        name: "run_command",
        status: allowed ? "completed" : "cancelled",
        rawOutput: allowed ? { output: "ok\n", exit_code: 0 } : { output: "denied", exit_code: 1 },
        content: [{ type: "content", content: { type: "text", text: allowed ? "ok\n" : "denied" } }],
      });
      const replyText = allowed
        ? (steeredTexts.length ? `Allowed. Steers: ${steeredTexts.join(", ")}` : "Allowed and ran.")
        : "Permission denied.";
      steeredTexts = [];
      update(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: replyText },
      });
      const pid = activePromptId;
      activePromptId = null;
      send({ jsonrpc: "2.0", id: pid, result: { stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 12 } } });
    };
    if (slow) {
      activeTimer = setTimeout(() => {
        activeTimer = null;
        finishPerm();
      }, 250);
    } else {
      finishPerm();
    }
    return;
  }

  switch (msg.method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: "Fake Antigravity ACP", version: "1.5.14-test" },
          agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
        },
      });
      break;

    case "session/new": {
      const sid = "sess-new-1";
      send({ jsonrpc: "2.0", id: msg.id, result: sessionResult(sid) });
      update(sid, {
        sessionUpdate: "available_commands_update",
        availableCommands: [
          { name: "plan", description: "Plan carefully" },
          { name: "compact", description: "Compact context" },
        ],
      });
      update(sid, { sessionUpdate: "usage_update", used: 0, size: 1048576 });
      break;
    }

    case "session/list":
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          sessions: [
            { sessionId: "sess-old-1", cwd: msg.params?.cwd ?? "/tmp", title: "Previous Session", updatedAt: "2026-11-22T12:00:00Z" },
          ],
        },
      });
      break;

    case "session/load": {
      const sid = msg.params?.sessionId ?? "sess-old-1";
      update(sid, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Old question" } });
      update(sid, {
        sessionUpdate: "tool_call",
        toolCallId: "call_hist_1",
        name: "run_command",
        args: { CommandLine: "echo old" },
        status: "completed",
        rawOutput: { output: "old\n", exit_code: 0 },
        content: [{ type: "content", content: { type: "text", text: "old\n" } }],
      });
      update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Old answer" } });
      update(sid, { sessionUpdate: "usage_update", used: 4200, size: 1048576 });
      send({ jsonrpc: "2.0", id: msg.id, result: sessionResult(sid) });
      break;
    }

    case "session/set_config_option": {
      const sid = msg.params?.sessionId;
      if (msg.params?.configId === "model") currentModel = msg.params.value;
      if (msg.params?.configId === "thought_level") currentThought = msg.params.value;
      const opts = configOptions();
      send({ jsonrpc: "2.0", id: msg.id, result: { configOptions: opts } });
      update(sid, { sessionUpdate: "config_option_update", configOptions: opts });
      break;
    }

    case "session/set_model": {
      const sid = msg.params?.sessionId;
      const mid = String(msg.params?.modelId ?? "");
      const m = mid.match(/^(.+)-(low|medium|high|xhigh)$/);
      if (m) {
        currentModel = m[1];
        currentThought = m[2];
      } else if (mid) {
        currentModel = mid;
      }
      const opts = configOptions();
      send({ jsonrpc: "2.0", id: msg.id, result: {} });
      update(sid, { sessionUpdate: "config_option_update", configOptions: opts });
      break;
    }

    case "session/set_mode": {
      const sid = msg.params?.sessionId;
      currentMode = msg.params?.modeId ?? currentMode;
      send({ jsonrpc: "2.0", id: msg.id, result: {} });
      update(sid, { sessionUpdate: "current_mode_update", currentModeId: currentMode });
      break;
    }

    case "session/cancel": {
      if (activeTimer) {
        clearTimeout(activeTimer);
        activeTimer = null;
      }
      if (activeToolCallId && activeSessionId) {
        update(activeSessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId: activeToolCallId,
          name: "run_command",
          status: "failed",
          rawOutput: { error: "cancelled" },
        });
        activeToolCallId = null;
      }
      steeredTexts = [];
      pendingPermission = null;
      if (activePromptId !== null) {
        const pid = activePromptId;
        activePromptId = null;
        send({ jsonrpc: "2.0", id: pid, result: { stopReason: "cancelled" } });
      }
      break;
    }

    case "session/prompt": {
      const sid = msg.params?.sessionId;
      const text = (msg.params?.prompt ?? []).find((b) => b.type === "text")?.text ?? "";
      if (activePromptId !== null) {
        if (pendingPermission) {
          send({
            jsonrpc: "2.0",
            id: msg.id,
            error: {
              code: -32000,
              message: "the running prompt is waiting for a permission or question answer; answer it or send session/cancel, then send this prompt again",
            },
          });
          break;
        }
        steeredTexts.push(text);
        const prevId = activePromptId;
        activePromptId = msg.id;
        send({ jsonrpc: "2.0", id: prevId, result: { stopReason: "end_turn" } });
        break;
      }
      activeSessionId = sid;
      activeToolCallId = null;
      steeredTexts = [];
      lastPromptParams = msg.params;
      activePromptId = msg.id;

      if (text.includes("SLOW") && !text.includes("ASK_PERM")) {
        if (text.includes("STREAM_SLOW")) {
          update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Part 1." } });
          activeTimer = setTimeout(() => {
            activeTimer = null;
            if (activePromptId === null) return;
            update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " Part 1 done." } });
            update(sid, { sessionUpdate: "usage_update", used: 2000, size: 1048576 });
            if (steeredTexts.length) {
              update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Steered reply: ${steeredTexts.join(", ")}` } });
              update(sid, { sessionUpdate: "usage_update", used: 2400, size: 1048576 });
            }
            steeredTexts = [];
            const pid = activePromptId;
            activePromptId = null;
            send({ jsonrpc: "2.0", id: pid, result: { stopReason: "end_turn", usage: { inputTokens: 200, outputTokens: 30 } } });
          }, 350);
          break;
        }
        const callId = `call_slow_${msg.id}`;
        activeToolCallId = callId;
        update(sid, {
          sessionUpdate: "tool_call",
          toolCallId: callId,
          name: "run_command",
          args: { CommandLine: "sleep 1" },
          status: "in_progress",
        });
        activeTimer = setTimeout(() => {
          activeTimer = null;
          if (activePromptId === null) return;
          activeToolCallId = null;
          update(sid, {
            sessionUpdate: "tool_call_update",
            toolCallId: callId,
            name: "run_command",
            status: "completed",
            rawOutput: { output: "done\n", exit_code: 0 },
            content: [{ type: "content", content: { type: "text", text: "done\n" } }],
          });
          const reply = steeredTexts.length ? `ok: ${text} | steers: ${steeredTexts.join(", ")}` : `ok: ${text}`;
          steeredTexts = [];
          update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply } });
          const pid = activePromptId;
          activePromptId = null;
          send({ jsonrpc: "2.0", id: pid, result: { stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 20 } } });
        }, 400);
        break;
      }

      if (text.startsWith("ECHO:")) {
        update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `ok: ${text.slice(5).trim()}` } });
        activePromptId = null;
        send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn", usage: { inputTokens: 50, outputTokens: 10 } } });
        break;
      }

      if (text.includes("ASK_PERM")) {
        activeToolCallId = "call_perm_1";
        update(sid, {
          sessionUpdate: "tool_call",
          toolCallId: "call_perm_1",
          name: "run_command",
          args: { CommandLine: "rm -rf /tmp/test" },
          status: "in_progress",
        });
        pendingPermission = { rpcId: 9001, sessionId: sid, slow: text.includes("ASK_PERM_SLOW") };
        send({
          jsonrpc: "2.0",
          id: 9001,
          method: "session/request_permission",
          params: {
            sessionId: sid,
            toolCall: { toolCallId: "call_perm_1", name: "run_command", title: "rm -rf /tmp/test", rawInput: { CommandLine: "rm -rf /tmp/test" } },
            options: [
              { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
              { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
              { optionId: "reject_once", name: "Deny", kind: "reject_once" },
            ],
          },
        });
        break;
      }

      if (text.includes("HANG")) {
        update(sid, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking slowly..." } });
        break;
      }

      update(sid, { sessionUpdate: "session_info_update", title: "Test Turn Title" });
      update(sid, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Let me run a check." } });
      update(sid, {
        sessionUpdate: "tool_call",
        toolCallId: "call_1",
        name: "run_command",
        args: { CommandLine: "echo hi" },
        status: "in_progress",
      });
      update(sid, {
        sessionUpdate: "tool_call_update",
        toolCallId: "call_1",
        name: "run_command",
        status: "completed",
        rawOutput: { output: "hi\n", exit_code: 0 },
        content: [{ type: "content", content: { type: "text", text: "hi\n" } }],
      });
      update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello " } });
      update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "world!" } });
      update(sid, { sessionUpdate: "usage_update", used: 1500, size: 1048576 });
      activePromptId = null;
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          stopReason: "end_turn",
          usage: { inputTokens: 1400, outputTokens: 100, cachedReadTokens: 200, cachedWriteTokens: 0 },
        },
      });
      break;
    }
  }
});
