#!/usr/bin/env node
// fake-claude: a scriptable stand-in for `claude -p --input-format stream-json
// --output-format stream-json` with the control protocol. No dependencies.
// Records are shaped like the real CLI's (docs/dev/research/samples/claude/).
// See README.md for the scenario format and the replay mode.
import { readFileSync, appendFileSync, existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const VERSION = "2.1.303";
const argv = process.argv.slice(2);
if (argv.includes("--version")) {
  process.stdout.write(`${VERSION} (Claude Code)\n`);
  process.exit(0);
}
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
};

const SPEED = Number(process.env.FAKE_CLAUDE_SPEED || "1") || 1;
const LOG = process.env.FAKE_CLAUDE_LOG;
const scenario = process.env.FAKE_CLAUDE_SCENARIO ? JSON.parse(readFileSync(process.env.FAKE_CLAUDE_SCENARIO, "utf8")) : {};
const replayPath = process.env.FAKE_CLAUDE_REPLAY;
const REPLAY = argv.includes("--replay-user-messages");
const TURN_START_MS = scenario.turnStartMs ?? 600;
const STATES = process.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS === "1" && scenario.sessionStates !== false;
const resumeId = flag("--resume");
const sessionId = resumeId && !argv.includes("--fork-session") ? resumeId : flag("--session-id") ?? randomUUID();
let model = flag("--model") ?? "default";
let permissionMode = flag("--permission-mode") ?? "default";
let effort = flag("--effort") ?? null;

const log = (rec) => LOG && appendFileSync(LOG, JSON.stringify(rec) + "\n");
log({ type: "_start", argv, env: { PI_CHAT_HOST: process.env.PI_CHAT_HOST ?? null, CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: process.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS ?? null, NODE_OPTIONS: process.env.NODE_OPTIONS ?? null, HERDR_PANE_ID: process.env.HERDR_PANE_ID ?? null, HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH ?? null, HERDR_ENV: process.env.HERDR_ENV ?? null }, cwd: process.cwd() });

const out = (rec) => process.stdout.write(JSON.stringify(rec) + "\n");
const uuid = () => randomUUID();
const now = () => new Date().toISOString();
const base = () => ({ session_id: sessionId, uuid: uuid() });

