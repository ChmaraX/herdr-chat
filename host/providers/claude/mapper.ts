// Claude Code stream-json records → normalized events. No I/O: the adapter
// feeds it records (and tells it what it sent) and forwards what comes out.
// Control requests and responses are the adapter's.
import type { NormalizedEvent, EventOf, AssistantBlock, ImageBlock, StopReason, Usage, PlanStep } from "../types.ts";

type Rec = Record<string, any>;

export type Priority = "now" | "next" | "later";
/** A user message the adapter sent, by its uuid. `queued`: sent while a run was on. */
export type Sent = { uuid: string; text: string; images: ImageBlock[]; priority: Priority; queued: boolean; echoed: boolean; cancelled: boolean };

type Block = { kind: "text" | "thinking" | "tool"; text: string; started: boolean; ended: boolean; callId?: string; name?: string; args?: unknown };
type Msg = { id: string | null; model?: string; blocks: Map<number, Block>; open: number | null; stop?: string; usage?: Rec };

const STOP: Record<string, StopReason> = { end_turn: "stop", stop_sequence: "stop", pause_turn: "stop", tool_use: "toolUse", max_tokens: "length", refusal: "error", model_context_window_exceeded: "length" };

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function usageOf(u: Rec | undefined): Usage | undefined {
  if (!u || typeof u !== "object") return undefined;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return { input: n(u.input_tokens), output: n(u.output_tokens), cacheRead: n(u.cache_read_input_tokens), cacheWrite: n(u.cache_creation_input_tokens), cost: null };
}

export function imagesOf(content: unknown): ImageBlock[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((b: Rec) => b?.type === "image" && b.source?.type === "base64" && typeof b.source.data === "string" && b.source.data.length)
    .map((b: Rec) => ({ data: b.source.data, mimeType: typeof b.source.media_type === "string" ? b.source.media_type : "image/png" }));
}

export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((b: Rec) => b?.type === "text" && typeof b.text === "string").map((b: Rec) => b.text).join("\n");
}

/** TodoWrite input → plan steps. */
export function todoSteps(input: unknown): PlanStep[] | null {
  const todos = (input as Rec)?.todos;
  if (!Array.isArray(todos)) return null;
  return todos
    .filter((t: Rec) => t && typeof t.content === "string")
    .map((t: Rec) => ({ text: t.content, status: t.status === "completed" ? "completed" : t.status === "in_progress" ? "in_progress" : "pending" }));
}

/** The plan event a tool call carries (TodoWrite), if any. */
export function planFor(name: string, input: unknown, parent?: string): NormalizedEvent | null {
  if (name !== "TodoWrite") return null;
  const steps = todoSteps(input);
  return steps ? { type: "plan", key: parent ? `todos:${parent}` : "todos", steps, ...(parent ? { parent } : {}) } : null;
}

/**
 * One `tool_result` block → `tool_ended`. `tur` is the record's structured
 * tool output (`tool_use_result` live, `toolUseResult` on disk); `declined`
 * comes from the permission metadata.
 */
export function toolEnded(b: Rec, name: string, tur: unknown, declined: boolean, parent?: string): EventOf<"tool_ended"> {
  const t: Rec | null = tur && typeof tur === "object" && !Array.isArray(tur) ? (tur as Rec) : null;
  let output = textOf(b.content);
  // Read numbers its lines ("1\tfoo"); the file content is what a reader wants.
  if (name === "Read" && typeof t?.file?.content === "string") output = t.file.content;
  // A subagent's result is wrapped in a harness note; the report itself is in `content`.
  else if ((name === "Agent" || name === "Task") && Array.isArray(t?.content)) output = textOf(t!.content) || output;
  const images = imagesOf(b.content);
  return {
    type: "tool_ended", callId: String(b.tool_use_id), name, isError: b.is_error === true, ...(declined ? { declined: true } : {}),
    output, ...(images.length ? { images } : {}), ...(t ? { result: t } : {}), ...(parent ? { parent } : {}),
  };
}

