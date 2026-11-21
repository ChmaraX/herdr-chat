// Normalized agent events → timeline Items (protocol.md "Item"). Provider-neutral
// and pure: no I/O except through the injected image saver. Callers read
// `dirty` to know which items changed.
import { stripAnsi, toSpans } from "./ansi.ts";
import type { Span } from "./ansi.ts";
import { presentTool, applyResult, prettyArgs, NO_TOOLS, type ToolMap } from "./tools.ts";
import type { NormalizedEvent, EventOf, ImageBlock, AssistantBlock, SkillRef } from "./providers/types.ts";
import { imageSize, type ImageFile, type ImageSize } from "./imagesize.ts";

export type { ImageBlock, SkillRef };

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
/** `skills`: the skills the message invokes, in order, drawn as pills; `text` is then what the person wrote after them. */
export type UserItem = Nested & {
  id: string; kind: "user"; ts: number; text: string; images: number; imageFiles?: ImageFile[];
  source: UserSource; from?: string; skills?: SkillRef[];
};
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
  durationMs?: number; imageFiles?: ImageFile[]; outputLines?: Span[][]; detail: ToolDetail;
};
export type NoticeItem = Nested & { id: string; kind: "notice"; ts: number; level: "info" | "warning" | "error"; source: "notify" | "retry" | "compaction" | "extension_error" | "host" | "queue" | "plan"; text: string; spans?: Span[] };
export type CustomItem = Nested & { id: string; kind: "custom"; ts: number; customType: string; text: string };
export type PlanStep = { text: string; status: "pending" | "in_progress" | "completed" };
/** A list of steps: the agent's plan (chat state, shown above the composer), or a subagent's card. */
export type Plan = { explanation?: string; steps: PlanStep[] };
/** A subagent's plan: a card in its group. */
export type PlanItem = Nested & { id: string; kind: "plan"; ts: number } & Plan;
export type Item = UserItem | AssistantItem | ThinkingItem | ToolItem | NoticeItem | CustomItem | PlanItem;

/**
 * An item as the wire carries it. Saved images go as parallel arrays, paths
 * (`imagePaths` on user items, `images` on tool items) and `imageSizes` (v3.7),
 * so a mod older than the sizes still finds its paths. A user item's first
 * skill also goes as `skill` (v3.8), so a mod older than `skills` still shows
 * a pill.
 */
type WireImages<K extends string> = { [P in K]?: string[] } & { imageSizes?: (ImageSize | null)[] };
export type WireItem =
  | Exclude<Item, UserItem | ToolItem>
  | (Omit<UserItem, "imageFiles"> & WireImages<"imagePaths"> & { skill?: SkillRef })
  | (Omit<ToolItem, "imageFiles"> & WireImages<"images">);

export function toWire(item: Item): WireItem {
  const it = structuredClone(item);
  if (it.kind === "user") {
    const { imageFiles, ...rest } = it;
    const old = rest.skills?.length ? { skill: rest.skills[0] } : {};
    return imageFiles ? { ...rest, ...old, imagePaths: imageFiles.map((f) => f.path), imageSizes: imageFiles.map((f) => f.size) } : { ...rest, ...old };
  }
  if (it.kind === "tool") {
    const { imageFiles, ...rest } = it;
    return imageFiles ? { ...rest, images: imageFiles.map((f) => f.path), imageSizes: imageFiles.map((f) => f.size) } : rest;
  }
  return it;
}

let idCounter = 0;
export function newId(prefix = "i"): string {
  return `${prefix}${(++idCounter).toString(36)}`;
}

function bounded(text: string, max = LIMITS.text): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "\n\n… [truncated]";
}

/** Writes an item's `n`th image; returns its absolute path, or null. Injected so the timeline stays pure. */
export type ImageSaver = (img: { itemId: string; n: number; bytes: Buffer; mimeType: string }) => string | null;

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

const planDone = (p: Plan): boolean => p.steps.every((s) => s.status === "completed");
const sameTexts = (a: Plan, b: Plan): boolean => a.steps.length === b.steps.length && a.steps.every((s, i) => s.text === b.steps[i]?.text);

function planOf(ev: EventOf<"plan" | "subagent_plan">): Plan {
  return { ...(ev.explanation !== undefined ? { explanation: ev.explanation } : {}), steps: ev.steps.map((s) => ({ ...s, text: bounded(s.text, 4096) })) };
}

/** The turn's plan marker row; `created`: the turn started a new plan. */
type TurnMarker = { id: string; created: boolean };