const MODELS = scenario.models ?? [
  { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)", description: "Opus 5.5", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
  { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
  { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet 5.5", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
  { value: "haiku", resolvedModel: "claude-haiku-5-5", displayName: "Haiku 5.5", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high"] },
];
const resolved = () => MODELS.find((m) => m.value === model)?.resolvedModel ?? model;
const COMMANDS = scenario.commands ?? [
  { name: "context", description: "Show context usage", argumentHint: "" },
  { name: "review", description: "Review a pull request", argumentHint: "" },
  { name: "doctor", description: "Diagnose the installation", argumentHint: "" },
  { name: "tdd", description: "Test-driven development loop (user)", argumentHint: "" },
];

// ---------- the transcript on disk ($CLAUDE_CONFIG_DIR/projects/<cwd>/<id>.jsonl) ----------
const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
let realCwd = process.cwd();
try {
  realCwd = realpathSync(realCwd);
} catch {}
const projectDir = join(configDir, "projects", realCwd.replace(/[^A-Za-z0-9]/g, "-"));
const transcript = join(projectDir, `${sessionId}.jsonl`);
let lastUuid = null;
if (resumeId && !existsSync(join(projectDir, `${resumeId}.jsonl`)) && !replayPath) {
  process.stderr.write(`No conversation found with session ID: ${resumeId}\n`);
  process.exit(1);
}
if (resumeId && existsSync(transcript)) {
  for (const l of readFileSync(transcript, "utf8").split("\n")) {
    try {
      const r = JSON.parse(l);
      if (r.uuid && !r.isSidechain) lastUuid = r.uuid;
    } catch {}
  }
}
// --fork-session: like the CLI, the fork's transcript is written at its first
// record: the resumed session's branch up to --resume-session-at (else all of
// it), under the new session id.
let forkCopy = resumeId && argv.includes("--fork-session") && !replayPath ? join(projectDir, `${resumeId}.jsonl`) : null;
function copyFork() {
  const src = forkCopy;
  forkCopy = null;
  if (!src || !existsSync(src)) return;
  const recs = readFileSync(src, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((r) => r?.uuid && !r.isSidechain);
  const byUuid = new Map(recs.map((r) => [r.uuid, r]));
  const at = flag("--resume-session-at");
  const chain = [];
  for (let r = at ? byUuid.get(at) : recs.at(-1); r; r = r.parentUuid ? byUuid.get(r.parentUuid) : null) chain.unshift(r);
  mkdirSync(dirname(transcript), { recursive: true });
  for (const r of chain) appendFileSync(transcript, JSON.stringify({ ...r, sessionId }) + "\n");
  lastUuid = chain.at(-1)?.uuid ?? null;
}
function disk(rec, file = transcript) {
  if (replayPath) return rec;
  if (forkCopy) copyFork();
  mkdirSync(dirname(file), { recursive: true });
  const full = { parentUuid: file === transcript ? lastUuid : rec.parentUuid ?? null, isSidechain: file !== transcript, ...rec, uuid: rec.uuid ?? uuid(), timestamp: now(), sessionId, entrypoint: "sdk-cli", cwd: realCwd, version: VERSION };
  if (file === transcript) lastUuid = full.uuid;
  appendFileSync(file, JSON.stringify(full) + "\n");
  return full;
}
// The CLI's live-process registry.
const registry = join(configDir, "sessions", `${process.pid}.json`);
if (!replayPath) {
  mkdirSync(dirname(registry), { recursive: true });
  writeFileSync(registry, JSON.stringify({ pid: process.pid, sessionId, cwd: realCwd, kind: "interactive", entrypoint: "sdk-cli", status: "idle" }));
}
const cleanup = () => {
  try {
    if (!replayPath) writeFileSync(registry, "{}");
  } catch {}
};

// ---------- time ----------
let interrupted = false;
let wake = null;
function sleep(ms) {
  return new Promise((r) => {
    const t = setTimeout(() => {
      wake = null;
      r();
    }, ms / SPEED);
    wake = () => {
      clearTimeout(t);
      wake = null;
      r();
    };
  });
}
class Interrupted extends Error {}
const check = () => {
  if (interrupted) throw new Interrupted();
};

// ---------- control requests to the host ----------
const waiting = new Map(); // request_id -> resolve(response)
function ask(request) {
  const request_id = uuid();
  out({ type: "control_request", request_id, request });
  return new Promise((resolve) => waiting.set(request_id, { resolve, request }));
}
function withdraw(request_id) {
  const w = waiting.get(request_id);
  if (!w) return;
  waiting.delete(request_id);
  out({ type: "control_cancel_request", request_id });
  w.resolve(null);
}

// ---------- the turn engine ----------
let busy = false;
let turn = null; // { prompt, steers: [], laterQueue... }
const later = []; // queued "later" messages: {uuid, text, content}
const steers = []; // queued "next" messages waiting for a tool boundary
let msgIndex = 0;
let current = null; // the open assistant message
const tasks = new Map(); // task_id -> { output, done }
let cost = 0;
let contextTokens = 20000;

function state(s) {
  if (STATES) out({ type: "system", subtype: "session_state_changed", state: s, ...base() });
}
function lifecycle(u, s) {
  if (u) out({ type: "command_lifecycle", command_uuid: u, state: s, ...base() });
}
function textOf(content) {
  return typeof content === "string" ? content : Array.isArray(content) ? content.filter((b) => b.type === "text").map((b) => b.text).join("\n") : "";
}
const fill = (s, ctx) => String(s).replace(/\{prompt\}/g, ctx.prompt).replace(/\{steers\}/g, ctx.steered.join(" / ")).replace(/\{model\}/g, model).replace(/\{effort\}/g, effort ?? "default").replace(/\{mode\}/g, permissionMode).replace(/\{cwd\}/g, realCwd);
const fillDeep = (v, ctx) => JSON.parse(fill(JSON.stringify(v ?? {}), ctx));

function openMessage() {
  if (current) return current;
  const id = `msg_fake${(++msgIndex).toString().padStart(4, "0")}`;
  current = { id, index: 0, blocks: [] };
  out({ type: "stream_event", event: { type: "message_start", message: { model: resolved(), id, type: "message", role: "assistant", content: [], usage: { input_tokens: 3, output_tokens: 1 } } }, parent_tool_use_id: null, ...base(), api_message_id: id });
  return current;
}
function assistantRecord(m, block, stop = null, extra = {}) {
  const rec = { type: "assistant", message: { model: resolved(), id: m.id, type: "message", role: "assistant", content: [block], stop_reason: stop, usage: { input_tokens: 3, output_tokens: 7, cache_read_input_tokens: 100, cache_creation_input_tokens: 10 } }, parent_tool_use_id: null, ...base(), timestamp: now(), ...extra };
  out(rec);
  return rec;
}
async function streamBlock(kind, text) {
  const m = openMessage();
  const index = m.index++;
  out({ type: "stream_event", event: { type: "content_block_start", index, content_block: kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "", signature: "" } }, parent_tool_use_id: null, ...base() });
  const parts = text.match(/[\s\S]{1,12}/g) ?? [];
  for (const p of parts) {
    check();
    await sleep(15);
    check();
    out({ type: "stream_event", event: { type: "content_block_delta", index, delta: kind === "text" ? { type: "text_delta", text: p } : { type: "thinking_delta", thinking: p } }, parent_tool_use_id: null, ...base() });
  }
  const block = kind === "text" ? { type: "text", text } : { type: "thinking", thinking: text, signature: "sig" };
  assistantRecord(m, block);
  m.blocks.push(block);
  out({ type: "stream_event", event: { type: "content_block_stop", index }, parent_tool_use_id: null, ...base() });
}
function closeMessage(stop) {
  const m = current;
  if (!m) return;
  current = null;
  out({ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: stop }, usage: { input_tokens: 3, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 10 } }, parent_tool_use_id: null, ...base() });
  out({ type: "stream_event", event: { type: "message_stop" }, parent_tool_use_id: null, ...base() });
  for (const b of m.blocks) disk({ type: "assistant", message: { model: resolved(), id: m.id, type: "message", role: "assistant", content: [b], stop_reason: stop, usage: { input_tokens: 3, output_tokens: 20 } } });
  cost += 0.001;
  contextTokens += 500;
}
async function toolUseBlock(name, input) {
  const m = openMessage();
  const index = m.index++;
  const id = `toolu_fake${(++msgIndex).toString().padStart(4, "0")}`;
  out({ type: "stream_event", event: { type: "content_block_start", index, content_block: { type: "tool_use", id, name, input: {} } }, parent_tool_use_id: null, ...base() });
  const json = JSON.stringify(input);
  for (const p of json.match(/[\s\S]{1,16}/g) ?? []) {
    await sleep(5);
    out({ type: "stream_event", event: { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: p } }, parent_tool_use_id: null, ...base() });
  }
  const block = { type: "tool_use", id, name, input };
  assistantRecord(m, block);
  m.blocks.push(block);
  out({ type: "stream_event", event: { type: "content_block_stop", index }, parent_tool_use_id: null, ...base() });
  return id;
}
function toolResult(id, content, isError, tur, meta = {}, parent = null, agentFile = null) {
  const block = { tool_use_id: id, type: "tool_result", content, ...(isError ? { is_error: true } : {}) };
  const rec = { type: "user", message: { role: "user", content: [block] }, parent_tool_use_id: parent, ...base(), timestamp: now(), ...(tur !== undefined ? { tool_use_result: tur } : {}), tool_result_meta: [{ id, ...meta }] };
  out(rec);
  const d = { type: "user", message: { role: "user", content: [block] }, ...(tur !== undefined ? { toolUseResult: tur } : {}) };
  if (meta.permission_decision) d.permissionDecision = meta.permission_decision;
  if (meta.non_execution_kind) d.toolDenialKind = meta.non_execution_kind;
  if (agentFile) disk({ ...d, parentUuid: null }, agentFile);
  else if (!parent) disk(d);
}

