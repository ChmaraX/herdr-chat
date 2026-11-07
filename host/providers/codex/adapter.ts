// Codex as a provider: `codex app-server` (JSON-RPC over stdio), one server per
// chat. Threads are sessions, turns are runs, items are messages and tools
// (docs/dev/research/provider-codex.md). Items go through the pure mapper in
// map.ts, live and in history alike; this file owns the run lifecycle (turns,
// steers, the follow-up queue, interrupt), asks (approvals, questions, MCP
// elicitations), settings (model, effort, permission presets, plan mode),
// sessions, and the settle fallback and stall watchdog.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { CodexProcess, CodexRpcError } from "./rpc.ts";
import type { RequestId } from "./rpc.ts";
import { CodexMapper, userContent } from "./map.ts";
import type { TokenUsage } from "./map.ts";
import { stripAnsi } from "../../ansi.ts";
import { AgentError } from "../types.ts";
import { CODEX_TOOLS } from "./tools.ts";
import { mcpFailureNotice } from "../mcp.ts";
import { agentEnv } from "../env.ts";
import type { McpFailure } from "../mcp.ts";
import type {
  ProviderAdapter, AdapterHost, AdapterOptions, Capabilities, StartInfo, NormalizedEvent, AskAnswer, ImageBlock, Ask,
  ModelInfo, AgentCommand, AgentModel, SessionInfo, UsageInfo, PromptMode, Disposition, PermissionMode, PermissionChoice, Question, ForkPoint,
} from "../types.ts";

type Rec = Record<string, any>;

const CLIENT_NAME = "herdr_chat";
const CLIENT_VERSION = "0.1.0";
/** Oldest app-server this adapter is written against (turn/start replies name real turns from 0.148). */
const MIN_VERSION = "0.148.0";
/** Thread config: the todo-list tool is off unless asked for. */
const THREAD_CONFIG = { "tools.update_plan.enabled": true };
const HISTORY_TURNS = 200;
const PAGE = 25;

export const CODEX_PERMISSION_MODES: PermissionMode[] = [
  { id: "untrusted", label: "Ask first", description: "Asks before running any command that isn't known to be safe; edits stay in the workspace" },
  { id: "read-only", label: "Read only", description: "Reads files; asks before editing or running anything else" },
  { id: "auto", label: "Auto", description: "Edits files and runs commands in the workspace; asks before going outside it" },
  { id: "auto-review", label: "Auto-review", description: "Like Auto, but a reviewer agent answers the approval requests" },
  { id: "full", label: "Full access", description: "No sandbox and no approvals" },
  { id: "plan", label: "Plan", description: "Plan mode: Codex asks questions and proposes a plan instead of making changes" },
];

type Preset = { approvalPolicy: string; sandbox: "readOnly" | "workspaceWrite" | "dangerFullAccess"; reviewer: string; plan?: boolean };
const PRESETS: Record<string, Preset> = {
  untrusted: { approvalPolicy: "untrusted", sandbox: "workspaceWrite", reviewer: "user" },
  "read-only": { approvalPolicy: "on-request", sandbox: "readOnly", reviewer: "user" },
  auto: { approvalPolicy: "on-request", sandbox: "workspaceWrite", reviewer: "user" },
  "auto-review": { approvalPolicy: "on-request", sandbox: "workspaceWrite", reviewer: "auto_review" },
  full: { approvalPolicy: "never", sandbox: "dangerFullAccess", reviewer: "user" },
  plan: { approvalPolicy: "on-request", sandbox: "readOnly", reviewer: "user", plan: true },
};

type Settings = {
  model: string | null;
  modelProvider: string;
  effort: string | null;
  summary: string | null;
  approvalPolicy: unknown;
  approvalsReviewer: string;
  sandboxPolicy: Rec | null;
  collaborationMode: string;
};

type OpenAsk = { rpcId: RequestId; method: string; params: Rec; decisions?: Map<string, unknown>; fields?: Rec };

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.jsonl)?$/i;

/** A session reference (a rollout file `rollout-<ts>-<uuid>.jsonl`, or a bare thread id) → the thread id. */
export function threadIdOf(session: string): string | null {
  return UUID.exec(basename(session))?.[1] ?? null;
}

export function versionAtLeast(v: string, min: string): boolean {
  const a = v.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const b = min.split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
}

/** The preset a thread's settings match, else null. */
export function presetOf(s: Pick<Settings, "approvalPolicy" | "approvalsReviewer" | "sandboxPolicy" | "collaborationMode">): string | null {
  if (s.collaborationMode === "plan") return "plan";
  const sandbox = s.sandboxPolicy?.type;
  for (const [id, p] of Object.entries(PRESETS)) {
    if (p.plan) continue;
    if (p.approvalPolicy === s.approvalPolicy && p.sandbox === sandbox && p.reviewer === (s.approvalsReviewer ?? "user")) return id;
  }
  return null;
}

function policyLabel(s: Settings): string {
  const policy = typeof s.approvalPolicy === "string" ? s.approvalPolicy : "granular";
  const sandbox = String(s.sandboxPolicy?.type ?? "?").replace(/([A-Z])/g, " $1").toLowerCase();
  return `${policy} · ${sandbox}${s.approvalsReviewer && s.approvalsReviewer !== "user" ? ` · ${s.approvalsReviewer}` : ""}`;
}

const IMAGE_EXT: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const MIME_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/gif": "gif", "image/webp": "webp" };

/** A local image file for the core to show (bounded). */
export function readImageFile(path: string): ImageBlock | null {
  const mimeType = IMAGE_EXT[extname(path).toLowerCase()];
  if (!mimeType) return null;
  try {
    if (statSync(path).size > 16 * 1024 * 1024) return null;
    return { data: readFileSync(path).toString("base64"), mimeType };
  } catch {
    return null;
  }
}

function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

/** `~/.codex/prompts/*.md`: custom prompts, expanded by the client. */
function readPrompts(): { name: string; description: string; body: string }[] {
  const dir = join(codexHome(), "prompts");
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".md"));
  } catch {
    return [];
  }
  const out: { name: string; description: string; body: string }[] = [];
  for (const n of names.slice(0, 200)) {
    try {
      let body = readFileSync(join(dir, n), "utf8");
      let description = "";
      const fm = /^---\n([\s\S]*?)\n---\n?/.exec(body);
      if (fm) {
        description = /^description:\s*(.*)$/m.exec(fm[1]!)?.[1]?.replace(/^["']|["']$/g, "") ?? "";
        body = body.slice(fm[0].length);
      }
      out.push({ name: n.slice(0, -3), description: description || "Custom prompt", body });
    } catch {}
  }
  return out;
}

/** `$ARGUMENTS` and `$1`…`$9` in a custom prompt. */
export function expandPrompt(body: string, rest: string): string {
  const args = rest.match(/"[^"]*"|'[^']*'|\S+/g)?.map((a) => a.replace(/^["']|["']$/g, "")) ?? [];
  return body.replace(/\$ARGUMENTS/g, rest).replace(/\$([1-9])/g, (_, d) => args[Number(d) - 1] ?? "");
}

export class CodexAdapter implements ProviderAdapter {
  readonly id = "codex";
  readonly name = "Codex";
  readonly tools = CODEX_TOOLS;
  readonly capabilities: Capabilities = {
    steer: true, followUp: true, thinkingLevels: [], permissions: true, permissionModes: CODEX_PERMISSION_MODES,
    extensionUi: false, compact: true, compactInstructions: false, rename: true, fork: true, images: true, cost: false, tui: true,
  };
  private opts: AdapterOptions;
  private proc: CodexProcess | null = null;
  private host: AdapterHost | null = null;
  private mapper: CodexMapper;

