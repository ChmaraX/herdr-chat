#!/usr/bin/env node
// fake-codex: a scriptable stand-in for `codex app-server` (JSON-RPC 2.0 over
// LF-framed JSONL on stdio). Node, no dependencies. See README.md.
//   FAKE_CODEX_SCENARIO=<file.json>  scripted mode
//   FAKE_CODEX_REPLAY=<fixture.jsonl> replay a recorded real session
//   FAKE_CODEX_SPEED, FAKE_CODEX_LOG, FAKE_CODEX_HOME
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const argv = process.argv.slice(2);
const sub = argv.find((a, i) => !a.startsWith("-") && !(argv[i - 1] === "-c" || argv[i - 1] === "--config" || argv[i - 1] === "--enable" || argv[i - 1] === "--disable" || argv[i - 1] === "-p" || argv[i - 1] === "--profile"));
const VERSION = process.env.FAKE_CODEX_VERSION ?? "0.163.0";
if (argv.includes("--version")) {
  process.stdout.write(`codex-cli ${VERSION}\n`);
  process.exit(0);
}
if (sub !== "app-server") {
  // `resume <id>` and friends: the TUI. Print what we were asked, exit.
  process.stdout.write(`fake-codex TUI: ${argv.join(" ")}\n`);
  process.exit(0);
}

const SPEED = Number(process.env.FAKE_CODEX_SPEED ?? "1") || 1;
const LOG = process.env.FAKE_CODEX_LOG;
const HOME = process.env.FAKE_CODEX_HOME ?? join(tmpdir(), "fake-codex-home");
const SESSIONS = join(HOME, "sessions");
const CWD = process.cwd();
const config = {};
for (let i = 0; i < argv.length; i++) if (argv[i] === "-c" && argv[i + 1]) {
  const [k, ...v] = argv[i + 1].split("=");
  config[k] = v.join("=");
}
const scenario = process.env.FAKE_CODEX_SCENARIO ? JSON.parse(readFileSync(process.env.FAKE_CODEX_SCENARIO, "utf8")) : {};
const log = (rec) => LOG && appendFileSync(LOG, JSON.stringify(rec) + "\n");
log({ _start: true, argv, cwd: CWD, env: { HERDR_PANE_ID: process.env.HERDR_PANE_ID ?? null, HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH ?? null, HERDR_ENV: process.env.HERDR_ENV ?? null, HERDR_CHAT_HOST: process.env.HERDR_CHAT_HOST ?? null } });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms / SPEED));
const now = () => Date.now();
const secs = () => Math.floor(Date.now() / 1000);
let seq = 0;
const uid = (p = "") => `${p}${randomUUID()}`;

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}
const notify = (method, params) => send({ method, params });

// ------------------------------------------------------------------ defaults

const DEFAULT_MODELS = [
  { id: "gpt-5.6-luna", model: "gpt-5.6-luna", displayName: "GPT-5.6-Luna", description: "Fast and cheap", hidden: false, isDefault: false,
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"].map((e) => ({ reasoningEffort: e, description: e })), defaultReasoningEffort: "medium", inputModalities: ["text", "image"] },
  { id: "gpt-5.6-sol", model: "gpt-5.6-sol", displayName: "GPT-5.6-Sol", description: "Workhorse", hidden: false, isDefault: true,
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"].map((e) => ({ reasoningEffort: e, description: e })), defaultReasoningEffort: "low", inputModalities: ["text", "image"] },
  { id: "gpt-text-only", model: "gpt-text-only", displayName: "Text Only", description: "No images", hidden: false, isDefault: false,
    supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }], defaultReasoningEffort: "low", inputModalities: ["text"] },
  { id: "codex-auto-review", model: "codex-auto-review", displayName: "Codex Auto Review", hidden: true, isDefault: false,
    supportedReasoningEfforts: [{ reasoningEffort: "medium" }], defaultReasoningEffort: "medium", inputModalities: ["text"] },
];
const MODELS = scenario.models ?? DEFAULT_MODELS;
const SKILLS = scenario.skills ?? [{ name: "greet", description: "Say hello nicely", path: join(HOME, "skills/greet/SKILL.md"), scope: "user", enabled: true, pluginId: null }];