/** At a tool boundary, steered messages are folded into the turn. */
function foldSteers(ctx) {
  while (steers.length) {
    const s = steers.shift();
    if (REPLAY) out({ type: "user", message: { role: "user", content: s.content }, ...base(), uuid: s.uuid ?? uuid(), parent_tool_use_id: null, timestamp: now(), isReplay: true });
    lifecycle(s.uuid, "started");
    disk({ type: "user", message: { role: "user", content: s.content } });
    ctx.steered.push(textOf(s.content));
    ctx.uuids.push(s.uuid);
  }
}

async function permission(name, input, id, step) {
  if (step.ask === false || (step.ask === undefined && !["Bash", "Write", "Edit", "WebFetch", "WebSearch"].includes(name)) || ["bypassPermissions", "dontAsk"].includes(permissionMode)) return { behavior: "allow", source: "config" };
  if (permissionMode === "acceptEdits" && ["Write", "Edit"].includes(name)) return { behavior: "allow", source: "mode" };
  if (allowRules.has(name) || allowRules.has(`${name}(${input.command ?? ""})`)) return { behavior: "allow", source: "rule" };
  state("requires_action");
  const suggestions = [{ type: "addRules", rules: [{ toolName: name, ...(input.command ? { ruleContent: input.command } : {}) }], behavior: "allow", destination: "session" }, { type: "setMode", mode: "acceptEdits", destination: "session" }];
  const req = { subtype: "can_use_tool", tool_name: name, display_name: name, input, description: input.description ?? name, permission_suggestions: suggestions, tool_use_id: id, ...(step.decisionReason ? { decision_reason: step.decisionReason } : {}) };
  const p = ask(req);
  if (step.withdrawAfterMs) {
    const rid = [...waiting.keys()].at(-1);
    setTimeout(() => withdraw(rid), step.withdrawAfterMs / SPEED);
  }
  const r = await p;
  state("running");
  if (!r) return { behavior: "deny", message: "Withdrawn", withdrawn: true };
  const resp = r.response ?? {};
  for (const u of resp.updatedPermissions ?? []) {
    if (u.type === "addRules") for (const rule of u.rules ?? []) allowRules.add(rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName);
    if (u.type === "setMode") setMode(u.mode);
  }
  return resp;
}
const allowRules = new Set();
function setMode(m) {
  permissionMode = m;
  out({ type: "system", subtype: "status", status: null, permissionMode: m, ...base() });
}

