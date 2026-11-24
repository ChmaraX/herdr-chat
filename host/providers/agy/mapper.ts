// Pure translation of Antigravity ACP `session/update` notifications into
// herdr-chat NormalizedEvents, used for both live runs and `session/load` replay.
import type {
  AssistantBlock,
  ImageBlock,
  NormalizedEvent,
  PlanStep,
  StopReason,
  Usage,
} from "../types.ts";

type Rec = Record<string, any>;

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Extract text and image blocks from ACP tool_call_update `content` and `rawOutput`. */
export function extractToolOutput(u: Rec): { output: string; images: ImageBlock[] } {
  const parts: string[] = [];
  const images: ImageBlock[] = [];
  if (Array.isArray(u.content)) {
    for (const entry of u.content) {
      if (!entry || typeof entry !== "object") continue;
      if (entry.type === "content" && entry.content && typeof entry.content === "object") {
        const inner = entry.content as Rec;
        if (inner.type === "text" && typeof inner.text === "string") parts.push(inner.text);
        else if (inner.type === "image" && typeof inner.data === "string" && typeof inner.mimeType === "string") {
          images.push({ data: inner.data, mimeType: inner.mimeType });
        }
      } else if (entry.type === "text" && typeof entry.text === "string") {
        parts.push(entry.text);
      } else if (entry.type === "image" && typeof entry.data === "string" && typeof entry.mimeType === "string") {
        images.push({ data: entry.data, mimeType: entry.mimeType });
      } else if (entry.type === "diff") {
        const path = str(entry.path) ?? "";
        const oldText = str(entry.oldText) ?? "";
        const newText = str(entry.newText) ?? "";
        if (oldText || newText) parts.push(`--- ${path}\n+++ ${path}\n-${oldText}\n+${newText}`);
      }
    }
  }
  if (!parts.length && u.rawOutput !== undefined && u.rawOutput !== null) {
    if (typeof u.rawOutput === "string") parts.push(u.rawOutput);
    else if (typeof u.rawOutput === "object") {
      const o = u.rawOutput as Rec;
      if (typeof o.output === "string") parts.push(o.output);
      else if (typeof o.content === "string") parts.push(o.content);
      else if (typeof o.error === "string") parts.push(o.error);
      else {
        try { parts.push(JSON.stringify(o, null, 2)); } catch {}
      }
    }
  }
  return { output: parts.join("\n"), images };
}

export function mapStopReason(raw: unknown): StopReason {
  switch (raw) {
    case "end_turn":
      return "stop";
    case "max_tokens":
    case "max_turn_requests":
      return "length";
    case "cancelled":
      return "aborted";
    case "refusal":
      return "error";
    default:
      return "stop";
  }
}

export function mapUsage(raw: unknown): Usage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const u = raw as Rec;
  const input = num(u.inputTokens) ?? num(u.input_tokens) ?? 0;
  const output = num(u.outputTokens) ?? num(u.output_tokens) ?? 0;
  const cacheRead = num(u.cachedReadTokens) ?? num(u.cache_read_tokens) ?? 0;
  const cacheWrite = num(u.cachedWriteTokens) ?? num(u.cache_write_tokens) ?? 0;
  if (!input && !output && !cacheRead && !cacheWrite) return undefined;
  return { input, output, cacheRead, cacheWrite, cost: null };
}

function mapPlanStatus(status: unknown): PlanStep["status"] {
  if (status === "completed" || status === "done") return "completed";
  if (status === "in_progress" || status === "active") return "in_progress";
  return "pending";
}

export class AgyMapper {
  private inAssistant = false;
  private nextIndex = 0;
  private openBlock: { index: number; kind: "text" | "thinking" } | null = null;
  private blocks: (AssistantBlock | null)[] = [];
  private toolsSeen = new Map<string, { name: string; args: unknown; ended: boolean }>();
  private pendingUser: { text: string; images: ImageBlock[] } | null = null;
  private turnStartAt: number | null = null;

  /** Number of tool calls currently in progress (not yet ended). */
  get openToolCount(): number {
    let n = 0;
    for (const t of this.toolsSeen.values()) if (!t.ended) n++;
    return n;
  }