/** The transcript's row for a turn's plan change. */
function markerText(plan: Plan | null, created: boolean): string {
  if (!plan) return "Plan cleared";
  const n = plan.steps.length;
  return `${created ? "Plan created" : "Plan updated"} · ${n} ${n === 1 ? "step" : "steps"}`;
}

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
  /** The agent's tools, for the classifier. */
  tools: ToolMap;
  /** Set by the session while a run nobody prompted is active. */
  autonomous = false;
  saveImage: ImageSaver | null = null;
  /** The message being streamed, per parent (a subagent streams beside the main agent). */
  private msgs = new Map<string, MsgCtx>();
  /** The top-level agent's plan. A new one replaces it; a finished one goes at the next user message. Never changed in place. */
  plan: Plan | null = null;
  /** `plan` changed since the chat last read it. */
  planChanged = false;
  private turnMarker: TurnMarker | null = null;
  /** What the last top-level user message reset, until the plan changes again: removing that message puts it back. */
  private turnStart: { userId: string; plan: Plan | null; marker: TurnMarker | null } | null = null;
  private cardsByKey = new Map<string, string>();
  /** The callId of the event being applied's parent, if any. */
  private parentCall: string | undefined;

  constructor(cwd: string, saveImage: ImageSaver | null = null, tools: ToolMap = NO_TOOLS) {
    this.cwd = cwd;
    this.saveImage = saveImage;
    this.tools = tools;
  }

  private attachImages(item: UserItem | ToolItem, blocks: ImageBlock[]): void {
    if (!this.saveImage) return;
    const files: ImageFile[] = [];
    for (const img of blocks.slice(0, LIMITS.imagesPerItem)) {
      const bytes = Buffer.from(img.data, "base64");
      const path = this.saveImage({ itemId: item.id, n: files.length + 1, bytes, mimeType: img.mimeType });
      if (path) files.push({ path, size: imageSize(bytes) });
    }
    if (files.length) item.imageFiles = files;
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

  addUser(text: string, images: number, source: UserSource, from?: string, ts = Date.now(), blocks: ImageBlock[] = [], skills?: SkillRef[]): UserItem {
    this.carry = {};
    const item = this.add<UserItem>({ id: newId("u"), kind: "user", ts, text: bounded(text), images: Math.max(images, blocks.length), source, ...(from ? { from } : {}), ...(skills?.length ? { skills } : {}) });
    if (!item.parent) {
      this.turnStart = { userId: item.id, plan: this.plan, marker: this.turnMarker };
      this.turnMarker = null;
      if (this.plan && planDone(this.plan)) this.replacePlan(null);
    }
    this.attachImages(item, blocks);
    return item;
  }

  /** A sent message's echo: the agent's text (an expanded template), the skills it ran, its images and time. */
  confirmUser(item: UserItem, text: string, blocks: ImageBlock[], ts?: number, skills?: SkillRef[]): void {
    if (skills?.length) {
      item.skills = skills;
      item.text = bounded(text);
    } else if (text && text !== item.text) {
      item.text = bounded(text);
      delete item.skills;
    }
    if (blocks.length && !item.imageFiles) {
      item.images = Math.max(item.images, blocks.length);
      this.attachImages(item, blocks);
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
    if (this.turnStart?.userId === id) {
      if (this.plan !== this.turnStart.plan) this.replacePlan(this.turnStart.plan);
      this.turnMarker = this.turnStart.marker;
      this.turnStart = null;
    }
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

  private replacePlan(plan: Plan | null): void {
    this.plan = plan;
    this.planChanged = true;
  }

  /** The agent's new plan (null: no steps). A turn that adds, removes or renames steps gets one marker row, kept up to date. */
  private setPlan(next: Plan | null, ts: number): void {
    const prev = this.plan;
    if (!prev && !next) return;
    this.replacePlan(next);
    this.turnStart = null;
    const kept = prev !== null && next !== null && next.steps.some((s) => prev.steps.some((p) => p.text === s.text));
    if (kept && sameTexts(prev, next)) return;
    const marker = this.turnMarker;
    if (marker && this.byId.has(marker.id)) {
      marker.created ||= !kept;
      this.updateNotice(marker.id, { text: markerText(next, marker.created) });
      return;
    }
    this.turnMarker = { id: this.addNotice("info", "plan", markerText(next, !kept), ts).id, created: !kept };
  }

  private setCard(key: string, plan: Plan, ts: number): void {
    const known = this.cardsByKey.get(key);
    const it = known ? this.byId.get(known) : undefined;
    if (it && it.kind === "plan") {
      it.steps = [...plan.steps];
      if (plan.explanation !== undefined) it.explanation = plan.explanation;
      else delete it.explanation;
      this.dirty.add(it.id);
      return;
    }
    const item = this.add<PlanItem>({ id: newId("p"), kind: "plan", ts, ...plan, steps: [...plan.steps] });
    this.cardsByKey.set(key, item.id);
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
    const p = presentTool(this.tools, name, args, this.cwd);
    const item = this.add<ToolItem>({
      id: newId("x"), kind: "tool", ts, toolCallId, name, title: p.title, status: "pending",
      args: prettyArgs(args), output: "", outputTruncated: false, detail: p.detail,
    });
    this.toolsByCall.set(toolCallId, item.id);
    return item;
  }

  private setToolArgs(item: ToolItem, args: unknown): void {
    if (args === undefined) return;
    const p = presentTool(this.tools, item.name, args, this.cwd);
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
        this.addUser(ev.text, ev.images, ev.source ?? "extension", ev.from, now, ev.imageBlocks ?? [], ev.skills);
        return true;
      case "custom":
        this.addCustom(ev.customType, ev.text, now);
        return true;
      case "notice":
        this.addNotice(ev.level, ev.source, ev.text, now);
        return true;
      case "plan":
        this.setPlan(ev.steps.length ? planOf(ev) : null, now);
        return true;
      case "subagent_plan":
        // A subagent whose card isn't on the timeline (cut from the history) has nowhere to show its plan.
        if (this.toolsByCall.has(ev.parent)) this.setCard(ev.key, planOf(ev), now);
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
    if (!t.imageFiles && ev.images?.length) this.attachImages(t, ev.images);
    const ran = t.status !== "pending";
    t.status = ev.declined ? "declined" : ev.isError ? "error" : "done";
    if (ev.durationMs !== undefined) t.durationMs = ev.durationMs;
    else if (ran) t.durationMs ??= Math.max(0, Date.now() - t.ts);
    t.detail = applyResult(this.tools, t.name, t.detail, ev.result, ev.isError, text, this.cwd);
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
  closeOpen(reason: "aborted" | "exited" | "settled", agent: string): void {
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
