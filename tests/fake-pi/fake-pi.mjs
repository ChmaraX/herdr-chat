#!/usr/bin/env node
// fake-pi: a scriptable stand-in for `pi --mode rpc`. No dependencies.
// LF-framed JSONL on stdin/stdout, like Pi. See README.md for the scenario format.
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { randomUUID, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const VERSION = "1.5.0";
const argv = process.argv.slice(2);
if (argv.includes("--version") || argv.includes("-v")) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}

function flag(name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

const SPEED = Number(process.env.FAKE_PI_SPEED || "1") || 1;
const LOG = process.env.FAKE_PI_LOG;
const scenarioPath = process.env.FAKE_PI_SCENARIO;
const replayPath = process.env.FAKE_PI_REPLAY;
const scenario = scenarioPath ? JSON.parse(readFileSync(scenarioPath, "utf8")) : {};

// ---------- output ----------
function out(rec) {
  process.stdout.write(JSON.stringify(rec) + "\n");
}
function respond(id, command, data, error) {
  const rec = { ...(id === undefined ? {} : { id }), type: "response", command };
  if (error) {
    rec.success = false;
    rec.error = error;
  } else {
    rec.success = true;
    if (data !== undefined) rec.data = data;
  }
  out(rec);
}
function log(rec) {
  if (LOG) appendFileSync(LOG, JSON.stringify(rec) + "\n");
}
// The first log line records how fake-pi was started (argv and the env a host sets).
log({ type: "_start", argv, env: { PI_CHAT_HOST: process.env.PI_CHAT_HOST ?? null, HC_TERMINAL_ID: process.env.HC_TERMINAL_ID ?? null }, cwd: process.cwd() });

// ---------- stdin framing (LF only, never U+2028) ----------
let stdinBuf = Buffer.alloc(0);
let onCommand = () => {};
function startReading() {
  process.stdin.on("data", (chunk) => {
    stdinBuf = Buffer.concat([stdinBuf, chunk]);
    let i;
    while ((i = stdinBuf.indexOf(10)) >= 0) {
      let line = stdinBuf.subarray(0, i).toString("utf8");
      stdinBuf = stdinBuf.subarray(i + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch (e) {
        respond(undefined, "parse", undefined, `Failed to parse command: ${e.message}`);
        continue;
      }
      log(rec);
      try {
        onCommand(rec);
      } catch (e) {
        respond(rec.id, rec.type, undefined, String(e?.message ?? e));
      }
    }
  });
  process.stdin.on("end", () => process.exit(0));
}

// Like Pi, stay alive until stdin closes, even while nothing is scheduled.
const keepAlive = setInterval(() => {}, 1 << 30);
void keepAlive;
const sleepRaw = (ms) => new Promise((r) => setTimeout(r, ms));
const scaled = (ms) => Math.max(0, Math.round(ms / SPEED));

if (replayPath) {
  runReplay(replayPath);
} else {
  runScenario();
}

// =====================================================================
// Scenario mode
// =====================================================================
function runScenario() {
  const DEFAULT_MODELS = [
    model("anthropic", "claude-haiku-4-5", "Claude Haiku 4.5", true, 200000),
    model("anthropic", "claude-sonnet-5", "Claude Sonnet 5", true, 1000000),
    model("openai-codex", "gpt-5.6-luna", "GPT-5.6 Luna", true, 400000),
    model("local", "tiny", "Tiny (no reasoning)", false, 8000, ["text"]),
  ];
  const models = scenario.models ?? DEFAULT_MODELS;
  function model(provider, id, name, reasoning, contextWindow, input = ["text", "image"]) {
    return {
      id, name, api: "fake", provider, baseUrl: "http://fake", reasoning, input, contextWindow,
      maxTokens: 16384, cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    };
  }
  function findModel(spec) {
    if (!spec) return null;
    if (typeof spec === "object") return spec;
    const [p, ...rest] = spec.split("/");
    const id = rest.join("/");
    return models.find((m) => m.provider === p && m.id === id) ?? models.find((m) => m.id === spec) ?? null;
  }

  const cwd = process.cwd();
  const noSession = argv.includes("--no-session");
  const sessionDir = flag("--session-dir") ?? join(tmpdir(), "fake-pi-sessions", "--" + cwd.replace(/^\//, "").replace(/[/\\:]/g, "-") + "--");

  const S = {
    model: findModel(flag("--model")) ?? findModel(scenario.model) ?? models[0],
    thinkingLevel: flag("--thinking") ?? scenario.thinkingLevel ?? "low",
    sessionFile: null,
    sessionId: randomUUID(),
    sessionName: flag("--name") ?? scenario.sessionName ?? null,
    messages: [],
    lastEntryId: null,
    headerWritten: false,
    steering: [],
    followUp: [],
    isCompacting: false,
    run: null, // active run context
    dialogs: new Map(), // id -> resolve
    usedPrompts: new Set(),
    dialogSeq: 0,
    uiSeq: 0,
  };

  function newSessionFile() {
    if (noSession) return null;
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    return join(sessionDir, `${ts}_${S.sessionId}.jsonl`);
  }

  function loadSessionFile(path) {
    const msgs = [];
    let name = null;
    const lines = readFileSync(path, "utf8").split("\n");
    let last = null;
    for (const line of lines) {
      if (!line.trim()) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (e.type === "session") { if (e.id) S.sessionId = e.id; continue; }
      if (e.id) last = e.id;
      if (e.type === "message" && e.message) msgs.push(e.message);
      else if (e.type === "custom_message") msgs.push({ role: "custom", customType: e.customType, content: e.content, display: e.display, timestamp: Date.parse(e.timestamp) || Date.now() });
      else if (e.type === "session_info") name = e.name ?? null;
    }
    S.lastEntryId = last;
    S.headerWritten = true;
    return { msgs, name };
  }

  // Like herdr-chat-lock's hand-off report: a TUI started by a chat's hand-off
  // writes every session it opens to PI_CHAT_HANDOFF.
  function reportHandoff() {
    const out = process.env.PI_CHAT_HANDOFF;
    if (!out || process.env.PI_CHAT_HOST === "1" || !S.sessionFile) return;
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(`${out}.${process.pid}.tmp`, JSON.stringify({ sessionFile: S.sessionFile, pid: process.pid, at: Date.now() }));
    renameSync(`${out}.${process.pid}.tmp`, out);
  }

  function openSession(path, fallbackHistory) {
    openSessionFile(path, fallbackHistory);
    reportHandoff();
  }

  function openSessionFile(path, fallbackHistory) {
    S.messages = [];
    S.lastEntryId = null;
    S.headerWritten = false;
    S.sessionId = randomUUID();
    if (path && existsSync(path)) {
      const { msgs, name } = loadSessionFile(path);
      S.messages = msgs;
      if (name) S.sessionName = name;
      S.sessionFile = path;
      return;
    }
    S.sessionFile = path ?? newSessionFile();
    for (const m of fallbackHistory ?? []) persist(m);
  }

  function persist(message) {
    S.messages.push(message);
    if (!S.sessionFile) return;
    mkdirSync(dirname(S.sessionFile), { recursive: true });
    if (!S.headerWritten) {
      writeFileSync(S.sessionFile, JSON.stringify({ type: "session", version: 3, id: S.sessionId, timestamp: new Date().toISOString(), cwd }) + "\n");
      S.headerWritten = true;
    }
    const id = randomBytes(4).toString("hex");
    appendFileSync(S.sessionFile, JSON.stringify({ type: "message", id, parentId: S.lastEntryId, timestamp: new Date().toISOString(), message }) + "\n");
    S.lastEntryId = id;
  }
  function persistEntry(entry) {
    if (!S.sessionFile || !S.headerWritten) return;
    const id = randomBytes(4).toString("hex");
    appendFileSync(S.sessionFile, JSON.stringify({ ...entry, id, parentId: S.lastEntryId, timestamp: new Date().toISOString() }) + "\n");
    S.lastEntryId = id;
  }

  // The session's message entries, oldest first (the fake's sessions are linear).
  function forkEntries() {
    if (!S.sessionFile || !existsSync(S.sessionFile)) return [];
    const out = [];
    for (const line of readFileSync(S.sessionFile, "utf8").split("\n")) {
      try {
        const e = JSON.parse(line);
        if (e.type === "message" && e.message && (e.message.role === "user" || e.message.role === "assistant" || e.message.role === "toolResult")) out.push(e);
      } catch {}
    }
    return out;
  }
  function textOfContent(c) {
    return typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b?.type === "text").map((b) => b.text).join("\n") : "";
  }

  const sessionArg = flag("--session");
  openSession(sessionArg, sessionArg || scenario.historyAlways ? scenario.history : undefined);

  // ---------- run context / interruptible waits ----------
  function makeCtx(kind) {
    return { kind, aborted: false, waiters: new Set(), turnMessages: [], toolResults: [], needNewTurn: false, runMessages: [], lastAssistant: null };
  }
  function sleep(ms, ctx) {
    return new Promise((resolve) => {
      const t = setTimeout(done, scaled(ms));
      function done() { clearTimeout(t); ctx?.waiters.delete(done); resolve(); }
      ctx?.waiters.add(done);
    });
  }
  function wake(ctx) {
    for (const w of [...ctx.waiters]) w();
  }
  function waitUntil(cond, ctx, timeoutMs) {
    return new Promise((resolve) => {
      let timer;
      const check = () => {
        if (cond() || ctx?.aborted) { finish(); return true; }
        return false;
      };
      const finish = () => { clearInterval(iv); clearTimeout(timer); ctx?.waiters.delete(finish); resolve(); };
      const iv = setInterval(check, 5);
      if (timeoutMs) timer = setTimeout(finish, scaled(timeoutMs));
      ctx?.waiters.add(finish);
      check();
    });
  }

  function usage(input, output) {
    return { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { input: input * 1e-6, output: output * 5e-6, cacheRead: 0, cacheWrite: 0, total: input * 1e-6 + output * 5e-6 } };
  }

  function emitMessage(message, ctx) {
    out({ type: "message_start", message });
    out({ type: "message_end", message });
    persist(message);
    ctx?.runMessages.push(message);
  }

  function emitQueue() {
    out({ type: "queue_update", steering: S.steering.map((q) => q.text), followUp: S.followUp.map((q) => q.text) });
  }

  function userMessage(text, images) {
    const content = [{ type: "text", text }];
    for (const img of images ?? []) content.push(img);
    return { role: "user", content, timestamp: Date.now() };
  }

  function deliverQueue(which, ctx) {
    const list = which === "followUp" ? S.followUp : S.steering;
    if (!list.length) return [];
    const items = list.splice(0, list.length);
    emitQueue();
    for (const q of items) emitMessage(userMessage(q.text, q.images), ctx);
    return items;
  }

  async function streamAssistant(spec, ctx) {
    if (ctx.needNewTurn) {
      out({ type: "turn_end", message: ctx.lastAssistant, toolResults: ctx.toolResults });
      ctx.toolResults = [];
      deliverQueue("steering", ctx);
      out({ type: "turn_start" });
      ctx.needNewTurn = false;
    }
    const chunk = spec.chunk ?? 8;
    const every = spec.every ?? 10;
    const base = { role: "assistant", content: [], api: S.model?.api ?? "fake", provider: S.model?.provider ?? "fake", model: S.model?.id ?? "fake", usage: usage(0, 0), stopReason: "pending", timestamp: Date.now() };
    out({ type: "message_start", message: base });
    const content = [];
    let idx = 0;
    let outTokens = 0;
    const u = () => usage(spec.inputTokens ?? 1200, outTokens);
    const upd = (ev) => out({ type: "message_update", usage: u(), assistantMessageEvent: ev });
    const blocks = [];
    if (spec.thinking != null) blocks.push({ kind: "thinking", text: spec.thinking });
    if (spec.text != null) blocks.push({ kind: "text", text: spec.text });
    for (const b of spec.blocks ?? []) blocks.push(b);
    for (const t of spec.tools ?? []) blocks.push({ kind: "tool", ...t });
    let aborted = false;
    for (const b of blocks) {
      if (ctx.aborted) { aborted = true; break; }
      const contentIndex = idx++;
      if (b.kind === "thinking" || b.kind === "text") {
        const T = b.kind;
        upd({ type: `${T}_start`, contentIndex });
        let sent = "";
        for (let i = 0; i < b.text.length; i += chunk) {
          if (ctx.aborted) { aborted = true; break; }
          const delta = b.text.slice(i, i + chunk);
          sent += delta;
          outTokens += 1;
          upd({ type: `${T}_delta`, contentIndex, delta });
          if (every) await sleep(every, ctx);
        }
        const finalText = aborted ? sent : b.text;
        upd({ type: `${T}_end`, contentIndex, content: finalText });
        content.push(T === "thinking" ? { type: "thinking", thinking: finalText, thinkingSignature: "sig" } : { type: "text", text: finalText });
        if (aborted) break;
      } else {
        const id = b.id ?? `toolu_${randomBytes(6).toString("hex")}`;
        upd({ type: "toolcall_start", contentIndex, id, toolName: b.name });
        const json = JSON.stringify(b.args ?? {});
        for (let i = 0; i < json.length; i += 16) {
          upd({ type: "toolcall_delta", contentIndex, delta: json.slice(i, i + 16) });
        }
        if (every) await sleep(every, ctx);
        const toolCall = { type: "toolCall", id, name: b.name, arguments: b.args ?? {} };
        upd({ type: "toolcall_end", contentIndex, toolCall });
        content.push(toolCall);
      }
    }
    const hasTools = content.some((c) => c.type === "toolCall");
    const stopReason = aborted || ctx.aborted ? "aborted" : spec.stopReason ?? (hasTools ? "toolUse" : "stop");
    // Like Pi 1.5: message_end carries the message's duration (message_start → end).
    const final = { ...base, content, usage: u(), stopReason, timestamp: base.timestamp, durationMs: Date.now() - base.timestamp };
    if (spec.errorMessage) final.errorMessage = spec.errorMessage;
    if (stopReason === "aborted" && !final.errorMessage) final.errorMessage = "Request was aborted";
    out({ type: "message_end", message: final });
    persist(final);
    ctx.runMessages.push(final);
    ctx.lastAssistant = final;
    S.lastUsage = final.usage;
    if (hasTools) ctx.needNewTurn = true;
    return final;
  }

  async function runTool(spec, ctx) {
    ctx.ran ??= new Set();
    const pending = (c) => c.type === "toolCall" && !ctx.ran.has(c.id) && (!spec.name || c.name === spec.name);
    const id = spec.id ?? ctx.lastAssistant?.content.find(pending)?.id ?? `toolu_${randomBytes(6).toString("hex")}`;
    const call = ctx.lastAssistant?.content.find((c) => c.type === "toolCall" && c.id === id);
    ctx.ran.add(id);
    const name = spec.name ?? call?.name ?? "tool";
    const args = spec.args ?? call?.arguments ?? {};
    const started = Date.now();
    out({ type: "tool_execution_start", toolCallId: id, toolName: name, args });
    let acc = "";
    const updates = spec.updates ?? [];
    const every = spec.every ?? 30;
    for (const u of updates) {
      if (ctx.aborted) break;
      acc += u;
      out({ type: "tool_execution_update", toolCallId: id, toolName: name, args, partialResult: { content: [{ type: "text", text: acc }], details: {} } });
      await sleep(every, ctx);
    }
    if (spec.until === "abort") {
      let n = 0;
      while (!ctx.aborted) {
        acc += spec.tick ? spec.tick.replace("{n}", String(++n)) : `tick ${++n}\n`;
        out({ type: "tool_execution_update", toolCallId: id, toolName: name, args, partialResult: { content: [{ type: "text", text: acc }], details: {} } });
        await sleep(every, ctx);
      }
    } else if (spec.duration) {
      await sleep(spec.duration, ctx);
    }
    const aborted = ctx.aborted;
    const text = aborted ? (acc ? acc + "\n\n" : "") + "Command aborted" : spec.output ?? acc;
    const result = { content: !aborted && spec.content ? spec.content : [{ type: "text", text }], ...(spec.details ? { details: spec.details } : {}) };
    if (spec.structuredContent) result.structuredContent = spec.structuredContent;
    else if (name === "bash") result.structuredContent = { output: text, truncated: false, exit_code: aborted ? null : spec.exitCode ?? (spec.isError ? 1 : 0), wall_time_seconds: 0 };
    const isError = aborted || !!spec.isError;
    const durationMs = spec.durationMs ?? Date.now() - started;
    out({ type: "tool_execution_end", toolCallId: id, toolName: name, result, isError, durationMs });
    const msg = { role: "toolResult", toolCallId: id, toolName: name, content: result.content, ...(spec.details ? { details: spec.details } : {}), isError, durationMs, timestamp: Date.now() };
    emitMessage(msg, ctx);
    ctx.toolResults.push(msg);
  }

  async function runSteps(steps, ctx) {
    for (const step of steps ?? []) {
      if (ctx.aborted) return;
      await runStep(step, ctx);
    }
  }

  async function runStep(step, ctx) {
    if (step.emit) {
      for (const r of Array.isArray(step.emit) ? step.emit : [step.emit]) {
        out(r);
        if (r.type === "message_end" && r.message) persist(r.message);
      }
    } else if (step.raw !== undefined) {
      process.stdout.write(step.raw);
    } else if (step.big) {
      // An oversized record: a tool update whose payload is `bytes` long.
      const id = step.big.toolCallId ?? ctx.lastAssistant?.content.find((c) => c.type === "toolCall")?.id ?? "toolu_big";
      const text = "x".repeat(step.big.bytes ?? 9 * 1024 * 1024);
      out({ type: step.big.type ?? "tool_execution_update", toolCallId: id, toolName: step.big.toolName ?? "bash", args: step.big.args ?? {}, ...(step.big.type === "tool_execution_end" ? { result: { content: [{ type: "text", text }] }, isError: false, durationMs: 5 } : { partialResult: { content: [{ type: "text", text }] } }) });
    } else if (step.wait !== undefined) {
      await sleep(step.wait, ctx);
    } else if (step.assistant) {
      await streamAssistant(step.assistant, ctx);
    } else if (step.tool) {
      await runTool(step.tool, ctx);
    } else if (step.ui) {
      out({ type: "extension_ui_request", id: `ui-${++S.uiSeq}`, ...step.ui });
    } else if (step.custom) {
      emitMessage({ role: "custom", customType: step.custom.customType ?? "test", content: step.custom.content ?? "", display: step.custom.display ?? true, timestamp: Date.now() }, ctx);
    } else if (step.user) {
      emitMessage(userMessage(step.user), ctx);
    } else if (step.dialog) {
      const id = step.dialog.id ?? `dlg-${++S.dialogSeq}`;
      // The advertised timeout is scaled like every wait, so client and fake agree.
      out({ type: "extension_ui_request", ...step.dialog, id, ...(step.dialog.timeout ? { timeout: scaled(step.dialog.timeout) } : {}) });
      const answer = await new Promise((resolve) => {
        let timer;
        const finish = (a) => { clearTimeout(timer); S.dialogs.delete(id); ctx?.waiters.delete(onAbort); resolve(a); };
        const onAbort = () => finish("aborted");
        S.dialogs.set(id, (resp) => finish(resp.cancelled ? "cancelled" : resp.confirmed !== undefined ? String(resp.confirmed) : String(resp.value)));
        if (step.dialog.timeout) timer = setTimeout(() => finish("timeout"), scaled(step.dialog.timeout));
        ctx?.waiters.add(onAbort);
      });
      if (step.as) S[`answer:${step.as}`] = answer;
      const then = step.then ?? {};
      const branch = then[answer] ?? then["*"];
      if (branch) await runSteps(subst(branch, answer), ctx);
    } else if (step.deliverQueue) {
      deliverQueue(step.deliverQueue === true ? "steering" : step.deliverQueue, ctx);
    } else if (step.crash !== undefined) {
      process.stderr.write(`fake-pi: crashing with code ${step.crash}\n`);
      process.exit(Number(step.crash) || 1);
    } else if (step.hang) {
      await waitUntil(() => false, ctx, typeof step.hang === "number" ? step.hang : 0);
    } else if (step.run) {
      await startRun({ steps: step.run, autonomous: true });
    } else if (step.compaction) {
      const c = step.compaction;
      S.isCompacting = true;
      out({ type: "compaction_start", reason: c.reason ?? "threshold" });
      await sleep(c.duration ?? 100, ctx);
      S.isCompacting = false;
      if (c.error) out({ type: "compaction_end", reason: c.reason ?? "threshold", aborted: false, willRetry: false, errorMessage: c.error });
      else out({ type: "compaction_end", reason: c.reason ?? "threshold", result: { summary: c.summary ?? "Summary.", firstKeptEntryId: "x", tokensBefore: c.tokensBefore ?? 150000, estimatedTokensAfter: c.tokensAfter ?? 32000 }, aborted: false, willRetry: false });
    } else if (step.retry) {
      const r = step.retry;
      out({ type: "auto_retry_start", attempt: r.attempt ?? 1, maxAttempts: r.maxAttempts ?? 3, delayMs: r.delayMs ?? 2000, errorMessage: r.errorMessage ?? "529 overloaded" });
      await sleep(r.wait ?? 50, ctx);
      out({ type: "auto_retry_end", success: r.success ?? true, attempt: (r.attempt ?? 1) + 1, ...(r.success === false ? { finalError: r.errorMessage ?? "529 overloaded" } : {}) });
    } else if (step.extensionError) {
      out({ type: "extension_error", extensionPath: step.extensionError.path ?? "/ext/test.ts", event: step.extensionError.event ?? "tool_call", error: step.extensionError.error ?? "boom" });
    } else {
      process.stderr.write(`fake-pi: unknown step ${JSON.stringify(step)}\n`);
    }
  }

  function subst(steps, answer, key = "answer") {
    return JSON.parse(JSON.stringify(steps).replaceAll(`{${key}}`, String(answer).replace(/["\\]/g, "")));
  }

  function pickPrompt(text) {
    const list = scenario.prompts ?? [];
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (S.usedPrompts.has(i) && p.once !== false) continue;
      if (p.match && !new RegExp(p.match, "s").test(text)) continue;
      S.usedPrompts.add(i);
      return p.steps;
    }
    return scenario.default ?? [{ assistant: { text: `ok: ${text.slice(0, 60)}` } }];
  }

  async function startRun({ text, images, steps, autonomous }) {
    const ctx = makeCtx(autonomous ? "autonomous" : "prompt");
    S.run = ctx;
    out({ type: "agent_start" });
    out({ type: "turn_start" });
    if (text !== undefined) emitMessage(userMessage(text, images), ctx);
    let script = steps ?? pickPrompt(text ?? "");
    for (;;) {
      await runSteps(script, ctx);
      if (ctx.aborted) {
        // Like Pi 1.5: after tool calls, an aborted run ends with an empty assistant
        // message, stopReason "error", "This operation was aborted".
        if (ctx.needNewTurn) {
          out({ type: "turn_end", message: ctx.lastAssistant, toolResults: ctx.toolResults });
          ctx.toolResults = [];
          out({ type: "turn_start" });
          const empty = { role: "assistant", content: [], api: S.model?.api ?? "fake", provider: S.model?.provider ?? "fake", model: S.model?.id ?? "fake", usage: usage(0, 0), stopReason: "error", errorMessage: "This operation was aborted", timestamp: Date.now() };
          out({ type: "message_start", message: { ...empty, stopReason: "pending" } });
          out({ type: "message_end", message: empty });
          persist(empty);
          ctx.runMessages.push(empty);
          ctx.lastAssistant = empty;
          ctx.needNewTurn = false;
        }
        if (ctx.abortSteps) await runSteps(ctx.abortSteps, { ...makeCtx("abort") });
        break;
      }
      // Steering left at the end of a run still gets a turn; then follow-ups.
      let next = deliverQueue("steering", ctx);
      if (!next.length) next = deliverQueue("followUp", ctx);
      if (!next.length) break;
      out({ type: "turn_end", message: ctx.lastAssistant, toolResults: ctx.toolResults });
      ctx.toolResults = [];
      out({ type: "turn_start" });
      ctx.needNewTurn = false;
      script = pickPrompt(next.map((q) => q.text).join("\n"));
    }
    out({ type: "turn_end", message: ctx.lastAssistant, toolResults: ctx.toolResults });
    out({ type: "agent_end", messages: ctx.runMessages, willRetry: false });
    S.run = null;
    out({ type: "agent_settled", aborted: ctx.aborted });
    for (const w of ctx.onSettled ?? []) w();
    // `abort` continues queued messages when they remain.
    if (ctx.aborted && (S.steering.length || S.followUp.length)) {
      const q = [...S.steering, ...S.followUp];
      S.steering = [];
      S.followUp = [];
      emitQueue();
      startRun({ text: q.map((x) => x.text).join("\n") });
    }
  }

  function enqueue(kind, text, images) {
    (kind === "followUp" ? S.followUp : S.steering).push({ text, images });
    emitQueue();
  }

  function getState() {
    return {
      ...(S.model ? { model: S.model } : {}),
      thinkingLevel: S.thinkingLevel,
      isStreaming: !!S.run,
      isCompacting: S.isCompacting,
      steeringMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
      ...(S.sessionFile ? { sessionFile: S.sessionFile } : {}),
      sessionId: S.sessionId,
      ...(S.sessionName ? { sessionName: S.sessionName } : {}),
      autoCompactionEnabled: true,
      messageCount: S.messages.length,
      pendingMessageCount: S.steering.length + S.followUp.length,
    };
  }

  function stats() {
    const count = (role) => S.messages.filter((m) => m.role === role).length;
    const u = S.lastUsage;
    const cw = S.model?.contextWindow ?? null;
    const tokens = u ? u.totalTokens : scenario.contextTokens ?? null;
    return {
      sessionFile: S.sessionFile ?? undefined,
      sessionId: S.sessionId,
      userMessages: count("user"),
      assistantMessages: count("assistant"),
      toolCalls: S.messages.filter((m) => m.role === "assistant").reduce((a, m) => a + m.content.filter((c) => c.type === "toolCall").length, 0),
      toolResults: count("toolResult"),
      totalMessages: S.messages.length,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: scenario.cost ?? 0.0123,
      ...(cw ? { contextUsage: { tokens, contextWindow: cw, percent: tokens == null ? null : Math.round((tokens / cw) * 1000) / 10 } } : {}),
    };
  }

  const handlers = {
    prompt(rec) {
      let text = String(rec.message ?? "");
      const images = rec.images ?? [];
      const m = /^\/(\S+)\s*([\s\S]*)$/.exec(text);
      const extSteps = m && scenario.extensionCommands?.[m[1]];
      if (extSteps) {
        // Pi replies to an extension command only after its handler finishes.
        const ctx = makeCtx("command");
        runSteps(subst(extSteps, m[2], "args"), ctx).then(() => respond(rec.id, "prompt", { disposition: "handled" }));
        return;
      }
      // Pi's own failures (an extension's input handler, a bad template), and its skill/template expansion.
      if (scenario.rejectPrompts && new RegExp(scenario.rejectPrompts, "s").test(text)) {
        respond(rec.id, "prompt", undefined, `Rejected: ${text}`);
        return;
      }
      for (const [re, to] of Object.entries(scenario.expandPrompts ?? {})) text = text.replace(new RegExp(re, "s"), to);
      if (S.run || S.isCompacting) {
        if (!rec.streamingBehavior) {
          respond(rec.id, "prompt", undefined, "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.");
          return;
        }
        enqueue(rec.streamingBehavior === "followUp" ? "followUp" : "steer", text, images);
        respond(rec.id, "prompt", { disposition: "queued" });
        return;
      }
      respond(rec.id, "prompt", { disposition: "started" });
      startRun({ text, images });
    },
    steer(rec) {
      enqueue("steer", String(rec.message ?? ""), rec.images);
      respond(rec.id, "steer", { disposition: "queued" });
    },
    follow_up(rec) {
      enqueue("followUp", String(rec.message ?? ""), rec.images);
      respond(rec.id, "follow_up", { disposition: "queued" });
    },
    abort(rec) {
      const run = S.run;
      if (!run) { respond(rec.id, "abort"); return; }
      run.aborted = true;
      run.abortSteps = scenario.abort;
      (run.onSettled ??= []).push(() => respond(rec.id, "abort"));
      wake(run);
    },
    clear_queue(rec) {
      const data = { steering: S.steering.map((q) => q.text), followUp: S.followUp.map((q) => q.text) };
      S.steering = [];
      S.followUp = [];
      emitQueue();
      respond(rec.id, "clear_queue", data);
    },
    get_state(rec) { respond(rec.id, "get_state", getState()); },
    get_messages(rec) { respond(rec.id, "get_messages", { messages: S.messages }); },
    get_commands(rec) { respond(rec.id, "get_commands", { commands: scenario.commands ?? DEFAULT_COMMANDS }); },
    get_available_models(rec) { respond(rec.id, "get_available_models", { models }); },
    set_model(rec) {
      const m = models.find((x) => x.provider === rec.provider && x.id === rec.modelId);
      if (!m) return respond(rec.id, "set_model", undefined, `Model not found: ${rec.provider}/${rec.modelId}`);
      S.model = m;
      persistEntry({ type: "model_change", provider: m.provider, modelId: m.id });
      respond(rec.id, "set_model", m);
    },
    set_thinking_level(rec) {
      const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
      if (!levels.includes(rec.level)) return respond(rec.id, "set_thinking_level", undefined, `Invalid thinking level: ${rec.level}`);
      S.thinkingLevel = S.model?.reasoning === false ? "off" : rec.level;
      persistEntry({ type: "thinking_level_change", thinkingLevel: S.thinkingLevel });
      respond(rec.id, "set_thinking_level");
    },
    get_session_stats(rec) { respond(rec.id, "get_session_stats", stats()); },
    async compact(rec) {
      if (S.run) return respond(rec.id, "compact", undefined, "Cannot compact while the agent is running");
      S.isCompacting = true;
      out({ type: "compaction_start", reason: "manual" });
      await sleepRaw(scaled(scenario.compactMs ?? 150));
      S.isCompacting = false;
      const result = { summary: `Summary${rec.customInstructions ? " (" + rec.customInstructions + ")" : ""}.`, firstKeptEntryId: S.lastEntryId ?? "x", tokensBefore: 1200, estimatedTokensAfter: 300 };
      out({ type: "compaction_end", reason: "manual", result, aborted: false, willRetry: false });
      S.lastUsage = null;
      respond(rec.id, "compact", result);
    },
    new_session(rec) {
      if (scenario.cancelNewSession) return respond(rec.id, "new_session", { cancelled: true });
      S.sessionName = null;
      openSession(undefined);
      S.lastUsage = null;
      respond(rec.id, "new_session", { cancelled: false });
    },
    switch_session(rec) {
      const p = rec.sessionPath;
      if (!p || (!existsSync(p) && !scenario.sessions?.[p])) return respond(rec.id, "switch_session", undefined, `Session not found: ${p}`);
      S.sessionName = scenario.sessions?.[p]?.name ?? null;
      openSession(p, scenario.sessions?.[p]?.history);
      respond(rec.id, "switch_session", { cancelled: false });
    },
    // Pi's fork: the person's messages (entry ids from the session file), and a
    // new session file holding what came before one of them (Pi switches to it).
    get_fork_messages(rec) {
      respond(rec.id, "get_fork_messages", { messages: forkEntries().filter((e) => e.message.role === "user").map((e) => ({ entryId: e.id, text: textOfContent(e.message.content) })) });
    },
    fork(rec) {
      const entries = forkEntries();
      const i = entries.findIndex((e) => e.id === rec.entryId && e.message.role === "user");
      if (i < 0) return respond(rec.id, "fork", undefined, `Entry not found: ${rec.entryId}`);
      if (scenario.cancelFork) return respond(rec.id, "fork", { text: "", cancelled: true });
      const parent = S.sessionFile;
      S.sessionName = null;
      openSessionFile(undefined);
      if (S.sessionFile) {
        mkdirSync(dirname(S.sessionFile), { recursive: true });
        writeFileSync(S.sessionFile, JSON.stringify({ type: "session", version: 3, id: S.sessionId, timestamp: new Date().toISOString(), cwd, parentSession: parent }) + "\n");
        S.headerWritten = true;
      }
      for (const e of entries.slice(0, i)) persist(e.message);
      S.lastUsage = null;
      respond(rec.id, "fork", { text: textOfContent(entries[i].message.content), cancelled: false });
    },
    set_session_name(rec) {
      S.sessionName = rec.name || null;
      persistEntry({ type: "session_info", name: rec.name });
      out({ type: "session_info_changed", ...(rec.name ? { name: rec.name } : {}) });
      respond(rec.id, "set_session_name");
    },
    get_last_assistant_text(rec) {
      const a = [...S.messages].reverse().find((m) => m.role === "assistant");
      respond(rec.id, "get_last_assistant_text", { text: a ? a.content.filter((c) => c.type === "text").map((c) => c.text).join("") : null });
    },
    extension_ui_response(rec) {
      const r = S.dialogs.get(rec.id);
      if (r) r(rec);
    },
  };

  onCommand = (rec) => {
    const h = handlers[rec.type];
    if (!h) return respond(rec.id, rec.type, undefined, `Unknown command: ${rec.type}`);
    h(rec);
  };

  // Startup: Pi runs session_start handlers before it reads stdin.
  (async () => {
    const ctx = makeCtx("startup");
    if (scenario.startupBlocksStdin) {
      await runSteps(scenario.startup, ctx);
      startReading();
    } else {
      startReading();
      await runSteps(scenario.startup, ctx);
    }
    for (const t of scenario.timers ?? []) {
      setTimeout(() => runSteps(t.steps, makeCtx("timer")), scaled(t.after ?? 0));
    }
  })();
}

const DEFAULT_COMMANDS = [
  { name: "rpc-input", description: "Ask for input (demo)", source: "extension", sourceInfo: { path: "/ext/rpc-demo.ts", source: "cli", scope: "temporary", origin: "top-level" } },
  { name: "review", description: "Review the current diff", source: "prompt", sourceInfo: { path: "/prompts/review.md", source: "local", scope: "user", origin: "top-level" } },
  { name: "skill:diagnose", description: "Diagnose a bug", source: "skill", sourceInfo: { path: "/skills/diagnose/SKILL.md", source: "local", scope: "user", origin: "top-level" } },
];

// =====================================================================
// Replay mode: plays a recorded fixture (tests/fixtures/*.jsonl).
// Lines: {"t":ms,"dir":"in"|"out","rec":{...}}. "in" records are what the
// recorder sent. Segment commands (prompt, steer, follow_up, abort,
// extension_ui_response, compact, new_session, ...) gate playback: the
// records after a recorded segment command play only once the host sends a
// command of the same type. Query commands are answered from the recording.
// =====================================================================
function runReplay(path) {
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  const SEGMENT = new Set(["prompt", "steer", "follow_up", "abort", "extension_ui_response", "compact", "new_session", "switch_session", "set_model", "set_thinking_level", "set_session_name"]);
  const recorderIds = new Set(lines.filter((l) => l.dir === "in" && l.rec.id !== undefined).map((l) => String(l.rec.id)));
  // Recorded answers to query commands, in order, by command type.
  const answers = new Map();
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.dir === "in" && !SEGMENT.has(l.rec.type)) {
      const resp = lines.slice(i + 1).find((x) => x.dir === "out" && x.rec.type === "response" && x.rec.id === l.rec.id);
      if (resp) {
        if (!answers.has(l.rec.type)) answers.set(l.rec.type, []);
        answers.get(l.rec.type).push({ at: i, rec: resp.rec });
      }
    }
  }
  const isQueryResponse = (rec) => rec.type === "response" && rec.id !== undefined && recorderIds.has(String(rec.id)) && !SEGMENT.has(rec.command);
  let pos = 0; // next line index to play
  let playing = false;
  const waiting = []; // host commands of segment types waiting for their segment
  const idMap = new Map(); // recorded segment command id -> host id

  async function playUntilNextSegment() {
    if (playing) return;
    playing = true;
    let lastT = null;
    while (pos < lines.length) {
      const l = lines[pos];
      if (l.dir === "in") {
        if (!SEGMENT.has(l.rec.type)) { pos++; continue; }
        // Gate: need a matching host command.
        const wi = waiting.findIndex((w) => w.type === l.rec.type);
        if (wi < 0) break;
        const w = waiting.splice(wi, 1)[0];
        if (l.rec.id !== undefined) idMap.set(String(l.rec.id), w.id);
        pos++;
        lastT = l.t;
        continue;
      }
      if (lastT !== null && l.t > lastT) await sleepRaw(scaled(l.t - lastT));
      lastT = l.t;
      pos++;
      const rec = l.rec;
      if (isQueryResponse(rec)) continue;
      if (rec.type === "response" && rec.id !== undefined) {
        const hostId = idMap.get(String(rec.id));
        out({ ...rec, ...(hostId === undefined ? {} : { id: hostId }) });
        continue;
      }
      out(rec);
    }
    playing = false;
  }

  onCommand = (rec) => {
    if (SEGMENT.has(rec.type)) {
      waiting.push({ type: rec.type, id: rec.id });
      playUntilNextSegment();
      return;
    }
    const list = answers.get(rec.type);
    if (!list || !list.length) return respond(rec.id, rec.type, undefined, `fake-pi replay: no recorded ${rec.type}`);
    // The latest recorded answer at or before the playback position, else the first.
    let pick = list[0];
    for (const a of list) if (a.at <= pos) pick = a;
    out({ ...pick.rec, id: rec.id });
  };

  startReading();
  playUntilNextSegment();
}
