// Pi as a provider: `pi --mode rpc`. Spawns and supervises Pi, turns its RPC
// events and `get_messages` history into normalized events, and carries out
// the core's commands. The settle fallback (a `get_state` probe after a quiet
// spell) lives here because it is Pi's.
import { execFile } from "node:child_process";
import { basename, dirname } from "node:path";
import { PiProcess } from "./rpc.ts";
import type { PiRecord, Oversized } from "./rpc.ts";
import { contentText, echoText, countImages, imageBlocks, resultText, resultImages } from "./content.ts";
import { listSessions, defaultSessionDir, readSettings } from "./sessions.ts";
import { newId } from "../../timeline.ts";
import type {
  ProviderAdapter, AdapterHost, AdapterOptions, Capabilities, StartInfo, NormalizedEvent, AssistantBlock, AskAnswer, ImageBlock,
  ModelInfo, AgentCommand, AgentModel, SessionInfo, UsageInfo, PromptMode, Disposition, StopReason, Usage, EventOf, ForkPoint,
} from "../types.ts";
import { PI_TOOLS } from "./tools.ts";
import { userText } from "./skill.ts";

type Rec = Record<string, any>;

export const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function mapModel(m: Rec | undefined | null): ModelInfo | null {
  if (!m || typeof m !== "object" || typeof m.id !== "string") return null;
  return {
    provider: String(m.provider ?? ""),
    id: m.id,
    name: String(m.name ?? m.id),
    reasoning: m.reasoning === true,
    contextWindow: typeof m.contextWindow === "number" ? m.contextWindow : null,
    input: Array.isArray(m.input) ? m.input.map(String) : ["text"],
  };
}

