// Normalized agent events → timeline Items (protocol.md "Item"). Provider-neutral
// and pure: no I/O except through the injected image saver. Callers read
// `dirty` to know which items changed.
import { stripAnsi, toSpans } from "./ansi.ts";
import type { Span } from "./ansi.ts";
import { presentTool, applyResult, prettyArgs } from "./tools.ts";
import type { NormalizedEvent, EventOf, ImageBlock, AssistantBlock } from "./providers/types.ts";

export type { ImageBlock };

export const LIMITS = {
  imagesPerItem: 8,
  output: 16 * 1024,
  args: 4 * 1024,
  fullOutput: 1024 * 1024,
  text: 256 * 1024,
};

export type UserSource = "composer" | "external" | "queued" | "extension";
export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export type ToolDetail =
  | { type: "bash"; command: string; exitCode?: number | null }
  | { type: "read"; path: string; offset?: number; limit?: number }
  | { type: "edit"; path: string; diff: string | null; added?: number; removed?: number; diffLines?: DiffLine[] }
  | { type: "write"; path: string; bytes?: number }
  | { type: "search"; tool: string; query?: string; path?: string }
  | { type: "web"; tool: "fetch" | "search"; url?: string; query?: string }
  | { type: "agent"; description: string; agentType?: string }
  | { type: "generic"; server?: string; tool: string };

/** Every item may carry `parent`: the id of the tool item (a subagent) whose run produced it. */
type Nested = { parent?: string };
export type UserItem = Nested & { id: string; kind: "user"; ts: number; text: string; images: number; imagePaths?: string[]; source: UserSource; from?: string };
export type DiffLine = { kind: "hunk" | "add" | "del" | "ctx" | "meta"; old?: number; new?: number; spans: Span[] };
export type Block =
  | { type: "markdown"; text: string }
  | { type: "code"; lang: string | null; code: string; open: boolean; lines?: Span[][] }
  | { type: "mermaid"; source: string; open: boolean; svg?: string; ascii?: Span[][]; error?: string };
export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number | null };
export type AssistantItem = Nested & {
  id: string; kind: "assistant"; ts: number; text: string; streaming: boolean; stopReason?: StopReason; error?: string; autonomous?: true;
  blocks?: Block[]; model?: string; durationMs?: number; usage?: Usage;
};
export type ThinkingItem = Nested & { id: string; kind: "thinking"; ts: number; text: string; streaming: boolean; durationMs?: number };
export type ToolItem = Nested & {
  id: string; kind: "tool"; ts: number; toolCallId: string; name: string; title: string;
  status: "pending" | "running" | "done" | "error" | "declined"; args: string; output: string; outputTruncated: boolean;
  durationMs?: number; images?: string[]; outputLines?: Span[][]; detail: ToolDetail;
};
export type NoticeItem = Nested & { id: string; kind: "notice"; ts: number; level: "info" | "warning" | "error"; source: "notify" | "retry" | "compaction" | "extension_error" | "host" | "queue"; text: string; spans?: Span[] };
export type CustomItem = Nested & { id: string; kind: "custom"; ts: number; customType: string; text: string };
export type PlanStep = { text: string; status: "pending" | "in_progress" | "completed" };
export type PlanItem = Nested & { id: string; kind: "plan"; ts: number; explanation?: string; steps: PlanStep[] };
export type Item = UserItem | AssistantItem | ThinkingItem | ToolItem | NoticeItem | CustomItem | PlanItem;

let idCounter = 0;
export function newId(prefix = "i"): string {
  return `${prefix}${(++idCounter).toString(36)}`;
}

function bounded(text: string, max = LIMITS.text): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "\n\n… [truncated]";
}

/** Writes one image for an item; returns its absolute path, or null. Injected so the timeline stays pure. */
export type ImageSaver = (itemId: string, n: number, img: ImageBlock) => string | null;

type MsgCtx = { blocks: Map<number, string>; thinkingStart: Map<number, number>; toolArgsText: Map<number, string>; autonomous: boolean; startedAt?: number };

function addUsage(a: Usage | undefined, b: Usage | undefined): Usage | undefined {
  if (!a) return b;
  if (!b) return a;
  return {
    input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite,
    cost: a.cost === null && b.cost === null ? null : (a.cost ?? 0) + (b.cost ?? 0),
  };
}

const STOP_REASONS = new Set<string>(["stop", "length", "toolUse", "error", "aborted"]);

