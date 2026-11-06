// Codex app-server items → normalized events. Pure: live notifications and
// history (`thread/turns/list`, the same ThreadItem shapes) go through the
// same code, so a resumed session rebuilds the same items as the live one.
//
// Model: a Codex turn holds items in emission order. Consecutive reasoning,
// agentMessage and plan items form one assistant "segment" (one assistant
// message in the core's terms, each item a content block); any other item
// (a tool, a user message) closes the segment. Tools are their own cards.
// A subagent's thread (collabAgentToolCall spawnAgent → receiverThreadIds)
// maps every event to `parent: <the spawn call id>`.
import type { NormalizedEvent, AssistantBlock, ImageBlock, Usage, PlanStep } from "../types.ts";

type Rec = Record<string, any>;

export type TokenBreakdown = { totalTokens: number; inputTokens: number; cachedInputTokens: number; cacheWriteInputTokens?: number; outputTokens: number; reasoningOutputTokens: number };
export type TokenUsage = { total: TokenBreakdown; last: TokenBreakdown; modelContextWindow: number | null };

export type MapperOptions = {
  /** History replay: user messages are `composer`, compactions become notices. */
  history?: boolean;
  /** "provider/id" of the model that is answering, for assistant_end. */
  model?: () => string | undefined;
  /** Reads a local image (a localImage input, an imageView path) for the core to save. */
  readImage?: (path: string) => ImageBlock | null;
};

const TEXT_ITEMS = new Set(["agentMessage", "reasoning", "plan"]);
/** Items that are not tool cards. */
const NON_TOOLS = new Set(["userMessage", "agentMessage", "reasoning", "plan", "contextCompaction", "hookPrompt", "enteredReviewMode", "exitedReviewMode", "subAgentActivity"]);

type Segment = {
  next: number;
  index: Map<string, number>; // item id -> content index
  kind: Map<number, "text" | "thinking">;
  streamed: Map<number, string>;
  parts: Map<string, number>; // reasoning item -> summary parts seen
  content: (AssistantBlock | null)[];
};

type OpenTool = { thread: string; name: string; args: unknown; output: string; startedAt: number };

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** A user message's text and image inputs (`UserInput[]`). */
export function userContent(content: unknown, readImage?: (p: string) => ImageBlock | null): { text: string; images: number; imageBlocks: ImageBlock[] } {
  const parts: Rec[] = Array.isArray(content) ? content : [];
  const texts: string[] = [];
  const imageBlocks: ImageBlock[] = [];
  let images = 0;
  for (const p of parts) {
    if (!p || typeof p !== "object") continue;
    if (p.type === "text" && typeof p.text === "string") texts.push(p.text);
    else if (p.type === "localImage") {
      images++;
      const b = typeof p.path === "string" ? readImage?.(p.path) : null;
      if (b) imageBlocks.push(b);
    } else if (p.type === "image") {
      images++;
      const m = typeof p.url === "string" ? /^data:([\w/+.-]+);base64,(.*)$/s.exec(p.url) : null;
      if (m) imageBlocks.push({ mimeType: m[1]!, data: m[2]! });
    }
  }
  return { text: texts.join("\n"), images, imageBlocks };
}

/** What a tool card shows as its arguments (the item without its state). */
export function toolArgs(item: Rec): Rec {
  switch (item.type) {
    case "commandExecution":
      return { command: item.command, cwd: item.cwd, commandActions: item.commandActions ?? [] };
    case "fileChange":
      return { changes: item.changes ?? [] };
    case "mcpToolCall":
      return { server: item.server, tool: item.tool, arguments: item.arguments };
    case "dynamicToolCall":
      return { tool: item.tool, ...(item.namespace ? { namespace: item.namespace } : {}), arguments: item.arguments };
    case "webSearch":
      return { query: item.query ?? "", ...(item.action ? { action: item.action } : {}) };
    case "imageView":
      return { path: item.path };
    case "imageGeneration":
      return { ...(item.revisedPrompt ? { prompt: item.revisedPrompt } : {}) };
    case "collabAgentToolCall":
      return {
        tool: item.tool, ...(item.prompt ? { prompt: item.prompt } : {}), ...(item.model ? { model: item.model } : {}),
        ...(item.reasoningEffort ? { reasoningEffort: item.reasoningEffort } : {}), receiverThreadIds: item.receiverThreadIds ?? [],
      };
    default: {
      const { id: _id, type: _type, status: _status, ...rest } = item;
      return rest;
    }
  }
}