async function runTool(step, ctx) {
  const name = step.tool;
  const input = fillDeep(step.input, ctx);
  const id = await toolUseBlock(name, input);
  closeMessage("tool_use");
  const decision = await permission(name, input, id, step);
  check();
  if (decision.behavior !== "allow") {
    const msg = decision.message ?? "The user denied this.";
    toolResult(id, msg, true, `Error: ${msg}`, decision.withdrawn ? { non_execution_kind: "permission-rule" } : { non_execution_kind: "permission-rule", permission_decision: { decision: "reject", source: "user_reject" } });
    return;
  }
  const meta = { permission_decision: { decision: "accept", source: decision.source ?? "user_temporary" } };
  let taskId = null;
  if (step.task) {
    taskId = `bfake${msgIndex}`;
    const t = { output: "", done: false };
    tasks.set(taskId, t);
    out({ type: "system", subtype: "task_started", task_id: taskId, tool_use_id: id, description: input.description ?? name, task_type: "local_bash", ...base() });
    try {
      for (const line of step.task.lines ?? []) {
        await sleep(step.task.everyMs ?? 300);
        check();
        t.output += line + "\n";
      }
    } catch (e) {
      out({ type: "system", subtype: "task_notification", task_id: taskId, tool_use_id: id, status: "stopped", summary: "stopped", ...base() });
      toolResult(id, "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.", true, "User rejected tool use", { non_execution_kind: "user-rejected" });
      throw e;
    }
    t.done = true;
    out({ type: "system", subtype: "task_notification", task_id: taskId, tool_use_id: id, status: step.result?.is_error ? "failed" : "completed", summary: "done", ...base() });
  } else if (step.durationMs) {
    try {
      await sleep(step.durationMs);
      check();
    } catch (e) {
      toolResult(id, "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.", true, "User rejected tool use", { non_execution_kind: "user-rejected" });
      throw e;
    }
  }
  const r = step.result ?? {};
  const content = r.content ?? (taskId ? tasks.get(taskId).output.trimEnd() : "ok");
  toolResult(id, typeof content === "string" ? fill(content, ctx) : content, r.is_error === true, r.tool_use_result ?? (name === "Bash" ? { stdout: typeof content === "string" ? content : "", stderr: "", interrupted: false } : undefined), meta);
  foldSteers(ctx);
}

async function runSubagent(step, ctx) {
  const s = step.subagent;
  const input = { description: s.description ?? "Subagent", prompt: s.prompt ?? "Do the thing", subagent_type: s.type ?? "general-purpose" };
  const id = await toolUseBlock("Agent", input);
  closeMessage("tool_use");
  const agentId = `afake${msgIndex}`;
  const agentFile = join(projectDir, sessionId, "subagents", `agent-${agentId}.jsonl`);
  out({ type: "system", subtype: "task_started", task_id: agentId, tool_use_id: id, description: input.description, subagent_type: input.subagent_type, task_type: "local_agent", prompt: input.prompt, ...base() });
  out({ type: "user", message: { role: "user", content: [{ type: "text", text: input.prompt }] }, parent_tool_use_id: id, agent_id: agentId, ...base(), timestamp: now() });
  disk({ type: "user", message: { role: "user", content: input.prompt }, agentId, parentUuid: null }, agentFile);
  for (const t of s.steps ?? []) {
    await sleep(40);
    check();
    if (t.text) {
      const block = { type: "text", text: t.text };
      out({ type: "assistant", message: { model: resolved(), id: `msg_sub${++msgIndex}`, type: "message", role: "assistant", content: [block], stop_reason: null }, parent_tool_use_id: id, agent_id: agentId, ...base(), timestamp: now() });
      disk({ type: "assistant", message: { model: resolved(), id: `msg_sub${msgIndex}`, role: "assistant", content: [block] }, agentId, parentUuid: null }, agentFile);
      continue;
    }
    const sid = `toolu_sub${++msgIndex}`;
    const block = { type: "tool_use", id: sid, name: t.tool, input: t.input ?? {} };
    out({ type: "assistant", message: { model: resolved(), id: `msg_sub${msgIndex}`, type: "message", role: "assistant", content: [block], stop_reason: null }, parent_tool_use_id: id, agent_id: agentId, ...base(), timestamp: now() });
    disk({ type: "assistant", message: { model: resolved(), id: `msg_sub${msgIndex}`, role: "assistant", content: [block] }, agentId, parentUuid: null }, agentFile);
    await sleep(40);
    toolResult(sid, t.result?.content ?? "ok", t.result?.is_error === true, t.result?.tool_use_result, { permission_decision: { decision: "accept", source: "config" } }, id, agentFile);
  }
  const report = s.report ?? "Done.";
  disk({ type: "assistant", message: { model: resolved(), id: `msg_sub${++msgIndex}`, role: "assistant", content: [{ type: "text", text: report }] }, agentId, parentUuid: null }, agentFile);
  out({ type: "system", subtype: "task_notification", task_id: agentId, tool_use_id: id, status: "completed", summary: report, ...base() });
  toolResult(id, [{ type: "text", text: `[Subagent hand-back] The text below is the final report of a subagent.\n\n${report}` }], false, { status: "completed", prompt: input.prompt, agentId, agentType: input.subagent_type, content: [{ type: "text", text: report }] }, { permission_decision: { decision: "accept", source: "config" } });
  foldSteers(ctx);
}

