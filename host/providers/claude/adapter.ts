// Claude Code as a provider: `claude -p` in stream-json mode with the control
// protocol (docs/dev/research/provider-claude.md §1, §7). The user's own CLI and
// login; no API keys, no SDK runtime.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { ClaudeProcess } from "./process.ts";
import type { ClaudeRecord } from "./process.ts";
import { ClaudeMapper } from "./mapper.ts";
import { mcpFailureNotice } from "../mcp.ts";
import { agentEnv } from "../env.ts";
import type { Priority } from "./mapper.ts";
import { historyEvents, hasMessages } from "./history.ts";
import { sessionPath, sessionIdOf, listSessions, liveHolder, readUserSettings } from "./sessions.ts";
import type {
  ProviderAdapter, AdapterHost, AdapterOptions, Capabilities, StartInfo, NormalizedEvent, AskAnswer, ImageBlock, ModelInfo,
  AgentCommand, AgentModel, SessionInfo, UsageInfo, PromptMode, Disposition, PermissionMode, PermissionChoice,
} from "../types.ts";

type Rec = Record<string, any>;

export const CLAUDE_PERMISSION_MODES: PermissionMode[] = [
  { id: "default", label: "Ask", description: "Ask before edits and commands" },
  { id: "acceptEdits", label: "Accept edits", description: "Edit files without asking; ask for commands" },
  { id: "plan", label: "Plan", description: "Read and plan only, no changes" },
  { id: "auto", label: "Auto", description: "Decide per tool call" },
];
const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];
/** Commands that only work in the TUI (or make no sense here); the slash menu hides them. */
const TUI_ONLY = new Set(["doctor", "color", "focus", "reload-plugins", "theme", "login", "logout", "config", "terminal-setup", "statusline", "vim", "ide", "resume", "exit", "quit", "install-github-app", "keybindings"]);

const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
const STALL_MS = () => num(process.env.PI_CHAT_CLAUDE_STALL_MS, 90_000);
const INTERRUPT_MS = () => num(process.env.PI_CHAT_CLAUDE_INTERRUPT_MS, 8_000);
const POLL_MS = () => num(process.env.PI_CHAT_CLAUDE_POLL_MS, 1_000);

type PendingAsk = { requestId: string; kind: "permission" | "plan" | "questions"; request: Rec };

export class ClaudeAdapter implements ProviderAdapter {
  readonly id = "claude";
  readonly name = "Claude Code";
  readonly capabilities: Capabilities = {
    steer: true, followUp: true, thinkingLevels: EFFORT_LEVELS, permissions: true, permissionModes: CLAUDE_PERMISSION_MODES,
    extensionUi: false, compact: true, rename: true, fork: true, images: true, cost: true, tui: true,
  };
  private opts: AdapterOptions;
  private proc: ClaudeProcess | null = null;
  private host: AdapterHost | null = null;
  private mapper = new ClaudeMapper();
  private mcpReported = new Set<string>();
  private sessionId: string | null = null;
  private file: string | null = null;
  private models: Rec[] = [];
  private commandList: Rec[] = [];
  /** The model alias we launch with (`--model`), once the user picked one. */
  private modelValue: string | null = null;
  private effort: string | null;
  private permissionMode: string;
  private costBase = 0;
  private asks = new Map<string, PendingAsk>();
  private tasks = new Map<string, { callId: string; name: string; timer: NodeJS.Timeout }>();
  /** The polled output a Bash card shows, by call id, until the tool ends. */
  private liveOutput = new Map<string, string>();
  private lastRecordAt = Date.now();
  private watchdog: NodeJS.Timeout | null = null;
  private settleTimer: NodeJS.Timeout | null = null;
  private interruptTimer: NodeJS.Timeout | null = null;
  private compactWaiter: { resolve: () => void; reject: (e: Error) => void } | null = null;

  constructor(opts: AdapterOptions) {
    // `-- --model haiku` on the host's command line: the starting model, which /model can change later.
    const args = [...opts.args];
    const mi = args.findIndex((a) => a === "--model" || a.startsWith("--model="));
    if (mi >= 0) {
      const v = args[mi]!.includes("=") ? args[mi]!.slice(8) : args[mi + 1];
      args.splice(mi, args[mi]!.includes("=") ? 1 : 2);
      this.modelValue = v ?? null;
    }
    this.opts = { ...opts, args };
    const s = readUserSettings();
    this.effort = s.effortLevel && EFFORT_LEVELS.includes(s.effortLevel) ? s.effortLevel : null;
    // The user's default may be anything (even "auto"); pass it explicitly, and never a bypass mode we can't offer.
    const want = s.defaultMode;
    this.permissionMode = want && CLAUDE_PERMISSION_MODES.some((m) => m.id === want) ? want : "default";
  }

