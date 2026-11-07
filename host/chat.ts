// One chat: supervises the agent through its provider adapter, turns normalized
// events into ChatState + Items, runs ops. Provider-neutral: it sees the agent
// only through host/providers/types.ts.
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Timeline } from "./timeline.ts";
import type { Item, UserSource, ImageBlock, ToolDetail, NoticeItem } from "./timeline.ts";
import { toSpans, toSpanLines, stripAnsi } from "./ansi.ts";
import type { Span } from "./ansi.ts";
import { mergeCommands, parseBuiltin, builtins } from "./commands.ts";
import { splitSkill, typedText } from "./skill.ts";
import type { SkillRef } from "./skill.ts";
import type { Command } from "./commands.ts";
import { takeLock, releaseLock, readLock, pidAlive, readRegistry } from "./registry.ts";
import { ChatClient } from "./client.ts";
import { FileIndex } from "./files.ts";
import { clipboardImage, loadImages } from "./clipboard.ts";
import { Renderer } from "./render.ts";
import { presentTool, prettyArgs } from "./tools.ts";
import { AgentError } from "./providers/types.ts";
import type {
  ProviderAdapter, AdapterHost, NormalizedEvent, EventOf, Capabilities, Ask, AskAnswer, ModelInfo, PermissionChoice, Question, AgentModel, SessionInfo, ForkPoint,
} from "./providers/types.ts";

export type { ModelInfo, Capabilities };

export const MAX_SNAPSHOT_ITEMS = 200;
const MAX_SNAPSHOT_BYTES = 6 * 1024 * 1024;
const SEND_REPLY_WAIT_MS = 1500;
const STARTUP_DIALOG_HINT_MS = 10_000;
const STARTUP_TIMEOUT_MS = 45_000;
const COMMAND_HINT_MS = 10_000;

export type Phase = "starting" | "idle" | "working" | "compacting" | "handoff" | "conflict" | "exited" | "error";
/** The session is in the agent's TUI: `argv` runs it, `terminal` is the TUI's terminal once the client reports it. */
export type Handoff = { argv: string[]; terminal: string | null; since: number };
/** Another live writer has the session: a chat's host (`chat`, `terminal`), or an agent process outside any chat (`chat: null`). */
export type Conflict = { chat: string | null; terminal: string | null; pid: number | null };
export type ExtensionDialog = {
  id: string; method: "select" | "confirm" | "input" | "editor"; title: string;
  message?: string; options?: string[]; placeholder?: string; prefill?: string; timeoutAt?: number;
};
export type PermissionDialog = {
  id: string; method: "permission"; title: string; message?: string;
  tool?: { name: string; title: string; detail?: ToolDetail; args?: string };
  choices: PermissionChoice[]; timeoutAt?: number;
};
export type QuestionsDialog = { id: string; method: "questions"; title: string; questions: Question[]; timeoutAt?: number };
export type Dialog = ExtensionDialog | PermissionDialog | QuestionsDialog;
export type ChatState = {
  phase: Phase;
  error: string | null;
  cwd: string;
  sessionFile: string | null;
  sessionName: string | null;
  agentVersion: string | null;
  model: ModelInfo | null;
  thinking: string | null;
  usage: { contextTokens: number | null; contextWindow: number | null; percent: number | null; cost: number | null } | null;
  queue: Queue;
  dialog: Dialog | null;
  dialogsPending: number;
  statuses: { key: string; spans: Span[] }[];
  widgets: { key: string; placement: "aboveEditor" | "belowEditor"; lines: Span[][] }[];
  title: string | null;
  editorText: string | null;
  commands: Command[];
  provider: string;
  providerName: string;
  capabilities: Capabilities;
  permissionMode: string | null;
  handoff: Handoff | null;
  conflict: Conflict | null;
};

const URGENT = new Set<keyof ChatState>(["phase", "dialog", "dialogsPending", "queue", "error", "editorText", "handoff", "conflict"]);

/**
 * The two lanes above the composer. Steering is the agent's queue; the
 * follow-ups are the agent's (rare) then the ones the host holds until the run
 * settles. The arrays are aligned with the texts and present when a lane has
 * something: `…Ids` the host's message id (null = not the host's: it can't be
 * removed, moved or edited), `…Removable` whether the host can take it back
 * now, `…From` who sent it (an `hc send` report's `from`, null = the user;
 * present only when some entry has a sender).
 */
export type Queue = {
  steering: string[]; followUp: string[];
  steeringIds?: (string | null)[]; followUpIds?: (string | null)[];
  steeringRemovable?: boolean[]; followUpRemovable?: boolean[];
  steeringFrom?: (string | null)[]; followUpFrom?: (string | null)[];
};

export type Patch = { state: Partial<ChatState>; upsert: Item[]; remove: string[] };
export type Sink = {
  patch(p: Patch): void;
  snapshot(): void;
  toast(level: "info" | "warning" | "error", text: string): void;
  bye(reason: string): void;
};

export type ChatOptions = {
  chat: string;
  cwd: string;
  session: string | null;
  adapter: ProviderAdapter;
  terminal: string | null;
  /** Where images from tool results and user messages are saved (<stateDir>/images/<chat>). */
  imageDir?: string | null;
  /** The state dir: other chats' registries (take_over) and the hand-off file (<stateDir>/handoff/<chat>.json). */
  stateDir?: string | null;
  /** The `hc` binary that watches the hand-off's terminal. */
  hcCommand?: string;
  /** Hand-off watch: poll interval, and how long to wait for the TUI's terminal before watching processes. */
  handoffPollMs?: number;
  handoffGraceMs?: number;
  /**
   * A process that still writes `session` (the Pi TUI a chat took over:
   * --after-pid). While it lives, the session is in conflict; main.ts waits
   * for it to exit before the first start.
   */
  afterPid?: number | null;
  log: (msg: string) => void;
  onSessionFile?: (file: string | null) => void;
  onVersion?: (v: string | null) => void;
  onShutdown?: () => void;
};

/**
 * A message the host sent that its echo hasn't confirmed yet. `item`: its user
 * item, shown at send time (a queued one shows in the queue until delivered).
 * `text` and `images` (paths) are what was sent, for taking a queued one back.
 */
type Sent = { source: UserSource; from?: string; item?: string; text: string; images: string[] };
/** A follow-up the host holds until the run settles. */
type Held = { id: string; text: string; images: string[]; from?: string };
const NO_QUEUE: EventOf<"queue_changed"> = { type: "queue_changed", steering: [], followUp: [] };
/** Unconfirmed messages kept: one whose echo never comes (aborted before its turn started) is dropped after this many newer ones. */
const MAX_UNCONFIRMED = 100;