async function runQuestion(step, ctx) {
  const input = { questions: step.question.questions };
  const id = await toolUseBlock("AskUserQuestion", input);
  closeMessage("tool_use");
  state("requires_action");
  const r = await ask({ subtype: "can_use_tool", tool_name: "AskUserQuestion", display_name: "AskUserQuestion", input, tool_use_id: id, requires_user_interaction: true });
  state("running");
  const resp = r?.response ?? {};
  const answers = resp.updatedInput?.answers;
  if (resp.behavior === "allow" && answers && Object.keys(answers).length) {
    const text = Object.entries(answers).map(([q, a]) => `"${q}"="${a}"`).join(", ");
    ctx.answers = answers;
    toolResult(id, `Your questions have been answered: ${text}. You can now continue with these answers in mind.`, false, { questions: input.questions, answers }, { permission_decision: { decision: "accept", source: "user_temporary" } });
  } else {
    toolResult(id, "The user did not answer the questions.", false, { questions: input.questions, answers: {} }, { permission_decision: { decision: "accept", source: "user_temporary" } });
  }
}

async function runPlan(step) {
  const input = { plan: step.plan };
  const id = await toolUseBlock("ExitPlanMode", input);
  closeMessage("tool_use");
  state("requires_action");
  const r = await ask({ subtype: "can_use_tool", tool_name: "ExitPlanMode", display_name: "ExitPlanMode", input, tool_use_id: id, requires_user_interaction: true });
  state("running");
  const resp = r?.response ?? {};
  for (const u of resp.updatedPermissions ?? []) if (u.type === "setMode") setMode(u.mode);
  if (resp.behavior === "allow") toolResult(id, "User has approved your plan. You can now start coding.", false, { plan: step.plan, isAgent: false }, { permission_decision: { decision: "accept", source: "user_temporary" } });
  else toolResult(id, resp.message ?? "Keep planning", true, `Error: ${resp.message ?? "Keep planning"}`, { non_execution_kind: "permission-rule", permission_decision: { decision: "reject", source: "user_reject" } });
}

function result(ctx, extra = {}) {
  out({
    type: "result", subtype: "success", is_error: false, num_turns: ctx.turns ?? 1, result: ctx.lastText ?? "", stop_reason: "end_turn", total_cost_usd: cost,
    usage: { input_tokens: 3, output_tokens: 20 }, modelUsage: { [resolved()]: { costUSD: cost, contextWindow: 1000000 } }, permission_denials: [], terminal_reason: "completed",
    queued_turn_count: later.length, ...(ctx.uuids.length ? { user_message_uuids: ctx.uuids } : {}), ...base(), ...extra,
  });
}

function findTurn(prompt) {
  const turns = scenario.turns ?? [];
  for (const t of turns) {
    if (t.used && t.once) continue;
    if (new RegExp(t.match ?? ".*", "s").test(prompt)) {
      t.used = true;
      return { steps: t.steps ?? [], startMs: t.startMs ?? TURN_START_MS };
    }
  }
  return { steps: scenario.default ?? [{ text: "ok: {prompt}" }], startMs: TURN_START_MS };
}

async function localCommand(prompt, ctx) {
  const [, name, rest] = /^\/(\S+)\s*([\s\S]*)$/.exec(prompt) ?? [];
  if (name === "compact") {
    out({ type: "system", subtype: "status", status: "compacting", ...base() });
    await sleep(scenario.compactMs ?? 200);
    const before = contextTokens;
    contextTokens = 3000;
    out({ type: "system", subtype: "status", status: null, compact_result: "success", ...base() });
    out({ type: "system", subtype: "init", ...initFields(), ...base() });
    out({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: before, post_tokens: contextTokens, duration_ms: 200 }, ...base() });
    lastUuid = null;
    disk({ type: "system", subtype: "compact_boundary", content: "Conversation compacted", compactMetadata: { trigger: "manual", preTokens: before, postTokens: contextTokens }, logicalParentUuid: lastUuidBefore() });
    disk({ type: "user", isCompactSummary: true, message: { role: "user", content: `This session is being continued from a previous conversation.${rest ? " Instructions: " + rest : ""}` } });
    if (REPLAY) out({ type: "user", message: { role: "user", content: "<local-command-stdout>Compacted </local-command-stdout>" }, ...base(), parent_tool_use_id: null, isReplay: true });
    result(ctx, { num_turns: 0, result: "", stop_reason: null, local_command: "compact" });
    return true;
  }
  if (name === "context" || name === "cost") {
    out({ type: "system", subtype: "init", ...initFields(), ...base() });
    const text = name === "context" ? `## Context Usage\n\n**Model:** ${resolved()}\n**Tokens:** ${Math.round(contextTokens / 1000)}k / 1m` : "You are currently using your subscription.";
    out({ type: "assistant", message: { id: uuid(), model: "<synthetic>", role: "assistant", type: "message", stop_reason: "end_turn", content: [{ type: "text", text }] }, parent_tool_use_id: null, ...base() });
    if (REPLAY) out({ type: "user", message: { role: "user", content: `<command-name>/${name}</command-name>\n            <command-message>${name}</command-message>\n            <command-args>${rest}</command-args>` }, ...base(), uuid: ctx.uuid ?? uuid(), parent_tool_use_id: null, isReplay: true });
    disk({ type: "user", message: { role: "user", content: `<command-name>/${name}</command-name>\n            <command-message>${name}</command-message>\n            <command-args>${rest}</command-args>` } });
    disk({ type: "system", subtype: "local_command", content: `<local-command-stdout>${text}</local-command-stdout>`, level: "info" });
    result(ctx, { num_turns: 0, result: text, stop_reason: null, local_command: name });
    return true;
  }
  if (name === "theme") {
    out({ type: "system", subtype: "init", ...initFields(), ...base() });
    const text = "/theme isn't available in this environment.";
    out({ type: "assistant", message: { id: uuid(), model: "<synthetic>", role: "assistant", type: "message", content: [{ type: "text", text }] }, parent_tool_use_id: null, ...base() });
    result(ctx, { num_turns: 0, result: text, stop_reason: null });
    return true;
  }
  return false;
}
let compactParent = null;
const lastUuidBefore = () => compactParent;