  get alive(): boolean {
    return !!this.proc && !this.proc.exited;
  }

  private emit(ev: NormalizedEvent): void {
    this.host?.emit(ev);
  }

  private require(): ClaudeProcess {
    if (!this.proc || this.proc.exited) throw new Error("Claude Code is not running. Use /reload to restart it.");
    return this.proc;
  }

  // ---------------------------------------------------------------- lifecycle

  async start(session: string | null, host: AdapterHost): Promise<StartInfo> {
    this.host = host;
    this.mapper = new ClaudeMapper();
    this.mapper.permissionMode = this.permissionMode;
    let id: string;
    let resume = false;
    if (session) {
      id = sessionIdOf(session);
      this.file = session;
      resume = existsSync(session);
    } else {
      id = randomUUID();
      this.file = sessionPath(this.opts.cwd, id);
    }
    this.sessionId = id;
    this.mapper.sessionId = id;
    const args = [
      "-p", "--output-format", "stream-json", "--verbose", "--input-format", "stream-json",
      "--include-partial-messages", "--replay-user-messages", "--permission-prompt-tool", "stdio",
      "--permission-mode", this.permissionMode, "--thinking-display", "summarized",
      ...(this.modelValue ? ["--model", this.modelValue] : []),
      ...(this.effort ? ["--effort", this.effort] : []),
      ...(resume ? ["--resume", id] : ["--session-id", id]),
      ...this.opts.args,
    ];
    host.log(`spawn ${this.opts.command} ${args.join(" ")}`);
    const env = agentEnv({ CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1" });
    delete env.NODE_OPTIONS; // the inspector or ESM loaders break the CLI (as the SDK does)
    const p = new ClaudeProcess({ command: this.opts.command, args, cwd: this.opts.cwd, env });
    this.proc = p;
    p.onRecord = (r) => this.proc === p && this.onRecord(r);
    p.onOversized = (o) => {
      if (this.proc !== p) return;
      this.lastRecordAt = Date.now();
      host.log(`dropped an oversized Claude record (${o.size} bytes): ${o.head.slice(0, 120)}`);
      this.emit({ type: "heartbeat" });
      this.emit({ type: "notice", level: "warning", source: "host", text: `Claude Code sent an update too large to show (${(o.size / 1048576).toFixed(1)} MiB), so part of this turn is missing here.`, once: "run" });
    };
    p.onBadLine = (line) => host.log(`claude stdout (not JSON): ${line.slice(0, 200)}`);
    p.onExit = (info) => {
      if (this.proc !== p) return;
      this.proc = null;
      this.stopTimers();
      host.emit({ type: "exited", code: info.code, signal: info.signal, stderrTail: info.stderr, ...(info.spawnError ? { spawnError: info.spawnError } : {}), command: this.opts.command });
    };
    this.emit({ type: "session", id, file: this.file, ...(resume ? {} : { name: null }) });
    this.startWatchdog();
    // MCP servers can hold up initialize; 30 s as T3 does.
    const init: Rec = await p.control({ subtype: "initialize" }, 30_000);
    this.models = Array.isArray(init.models) ? init.models : [];
    this.commandList = Array.isArray(init.commands) ? init.commands : [];
    const version = typeof init.claude_code_version === "string" ? init.claude_code_version : null;
    this.emit({ type: "version", version });
    if (typeof init.current_permission_mode === "string") {
      this.mapper.permissionMode = init.current_permission_mode;
      this.emit({ type: "permission_mode", mode: init.current_permission_mode });
    } else this.emit({ type: "permission_mode", mode: this.permissionMode });
    this.emitModel();
    if (this.effort) this.emit({ type: "thinking", level: this.effort });
    const other = liveHolder(id, p.pid);
    if (other) this.emit({ type: "notice", level: "warning", source: "host", text: `This session is also open in another Claude Code process (pid ${other.pid}${other.kind ? `, ${other.kind}` : ""}). Two writers on one session can lose turns.` });
    return { streaming: false, hasHistory: resume && hasMessages(this.file) };
  }

  /** ModelInfo for the current model: the alias we launched with, else the one init reported. */
  private currentModel(): ModelInfo {
    const want = this.modelValue ?? "default";
    const live = this.mapper.initModel;
    let m = this.models.find((x) => x.value === want);
    if (live && m && m.resolvedModel !== live && m.value !== live) {
      m = this.models.find((x) => x.value === live) ?? this.models.find((x) => x.resolvedModel === live && x.value !== "default") ?? undefined;
    }
    const id = m ? String(m.value) : live ?? want;
    return {
      provider: "anthropic", id, name: m ? String(m.displayName ?? m.value).replace(/\s*\(recommended\)\s*$/i, "") : id,
      reasoning: m ? m.supportsEffort === true : true, contextWindow: this.mapper.contextWindow, input: ["text", "image"],
    };
  }

  private emitModel(): void {
    const model = this.currentModel();
    this.emit({ type: "model", model });
    const m = this.models.find((x) => x.value === model.id);
    const levels = Array.isArray(m?.supportedEffortLevels) ? m.supportedEffortLevels.map(String) : m && !m.supportsEffort ? [] : EFFORT_LEVELS;
    this.emit({ type: "capabilities", capabilities: { thinkingLevels: levels } });
  }

  async dispose(): Promise<void> {
    const p = this.proc;
    if (!p) return;
    this.proc = null;
    this.stopTimers();
    this.costBase += this.mapper.totalCost;
    this.mapper.totalCost = 0;
    await p.stop();
  }

  kill(): void {
    this.proc?.killNow();
  }

  private stopTimers(): void {
    for (const t of this.tasks.values()) clearInterval(t.timer);
    this.tasks.clear();
    this.liveOutput.clear();
    for (const t of [this.watchdog, this.settleTimer, this.interruptTimer]) if (t) clearTimeout(t);
    this.watchdog = this.settleTimer = this.interruptTimer = null;
    this.asks.clear();
    if (this.compactWaiter) {
      this.compactWaiter.reject(new Error("Claude Code stopped"));
      this.compactWaiter = null;
    }
  }

  /** Stall watchdog: a run with no record for a while (and nothing for the user to answer) gets a warning. */
  private startWatchdog(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.lastRecordAt = Date.now();
    this.watchdog = setInterval(() => {
      if (!this.mapper.running || this.asks.size) return;
      const quiet = Date.now() - this.lastRecordAt;
      if (quiet < STALL_MS()) return;
      this.lastRecordAt = Date.now(); // warn again only after another full spell (and once per run)
      this.emit({ type: "notice", level: "warning", source: "host", text: `Claude Code hasn't sent anything for ${Math.round(quiet / 1000)} s. Press Esc to stop it, or /reload to restart it.`, once: "run" });
    }, Math.min(1000, STALL_MS()));
    this.watchdog.unref();
  }

  private async restart(session: string | null): Promise<void> {
    const host = this.host;
    if (!host) throw new Error("Claude Code is not running");
    await this.dispose();
    await this.start(session, host);
  }

  // ---------------------------------------------------------------- records

  private onRecord(rec: ClaudeRecord): void {
    this.lastRecordAt = Date.now();
    this.emit({ type: "heartbeat" });
    if (this.settleTimer && rec.type !== "control_response") {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    switch (rec.type) {
      case "control_request":
        this.onControlRequest(rec);
        return;
      case "control_cancel_request": {
        const id = String(rec.request_id ?? "");
        if (this.asks.delete(id)) this.emit({ type: "ask_closed", id });
        return;
      }
      case "control_response":
        return;
      case "system":
        this.onSystem(rec);
        break;
    }
    const before = this.mapper.running;
    for (const ev of this.mapper.map(rec)) this.forward(ev);
    if (before && !this.mapper.running && this.interruptTimer) {
      clearTimeout(this.interruptTimer);
      this.interruptTimer = null;
    }
    // Settle fallback when the CLI doesn't emit session_state_changed: a result with nothing queued ends the run.
    if (rec.type === "result" && !this.mapper.sawStates && this.mapper.running && !(rec.queued_turn_count > 0) && !this.hasQueued()) {
      this.settleTimer = setTimeout(() => {
        this.settleTimer = null;
        if (this.mapper.running) for (const ev of this.mapper.settle()) this.forward(ev);
      }, 400);
    }
  }

  private hasQueued(): boolean {
    const q = this.mapper.queueEvent();
    return q.steering.length + q.followUp.length > 0;
  }

  private forward(ev: NormalizedEvent): void {
    if (ev.type === "tool_ended") {
      this.stopTask(ev.callId);
      const live = this.liveOutput.get(ev.callId);
      this.liveOutput.delete(ev.callId);
      // An interrupted Bash ends with only the CLI's rejection: keep the output the card showed above it, as Pi and Codex do.
      if (live && this.mapper.aborting && !ev.output.includes(live)) ev = { ...ev, output: `${live.replace(/\n?$/, "\n")}${ev.output}` };
    }
    if (ev.type === "compaction" && ev.phase === "end") {
      this.mapper.compactOwn = false;
      const w = this.compactWaiter;
      this.compactWaiter = null;
      if (w) {
        if (ev.outcome === "failed") w.reject(new Error(ev.error ?? "compaction failed"));
        else w.resolve();
      }
    }
    this.emit(ev);
  }

  private onSystem(rec: Rec): void {
    switch (rec.subtype) {
      case "init": {
        if (typeof rec.model === "string" && rec.model !== this.mapper.initModel) {
          this.mapper.initModel = rec.model;
          this.emitModel();
        }
        // init comes with every turn: each failed MCP server is told once, all of one init in one notice.
        const failed = (Array.isArray(rec.mcp_servers) ? rec.mcp_servers : [])
          .filter((m: Rec) => (m?.status === "failed" || m?.status === "needs-auth") && typeof m.name === "string" && !this.mcpReported.has(m.name));
        for (const m of failed) this.mcpReported.add(m.name);
        if (failed.length) this.emit({ type: "notice", level: "warning", source: "notify", text: mcpFailureNotice(failed.map((m: Rec) => ({ name: m.name, auth: m.status === "needs-auth", detail: m.status === "needs-auth" ? "needs OAuth sign-in" : "failed to connect" })), "run /mcp in /tui") });
        return;
      }
      case "task_started":
        if (rec.task_type === "local_bash" && typeof rec.tool_use_id === "string" && typeof rec.task_id === "string") this.pollTask(rec.task_id, rec.tool_use_id);
        return;
      case "task_notification":
      case "task_updated": {
        const done = rec.subtype === "task_notification" || ["completed", "failed", "stopped", "killed"].includes(rec.patch?.status);
        if (done && typeof rec.task_id === "string") {
          const t = this.tasks.get(rec.task_id);
          if (t) clearInterval(t.timer);
          this.tasks.delete(rec.task_id);
        }
        return;
      }
    }
  }

  /** No bash output streams; a foreground Bash over ~3 s becomes a task whose output we poll. */
  private pollTask(taskId: string, callId: string): void {
    const name = this.mapper.toolNames.get(callId) ?? "Bash";
    let busy = false;
    const timer = setInterval(async () => {
      const p = this.proc;
      if (!p || busy) return;
      busy = true;
      try {
        const r: Rec = await p.control({ subtype: "get_task_output", task_id: taskId }, 5_000);
        if (this.tasks.has(taskId) && typeof r.output === "string") {
          this.liveOutput.set(callId, r.output);
          this.emit({ type: "tool_progress", callId, name, output: r.output });
        }
      } catch {
      } finally {
        busy = false;
      }
    }, POLL_MS());
    this.tasks.set(taskId, { callId, name, timer });
  }

  private stopTask(callId: string): void {
    for (const [id, t] of this.tasks) {
      if (t.callId !== callId) continue;
      clearInterval(t.timer);
      this.tasks.delete(id);
    }
  }

  // ---------------------------------------------------------------- asks (control requests from the CLI)

  private reply(requestId: string, response: Rec): void {
    this.proc?.write({ type: "control_response", response: { subtype: "success", request_id: requestId, response } });
  }

  private onControlRequest(rec: Rec): void {
    const id = String(rec.request_id ?? "");
    const r: Rec = rec.request ?? {};
    switch (r.subtype) {
      case "can_use_tool":
        this.onCanUseTool(id, r);
        return;
      case "elicitation":
        this.reply(id, { action: "decline" });
        this.emit({ type: "notice", level: "warning", source: "host", text: `An MCP server${r.mcp_server_name ? ` (${r.mcp_server_name})` : ""} asked for input, which the chat can't show yet: ${String(r.message ?? "").slice(0, 200)}. Declined; use /tui to answer it there.` });
        return;
      case "request_user_dialog":
        return; // only sent for dialog kinds we declare (none); it must stay unanswered
      default:
        this.proc?.write({ type: "control_response", response: { subtype: "error", request_id: id, error: `Unsupported request: ${r.subtype}` } });
    }
  }

  private onCanUseTool(id: string, r: Rec): void {
    const name = String(r.tool_name ?? "tool");
    const input: Rec = r.input && typeof r.input === "object" ? r.input : {};
    if (name === "AskUserQuestion" && Array.isArray(input.questions)) {
      const questions = input.questions.map((q: Rec, i: number) => ({
        id: `q${i}`, ...(typeof q.header === "string" ? { header: q.header } : {}), question: String(q.question ?? ""),
        options: Array.isArray(q.options) ? q.options.map((o: Rec) => ({ label: String(o.label ?? ""), ...(typeof o.description === "string" && o.description !== o.label ? { description: o.description } : {}) })) : [],
        multiSelect: q.multiSelect === true, allowOther: true,
      }));
      this.asks.set(id, { requestId: id, kind: "questions", request: r });
      this.emit({ type: "ask", ask: { id, kind: "questions", title: questions.length > 1 ? "Claude Code has some questions" : "Claude Code has a question", questions } });
      return;
    }
    if (name === "ExitPlanMode") {
      this.asks.set(id, { requestId: id, kind: "plan", request: r });
      this.emit({
        type: "ask", ask: {
          id, kind: "permission", title: "Claude Code's plan is ready", ...(typeof input.plan === "string" ? { message: input.plan } : {}),
          choices: [
            { id: "approve", label: "Approve", kind: "allow", description: "Leave plan mode and start; ask before edits" },
            { id: "approve_edits", label: "Approve, accept edits", kind: "other", description: "Leave plan mode and edit without asking" },
            { id: "keep", label: "Keep planning", kind: "deny", description: "Tell Claude what to change" },
          ],
        },
      });
      return;
    }
    const rules = this.alwaysRules(r);
    const choices: PermissionChoice[] = [
      { id: "allow", label: "Allow once", kind: "allow" },
      ...(rules.length && r.suppress_always_allow_rule !== true ? [{ id: "always", label: "Always allow", kind: "allow_always" as const, description: rules.map(describeRule).join(", ") }] : []),
      { id: "deny", label: "Deny", kind: "deny" },
    ];
    this.asks.set(id, { requestId: id, kind: "permission", request: r });
    const display = String(r.display_name ?? name);
    const message = [r.decision_reason, r.description].filter((x) => typeof x === "string" && x).join("\n") || undefined;
    this.emit({
      type: "ask", ask: {
        id, kind: "permission", title: typeof r.title === "string" && r.title ? r.title : `Allow ${display}?`, ...(message ? { message } : {}),
        tool: { name, args: input, ...(typeof r.tool_use_id === "string" ? { callId: r.tool_use_id } : {}) }, choices,
      },
    });
  }

  /** The suggestions "Always allow" applies: rules and directories, not mode switches. */
  private alwaysRules(r: Rec): Rec[] {
    return Array.isArray(r.permission_suggestions) ? r.permission_suggestions.filter((s: Rec) => s?.type === "addRules" || s?.type === "addDirectories") : [];
  }

  answer(askId: string, a: AskAnswer): void {
    const ask = this.asks.get(askId);
    if (!ask) return;
    this.asks.delete(askId);
    const r = ask.request;
    const input: Rec = r.input && typeof r.input === "object" ? r.input : {};
    const toolUseID = typeof r.tool_use_id === "string" ? { toolUseID: r.tool_use_id } : {};
    const allow = (extra: Rec = {}) => this.reply(ask.requestId, { behavior: "allow", updatedInput: input, ...extra, ...toolUseID });
    const deny = (message: string) => this.reply(ask.requestId, { behavior: "deny", message, ...toolUseID });
    if ("cancelled" in a) return deny(ask.kind === "questions" ? "The user dismissed the question." : "The user cancelled this.");
    if (ask.kind === "questions") {
      if (!("answers" in a)) return deny("The user dismissed the question.");
      const answers: Record<string, string> = {};
      (input.questions as Rec[]).forEach((q, i) => {
        const v = a.answers[`q${i}`];
        if (v !== undefined) answers[String(q.question)] = Array.isArray(v) ? v.join(", ") : v;
      });
      return allow({ updatedInput: { ...input, answers } });
    }
    const choice = "choice" in a ? a.choice : "confirmed" in a ? (a.confirmed ? "allow" : "deny") : "value" in a ? a.value : "deny";
    const msg = "choice" in a ? a.message : undefined;
    if (ask.kind === "plan") {
      if (choice === "approve") return allow({ updatedPermissions: [{ type: "setMode", mode: "default", destination: "session" }] });
      if (choice === "approve_edits") return allow({ updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }] });
      return deny(msg || "Keep planning: the user didn't approve the plan yet.");
    }
    if (choice === "allow") return allow();
    if (choice === "always") return allow({ updatedPermissions: this.alwaysRules(r) });
    return deny(msg || "The user denied this.");
  }

  // ---------------------------------------------------------------- commands

  async prompt(p: { id: string; text: string; images: ImageBlock[]; mode: PromptMode; busy: boolean }): Promise<{ disposition: Disposition }> {
    const proc = this.require();
    const uuid = p.id; // the CLI replays it on the echo
    // The CLI's default priority sits behind a feature flag: always set it.
    const priority: Priority = p.busy && p.mode === "followUp" ? "later" : "next";
    this.mapper.sent.set(uuid, { uuid, text: p.text, images: p.images, priority, queued: p.busy, echoed: false, cancelled: false });
    const content = p.images.length
      ? [...p.images.map((i) => ({ type: "image", source: { type: "base64", media_type: i.mimeType, data: i.data } })), ...(p.text ? [{ type: "text", text: p.text }] : [])]
      : p.text;
    if (!proc.write({ type: "user", message: { role: "user", content }, parent_tool_use_id: null, uuid, priority })) throw new Error("Claude Code is not running");
    if (p.busy) this.emit(this.mapper.queueEvent());
    return { disposition: p.busy ? "queued" : "started" };
  }

  async clearQueue(): Promise<string[]> {
    const before = [...this.mapper.sent.values()].filter((s) => s.queued && !s.echoed && !s.cancelled);
    const texts = this.mapper.dropQueue();
    if (texts.length) this.emit(this.mapper.queueEvent());
    // While a run is on, the interrupt (cancel_queued) drops them; between runs, cancel each.
    if (!this.mapper.running) for (const s of before) this.proc?.control({ subtype: "cancel_async_message", message_uuid: s.uuid }, 5_000).catch(() => {});
    return texts;
  }

  canRemoveQueued(id: string): boolean {
    const s = this.mapper.sent.get(id);
    return !!s && s.queued && !s.echoed && !s.cancelled;
  }

  /** `cancel_async_message`: drops a queued message by uuid, a no-op once the CLI dequeued it. */
  async removeQueued(id: string): Promise<boolean> {
    if (!this.canRemoveQueued(id)) return false;
    const r: Rec = await this.require().control({ subtype: "cancel_async_message", message_uuid: id }, 5_000);
    const s = this.mapper.sent.get(id)!;
    if (r?.cancelled === false || s.echoed) return false;
    s.cancelled = true;
    this.emit(this.mapper.queueEvent());
    return true;
  }

  abort(): void {
    const p = this.proc;
    if (!p) return;
    this.mapper.aborting = true;
    for (const t of this.tasks.values()) clearInterval(t.timer);
    this.tasks.clear();
    p.control({ subtype: "interrupt", cancel_queued: true }, 0)
      .then(() => {
        // Nothing was running (the turn hadn't started): don't mark the next run aborted.
        if (!this.mapper.running) this.mapper.aborting = false;
      })
      .catch(() => {});
    if (this.interruptTimer) clearTimeout(this.interruptTimer);
    // A wedged CLI never answers: stop it, so the chat can restart it on the same session.
    this.interruptTimer = setTimeout(() => {
      this.interruptTimer = null;
      if (this.proc !== p || !this.mapper.running) return;
      this.host?.log("interrupt not honoured; killing claude");
      this.emit({ type: "notice", level: "warning", source: "host", text: "Claude Code didn't stop when asked, so the chat stopped it. Send a message to continue the session." });
      p.killNow();
    }, INTERRUPT_MS());
  }

  async history(): Promise<NormalizedEvent[]> {
    return this.file && existsSync(this.file) ? historyEvents(this.file) : [];
  }

  listSessions(): SessionInfo[] {
    return listSessions(this.opts.cwd);
  }

  async listModels(): Promise<AgentModel[]> {
    const p = this.require();
    try {
      const r: Rec = await p.control({ subtype: "list_models" }, 15_000);
      if (Array.isArray(r.models) && r.models.length) this.models = r.models;
    } catch {}
    return this.models.map((m) => ({
      provider: "anthropic", id: String(m.value), name: String(m.displayName ?? m.value).replace(/\s*\(recommended\)\s*$/i, ""), reasoning: m.supportsEffort === true, enabled: true,
    }));
  }

  async commands(): Promise<AgentCommand[]> {
    const hidden = new Set([...TUI_ONLY, ...this.mapper.terminalCommands]);
    return this.commandList
      .filter((c) => c && typeof c.name === "string" && !hidden.has(c.name))
      .map((c) => {
        const description = typeof c.description === "string" ? c.description : "";
        return { name: c.name, description, source: /\((user|project|plugin[^)]*|managed)\)\s*$/.test(description) ? "skill" : "extension" };
      });
  }