function webResults(results: unknown): string {
  if (!Array.isArray(results)) return "";
  const out: string[] = [];
  for (const r of results.slice(0, 20) as Rec[]) {
    if (!r || typeof r !== "object") continue;
    const title = str(r.title) ?? str(r.domain) ?? "";
    const url = str(r.url) ?? "";
    out.push([title, url].filter(Boolean).join(" — "));
    if (str(r.snippet)) out.push(`  ${r.snippet.replace(/\s+/g, " ").slice(0, 300)}`);
  }
  return out.join("\n");
}

/** A finished tool item → its card's output, images and error state. */
function toolResult(item: Rec, streamed: string, readImage?: (p: string) => ImageBlock | null): { output: string; images: ImageBlock[]; isError: boolean; declined: boolean } {
  const status = str(item.status);
  const declined = status === "declined";
  const failed = status === "failed" || status === "interrupted";
  const images: ImageBlock[] = [];
  switch (item.type) {
    case "commandExecution": {
      const output = str(item.aggregatedOutput) ?? streamed;
      const code = num(item.exitCode);
      return { output, images, isError: failed || declined || (code !== undefined && code !== 0), declined };
    }
    case "fileChange":
      return { output: failed ? "The patch did not apply." : "", images, isError: failed || declined, declined };
    case "mcpToolCall": {
      const parts: string[] = [];
      for (const b of (item.result?.content ?? []) as Rec[]) {
        if (b?.type === "text" && typeof b.text === "string") parts.push(b.text);
        else if (b?.type === "image" && typeof b.data === "string") images.push({ data: b.data, mimeType: str(b.mimeType) ?? "image/png" });
      }
      if (!parts.length && item.result?.structuredContent != null) parts.push(JSON.stringify(item.result.structuredContent, null, 2));
      if (item.error?.message) parts.push(String(item.error.message));
      return { output: parts.join("\n"), images, isError: failed || !!item.error, declined };
    }
    case "dynamicToolCall": {
      const parts: string[] = [];
      for (const c of (item.contentItems ?? []) as Rec[]) if (c?.type === "inputText") parts.push(String(c.text ?? ""));
      return { output: parts.join("\n"), images, isError: failed || item.success === false, declined };
    }
    case "webSearch":
      return { output: webResults(item.results), images, isError: failed, declined };
    case "imageView": {
      const b = typeof item.path === "string" ? readImage?.(item.path) : null;
      if (b) images.push(b);
      return { output: "", images, isError: failed, declined };
    }
    case "imageGeneration": {
      if (typeof item.result === "string" && /^[A-Za-z0-9+/=\s]{64,}$/.test(item.result.slice(0, 200))) images.push({ data: item.result, mimeType: "image/png" });
      const output = item.failure ? String(item.failure.message ?? JSON.stringify(item.failure)) : str(item.savedPath) ?? "";
      return { output, images, isError: failed || !!item.failure, declined };
    }
    case "collabAgentToolCall": {
      const states = item.agentsStates && typeof item.agentsStates === "object" ? Object.values(item.agentsStates as Rec) : [];
      const output = states.map((s: Rec) => str(s?.message) ?? (s?.status ? `(${s.status})` : "")).filter(Boolean).join("\n\n");
      const errored = states.some((s: Rec) => s?.status === "errored");
      return { output, images, isError: failed || errored, declined };
    }
    default:
      return { output: streamed, images, isError: failed, declined };
  }
}

function planStatus(s: unknown): PlanStep["status"] {
  return s === "completed" ? "completed" : s === "inProgress" || s === "in_progress" ? "in_progress" : "pending";
}

/** One request's tokens in protocol form (Codex counts cached input inside input). */
function usageOf(b: TokenBreakdown): Usage {
  const cached = Math.max(0, b.cachedInputTokens ?? 0);
  return { input: Math.max(0, (b.inputTokens ?? 0) - cached), output: b.outputTokens ?? 0, cacheRead: cached, cacheWrite: b.cacheWriteInputTokens ?? 0, cost: null };
}

function addUsage(a: Usage | undefined, b: Usage): Usage {
  if (!a) return b;
  return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite, cost: null };
}

export class CodexMapper {
  opts: MapperOptions;
  /** The chat's thread; others are subagents (or ignored). */
  mainThread: string | null = null;
  /** Subagent thread id -> the spawn call id its events nest under. */
  private childParents = new Map<string, string>();
  private segments = new Map<string, Segment>(); // thread id -> open segment
  private tools = new Map<string, OpenTool>(); // item id -> open tool
  private planText = new Map<string, string>();
  /** Requests since the last assistant_end, per thread (each update's `last`), so a run's items add up to the run. */
  private pendingUsage = new Map<string, Usage>();
  /** The latest token usage per thread. */
  usage = new Map<string, TokenUsage>();
  /** The `ts` of the events being made (history); live events leave it unset. */
  ts: number | undefined;