type Rec = Record<string, any>;

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class Chat {
  opts: ChatOptions;
  adapter: ProviderAdapter;
  state: ChatState;
  timeline: Timeline;
  render: Renderer;
  sinks: Sink[] = [];

  private dirtyState = new Set<keyof ChatState>();
  private flushTimer: NodeJS.Timeout | null = null;
  private urgentQueued = false;

  private dialogs: Dialog[] = [];
  private dialogRun = new Map<string, number>(); // dialog id -> the run it opened in
  private dialogTimers = new Map<string, NodeJS.Timeout>();
  private statusMap = new Map<string, Span[]>();
  private widgetMap = new Map<string, { placement: "aboveEditor" | "belowEditor"; lines: Span[][] }>();

  private runActive = false;
  private runAborted = false;
  private expectRun = 0;
  private autonomousNotice: string | null = null;
  private autonomousCause: string | null = null;
  private activity = 0;
  /** By the host's message id (the adapters put it on the echo as `clientId`). */
  private unconfirmed = new Map<string, Sent>();
  /** The agent's last queue (`queue_changed`). */
  private agentQueue: EventOf<"queue_changed"> = NO_QUEUE;
  /** Follow-ups the host holds: the next goes as a prompt when the run settles, one per run. */
  private held: Held[] = [];
  private heldSending = false;
  private retryNotice: string | null = null;
  private compactionNotice: string | null = null;
  private onceRun = new Map<string, number>(); // notice key -> the run it was shown in
  private runSeq = 0;
  private lastRunError: string | null = null;
  private stopping = false;
  private ready: Promise<void> = Promise.resolve();
  private readyResolve: (() => void) | null = null;
  private startupTimers: NodeJS.Timeout[] = [];
  private commandHint: NodeJS.Timeout | null = null;
  private statsBusy = false;
  private statsAgain = false;
  private lockedFile: string | null = null;
  private sessionId: string | null = null;
  private files: FileIndex;
  private generation = 0;

  constructor(opts: ChatOptions) {
    this.opts = opts;
    this.adapter = opts.adapter;
    this.timeline = this.newTimeline();
    this.render = new Renderer(opts.imageDir ?? null, (id) => this.timeline.rawOutput.get(id), opts.log);
    this.files = new FileIndex(opts.cwd);
    this.state = {
      phase: "starting", error: null, cwd: opts.cwd, sessionFile: opts.session, sessionName: null, agentVersion: null,
      model: null, thinking: null, usage: null, queue: { steering: [], followUp: [] }, dialog: null, dialogsPending: 0,
      statuses: [], widgets: [], title: null, editorText: null, commands: [],
      provider: this.adapter.id, providerName: this.adapter.name, capabilities: structuredClone(this.adapter.capabilities), permissionMode: null,
      handoff: null, conflict: null,
    };
    this.state.commands = this.menu();
  }

  /** The agent's own commands, from the last `commands()`. */
  private agentCommands: unknown = [];

  /** The slash menu: the built-ins this provider supports, then the agent's commands. */
  private menu(): Command[] {
    const a = this.adapter;
    const builtin = builtins({
      name: a.name, capabilities: this.state.capabilities, tuiCommands: a.tuiCommands?.() ?? [],
      utility: (n) => a.utilityCommand?.(n) ?? null,
      tuiInput: (n) => a.tuiInput?.(n) ?? null,
    });
    return mergeCommands(builtin, this.agentCommands);
  }

  /** The agent's display name, for messages ("Pi", "Claude Code"). */
  private get agent(): string {
    return this.adapter.name;
  }

  private newTimeline(): Timeline {
    const dir = this.opts.imageDir;
    if (!dir) return new Timeline(this.opts.cwd, null, this.adapter.tools);
    const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/gif": "gif", "image/webp": "webp" };
    return new Timeline(this.opts.cwd, (itemId: string, n: number, img: ImageBlock) => {
      const ext = EXT[img.mimeType.toLowerCase()];
      if (!ext) return null;
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const path = join(dir, `${itemId}-${n}.${ext}`);
        writeFileSync(path, Buffer.from(img.data, "base64"), { mode: 0o600 });
        return path;
      } catch (e) {
        this.opts.log(`could not save an image: ${errText(e)}`);
        return null;
      }
    }, this.adapter.tools);
  }

  // ---------------------------------------------------------------- publishing

  private set(patch: Partial<ChatState>): void {
    for (const k of Object.keys(patch) as (keyof ChatState)[]) {
      const v = patch[k];
      if (JSON.stringify(this.state[k]) === JSON.stringify(v)) continue;
      (this.state as Record<string, unknown>)[k] = v;
      this.dirtyState.add(k);
      if (URGENT.has(k)) this.urgent();
    }
    this.schedule();
  }

  /** Something in the timeline changed: flush within 50 ms. */
  schedule(): void {
    if (this.flushTimer || this.urgentQueued) return;
    this.flushTimer = setTimeout(() => this.flush(), 50);
  }

  private urgent(): void {
    if (this.urgentQueued) return;
    this.urgentQueued = true;
    setImmediate(() => this.flush());
  }

  flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.urgentQueued = false;
    if (!this.dirtyState.size && !this.timeline.dirty.size && !this.timeline.removed.size) return;
    const state: Partial<ChatState> = {};
    for (const k of this.dirtyState) (state as Record<string, unknown>)[k] = this.state[k];
    this.dirtyState.clear();
    const upsert: Item[] = [];
    for (const it of this.timeline.items) if (this.timeline.dirty.has(it.id)) upsert.push(it);
    for (const it of upsert) this.render.prepare(it);
    const remove = [...this.timeline.removed];
    this.timeline.dirty.clear();
    this.timeline.removed.clear();
    const p = { state, upsert: structuredClone(upsert), remove };
    for (const s of this.sinks) s.patch(p);
  }

  snapshotData(): { state: ChatState; items: Item[]; hasOlder: boolean } {
    const all = this.timeline.items;
    let items = all.slice(-MAX_SNAPSHOT_ITEMS);
    for (const it of items) this.render.prepare(it);
    let bytes = 0;
    let start = items.length;
    while (start > 0) {
      const b = JSON.stringify(items[start - 1]).length;
      if (bytes + b > MAX_SNAPSHOT_BYTES && start < items.length) break;
      bytes += b;
      start--;
    }
    items = items.slice(start);
    return { state: structuredClone(this.state), items: structuredClone(items), hasOlder: items.length < all.length };
  }

  /** Replace the whole timeline (new session, switch, resume). */
  private replaceTimeline(t: Timeline): void {
    this.flush();
    const old = this.timeline;
    this.timeline = t;
    t.dirty.clear();
    this.dirtyState.clear();
    for (const s of this.sinks) s.snapshot();
    // The old items' image files are no longer referenced.
    const keep = new Set(t.items.flatMap((i) => (i.kind === "tool" ? i.images ?? [] : i.kind === "user" ? i.imagePaths ?? [] : [])));
    for (const it of old.items) {
      for (const p of it.kind === "tool" ? it.images ?? [] : it.kind === "user" ? it.imagePaths ?? [] : []) {
        if (!keep.has(p)) rmSync(p, { force: true });
      }
    }
  }

  private toast(level: "info" | "warning" | "error", text: string): void {
    for (const s of this.sinks) s.toast(level, text);
  }

  notice(level: NoticeItem["level"], text: string, source: NoticeItem["source"] = "host"): string {
    const n = this.timeline.addNotice(level, source, text);
    if (level === "error") this.urgent();
    this.schedule();
    return n.id;
  }

  // ---------------------------------------------------------------- agent lifecycle

  /** The adapter's view of this chat, bound to one start: events from an older process are dropped. */
  private hostFor(gen: number): AdapterHost {
    const chat = this;
    return {
      emit: (ev) => {
        if (gen === chat.generation) chat.onEvent(ev);
      },
      log: (msg) => chat.opts.log(msg),
      get running() {
        return chat.runActive;
      },
      get working() {
        return chat.state.phase === "working";
      },
    };
  }

  /**
   * Starts the agent on `sessionFile`, unless another live writer has it
   * (phase "conflict"). `agentGuard: false` skips the agent's own guard: after
   * a hand-off the holder is the chat's own TUI on its way out.
   */
  start(sessionFile: string | null = this.state.sessionFile, opts: { agentGuard?: boolean } = {}): void {
    const gen = ++this.generation;
    this.stopping = false;
    this.runActive = false;
    this.expectRun = 0;
    this.ready = new Promise((r) => (this.readyResolve = r));
    const conflict = sessionFile ? this.findConflict(sessionFile, opts.agentGuard !== false) : null;
    if (conflict) {
      this.enterConflict(sessionFile!, conflict);
      return;
    }
    this.set({ phase: "starting", error: null, sessionFile, conflict: null });
    void this.boot(gen, sessionFile);
  }

  // ---------------------------------------------------------------- one writer per session

  /** Another live chat's host holding the session lock. An older host of this same chat doesn't count. */
  private lockHolder(file: string): Conflict | null {
    const l = readLock(file);
    if (!l || !Number.isInteger(l.pid) || l.pid === process.pid || l.chat === this.opts.chat || !pidAlive(l.pid)) return null;
    return { chat: l.chat ?? null, terminal: l.terminal ?? null, pid: l.pid };
  }

  private findConflict(file: string, agentGuard: boolean): Conflict | null {
    const host = this.lockHolder(file);
    if (host) return host;
    if (!agentGuard) return null;
    const tui = this.opts.afterPid;
    if (tui && tui !== process.pid && file === this.opts.session && pidAlive(tui)) return { chat: null, terminal: null, pid: tui };
    // A live lock of this same chat is an older instance of it; its agent is not a stranger.
    const own = readLock(file);
    if (own && own.chat === this.opts.chat && own.pid !== process.pid && pidAlive(own.pid)) return null;
    const agent = this.adapter.sessionHolder?.(file);
    return agent ? { chat: null, terminal: null, pid: agent.pid } : null;
  }

  private enterConflict(file: string, c: Conflict, why?: string): void {
    for (const t of this.startupTimers) clearTimeout(t);
    this.releaseLock();
    if (file !== this.state.sessionFile && this.timeline.items.length) this.replaceTimeline(this.newTimeline());
    const again = this.state.phase === "conflict" && JSON.stringify(this.state.conflict) === JSON.stringify(c);
    this.set({ phase: "conflict", conflict: c, sessionFile: file, error: null, handoff: null });
    this.dropQueue();
    if (!again) this.notice("warning", `${why ? why + "\n" : ""}${this.conflictText(c)} ${this.conflictWayOut(c)}`);
    this.terminalState("idle");
    this.opts.onSessionFile?.(file);
    this.readyResolve?.();
  }

  private conflictText(c: Conflict): string {
    if (c.chat) return `This session is open in another chat${c.terminal ? ` (terminal ${c.terminal})` : ""}.`;
    return `This session is open in ${this.agent} outside a chat${c.pid ? ` (pid ${c.pid})` : ""}.`;
  }

  private conflictWayOut(c: Conflict): string {
    return c.chat ? "Go to that chat, or use take_over to move it here." : "Quit it there, then use resume.";
  }

  /** take_over: close the other chat's host (through its registry), then open the session here. */
  async takeOver(): Promise<void> {
    const file = this.state.sessionFile;
    if (this.state.phase !== "conflict" || !file) throw new Error("Nothing to take over: no other chat has this session.");
    const c = this.lockHolder(file) ?? this.state.conflict;
    if (c?.pid && pidAlive(c.pid)) {
      if (!c.chat) throw new Error(`${this.conflictText(c)} Quit it there, then use resume.`);
      await this.closeOtherChat(c);
    }
    this.set({ conflict: null });
    this.start(file);
    await this.whenReady(30_000);
    const phase = this.state.phase as Phase; // start() changed it
    if (phase === "conflict" && this.state.conflict) throw new Error(this.conflictText(this.state.conflict));
    if (phase === "error") throw new Error(this.state.error ?? `${this.agent} failed to start`);
  }

  private async closeOtherChat(c: Conflict): Promise<void> {
    const where = c.terminal ? `terminal ${c.terminal}` : c.chat;
    const reg = this.opts.stateDir && c.chat ? readRegistry(this.opts.stateDir, c.chat) : null;
    if (!reg?.port || reg.pid !== c.pid) throw new Error(`Can't reach the other chat (${where}). Close it there, then use resume.`);
    const client = await ChatClient.connect(reg.port, reg.token, "host", 5000);
    try {
      await client.req("shutdown", {}, 5000);
    } finally {
      client.close();
    }
    const t0 = Date.now();
    while (pidAlive(c.pid!)) {
      if (Date.now() - t0 > 15_000) throw new Error(`The other chat (${where}) did not close. Close it there, then use resume.`);
      await new Promise((r) => setTimeout(r, 100));
    }
    this.opts.log(`took the session over from chat ${c.chat} (pid ${c.pid})`);
  }

  private stalledPrefixes(): string[] {
    return ["An extension is waiting", `${this.agent} did not answer`];
  }

  private bootedAt = Date.now();

  private async boot(gen: number, sessionFile: string | null): Promise<void> {
    for (const t of this.startupTimers) clearTimeout(t);
    this.startupTimers = [
      setTimeout(() => {
        if (gen !== this.generation || this.state.phase !== "starting") return;
        const d = this.dialogs[0];
        if (d) {
          const msg = `An extension is waiting for input during startup, which ${this.agent} RPC can't deliver: "${d.title}". Disable that extension or answer it in the TUI${d.timeoutAt ? ` (${this.agent} will resolve it itself when its timeout runs out)` : ""}.`;
          this.set({ error: msg });
          this.notice("warning", msg);
        } else {
          this.notice("warning", `${this.agent} is taking a long time to start.`);
        }
      }, STARTUP_DIALOG_HINT_MS),
      setTimeout(() => {
        if (gen !== this.generation || this.state.phase !== "starting") return;
        if (this.dialogs.length) return; // the hint already explains it; keep waiting
        const msg = `${this.agent} did not answer within 45 s of starting.`;
        this.set({ error: msg });
        this.notice("error", msg);
      }, STARTUP_TIMEOUT_MS),
    ];
    let info: Awaited<ReturnType<ProviderAdapter["start"]>>;
    try {
      info = await this.adapter.start(sessionFile, this.hostFor(gen));
    } catch (e) {
      if (gen !== this.generation) return;
      if (e instanceof AgentError && e.sessionBusy && sessionFile) {
        // The agent's own guard refused a second writer (Codex "active writer").
        // Taking over a TUI that just quit (Continue as chat): its agent may hold
        // the session a while longer (Codex's daemon: up to a minute), so try again.
        if (this.opts.afterPid && sessionFile === this.opts.session && Date.now() - this.bootedAt < 90_000) {
          await this.stopAgent();
          this.opts.log(`session busy after the TUI quit: trying again in 5 s`);
          setTimeout(() => { if (gen === this.generation) this.start(sessionFile); }, 5000).unref();
          return;
        }
        await this.stopAgent();
        this.enterConflict(sessionFile, this.lockHolder(sessionFile) ?? { chat: null, terminal: null, pid: null }, errText(e));
        return;
      }
      if (this.adapter.alive) this.fatal(`${this.agent} failed to start: ${errText(e)}`);
      return;
    }
    if (gen !== this.generation) return;
    for (const t of this.startupTimers) clearTimeout(t);
    if (this.stalledPrefixes().some((p) => this.state.error?.startsWith(p))) this.set({ error: null });
    this.refreshCommands();
    this.refreshStats();
    // Stay "starting" until the history is in, so a send can't race the timeline swap.
    if (sessionFile !== null || info.hasHistory) {
      try {
        const events = await this.adapter.history();
        if (gen !== this.generation) return;
        this.loadHistory(events);
      } catch (e) {
        this.notice("warning", `Could not load the session history: ${errText(e)}`);
      }
    }
    if (info.streaming && !this.runActive) {
      this.runActive = true;
      this.adapter.watchRun?.();
    }
    if (this.state.phase === "starting") this.set({ phase: this.runActive || info.streaming ? "working" : "idle" });
    this.readyResolve?.();
  }

  /** History's user messages with their skills split off, as live ones are. */
  private historyWithSkills(events: NormalizedEvent[]): NormalizedEvent[] {
    return events.map((ev) => (ev.type === "user_message" ? { ...ev, ...this.withSkill(ev.text, ev.skill) } : ev));
  }

  private loadHistory(events: NormalizedEvent[]): void {
    const t = this.newTimeline();
    t.load(this.historyWithSkills(events));
    // Keep what arrived during startup (extension notices) after the history.
    const keep = this.timeline.items.filter((i) => i.kind === "notice");
    for (const it of keep) {
      t.items.push(it);
      t.byId.set(it.id, it);
    }
    this.replaceTimeline(t);
  }

  private setLock(file: string | null): void {
    if (file === this.lockedFile) return;
    if (this.lockedFile) releaseLock(this.lockedFile);
    this.lockedFile = file;
    if (file) {
      const other = takeLock(file, { pid: process.pid, chat: this.opts.chat, terminal: this.opts.terminal, startedAt: Date.now() });
      if (other) this.notice("warning", `This session is also open in another chat (pid ${other.pid}${other.terminal ? `, terminal ${other.terminal}` : ""}). Two writers can corrupt it.`);
    }
    this.opts.onSessionFile?.(file);
  }

  releaseLock(): void {
    if (this.lockedFile) releaseLock(this.lockedFile);
    this.lockedFile = null;
  }

  private fatal(msg: string): void {
    this.set({ phase: "error", error: msg });
    this.notice("error", msg);
  }

  private onExit(ev: EventOf<"exited">): void {
    for (const t of this.startupTimers) clearTimeout(t);
    this.clearDialogs(false);
    const wasStarting = this.state.phase === "starting";
    this.runActive = false;
    this.expectRun = 0;
    this.timeline.autonomous = false;
    this.timeline.closeOpen("exited", this.agent);
    this.releaseLock();
    this.readyResolve?.();
    if (this.stopping) {
      this.schedule();
      return;
    }
    const why = ev.spawnError
      ? `Could not start ${this.agent} (${ev.command ?? this.adapter.id}): ${ev.spawnError}`
      : `${this.agent} ${wasStarting ? "failed to start" : "exited"} (${ev.signal ? `signal ${ev.signal}` : `code ${ev.code}`})`;
    const tail = stripAnsi(ev.stderrTail).trim().split("\n").filter(Boolean).slice(-3).join("\n");
    const msg = tail ? `${why}: ${tail}` : why;
    this.opts.log(msg);
    this.set({ phase: wasStarting || ev.spawnError ? "error" : "exited", error: msg });
    this.dropQueue();
    this.onTerminalState("error", why);
    this.notice("error", `${msg}\nSend a message or use /reload to restart ${this.agent} on this session.`);
  }

  async stopAgent(): Promise<void> {
    if (!this.adapter.alive) return;
    this.stopping = true;
    this.generation++;
    await this.adapter.dispose();
    this.runActive = false;
    this.expectRun = 0;
    this.clearDialogs(false);
    this.timeline.closeOpen("aborted", this.agent);
    this.releaseLock();
    this.dropQueue();
  }

  /** Synchronous last resort (process exit handlers). */
  killAgent(): void {
    this.adapter.kill();
  }

  /** Waits until the agent answered (or exited). */
  whenReady(timeoutMs = 60_000): Promise<void> {
    return Promise.race([this.ready, new Promise<void>((r) => setTimeout(r, timeoutMs))]);
  }

  // ---------------------------------------------------------------- events

  private onEvent(ev: NormalizedEvent): void {
    switch (ev.type) {
      case "heartbeat":
        this.activity++;
        return;
      case "run_started":
        this.onRunStart();
        return;
      case "run_settled":
        this.settle(ev.aborted);
        return;
      case "run_cause":
        this.setCause(ev.text);
        return;
      case "turn_end":
        this.refreshStats();
        return;
      case "queue_changed":
        this.agentQueue = ev;
        this.publishQueue();
        return;
      case "user_message":
        if (ev.source || ev.parent) {
          this.timeline.apply({ ...ev, ...this.withSkill(ev.text, ev.skill), source: ev.source ?? "extension" });
          this.schedule();
        } else this.onUserEcho(ev);
        return;
      case "compaction":
        this.onCompaction(ev);
        return;
      case "retry":
        this.onRetry(ev);
        return;
      case "notice": {
        if (ev.once === "run") {
          const key = `${ev.source}:${ev.level}`;
          if (this.onceRun.get(key) === this.runSeq) return;
          this.onceRun.set(key, this.runSeq);
        }
        this.notice(ev.level, ev.text, ev.source);
        return;
      }
      case "ask":
        this.onAsk(ev.ask);
        return;
      case "ask_closed":
        this.removeDialog(ev.id);
        return;
      case "status":
        if (ev.text !== null) this.statusMap.set(ev.key, toSpans(ev.text.replace(/\n/g, " ")));
        else this.statusMap.delete(ev.key);
        this.set({ statuses: [...this.statusMap].map(([k, spans]) => ({ key: k, spans })) });
        return;
      case "widget":
        if (ev.lines) this.widgetMap.set(ev.key, { placement: ev.placement, lines: toSpanLines(ev.lines.slice(0, 200)) });
        else this.widgetMap.delete(ev.key);
        this.set({ widgets: [...this.widgetMap].map(([k, w]) => ({ key: k, ...w })) });
        return;
      case "title":
        this.set({ title: ev.text ? stripAnsi(ev.text) : null });
        return;
      case "editor_text":
        this.set({ editorText: ev.text });
        return;
      case "session": {
        const patch: Partial<ChatState> = {};
        if (ev.id !== undefined) this.sessionId = ev.id;
        if (ev.name !== undefined) patch.sessionName = ev.name;
        if (ev.file !== undefined) patch.sessionFile = ev.file;
        this.set(patch);
        if (ev.file !== undefined) this.setLock(ev.file);
        return;
      }
      case "model":
        this.set({ model: ev.model });
        return;
      case "thinking":
        this.set({ thinking: ev.level });
        return;
      case "permission_mode":
        this.set({ permissionMode: ev.mode });
        return;
      case "capabilities":
        this.set({ capabilities: { ...this.state.capabilities, ...ev.capabilities } });
        this.set({ commands: this.menu() });
        return;
      case "version":
        this.set({ agentVersion: ev.version });
        this.opts.onVersion?.(ev.version);
        return;
      case "exited":
        this.onExit(ev);
        return;
    }
    if (this.timeline.apply(ev)) {
      if (ev.type === "assistant_end" && ev.stopReason === "error") this.lastRunError = ev.error ?? "error";
      this.schedule();
    }
  }

  /** The lanes: the agent's queue, then the follow-ups the host holds, with each one's id, sender and whether it can be taken back. */
  private publishQueue(): void {
    const ev = this.agentQueue;
    const steering = ev.steering;
    const followUp = [...ev.followUp, ...this.held.map((h) => h.text)];
    if (!steering.length && !followUp.length) {
      this.set({ queue: { steering: [], followUp: [] } });
      return;
    }
    const steeringIds = steering.map((_, i) => ev.steeringIds?.[i] ?? null);
    const followUpIds = [...ev.followUp.map((_, i) => ev.followUpIds?.[i] ?? null), ...this.held.map((h) => h.id)];
    const fromOf = (id: string | null): string | null => (id && (this.unconfirmed.get(id)?.from ?? this.held.find((h) => h.id === id)?.from)) || null;
    const q: Queue = {
      steering, followUp, steeringIds, followUpIds,
      steeringRemovable: steeringIds.map((id) => this.removable(id)), followUpRemovable: followUpIds.map((id) => this.removable(id)),
    };
    const steeringFrom = steeringIds.map(fromOf);
    const followUpFrom = followUpIds.map(fromOf);
    if ([...steeringFrom, ...followUpFrom].some(Boolean)) Object.assign(q, { steeringFrom, followUpFrom });
    this.set({ queue: q });
  }

  /** The host can take this queued message back now: one it holds, or the agent's where the agent allows it. */
  private removable(id: string | null): boolean {
    if (!id) return false;
    if (this.held.some((h) => h.id === id)) return true;
    return this.unconfirmed.has(id) && this.adapter.alive && (this.adapter.canRemoveQueued?.(id) ?? false);
  }

  /** The agent's queue is gone (it exited, or another writer has the session); held follow-ups go back to the composer. */
  private dropQueue(): void {
    this.agentQueue = NO_QUEUE;
    this.returnHeld();
    this.publishQueue();
  }

  /** The held follow-ups go back to the composer, unsent: the run was stopped or failed, or the agent went away. */
  private returnHeld(): void {
    if (!this.held.length) return;
    const texts = this.held.map((h) => h.text);
    this.held = [];
    this.set({ editorText: [this.state.editorText, ...texts].filter(Boolean).join("\n\n") });
    this.publishQueue();
  }

  /** Idle with follow-ups held: send the next one as a prompt. One per run; the next waits for this one's run to settle. */
  private drainHeld(): void {
    if (this.busy || this.heldSending || !this.held.length || !this.adapter.alive) return;
    // Until `send` answers (it may wait for images before the phase says working), no second one goes.
    this.heldSending = true;
    const h = this.held.shift()!;
    this.publishQueue();
    let returned = false;
    const giveBack = () => {
      if (returned) return;
      returned = true;
      this.set({ editorText: [this.state.editorText, h.text].filter(Boolean).join("\n\n") });
    };
    this.send({ text: h.text, images: h.images, mode: "auto", source: "queued", from: h.from }, { onRejected: giveBack })
      .catch((e) => {
        if (!returned) this.notice("error", `Could not send the follow-up: ${errText(e)}`);
        giveBack();
      })
      .finally(() => {
        this.heldSending = false;
        this.drainHeld(); // its run may have settled already
      });
  }

  private onCompaction(ev: EventOf<"compaction">): void {
    if (ev.phase === "start") {
      this.compactionNotice = this.timeline.addNotice("info", "compaction", ev.reason === "overflow" ? "Context overflow: compacting the conversation…" : "Compacting the conversation…").id;
      this.set({ phase: "compacting" });
      this.schedule();
      return;
    }
    const text = ev.outcome === "done"
      ? ev.tokensBefore === undefined
        ? "Compacted the conversation."
        : `Compacted the conversation: ${Math.round(ev.tokensBefore / 1000)}k → ${Math.round((ev.tokensAfter ?? 0) / 1000)}k tokens.`
      : ev.outcome === "aborted"
        ? "Compaction cancelled."
        : `Compaction failed: ${ev.error ?? "unknown error"}`;
    const level = ev.outcome === "failed" ? "error" : "info";
    if (this.compactionNotice) this.timeline.updateNotice(this.compactionNotice, { text, level });
    else this.timeline.addNotice(level, "compaction", text);
    this.compactionNotice = null;
    this.set({ phase: this.runActive ? "working" : "idle" });
    this.refreshStats();
    if (!this.runActive && this.held.length) this.drainHeld();
    else if (!this.runActive) this.terminalState("idle");
  }

  private onRetry(ev: EventOf<"retry">): void {
    if (ev.phase === "start") {
      const text = `Retrying (attempt ${ev.attempt}/${ev.maxAttempts ?? "?"}) in ${Math.round(ev.delayMs / 100) / 10} s: ${ev.error}`;
      if (this.retryNotice) this.timeline.updateNotice(this.retryNotice, { text, level: "warning" });
      else this.retryNotice = this.timeline.addNotice("warning", "retry", text).id;
      this.schedule();
      return;
    }
    const text = ev.success ? `Retry succeeded (attempt ${ev.attempt ?? "?"}).` : `Retry failed: ${ev.error ?? "error"}`;
    if (this.retryNotice) this.timeline.updateNotice(this.retryNotice, { text, level: ev.success ? "info" : "error" });
    else this.timeline.addNotice(ev.success ? "info" : "error", "retry", text);
    this.retryNotice = null;
    this.schedule();
  }

  private onRunStart(): void {
    if (this.runActive) return; // a nested low-level run (retry, follow-up) in the same session-level run
    this.runActive = true;
    this.runAborted = false;
    this.runSeq++;
    this.lastRunError = null;
    this.clearCommandHint();
    if (this.expectRun > 0) {
      this.expectRun--;
      this.timeline.autonomous = false;
      this.autonomousNotice = null;
    } else {
      this.timeline.autonomous = true;
      this.autonomousCause = null;
      this.autonomousNotice = this.timeline.addNotice("info", "host", `${this.agent} started a run on its own.`).id;
    }
    this.set({ phase: "working" });
    this.terminalState("working");
  }

  private setCause(text: string): void {
    if (!this.autonomousNotice || this.autonomousCause) return;
    this.autonomousCause = text;
    this.timeline.updateNotice(this.autonomousNotice, { text });
  }

  /** A user message's skill: the adapter's, else the one its text starts with (by the chat's skill commands). */
  private withSkill(text: string, skill?: SkillRef): { text: string; skill?: SkillRef } {
    if (skill) return { text, skill };
    return splitSkill(text, this.state.commands.filter((c) => c.source === "skill").map((c) => c.name)) ?? { text };
  }

  /** The echo of a message: confirms (and enriches) the item `send` showed, adds a queued one's, or adds one from elsewhere. */
  private onUserEcho(ev: EventOf<"user_message">): void {
    const p = ev.clientId ? this.unconfirmed.get(ev.clientId) : undefined;
    if (p) this.unconfirmed.delete(ev.clientId!);
    const shown = p?.item ? this.timeline.get(p.item) : undefined;
    const { text, skill } = this.withSkill(ev.text, ev.skill);
    if (shown?.kind === "user") this.timeline.confirmUser(shown, text, ev.imageBlocks ?? [], ev.ts, skill);
    else this.timeline.addUser(text, ev.images, p ? p.source : "extension", p?.from, ev.ts ?? Date.now(), ev.imageBlocks ?? [], skill);
    if (p?.from) this.setCause(`Started by a message from ${p.from}.`);
    else if (!p && this.adapter.unsentMessageCause) this.setCause(this.adapter.unsentMessageCause);
    this.schedule();
  }

  private settle(aborted: boolean): void {
    const wasRun = this.runActive || this.state.phase === "working";
    // A dialog opened inside this run can't outlive it (an aborted hook); cancel it.
    for (const [id, run] of [...this.dialogRun]) {
      if (run === this.runSeq) {
        this.adapter.answer(id, { cancelled: true });
        this.removeDialog(id);
      }
    }
    this.runActive = false;
    this.expectRun = 0;
    this.timeline.autonomous = false;
    this.autonomousNotice = null;
    const stopped = aborted || this.runAborted;
    this.timeline.closeOpen(stopped ? "aborted" : "settled", this.agent);
    if (this.state.phase === "working" || this.state.phase === "starting") this.set({ phase: "idle" });
    this.clearCommandHint();
    this.refreshStats();
    this.schedule();
    // Stopped (from elsewhere: our own abort took them already) or failed: the follow-ups wait in the composer.
    if (stopped || this.lastRunError) this.returnHeld();
    // The next follow-up continues the work: no "done" in between.
    if (this.held.length && this.adapter.alive) return this.drainHeld();
    if (wasRun) this.terminalState(stopped ? "idle" : this.lastRunError ? "error" : "done", this.lastRunError ?? undefined);
  }

  // ---------------------------------------------------------------- dialogs (asks)

  private onAsk(ask: Ask): void {
    const id = ask.id;
    const title = stripAnsi(ask.title) || `${this.agent} asks`;
    let d: Dialog;
    switch (ask.kind) {
      case "permission": {
        let tool: PermissionDialog["tool"];
        if (ask.tool) {
          const p = presentTool(this.adapter.tools, ask.tool.name, ask.tool.args, this.opts.cwd);
          tool = { name: ask.tool.name, title: p.title, detail: p.detail, ...(ask.tool.args !== undefined ? { args: prettyArgs(ask.tool.args) } : {}) };
        }
        d = {
          id, method: "permission", title, ...(ask.message !== undefined ? { message: stripAnsi(ask.message) } : {}),
          ...(tool ? { tool } : {}), choices: ask.choices.map((c) => ({ ...c, label: stripAnsi(c.label) })),
        };
        break;
      }
      case "questions":
        d = { id, method: "questions", title, questions: ask.questions };
        break;
      default: {
        const x: ExtensionDialog = { id, method: ask.kind, title };
        if (typeof ask.message === "string") x.message = stripAnsi(ask.message);
        if (Array.isArray(ask.options)) x.options = ask.options.map((o) => stripAnsi(o));
        if (typeof ask.placeholder === "string") x.placeholder = ask.placeholder;
        if (typeof ask.prefill === "string") x.prefill = ask.prefill;
        d = x;
      }
    }
    if (ask.timeoutAt !== undefined) {
      d.timeoutAt = ask.timeoutAt;
      // The agent resolves it itself at the timeout; drop it then.
      this.dialogTimers.set(id, setTimeout(() => this.removeDialog(id), Math.max(0, ask.timeoutAt - Date.now())));
    }
    this.dialogs.push(d);
    if (this.runActive) this.dialogRun.set(id, this.runSeq);
    this.clearCommandHint();
    this.syncDialogs();
  }

  private syncDialogs(): void {
    this.set({ dialog: this.dialogs[0] ?? null, dialogsPending: this.dialogs.length });
    const d = this.dialogs[0];
    if (d) this.terminalState("blocked", d.title);
    else this.terminalState(this.runActive || this.state.phase === "working" || this.state.phase === "compacting" ? "working" : "idle");
  }

  private removeDialog(id: string): boolean {
    const i = this.dialogs.findIndex((d) => d.id === id);
    const t = this.dialogTimers.get(id);
    if (t) clearTimeout(t);
    this.dialogTimers.delete(id);
    this.dialogRun.delete(id);
    if (i < 0) return false;
    this.dialogs.splice(i, 1);
    this.syncDialogs();
    return true;
  }

  private clearDialogs(answer: boolean): void {
    for (const d of [...this.dialogs]) {
      if (answer) this.adapter.answer(d.id, { cancelled: true });
      this.removeDialog(d.id);
    }
  }

  /** The terminal title: session name, else the extension title, else the first prompt, else the agent's name. */
  chatTitle(): string {
    const pick = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
    const name = pick(this.state.sessionName) || pick(this.state.title);
    if (name) return name;
    const first = this.timeline.items.find((i) => i.kind === "user");
    const text = first && first.kind === "user" ? pick(first.text) || pick(first.skill && `/${first.skill.command}`) : "";
    if (text) return text.length > 60 ? text.slice(0, 59) + "…" : text;
    return this.agent;
  }

  // ---------------------------------------------------------------- terminal status hook

  onTerminalState: (state: "working" | "blocked" | "done" | "error" | "idle", msg?: string) => void = () => {};
  private terminalState(state: "working" | "blocked" | "done" | "error" | "idle", msg?: string): void {
    if (this.dialogs.length && state !== "blocked") {
      this.onTerminalState("blocked", this.dialogs[0]!.title);
      return;
    }
    this.onTerminalState(state, msg ?? (state === "working" || state === "done" ? this.state.sessionName ?? undefined : undefined));
  }

  // ---------------------------------------------------------------- stats & commands

  private refreshStats(): void {
    if (!this.adapter.alive) return;
    if (this.statsBusy) {
      this.statsAgain = true;
      return;
    }
    this.statsBusy = true;
    this.adapter
      .usage()
      .then((u) => {
        this.set({
          usage: {
            contextTokens: u.contextTokens,
            contextWindow: u.contextWindow ?? this.state.model?.contextWindow ?? null,
            percent: u.percent,
            cost: u.cost,
          },
        });
      })
      .catch(() => {})
      .finally(() => {
        this.statsBusy = false;
        if (this.statsAgain) {
          this.statsAgain = false;
          this.refreshStats();
        }
      });
  }

  private refreshCommands(): void {
    if (!this.adapter.alive) return;
    this.adapter
      .commands()
      .then((list) => {
        this.agentCommands = list;
        this.set({ commands: this.menu() });
      })
      .catch(() => {});
  }

  private clearCommandHint(): void {
    if (this.commandHint) clearTimeout(this.commandHint);
    this.commandHint = null;
  }

  // ---------------------------------------------------------------- ops

  private requireAgent(): ProviderAdapter {
    if (!this.adapter.alive) {
      if (this.state.phase === "handoff") {
        const t = this.state.handoff?.terminal;
        throw new Error(`${this.agent} is open in the terminal UI${t ? ` (terminal ${t})` : ""}. Quit it there, or use resume (Return to chat) to come back.`);
      }
      if (this.state.phase === "conflict" && this.state.conflict) throw new Error(`${this.conflictText(this.state.conflict)} ${this.conflictWayOut(this.state.conflict)}`);
      throw new Error(`${this.agent} is not running. Use /reload to restart it.`);
    }
    return this.adapter;
  }

  private get busy(): boolean {
    return this.runActive || this.state.phase === "working" || this.state.phase === "compacting";
  }

  /** `onRejected`: the agent refused the message after it was sent (the timeline item is gone again). */
  async send(args: { text?: string; images?: string[]; mode?: string; source?: UserSource; from?: string }, opts: { onRejected?: () => void } = {}): Promise<{ disposition: string }> {
    const text = String(args.text ?? "");
    const imagePaths = Array.isArray(args.images) ? args.images.map(String) : [];
    if (!text.trim() && !imagePaths.length) throw new Error("Nothing to send");
    // A follow-up while working: the host holds it (a command too: it runs after the run) and sends it when the run settles.
    if (args.mode === "followUp" && this.busy && this.adapter.alive) {
      this.held.push({ id: randomUUID(), text, images: imagePaths, ...(args.from ? { from: args.from } : {}) });
      this.publishQueue();
      return { disposition: "queued" };
    }
    const builtin = imagePaths.length ? null : parseBuiltin(text, this.state.commands.filter((c) => c.source === "builtin"));
    if (builtin) {
      await this.runBuiltin(builtin.name, builtin.rest);
      // No run, so no settle sends the next follow-up (a compaction's end does).
      if (builtin.name !== "compact") this.drainHeld();
      return { disposition: "handled" };
    }
    if (this.state.phase === "exited" || (this.state.phase === "error" && !this.adapter.alive)) {
      this.start(this.state.sessionFile);
      await this.whenReady(30_000);
    }
    if (this.state.phase === "starting") await this.whenReady(30_000);
    const agent = this.requireAgent();
    let message = text;
    let images: ImageBlock[] = imagePaths.length ? (await loadImages(imagePaths)).map((i) => ({ data: i.data, mimeType: i.mimeType })) : [];
    if (images.length && !this.state.capabilities.images) {
      message += (message ? "\n\n" : "") + imagePaths.map((p) => `[Image available at: ${p}]`).join("\n");
      images = [];
    }
    const mode = args.mode === "steer" || args.mode === "followUp" ? args.mode : "auto";
    const working = this.busy;
    const source: UserSource = working ? "queued" : args.source ?? "composer";
    // The message is on the timeline at once (the agent may echo it seconds later, when its turn starts); the echo confirms it.
    const id = randomUUID();
    const sent: Sent = { source, text, images: imagePaths, ...(args.from ? { from: args.from } : {}) };
    if (!working) {
      const shown = this.withSkill(message);
      sent.item = this.timeline.addUser(shown.text, images.length, source, args.from, Date.now(), images, shown.skill).id;
      this.urgent();
    }
    this.unconfirmed.set(id, sent);
    if (this.unconfirmed.size > MAX_UNCONFIRMED) this.unconfirmed.delete(this.unconfirmed.keys().next().value!);
    const counted = !working;
    if (counted) {
      this.expectRun++;
      this.set({ phase: "working" });
      this.terminalState("working");
    }
    const isCommand = /^\/\S/.test(message);
    if (isCommand) {
      this.clearCommandHint();
      const rev = this.activity;
      this.commandHint = setTimeout(() => {
        if (rev === this.activity && !this.dialogs.length) {
          this.notice("warning", `${message.split(/\s/)[0]} hasn't answered. It may need ${this.agent}'s terminal UI: use /tui to open the session there, or press Esc to stop.`);
        }
      }, COMMAND_HINT_MS);
    }
    const undo = () => {
      this.unconfirmed.delete(id);
      if (sent.item && this.timeline.remove(sent.item)) this.schedule();
      if (counted && this.expectRun > 0 && !this.runActive) {
        this.expectRun--;
        if (this.expectRun === 0 && this.state.phase === "working") {
          this.set({ phase: "idle" });
          this.terminalState("idle");
        }
      }
    };
    const reply = agent.prompt({ id, text: message, images, mode, busy: working }).then((d) => {
      if (isCommand) this.clearCommandHint();
      if (d.disposition === "handled") {
        undo();
        // An extension command answered without a run: no settle will send the next follow-up.
        this.drainHeld();
      }
      return { disposition: String(d.disposition) };
    });
    const exited = (e: unknown) => e instanceof AgentError && e.agentExited;
    reply.catch((e) => {
      if (isCommand) this.clearCommandHint();
      undo();
      opts.onRejected?.();
      if (!exited(e)) {
        this.toast("error", errText(e));
        this.notice("error", `${this.agent} rejected the message: ${errText(e)}`);
      }
    });
    const pending = new Promise<{ disposition: string }>((r) => setTimeout(() => r({ disposition: "pending" }), SEND_REPLY_WAIT_MS));
    // The agent exiting before it replies is reported by the exit notice, not as a failed send.
    const settled = reply.catch((e) => {
      if (exited(e)) return { disposition: "pending" };
      throw e;
    });
    return Promise.race([settled, pending]);
  }

  private async runBuiltin(name: string, rest: string): Promise<void> {
    switch (name) {
      case "compact":
        return this.compact(rest || undefined);
      case "new":
      case "clear":
        return this.newSession();
      case "name":
        if (!rest) throw new Error("Usage: /name <name>");
        return this.setName(rest);
      case "reload":
        return this.resume();
      case "model": {
        const m = /^([^/\s]+)\/(\S+)$/.exec(rest);
        if (m) return this.setModel(m[1]!, m[2]!);
        break;
      }
      case "thinking":
        if (rest) return this.setThinking(rest);
        break;
    }
    this.toast("info", `/${name} is available in the chat window.`);
  }

  async abort(): Promise<{ restored: string[] }> {
    if (!this.adapter.alive) return { restored: [] };
    // The held follow-ups first: none of them may start a run when this one settles.
    const held = this.held.map((h) => h.text);
    this.held = [];
    const restored = [...(await this.adapter.clearQueue()), ...held];
    // The queue is gone (its texts go back to the composer): none of it will be echoed.
    for (const [id, p] of this.unconfirmed) if (p.source === "queued") this.unconfirmed.delete(id);
    this.agentQueue = NO_QUEUE;
    this.publishQueue();
    this.clearDialogs(true);
    if (this.busy || this.expectRun > 0) {
      this.runAborted = true;
      this.adapter.abort();
    }
    return { restored };
  }

  // ---------------------------------------------------------------- the queue's rows

  /** Takes a queued message out of its lane: a held follow-up, or one the agent lets go of. Its text and images are returned. */
  private async takeQueued(id: string): Promise<{ lane: "steer" | "followUp"; text: string; images: string[]; from?: string }> {
    if (!id) throw new Error("Which message? Pass `message`: its id from state.queue");
    const i = this.held.findIndex((h) => h.id === id);
    if (i >= 0) {
      const [h] = this.held.splice(i, 1);
      this.publishQueue();
      return { lane: "followUp", text: h!.text, images: h!.images, ...(h!.from ? { from: h!.from } : {}) };
    }
    const q = this.agentQueue;
    const lane = q.steeringIds?.includes(id) ? "steer" : q.followUpIds?.includes(id) ? "followUp" : null;
    const sent = this.unconfirmed.get(id);
    if (!lane || !sent) throw new Error("That message is no longer queued");
    if (!this.adapter.alive || !this.adapter.removeQueued || !(this.adapter.canRemoveQueued?.(id) ?? false)) {
      throw new Error(`${this.agent} can't take back a message it already has: it gets it at its next step.`);
    }
    if (!(await this.adapter.removeQueued(id))) throw new Error(`Too late: ${this.agent} already took that message.`);
    this.unconfirmed.delete(id);
    this.publishQueue();
    return { lane, text: sent.text, images: sent.images, ...(sent.from ? { from: sent.from } : {}) };
  }

  /** queue_remove: the row's ×. */
  async queueRemove(id: string): Promise<Record<string, never>> {
    await this.takeQueued(id);
    return {};
  }

  /** queue_edit: a click on the row. It leaves the queue; its text and images go back to the composer, and sending again re-queues it. */
  async queueEdit(id: string): Promise<{ text: string; images: string[] }> {
    const m = await this.takeQueued(id);
    return { text: m.text, images: m.images };
  }

  /** queue_move: the row's ⇄. A follow-up becomes a steer now; a steer the agent gives back waits for the run's end. */
  async queueMove(id: string, to: string): Promise<Record<string, never>> {
    if (to !== "steer" && to !== "followUp") throw new Error("queue_move needs `to`: \"steer\" or \"followUp\"");
    const inLane = to === "steer" ? this.agentQueue.steeringIds?.includes(id) : this.held.some((h) => h.id === id) || this.agentQueue.followUpIds?.includes(id);
    if (inLane) return {};
    const m = await this.takeQueued(id);
    const args = { text: m.text, images: m.images, ...(m.from ? { from: m.from } : {}) };
    if (to === "steer") await this.send({ ...args, mode: "steer" });
    else await this.send({ ...args, mode: "followUp" }); // held while working; sent now if the run just ended
    return {};
  }

  dialogAnswer(args: { dialog?: string; value?: unknown; confirmed?: unknown; cancelled?: unknown; choice?: unknown; message?: unknown; answers?: unknown }): Record<string, never> {
    const id = String(args.dialog ?? "");
    const d = this.dialogs.find((x) => x.id === id);
    if (!d) throw new Error("That dialog is no longer open");
    const agent = this.requireAgent();
    let resp: AskAnswer;
    if (args.cancelled === true) resp = { cancelled: true };
    else if (d.method === "confirm") {
      if (typeof args.confirmed !== "boolean") throw new Error("confirm needs `confirmed: true|false`");
      resp = { confirmed: args.confirmed };
    } else if (d.method === "permission") {
      if (typeof args.choice !== "string" || !d.choices.some((c) => c.id === args.choice)) throw new Error("permission needs `choice`: one of the choice ids");
      resp = { choice: args.choice, ...(typeof args.message === "string" && args.message ? { message: args.message } : {}) };
    } else if (d.method === "questions") {
      const a = args.answers;
      if (!a || typeof a !== "object" || Array.isArray(a)) throw new Error("questions needs `answers: {questionId: string | string[]}`");
      const answers: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(a as Rec)) {
        if (typeof v === "string" || (Array.isArray(v) && v.every((x) => typeof x === "string"))) answers[k] = v;
        else throw new Error(`Answer for ${k} must be a string or a list of strings`);
      }
      resp = { answers };
    } else {
      if (typeof args.value !== "string") throw new Error(`${d.method} needs a string \`value\``);
      if (d.method === "select" && d.options && !d.options.includes(args.value)) throw new Error("Not one of the options");
      resp = { value: args.value };
    }
    agent.answer(id, resp);
    this.removeDialog(id);
    return {};
  }

  ackEditorText(): Record<string, never> {
    this.set({ editorText: null });
    return {};
  }

  async models(): Promise<{ models: AgentModel[] }> {
    return { models: await this.requireAgent().listModels() };
  }

  async setModel(provider: string, id: string): Promise<void> {
    await this.requireAgent().setModel(provider, id);
    this.refreshStats();
  }

  async setThinking(level: string): Promise<void> {
    await this.requireAgent().setThinking(level);
  }

  async setPermissionMode(mode: string): Promise<void> {
    if (!mode) throw new Error("set_permission_mode needs `mode`");
    const known = this.state.capabilities.permissionModes;
    if (!known.some((m) => m.id === mode)) throw new Error(known.length ? `Not one of the permission modes: ${known.map((m) => m.id).join(", ")}` : `${this.agent} has no permission modes`);
    await this.requireAgent().setPermissionMode(mode);
  }

  async compact(instructions?: string): Promise<void> {
    const agent = this.requireAgent();
    if (this.runActive) throw new Error(`Wait until ${this.agent} is done, or press Esc, before compacting.`);
    if (instructions && !this.state.capabilities.compactInstructions) throw new Error(`${this.agent} compacts without instructions: send /compact alone.`);
    agent.compact(instructions).catch((e) => {
      if (this.state.phase === "compacting") this.set({ phase: "idle" });
      this.drainHeld();
      this.toast("error", `Compaction failed: ${errText(e)}`);
      if (!this.compactionNotice) this.notice("error", `Compaction failed: ${errText(e)}`);
    });
  }

  private async afterSessionChange(): Promise<void> {
    let events: NormalizedEvent[] = [];
    try {
      events = await this.requireAgent().history();
    } catch {}
    const t = this.newTimeline();
    t.load(this.historyWithSkills(events));
    // Extension statuses and widgets are UI state; they survive a session change like in the TUI.
    this.replaceTimeline(t);
    this.set({ usage: null, editorText: null, phase: "idle" });
    this.refreshCommands();
    this.refreshStats();
  }

  async newSession(): Promise<void> {
    if (this.state.phase === "conflict") {
      this.replaceTimeline(this.newTimeline());
      this.start(null);
      await this.whenReady(30_000);
      return;
    }
    const agent = this.requireAgent();
    if (this.runActive) await this.abort();
    await agent.newSession();
    await this.afterSessionChange();
  }

  async switchSession(path: string): Promise<void> {
    if (!path) throw new Error("switch_session needs `path`");
    if (this.state.phase === "conflict") {
      if (path !== this.state.sessionFile) this.replaceTimeline(this.newTimeline());
      this.start(path);
      await this.whenReady(30_000);
      return;
    }
    const agent = this.requireAgent();
    const conflict = path === this.state.sessionFile ? null : this.findConflict(path, true);
    if (conflict) {
      if (this.runActive) await this.abort();
      await this.stopAgent();
      this.enterConflict(path, conflict);
      return;
    }
    if (this.runActive) await this.abort();
    try {
      await agent.switchSession(path);
    } catch (e) {
      if (!(e instanceof AgentError && e.sessionBusy)) throw e;
      await this.stopAgent();
      this.enterConflict(path, this.lockHolder(path) ?? { chat: null, terminal: null, pid: null }, errText(e));
      return;
    }
    await this.afterSessionChange();
  }

  async setName(name: string): Promise<void> {
    await this.requireAgent().setName(name);
  }

  /** /fork's list: the person's messages in this session, newest first. */
  async forkPoints(): Promise<{ points: ForkPoint[] }> {
    const agent = this.requireAgent();
    if (!agent.forkPoints || !agent.fork) throw new Error(`${this.agent} can't fork from the chat`);
    return { points: (await agent.forkPoints()).reverse().map((p) => ({ id: p.id, text: this.asTyped(p.text) })) };
  }

  /** A message as the person would type it again: a skill as its `/command`. */
  private asTyped(text: string): string {
    const s = this.withSkill(text);
    return typedText(s.text, s.skill);
  }

  /** A new session holding what came before that message; its text goes back to the client's composer. */
  async fork(point: string): Promise<{ text: string }> {
    if (!point) throw new Error("fork needs `point`: an id from fork_points");
    const agent = this.requireAgent();
    if (!agent.fork) throw new Error(`${this.agent} can't fork from the chat`);
    if (this.runActive) await this.abort();
    const { text } = await agent.fork(point);
    await this.afterSessionChange();
    this.notice("info", "Forked: a new session up to that message. The original is unchanged (/resume).");
    return { text: this.asTyped(text) };
  }

  async sessions(): Promise<{ sessions: SessionInfo[] }> {
    return { sessions: await this.adapter.listSessions(this.state.sessionFile) };
  }

  async filesOp(query: string, limit?: number): Promise<{ files: string[] }> {
    return { files: await this.files.search(String(query ?? ""), typeof limit === "number" ? limit : 50) };
  }

  async clipboardImage(): Promise<{ path: string | null }> {
    return { path: await clipboardImage() };
  }

  history(before: string, limit?: number): { items: Item[]; hasOlder: boolean } {
    const r = this.timeline.older(String(before ?? ""), typeof limit === "number" && limit > 0 ? Math.min(limit, 500) : 100);
    for (const it of r.items) this.render.prepare(it);
    return structuredClone(r);
  }

  toolOutput(itemId: string): { text: string } {
    const it = this.timeline.get(String(itemId ?? ""));
    if (!it || it.kind !== "tool") throw new Error("No such tool item");
    return { text: this.timeline.fullOutput.get(it.id) ?? it.output };
  }

  // ---------------------------------------------------------------- hand-off to the agent's TUI

  /** Where the TUI reports the session it is on (Pi's lock extension, HERDR_CHAT_HANDOFF). */
  private handoffPath(): string | null {
    return this.opts.stateDir ? join(this.opts.stateDir, "handoff", `${this.opts.chat}.json`) : null;
  }

  private readHandoffFile(): { sessionFile?: string; pid?: number } | null {
    const p = this.handoffPath();
    if (!p) return null;
    try {
      const r = JSON.parse(readFileSync(p, "utf8"));
      return r && typeof r === "object" ? r : null;
    } catch {
      return null;
    }
  }

  private handoffTimer: NodeJS.Timeout | null = null;
  private handoffBusy = false;
  private hcFailures = 0;

  private watchHandoff(): void {
    this.stopHandoffWatch();
    this.hcFailures = 0;
    this.handoffTimer = setInterval(() => void this.handoffTick(), this.opts.handoffPollMs ?? 2000);
    this.handoffTimer.unref();
  }

  private stopHandoffWatch(): void {
    if (this.handoffTimer) clearInterval(this.handoffTimer);
    this.handoffTimer = null;
  }

  /** One look at the hand-off: resume once the TUI's terminal is finished or gone and no TUI process is left. */
  private async handoffTick(): Promise<void> {
    const h = this.state.handoff;
    if (this.state.phase !== "handoff" || !h) return this.stopHandoffWatch();
    if (this.handoffBusy) return;
    this.handoffBusy = true;
    try {
      if (h.terminal && this.hcFailures < 5) {
        const t = await this.tuiTerminal(h.terminal);
        if (t === "live") return;
        if (t === "unknown") {
          this.hcFailures++;
          return;
        }
        // Finished or gone: resume once the TUI process is gone too (it may still be writing).
      } else if (Date.now() - h.since < (this.opts.handoffGraceMs ?? 60_000)) return;
      if (await this.tuiHolder()) return;
      if (this.state.phase !== "handoff" || this.state.handoff?.since !== h.since) return;
      this.opts.log(`hand-off over (${h.terminal ? `terminal ${h.terminal} ended` : "no TUI process left"}): resuming`);
      await this.resume({ auto: true }).catch((e) => this.opts.log(`resume after the hand-off failed: ${errText(e)}`));
    } finally {
      this.handoffBusy = false;
    }
  }

  /** `hc get <terminal>`: "live", "gone" (finished or no such terminal), or "unknown" (hc failed). */
  private tuiTerminal(address: string): Promise<"live" | "gone" | "unknown"> {
    return new Promise((resolve) => {
      execFile(this.opts.hcCommand ?? "hc", ["get", address, "--json"], { timeout: 5000 }, (err, stdout, stderr) => {
        for (const text of [stdout, stderr]) {
          let r: Rec;
          try {
            r = JSON.parse(String(text));
          } catch {
            continue;
          }
          if (r?.error?.kind === "not_found") return resolve("gone");
          if (r?.state === "finished") return resolve("gone");
          if (r?.state === "live") return resolve("live");
        }
        this.opts.log(`hc get ${address} failed: ${err ? errText(err) : "unexpected output"}`);
        resolve("unknown");
      });
    });
  }

  /** A live TUI process on the session: the pid the lock extension reported, the agent's own guard, else a process scan. */
  private async tuiHolder(): Promise<number | null> {
    const f = this.readHandoffFile();
    if (typeof f?.pid === "number" && f.pid !== process.pid && pidAlive(f.pid)) return f.pid;
    const file = this.state.sessionFile;
    const agent = file ? this.adapter.sessionHolder?.(file) : null;
    if (agent) return agent.pid;
    return this.processHolder(this.state.handoff?.argv ?? []);
  }

  /** A process whose argv names the TUI's session (its last argument) and the agent's program. */
  private processHolder(argv: string[]): Promise<number | null> {
    const token = argv.at(-1);
    let i = 0;
    if (argv[0] === "env") for (i = 1; argv[i]?.includes("="); i++);
    const program = argv[i];
    if (!token || !program) return Promise.resolve(null);
    const base = (p: string) => p.replace(/^.*\//, "").replace(/\.[mc]?[jt]s$/, "");
    const names = new Set(["pi", "claude", "codex", base(program)]);
    return new Promise((resolve) => {
      execFile("ps", ["-Ao", "pid=,args="], { timeout: 5000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
        if (err) return resolve(null);
        for (const line of String(stdout).split("\n")) {
          const m = /^\s*(\d+)\s+(.*)$/.exec(line);
          if (!m) continue;
          const pid = Number(m[1]);
          const args = m[2]!.split(/\s+/);
          if (pid === process.pid || !args.includes(token)) continue;
          if (args.some((a) => /herdr-chat-host$|host\/main\.ts$/.test(a))) continue; // a chat host, not a TUI
          if (args.slice(0, 3).some((a) => names.has(base(a)))) return resolve(pid);
        }
        resolve(null);
      });
    });
  }

  /** handoff_started: the client reports the TUI's terminal; the host watches it from now on. */
  handoffStarted(terminal: string): Record<string, never> {
    if (!terminal) throw new Error("handoff_started needs `terminal`");
    const h = this.state.handoff;
    if (this.state.phase !== "handoff" || !h) throw new Error(`${this.agent} is not open in its terminal UI.`);
    this.hcFailures = 0;
    if (h.terminal !== terminal) this.set({ handoff: { ...h, terminal } });
    return {};
  }

  /** Stops the agent so its TUI can take the session. `argv` is the TUI's command, run in the chat's cwd. */
  async handoff(): Promise<{ sessionFile: string; argv: string[] }> {
    const file = this.state.sessionFile;
    if (!file) throw new Error("This chat has no session file to hand off");
    if (this.state.phase === "handoff" && this.state.handoff) return { sessionFile: file, argv: this.state.handoff.argv };
    if (this.state.phase === "conflict" && this.state.conflict) throw new Error(`${this.conflictText(this.state.conflict)} ${this.conflictWayOut(this.state.conflict)}`);
    const hf = this.handoffPath();
    if (hf) rmSync(hf, { force: true });
    const argv = this.adapter.tuiCommand(this.sessionId ?? file, { handoffFile: hf });
    if (this.adapter.alive && this.busy) {
      const { restored } = await this.abort();
      if (restored.length) this.set({ editorText: restored.join("\n\n") });
      const t0 = Date.now();
      while (this.runActive && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 50));
    }
    await this.stopAgent();
    this.set({ phase: "handoff", error: null, handoff: { argv, terminal: null, since: Date.now() } });
    this.watchHandoff();
    this.terminalState("idle");
    this.opts.onSessionFile?.(file);
    return { sessionFile: file, argv };
  }

  /**
   * Restarts the agent on the session. After a hand-off: on the session the
   * TUI ended on (a fork or /resume there), when it reported one. `auto`: the
   * hand-off watch saw the TUI end.
   */
  async resume(opts: { auto?: boolean } = {}): Promise<void> {
    this.stopHandoffWatch();
    const fromHandoff = this.state.phase === "handoff";
    let file = this.state.sessionFile;
    if (fromHandoff) {
      const holder = opts.auto ? null : await this.tuiHolder();
      const r = this.readHandoffFile();
      const hf = this.handoffPath();
      if (hf) rmSync(hf, { force: true });
      if (typeof r?.sessionFile === "string" && r.sessionFile !== file && existsSync(r.sessionFile)) {
        file = r.sessionFile;
        this.set({ sessionFile: file });
        this.opts.onSessionFile?.(file);
        this.notice("info", "Continuing on the session the terminal UI ended on.");
      }
      if (holder) this.notice("warning", `${this.agent}'s terminal UI is still running (pid ${holder}). Quit it there: two ${this.agent} processes writing one session corrupt it.`);
      this.set({ handoff: null });
    }
    if (this.adapter.alive) await this.stopAgent();
    this.start(file, { agentGuard: !fromHandoff });
    await this.whenReady(30_000);
    if (this.state.phase === "error") throw new Error(this.state.error ?? `${this.agent} failed to start`);
  }

  async shutdown(): Promise<void> {
    this.stopHandoffWatch();
    for (const s of this.sinks) s.bye("shutdown");
    await this.stopAgent();
    this.opts.onShutdown?.();
  }

  /** Colors for host-rendered SVGs; the closed mermaid blocks are re-rendered and re-sent. */
  setTheme(colors: unknown, dark: unknown): void {
    if (!colors || typeof colors !== "object") throw new Error("set_theme needs `colors`");
    if (!this.render.setTheme(colors as Rec, dark !== false)) return;
    for (const it of this.timeline.items) if (this.render.hasMermaid(it)) this.timeline.touch(it.id);
    this.schedule();
  }

  /** The `op` dispatcher used by the server. */
  async op(name: string, a: Rec): Promise<unknown> {
    switch (name) {
      case "send":
        return this.send({ text: a.text, images: a.images, mode: a.mode, source: a.source === "external" ? "external" : "composer", from: typeof a.from === "string" ? a.from : undefined });
      case "abort":
        return this.abort();
      // `message`, not `id`: `id` is the request's own.
      case "queue_remove":
        return this.queueRemove(String(a.message ?? ""));
      case "queue_edit":
        return this.queueEdit(String(a.message ?? ""));
      case "queue_move":
        return this.queueMove(String(a.message ?? ""), String(a.to ?? ""));
      case "dialog_answer":
        return this.dialogAnswer(a);
      case "ack_editor_text":
        return this.ackEditorText();
      case "models":
        return this.models();
      case "set_model": {
        // `id` is the request's own id, so the model id is `modelId` (or `model: "provider/id"`).
        let provider = String(a.provider ?? "");
        let modelId = String(a.modelId ?? "");
        const m = typeof a.model === "string" ? /^([^/]+)\/(.+)$/.exec(a.model) : null;
        if (m) [provider, modelId] = [m[1]!, m[2]!];
        if (!provider || !modelId) throw new Error("set_model needs `provider` and `modelId`");
        await this.setModel(provider, modelId);
        return {};
      }
      case "set_thinking":
        await this.setThinking(String(a.level ?? ""));
        return {};
      case "set_permission_mode":
        await this.setPermissionMode(String(a.mode ?? ""));
        return {};
      case "compact":
        await this.compact(typeof a.instructions === "string" && a.instructions ? a.instructions : undefined);
        return {};
      case "new_session":
        await this.newSession();
        return {};
      case "set_name":
        await this.setName(String(a.name ?? ""));
        return {};
      case "fork_points":
        return this.forkPoints();
      case "fork":
        return this.fork(String(a.point ?? ""));
      case "sessions":
        return this.sessions();
      case "switch_session":
        await this.switchSession(String(a.path ?? ""));
        return {};
      case "files":
        return this.filesOp(a.query, a.limit);
      case "clipboard_image":
        return this.clipboardImage();
      case "history":
        return this.history(a.before, a.limit);
      case "tool_output":
        return this.toolOutput(a.item);
      case "handoff":
        return this.handoff();
      case "handoff_started":
        return this.handoffStarted(String(a.terminal ?? ""));
      case "take_over":
        await this.takeOver();
        return {};
      case "utility": {
        // A terminal utility built-in (/login, /settings…): the argv to run, cwd = the chat's.
        const c = this.state.commands.find((x) => x.source === "builtin" && x.name === String(a.name ?? "") && x.argv);
        if (!c) throw new Error(`${this.agent} has no /${String(a.name ?? "")}`);
        return { argv: c.argv };
      }
      case "resume":
        await this.resume();
        return {};
      case "shutdown":
        setImmediate(() => void this.shutdown());
        return {};
      case "set_theme":
        this.setTheme(a.colors, a.dark);
        return {};
    }
    throw new Error(`Unknown op: ${name}`);
  }
}