  async usage(): Promise<UsageInfo> {
    const r: Rec = await this.require().control({ subtype: "get_context_usage", detail: "summary" }, 10_000);
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const cost = this.costBase + this.mapper.totalCost;
    return { contextTokens: n(r.totalTokens), contextWindow: n(r.maxTokens), percent: n(r.percentage), cost: cost > 0 ? cost : null };
  }

  /** Claude Code's own guard: its live-process registry (~/.claude/sessions/<pid>.json). */
  sessionHolder(session: string): { pid: number } | null {
    const id = sessionIdOf(session);
    return id ? liveHolder(id, this.proc?.pid) : null;
  }

  tuiCommand(session: string): string[] {
    const id = session.endsWith(".jsonl") ? sessionIdOf(session) : session;
    // Before the first turn there's no transcript to resume: open the TUI on that id instead.
    const file = this.file && sessionIdOf(this.file) === id ? this.file : sessionPath(this.opts.cwd, id);
    return [this.opts.command, existsSync(file) ? "--resume" : "--session-id", id];
  }

  /** /login: `claude auth login`; /settings: the TUI (its /config lives there). */
  utilityCommand(name: string): string[] | null {
    if (name === "login") return [this.opts.command, "auth", "login"];
    if (name === "settings") return [this.opts.command];
    return null;
  }