export class ClaudeMapper {
  /** What we sent, by uuid (echo matching, the queue). */
  sent = new Map<string, Sent>();
  toolNames = new Map<string, string>();
  sessionId: string | null = null;
  /** The init `model` (an id such as claude-haiku-5-5). */
  initModel: string | null = null;
  permissionMode: string | null = null;
  terminalCommands: string[] = [];
  /** Set by the adapter: our own /compact is running (a compaction, not a run). */
  compactOwn = false;
  /** Set by the adapter while an interrupt is on its way. */
  aborting = false;
  /** Set by the adapter: the CLI emits session_state_changed (the env flag took). */
  sawStates = false;
  running = false;
  totalCost = 0;
  contextWindow: number | null = null;
  private msg: Msg | null = null;
  private compacting = false;
  private retrying = false;
  private turnText = false;
  private turnError = false;
  private suppressRun = false;

  /** Records that ended a turn (`result`), for the adapter's settle fallback. */
  lastResultAt = 0;

  queueEvent(): EventOf<"queue_changed"> {
    const live = [...this.sent.values()].filter((s) => s.queued && !s.echoed && !s.cancelled);
    const steering = live.filter((s) => s.priority !== "later");
    const followUp = live.filter((s) => s.priority === "later");
    return { type: "queue_changed", steering: steering.map((s) => s.text), followUp: followUp.map((s) => s.text), steeringIds: steering.map((s) => s.uuid), followUpIds: followUp.map((s) => s.uuid) };
  }

  /** The queued messages, which an interrupt with cancel_queued drops. */
  dropQueue(): string[] {
    const out: string[] = [];
    for (const s of this.sent.values()) {
      if (s.queued && !s.echoed && !s.cancelled) {
        s.cancelled = true;
        out.push(s.text);
      }
    }
    return out;
  }

  private echo(s: Sent): NormalizedEvent[] {
    if (s.echoed || s.cancelled) return [];
    s.echoed = true;
    const out: NormalizedEvent[] = [{ type: "user_message", text: s.text, images: s.images.length, ...(s.images.length ? { imageBlocks: s.images } : {}), clientId: s.uuid }];
    if (s.queued) out.push(this.queueEvent());
    return out;
  }

  /** The oldest sent message that hasn't shown up yet (a local command answers without an echo first). */
  private unechoed(): Sent | undefined {
    for (const s of this.sent.values()) if (!s.echoed && !s.cancelled && !(s.queued && s.priority === "later")) return s;
    return undefined;
  }

  private startRun(): NormalizedEvent[] {
    if (this.running) return [];
    this.running = true;
    this.turnText = false;
    this.turnError = false;
    if (this.compactOwn) {
      this.suppressRun = true;
      return [];
    }
    return [{ type: "run_started" }];
  }

  /** The run is over (idle, or the fallback). */
  settle(): NormalizedEvent[] {
    if (!this.running) return [];
    this.running = false;
    const aborted = this.aborting;
    this.aborting = false;
    this.msg = null;
    if (this.suppressRun) {
      this.suppressRun = false;
      return [];
    }
    return [{ type: "run_settled", aborted }];
  }

  map(rec: Rec): NormalizedEvent[] {
    switch (rec.type) {
      case "stream_event":
        return rec.parent_tool_use_id ? [] : this.stream(rec.event ?? {});
      case "assistant":
        return this.assistant(rec);
      case "user":
        return this.user(rec);
      case "result":
        return this.result(rec);
      case "system":
        return this.system(rec);
      case "command_lifecycle": {
        const s = typeof rec.command_uuid === "string" ? this.sent.get(rec.command_uuid) : undefined;
        if (!s) return [];
        if (rec.state === "cancelled" && !s.cancelled) {
          s.cancelled = true;
          return s.queued ? [this.queueEvent()] : [];
        }
        if (rec.state === "started" && s.queued && !this.sawStates && !this.running) return this.startRun();
        return [];
      }
      case "rate_limit_event": {
        const info: Rec = rec.rate_limit_info ?? {};
        if (!info.status || info.status === "allowed" || info.status === "allowed_warning") return [];
        const when = typeof info.resetsAt === "number" ? ` until ${new Date(info.resetsAt * 1000).toLocaleTimeString()}` : "";
        return [{ type: "notice", level: "warning", source: "host", text: `Claude Code is rate limited (${info.rateLimitType ?? "limit"})${when}.`, once: "run" }];
      }
    }
    return [];
  }