export class Timeline {
  items: Item[] = [];
  byId = new Map<string, Item>();
  dirty = new Set<string>();
  removed = new Set<string>();
  toolsByCall = new Map<string, string>(); // toolCallId -> item id
  fullOutput = new Map<string, string>(); // tool item id -> full text (≤ 1 MiB)
  rawOutput = new Map<string, string>(); // tool item id -> output tail with its ANSI escapes, for `outputLines`
  /** Usage and time of assistant messages with no text item yet; added to the next one (so a run's items sum to its total). */
  private carry: { usage?: Usage; durationMs?: number } = {};
  cwd: string;
  /** The provider, for the tool classifier. */
  provider: string;
  /** Set by the session while a run nobody prompted is active. */
  autonomous = false;
  saveImage: ImageSaver | null = null;
  /** The message being streamed, per parent (a subagent streams beside the main agent). */
  private msgs = new Map<string, MsgCtx>();
  private plans = new Map<string, string>(); // plan key -> item id
  /** The callId of the event being applied's parent, if any. */
  private parentCall: string | undefined;

  constructor(cwd: string, saveImage: ImageSaver | null = null, provider = "pi") {
    this.cwd = cwd;
    this.saveImage = saveImage;
    this.provider = provider;
  }

  private saveImages(itemId: string, blocks: ImageBlock[]): string[] {
    if (!this.saveImage) return [];
    const out: string[] = [];
    for (const img of blocks.slice(0, LIMITS.imagesPerItem)) {
      const p = this.saveImage(itemId, out.length + 1, img);
      if (p) out.push(p);
    }
    return out;
  }

  private add<T extends Item>(item: T): T {
    const parent = this.parentCall !== undefined ? this.toolsByCall.get(this.parentCall) : undefined;
    if (parent) item.parent = parent;
    this.items.push(item);
    this.byId.set(item.id, item);
    this.dirty.add(item.id);
    return item;
  }

  touch(id: string): void {
    if (this.byId.has(id)) this.dirty.add(id);
  }

  get(id: string): Item | undefined {
    return this.byId.get(id);
  }

  addUser(text: string, images: number, source: UserSource, from?: string, ts = Date.now(), blocks: ImageBlock[] = []): UserItem {
    this.carry = {};
    const item = this.add<UserItem>({ id: newId("u"), kind: "user", ts, text: bounded(text), images: Math.max(images, blocks.length), source, ...(from ? { from } : {}) });
    const paths = this.saveImages(item.id, blocks);
    if (paths.length) item.imagePaths = paths;
    return item;
  }

  /** A sent message's echo: the agent's text (an expanded skill or template), its images and time. */
  confirmUser(item: UserItem, text: string, blocks: ImageBlock[], ts?: number): void {
    if (text && text !== item.text) item.text = bounded(text);
    if (blocks.length && !item.imagePaths?.length) {
      item.images = Math.max(item.images, blocks.length);
      const paths = this.saveImages(item.id, blocks);
      if (paths.length) item.imagePaths = paths;
    }
    if (ts !== undefined) item.ts = ts;
    this.dirty.add(item.id);
  }

  remove(id: string): boolean {
    const i = this.items.findIndex((x) => x.id === id);
    if (i < 0) return false;
    this.items.splice(i, 1);
    this.byId.delete(id);
    this.dirty.delete(id);
    this.removed.add(id);
    return true;
  }

  addNotice(level: NoticeItem["level"], source: NoticeItem["source"], text: string, ts = Date.now()): NoticeItem {
    const spans = toSpans(text);
    const plain = spans.map((s) => s.text).join("");
    const styled = spans.some((s) => Object.keys(s).length > 1);
    return this.add({ id: newId("n"), kind: "notice", ts, level, source, text: bounded(plain), ...(styled ? { spans } : {}) });
  }

  updateNotice(id: string, patch: Partial<Pick<NoticeItem, "level" | "text">>): void {
    const n = this.byId.get(id);
    if (!n || n.kind !== "notice") return;
    if (patch.level) n.level = patch.level;
    if (patch.text !== undefined) {
      const spans = toSpans(patch.text);
      n.text = spans.map((s) => s.text).join("");
      if (spans.some((s) => Object.keys(s).length > 1)) n.spans = spans;
      else delete n.spans;
    }
    this.dirty.add(id);
  }

  addCustom(customType: string, text: string, ts = Date.now()): CustomItem {
    return this.add({ id: newId("c"), kind: "custom", ts, customType, text: bounded(stripAnsi(text)) });
  }