  reset(): void {
    this.inAssistant = false;
    this.nextIndex = 0;
    this.openBlock = null;
    this.blocks = [];
    this.toolsSeen.clear();
    this.pendingUser = null;
    this.turnStartAt = null;
  }

  private ensureAssistant(out: NormalizedEvent[]): void {
    if (this.inAssistant) return;
    this.inAssistant = true;
    this.nextIndex = 0;
    this.openBlock = null;
    this.blocks = [];
    this.turnStartAt = Date.now();
    out.push({ type: "assistant_start" });
  }

  private closeOpenBlock(out: NormalizedEvent[]): void {
    if (!this.openBlock) return;
    const { index, kind } = this.openBlock;
    this.openBlock = null;
    const blk = this.blocks[index];
    out.push({
      type: "assistant_block_end",
      index,
      kind,
      ...(blk && (blk.type === "text" || blk.type === "thinking") ? { text: blk.text } : {}),
    });
  }

  private flushPendingUser(out: NormalizedEvent[]): void {
    if (!this.pendingUser) return;
    const u = this.pendingUser;
    this.pendingUser = null;
    out.push({
      type: "user_message",
      text: u.text,
      images: u.images.length,
      ...(u.images.length ? { imageBlocks: u.images } : {}),
      source: "composer",
    });
  }