  constructor(opts: MapperOptions = {}) {
    this.opts = opts;
  }

  reset(mainThread: string | null): void {
    this.mainThread = mainThread;
    this.childParents.clear();
    this.segments.clear();
    this.tools.clear();
    this.planText.clear();
    this.pendingUsage.clear();
    this.usage.clear();
  }

  /** Whether events of this thread are shown: the main thread and known subagents. */
  known(threadId: string | undefined): boolean {
    return !threadId || threadId === this.mainThread || this.childParents.has(threadId);
  }

  isChild(threadId: string | undefined): boolean {
    return !!threadId && threadId !== this.mainThread && this.childParents.has(threadId);
  }

  /** The parent call of a subagent thread. */
  parentOf(threadId: string | undefined): string | undefined {
    return threadId ? this.childParents.get(threadId) : undefined;
  }

  /** Children spawned so far: [thread id, spawn call id]. */
  children(): [string, string][] {
    return [...this.childParents];
  }

  /** The open tool item's card arguments (approval cards show what will run). */
  openToolArgs(itemId: string): { name: string; args: unknown } | undefined {
    const t = this.tools.get(itemId);
    return t ? { name: t.name, args: t.args } : undefined;
  }

  get openToolIds(): string[] {
    return [...this.tools.keys()];
  }

  private stamp(thread: string, evs: NormalizedEvent[]): NormalizedEvent[] {
    const parent = this.parentOf(thread);
    for (const e of evs) {
      if (parent && e.parent === undefined) e.parent = parent;
      if (this.ts !== undefined && e.ts === undefined) e.ts = this.ts;
    }
    return evs;
  }

  // ---------------------------------------------------------------- segments

  private segment(thread: string, out: NormalizedEvent[]): Segment {
    let s = this.segments.get(thread);
    if (!s) {
      s = { next: 0, index: new Map(), kind: new Map(), streamed: new Map(), parts: new Map(), content: [] };
      this.segments.set(thread, s);
      out.push({ type: "assistant_start" });
    }
    return s;
  }

  private blockIndex(thread: string, itemId: string, kind: "text" | "thinking", out: NormalizedEvent[]): number {
    const s = this.segment(thread, out);
    let i = s.index.get(itemId);
    if (i === undefined) {
      i = s.next++;
      s.index.set(itemId, i);
      s.kind.set(i, kind);
      s.content[i] = null;
    }
    return i;
  }

  private delta(thread: string, itemId: string, kind: "text" | "thinking", delta: string, out: NormalizedEvent[]): void {
    if (!delta) return;
    const s = this.segment(thread, out);
    const i = this.blockIndex(thread, itemId, kind, out);
    s.streamed.set(i, (s.streamed.get(i) ?? "") + delta);
    out.push({ type: "assistant_delta", index: i, kind, delta });
  }

  /** Ends the open segment of a thread as one assistant message. */
  private closeSegment(thread: string, out: NormalizedEvent[], stopReason?: "stop" | "toolUse" | "aborted" | "error", error?: string): void {
    const s = this.segments.get(thread);
    if (!s) {
      if (stopReason === "error") {
        out.push({ type: "assistant_start" });
        out.push({ type: "assistant_end", content: [], stopReason, ...(error ? { error } : {}), ...this.endMeta(thread) });
      }
      return;
    }
    this.segments.delete(thread);
    out.push({ type: "assistant_end", content: s.content, ...(stopReason ? { stopReason } : {}), ...(error ? { error } : {}), ...this.endMeta(thread) });
  }

  private endMeta(thread: string): { model?: string; usage?: Usage } {
    const model = this.opts.model?.();
    const usage = this.pendingUsage.get(thread);
    this.pendingUsage.delete(thread);
    return { ...(model ? { model } : {}), ...(usage ? { usage } : {}) };
  }

  // ---------------------------------------------------------------- items