  // ---------------------------------------------------------------- streaming

  private stream(e: Rec): NormalizedEvent[] {
    switch (e.type) {
      case "message_start": {
        const m: Rec = e.message ?? {};
        this.msg = { id: str(m.id) ?? null, model: str(m.model), blocks: new Map(), open: null, usage: m.usage };
        const out: NormalizedEvent[] = [];
        // The prompt's echo comes first with --replay-user-messages; without it, show the prompt now.
        const s = this.unechoed();
        if (s && !s.queued) out.push(...this.echo(s));
        if (this.retrying) {
          this.retrying = false;
          out.push({ type: "retry", phase: "end", success: true, attempt: null });
        }
        out.push({ type: "assistant_start" });
        return out;
      }
      case "content_block_start": {
        const m = this.msg;
        if (!m || typeof e.index !== "number") return [];
        const cb: Rec = e.content_block ?? {};
        m.open = e.index;
        if (cb.type === "text" || cb.type === "thinking") {
          m.blocks.set(e.index, { kind: cb.type, text: "", started: false, ended: false });
          return [];
        }
        if (typeof cb.id === "string" && typeof cb.name === "string") {
          m.blocks.set(e.index, { kind: "tool", text: "", started: true, ended: false, callId: cb.id, name: cb.name });
          this.toolNames.set(cb.id, cb.name);
          return [{ type: "tool_call_start", index: e.index, callId: cb.id, name: cb.name }];
        }
        return [];
      }
      case "content_block_delta": {
        const m = this.msg;
        const b = m && typeof e.index === "number" ? m.blocks.get(e.index) : undefined;
        if (!b) return [];
        const d: Rec = e.delta ?? {};
        if (d.type === "text_delta" && b.kind === "text" && typeof d.text === "string" && d.text) {
          b.text += d.text;
          b.started = true;
          return [{ type: "assistant_delta", index: e.index, kind: "text", delta: d.text }];
        }
        // Thinking deltas are empty unless --thinking-display summarized took.
        if (d.type === "thinking_delta" && b.kind === "thinking" && typeof d.thinking === "string" && d.thinking) {
          b.text += d.thinking;
          b.started = true;
          return [{ type: "assistant_delta", index: e.index, kind: "thinking", delta: d.thinking }];
        }
        if (d.type === "input_json_delta" && b.kind === "tool" && typeof d.partial_json === "string" && d.partial_json) {
          return [{ type: "tool_call_delta", index: e.index, delta: d.partial_json }];
        }
        return [];
      }
      case "content_block_stop": {
        const m = this.msg;
        const b = m && typeof e.index === "number" ? m.blocks.get(e.index) : undefined;
        if (m && m.open === e.index) m.open = null;
        if (!b || b.ended || b.kind === "tool" || !b.started) return [];
        b.ended = true;
        return [{ type: "assistant_block_end", index: e.index, kind: b.kind, text: b.text }];
      }
      case "message_delta": {
        if (!this.msg) return [];
        if (typeof e.delta?.stop_reason === "string") this.msg.stop = e.delta.stop_reason;
        if (e.usage) this.msg.usage = { ...this.msg.usage, ...e.usage };
        return [];
      }
      case "message_stop":
        return this.endMessage();
    }
    return [];
  }