  private setPlan(key: string, explanation: string | undefined, steps: EventOf<"plan">["steps"], ts: number): void {
    const known = this.plans.get(key);
    const it = known ? this.byId.get(known) : undefined;
    if (it && it.kind === "plan") {
      it.steps = steps.map((s) => ({ ...s, text: bounded(s.text, 4096) }));
      if (explanation !== undefined) it.explanation = explanation;
      else delete it.explanation;
      this.dirty.add(it.id);
      return;
    }
    const item = this.add<PlanItem>({ id: newId("p"), kind: "plan", ts, ...(explanation !== undefined ? { explanation } : {}), steps: steps.map((s) => ({ ...s, text: bounded(s.text, 4096) })) });
    this.plans.set(key, item.id);
  }

  // ---------------- assistant messages ----------------

  private get msgKey(): string {
    return this.parentCall ?? "";
  }

  private ctx(): MsgCtx {
    let m = this.msgs.get(this.msgKey);
    if (!m) {
      m = { blocks: new Map(), thinkingStart: new Map(), toolArgsText: new Map(), autonomous: this.autonomous };
      this.msgs.set(this.msgKey, m);
    }
    return m;
  }

  private blockItem(index: number, kind: "text" | "thinking", ts = Date.now()): AssistantItem | ThinkingItem {
    const c = this.ctx();
    const id = c.blocks.get(index);
    const existing = id ? this.byId.get(id) : undefined;
    if (existing && (existing.kind === "assistant" || existing.kind === "thinking")) return existing;
    let item: AssistantItem | ThinkingItem;
    if (kind === "thinking") {
      c.thinkingStart.set(index, ts);
      item = this.add({ id: newId("t"), kind: "thinking", ts, text: "", streaming: true });
    } else {
      item = this.add({ id: newId("a"), kind: "assistant", ts, text: "", streaming: true, ...(c.autonomous ? { autonomous: true as const } : {}) });
    }
    c.blocks.set(index, item.id);
    return item;
  }

  private toolItem(toolCallId: string, name: string, args: unknown, ts = Date.now()): ToolItem {
    const known = this.toolsByCall.get(toolCallId);
    const existing = known ? this.byId.get(known) : undefined;
    if (existing && existing.kind === "tool") return existing;
    const p = presentTool(this.provider, name, args, this.cwd);
    const item = this.add<ToolItem>({
      id: newId("x"), kind: "tool", ts, toolCallId, name, title: p.title, status: "pending",
      args: prettyArgs(args), output: "", outputTruncated: false, detail: p.detail,
    });
    this.toolsByCall.set(toolCallId, item.id);
    return item;
  }

  private setToolArgs(item: ToolItem, args: unknown): void {
    if (args === undefined) return;
    const p = presentTool(this.provider, item.name, args, this.cwd);
    item.title = p.title;
    item.args = prettyArgs(args);
    const prevExit = item.detail.type === "bash" ? item.detail.exitCode : undefined;
    item.detail = p.detail;
    if (item.detail.type === "bash" && prevExit !== undefined) item.detail.exitCode = prevExit;
    this.dirty.add(item.id);
  }

  private setToolOutput(item: ToolItem, text: string): void {
    const clean = stripAnsi(text);
    if (clean.length !== text.length) this.rawOutput.set(item.id, text.length > LIMITS.output * 4 ? text.slice(-LIMITS.output * 4) : text);
    else this.rawOutput.delete(item.id);
    const full = clean.length > LIMITS.fullOutput ? clean.slice(-LIMITS.fullOutput) : clean;
    this.fullOutput.set(item.id, full);
    if (clean.length > LIMITS.output) {
      item.output = clean.slice(-LIMITS.output);
      item.outputTruncated = true;
    } else {
      item.output = clean;
      item.outputTruncated = false;
    }
    this.dirty.add(item.id);
  }

  private static finished(t: ToolItem): boolean {
    return t.status === "done" || t.status === "error" || t.status === "declined";
  }

  /**
   * Applies one item-building event (messages, tools, plans, notices, custom
   * items). Returns true when it was one. Run, ask, decoration and session
   * events are the session's.
   */
  apply(ev: NormalizedEvent, now = ev.ts ?? Date.now()): boolean {
    this.parentCall = ev.parent;
    try {
      return this.applyEvent(ev, now);
    } finally {
      this.parentCall = undefined;
    }
  }