/** Whether `provider/id` matches Pi's `enabledModels` patterns (globs, `:level` suffixes). */
export function modelEnabled(patterns: unknown, provider: string, id: string): boolean {
  if (!Array.isArray(patterns)) return false;
  const full = `${provider}/${id}`;
  for (const raw of patterns) {
    if (typeof raw !== "string") continue;
    const candidates = [raw, raw.replace(/:(off|minimal|low|medium|high|xhigh|max)$/, "")];
    for (const p of candidates) {
      if (p === full || p === id) return true;
      if (p.includes("*")) {
        const re = new RegExp("^" + p.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
        if (re.test(full) || re.test(id)) return true;
      }
    }
  }
  return false;
}

/** Pi message usage in protocol form (`cost` is Pi's `cost.total`). */
function usageOf(m: Rec): Usage | undefined {
  const u = m.usage;
  if (!u || typeof u !== "object") return undefined;
  const n = (v: unknown) => num(v) ?? 0;
  const cost = typeof u.cost === "object" && u.cost ? num(u.cost.total) ?? null : num(u.cost) ?? null;
  return { input: n(u.input), output: n(u.output), cacheRead: n(u.cacheRead), cacheWrite: n(u.cacheWrite), cost };
}

/** A finished Pi assistant message → `assistant_end`. */
export function assistantEnd(m: Rec): EventOf<"assistant_end"> {
  const raw: Rec[] = Array.isArray(m.content) ? m.content : typeof m.content === "string" ? [{ type: "text", text: m.content }] : [];
  const content: (AssistantBlock | null)[] = raw.map((b) => {
    if (!b || typeof b !== "object") return null;
    if (b.type === "text") return { type: "text", text: String(b.text ?? "") };
    if (b.type === "thinking") return { type: "thinking", text: String(b.thinking ?? "") };
    if (b.type === "toolCall") return { type: "toolCall", callId: String(b.id), name: String(b.name ?? "tool"), args: b.arguments };
    return null;
  });
  let stopReason = str(m.stopReason) as StopReason | undefined;
  const error = str(m.errorMessage);
  // Pi 1.5 ends an aborted request with stopReason "error" and "This operation was aborted".
  if (stopReason === "error" && error && /\babort(ed)?\b/i.test(error)) stopReason = "aborted";
  const usage = usageOf(m);
  const durationMs = num(m.durationMs);
  const model = str(m.provider) && str(m.model) ? `${m.provider}/${m.model}` : undefined;
  return {
    type: "assistant_end", content,
    ...(stopReason ? { stopReason } : {}), ...(error ? { error } : {}), ...(model ? { model } : {}),
    ...(usage ? { usage } : {}), ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

/** `get_messages` → the events that rebuild the timeline. */
export function historyEvents(messages: Rec[]): NormalizedEvent[] {
  const out: NormalizedEvent[] = [];
  for (const m of messages) {
    const ts = num(m.timestamp) ?? Date.now();
    switch (m.role) {
      case "user":
        out.push({ type: "user_message", ...userText(contentText(m.content)), images: countImages(m.content), imageBlocks: imageBlocks(m.content), source: "composer", ts });
        break;
      case "assistant":
        out.push({ ...assistantEnd(m), ts });
        break;
      case "toolResult": {
        const result = { content: m.content, details: m.details };
        const durationMs = num(m.durationMs);
        out.push({
          type: "tool_ended", callId: String(m.toolCallId), name: str(m.toolName) ?? "tool", isError: m.isError === true,
          output: resultText(result), images: resultImages(result), result, ...(durationMs !== undefined ? { durationMs } : {}), ts,
        });
        break;
      }
      case "custom":
        if (m.display !== false) out.push({ type: "custom", customType: str(m.customType) ?? "custom", text: contentText(m.content), ts });
        break;
      case "bashExecution": {
        const callId = newId("bash");
        const args = { command: m.command };
        const output = String(m.output ?? "");
        out.push({ type: "tool_call", callId, name: "bash", args, ts });
        out.push({
          type: "tool_ended", callId, name: "bash", isError: m.cancelled === true || (m.exitCode ?? 0) !== 0, output,
          result: { content: [{ type: "text", text: output }], structuredContent: { exit_code: m.exitCode ?? null } }, ts,
        });
        break;
      }
      case "compactionSummary":
        out.push({ type: "notice", level: "info", source: "compaction", text: `Compacted the conversation (${Math.round((num(m.tokensBefore) ?? 0) / 1000)}k tokens before).`, ts });
        break;
      case "branchSummary":
        out.push({ type: "notice", level: "info", source: "host", text: "Continued from another branch.", ts });
        break;
    }
  }
  return out;
}

export class PiAdapter implements ProviderAdapter {
  readonly id = "pi";
  readonly name = "Pi";
  readonly tools = PI_TOOLS;
  readonly capabilities: Capabilities = {
    steer: true, followUp: true, thinkingLevels: PI_THINKING_LEVELS, permissions: false, permissionModes: [],
    extensionUi: true, compact: true, compactInstructions: true, rename: true, fork: true, images: true, cost: true, tui: true,
  };
  private opts: AdapterOptions;
  private proc: PiProcess | null = null;
  private host: AdapterHost | null = null;
  private activity = 0;
  private probeTimer: NodeJS.Timeout | null = null;
  /**
   * The host's messages Pi hasn't echoed yet, oldest first. Pi has no message
   * ids, so its echoes are matched in the order it delivers them: a prompt at
   * once, then steers, then follow-ups (Pi drains the steers before a follow-up).
   */
  private unechoed: { id: string; kind: "prompt" | "steer" | "followUp"; text: string; images: ImageBlock[] }[] = [];
  /** Every entry of Pi's last queue_update is one of ours: a steer can be taken back (clear, re-add the others). */
  private queueOurs = false;
  /** Removals run one at a time (each clears Pi's queue and re-adds). */
  private queueOp: Promise<unknown> = Promise.resolve();

  constructor(opts: AdapterOptions) {
    this.opts = opts;
  }

  get alive(): boolean {
    return !!this.proc && !this.proc.exited;
  }

  private emit(ev: NormalizedEvent): void {
    this.host?.emit(ev);
  }

  private require(): PiProcess {
    if (!this.proc) throw new Error("Pi is not running. Use /reload to restart it.");
    return this.proc;
  }

  // ---------------------------------------------------------------- lifecycle

  async start(session: string | null, host: AdapterHost): Promise<StartInfo> {
    this.host = host;
    this.unechoed = [];
    this.queueOurs = false;
    const args = ["--mode", "rpc", ...this.opts.args, ...(session ? ["--session", session] : [])];
    host.log(`spawn ${this.opts.command} ${args.join(" ")}`);
    const env = { ...process.env, HERDR_CHAT_HOST: "1" };
    const pi = new PiProcess({ command: this.opts.command, args, cwd: this.opts.cwd, env });
    this.proc = pi;
    pi.onEvent = (rec) => this.proc === pi && this.onRecord(rec);
    pi.onOversized = (o) => this.proc === pi && this.onOversized(o);
    pi.onBadLine = (line) => host.log(`pi stdout (not JSON): ${line.slice(0, 200)}`);
    pi.onExit = (info) => {
      if (this.proc !== pi) return;
      this.proc = null;
      host.emit({
        type: "exited", code: info.code, signal: info.signal, stderrTail: info.stderr,
        ...(info.spawnError ? { spawnError: info.spawnError } : {}), command: this.opts.command,
      });
    };
    this.probeVersion(host);
    const st = (await pi.request("get_state", {}, 0)) as Rec;
    this.applyState(st);
    return { streaming: st.isStreaming === true, hasHistory: (st.messageCount ?? 0) > 0 };
  }

  /** The core adopted the run Pi reported at start; settle it by probe if Pi never says so. */
  watchRun(): void {
    this.probe(3000);
  }

  private probeVersion(host: AdapterHost): void {
    execFile(this.opts.command, ["--version"], { timeout: 10_000, env: { ...process.env, HERDR_CHAT_HOST: "1" } }, (err, stdout) => {
      const v = err ? null : (/\d+\.\d+\.\d+[\w.-]*/.exec(stdout)?.[0] ?? null);
      host.emit({ type: "version", version: v });
      if (v && /^(0\.|1\.[0-4]\.)/.test(v)) host.emit({ type: "notice", level: "warning", source: "host", text: `Pi ${v} is older than 1.5; the chat needs Pi 1.5 or newer.` });
    });
  }

  private applyState(st: Rec): void {
    const model = mapModel(st.model);
    if (model) this.emitModel(model);
    if (typeof st.thinkingLevel === "string") this.emit({ type: "thinking", level: st.thinkingLevel });
    this.emit({ type: "session", file: typeof st.sessionFile === "string" ? st.sessionFile : null, name: typeof st.sessionName === "string" ? st.sessionName : null });
  }

  private emitModel(model: ModelInfo): void {
    this.emit({ type: "model", model });
    this.emit({ type: "capabilities", capabilities: { images: model.input.includes("image") } });
  }

  private async refreshState(): Promise<void> {
    if (!this.proc) return;
    try {
      this.applyState((await this.proc.request("get_state", {}, 10_000)) as Rec);
    } catch {}
  }

  async dispose(): Promise<void> {
    const pi = this.proc;
    if (!pi) return;
    this.proc = null;
    if (this.probeTimer) clearTimeout(this.probeTimer);
    this.probeTimer = null;
    await pi.stop();
  }

  kill(): void {
    this.proc?.killNow();
  }

  // ---------------------------------------------------------------- events

  private onRecord(rec: PiRecord): void {
    const ev = rec as Rec;
    const t = ev.type;
    if (t !== "extension_ui_request" && t !== "response") {
      this.activity++;
      this.emit({ type: "heartbeat" });
    }
    switch (t) {
      case "response":
        if (ev.command === "parse" && ev.success === false) this.host?.log(`pi parse error: ${ev.error}`);
        return;
      case "agent_start":
        this.emit({ type: "run_started" });
        return;
      case "agent_end":
        this.probe(3000);
        return;
      case "agent_settled":
        if (this.probeTimer) clearTimeout(this.probeTimer);
        this.probeTimer = null;
        // A prompt's echo comes inside its run.
        this.unechoed = this.unechoed.filter((u) => u.kind !== "prompt");
        this.emit({ type: "run_settled", aborted: ev.aborted === true });
        return;
      case "turn_end":
        this.emit({ type: "turn_end" });
        return;
      case "message_start": {
        const m: Rec = ev.message ?? {};
        if (m.role === "user") {
          const clientId = this.takeEchoed();
          this.emit({ type: "user_message", ...userText(echoText(m.content)), images: countImages(m.content), imageBlocks: imageBlocks(m.content), ...(clientId ? { clientId } : {}) });
        } else if (m.role === "custom" && m.display !== false) {
          this.emit({ type: "custom", customType: String(m.customType ?? "custom"), text: contentText(m.content) });
          this.emit({ type: "run_cause", text: `Started by ${m.customType ?? "an extension"}.` });
        } else if (m.role === "assistant") {
          this.emit({ type: "assistant_start" });
        }
        return;
      }
      case "message_update":
        this.onMessageUpdate(ev.assistantMessageEvent ?? {});
        return;
      case "message_end":
        if (ev.message?.role === "assistant") this.emit(assistantEnd(ev.message));
        return;
      case "tool_execution_start":
        this.emit({ type: "tool_started", callId: String(ev.toolCallId), name: str(ev.toolName) ?? "tool", args: ev.args });
        return;
      case "tool_execution_update":
        this.emit({
          type: "tool_progress", callId: String(ev.toolCallId), name: str(ev.toolName) ?? "tool", args: ev.args,
          ...(ev.partialResult !== undefined ? { output: resultText(ev.partialResult) } : {}),
        });
        return;
      case "tool_execution_end": {
        const durationMs = num(ev.durationMs);
        this.emit({
          type: "tool_ended", callId: String(ev.toolCallId), name: str(ev.toolName) ?? "tool", args: ev.args, isError: ev.isError === true,
          output: resultText(ev.result), images: resultImages(ev.result), result: ev.result, ...(durationMs !== undefined ? { durationMs } : {}),
        });
        return;
      }
      case "queue_update": {
        const steering = (ev.steering ?? []).map(String);
        const followUp = (ev.followUp ?? []).map(String);
        // Ours, in order, when Pi's queue holds only ours.
        const ids = (kind: "steer" | "followUp", texts: string[]) => {
          const mine = this.unechoed.filter((u) => u.kind === kind);
          return mine.length === texts.length ? mine.map((u) => u.id) : texts.map(() => null);
        };
        const steeringIds = ids("steer", steering);
        const followUpIds = ids("followUp", followUp);
        this.queueOurs = [...steeringIds, ...followUpIds].every(Boolean);
        this.emit({ type: "queue_changed", steering, followUp, steeringIds, followUpIds });
        return;
      }
      case "compaction_start": {
        const reason = String(ev.reason ?? "manual");
        this.emit({ type: "compaction", phase: "start", reason: reason === "overflow" ? "overflow" : reason === "manual" ? "manual" : "auto" });
        return;
      }
      case "compaction_end":
        this.emit({
          type: "compaction", phase: "end", outcome: ev.result ? "done" : ev.aborted ? "aborted" : "failed",
          ...(ev.result ? { tokensBefore: ev.result.tokensBefore ?? 0, tokensAfter: ev.result.estimatedTokensAfter ?? 0 } : {}),
          ...(ev.errorMessage !== undefined && ev.errorMessage !== null ? { error: String(ev.errorMessage) } : {}),
        });
        return;
      case "auto_retry_start":
        this.emit({ type: "retry", phase: "start", attempt: ev.attempt ?? 1, maxAttempts: ev.maxAttempts ?? null, delayMs: ev.delayMs ?? 0, error: String(ev.errorMessage ?? "error") });
        return;
      case "auto_retry_end":
        this.emit({ type: "retry", phase: "end", success: !!ev.success, attempt: ev.attempt ?? null, ...(ev.finalError !== undefined && ev.finalError !== null ? { error: String(ev.finalError) } : {}) });
        return;
      case "extension_error": {
        const ext = typeof ev.extensionPath === "string" ? basename(ev.extensionPath) : "an extension";
        this.emit({ type: "notice", level: "error", source: "extension_error", text: `Extension error in ${ext}${ev.event ? ` (${ev.event})` : ""}: ${ev.error ?? ""}` });
        return;
      }
      case "extension_ui_request":
        this.onUi(ev);
        return;
      case "session_info_changed":
        this.emit({ type: "session", name: typeof ev.name === "string" && ev.name ? ev.name : null });
        return;
      case "thinking_level_changed":
        if (typeof ev.level === "string") this.emit({ type: "thinking", level: ev.level });
        return;
    }
  }

  private onMessageUpdate(u: Rec): void {
    const index = num(u.contentIndex) ?? 0;
    switch (u.type) {
      case "text_start":
      case "thinking_start":
        this.emit({ type: "assistant_block_start", index, kind: u.type === "text_start" ? "text" : "thinking" });
        return;
      case "text_delta":
      case "thinking_delta": {
        const kind = u.type === "text_delta" ? "text" : "thinking";
        if (typeof u.delta === "string") this.emit({ type: "assistant_delta", index, kind, delta: u.delta });
        else this.emit({ type: "assistant_block_start", index, kind });
        return;
      }
      case "text_end":
      case "thinking_end":
        this.emit({ type: "assistant_block_end", index, kind: u.type === "text_end" ? "text" : "thinking", ...(typeof u.content === "string" ? { text: u.content } : {}) });
        return;
      case "toolcall_start":
        this.emit({ type: "tool_call_start", index, callId: str(u.id) ?? `call-${index}`, name: str(u.toolName) ?? "tool" });
        return;
      case "toolcall_delta":
        this.emit({ type: "tool_call_delta", index, delta: str(u.delta) ?? "" });
        return;
      case "toolcall_end": {
        const call: Rec = u.toolCall ?? {};
        this.emit({ type: "tool_call", index, callId: str(call.id) ?? `call-${index}`, name: str(call.name) ?? "tool", args: call.arguments });
        return;
      }
    }
  }

  private onUi(ev: Rec): void {
    const id = String(ev.id ?? "");
    switch (ev.method) {
      case "select":
      case "confirm":
      case "input":
      case "editor":
        this.emit({
          type: "ask",
          ask: {
            id, kind: ev.method, title: String(ev.title ?? ""),
            ...(typeof ev.message === "string" ? { message: ev.message } : {}),
            ...(Array.isArray(ev.options) ? { options: ev.options.map((o: unknown) => String(o)) } : {}),
            ...(typeof ev.placeholder === "string" ? { placeholder: ev.placeholder } : {}),
            ...(typeof ev.prefill === "string" ? { prefill: ev.prefill } : {}),
            ...(typeof ev.timeout === "number" && ev.timeout > 0 ? { timeoutAt: Date.now() + ev.timeout } : {}),
          },
        });
        return;
      case "notify": {
        const level = ev.notifyType === "error" ? "error" : ev.notifyType === "warning" ? "warning" : "info";
        this.emit({ type: "notice", level, source: "notify", text: String(ev.message ?? "") });
        return;
      }
      case "setStatus":
        this.emit({ type: "status", key: String(ev.statusKey ?? ""), text: typeof ev.statusText === "string" && ev.statusText.length ? ev.statusText : null });
        return;
      case "setWidget":
        this.emit({
          type: "widget", key: String(ev.widgetKey ?? ""), placement: ev.widgetPlacement === "belowEditor" ? "belowEditor" : "aboveEditor",
          lines: Array.isArray(ev.widgetLines) ? ev.widgetLines.slice(0, 200).map(String) : null,
        });
        return;
      case "setTitle":
        this.emit({ type: "title", text: typeof ev.title === "string" && ev.title ? ev.title : null });
        return;
      case "set_editor_text":
        this.emit({ type: "editor_text", text: typeof ev.text === "string" ? ev.text : null });
        return;
      default:
        // An unknown method that may await an answer: cancel it so Pi doesn't hang.
        if (id) this.proc?.write({ type: "extension_ui_response", id, cancelled: true });
    }
  }

  /**
   * Settle fallback: if Pi shows no activity for `delay` ms while the core
   * thinks a run is on, ask get_state and settle when Pi is idle.
   */
  private probe(delay: number): void {
    if (this.probeTimer) clearTimeout(this.probeTimer);
    const rev = this.activity;
    this.probeTimer = setTimeout(async () => {
      this.probeTimer = null;
      const pi = this.proc;
      const host = this.host;
      if (!pi || !host || rev !== this.activity) return;
      if (!host.running && !host.working) return;
      let st: Rec;
      try {
        st = (await pi.request("get_state", {}, 10_000)) as Rec;
      } catch {
        return;
      }
      if (rev !== this.activity) return;
      if (!st.isStreaming && !st.isCompacting && !(st.pendingMessageCount > 0)) {
        host.log("settled by get_state probe");
        host.emit({ type: "run_settled", aborted: false });
      } else {
        this.probe(Math.max(delay, 2000));
      }
    }, delay);
  }

  /** A record over the 8 MiB cap: recover what it was from its head, so the timeline stays consistent. */
  private onOversized(o: Oversized): void {
    this.activity++;
    this.emit({ type: "heartbeat" });
    const type = /^\{"type":"([a-z_]+)"/.exec(o.head)?.[1] ?? null;
    const mb = (o.size / 1048576).toFixed(1);
    this.host?.log(`dropped an oversized Pi record (${type ?? "unknown"}, ${o.size} bytes)`);
    const tool = /^\{"type":"tool_execution_(start|update|end)","toolCallId":"([^"\\]+)","toolName":"([^"\\]+)"/.exec(o.head);
    if (tool) {
      const [, phase, callId, name] = tool as unknown as [string, string, string, string];
      this.emit({ type: "tool_started", callId, name });
      if (phase === "end") {
        const durationMs = Number(/"durationMs":(\d+)/.exec(o.head)?.[1]);
        this.emit({ type: "tool_ended", callId, name, isError: false, output: "", lostBytes: o.size, ...(Number.isFinite(durationMs) ? { durationMs } : {}) });
      }
    } else if (type === "message_end" && /^\{"type":"message_end","message":\{"role":"assistant"/.test(o.head)) {
      this.emit({ type: "assistant_end", content: [] });
    } else if (type === "message_start" && /"role":"user"/.test(o.head.slice(0, 64))) {
      this.emit({ type: "user_message", text: `[message too large to show: ${mb} MiB]`, images: 0, source: "extension" });
    }
    this.emit({ type: "notice", level: "warning", source: "host", text: `Pi sent an update too large to show (${mb} MiB), so part of this turn is missing here.`, once: "run" });
    if (this.host?.running) this.probe(3000);
  }

  // ---------------------------------------------------------------- commands

  async prompt(p: { id: string; text: string; images: ImageBlock[]; mode: PromptMode; busy: boolean }): Promise<{ disposition: Disposition }> {
    const pi = this.require();
    const behavior: "steer" | "followUp" | undefined = p.busy ? (p.mode === "followUp" ? "followUp" : "steer") : undefined;
    const images = p.images.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType }));
    // Before the request: the echo can come before the reply.
    const entry: (typeof this.unechoed)[number] = { id: p.id, kind: behavior ?? "prompt", text: p.text, images: p.images };
    this.unechoed.push(entry);
    const forget = () => {
      const i = this.unechoed.indexOf(entry);
      if (i >= 0) this.unechoed.splice(i, 1);
    };
    const d = (await pi.request("prompt", { message: p.text, ...(images.length ? { images } : {}), ...(behavior ? { streamingBehavior: behavior } : {}) }, 0).catch((e) => {
      forget();
      throw e;
    })) as Rec;
    const disposition = String(d?.disposition ?? "started");
    if (disposition === "handled") forget(); // an extension command: no message
    if (disposition === "started") this.probe(5000);
    return { disposition };
  }

  /** The host's message a user echo is, in Pi's delivery order. */
  private takeEchoed(): string | undefined {
    const next = this.unechoed.find((u) => u.kind === "prompt") ?? this.unechoed.find((u) => u.kind === "steer") ?? this.unechoed.find((u) => u.kind === "followUp");
    if (!next) return undefined;
    this.unechoed.splice(this.unechoed.indexOf(next), 1);
    return next.id;
  }

  async clearQueue(): Promise<string[]> {
    const pi = this.proc;
    if (!pi) return [];
    try {
      const q = (await pi.request("clear_queue", {}, 5_000)) as Rec;
      this.unechoed = this.unechoed.filter((u) => u.kind === "prompt");
      return [...(q?.steering ?? []), ...(q?.followUp ?? [])].map(String);
    } catch {
      return [];
    }
  }

  // Pi's RPC has no per-message removal: clear its queue and re-add the rest.
  // Their order holds only while the whole queue is ours (we have their images too).
  canRemoveQueued(id: string): boolean {
    return this.queueOurs && this.unechoed.some((u) => u.id === id && u.kind === "steer");
  }

  removeQueued(id: string): Promise<boolean> {
    const run = this.queueOp.then(() => this.clearAndReadd(id));
    this.queueOp = run.catch(() => {});
    return run;
  }

  private async clearAndReadd(id: string): Promise<boolean> {
    const pi = this.require();
    const q = (await pi.request("clear_queue", {}, 5_000)) as Rec;
    const steering = (q?.steering ?? []).map(String);
    const followUp = (q?.followUp ?? []).map(String);
    // Pi delivers its oldest steers first: the ones it gave back are our newest.
    const mine = this.unechoed.filter((u) => u.kind === "steer");
    const back = steering.length <= mine.length ? mine.slice(mine.length - steering.length) : [];
    const ours = new Set(back.map((u) => u.id));
    this.unechoed = this.unechoed.filter((u) => !ours.has(u.id) && u.kind !== "followUp");
    const found = ours.has(id);
    const busy = this.host?.running ?? true;
    if (back.length === steering.length) {
      for (const u of back) if (u.id !== id) await this.prompt({ id: u.id, text: u.text, images: u.images, mode: "steer", busy });
    } else {
      // Not all ours after all (an extension queued one meanwhile): put back what Pi returned, as text.
      for (const text of steering) await pi.request("prompt", { message: text, streamingBehavior: "steer" }, 0);
    }
    for (const text of followUp) await pi.request("prompt", { message: text, streamingBehavior: "followUp" }, 0);
    return found;
  }

  abort(): void {
    const pi = this.proc;
    if (!pi) return;
    pi.request("abort", {}, 0)
      .then(() => this.probe(300))
      .catch(() => {});
    this.probe(5000);
  }

  answer(askId: string, a: AskAnswer): void {
    const resp = "cancelled" in a || "confirmed" in a || "value" in a ? a : { cancelled: true };
    this.proc?.write({ type: "extension_ui_response", id: askId, ...resp });
  }

  async history(): Promise<NormalizedEvent[]> {
    const data = (await this.require().request("get_messages", {}, 30_000)) as Rec;
    return historyEvents(Array.isArray(data?.messages) ? data.messages : []);
  }

  listSessions(current: string | null): SessionInfo[] {
    const dirs = new Set<string>();
    if (current) dirs.add(dirname(current));
    dirs.add(defaultSessionDir(this.opts.cwd));
    return listSessions([...dirs]);
  }

  async listModels(): Promise<AgentModel[]> {
    const d = (await this.require().request("get_available_models", {}, 30_000)) as Rec;
    const enabled = readSettings(this.opts.cwd).enabledModels;
    const list = Array.isArray(d?.models) ? d.models : [];
    return list.map((m: Rec) => ({
      provider: String(m.provider), id: String(m.id), name: String(m.name ?? m.id), reasoning: m.reasoning === true,
      enabled: modelEnabled(enabled, String(m.provider), String(m.id)),
    }));
  }

  async commands(): Promise<AgentCommand[]> {
    const d = (await this.require().request("get_commands", {}, 15_000)) as Rec;
    const list = Array.isArray(d?.commands) ? d.commands : [];
    return list
      .filter((c: Rec) => c && typeof c === "object" && typeof c.name === "string")
      .map((c: Rec) => ({ name: c.name, description: typeof c.description === "string" ? c.description : "", source: c.source === "prompt" || c.source === "skill" ? c.source : "extension" }));
  }

  async usage(): Promise<UsageInfo> {
    const s = (await this.require().request("get_session_stats", {}, 15_000)) as Rec;
    const cu: Rec = s?.contextUsage ?? {};
    return {
      contextTokens: typeof cu.tokens === "number" ? cu.tokens : null,
      contextWindow: typeof cu.contextWindow === "number" ? cu.contextWindow : null,
      percent: typeof cu.percent === "number" ? cu.percent : null,
      cost: typeof s?.cost === "number" ? s.cost : null,
    };
  }

  tuiCommand(session: string, ctx?: { handoffFile?: string | null }): string[] {
    // The lock extension writes the session the TUI ends on to HERDR_CHAT_HANDOFF (a fork, a /resume).
    const env = ctx?.handoffFile ? ["env", `HERDR_CHAT_HANDOFF=${ctx.handoffFile}`] : [];
    return [...env, this.opts.command, "--session", session];
  }

  tuiCommands(): { name: string; description: string }[] {
    return [
      { name: "tree", description: "Browse the session tree" },
      { name: "export", description: "Export the session" },
      { name: "hotkeys", description: "Show Pi's hotkeys" },
    ];
  }
  readonly unsentMessageCause = "Started by an extension message.";

  /** /login, /settings and /scoped-models run in Pi's TUI with no session. */
  utilityCommand(name: string): string[] | null {
    return ["login", "settings", "scoped-models"].includes(name) ? [this.opts.command, "--no-session"] : null;
  }

  /** Pi's TUI has a command for each utility: typed, it opens that screen. */
  tuiInput(name: string): string | null {
    return ["login", "settings", "scoped-models"].includes(name) ? `/${name}` : null;
  }

  async setModel(provider: string, id: string): Promise<void> {
    const m = (await this.require().request("set_model", { provider, modelId: id }, 30_000)) as Rec;
    const model = mapModel(m);
    if (model) this.emitModel(model);
    await this.refreshState();
  }

  async setThinking(level: string): Promise<void> {
    await this.require().request("set_thinking_level", { level }, 15_000);
    this.emit({ type: "thinking", level });
    await this.refreshState();
  }

  async setPermissionMode(): Promise<void> {
    throw new Error("Pi has no permission modes");
  }

  async compact(instructions?: string): Promise<void> {
    await this.require().request("compact", instructions ? { customInstructions: instructions } : {}, 0);
  }

  private async afterSessionChange(): Promise<void> {
    this.applyState((await this.require().request("get_state", {}, 15_000)) as Rec);
  }

  async newSession(): Promise<void> {
    const d = (await this.require().request("new_session", {}, 30_000)) as Rec;
    if (d?.cancelled) throw new Error("An extension cancelled the new session");
    await this.afterSessionChange();
  }

  async switchSession(path: string): Promise<void> {
    const d = (await this.require().request("switch_session", { sessionPath: path }, 30_000)) as Rec;
    if (d?.cancelled) throw new Error("An extension cancelled the switch");
    await this.afterSessionChange();
  }

  async setName(name: string): Promise<void> {
    await this.require().request("set_session_name", { name }, 15_000);
    this.emit({ type: "session", name: name || null });
  }

  async forkPoints(): Promise<ForkPoint[]> {
    const d = (await this.require().request("get_fork_messages", {}, 15_000)) as Rec;
    const list: Rec[] = Array.isArray(d?.messages) ? d.messages : [];
    return list.filter((m) => typeof m?.entryId === "string").map((m) => ({ id: m.entryId, text: String(m.text ?? "") }));
  }

  /** Pi's own fork: a new session file up to that entry; Pi switches to it. */
  async fork(point: string): Promise<{ text: string }> {
    const d = (await this.require().request("fork", { entryId: point }, 30_000)) as Rec;
    if (d?.cancelled) throw new Error("An extension cancelled the fork");
    await this.afterSessionChange();
    return { text: String(d?.text ?? "") };
  }
}