  private thread: string | null = null;
  private threadFile: string | null = null;
  /** The thread has no turn yet: no rollout on disk, nothing to resume or list. */
  private fresh = true;
  private settings: Settings = { model: null, modelProvider: "openai", effort: null, summary: null, approvalPolicy: null, approvalsReviewer: "user", sandboxPolicy: null, collaborationMode: "default" };
  /** Last-seen sandbox policy objects by type, so switching presets keeps the user's roots and network setting. */
  private sandboxSeen = new Map<string, Rec>();
  /** Overrides for the next turn/start, when thread/settings/update isn't available. */
  private turnOverrides: Rec = {};
  private models: Rec[] = [];
  private modelsLoaded: Promise<void> = Promise.resolve();
  private skills: { name: string; path: string; description: string }[] = [];
  private emittedModel = "";

  // ---- run state
  private runOpen = false;
  private activeTurn: string | null = null;
  private turnStarting: Promise<unknown> | null = null;
  private aborting = false;
  private interruptPending = false;
  private steering: { text: string; clientId: string }[] = [];
  private followUps: { id: string; text: string; images: ImageBlock[] }[] = [];
  private retryAttempt = 0;
  private compacting: { resolve: () => void; reject: (e: Error) => void; turn: string | null; ended: boolean } | null = null;

  // ---- asks
  private asks = new Map<string, OpenAsk>();

  // ---- watchdog
  private lastActivity = Date.now();
  private watchdog: NodeJS.Timeout | null = null;
  private stallNoticed = false;
  private probing = false;
  private lastProbe = 0;
  private idleSeenAt = 0;
  private noticedOnce = new Set<string>();
  /** MCP startup of this app-server: each server's state, the failures not yet shown. */
  private mcp = { states: new Map<string, string>(), failed: [] as McpFailure[], timer: null as NodeJS.Timeout | null };
  private stderrNoticeTurn: string | null = null;

  constructor(opts: AdapterOptions) {
    this.opts = opts;
    this.mapper = new CodexMapper({ model: () => this.modelRef(), readImage: readImageFile });
  }

  get alive(): boolean {
    return !!this.proc && !this.proc.exited;
  }

  private emit(ev: NormalizedEvent): void {
    this.host?.emit(ev);
  }

  private emitAll(evs: NormalizedEvent[]): void {
    for (const e of evs) this.emit(e);
  }

  private require(): CodexProcess {
    if (!this.proc || this.proc.exited) throw new AgentError("Codex is not running. Use /reload to restart it.");
    return this.proc;
  }

  private requireThread(): string {
    if (!this.thread) throw new AgentError("Codex has no thread open. Use /reload to restart it.");
    return this.thread;
  }

  private modelRef(): string | undefined {
    return this.settings.model ? `${this.settings.modelProvider || "openai"}/${this.settings.model}` : undefined;
  }

  private stallMs(): number {
    const v = Number(process.env.HERDR_CHAT_CODEX_STALL_MS);
    return Number.isFinite(v) && v > 0 ? v : 120_000;
  }

  // ---------------------------------------------------------------- lifecycle

  async start(session: string | null, host: AdapterHost): Promise<StartInfo> {
    this.host = host;
    this.resetRun();
    this.asks.clear();
    const args = ["-c", "notify=[]", ...this.opts.args, "app-server"];
    host.log(`spawn ${this.opts.command} ${args.join(" ")}`);
    const proc = new CodexProcess({ command: this.opts.command, args, cwd: this.opts.cwd, env: agentEnv() });
    this.proc = proc;
    this.flushMcp();
    this.mcp.states.clear();
    proc.onNotification = (m, p) => this.proc === proc && this.onNotification(m, p);
    proc.onServerRequest = (id, m, p) => this.proc === proc && this.onServerRequest(id, m, p);
    proc.onStderrLine = (line) => this.proc === proc && this.onStderr(line);
    proc.onBadLine = (line) => host.log(`codex stdout (not JSON-RPC): ${line.slice(0, 200)}`);
    proc.onOversized = (o) => {
      if (this.proc !== proc) return;
      host.log(`dropped an oversized Codex record (${o.size} bytes): ${o.head.slice(0, 120)}`);
      this.emit({ type: "notice", level: "warning", source: "host", text: `Codex sent an update too large to show (${(o.size / 1048576).toFixed(1)} MiB), so part of this turn is missing here.`, once: "run" });
    };
    proc.onExit = (info) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.stopWatchdog();
      this.resetRun();
      host.emit({
        type: "exited", code: info.code, signal: info.signal, stderrTail: info.stderr,
        ...(info.spawnError ? { spawnError: info.spawnError } : {}), command: this.opts.command,
      });
    };