  async setModel(_provider: string, id: string): Promise<void> {
    await this.require().control({ subtype: "set_model", model: id }, 30_000);
    this.modelValue = id;
    this.mapper.initModel = null;
    this.emitModel();
  }

  async setThinking(level: string): Promise<void> {
    if (!EFFORT_LEVELS.includes(level)) throw new Error(`Claude Code's effort levels are ${EFFORT_LEVELS.join(", ")}`);
    await this.require().control({ subtype: "apply_flag_settings", settings: { effortLevel: level } }, 15_000);
    this.effort = level;
    this.emit({ type: "thinking", level });
  }

  async setPermissionMode(mode: string): Promise<void> {
    const r: Rec = await this.require().control({ subtype: "set_permission_mode", mode }, 15_000);
    this.permissionMode = typeof r.mode === "string" ? r.mode : mode;
    this.mapper.permissionMode = this.permissionMode;
    this.emit({ type: "permission_mode", mode: this.permissionMode });
  }

  compact(instructions?: string): Promise<void> {
    const p = this.require();
    this.mapper.compactOwn = true;
    return new Promise((resolve, reject) => {
      this.compactWaiter = { resolve, reject };
      const text = instructions ? `/compact ${instructions}` : "/compact";
      p.write({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, uuid: randomUUID(), priority: "next" });
    });
  }

  async newSession(): Promise<void> {
    await this.restart(null);
  }

  async switchSession(path: string): Promise<void> {
    await this.restart(path);
  }

  async setName(name: string): Promise<void> {
    await this.require().control({ subtype: "rename_session", title: name, source: "host" }, 15_000);
    this.emit({ type: "session", name: name || null });
  }
}

function describeRule(s: Rec): string {
  if (s.type === "addDirectories" && Array.isArray(s.directories)) return `access to ${s.directories.join(", ")}`;
  if (Array.isArray(s.rules)) return s.rules.map((r: Rec) => (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : String(r.toolName))).join(", ");
  return String(s.type);
}