  private endMessage(): NormalizedEvent[] {
    const m = this.msg;
    if (!m) return [];
    this.msg = null;
    const max = Math.max(-1, ...m.blocks.keys());
    const content: (AssistantBlock | null)[] = [];
    for (let i = 0; i <= max; i++) {
      const b = m.blocks.get(i);
      if (!b) content.push(null);
      else if (b.kind === "tool") content.push({ type: "toolCall", callId: b.callId!, name: b.name!, args: b.args });
      else if (b.text) content.push({ type: b.kind, text: b.text });
      else content.push(null);
    }
    const stop = m.stop ? STOP[m.stop] ?? "stop" : undefined;
    const usage = usageOf(m.usage);
    return [{ type: "assistant_end", content, ...(stop ? { stopReason: stop } : {}), ...(usage ? { usage } : {}), ...(m.model ? { model: m.model } : {}) }];
  }

  // ---------------------------------------------------------------- assistant records

  private toolCall(index: number | undefined, b: Rec, parent?: string): NormalizedEvent[] {
    const callId = String(b.id);
    const name = String(b.name ?? "tool");
    this.toolNames.set(callId, name);
    const p = parent ? { parent } : {};
    const out: NormalizedEvent[] = [
      { type: "tool_call", ...(index !== undefined ? { index } : {}), callId, name, args: b.input, ...p },
      { type: "tool_started", callId, name, args: b.input, ...p },
    ];
    const plan = planFor(name, b.input, parent);
    if (plan) out.push(plan);
    return out;
  }

  private assistant(rec: Rec): NormalizedEvent[] {
    const m: Rec = rec.message ?? {};
    const blocks: Rec[] = Array.isArray(m.content) ? m.content : [];
    const parent = str(rec.parent_tool_use_id);
    if (parent) {
      // A subagent's message (not streamed): its own item, nested under the Agent card.
      const out: NormalizedEvent[] = [];
      const content: (AssistantBlock | null)[] = blocks.map((b) =>
        b.type === "text" && b.text ? { type: "text", text: b.text } : b.type === "thinking" && b.thinking ? { type: "thinking", text: b.thinking } : null,
      );
      if (content.some(Boolean)) out.push({ type: "assistant_end", content, parent });
      for (const b of blocks) if (b.type === "tool_use") out.push(...this.toolCall(undefined, b, parent));
      return out;
    }
    if (m.model === "<synthetic>" || !this.msg || (this.msg.id && m.id && this.msg.id !== m.id)) {
      // A whole message with no stream: a local command's answer, or an API error.
      const out: NormalizedEvent[] = [];
      if (m.model === "<synthetic>") {
        const s = this.unechoed();
        if (s) out.push(...this.echo(s));
      }
      const text = textOf(blocks);
      const isError = typeof rec.error === "string";
      if (text || isError) {
        const hint = rec.error === "authentication_failed" || rec.error === "billing_error" ? " Sign in with `claude auth login` in a terminal (or /login)." : "";
        out.push({
          type: "assistant_end", content: text ? [{ type: "text", text }] : [], stopReason: isError ? "error" : "stop",
          ...(isError ? { error: (text || rec.error) + hint } : {}),
        });
        this.turnText = true;
        if (isError) this.turnError = true;
      }
      for (const b of blocks) if (b.type === "tool_use") out.push(...this.toolCall(undefined, b));
      return out;
    }
    // Streaming: one record per finished block, for the block that's open.
    const out: NormalizedEvent[] = [];
    const msg = this.msg;
    for (const b of blocks) {
      if (b.type === "tool_use") {
        let index: number | undefined;
        for (const [i, x] of msg.blocks) if (x.kind === "tool" && x.callId === b.id) index = i;
        const x = index !== undefined ? msg.blocks.get(index) : undefined;
        if (x) x.args = b.input;
        out.push(...this.toolCall(index, b));
      } else if (b.type === "text" || b.type === "thinking") {
        const kind = b.type as "text" | "thinking";
        const text = String(kind === "text" ? b.text ?? "" : b.thinking ?? "");
        let index = msg.open;
        if (index === null || msg.blocks.get(index)?.kind !== kind) {
          index = null;
          for (const [i, x] of msg.blocks) if (x.kind === kind && !x.ended) index = i;
        }
        if (index === null) continue;
        const x = msg.blocks.get(index)!;
        if (!text && !x.started) continue; // redacted thinking: nothing to show
        x.text = text;
        x.started = true;
        x.ended = true;
        if (kind === "text") this.turnText = true;
        out.push({ type: "assistant_block_end", index, kind, text });
      }
    }
    if (typeof rec.error === "string") this.turnError = true;
    return out;
  }