  private applyEvent(ev: NormalizedEvent, now: number): boolean {
    switch (ev.type) {
      case "user_message":
        this.addUser(ev.text, ev.images, ev.source ?? "extension", ev.from, now, ev.imageBlocks ?? []);
        return true;
      case "custom":
        this.addCustom(ev.customType, ev.text, now);
        return true;
      case "notice":
        this.addNotice(ev.level, ev.source, ev.text, now);
        return true;
      case "plan":
        this.setPlan(ev.key, ev.explanation, ev.steps, now);
        return true;
      case "assistant_start":
        this.msgs.delete(this.msgKey);
        this.ctx().startedAt = now;
        return true;
      case "assistant_block_start":
        this.blockItem(ev.index, ev.kind, now);
        return true;
      case "assistant_delta": {
        const it = this.blockItem(ev.index, ev.kind, now);
        if (typeof ev.delta === "string" && it.text.length < LIMITS.text) {
          it.text = bounded(it.text + ev.delta);
          this.dirty.add(it.id);
        }
        return true;
      }
      case "assistant_block_end": {
        const it = this.blockItem(ev.index, ev.kind, now);
        if (typeof ev.text === "string") it.text = bounded(ev.text);
        if (it.kind === "thinking") {
          it.streaming = false;
          const t0 = this.msgs.get(this.msgKey)?.thinkingStart.get(ev.index);
          if (t0 !== undefined) it.durationMs = Math.max(0, now - t0);
        }
        this.dirty.add(it.id);
        return true;
      }
      case "tool_call_start": {
        const t = this.toolItem(ev.callId, ev.name, undefined, now);
        this.ctx().blocks.set(ev.index, t.id);
        return true;
      }
      case "tool_call_delta": {
        const c = this.ctx();
        const prev = c.toolArgsText.get(ev.index) ?? "";
        if (prev.length < LIMITS.args) c.toolArgsText.set(ev.index, prev + ev.delta);
        const tid = c.blocks.get(ev.index);
        const t = tid ? this.byId.get(tid) : undefined;
        if (t && t.kind === "tool" && !t.args) {
          // Show the partial JSON until the call is complete.
          t.args = (c.toolArgsText.get(ev.index) ?? "").slice(0, LIMITS.args);
          this.dirty.add(t.id);
        }
        return true;
      }
      case "tool_call": {
        const t = this.toolItem(ev.callId, ev.name, ev.args, now);
        if (ev.index !== undefined) this.ctx().blocks.set(ev.index, t.id);
        this.setToolArgs(t, ev.args);
        return true;
      }
      case "assistant_end":
        this.finishAssistant(ev, now);
        return true;
      case "tool_started": {
        const known = this.toolsByCall.has(ev.callId);
        const t = this.toolItem(ev.callId, ev.name, ev.args, now);
        if (Timeline.finished(t)) return true; // late or duplicate
        if (known && t.status === "running" && ev.args === undefined) return true; // nothing new
        if (ev.args !== undefined) this.setToolArgs(t, ev.args);
        t.status = "running";
        this.dirty.add(t.id);
        return true;
      }
      case "tool_progress": {
        const t = this.toolItem(ev.callId, ev.name, ev.args, now);
        if (Timeline.finished(t)) return true;
        if (t.status === "pending") t.status = "running";
        if (ev.output !== undefined && (ev.output || t.output)) this.setToolOutput(t, ev.output);
        this.dirty.add(t.id);
        return true;
      }
      case "tool_ended": {
        const t = this.toolItem(ev.callId, ev.name, ev.args, now);
        this.endTool(t, ev);
        return true;
      }
    }
    return false;
  }

  private endTool(t: ToolItem, ev: EventOf<"tool_ended">): void {
    const text = ev.lostBytes ? `[output too large to show: ${(ev.lostBytes / 1048576).toFixed(1)} MiB]` : ev.output;
    this.setToolOutput(t, text);
    if (ev.lostBytes) t.outputTruncated = true;
    if (!t.images && ev.images?.length) {
      const paths = this.saveImages(t.id, ev.images);
      if (paths.length) t.images = paths;
    }
    const ran = t.status !== "pending";
    t.status = ev.declined ? "declined" : ev.isError ? "error" : "done";
    if (ev.durationMs !== undefined) t.durationMs = ev.durationMs;
    else if (ran) t.durationMs ??= Math.max(0, Date.now() - t.ts);
    t.detail = applyResult(this.provider, t.name, t.detail, ev.result, ev.isError, text, this.cwd);
    this.dirty.add(t.id);
  }