function sandboxPolicy(mode) {
  if (mode === "read-only") return { type: "readOnly", networkAccess: false };
  if (mode === "danger-full-access") return { type: "dangerFullAccess" };
  return { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
}

// ------------------------------------------------------------------ threads on disk

function threadFile(t) {
  return t.path;
}
function saveThread(t) {
  if (t.ephemeral || !t.written) return;
  t.updatedMs = Date.now();
  mkdirSync(SESSIONS, { recursive: true });
  writeFileSync(threadFile(t), JSON.stringify({ ...t, live: undefined }) + "\n");
}
function loadThread(id, path) {
  const candidates = [];
  if (path && existsSync(path)) candidates.push(path);
  if (existsSync(SESSIONS)) for (const n of readdirSync(SESSIONS)) if (n.includes(id)) candidates.push(join(SESSIONS, n));
  for (const c of candidates) {
    try {
      return JSON.parse(readFileSync(c, "utf8"));
    } catch {}
  }
  return null;
}
function newThread(params = {}) {
  const id = params.id ?? uid();
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return {
    id, name: params.name ?? null, cwd: params.cwd ?? CWD, path: join(SESSIONS, `rollout-${ts}-${id}.jsonl`), ephemeral: !!params.ephemeral,
    createdAt: secs(), updatedAt: secs(), preview: "", turns: [], written: false,
    settings: {
      model: params.model ?? scenario.model ?? "gpt-5.6-luna", modelProvider: "openai",
      effort: scenario.effort ?? "low", summary: null,
      approvalPolicy: params.approvalPolicy ?? scenario.approvalPolicy ?? "on-request",
      approvalsReviewer: scenario.approvalsReviewer ?? "user",
      sandboxPolicy: sandboxPolicy(params.sandbox ?? scenario.sandbox ?? "workspace-write"),
      collaborationMode: { mode: "default", settings: { model: params.model ?? scenario.model ?? "gpt-5.6-luna", reasoning_effort: scenario.effort ?? "low", developer_instructions: null } },
    },
  };
}
function threadView(t, status) {
  return {
    id: t.id, sessionId: t.id, forkedFromId: null, parentThreadId: t.parentThreadId ?? null, preview: t.preview, ephemeral: t.ephemeral, historyMode: "paginated",
    modelProvider: "openai", model: t.settings.model, reasoningEffort: t.settings.effort, createdAt: t.createdAt, updatedAt: t.updatedAt,
    status: status ?? { type: "idle" }, path: t.ephemeral ? null : t.path, cwd: t.cwd, cliVersion: VERSION, originator: "herdr_chat", source: "vscode", name: t.name, turns: [],
  };
}
function threadResponse(t) {
  const s = t.settings;
  return {
    thread: threadView(t), model: s.model, modelProvider: "openai", serviceTier: null, cwd: t.cwd, approvalPolicy: s.approvalPolicy, approvalsReviewer: s.approvalsReviewer,
    sandbox: s.sandboxPolicy, reasoningEffort: s.effort, collaborationMode: s.collaborationMode, multiAgentMode: "explicitRequestOnly",
  };
}
function settingsNotification(t) {
  notify("thread/settings/updated", { threadId: t.id, threadSettings: { ...t.settings, cwd: t.cwd, disabledPluginIds: [], activePermissionProfile: null, serviceTier: null, multiAgentMode: "explicitRequestOnly" } });
}

const threads = new Map();
let main = null; // the thread turns run on

// ------------------------------------------------------------------ server requests (asks)

let nextServerId = 0;
const serverPending = new Map(); // id -> resolve
function serverRequest(method, params) {
  const id = nextServerId++;
  return new Promise((resolve) => {
    serverPending.set(id, resolve);
    send({ id, method, params });
  });
}

// ------------------------------------------------------------------ turns

class Interrupted extends Error {}
let active = null; // {thread, turn, items, steers: [], interrupted, wake}

function ensureActive(a) {
  if (a.interrupted) throw new Interrupted();
}
async function wait(a, ms) {
  const end = now() + ms / SPEED;
  while (now() < end) {
    ensureActive(a);
    await new Promise((r) => {
      a.wake = r;
      setTimeout(r, Math.min(20, Math.max(0, end - now())));
    });
  }
  ensureActive(a);
}
function itemStarted(a, item) {
  (a.started ??= new Map()).set(item.id, item);
  notify("item/started", { item, threadId: a.thread.id, turnId: a.turn.id, startedAtMs: now() });
}
function itemCompleted(a, item) {
  a.started?.delete(item.id);
  a.items.push(item);
  notify("item/completed", { item, threadId: a.thread.id, turnId: a.turn.id, completedAtMs: now() });
}
function usage(a, out = 20) {
  const t = a.thread;
  t.tokens = t.tokens ?? { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
  const input = 12000 + (t.turns.length + a.items.length) * 300;
  const last = { totalTokens: input + out, inputTokens: input, cachedInputTokens: 8000, cacheWriteInputTokens: 0, outputTokens: out, reasoningOutputTokens: 0 };
  for (const k of Object.keys(last)) t.tokens[k] += last[k];
  notify("thread/tokenUsage/updated", { threadId: t.id, turnId: a.turn.id, tokenUsage: { total: { ...t.tokens }, last, modelContextWindow: 258400 } });
}
function chunks(text, n = 8) {
  const out = [];
  for (let i = 0; i < text.length; i += n) out.push(text.slice(i, i + n));
  return out;
}
function decisionWord(d) {
  return typeof d === "string" ? d : d && typeof d === "object" ? Object.keys(d)[0] : "decline";
}

async function runSteps(a, steps) {
  for (const step of steps ?? []) {
    await deliverSteers(a);
    await runStep(a, step);
  }
  await deliverSteers(a);
}

/** Steers land at a step boundary as a userMessage of the same turn, then their matching script runs. */
async function deliverSteers(a) {
  while (a.steers.length) {
    ensureActive(a);
    const s = a.steers.shift();
    const item = { type: "userMessage", id: uid(), clientId: s.clientId ?? null, content: s.input };
    itemStarted(a, item);
    itemCompleted(a, item);
    await runSteps(a, scriptFor(textOf(s.input)));
  }
}

async function runStep(a, step) {
  ensureActive(a);
  const t = a.thread;
  if (step.wait !== undefined) return wait(a, step.wait);
  if (step.text !== undefined) {
    const item = { type: "agentMessage", id: uid("msg_"), text: "", phase: step.phase ?? "final_answer", memoryCitation: null, delivery: null, questions: null };
    itemStarted(a, item);
    for (const c of chunks(step.text, step.chunk ?? 8)) {
      await wait(a, step.every ?? 10);
      notify("item/agentMessage/delta", { threadId: t.id, turnId: a.turn.id, itemId: item.id, delta: c });
    }
    itemCompleted(a, { ...item, text: step.text });
    usage(a, Math.ceil(step.text.length / 4));
    return;
  }
  if (step.reasoning !== undefined) {
    const item = { type: "reasoning", id: uid("rs_"), summary: [], content: [] };
    itemStarted(a, item);
    const parts = step.reasoning;
    for (let i = 0; i < parts.length; i++) {
      notify("item/reasoning/summaryPartAdded", { threadId: t.id, turnId: a.turn.id, itemId: item.id, summaryIndex: i });
      for (const c of chunks(parts[i], step.chunk ?? 12)) {
        await wait(a, step.every ?? 10);
        notify("item/reasoning/summaryTextDelta", { threadId: t.id, turnId: a.turn.id, itemId: item.id, delta: c, summaryIndex: i });
      }
    }
    itemCompleted(a, { ...item, summary: parts });
    return;
  }
  if (step.command !== undefined) return runCommand(a, step);
  if (step.fileChange !== undefined) {
    const changes = step.fileChange.map((c) => ({ path: c.path.startsWith("/") ? c.path : join(t.cwd, c.path), kind: c.kind === "update" ? { type: "update", move_path: null } : { type: c.kind ?? "update" }, diff: c.diff }));
    const item = { type: "fileChange", id: uid("exec-"), changes, status: "inProgress" };
    itemStarted(a, item);
    if (step.approval) {
      const d = await ask(a, "item/fileChange/requestApproval", { threadId: t.id, turnId: a.turn.id, itemId: item.id, startedAtMs: now(), reason: step.approval.reason ?? null, grantRoot: step.approval.grantRoot ?? null });
      const w = decisionWord(d.decision);
      if (w === "decline" || w === "cancel") {
        itemCompleted(a, { ...item, status: "declined" });
        if (w === "cancel") return interruptSelf(a);
        return;
      }
    }
    await wait(a, step.duration ?? 20);
    itemCompleted(a, { ...item, status: step.status ?? "completed" });
    notify("turn/diff/updated", { threadId: t.id, turnId: a.turn.id, diff: changes.map((c) => `diff --git a/${basename(c.path)} b/${basename(c.path)}\n${c.diff}`).join("\n") });
    return;
  }
  if (step.mcp !== undefined) {
    const m = step.mcp;
    const item = { type: "mcpToolCall", id: uid("exec-"), server: m.server, tool: m.tool, status: "inProgress", arguments: m.arguments ?? {}, appContext: null, mcpAppUi: null, pluginId: null, readOnlyHint: true, result: null, error: null, durationMs: null };
    itemStarted(a, item);
    for (const p of m.progress ?? []) {
      await wait(a, 20);
      notify("item/mcpToolCall/progress", { threadId: t.id, turnId: a.turn.id, itemId: item.id, message: p });
    }
    await wait(a, m.duration ?? 20);
    itemCompleted(a, { ...item, status: m.error ? "failed" : "completed", result: m.error ? null : { content: m.content ?? [], structuredContent: m.structuredContent ?? null, _meta: null }, error: m.error ? { message: m.error } : null, durationMs: 3 });
    return;
  }
  if (step.webSearch !== undefined) {
    const w = step.webSearch;
    const item = { type: "webSearch", id: uid("exec-"), query: "", action: null, results: null };
    itemStarted(a, item);
    await wait(a, w.duration ?? 30);
    itemCompleted(a, { ...item, query: w.query ?? "", action: w.action ?? { type: "search", query: w.query, queries: null }, results: w.results ?? [] });
    return;
  }
  if (step.imageView !== undefined) {
    const item = { type: "imageView", id: uid("exec-"), path: step.imageView.startsWith("/") ? step.imageView : join(t.cwd, step.imageView) };
    itemStarted(a, item);
    itemCompleted(a, item);
    return;
  }
  if (step.subagent !== undefined) return runSubagent(a, step.subagent);
  if (step.question !== undefined) {
    const qs = step.question.questions;
    const r = await ask(a, "item/tool/requestUserInput", { threadId: t.id, turnId: a.turn.id, itemId: uid("call_"), questions: qs, isBlocking: true, autoResolutionMs: null });
    const first = r?.answers?.[qs[0]?.id]?.answers?.[0] ?? "";
    a.lastAnswer = r;
    const then = step.then ?? {};
    return runSteps(a, (then[first] ?? then["*"] ?? []).map((s) => JSON.parse(JSON.stringify(s).replaceAll("{answer}", first))));
  }
  if (step.permissions !== undefined) {
    const r = await ask(a, "item/permissions/requestApproval", { threadId: t.id, turnId: a.turn.id, itemId: uid("call_"), environmentId: "local", startedAtMs: now(), cwd: t.cwd, reason: step.permissions.reason ?? null, permissions: step.permissions.permissions });
    const key = r?.permissions && Object.keys(r.permissions).length ? r.scope : "denied";
    return runSteps(a, (step.then ?? {})[key] ?? (step.then ?? {})["*"] ?? []);
  }
  if (step.elicitation !== undefined) {
    const r = await ask(a, "mcpServer/elicitation/request", { threadId: t.id, turnId: a.turn.id, ...step.elicitation });
    const key = r?.action ?? "cancel";
    return runSteps(a, ((step.then ?? {})[key] ?? (step.then ?? {})["*"] ?? []).map((s) => JSON.parse(JSON.stringify(s).replaceAll("{content}", JSON.stringify(r?.content ?? null).replace(/"/g, "'")))));
  }
  if (step.plan !== undefined) {
    const id = `${a.turn.id}-plan`;
    itemStarted(a, { type: "plan", id, text: "" });
    for (const c of chunks(step.plan, step.chunk ?? 16)) {
      await wait(a, step.every ?? 10);
      notify("item/plan/delta", { threadId: t.id, turnId: a.turn.id, itemId: id, delta: c });
    }
    itemCompleted(a, { type: "plan", id, text: step.plan });
    return;
  }
  if (step.todo !== undefined) {
    notify("turn/plan/updated", { threadId: t.id, turnId: a.turn.id, explanation: step.todo.explanation ?? null, plan: step.todo.plan });
    return;
  }
  if (step.error !== undefined) {
    notify("error", { error: { message: step.error, codexErrorInfo: step.codexErrorInfo ?? null, additionalDetails: step.details ?? null }, willRetry: !!step.willRetry, threadId: t.id, turnId: a.turn.id });
    return;
  }
  if (step.fail !== undefined) {
    a.failed = step.fail;
    throw new Interrupted();
  }
  if (step.hang !== undefined) {
    // A silent stall: nothing at all until interrupted (or `hang` ms).
    return wait(a, typeof step.hang === "number" ? step.hang : 3_600_000);
  }
  if (step.stderr !== undefined) {
    process.stderr.write(step.stderr + "\n");
    return;
  }
  if (step.emit !== undefined) {
    for (const m of Array.isArray(step.emit) ? step.emit : [step.emit]) send(JSON.parse(JSON.stringify(m).replaceAll("{thread}", t.id).replaceAll("{turn}", a.turn.id)));
    return;
  }
  if (step.crash !== undefined) {
    if (step.stderrBefore) process.stderr.write(step.stderrBefore + "\n");
    process.exit(step.crash);
  }
  if (step.waitFor === "steer") {
    const end = now() + (step.timeout ?? 10_000) / SPEED;
    while (!a.steers.length && now() < end) await wait(a, 20 * SPEED);
    return;
  }
  throw new Error(`unknown step ${JSON.stringify(step)}`);
}

async function ask(a, method, params) {
  const t = a.thread;
  notify("thread/status/changed", { threadId: t.id, status: { type: "active", activeFlags: [method.includes("UserInput") ? "waitingOnUserInput" : "waitingOnApproval"] } });
  const id = nextServerId;
  const p = serverRequest(method, params);
  a.openAsk = id;
  let result;
  for (;;) {
    const r = await Promise.race([p, new Promise((res) => setTimeout(() => res(undefined), 20))]);
    if (r !== undefined) {
      result = r;
      break;
    }
    if (a.interrupted) {
      serverPending.delete(id);
      notify("serverRequest/resolved", { threadId: t.id, requestId: id });
      a.openAsk = null;
      throw new Interrupted();
    }
  }
  a.openAsk = null;
  notify("serverRequest/resolved", { threadId: t.id, requestId: id });
  notify("thread/status/changed", { threadId: t.id, status: { type: "active", activeFlags: [] } });
  return result;
}

function interruptSelf(a) {
  a.interrupted = true;
  throw new Interrupted();
}

async function runCommand(a, step) {
  const t = a.thread;
  const command = step.raw ? step.command : `/bin/zsh -lc '${step.command.replace(/'/g, "'\\''")}'`;
  const actions = step.actions ?? [{ type: "unknown", command: step.command }];
  const item = { type: "commandExecution", id: uid("exec-"), pluginId: null, scriptPath: null, command, cwd: t.cwd, processId: null, source: "agent", status: "inProgress", commandActions: actions, aggregatedOutput: null, exitCode: null, durationMs: null };
  itemStarted(a, item);
  if (step.approval) {
    const available = step.approval.availableDecisions ?? ["accept", { acceptWithExecpolicyAmendment: { execpolicy_amendment: step.command.split(" ") } }, "cancel"];
    const d = await ask(a, "item/commandExecution/requestApproval", {
      kind: "command", threadId: t.id, turnId: a.turn.id, itemId: item.id, startedAtMs: now(), environmentId: "local", command, cwd: t.cwd, commandActions: actions,
      ...(step.approval.reason ? { reason: step.approval.reason } : {}), proposedExecpolicyAmendment: step.command.split(" "), availableDecisions: available,
    });
    const w = decisionWord(d.decision);
    a.decisions = [...(a.decisions ?? []), w];
    if (w === "decline" || w === "cancel") {
      itemCompleted(a, { ...item, status: "declined" });
      process.stderr.write(`\u001b[2m${new Date().toISOString()}\u001b[0m \u001b[31mERROR\u001b[0m \u001b[2mcodex_core::tools::router\u001b[0m: error=exec_command failed: CreateProcess { message: "Rejected(\\"rejected by user\\")" }\n`);
      if (w === "cancel") return interruptSelf(a);
      return runSteps(a, step.onDecline ?? []);
    }
  }
  const t0 = now();
  let output = "";
  const outs = Array.isArray(step.output) ? step.output : step.output !== undefined ? [step.output] : [];
  for (const o of outs) {
    await wait(a, step.every ?? 30);
    output += o;
    notify("item/commandExecution/outputDelta", { threadId: t.id, turnId: a.turn.id, itemId: item.id, delta: o });
  }
  if (step.until === "interrupt") {
    // Like Codex: an interrupted command never gets item/completed.
    for (let n = 1; ; n++) {
      await wait(a, step.every ?? 100);
      if (step.tick) {
        const d = step.tick.replaceAll("{n}", String(n));
        output += d;
        notify("item/commandExecution/outputDelta", { threadId: t.id, turnId: a.turn.id, itemId: item.id, delta: d });
      }
    }
  }
  await wait(a, step.duration ?? 20);
  const exitCode = step.exitCode ?? 0;
  itemCompleted(a, { ...item, processId: "4242", source: "unifiedExecStartup", status: step.status ?? (exitCode === 0 ? "completed" : "failed"), aggregatedOutput: step.aggregated === false ? null : output, exitCode, durationMs: now() - t0 });
}

async function runSubagent(a, s) {
  const t = a.thread;
  const spawn = { type: "collabAgentToolCall", id: uid("exec-"), tool: "spawnAgent", status: "inProgress", senderThreadId: t.id, receiverThreadIds: [], prompt: s.prompt, model: "", reasoningEffort: "medium", agentsStates: {} };
  itemStarted(a, spawn);
  const child = newThread({ cwd: t.cwd, model: t.settings.model });
  child.parentThreadId = t.id;
  child.ephemeral = true;
  threads.set(child.id, child);
  await wait(a, 20);
  itemCompleted(a, { ...spawn, status: "completed", receiverThreadIds: [child.id], model: t.settings.model, reasoningEffort: "low", agentsStates: { [child.id]: { status: "running", message: null } } });
  const waitItem = { type: "collabAgentToolCall", id: uid("exec-"), tool: "wait", status: "inProgress", senderThreadId: t.id, receiverThreadIds: [child.id], prompt: null, model: null, reasoningEffort: null, agentsStates: {} };
  itemStarted(a, waitItem);
  // The child's own turn, on its own thread id.
  const ct = { id: uid(), rootTurnId: a.turn.id, items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: secs(), completedAt: null, durationMs: null };
  notify("thread/status/changed", { threadId: child.id, status: { type: "active", activeFlags: [] } });
  notify("turn/started", { threadId: child.id, turn: ct });
  const ca = { thread: child, turn: ct, items: [], steers: [] };
  Object.defineProperty(ca, "interrupted", { get: () => a.interrupted });
  const um = { type: "userMessage", id: uid(), clientId: null, content: [{ type: "text", text: s.prompt, text_elements: [] }] };
  itemStarted(ca, um);
  itemCompleted(ca, um);
  await runSteps(ca, s.steps ?? [{ text: s.answer ?? "done" }]);
  notify("thread/status/changed", { threadId: child.id, status: { type: "idle" } });
  notify("turn/completed", { threadId: child.id, turn: { ...ct, status: "completed", completedAt: secs(), durationMs: 50 } });
  child.turns.push({ ...ct, items: ca.items, itemsView: "full", status: "completed", completedAt: secs() });
  child.written = true;
  child.ephemeral = false;
  saveThread(child);
  await wait(a, 10);
  itemCompleted(a, { ...waitItem, status: "completed", agentsStates: { [child.id]: { status: "completed", message: s.answer ?? "done" } } });
}

function textOf(input) {
  return (input ?? []).filter((p) => p.type === "text").map((p) => p.text).join("\n");
}

const usedOnce = new Set();
function scriptFor(text) {
  for (const [i, p] of (scenario.prompts ?? []).entries()) {
    if (p.once && usedOnce.has(i)) continue;
    if (new RegExp(p.match, "i").test(text)) {
      if (p.once) usedOnce.add(i);
      return p.steps;
    }
  }
  return scenario.default ?? [{ text: `ok: ${text}` }];
}

async function startTurn(t, params, steps) {
  const turn = { id: uid(), rootTurnId: null, items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: null, completedAt: null, durationMs: null };
  turn.rootTurnId = turn.id;
  const a = { thread: t, turn, items: [], steers: [], interrupted: false, failed: null, openAsk: null };
  active = a;
  setImmediate(async () => {
    notify("thread/status/changed", { threadId: t.id, status: { type: "active", activeFlags: [] } });
    turn.startedAt = secs();
    notify("turn/started", { threadId: t.id, turn: { ...turn } });
    if (!t.written && !t.ephemeral) {
      t.written = true;
      saveThread(t);
    }
    let status = "completed";
    try {
      if (params) {
        const um = { type: "userMessage", id: uid(), clientId: params.clientUserMessageId ?? null, content: params.input };
        itemStarted(a, um);
        itemCompleted(a, um);
        if (!t.preview) t.preview = textOf(params.input).slice(0, 200);
      }
      await runSteps(a, steps);
    } catch (e) {
      if (!(e instanceof Interrupted)) {
        process.stderr.write(`fake-codex: ${e.stack ?? e}\n`);
        a.failed = String(e.message ?? e);
      }
      status = a.failed ? "failed" : "interrupted";
    }
    const done = { ...turn, status, error: a.failed ? { message: a.failed, codexErrorInfo: null, additionalDetails: null } : null, completedAt: secs(), durationMs: Math.max(1, now() - turn.startedAt * 1000) };
    // Items that never completed (an interrupted command) are recorded as they started.
    t.turns.push({ ...done, items: [...a.items, ...(a.started?.values() ?? [])], itemsView: "full" });
    t.updatedAt = secs();
    saveThread(t);
    active = null;
    notify("thread/status/changed", { threadId: t.id, status: { type: "idle" } });
    notify("turn/completed", { threadId: t.id, turn: { ...done, items: a.items.filter((i) => i.type === "agentMessage").slice(-1), itemsView: "summary" } });
    if (a.onDone) a.onDone();
  });
  return turn;
}

// ------------------------------------------------------------------ requests

const err = (code, message) => ({ __error: { code, message } });

async function handle(msg) {
  const p = msg.params ?? {};
  switch (msg.method) {
    case "initialize":
      return { userAgent: `herdr_chat/${VERSION} (fake) fake-codex (herdr_chat; 0.1.0)`, codexHome: HOME, platformFamily: "unix", platformOs: "macos" };
    case "model/list":
      return { data: p.includeHidden ? MODELS : MODELS.filter((m) => !m.hidden), nextCursor: null };
    case "collaborationMode/list":
      return { data: [{ name: "Plan", mode: "plan", model: null, reasoning_effort: "medium" }, { name: "Default", mode: "default", model: null, reasoning_effort: null }] };
    case "account/read":
      return { account: { type: "chatgpt", email: "<email>", planType: "plus" }, requiresOpenaiAuth: true };
    case "skills/list":
      return { data: [{ cwd: CWD, skills: SKILLS, errors: [] }] };
    case "thread/start": {
      const t = newThread({ cwd: p.cwd, model: p.model, approvalPolicy: p.approvalPolicy, sandbox: p.sandbox, ephemeral: p.ephemeral });
      t.config = p.config ?? null;
      threads.set(t.id, t);
      main = t;
      setImmediate(async () => {
        notify("thread/started", { thread: threadView(t) });
        for (const s of scenario.startupNotifications ?? []) {
          if (typeof s.wait === "number") await sleep(s.wait);
          else send(JSON.parse(JSON.stringify(s).replaceAll("{thread}", t.id)));
        }
      });
      return threadResponse(t);
    }
    case "thread/resume": {
      if (scenario.resumeError) return err(scenario.resumeError.code ?? -32600, scenario.resumeError.message ?? scenario.resumeError);
      let t = threads.get(p.threadId) ?? loadThread(p.threadId, p.path);
      if (!t && scenario.history) {
        t = newThread({ id: p.threadId, cwd: p.cwd });
        t.turns = scenario.history;
        t.written = true;
        t.preview = textOf(scenario.history[0]?.items?.[0]?.content);
        saveThread(t);
      }
      if (!t) return err(-32600, `no rollout found for thread id ${p.threadId}`);
      threads.set(t.id, t);
      main = t;
      if (p.approvalPolicy) t.settings.approvalPolicy = p.approvalPolicy;
      setImmediate(() => notify("thread/status/changed", { threadId: t.id, status: { type: "idle" } }));
      return threadResponse(t);
    }
    case "thread/fork": {
      const src = threads.get(p.threadId) ?? loadThread(p.threadId);
      if (!src) return err(-32600, `no rollout found for thread id ${p.threadId}`);
      const upTo = p.lastTurnId ? src.turns.findIndex((x) => x.id === p.lastTurnId) : src.turns.length - 1;
      if (p.lastTurnId && upTo < 0) return err(-32600, `turn not found: ${p.lastTurnId}`);
      const t = newThread({ cwd: p.cwd ?? src.cwd, model: p.model ?? src.settings.model, approvalPolicy: src.settings.approvalPolicy });
      t.settings = { ...JSON.parse(JSON.stringify(src.settings)), model: p.model ?? src.settings.model };
      // Without its own model the fork takes the config default, as the real one does (sample 10): not the source's effort.
      t.settings.effort = scenario.forkEffort ?? t.settings.effort;
      t.forkedFromId = src.id;
      t.turns = JSON.parse(JSON.stringify(src.turns.slice(0, upTo + 1)));
      t.written = t.turns.length > 0;
      t.preview = src.preview;
      t.config = p.config ?? null;
      threads.set(t.id, t);
      main = t;
      saveThread(t);
      setImmediate(() => notify("thread/started", { thread: { ...threadView(t), forkedFromId: src.id } }));
      const r = threadResponse(t);
      r.thread.forkedFromId = src.id;
      return r;
    }
    case "thread/turns/list": {
      const t = threads.get(p.threadId) ?? loadThread(p.threadId);
      if (!t) return err(-32600, `thread not found: ${p.threadId}`);
      if (!t.written) return err(-32600, `no rollout found for thread id ${p.threadId}`);
      let turns = [...t.turns];
      if ((p.sortDirection ?? "desc") === "desc") turns.reverse();
      const start = p.cursor ? Number(p.cursor) : 0;
      const limit = p.limit ?? 25;
      const page = turns.slice(start, start + limit);
      const next = start + limit < turns.length ? String(start + limit) : null;
      return { data: page.map((x) => ({ ...x, itemsView: p.itemsView === "full" ? "full" : "summary", items: p.itemsView === "full" ? x.items : [] })), nextCursor: next, backwardsCursor: null };
    }
    case "thread/list": {
      const out = [];
      if (existsSync(SESSIONS)) {
        for (const n of readdirSync(SESSIONS)) {
          try {
            const t = JSON.parse(readFileSync(join(SESSIONS, n), "utf8"));
            if (t.parentThreadId) continue;
            if (!p.cwd || t.cwd === p.cwd) out.push({ ...threadView(t), _updatedMs: t.updatedMs ?? 0 });
          } catch {}
        }
      }
      out.sort((a, b) => (b._updatedMs ?? 0) - (a._updatedMs ?? 0));
      return { data: out.slice(0, p.limit ?? 50), nextCursor: null };
    }
    case "thread/read": {
      const t = threads.get(p.threadId);
      if (!t) return err(-32600, "thread not loaded");
      const status = scenario.readStatus ?? (active && active.thread === t ? { type: "active", activeFlags: [] } : { type: "idle" });
      return { thread: threadView(t, status) };
    }
    case "thread/unsubscribe":
      return { status: "unsubscribed" };
    case "thread/name/set": {
      const t = threads.get(p.threadId);
      if (t) {
        t.name = p.name;
        saveThread(t);
      }
      setImmediate(() => notify("thread/name/updated", { threadId: p.threadId, threadName: p.name }));
      return {};
    }
    case "thread/settings/update": {
      if (scenario.settingsUpdateUnsupported) return err(-32601, "method not found");
      const t = threads.get(p.threadId);
      if (!t) return err(-32600, "thread not loaded");
      const s = t.settings;
      if (p.model) s.model = p.model;
      if (p.effort) s.effort = p.effort;
      if (p.summary) s.summary = p.summary;
      if (p.approvalPolicy) s.approvalPolicy = p.approvalPolicy;
      if (p.approvalsReviewer) s.approvalsReviewer = p.approvalsReviewer;
      if (p.sandboxPolicy) s.sandboxPolicy = p.sandboxPolicy;
      if (p.collaborationMode) s.collaborationMode = p.collaborationMode;
      setImmediate(() => settingsNotification(t));
      return {};
    }
    case "thread/compact/start": {
      const t = threads.get(p.threadId);
      setImmediate(() => {
        const turn = { id: uid(), rootTurnId: null, items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: secs(), completedAt: null, durationMs: null };
        const a = { thread: t, turn, items: [], steers: [], interrupted: false };
        active = a;
        notify("thread/status/changed", { threadId: t.id, status: { type: "active", activeFlags: [] } });
        notify("turn/started", { threadId: t.id, turn });
        const item = { type: "contextCompaction", id: uid() };
        itemStarted(a, item);
        setTimeout(() => {
          itemCompleted(a, item);
          active = null;
          t.turns.push({ ...turn, items: a.items, itemsView: "full", status: "completed", completedAt: secs() });
          saveThread(t);
          notify("thread/status/changed", { threadId: t.id, status: { type: "idle" } });
          notify("turn/completed", { threadId: t.id, turn: { ...turn, status: scenario.compactFails ? "failed" : "completed", error: scenario.compactFails ? { message: scenario.compactFails } : null, completedAt: secs() } });
        }, (scenario.compactMs ?? 150) / SPEED);
      });
      return {};
    }
    case "turn/start": {
      const t = threads.get(p.threadId);
      if (!t) return err(-32600, "thread not found");
      if (p.model) t.settings.model = p.model;
      if (p.effort) t.settings.effort = p.effort;
      if (p.summary) t.settings.summary = p.summary;
      if (p.approvalPolicy) t.settings.approvalPolicy = p.approvalPolicy;
      if (p.sandboxPolicy) t.settings.sandboxPolicy = p.sandboxPolicy;
      if (p.collaborationMode) t.settings.collaborationMode = p.collaborationMode;
      if (p.model || p.effort || p.summary || p.approvalPolicy || p.collaborationMode) setImmediate(() => settingsNotification(t));
      if (active && active.thread === t) {
        // Like Codex: a turn/start while a turn runs steers it and returns the same turn.
        active.steers.push({ input: p.input, clientId: p.clientUserMessageId });
        return { turn: { ...active.turn } };
      }
      const turn = await startTurn(t, p, scriptFor(textOf(p.input)));
      return { turn: { ...turn } };
    }
    case "turn/steer": {
      if (!active || active.thread.id !== p.threadId) return err(-32600, "no active turn to steer");
      if (p.expectedTurnId !== active.turn.id) return err(-32600, `expected turn ${p.expectedTurnId} is not the active turn`);
      active.steers.push({ input: p.input, clientId: p.clientUserMessageId });
      return { turnId: active.turn.id };
    }
    case "turn/interrupt": {
      if (!active || active.turn.id !== p.turnId) return {};
      active.interrupted = true;
      active.wake?.();
      return {};
    }
    case "thread/backgroundTerminals/clean":
      return {};
    default:
      return err(-32601, `method not found: ${msg.method}`);
  }
}

// ------------------------------------------------------------------ replay mode

function replayLines(file) {
  const raw = readFileSync(file, "utf8").split("\n").filter(Boolean);
  const out = [];
  const home = HOME.replace(/\/$/, "");
  for (const l of raw) {
    const fixed = l
      .replaceAll('"~/.codex', `"${home}`)
      .replaceAll("/private/tmp/codex-probe/work", CWD)
      .replaceAll("/tmp/codex-probe/work", CWD)
      .replaceAll("/tmp/codex-fixture", CWD);
    const r = JSON.parse(fixed);
    if (r.dir === "note" || r.dir === "mark") continue;
    out.push(r);
  }
  // A segment cut from a longer recording opens with the previous turn's tail: drop it.
  const first = out.findIndex((r) => r.dir === "out" && r.msg.method && r.msg.id !== undefined);
  if (first > 0 && out[first].msg.method !== "initialize") out.splice(0, first);
  return out;
}

const QUERIES = new Set(["model/list", "collaborationMode/list", "skills/list", "account/read", "thread/list", "thread/loaded/list", "thread/read", "thread/turns/list", "thread/items/list", "thread/queue/list", "mcpServerStatus/list", "config/read"]);

async function replay(file) {
  const lines = replayLines(file);
  const mainThread = lines.map((r) => r.msg?.params?.threadId ?? r.msg?.result?.thread?.id).find(Boolean);
  const latest = new Map(); // method -> recorded result (for queries the recording doesn't gate)
  const methodOf = new Map(); // recorded out id -> method
  const paramsOf = new Map(); // method -> recorded params
  for (const r of lines) if (r.dir === "out" && r.msg.method && r.msg.id !== undefined) {
    methodOf.set(r.msg.id, r.msg.method);
    paramsOf.set(r.msg.method, r.msg.params ?? {});
  }
  for (const r of lines) if (r.dir === "in" && r.msg.id !== undefined && !r.msg.method && methodOf.has(r.msg.id) && r.msg.result) latest.set(methodOf.get(r.msg.id), r.msg.result);
  const inbox = [];
  let wakeInbox = null;
  replayInput = (m) => {
    inbox.push(m);
    wakeInbox?.();
  };
  const idMap = new Map(); // recorded request id -> client's id
  const answered = new Set(); // server request ids the client answered
  const fallback = async (m) => {
    // A query the recording doesn't gate: the latest recorded answer, or the scripted default.
    if (m.method === "thread/start" && !latest.has("thread/start")) {
      const t = newThread({ id: mainThread, cwd: CWD });
      t.written = true;
      threads.set(t.id, t);
      return threadResponse(t);
    }
    if (m.method === "thread/read") return { thread: { id: mainThread, status: { type: "idle" } } };
    if (m.method === "thread/turns/list" && latest.has(m.method)) {
      // The recorded page, in the order the client asked for.
      const rec = latest.get(m.method);
      const flip = (paramsOf.get(m.method)?.sortDirection ?? "desc") !== (m.params?.sortDirection ?? "desc");
      return { ...rec, data: flip ? [...rec.data].reverse() : rec.data, nextCursor: null };
    }
    if (latest.has(m.method)) return latest.get(m.method);
    return handle(m);
  };
  const reply = (m, result) => send(result && result.__error ? { id: m.id, error: result.__error } : { id: m.id, result });
  const take = async (pred) => {
    for (;;) {
      const i = inbox.findIndex(pred);
      if (i >= 0) return inbox.splice(i, 1)[0];
      // Answer what doesn't gate meanwhile.
      for (let j = 0; j < inbox.length; j++) {
        const m = inbox[j];
        if (pred(m)) continue;
        if (m.method && m.id !== undefined && !pendingGate?.(m)) {
          inbox.splice(j, 1);
          j--;
          reply(m, await fallback(m));
        } else if (!m.method && m.id !== undefined) {
          answered.add(m.id);
          inbox.splice(j, 1);
          j--;
        } else if (m.method && m.id === undefined) {
          inbox.splice(j, 1);
          j--;
        }
      }
      const i2 = inbox.findIndex(pred);
      if (i2 >= 0) return inbox.splice(i2, 1)[0];
      await new Promise((r) => (wakeInbox = r));
      wakeInbox = null;
    }
  };
  let pendingGate = null;
  let lastT = null;
  const clientIds = []; // {thread, id}: the client's message ids, for the recorded echoes, in order
  for (const r of lines) {
    if (r.dir === "out") {
      const m = r.msg;
      if (m.method && m.id !== undefined) {
        // Queries don't gate playback: they're answered from the recording whenever they come.
        if (QUERIES.has(m.method)) continue;
        pendingGate = (x) => x.method === m.method;
        const got = await take((x) => x.method === m.method && x.id !== undefined);
        pendingGate = null;
        idMap.set(m.id, got.id);
        if (got.params?.clientUserMessageId) clientIds.push({ thread: got.params.threadId, id: got.params.clientUserMessageId });
      } else if (!m.method && m.id !== undefined) {
        // Our recorded answer to a server request: wait for the client's.
        if (!answered.has(m.id)) {
          pendingGate = () => false;
          await take((x) => !x.method && x.id === m.id);
          pendingGate = null;
        }
        answered.delete(m.id);
      }
      lastT = r.t ?? lastT;
      continue;
    }
    if (r.t !== undefined && lastT !== null) {
      const gap = Math.min(300, Math.max(0, r.t - lastT));
      if (gap > 0) await sleep(gap);
    }
    if (r.t !== undefined) lastT = r.t;
    if (r.dir === "stderr") {
      process.stderr.write(String(r.msg));
      continue;
    }
    let m = r.msg;
    // Codex echoes the client's clientUserMessageId on the userMessage; the recordings sent none.
    const um = m.params?.item;
    if (um?.type === "userMessage" && um.clientId == null && clientIds[0] && clientIds[0].thread === m.params.threadId) {
      m = { ...m, params: { ...m.params, item: { ...um, clientId: clientIds[0].id } } };
      if (m.method === "item/completed") clientIds.shift();
    }
    if (m.id !== undefined && !m.method) {
      if (!idMap.has(m.id)) continue;
      send({ ...m, id: idMap.get(m.id) });
      continue;
    }
    send(m);
  }
  // The recording is over: keep answering queries.
  pendingGate = () => false;
  for (;;) await take(() => false);
}

// ------------------------------------------------------------------ stdin

let replayInput = null;
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    log(msg);
    if (replayInput) {
      replayInput(msg);
      continue;
    }
    if (!msg.method && msg.id !== undefined) {
      const res = serverPending.get(msg.id);
      if (res) {
        serverPending.delete(msg.id);
        res(msg.result ?? { __error: msg.error });
      }
      continue;
    }
    if (!msg.method || msg.id === undefined) continue;
    handle(msg).then(
      (result) => send(result && result.__error ? { id: msg.id, error: result.__error } : { id: msg.id, result }),
      (e) => send({ id: msg.id, error: { code: -32603, message: String(e?.message ?? e) } }),
    );
  }
});
process.stdin.on("end", () => process.exit(0));

if (process.env.FAKE_CODEX_REPLAY) {
  replayInput = () => {};
  const pending = [];
  replayInput = (m) => pending.push(m);
  replay(process.env.FAKE_CODEX_REPLAY).catch((e) => {
    process.stderr.write(`fake-codex replay: ${e.stack ?? e}\n`);
    process.exit(70);
  });
  // replay() installs the real replayInput synchronously; flush anything that came first.
  for (const m of pending.splice(0)) replayInput(m);
} else if (scenario.startupStderr) {
  process.stderr.write(scenario.startupStderr + "\n");
}
if (scenario.exitAfterMs) setTimeout(() => process.exit(scenario.exitCode ?? 1), scenario.exitAfterMs / SPEED);
void seq;