  // ---------------------------------------------------------------- user records

  private user(rec: Rec): NormalizedEvent[] {
    const parent = str(rec.parent_tool_use_id);
    const c = rec.message?.content;
    if (rec.isReplay) {
      const s = typeof rec.uuid === "string" ? this.sent.get(rec.uuid) : undefined;
      if (s) return this.echo(s);
      const text = typeof c === "string" ? c : textOf(c);
      if (/^\s*<(local-command-stdout|local-command-stderr|command-name|local-command-caveat)>/.test(text)) return [];
      // Not one we sent (the CLI replays our uuid): the agent's own.
      const images = imagesOf(c);
      const echo: NormalizedEvent = { type: "user_message", text, images: images.length, ...(images.length ? { imageBlocks: images } : {}) };
      // A background task (Bash run_in_background, Monitor) woke the agent.
      return /^\s*<task-notification>/.test(text) ? [{ type: "run_cause", text: "Started by a background task." }, echo] : [echo];
    }
    if (!Array.isArray(c)) return [];
    const meta: Rec[] = Array.isArray(rec.tool_result_meta) ? rec.tool_result_meta : [];
    const out: NormalizedEvent[] = [];
    for (const b of c) {
      if (b?.type !== "tool_result") continue;
      const m = meta.find((x) => x?.id === b.tool_use_id);
      const declined = m?.permission_decision?.decision === "reject" || m?.non_execution_kind === "permission-rule";
      const name = this.toolNames.get(String(b.tool_use_id)) ?? "tool";
      out.push(toolEnded(b, name, rec.tool_use_result, declined, parent));
    }
    return out;
  }

  // ---------------------------------------------------------------- results and system records

  private result(rec: Rec): NormalizedEvent[] {
    this.lastResultAt = Date.now();
    const out: NormalizedEvent[] = [];
    if (this.msg) out.push(...this.endMessage());
    if (typeof rec.total_cost_usd === "number") this.totalCost = rec.total_cost_usd;
    const mu: Rec = rec.modelUsage ?? {};
    const win = Object.values(mu).map((x: any) => x?.contextWindow).find((x) => typeof x === "number");
    if (typeof win === "number") this.contextWindow = win;
    if (rec.local_command === "compact" || (this.compacting && rec.num_turns === 0)) {
      if (this.compacting) {
        this.compacting = false;
        out.push(rec.is_error ? { type: "compaction", phase: "end", outcome: "failed", error: String(rec.result || "error") } : { type: "compaction", phase: "end", outcome: "done" });
      }
    } else if (rec.local_command && !this.turnText && typeof rec.result === "string" && rec.result) {
      const s = this.unechoed();
      if (s) out.push(...this.echo(s));
      out.push({ type: "assistant_end", content: [{ type: "text", text: rec.result }], stopReason: "stop" });
    } else if (rec.is_error && !this.aborting && rec.terminal_reason !== "aborted_tools" && rec.terminal_reason !== "aborted_streaming" && !this.turnError) {
      const errors = Array.isArray(rec.errors) ? rec.errors.filter((x: unknown) => typeof x === "string" && !x.startsWith("[ede_diagnostic]")) : [];
      const error = errors.join("\n") || str(rec.result) || String(rec.subtype ?? "error");
      out.push({ type: "assistant_end", content: [], stopReason: "error", error });
    }
    this.turnText = false;
    this.turnError = false;
    out.push({ type: "turn_end" });
    return out;
  }