function initFields() {
  return { cwd: realCwd, tools: ["Bash", "Read", "Edit", "Write", "Agent", "AskUserQuestion", "ExitPlanMode", "TodoWrite", "WebSearch", "WebFetch"], mcp_servers: [], model: resolved(), permissionMode, slash_commands: COMMANDS.map((c) => c.name), terminal_slash_commands: ["doctor", "color", "focus", "reload-plugins"], apiKeySource: "none", claude_code_version: VERSION, capabilities: ["interrupt_receipt_v1", "interrupt_cancel_queued_v1", "msg_lifecycle_v1"] };
}

async function runTurn(first) {
  busy = true;
  interrupted = false;
  const ctx = { prompt: textOf(first.content), steered: [], uuids: first.uuid ? [first.uuid] : [], uuid: first.uuid, turns: 1, lastText: "" };
  state("running");
  if (!first.queuedStart) {
    lifecycle(first.uuid, "queued");
    lifecycle(first.uuid, "started");
  }
  compactParent = lastUuid;
  try {
    await turnBody(first, ctx);
  } catch (e) {
    if (!(e instanceof Interrupted)) throw e;
    if (current) closeMessage("end_turn");
    out({ type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] }, parent_tool_use_id: null, ...base() });
    disk({ type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] } });
    out({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 1, result: "", stop_reason: "tool_use", terminal_reason: "aborted_tools", queued_turn_count: 0, errors: ["[ede_diagnostic] aborted"], total_cost_usd: cost, ...base() });
  } finally {
    busy = false;
    interrupted = false;
  }
  if (later.length) {
    const next = later.shift();
    lifecycle(next.uuid, "started");
    return runTurn({ ...next, queuedStart: true });
  }
  state("idle");
}

async function turnBody(first, ctx) {
  {
    if (/^\//.test(ctx.prompt) && (await localCommand(ctx.prompt, ctx))) {
      lifecycle(first.uuid, "completed");
      return;
    }
    out({ type: "system", subtype: "init", ...initFields(), ...base() });
    out({ type: "system", subtype: "status", status: "requesting", ...base() });
    const { steps, startMs } = findTurn(ctx.prompt);
    // The CLI replays the prompt only when the model starts answering, with `message_start`:
    // 600–1000 ms after the prompt in the recordings, sometimes 2–3.5 s.
    await sleep(startMs);
    check();
    if (REPLAY) out({ type: "user", message: { role: "user", content: first.content }, ...base(), uuid: first.uuid ?? uuid(), parent_tool_use_id: null, timestamp: now(), isReplay: true });
    disk({ type: "user", message: { role: "user", content: first.content } });
    openMessage();
    for (const step of steps) {
      check();
      if (step.apiError) {
        closeMessage("end_turn");
        out({ type: "assistant", message: { id: uuid(), model: "<synthetic>", role: "assistant", content: [{ type: "text", text: step.text ?? "API Error: " + step.apiError }] }, error: step.apiError, parent_tool_use_id: null, ...base() });
        out({ type: "result", subtype: "success", is_error: true, result: step.text ?? "API Error", num_turns: 1, terminal_reason: "completed", queued_turn_count: 0, ...base() });
        return;
      } else if (step.sleep) await sleep(step.sleep);
      else if (step.thinking) await streamBlock("thinking", fill(step.thinking, ctx));
      else if (step.text) {
        if (step.afterSteers !== false) foldSteers(ctx);
        const t = fill(step.text, ctx);
        await streamBlock("text", t);
        ctx.lastText = t;
      } else if (step.tool) await runTool(step, ctx);
      else if (step.subagent) await runSubagent(step, ctx);
      else if (step.question) await runQuestion(step, ctx);
      else if (step.plan) await runPlan(step);
      else if (step.todos) await runTool({ tool: "TodoWrite", input: { todos: step.todos }, ask: false, result: { content: "Todos have been modified successfully.", tool_use_result: { oldTodos: [], newTodos: step.todos } } }, ctx);
      else if (step.retry) {
        out({ type: "system", subtype: "api_retry", attempt: step.retry.attempt ?? 1, max_retries: step.retry.max ?? 10, retry_delay_ms: step.retry.delayMs ?? 500, error_status: 529, error: step.retry.error ?? "overloaded", ...base() });
        await sleep(step.retry.delayMs ?? 500);
      } else if (step.notice) out({ type: "system", subtype: "notification", key: "n", text: step.notice, priority: step.priority ?? "low", ...base() });
      else if (step.rateLimit) out({ type: "rate_limit_event", rate_limit_info: { status: step.rateLimit, rateLimitType: "five_hour", resetsAt: Math.floor(Date.now() / 1000) + 3600 }, ...base() });
      else if (step.apiError) {
        closeMessage("end_turn");
        out({ type: "assistant", message: { id: uuid(), model: "<synthetic>", role: "assistant", content: [{ type: "text", text: step.text ?? "API Error: " + step.apiError }] }, error: step.apiError, parent_tool_use_id: null, ...base() });
        out({ type: "result", subtype: "success", is_error: true, result: step.text ?? "API Error", num_turns: 1, terminal_reason: "completed", queued_turn_count: 0, ...base() });
        return;
      } else if (step.hang) {
        // Silence: nothing until an interrupt (or nothing at all).
        while (!interrupted || step.ignoreInterrupt) await sleep(1000);
        check();
      } else if (step.crash !== undefined) {
        process.stderr.write(step.stderr ?? "fake-claude: crashed on purpose\n");
        cleanup();
        process.exit(step.crash);
      } else if (step.autonomous) setTimeout(() => void runTurn({ content: step.autonomous }), (step.afterMs ?? 300) / SPEED);
    }
    foldSteers(ctx);
    if (current) closeMessage("end_turn");
    result(ctx);
    for (const u of ctx.uuids) lifecycle(u, "completed");
  }
}