  /** One item lifecycle step (live `item/started`/`item/completed`, or history). */
  item(thread: string, phase: "started" | "completed", item: Rec): NormalizedEvent[] {
    const out: NormalizedEvent[] = [];
    if (!item || typeof item !== "object" || typeof item.id !== "string") return out;
    const id: string = item.id;
    const type = str(item.type) ?? "unknown";
    if (TEXT_ITEMS.has(type)) {
      const kind = type === "reasoning" ? "thinking" : "text";
      if (phase === "started") {
        this.blockIndex(thread, id, kind, out);
        return this.stamp(thread, out);
      }
      const s = this.segment(thread, out);
      const i = this.blockIndex(thread, id, kind, out);
      let text: string;
      if (type === "reasoning") {
        const summary = Array.isArray(item.summary) ? item.summary.map(String).filter(Boolean) : [];
        const raw = Array.isArray(item.content) ? item.content.map(String).filter(Boolean) : [];
        text = summary.join("\n\n") || raw.join("\n\n") || (s.streamed.get(i) ?? "");
      } else {
        text = str(item.text) ?? (s.streamed.get(i) ?? "");
      }
      if (text || s.streamed.has(i)) {
        out.push({ type: "assistant_block_end", index: i, kind, text });
        s.content[i] = kind === "thinking" ? { type: "thinking", text } : { type: "text", text };
      }
      return this.stamp(thread, out);
    }
    switch (type) {
      case "userMessage": {
        if (phase === "started") return out;
        this.closeSegment(thread, out);
        const u = userContent(item.content, this.opts.readImage);
        const clientId = this.opts.history ? undefined : str(item.clientId);
        out.push({
          type: "user_message", text: u.text, images: u.images, ...(u.imageBlocks.length ? { imageBlocks: u.imageBlocks } : {}),
          ...(this.opts.history ? { source: this.isChild(thread) ? ("extension" as const) : ("composer" as const) } : {}), ...(clientId ? { clientId } : {}),
        });
        return this.stamp(thread, out);
      }
      case "contextCompaction":
        this.closeSegment(thread, out);
        if (this.opts.history) {
          if (phase === "completed") out.push({ type: "notice", level: "info", source: "compaction", text: "Compacted the conversation." });
        } else if (phase === "started") out.push({ type: "compaction", phase: "start", reason: "auto" });
        else out.push({ type: "compaction", phase: "end", outcome: "done" });
        return this.stamp(thread, out);
      case "enteredReviewMode":
      case "exitedReviewMode":
        if (phase === "completed") {
          this.closeSegment(thread, out);
          out.push({ type: "notice", level: "info", source: "host", text: type === "enteredReviewMode" ? `Review started: ${item.review ?? ""}`.trim() : "Review finished." });
          if (type === "exitedReviewMode" && str(item.review)) {
            out.push({ type: "assistant_start" }, { type: "assistant_block_end", index: 0, kind: "text", text: item.review }, { type: "assistant_end", content: [{ type: "text", text: item.review }] });
          }
        }
        return this.stamp(thread, out);
      case "hookPrompt":
      case "subAgentActivity":
        return out;
    }
    if (NON_TOOLS.has(type)) return out;
    // A tool.
    this.closeSegment(thread, out, "toolUse");
    const args = toolArgs(item);
    const open = this.tools.get(id);
    if (phase === "started") {
      if (!open) this.tools.set(id, { thread, name: type, args, output: "", startedAt: Date.now() });
      out.push({ type: "tool_started", callId: id, name: type, args });
      return this.stamp(thread, out);
    }
    if (type === "collabAgentToolCall" && item.tool === "spawnAgent") {
      for (const t of (item.receiverThreadIds ?? []) as string[]) if (typeof t === "string") this.childParents.set(t, id);
    }
    if (str(item.status) === "inProgress") {
      // A completed-looking record of a tool still running (history of an interrupted turn): leave it open.
      if (!open) this.tools.set(id, { thread, name: type, args, output: str(item.aggregatedOutput) ?? "", startedAt: Date.now() });
      out.push({ type: "tool_started", callId: id, name: type, args });
      return this.stamp(thread, out);
    }
    this.tools.delete(id);
    const r = toolResult(item, open?.output ?? "", this.opts.readImage);
    const durationMs = num(item.durationMs);
    out.push({ type: "tool_started", callId: id, name: type, args });
    out.push({
      type: "tool_ended", callId: id, name: type, args, isError: r.isError, ...(r.declined ? { declined: true } : {}),
      output: r.output, ...(r.images.length ? { images: r.images } : {}), result: item, ...(durationMs !== undefined ? { durationMs } : {}),
    });
    return this.stamp(thread, out);
  }