  private system(rec: Rec): NormalizedEvent[] {
    switch (rec.subtype) {
      case "init": {
        const out: NormalizedEvent[] = [];
        if (typeof rec.session_id === "string" && rec.session_id !== this.sessionId) {
          this.sessionId = rec.session_id;
          out.push({ type: "session", id: rec.session_id });
        }
        if (typeof rec.model === "string") this.initModel = rec.model;
        if (typeof rec.permissionMode === "string" && rec.permissionMode !== this.permissionMode) {
          this.permissionMode = rec.permissionMode;
          out.push({ type: "permission_mode", mode: rec.permissionMode });
        }
        if (Array.isArray(rec.terminal_slash_commands)) this.terminalCommands = rec.terminal_slash_commands.map(String);
        if (!this.sawStates) out.push(...this.startRun());
        return out;
      }
      case "session_state_changed":
        this.sawStates = true;
        if (rec.state === "running") return this.startRun();
        if (rec.state === "idle") return this.settle();
        return [];
      case "status": {
        const out: NormalizedEvent[] = [];
        if (rec.status === "compacting" && !this.compacting) {
          this.compacting = true;
          out.push({ type: "compaction", phase: "start", reason: this.compactOwn ? "manual" : "auto" });
        } else if (this.compacting && rec.compact_result && rec.compact_result !== "success") {
          this.compacting = false;
          out.push({ type: "compaction", phase: "end", outcome: "failed", error: String(rec.compact_error ?? rec.compact_result) });
        }
        if (typeof rec.permissionMode === "string" && rec.permissionMode !== this.permissionMode) {
          this.permissionMode = rec.permissionMode;
          out.push({ type: "permission_mode", mode: rec.permissionMode });
        }
        return out;
      }
      case "compact_boundary": {
        const md: Rec = rec.compact_metadata ?? {};
        const wasOn = this.compacting;
        this.compacting = false;
        const out: NormalizedEvent[] = [];
        if (!wasOn) out.push({ type: "compaction", phase: "start", reason: md.trigger === "manual" ? "manual" : "auto" });
        out.push({ type: "compaction", phase: "end", outcome: "done", ...(typeof md.pre_tokens === "number" ? { tokensBefore: md.pre_tokens } : {}), ...(typeof md.post_tokens === "number" ? { tokensAfter: md.post_tokens } : {}) });
        return out;
      }
      case "api_retry":
        this.retrying = true;
        return [{
          type: "retry", phase: "start", attempt: typeof rec.attempt === "number" ? rec.attempt : 1, maxAttempts: typeof rec.max_retries === "number" ? rec.max_retries : null,
          delayMs: typeof rec.retry_delay_ms === "number" ? rec.retry_delay_ms : 0, error: String(rec.error ?? rec.error_status ?? "error"),
        }];
      case "session_title_changed":
        return typeof rec.title === "string" ? [{ type: "session", name: rec.title || null }] : [];
      case "notification":
        return typeof rec.text === "string" && rec.text ? [{ type: "notice", level: rec.priority === "high" || rec.priority === "immediate" ? "warning" : "info", source: "notify", text: rec.text }] : [];
      case "informational": {
        const text = str(rec.content) ?? str(rec.text);
        if (!text) return [];
        return [{ type: "notice", level: rec.level === "error" ? "error" : rec.level === "warning" ? "warning" : "info", source: "notify", text }];
      }
      case "hook_started":
        return typeof rec.hook_name === "string" ? [{ type: "status", key: "hook", text: `hook ${rec.hook_name}` }] : [];
      case "hook_response":
        return [{ type: "status", key: "hook", text: null }];
    }
    return [];
  }
}