// ---------- replay mode: a recorded session's turns, by prompt ----------
let replay = null;
if (replayPath) {
  const recs = readFileSync(replayPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  replay = { init: null, pre: [], turns: [] };
  let cur = null;
  for (const r of recs) {
    if (r.dir === "out" && r.rec.type === "control_response" && r.rec.response?.response?.commands && !replay.init) {
      replay.init = r.rec.response.response;
      continue;
    }
    if (r.dir === "in" && r.rec.type === "user") {
      // A message sent mid-turn (a steer) belongs to the turn that's running.
      if (cur && !cur.ended) {
        cur.steers.push(textOf(r.rec.message.content));
        continue;
      }
      cur = { prompt: textOf(r.rec.message.content), records: [], ended: false, steers: [] };
      replay.turns.push(cur);
      continue;
    }
    if (cur && r.dir === "out" && r.rec.type === "result" && !(r.rec.queued_turn_count > 0)) cur.ended = true;
    if (r.dir !== "out") continue;
    if (!cur) {
      if (r.rec.type === "system") replay.pre.push(r);
      continue;
    }
    // Echoes of the recording's own control responses, and replies to its control requests.
    if (r.rec.type === "control_response") continue;
    // The tail of the previous turn (its completion and idle) can be logged after the next prompt.
    const prev = replay.turns.at(-2);
    const tail = (r.rec.type === "command_lifecycle" && r.rec.state === "completed") || (r.rec.subtype === "session_state_changed" && r.rec.state === "idle");
    if (prev && tail && !cur.records.some((x) => x.rec.subtype === "session_state_changed" && x.rec.state === "running")) {
      prev.records.push(r);
      continue;
    }
    cur.records.push(r);
  }
}
async function replayTurn(first) {
  busy = true;
  const prompt = textOf(first.content);
  const t = replay.turns.find((x) => !x.used && x.prompt === prompt) ?? replay.turns.find((x) => !x.used && x.prompt.startsWith(prompt.slice(0, 40)));
  if (!t) {
    out({ type: "result", subtype: "error_during_execution", is_error: true, result: `fake-claude: no recorded turn for ${JSON.stringify(prompt)}`, num_turns: 0, ...base() });
    busy = false;
    return;
  }
  t.used = true;
  replayCurrent = t;
  let prev = t.records[0]?.t ?? 0;
  for (const r of t.records) {
    await sleep(Math.min(Math.max(0, r.t - prev), 300));
    prev = r.t;
    const rec = structuredClone(r.rec);
    if (rec.session_id) rec.session_id = sessionId;
    if (rec.type === "user" && rec.isReplay && textOf(rec.message?.content) === prompt && first.uuid) rec.uuid = first.uuid;
    else if (rec.type === "user" && rec.isReplay && t.steers.includes(textOf(rec.message?.content))) {
      // A steer's replay: the CLI can't echo it before it got it, and it echoes its uuid.
      const u = await steerFromHost(textOf(rec.message.content));
      if (u) rec.uuid = u;
    }
    if (rec.type === "control_request") {
      out(rec);
      await new Promise((resolve) => waiting.set(rec.request_id, { resolve, request: rec.request }));
      continue;
    }
    out(rec);
  }
  busy = false;
  replayCurrent = null;
  const next = replayQueue.shift();
  if (next) void replayTurn(next);
}
let replayCurrent = null;
const replayQueue = [];
const steersIn = new Map(); // text -> the host's uuid, or a waiter
function steerFromHost(text) {
  const v = steersIn.get(text);
  if (v && !v.wait) return Promise.resolve(v.uuid);
  return new Promise((resolve) => steersIn.set(text, { wait: resolve }));
}
function steerIn(text, uuid) {
  const v = steersIn.get(text);
  steersIn.set(text, { uuid });
  v?.wait?.(uuid);
}

// ---------- control requests from the host ----------
async function control(rec) {
  const { request_id, request } = rec;
  const ok = (response = {}) => out({ type: "control_response", response: { subtype: "success", request_id, response } });
  const fail = (error) => out({ type: "control_response", response: { subtype: "error", request_id, error } });
  switch (request.subtype) {
    case "initialize": {
      const init = scenario.initialize ?? {};
      if (init.delayMs) await sleep(init.delayMs);
      if (init.hang) return;
      if (init.fail) return fail(init.fail);
      if (replay?.init) return ok({ ...replay.init, current_permission_mode: permissionMode });
      return ok({ commands: COMMANDS, agents: [], models: MODELS, account: {}, pid: process.pid, claude_code_version: VERSION, current_permission_mode: permissionMode, session_state: "idle", capabilities: [] });
    }
    case "interrupt": {
      if (scenario.ignoreInterrupt) return;
      const cancelled = request.cancel_queued ? [...steers.splice(0), ...later.splice(0)].map((s) => s.uuid).filter(Boolean) : [];
      for (const u of cancelled) lifecycle(u, "cancelled");
      ok({ still_queued: request.cancel_queued ? [] : [...steers, ...later].map((s) => s.uuid), cancelled });
      if (busy) {
        interrupted = true;
        for (const [, w] of waiting) w.resolve(null);
        waiting.clear();
        wake?.();
      }
      return;
    }
    case "set_model":
      model = request.model ?? "default";
      return ok();
    case "set_permission_mode":
      setMode(request.mode);
      return ok({ mode: request.mode });
    case "apply_flag_settings":
      if (request.settings?.effortLevel) effort = request.settings.effortLevel;
      return ok();
    case "get_context_usage":
      return ok({ totalTokens: contextTokens, maxTokens: 1000000, percentage: Math.round((contextTokens / 1000000) * 100), model: resolved(), categories: [] });
    case "rename_session":
      out({ type: "system", subtype: "session_title_changed", title: request.title, ...base() });
      if (!replayPath) appendFileSync(transcript, JSON.stringify({ type: "custom-title", customTitle: request.title, sessionId }) + "\n");
      return ok();
    case "get_task_output": {
      const t = tasks.get(request.task_id);
      if (!t) return fail("No such task");
      return ok({ output: t.output, total_bytes: t.output.length, truncated: false });
    }
    case "list_models":
      return ok({ models: MODELS });
    case "cancel_async_message": {
      // "Drops a pending async user message from the command queue by uuid. No-op if already dequeued" (sdk.d.ts): either priority.
      let found = false;
      for (const q of [steers, later]) {
        const i = q.findIndex((s) => s.uuid === request.message_uuid);
        if (i >= 0) {
          q.splice(i, 1);
          found = true;
        }
      }
      if (found) lifecycle(request.message_uuid, "cancelled");
      return ok({ cancelled: found });
    }
  }
  return fail(`Unsupported control request subtype: ${request.subtype}`);
}

// ---------- stdin ----------
for (const r of replay?.pre ?? []) out(structuredClone({ ...r.rec, session_id: sessionId }));
let buf = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  let i;
  while ((i = buf.indexOf(10)) >= 0) {
    const line = buf.subarray(0, i).toString("utf8");
    buf = buf.subarray(i + 1);
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    log(rec);
    if (rec.type === "control_request") void control(rec);
    else if (rec.type === "control_response") {
      const w = waiting.get(rec.response?.request_id);
      // The CLI echoes the answers it gets (with --replay-user-messages).
      if (REPLAY) out(rec);
      if (w) {
        waiting.delete(rec.response.request_id);
        w.resolve(rec.response);
      }
    } else if (rec.type === "user") {
      const msg = { uuid: rec.uuid, content: rec.message?.content, priority: rec.priority ?? "next" };
      if (replay) {
        if (!busy) void replayTurn(msg);
        // Mid-turn: a steer the recording already folds in, or the next prompt (queued until this turn's records are out).
        else if (replayCurrent?.steers.includes(textOf(msg.content))) steerIn(textOf(msg.content), msg.uuid);
        else replayQueue.push(msg);
        continue;
      }
      if (!busy) {
        void runTurn(msg).catch((e) => process.stderr.write(`fake-claude: ${e?.stack ?? e}\n`));
      } else {
        lifecycle(msg.uuid, "queued");
        if (msg.priority === "later") later.push(msg);
        else steers.push(msg);
      }
    }
  }
});
process.stdin.on("end", () => {
  cleanup();
  // The real CLI exits 1 when its last turn was aborted; 0 otherwise.
  process.exit(0);
});
setInterval(() => {}, 1 << 30);