    const init = await proc.request("initialize", { clientInfo: { name: CLIENT_NAME, title: "Herdr chat", version: CLIENT_VERSION }, capabilities: { experimentalApi: true } }, 30_000);
    const version = /^[^/\s]+\/(\d+\.\d+\.\d+[\w.-]*)/.exec(str(init?.userAgent) ?? "")?.[1] ?? null;
    host.emit({ type: "version", version });
    if (version && !versionAtLeast(version, MIN_VERSION)) {
      host.emit({ type: "notice", level: "warning", source: "host", text: `Codex ${version} is older than ${MIN_VERSION}; the chat needs Codex ${MIN_VERSION} or newer.` });
    }
    proc.notify("initialized");
    this.modelsLoaded = proc
      .request("model/list", { includeHidden: true }, 30_000)
      .then((r) => {
        this.models = Array.isArray(r?.data) ? r.data : [];
        this.emitModel();
      })
      .catch((e) => host.log(`model/list failed: ${errText(e)}`));
    const resumed = await this.openThread(session);
    await Promise.race([this.modelsLoaded, new Promise((r) => setTimeout(r, 5000))]);
    this.emitModel();
    this.startWatchdog();
    return { streaming: false, hasHistory: resumed };
  }

  /** Opens `session` (resume) or a new thread. Returns whether a thread was resumed. */
  private async openThread(session: string | null): Promise<boolean> {
    const proc = this.require();
    const id = session ? threadIdOf(session) : null;
    if (session && !id) this.emit({ type: "notice", level: "warning", source: "host", text: `"${session}" is not a Codex session; starting a new one.` });
    if (id) {
      const params: Rec = { threadId: id, excludeTurns: true, cwd: this.opts.cwd, config: THREAD_CONFIG };
      if (session && session.endsWith(".jsonl") && existsSync(session)) params.path = session;
      try {
        const r = await this.resumeThread(params);
        this.applyThread(r, true);
        return true;
      } catch (e) {
        const msg = errText(e);
        if (/active writer/i.test(msg)) {
          throw new AgentError(`This Codex session is open in another Codex process ("active writer"). Close it there, or if you just left the terminal UI wait about a minute, then use /reload.`, false, true);
        }
        if (!/no rollout|not found|does not exist|unknown thread|invalid thread/i.test(msg)) throw e;
        this.emit({ type: "notice", level: "warning", source: "host", text: `Could not resume the Codex session (${msg}); started a new one.` });
      }
    }
    const r = await proc.request("thread/start", { cwd: this.opts.cwd, config: THREAD_CONFIG }, 60_000);
    this.applyThread(r, false);
    return false;
  }

  private async resumeThread(params: Rec): Promise<Rec> {
    const proc = this.require();
    try {
      return await proc.request("thread/resume", params, 60_000);
    } catch (e) {
      if (!/archived/i.test(errText(e))) throw e;
      await proc.request("thread/unarchive", { threadId: params.threadId }, 30_000);
      return proc.request("thread/resume", params, 60_000);
    }
  }

  /** A thread/start or thread/resume reply → session, model, thinking and mode events. */
  private applyThread(r: Rec, resumed: boolean): void {
    const t: Rec = r?.thread ?? {};
    const old = this.thread;
    this.thread = str(t.id) ?? null;
    this.mapper.reset(this.thread);
    this.fresh = !resumed;
    this.threadFile = str(t.path) ?? null;
    // A new thread's rollout is written at its first turn; until then there is nothing to resume.
    this.emit({ type: "session", id: this.thread, file: resumed ? this.threadFile ?? this.thread : null, name: str(t.name) || null });
    if (old && old !== this.thread) this.proc?.request("thread/unsubscribe", { threadId: old }, 10_000).catch(() => {});
    this.applySettings({
      model: str(r.model) ?? str(t.model) ?? null,
      modelProvider: str(r.modelProvider) ?? str(t.modelProvider) ?? "openai",
      effort: str(r.reasoningEffort) ?? str(t.reasoningEffort) ?? null,
      approvalPolicy: r.approvalPolicy ?? null,
      approvalsReviewer: str(r.approvalsReviewer) ?? "user",
      sandboxPolicy: r.sandbox && typeof r.sandbox === "object" ? r.sandbox : null,
      collaborationMode: str(r.collaborationMode?.mode) ?? "default",
    });
  }

  private applySettings(patch: Partial<Settings>): void {
    const s = (this.settings = { ...this.settings, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as Settings);
    if (s.sandboxPolicy?.type) this.sandboxSeen.set(s.sandboxPolicy.type, s.sandboxPolicy);
    this.emitModel();
    const mode = presetOf(s);
    if (mode) {
      this.emit({ type: "capabilities", capabilities: { permissionModes: CODEX_PERMISSION_MODES } });
      this.emit({ type: "permission_mode", mode });
    } else if (s.approvalPolicy !== null) {
      // The user's own combination (config.toml): show it as it is.
      this.emit({ type: "capabilities", capabilities: { permissionModes: [...CODEX_PERMISSION_MODES, { id: "custom", label: policyLabel(s), description: "Your Codex configuration" }] } });
      this.emit({ type: "permission_mode", mode: "custom" });
    }
  }

  private modelInfo(id: string | null): Rec | undefined {
    return id ? this.models.find((m) => m.id === id || m.model === id) : undefined;
  }

  private emitModel(): void {
    const id = this.settings.model;
    if (!id) return;
    const m = this.modelInfo(id);
    const usage = this.thread ? this.mapper.usage.get(this.thread) : undefined;
    const efforts: string[] = Array.isArray(m?.supportedReasoningEfforts) ? m!.supportedReasoningEfforts.map((e: Rec) => String(e.reasoningEffort)) : [];
    const info: ModelInfo = {
      provider: this.settings.modelProvider || "openai", id, name: str(m?.displayName) ?? id, reasoning: true,
      contextWindow: num(usage?.modelContextWindow) ?? null, input: Array.isArray(m?.inputModalities) ? m!.inputModalities.map(String) : ["text", "image"],
    };
    const effort = this.settings.effort ?? str(m?.defaultReasoningEffort) ?? null;
    const key = JSON.stringify([info, efforts, effort]);
    if (key === this.emittedModel) return;
    this.emittedModel = key;
    this.emit({ type: "model", model: info });
    this.emit({ type: "capabilities", capabilities: { thinkingLevels: efforts.length ? efforts : effort ? [effort] : [], images: info.input.includes("image") } });
    if (effort) this.emit({ type: "thinking", level: effort });
  }

  watchRun(): void {
    this.runOpen = true;
    this.lastActivity = Date.now();
  }

  async dispose(): Promise<void> {
    const p = this.proc;
    this.stopWatchdog();
    if (this.mcp.timer) clearTimeout(this.mcp.timer);
    if (!p) return;
    this.proc = null;
    this.resetRun();
    await p.stop();
  }

  kill(): void {
    this.proc?.killNow();
  }

  private resetRun(): void {
    this.runOpen = false;
    this.activeTurn = null;
    this.turnStarting = null;
    this.aborting = false;
    this.interruptPending = false;
    this.steering = [];
    this.followUps = [];
    this.retryAttempt = 0;
    if (this.compacting) this.compacting.reject(new Error("Codex stopped"));
    this.compacting = null;
  }

  // ---------------------------------------------------------------- notifications

  private ownThread(p: Rec): boolean {
    const t = str(p.threadId);
    return !t || t === this.thread;
  }

  private onNotification(method: string, p: Rec): void {
    const mine = this.ownThread(p);
    const known = mine || this.mapper.isChild(str(p.threadId));
    if (known && !method.startsWith("account/") && method !== "mcpServer/startupStatus/updated") {
      this.lastActivity = Date.now();
      this.emit({ type: "heartbeat" });
    }
    switch (method) {
      case "turn/started":
        if (mine) this.onTurnStarted(p.turn ?? {});
        return;
      case "turn/completed":
        if (mine) this.onTurnCompleted(p.turn ?? {});
        else if (known) this.emitAll(this.mapper.turnCompleted(String(p.threadId), p.turn ?? {}));
        return;
      case "thread/status/changed":
        if (mine && p.status?.type === "idle" && (this.activeTurn || this.runOpen)) this.idleSeenAt = Date.now();
        return;
      case "thread/started":
        if (str(p.thread?.id) === this.thread && p.thread?.name !== undefined) this.emit({ type: "session", name: str(p.thread.name) || null });
        return;
      case "thread/name/updated":
        if (mine) this.emit({ type: "session", name: str(p.threadName) || null });
        return;
      case "thread/settings/updated":
        if (mine && p.threadSettings) {
          const s = p.threadSettings;
          this.applySettings({
            model: str(s.model), modelProvider: str(s.modelProvider), effort: str(s.effort) ?? undefined, summary: s.summary ?? null,
            approvalPolicy: s.approvalPolicy, approvalsReviewer: str(s.approvalsReviewer), sandboxPolicy: s.sandboxPolicy ?? undefined,
            collaborationMode: str(s.collaborationMode?.mode),
          });
        }
        return;
      case "thread/tokenUsage/updated":
        if (!known) return;
        this.mapper.notification(method, p);
        if (mine) {
          this.emitModel(); // the context window becomes known
          this.emit({ type: "turn_end" });
        }
        return;
      case "serverRequest/resolved": {
        const id = String(p.requestId);
        if (this.asks.delete(id)) this.emit({ type: "ask_closed", id });
        return;
      }
      case "error": {
        if (!known) return;
        const msg = str(p.error?.message) ?? "Codex reported an error";
        const details = str(p.error?.additionalDetails);
        if (p.willRetry) {
          this.retryAttempt++;
          this.emit({ type: "retry", phase: "start", attempt: this.retryAttempt, maxAttempts: null, delayMs: 0, error: details ? `${msg} (${details})` : msg });
        } else if (!this.activeTurn) {
          this.emit({ type: "notice", level: "error", source: "host", text: `Codex: ${msg}` });
        }
        return;
      }
      case "warning":
        if (p.threadId == null || mine) this.emit({ type: "notice", level: "warning", source: "notify", text: String(p.message ?? "") });
        return;
      case "configWarning":
      case "deprecationNotice":
        this.noticeOnce(`${method}:${p.summary}`, "warning", `${p.summary ?? ""}${p.details ? `: ${p.details}` : ""}`);
        return;
      case "model/rerouted":
        if (mine) this.emit({ type: "notice", level: "info", source: "notify", text: `Codex switched from ${p.fromModel} to ${p.toModel}${p.reason ? ` (${typeof p.reason === "string" ? p.reason : JSON.stringify(p.reason)})` : ""}.` });
        return;
      case "modelProvider/authRecoveryStarted":
        this.emit({ type: "notice", level: "warning", source: "notify", text: "Codex is refreshing its sign-in…" });
        return;
      case "mcpServer/startupStatus/updated":
        this.onMcpStatus(p);
        return;
      case "hook/completed": {
        const run = p.run ?? {};
        if (mine && (run.status === "failed" || run.status === "blocked")) {
          this.emit({ type: "notice", level: "warning", source: "notify", text: `Hook ${run.eventName ?? ""} ${run.status}${run.statusMessage ? `: ${run.statusMessage}` : ""}`.replace(/\s+/g, " ") });
        }
        return;
      }
      case "account/rateLimits/updated": {
        const rl = p.rateLimits ?? {};
        const part = (w: Rec | null | undefined) => (w && typeof w.usedPercent === "number" ? `${w.windowDurationMins && w.windowDurationMins <= 600 ? `${Math.round(w.windowDurationMins / 60)}h` : "week"} ${Math.round(w.usedPercent)}%` : null);
        const text = [part(rl.primary), part(rl.secondary)].filter(Boolean).join(" · ");
        if (text) this.emit({ type: "status", key: "codex-limits", text: `limits ${text}` });
        return;
      }
    }
    if (!known) return;
    if (method === "item/started" || method === "item/agentMessage/delta" || method === "item/reasoning/summaryTextDelta") this.endRetry(true);
    const item: Rec | undefined = p.item;
    if (mine && method === "item/completed" && item?.type === "userMessage") this.onUserEcho(item);
    if (method === "item/started" && item?.type === "contextCompaction" && mine && this.compacting) {
      // Our manual compaction: its start is already shown.
      return;
    }
    if (method === "item/completed" && item?.type === "contextCompaction" && mine && this.compacting) {
      this.compacting.ended = true;
      this.emit({ type: "compaction", phase: "end", outcome: "done" });
      return;
    }
    this.emitAll(this.mapper.notification(method, p));
  }

  /** Failures of one start become one notice: shown once no server is still starting (or 5 s after the last failure). */
  private onMcpStatus(p: Rec): void {
    const name = str(p.name);
    if (!name) return;
    this.mcp.states.set(name, String(p.status));
    if (p.status === "failed" && !this.noticedOnce.has(`mcp:${name}`)) {
      this.noticedOnce.add(`mcp:${name}`);
      const detail = str(p.error);
      this.mcp.failed.push({ name, detail, auth: p.failureReason === "reauthenticationRequired" || /\b(OAuth|reauthenticat)/i.test(detail ?? "") });
    }
    if (!this.mcp.failed.length) return;
    if (![...this.mcp.states.values()].includes("starting")) return this.flushMcp();
    if (this.mcp.timer) clearTimeout(this.mcp.timer);
    this.mcp.timer = setTimeout(() => this.flushMcp(), 5000);
  }

  private flushMcp(): void {
    if (this.mcp.timer) clearTimeout(this.mcp.timer);
    this.mcp.timer = null;
    const failed = this.mcp.failed.splice(0);
    if (failed.length) this.emit({ type: "notice", level: "warning", source: "notify", text: mcpFailureNotice(failed, "codex mcp login <name>") });
  }

  private noticeOnce(key: string, level: "info" | "warning" | "error", text: string): void {
    if (this.noticedOnce.has(key)) return;
    this.noticedOnce.add(key);
    this.emit({ type: "notice", level, source: "notify", text });
  }

  private onStderr(line: string): void {
    const plain = stripAnsi(line).trim();
    this.host?.log(`codex stderr: ${plain.slice(0, 500)}`);
    // Tool-router failures leave no item at all (a failed code-mode host): say so once per turn.
    if (/\bERROR\b/.test(plain) && /codex_core::tools|code-mode host/.test(plain) && this.activeTurn && this.stderrNoticeTurn !== this.activeTurn) {
      if (/rejected by user/i.test(plain)) return;
      this.stderrNoticeTurn = this.activeTurn;
      const msg = plain.replace(/^.*?ERROR\s+\S+:\s*/, "").replace(/^error=/, "");
      this.emit({ type: "notice", level: "warning", source: "notify", text: `Codex tool error: ${msg.slice(0, 400)}` });
    }
  }

  private endRetry(success: boolean, error?: string): void {
    if (!this.retryAttempt) return;
    this.emit({ type: "retry", phase: "end", success, attempt: this.retryAttempt, ...(error ? { error } : {}) });
    this.retryAttempt = 0;
  }

  private onTurnStarted(turn: Rec): void {
    const id = str(turn.id) ?? null;
    if (this.compacting && !this.turnStarting && !this.activeTurn) {
      this.compacting.turn = id;
      return;
    }
    this.activeTurn = id;
    this.idleSeenAt = 0;
    this.stallNoticed = false;
    if (this.fresh) {
      // The rollout exists from the first turn on: now the session can be resumed and locked.
      this.fresh = false;
      this.emit({ type: "session", file: this.threadFile ?? this.thread });
    }
    if (!this.runOpen) {
      this.runOpen = true;
      this.emit({ type: "run_started" });
    }
    if (this.interruptPending && id) {
      this.interruptPending = false;
      this.interrupt(id);
    }
  }

  private onTurnCompleted(turn: Rec): void {
    const id = str(turn.id) ?? null;
    const status = str(turn.status);
    if (this.compacting && (id === this.compacting.turn || (!this.activeTurn && !this.runOpen))) {
      const c = this.compacting;
      this.compacting = null;
      if (status === "failed") {
        const error = str(turn.error?.message) ?? "compaction failed";
        this.emit({ type: "compaction", phase: "end", outcome: "failed", error });
        c.reject(new Error(error));
      } else {
        if (!c.ended) this.emit({ type: "compaction", phase: "end", outcome: status === "interrupted" ? "aborted" : "done" });
        c.resolve();
      }
      this.drainFollowUp();
      return;
    }
    this.idleSeenAt = 0;
    if (this.thread) this.emitAll(this.mapper.turnCompleted(this.thread, turn));
    if (status === "failed") this.endRetry(false, str(turn.error?.message));
    else this.endRetry(true);
    this.activeTurn = null;
    if (this.steering.length) {
      this.host?.log(`turn ${id} ended with ${this.steering.length} steer(s) not echoed`);
      this.steering = [];
      this.emitQueue();
    }
    const aborted = status === "interrupted" || this.aborting;
    if (aborted) {
      this.proc?.request("thread/backgroundTerminals/clean", { threadId: this.thread }, 10_000).catch(() => {});
    }
    if (!aborted && this.drainFollowUp()) return;
    this.settle(aborted);
  }

  private settle(aborted: boolean): void {
    this.aborting = false;
    this.interruptPending = false;
    this.activeTurn = null;
    this.idleSeenAt = 0;
    if (!this.runOpen && !this.host?.running && !this.host?.working) return;
    this.runOpen = false;
    this.emit({ type: "run_settled", aborted });
  }

  /** Starts the next queued follow-up as a new turn in the same run. */
  private drainFollowUp(): boolean {
    const next = this.followUps.shift();
    if (!next) return false;
    this.emitQueue();
    this.sendTurn(next.text, next.images, next.id).catch((e) => {
      this.emit({ type: "notice", level: "error", source: "queue", text: `Codex rejected a queued message: ${errText(e)}` });
      this.settle(false);
    });
    return true;
  }

  private onUserEcho(item: Rec): void {
    const clientId = str(item.clientId);
    const i = clientId ? this.steering.findIndex((s) => s.clientId === clientId) : -1;
    if (i < 0) return;
    this.steering.splice(i, 1);
    this.emitQueue();
  }

  private emitQueue(): void {
    this.emit({
      type: "queue_changed", steering: this.steering.map((s) => s.text), followUp: this.followUps.map((f) => f.text),
      steeringIds: this.steering.map((s) => s.clientId), followUpIds: this.followUps.map((f) => f.id),
    });
  }

  // ---------------------------------------------------------------- asks

  private onServerRequest(id: RequestId, method: string, p: Rec): void {
    const proc = this.proc;
    if (!proc) return;
    this.lastActivity = Date.now();
    this.emit({ type: "heartbeat" });
    const askId = String(id);
    const open: OpenAsk = { rpcId: id, method, params: p };
    let ask: Ask | null = null;
    switch (method) {
      case "item/commandExecution/requestApproval": {
        const { choices, decisions } = this.commandChoices(p.availableDecisions);
        open.decisions = decisions;
        const stdin = p.kind === "writeStdin";
        const net = p.networkApprovalContext;
        const command = str(p.command) ?? (this.mapper.openToolArgs(String(p.itemId))?.args as Rec | undefined)?.command ?? "";
        ask = {
          id: askId, kind: "permission",
          title: stdin ? "Send input to the running command?" : net ? "Allow network access?" : "Run this command?",
          ...(str(p.reason) ? { message: p.reason } : net?.host ? { message: `Network access to ${net.host}` } : {}),
          tool: { name: "commandExecution", args: { command, ...(p.cwd ? { cwd: p.cwd } : {}) }, callId: String(p.itemId) },
          choices,
        };
        break;
      }
      case "item/fileChange/requestApproval": {
        const decisions = new Map<string, unknown>([["accept", "accept"], ["acceptForSession", "acceptForSession"], ["decline", "decline"], ["cancel", "cancel"]]);
        open.decisions = decisions;
        const pending = this.mapper.openToolArgs(String(p.itemId));
        const msg = [str(p.reason), p.grantRoot ? `Codex also asks to write under ${p.grantRoot} for the rest of this session.` : undefined].filter(Boolean).join("\n");
        ask = {
          id: askId, kind: "permission", title: "Apply this change?", ...(msg ? { message: msg } : {}),
          tool: { name: "fileChange", args: pending?.args ?? { changes: [] }, callId: String(p.itemId) },
          choices: [
            { id: "accept", label: "Allow once", kind: "allow" },
            { id: "acceptForSession", label: "Always allow (this session)", kind: "allow_always" },
            { id: "decline", label: "Deny", kind: "deny", description: "Codex continues without it" },
            { id: "cancel", label: "Deny and stop", kind: "deny", description: "Stops the turn" },
          ],
        };
        break;
      }
      case "item/permissions/requestApproval": {
        const perms: Rec = p.permissions ?? {};
        const lines: string[] = [];
        if (perms.network?.enabled) lines.push("Network access");
        const fs: Rec = perms.fileSystem ?? {};
        if (Array.isArray(fs.read) && fs.read.length) lines.push(`Read: ${fs.read.join(", ")}`);
        if (Array.isArray(fs.write) && fs.write.length) lines.push(`Write: ${fs.write.join(", ")}`);
        if (Array.isArray(fs.entries) && fs.entries.length) lines.push(`Files: ${fs.entries.length} entries`);
        const msg = [str(p.reason), ...lines].filter(Boolean).join("\n");
        ask = {
          id: askId, kind: "permission", title: "Grant Codex more permissions?", ...(msg ? { message: msg } : {}),
          choices: [
            { id: "turn", label: "Allow for this turn", kind: "allow" },
            { id: "session", label: "Allow for this session", kind: "allow_always" },
            { id: "deny", label: "Deny", kind: "deny" },
          ],
        };
        break;
      }
      case "item/tool/requestUserInput":
      case "tool/requestUserInput": {
        const qs: Rec[] = Array.isArray(p.questions) ? p.questions : [];
        const questions: Question[] = qs.map((q, i) => ({
          id: str(q.id) ?? `q${i}`, ...(str(q.header) ? { header: q.header } : {}), question: str(q.question) ?? "",
          options: (Array.isArray(q.options) ? q.options : []).map((o: Rec) => ({ label: String(o?.label ?? ""), ...(str(o?.description) ? { description: o.description } : {}) })),
          multiSelect: false, allowOther: q.isOther === true || !Array.isArray(q.options) || !q.options.length,
        }));
        ask = { id: askId, kind: "questions", title: questions.length === 1 ? questions[0]!.header || "Codex has a question" : "Codex has some questions", questions };
        break;
      }
      case "mcpServer/elicitation/request":
        ask = this.elicitationAsk(askId, p, open);
        if (!ask) return;
        break;
      default:
        proc.respondError(id, -32601, `${method} is not supported by this client`);
        return;
    }
    this.asks.set(askId, open);
    this.emit({ type: "ask", ask });
  }

  /** `availableDecisions` → the card's buttons (only what Codex offers, plus a plain deny). */
  private commandChoices(available: unknown): { choices: PermissionChoice[]; decisions: Map<string, unknown> } {
    const list: unknown[] = Array.isArray(available) && available.length ? available : ["accept", "acceptForSession", "decline", "cancel"];
    const choices: PermissionChoice[] = [];
    const decisions = new Map<string, unknown>();
    const add = (c: PermissionChoice, d: unknown) => {
      choices.push(c);
      decisions.set(c.id, d);
    };
    list.forEach((d, i) => {
      if (d === "accept") add({ id: "accept", label: "Allow once", kind: "allow" }, d);
      else if (d === "acceptForSession") add({ id: "acceptForSession", label: "Always allow (this session)", kind: "allow_always" }, d);
      else if (d === "decline") add({ id: "decline", label: "Deny", kind: "deny", description: "Codex continues without it" }, d);
      else if (d === "cancel") {
        if (!decisions.has("decline")) add({ id: "decline", label: "Deny", kind: "deny", description: "Codex continues without it" }, "decline");
        add({ id: "cancel", label: "Deny and stop", kind: "deny", description: "Stops the turn" }, d);
      } else if (d && typeof d === "object") {
        const o = d as Rec;
        if (o.acceptWithExecpolicyAmendment) {
          const cmd = o.acceptWithExecpolicyAmendment.execpolicy_amendment;
          const shown = Array.isArray(cmd) ? cmd.join(" ") : "this command";
          add({ id: `amend${i}`, label: `Always allow \`${shown.length > 60 ? shown.slice(0, 59) + "…" : shown}\``, kind: "allow_always", description: "Adds a rule to Codex's exec policy" }, d);
        } else if (o.applyNetworkPolicyAmendment) {
          const a: Rec = o.applyNetworkPolicyAmendment.network_policy_amendment ?? {};
          add({ id: `net${i}`, label: `Always allow ${a.host ?? "this host"}`, kind: "allow_always" }, d);
        }
      }
    });
    if (!decisions.has("decline")) add({ id: "decline", label: "Deny", kind: "deny", description: "Codex continues without it" }, "decline");
    return { choices, decisions };
  }

  /** An MCP elicitation: a form becomes questions, a URL a confirm; anything else is declined. */
  private elicitationAsk(askId: string, p: Rec, open: OpenAsk): Ask | null {
    const server = str(p.serverName) ?? "an MCP server";
    if (p.mode === "url" && str(p.url)) {
      return { id: askId, kind: "confirm", title: `${server}: ${p.message ?? "open this link"}`, message: `Open ${p.url} and finish there, then confirm.` };
    }
    const schema: Rec = p.requestedSchema ?? {};
    const props: Rec = schema.properties && typeof schema.properties === "object" ? schema.properties : null;
    if ((p.mode === "form" || p.mode === "openai/form" || p.mode === "openaiForm") && props) {
      const questions: Question[] = [];
      open.fields = props;
      for (const [key, s] of Object.entries(props) as [string, Rec][]) {
        const enumVals: string[] = Array.isArray(s?.enum) ? s.enum.map(String) : Array.isArray(s?.oneOf) ? s.oneOf.map((o: Rec) => String(o.const)) : [];
        const options = s?.type === "boolean" ? [{ label: "Yes" }, { label: "No" }] : enumVals.map((v) => ({ label: v }));
        questions.push({ id: key, header: str(s?.title) ?? key, question: str(s?.description) ?? str(s?.title) ?? key, options, multiSelect: s?.type === "array", allowOther: !options.length });
      }
      return { id: askId, kind: "questions", title: `${server}: ${p.message ?? "needs input"}`, questions };
    }
    this.proc?.respond(open.rpcId, { action: "decline", content: null, _meta: null });
    this.emit({ type: "notice", level: "warning", source: "notify", text: `${server} asked for something the chat can't show (${p.mode ?? "unknown"}); declined. Use /tui to answer it in Codex.` });
    return null;
  }

  answer(askId: string, a: AskAnswer): void {
    const open = this.asks.get(askId);
    const proc = this.proc;
    if (!open || !proc) return;
    this.asks.delete(askId);
    const cancelled = "cancelled" in a;
    switch (open.method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval": {
        const choice = "choice" in a ? a.choice : null;
        const decision = cancelled ? "cancel" : choice ? open.decisions?.get(choice) ?? "decline" : "decline";
        proc.respond(open.rpcId, { decision });
        // A reason for the deny goes to the model as a steer.
        if ("message" in a && a.message && (decision === "decline") && this.activeTurn) {
          proc.request("turn/steer", { threadId: this.thread, expectedTurnId: this.activeTurn, input: [{ type: "text", text: a.message, text_elements: [] }] }, 30_000).catch(() => {});
        }
        return;
      }
      case "item/permissions/requestApproval": {
        const choice = "choice" in a ? a.choice : "deny";
        const perms: Rec = open.params.permissions ?? {};
        const granted: Rec = {};
        if (perms.network) granted.network = perms.network;
        if (perms.fileSystem) granted.fileSystem = perms.fileSystem;
        if (cancelled || choice === "deny") proc.respond(open.rpcId, { permissions: {}, scope: "turn" });
        else proc.respond(open.rpcId, { permissions: granted, scope: choice === "session" ? "session" : "turn" });
        return;
      }
      case "item/tool/requestUserInput":
      case "tool/requestUserInput": {
        const answers: Rec = {};
        if ("answers" in a) for (const [k, v] of Object.entries(a.answers)) answers[k] = { answers: Array.isArray(v) ? v : [v] };
        proc.respond(open.rpcId, { answers });
        return;
      }
      case "mcpServer/elicitation/request": {
        if (cancelled) {
          proc.respond(open.rpcId, { action: "cancel", content: null, _meta: null });
          return;
        }
        if ("confirmed" in a) {
          proc.respond(open.rpcId, { action: a.confirmed ? "accept" : "decline", content: null, _meta: null });
          return;
        }
        const content: Rec = {};
        if ("answers" in a) {
          for (const [k, v] of Object.entries(a.answers)) {
            const s: Rec = open.fields?.[k] ?? {};
            const one = Array.isArray(v) ? v[0] ?? "" : v;
            if (s.type === "boolean") content[k] = one === "Yes" || one === "true";
            else if (s.type === "number" || s.type === "integer") content[k] = Number(one);
            else if (s.type === "array") content[k] = Array.isArray(v) ? v : [v];
            else content[k] = one;
          }
        }
        proc.respond(open.rpcId, { action: "accept", content, _meta: null });
        return;
      }
    }
  }

  // ---------------------------------------------------------------- watchdog and settle fallback

  private startWatchdog(): void {
    this.stopWatchdog();
    this.lastActivity = Date.now();
    this.watchdog = setInterval(() => this.tick(), 1000);
    this.watchdog.unref?.();
  }

  private stopWatchdog(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
  }

  private tick(): void {
    const host = this.host;
    if (!host || !this.proc) return;
    const busy = this.runOpen || host.running;
    if (!busy) return;
    const quiet = Date.now() - this.lastActivity;
    // Codex said idle but never completed the turn: settle after a grace period.
    if (this.idleSeenAt && Date.now() - this.idleSeenAt > 2000) {
      this.idleSeenAt = 0;
      void this.probe("thread idle without turn/completed");
      return;
    }
    const probeEvery = Math.min(10_000, this.stallMs());
    if (quiet >= probeEvery && Date.now() - this.lastProbe >= probeEvery && !this.asks.size) void this.probe("quiet");
    if (quiet >= this.stallMs() && !this.stallNoticed && !this.asks.size && !this.mapper.openToolIds.length) {
      this.stallNoticed = true;
      this.emit({ type: "notice", level: "warning", source: "host", text: `Codex has sent nothing for ${Math.round(quiet / 1000)} s. It may be stalled: press Esc to interrupt.`, once: "run" });
    }
  }

  /** Asks Codex whether the thread is still active; settles the run when it isn't. */
  private async probe(why: string): Promise<void> {
    const proc = this.proc;
    if (!proc || !this.thread || this.probing) return;
    this.probing = true;
    this.lastProbe = Date.now();
    const rev = this.lastActivity;
    try {
      const r = await proc.request("thread/read", { threadId: this.thread }, 10_000);
      const status = r?.thread?.status?.type;
      if (rev !== this.lastActivity && why === "quiet") return;
      if (status && status !== "active" && (this.runOpen || this.host?.running)) {
        this.host?.log(`settled by thread/read probe (${why}, status ${status})`);
        if (this.thread) this.emitAll(this.mapper.turnCompleted(this.thread, { status: this.aborting ? "interrupted" : "completed" }));
        const aborted = this.aborting;
        this.steering = [];
        if (!aborted && this.drainFollowUp()) return;
        this.settle(aborted);
      }
    } catch (e) {
      this.host?.log(`thread/read probe failed: ${errText(e)}`);
    } finally {
      this.probing = false;
    }
  }

  // ---------------------------------------------------------------- commands

  /** Text and images → Codex `UserInput[]`; `/skill` and `/prompt` lines are expanded like Codex's TUI. */
  private buildInput(text: string, images: ImageBlock[]): Rec[] {
    let body = text;
    const extra: Rec[] = [];
    const m = /^\/([\w:.-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
    if (m) {
      const skill = this.skills.find((s) => s.name === m[1]);
      const prompt = skill ? null : readPrompts().find((p) => p.name === m[1]);
      if (skill) {
        body = `$${skill.name}${m[2] ? ` ${m[2]}` : ""}`;
        extra.push({ type: "skill", name: skill.name, path: skill.path });
      } else if (prompt) body = expandPrompt(prompt.body, (m[2] ?? "").trim());
    }
    const input: Rec[] = [];
    if (body) input.push({ type: "text", text: body, text_elements: [] });
    input.push(...extra);
    if (images.length) {
      const dir = join(tmpdir(), "herdr-chat-codex-images");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      for (const img of images) {
        const path = join(dir, `${randomUUID()}.${MIME_EXT[img.mimeType.toLowerCase()] ?? "png"}`);
        writeFileSync(path, Buffer.from(img.data, "base64"), { mode: 0o600 });
        input.push({ type: "localImage", path });
      }
    }
    return input;
  }

  /** turn/start; resolves with the turn id once Codex accepted it. `id`: the host's message id, which Codex puts on the echo as `clientId`. */
  private async sendTurn(text: string, images: ImageBlock[], id: string): Promise<string | null> {
    const proc = this.require();
    const threadId = this.requireThread();
    const params: Rec = { threadId, input: this.buildInput(text, images), clientUserMessageId: id, ...this.turnOverrides };
    // Thinking is invisible unless a summary is asked for; ask once (it sticks), unless the user chose one.
    if (!this.settings.summary) params.summary = "auto";
    const p = proc.request("turn/start", params, 60_000);
    this.turnStarting = p;
    try {
      const r = await p;
      this.turnOverrides = {};
      const id = str(r?.turn?.id) ?? null;
      if (id && !this.activeTurn) {
        // The reply can beat turn/started.
        this.activeTurn = id;
        if (this.interruptPending) {
          this.interruptPending = false;
          this.interrupt(id);
        }
      }
      return id;
    } finally {
      if (this.turnStarting === p) this.turnStarting = null;
    }
  }

  async prompt(p: { id: string; text: string; images: ImageBlock[]; mode: PromptMode; busy: boolean }): Promise<{ disposition: Disposition }> {
    this.require();
    if (this.compacting || (p.busy && p.mode === "followUp")) {
      this.followUps.push({ id: p.id, text: p.text, images: p.images });
      this.emitQueue();
      return { disposition: "queued" };
    }
    if (p.busy || this.runOpen) {
      if (this.turnStarting) await this.turnStarting.catch(() => {});
      const turn = this.activeTurn;
      if (turn) {
        const clientId = p.id;
        this.steering.push({ text: p.text, clientId });
        this.emitQueue();
        try {
          await this.require().request("turn/steer", { threadId: this.thread, expectedTurnId: turn, input: this.buildInput(p.text, p.images), clientUserMessageId: clientId }, 30_000);
          return { disposition: "queued" };
        } catch (e) {
          const i = this.steering.findIndex((s) => s.clientId === clientId);
          if (i >= 0) this.steering.splice(i, 1);
          this.emitQueue();
          if (!(e instanceof CodexRpcError) || e.code !== -32600) throw e;
          // The turn just ended: start a new one with it.
          this.host?.log(`turn/steer failed (${e.message}); starting a turn instead`);
          this.emit({ type: "run_cause", text: "Started by a message sent as the last turn ended." });
        }
      } else if (this.runOpen) {
        this.followUps.push({ id: p.id, text: p.text, images: p.images });
        this.emitQueue();
        return { disposition: "queued" };
      }
    }
    await this.sendTurn(p.text, p.images, p.id);
    return { disposition: "started" };
  }

  async clearQueue(): Promise<string[]> {
    // An interrupt drops the steers Codex hasn't taken yet.
    const out = [...this.steering.map((s) => s.text), ...this.followUps.map((f) => f.text)];
    this.steering = [];
    this.followUps = [];
    if (out.length) this.emitQueue();
    return out;
  }

  // A steer went to Codex with turn/steer, which has no way back. A follow-up
  // this adapter holds (one sent while compacting or between turns) can go.
  canRemoveQueued(id: string): boolean {
    return this.followUps.some((f) => f.id === id);
  }

  async removeQueued(id: string): Promise<boolean> {
    const i = this.followUps.findIndex((f) => f.id === id);
    if (i < 0) return false;
    this.followUps.splice(i, 1);
    this.emitQueue();
    return true;
  }

  private interrupt(turnId: string): void {
    this.proc?.request("turn/interrupt", { threadId: this.thread, turnId }, 15_000).catch((e) => this.host?.log(`turn/interrupt failed: ${errText(e)}`));
  }

  abort(): void {
    if (!this.proc) return;
    this.aborting = true;
    if (this.compacting?.turn) {
      this.interrupt(this.compacting.turn);
      return;
    }
    if (this.activeTurn) this.interrupt(this.activeTurn);
    else if (this.turnStarting) this.interruptPending = true;
    else if (this.runOpen || this.host?.working) {
      // Nothing is running on Codex's side: the core is waiting for a turn that won't come.
      void this.probe("abort");
      setTimeout(() => {
        if (this.aborting && !this.activeTurn) this.settle(true);
      }, 1500);
    }
    // Safety net: Codex should complete the turn as interrupted; if it doesn't, ask it.
    setTimeout(() => {
      if (this.aborting && (this.runOpen || this.host?.running)) void this.probe("abort timeout");
    }, 5000);
  }

  // ---------------------------------------------------------------- history

  /** Up to `max` turns of a thread, oldest first; `more` when older ones exist. */
  private async turnsOf(threadId: string, max: number): Promise<{ turns: Rec[]; more: boolean }> {
    const proc = this.require();
    const turns: Rec[] = [];
    let cursor: string | null = null;
    for (;;) {
      const r: Rec = await proc.request("thread/turns/list", { threadId, limit: Math.min(PAGE, max - turns.length), sortDirection: "desc", itemsView: "full", ...(cursor ? { cursor } : {}) }, 60_000);
      const data: Rec[] = Array.isArray(r?.data) ? r.data : [];
      turns.push(...data);
      cursor = str(r?.nextCursor) ?? null;
      if (!cursor || !data.length) return { turns: turns.reverse(), more: false };
      if (turns.length >= max) return { turns: turns.reverse(), more: true };
    }
  }

  async history(): Promise<NormalizedEvent[]> {
    const thread = this.requireThread();
    if (this.fresh) return [];
    const { turns, more } = await this.turnsOf(thread, HISTORY_TURNS);
    const m = new CodexMapper({ history: true, model: () => this.modelRef(), readImage: readImageFile });
    m.reset(thread);
    const out: NormalizedEvent[] = [];
    if (more) out.push({ type: "notice", level: "info", source: "host", text: `Showing the last ${HISTORY_TURNS} turns of this session.`, ts: (num(turns[0]?.startedAt) ?? 0) * 1000 });
    const loaded = new Set<string>();
    const feed = async (threadId: string, turn: Rec): Promise<void> => {
      const t0 = (num(turn.startedAt) ?? Date.now() / 1000) * 1000;
      m.ts = t0;
      const items: Rec[] = Array.isArray(turn.items) ? turn.items : [];
      let children: string[] = [];
      const flush = async () => {
        for (const child of children) {
          try {
            const sub = await this.turnsOf(child, 20);
            for (const ct of sub.turns) await feed(child, ct);
          } catch (e) {
            this.host?.log(`subagent history ${child}: ${errText(e)}`);
          }
          m.ts = t0;
        }
        children = [];
      };
      for (const [n, item] of items.entries()) {
        out.push(...m.item(threadId, "started", item), ...m.item(threadId, "completed", item));
        const spawn = item?.type === "collabAgentToolCall" && item.tool === "spawnAgent";
        // A subagent's own turns nest under its spawn card. Live they ran while the next call (its wait) was open: replay them there.
        if (children.length && !spawn) await flush();
        if (spawn) {
          for (const child of (item.receiverThreadIds ?? []) as string[]) {
            if (typeof child === "string" && !loaded.has(child)) {
              loaded.add(child);
              children.push(child);
            }
          }
          if (n === items.length - 1) await flush();
        }
      }
      if (children.length) await flush();
      m.ts = (num(turn.completedAt) ?? num(turn.startedAt) ?? Date.now() / 1000) * 1000;
      // A turn still in progress elsewhere stays open; one left by a dead process reads back as interrupted.
      if (str(turn.status) !== "inProgress") out.push(...m.turnCompleted(threadId, turn));
    };
    for (const turn of turns) await feed(thread, turn);
    return out;
  }

  // ---------------------------------------------------------------- queries

  async listSessions(): Promise<SessionInfo[]> {
    const r = await this.require().request("thread/list", { cwd: this.opts.cwd, limit: 50, sortKey: "updated_at" }, 30_000);
    const list: Rec[] = Array.isArray(r?.data) ? r.data : [];
    return list
      .filter((t) => typeof t.id === "string" && !t.ephemeral)
      .map((t) => ({
        path: str(t.path) ?? t.id, name: str(t.name) || null, firstMessage: str(t.preview) ?? "",
        modified: (num(t.updatedAt) ?? num(t.createdAt) ?? 0) * 1000, messageCount: Array.isArray(t.turns) ? t.turns.length : 0,
      }));
  }

  async listModels(): Promise<AgentModel[]> {
    await this.modelsLoaded;
    if (!this.models.length) {
      const r = await this.require().request("model/list", { includeHidden: true }, 30_000);
      this.models = Array.isArray(r?.data) ? r.data : [];
    }
    return this.models
      .filter((m) => !m.hidden || m.id === this.settings.model)
      .map((m) => ({ provider: this.settings.modelProvider || "openai", id: String(m.id), name: String(m.displayName ?? m.id), reasoning: true, enabled: true }));
  }

  async commands(): Promise<AgentCommand[]> {
    const out: AgentCommand[] = [];
    try {
      const r = await this.require().request("skills/list", { cwds: [this.opts.cwd] }, 15_000);
      const skills: Rec[] = (Array.isArray(r?.data) ? r.data : []).flatMap((d: Rec) => (Array.isArray(d?.skills) ? d.skills : []));
      this.skills = skills
        .filter((s) => typeof s?.name === "string" && s.enabled !== false)
        .map((s) => ({ name: s.name, path: String(s.path ?? ""), description: str(s.interface?.shortDescription) ?? str(s.shortDescription) ?? str(s.description) ?? "" }));
      for (const s of this.skills) out.push({ name: s.name, description: s.description.length > 200 ? s.description.slice(0, 199) + "…" : s.description, source: "skill" });
    } catch (e) {
      this.host?.log(`skills/list failed: ${errText(e)}`);
    }
    for (const p of readPrompts()) if (!out.some((c) => c.name === p.name)) out.push({ name: p.name, description: p.description, source: "prompt" });
    return out;
  }

  async usage(): Promise<UsageInfo> {
    const u: TokenUsage | undefined = this.thread ? this.mapper.usage.get(this.thread) : undefined;
    if (!u) return { contextTokens: null, contextWindow: null, percent: null, cost: null };
    const tokens = num(u.last?.totalTokens) ?? null;
    const window = num(u.modelContextWindow) ?? null;
    return { contextTokens: tokens, contextWindow: window, percent: tokens !== null && window ? Math.round((tokens / window) * 1000) / 10 : null, cost: null };
  }

  /** /login: `codex login`. Settings live in ~/.codex/config.toml, not a terminal UI: none. */
  utilityCommand(name: string): string[] | null {
    return name === "login" ? [this.opts.command, "login"] : null;
  }

  tuiCommand(session: string): string[] {
    // --no-daemon: the TUI must not load the thread into the shared daemon, or our resume fails for ~60 s after it exits.
    return [this.opts.command, ...this.opts.args, "resume", "--no-daemon", threadIdOf(session) ?? this.thread ?? session];
  }

  // ---------------------------------------------------------------- settings

  /** thread/settings/update, or (older Codex) the same overrides on the next turn/start. */
  private async updateSettings(patch: Rec, turnPatch: Rec): Promise<void> {
    const proc = this.require();
    try {
      await proc.request("thread/settings/update", { threadId: this.requireThread(), ...patch }, 30_000);
    } catch (e) {
      if (!(e instanceof CodexRpcError) || e.code !== -32601) throw e;
      Object.assign(this.turnOverrides, turnPatch);
    }
  }

  async setModel(_provider: string, id: string): Promise<void> {
    await this.modelsLoaded;
    const m = this.modelInfo(id);
    if (this.models.length && !m) throw new Error(`Codex has no model "${id}"`);
    const efforts: string[] = Array.isArray(m?.supportedReasoningEfforts) ? m!.supportedReasoningEfforts.map((e: Rec) => String(e.reasoningEffort)) : [];
    const effort = this.settings.effort && (!efforts.length || efforts.includes(this.settings.effort)) ? this.settings.effort : str(m?.defaultReasoningEffort) ?? null;
    const patch: Rec = { model: id, ...(effort ? { effort } : {}) };
    if (this.settings.collaborationMode === "plan") patch.collaborationMode = this.collaboration("plan", id, effort);
    await this.updateSettings(patch, patch);
    this.applySettings({ model: id, effort });
  }

  async setThinking(level: string): Promise<void> {
    const m = this.modelInfo(this.settings.model);
    const efforts: string[] = Array.isArray(m?.supportedReasoningEfforts) ? m!.supportedReasoningEfforts.map((e: Rec) => String(e.reasoningEffort)) : [];
    if (efforts.length && !efforts.includes(level)) throw new Error(`${m?.displayName ?? this.settings.model} supports ${efforts.join(", ")}`);
    const patch: Rec = { effort: level };
    if (this.settings.collaborationMode === "plan") patch.collaborationMode = this.collaboration("plan", this.settings.model, level);
    await this.updateSettings(patch, patch);
    this.applySettings({ effort: level });
  }

  private collaboration(mode: string, model: string | null, effort: string | null): Rec {
    return { mode, settings: { model: model ?? "", reasoning_effort: effort, developer_instructions: null } };
  }

  async setPermissionMode(mode: string): Promise<void> {
    const p = PRESETS[mode];
    if (!p) {
      if (mode === "custom") return;
      throw new Error(`Unknown permission mode "${mode}"`);
    }
    const sandboxPolicy = this.sandboxSeen.get(p.sandbox) ?? (p.sandbox === "workspaceWrite"
      ? { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
      : p.sandbox === "readOnly" ? { type: "readOnly", networkAccess: false } : { type: "dangerFullAccess" });
    const collaborationMode = this.collaboration(p.plan ? "plan" : "default", this.settings.model, this.settings.effort);
    const patch: Rec = { approvalPolicy: p.approvalPolicy, approvalsReviewer: p.reviewer, sandboxPolicy, collaborationMode };
    await this.updateSettings(patch, patch);
    this.applySettings({ approvalPolicy: p.approvalPolicy, approvalsReviewer: p.reviewer, sandboxPolicy, collaborationMode: p.plan ? "plan" : "default" });
  }

  // ---------------------------------------------------------------- sessions

  async compact(): Promise<void> {
    const proc = this.require();
    const threadId = this.requireThread();
    if (this.fresh) throw new Error("Nothing to compact yet");
    const done = new Promise<void>((resolve, reject) => (this.compacting = { resolve, reject, turn: null, ended: false }));
    this.emit({ type: "compaction", phase: "start", reason: "manual" });
    try {
      await proc.request("thread/compact/start", { threadId }, 30_000);
    } catch (e) {
      this.compacting = null;
      this.emit({ type: "compaction", phase: "end", outcome: "failed", error: errText(e) });
      throw e;
    }
    await done;
  }

  async newSession(): Promise<void> {
    const proc = this.require();
    this.resetRun();
    const r = await proc.request("thread/start", { cwd: this.opts.cwd, config: THREAD_CONFIG }, 60_000);
    this.applyThread(r, false);
  }

  async switchSession(path: string): Promise<void> {
    const id = threadIdOf(path);
    if (!id) throw new Error(`"${path}" is not a Codex session`);
    this.resetRun();
    const params: Rec = { threadId: id, excludeTurns: true, cwd: this.opts.cwd, config: THREAD_CONFIG };
    if (path.endsWith(".jsonl") && existsSync(path)) params.path = path;
    try {
      this.applyThread(await this.resumeThread(params), true);
    } catch (e) {
      if (/active writer/i.test(errText(e))) throw new AgentError("That Codex session is open in another Codex process. Close it there first.", false, true);
      throw e;
    }
  }

  async setName(name: string): Promise<void> {
    await this.require().request("thread/name/set", { threadId: this.requireThread(), name }, 15_000);
    this.emit({ type: "session", name: name || null });
  }

  /** Each turn the person started, with its message as typed (a skill as `/name`): a turn id is a fork point. */
  private async promptTurns(): Promise<{ id: string; text: string }[]> {
    if (this.fresh) return [];
    const { turns } = await this.turnsOf(this.requireThread(), HISTORY_TURNS);
    const out: { id: string; text: string }[] = [];
    for (const t of turns) {
      const item = (Array.isArray(t.items) ? t.items : []).find((i: Rec) => i?.type === "userMessage");
      const id = str(t.id);
      if (!item || !id) continue;
      const u = userContent(item.content);
      out.push({ id, text: u.skill ? `/${u.skill.command}${u.text ? ` ${u.text}` : ""}` : u.text });
    }
    return out;
  }

  async forkPoints(): Promise<ForkPoint[]> {
    return this.promptTurns();
  }

  /**
   * Codex's fork: `thread/fork` through the turn before that one (inclusive),
   * on the same model and effort; before the first turn, a new thread.
   */
  async fork(point: string): Promise<{ text: string }> {
    const turns = await this.promptTurns();
    const i = turns.findIndex((t) => t.id === point);
    if (i < 0) throw new Error("That message isn't in this session any more");
    const { model, effort } = this.settings;
    this.resetRun();
    if (i === 0) await this.newSession();
    else {
      const r = await this.require().request("thread/fork", {
        threadId: this.requireThread(), lastTurnId: turns[i - 1]!.id, excludeTurns: true, cwd: this.opts.cwd, config: THREAD_CONFIG, ...(model ? { model } : {}),
      }, 60_000);
      this.applyThread(r, true);
    }
    if (effort && this.settings.effort !== effort) await this.setThinking(effort).catch((e) => this.host?.log(`fork: effort ${effort}: ${errText(e)}`));
    return { text: turns[i]!.text };
  }
}