  /** A turn of `thread` ended: close its segment and any tool it left open. */
  turnCompleted(thread: string, turn: Rec): NormalizedEvent[] {
    const out: NormalizedEvent[] = [];
    const status = str(turn?.status);
    const error = str(turn?.error?.message);
    const stop = status === "interrupted" ? "aborted" : status === "failed" ? "error" : "stop";
    this.closeSegment(thread, out, stop, stop === "error" ? error ?? "The turn failed" : undefined);
    for (const [id, t] of [...this.tools]) {
      if (t.thread !== thread) continue;
      this.tools.delete(id);
      const note = status === "interrupted" ? "Interrupted." : "Codex did not report a result.";
      out.push({ type: "tool_ended", callId: id, name: t.name, args: t.args, isError: true, output: t.output + (t.output ? "\n" : "") + note });
    }
    return this.stamp(thread, out);
  }

  // ---------------------------------------------------------------- live notifications

  /** An item-level notification → events. Run, session and ask notifications are the adapter's. */
  notification(method: string, p: Rec): NormalizedEvent[] {
    const thread = str(p.threadId) ?? this.mainThread ?? "";
    if (!this.known(thread)) return [];
    const out: NormalizedEvent[] = [];
    switch (method) {
      case "item/started":
        return this.item(thread, "started", p.item);
      case "item/completed":
        return this.item(thread, "completed", p.item);
      case "item/agentMessage/delta":
        this.delta(thread, String(p.itemId), "text", str(p.delta) ?? "", out);
        return this.stamp(thread, out);
      case "item/plan/delta": {
        const id = String(p.itemId);
        this.planText.set(id, (this.planText.get(id) ?? "") + (str(p.delta) ?? ""));
        this.delta(thread, id, "text", str(p.delta) ?? "", out);
        return this.stamp(thread, out);
      }
      case "item/reasoning/summaryPartAdded": {
        const s = this.segment(thread, out);
        const id = String(p.itemId);
        const i = this.blockIndex(thread, id, "thinking", out);
        const n = (s.parts.get(id) ?? 0) + 1;
        s.parts.set(id, n);
        if (n > 1 && s.streamed.get(i)) this.delta(thread, id, "thinking", "\n\n", out);
        return this.stamp(thread, out);
      }
      case "item/reasoning/summaryTextDelta":
        this.delta(thread, String(p.itemId), "thinking", str(p.delta) ?? "", out);
        return this.stamp(thread, out);
      case "item/reasoning/textDelta": {
        // Raw reasoning: shown only for items that stream no summary.
        const s = this.segments.get(thread);
        if (s?.parts.has(String(p.itemId))) return out;
        this.delta(thread, String(p.itemId), "thinking", str(p.delta) ?? "", out);
        return this.stamp(thread, out);
      }
      case "item/commandExecution/outputDelta":
      case "item/fileChange/outputDelta": {
        const t = this.tools.get(String(p.itemId));
        if (!t) return out;
        t.output = (t.output + (str(p.delta) ?? "")).slice(-1024 * 1024);
        out.push({ type: "tool_progress", callId: String(p.itemId), name: t.name, output: t.output });
        return this.stamp(thread, out);
      }
      case "item/commandExecution/terminalInteraction": {
        const t = this.tools.get(String(p.itemId));
        if (!t || !str(p.stdin)) return out;
        t.output = t.output + `\n> ${p.stdin}`;
        out.push({ type: "tool_progress", callId: String(p.itemId), name: t.name, output: t.output });
        return this.stamp(thread, out);
      }
      case "item/mcpToolCall/progress": {
        const t = this.tools.get(String(p.itemId));
        if (!t || !str(p.message)) return out;
        t.output = t.output ? `${t.output}\n${p.message}` : p.message;
        out.push({ type: "tool_progress", callId: String(p.itemId), name: t.name, output: t.output });
        return this.stamp(thread, out);
      }
      case "turn/plan/updated": {
        const steps: PlanStep[] = (Array.isArray(p.plan) ? p.plan : []).map((s: Rec) => ({ text: String(s?.step ?? ""), status: planStatus(s?.status) }));
        out.push({ type: "plan", key: `${thread}:${p.turnId ?? ""}`, ...(str(p.explanation) ? { explanation: p.explanation } : {}), steps });
        return this.stamp(thread, out);
      }
      case "thread/tokenUsage/updated": {
        const u = p.tokenUsage as TokenUsage | undefined;
        if (!u?.total) return out;
        this.usage.set(thread, u);
        if (u.last) this.pendingUsage.set(thread, addUsage(this.pendingUsage.get(thread), usageOf(u.last)));
        return out;
      }
    }
    return out;
  }
}