  /** Flush any open replay/turn state when a turn ends or history replay completes. */
  finishTurn(opts: { stopReason?: StopReason; error?: string; model?: string; usage?: Usage } = {}): NormalizedEvent[] {
    const out: NormalizedEvent[] = [];
    this.flushPendingUser(out);
    if (!this.inAssistant) {
      if (opts.stopReason === "error" || opts.stopReason === "aborted") {
        out.push({ type: "assistant_start" });
        out.push({
          type: "assistant_end",
          content: [],
          stopReason: opts.stopReason,
          ...(opts.error ? { error: opts.error } : {}),
          ...(opts.model ? { model: opts.model } : {}),
          ...(opts.usage ? { usage: opts.usage } : {}),
        });
      }
      return out;
    }
    this.closeOpenBlock(out);
    const durationMs = this.turnStartAt !== null ? Math.max(0, Date.now() - this.turnStartAt) : undefined;
    out.push({
      type: "assistant_end",
      content: this.blocks,
      stopReason: opts.stopReason ?? "stop",
      ...(opts.error ? { error: opts.error } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.usage ? { usage: opts.usage } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
    });
    this.inAssistant = false;
    this.nextIndex = 0;
    this.openBlock = null;
    this.blocks = [];
    this.turnStartAt = null;
    return out;
  }

  /** Map one ACP `session/update` payload to NormalizedEvents. */
  onUpdate(u: Rec, opts: { replay?: boolean; model?: string } = {}): NormalizedEvent[] {
    const out: NormalizedEvent[] = [];
    const kind = str(u.sessionUpdate);
    if (!kind) return out;

    if (kind === "user_message_chunk") {
      if (this.inAssistant) out.push(...this.finishTurn({ stopReason: "stop", model: opts.model }));
      const c = u.content as Rec | undefined;
      if (!this.pendingUser) this.pendingUser = { text: "", images: [] };
      if (c?.type === "text" && typeof c.text === "string") {
        this.pendingUser.text += c.text;
      } else if (c?.type === "image" && typeof c.data === "string" && typeof c.mimeType === "string") {
        this.pendingUser.images.push({ data: c.data, mimeType: c.mimeType });
      }
      return out;
    }

    // Any non-user event flushes a buffered replay user message.
    if (opts.replay) this.flushPendingUser(out);

    switch (kind) {
      case "agent_thought_chunk":
      case "agent_message_chunk": {
        const blockKind = kind === "agent_thought_chunk" ? "thinking" : "text";
        const c = u.content as Rec | undefined;
        const delta = c?.type === "text" && typeof c.text === "string" ? c.text : "";
        if (!delta) break;
        this.ensureAssistant(out);
        if (this.openBlock && this.openBlock.kind !== blockKind) {
          this.closeOpenBlock(out);
        }
        if (!this.openBlock) {
          const index = this.nextIndex++;
          this.openBlock = { index, kind: blockKind };
          this.blocks[index] = { type: blockKind, text: "" };
          out.push({ type: "assistant_block_start", index, kind: blockKind });
        }
        const blk = this.blocks[this.openBlock.index];
        if (blk && (blk.type === "text" || blk.type === "thinking")) blk.text += delta;
        out.push({ type: "assistant_delta", index: this.openBlock.index, kind: blockKind, delta });
        break;
      }

      case "tool_call": {
        this.ensureAssistant(out);
        this.closeOpenBlock(out);
        const callId = str(u.toolCallId) ?? `call_${this.nextIndex}`;
        const name = str(u.name) ?? str(u.title) ?? "tool";
        const args = u.args ?? u.rawInput ?? {};
        const index = this.nextIndex++;
        this.blocks[index] = { type: "toolCall", callId, name, args };
        this.toolsSeen.set(callId, { name, args, ended: false });
        out.push({ type: "tool_call", index, callId, name, args });
        out.push({ type: "tool_started", callId, name, args });
        const status = str(u.status);
        if (status === "completed" || status === "failed" || status === "cancelled") {
          const { output, images } = extractToolOutput(u);
          const exitCode = typeof u.rawOutput?.exit_code === "number" ? u.rawOutput.exit_code : undefined;
          const isError = status === "failed" || (exitCode !== undefined && exitCode !== 0);
          const declined = status === "cancelled";
          this.toolsSeen.get(callId)!.ended = true;
          out.push({
            type: "tool_ended",
            callId,
            name,
            args,
            isError,
            ...(declined ? { declined: true } : {}),
            output,
            ...(images.length ? { images } : {}),
            ...(u.rawOutput !== undefined ? { result: u.rawOutput } : {}),
          });
        }
        break;
      }

      case "tool_call_update": {
        const callId = str(u.toolCallId);
        if (!callId) break;
        const prev = this.toolsSeen.get(callId);
        const name = str(u.name) ?? prev?.name ?? str(u.title) ?? "tool";
        const args = u.args ?? u.rawInput ?? prev?.args;
        if (!prev) {
          this.ensureAssistant(out);
          this.closeOpenBlock(out);
          const index = this.nextIndex++;
          this.blocks[index] = { type: "toolCall", callId, name, args: args ?? {} };
          this.toolsSeen.set(callId, { name, args: args ?? {}, ended: false });
          out.push({ type: "tool_call", index, callId, name, args: args ?? {} });
          out.push({ type: "tool_started", callId, name, args: args ?? {} });
        }
        const status = str(u.status);
        const { output, images } = extractToolOutput(u);
        if (status === "completed" || status === "failed" || status === "cancelled") {
          const entry = this.toolsSeen.get(callId)!;
          if (entry.ended) break;
          entry.ended = true;
          const exitCode = typeof u.rawOutput?.exit_code === "number" ? u.rawOutput.exit_code : undefined;
          const isError = status === "failed" || (exitCode !== undefined && exitCode !== 0);
          const declined = status === "cancelled";
          out.push({
            type: "tool_ended",
            callId,
            name,
            args,
            isError,
            ...(declined ? { declined: true } : {}),
            output,
            ...(images.length ? { images } : {}),
            ...(u.rawOutput !== undefined ? { result: u.rawOutput } : {}),
          });
        } else if (output) {
          out.push({ type: "tool_progress", callId, name, args, output });
        }
        break;
      }

      case "plan": {
        const entries = Array.isArray(u.entries) ? (u.entries as Rec[]) : [];
        const steps: PlanStep[] = entries
          .map((e) => ({ text: str(e?.content) ?? str(e?.text) ?? "", status: mapPlanStatus(e?.status) }))
          .filter((s) => s.text.length > 0);
        out.push({ type: "plan", steps });
        break;
      }

      case "session_info_update": {
        const title = str(u.title);
        if (title) out.push({ type: "session", name: title });
        break;
      }

      case "current_mode_update": {
        const mode = str(u.currentModeId);
        if (mode) out.push({ type: "permission_mode", mode });
        break;
      }
    }
    return out;
  }
}