  private finishAssistant(m: EventOf<"assistant_end">, now: number): void {
    const c = this.ctx();
    let lastText: AssistantItem | null = null;
    m.content.forEach((b: AssistantBlock | null, index) => {
      if (!b) return;
      if (b.type === "text") {
        const known = c.blocks.get(index);
        if (!known && !b.text) return;
        const it = this.blockItem(index, "text", now) as AssistantItem;
        it.text = bounded(b.text);
        it.streaming = false;
        this.dirty.add(it.id);
        lastText = it;
      } else if (b.type === "thinking") {
        const known = c.blocks.get(index);
        if (!known && !b.text) return;
        const it = this.blockItem(index, "thinking", now) as ThinkingItem;
        it.text = bounded(b.text);
        if (it.streaming) {
          it.streaming = false;
          const t0 = c.thinkingStart.get(index);
          if (t0 !== undefined && known) it.durationMs = Math.max(0, now - t0);
        }
        this.dirty.add(it.id);
      } else if (b.type === "toolCall") {
        const t = this.toolItem(b.callId, b.name, b.args, now);
        if (t.status === "pending" && b.args !== undefined) this.setToolArgs(t, b.args);
        c.blocks.set(index, t.id);
      }
    });
    // Blocks that streamed but are missing from the final message still stop streaming.
    for (const id of c.blocks.values()) {
      const it = this.byId.get(id);
      if (it && (it.kind === "assistant" || it.kind === "thinking") && it.streaming) {
        it.streaming = false;
        this.dirty.add(it.id);
        if (it.kind === "assistant") lastText = it;
      }
    }
    const stop = m.stopReason;
    const error = m.error;
    if (stop && STOP_REASONS.has(stop)) {
      let target: AssistantItem | null = lastText;
      if (!target && (stop === "error" || stop === "aborted")) {
        target = this.add<AssistantItem>({ id: newId("a"), kind: "assistant", ts: now, text: "", streaming: false, ...(c.autonomous ? { autonomous: true as const } : {}) });
      }
      if (target) {
        target.stopReason = stop;
        if (error && (stop === "error" || stop === "aborted")) target.error = error;
        this.dirty.add(target.id);
      }
      lastText = target;
    }
    // Model, time and usage: on the message's last text item. A message without one (tool calls only)
    // carries them to the next, so the assistant items of a run add up to the run.
    const usage = addUsage(this.carry.usage, m.usage);
    const own = m.durationMs ?? (c.startedAt !== undefined ? Math.max(0, now - c.startedAt) : undefined);
    const durationMs = own === undefined ? this.carry.durationMs : own + (this.carry.durationMs ?? 0);
    const target = lastText as AssistantItem | null;
    if (target) {
      if (m.model) target.model = m.model;
      if (durationMs !== undefined) target.durationMs = durationMs;
      if (usage) target.usage = usage;
      this.dirty.add(target.id);
      this.carry = {};
    } else {
      this.carry = { ...(usage ? { usage } : {}), ...(durationMs !== undefined ? { durationMs } : {}) };
    }
    this.msgs.delete(this.msgKey);
  }

  /** Closes whatever is still open after a run ends (abort, crash, lost records). `agent` names it in notes. */
  closeOpen(reason: "aborted" | "exited" | "settled", agent = "Pi"): void {
    for (const it of this.items) {
      if ((it.kind === "assistant" || it.kind === "thinking") && it.streaming) {
        it.streaming = false;
        if (it.kind === "assistant" && reason !== "settled") {
          it.stopReason = reason === "aborted" ? "aborted" : "error";
          if (reason === "exited") it.error = `${agent} exited`;
        }
        this.dirty.add(it.id);
      } else if (it.kind === "tool" && (it.status === "pending" || it.status === "running")) {
        it.status = "error";
        const note = reason === "exited" ? `${agent} exited before this tool finished.` : reason === "aborted" ? "Aborted." : "This tool did not report a result.";
        this.setToolOutput(it, (this.fullOutput.get(it.id) ?? it.output) + (it.output ? "\n" : "") + note);
        it.durationMs ??= Math.max(0, Date.now() - it.ts);
        this.dirty.add(it.id);
      }
    }
    this.msgs.clear();
  }

  // ---------------- history ----------------

  /** Rebuilds items from an adapter's `history()`, matching what live events produce. */
  load(events: NormalizedEvent[]): void {
    for (const ev of events) this.apply(ev, ev.ts ?? Date.now());
    // A tool call with no result in history did not finish.
    for (const it of this.items) {
      if (it.kind === "tool" && it.status === "pending") {
        it.status = "error";
        it.output = it.output || "No result was recorded.";
      }
    }
    this.msgs.clear();
  }

  /** Items before `beforeId`, newest `limit`. */
  older(beforeId: string, limit: number): { items: Item[]; hasOlder: boolean } {
    const idx = this.items.findIndex((i) => i.id === beforeId);
    if (idx <= 0) return { items: [], hasOlder: false };
    const start = Math.max(0, idx - limit);
    return { items: this.items.slice(start, idx), hasOlder: start > 0 };
  }

  lastAssistantText(): string | null {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i]!;
      if (it.kind === "assistant" && it.text) return it.text;
    }
    return null;
  }
}
