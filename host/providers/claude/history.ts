// A Claude Code transcript on disk → the normalized events that rebuild the
// timeline. `--resume` replays nothing on stdout, so this is the only history.
// The active branch is the parentUuid chain back from the last record;
// compaction boundaries continue through logicalParentUuid, so what came
// before a compaction stays visible (with a compaction notice), as live.
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { readTranscript, promptText } from "./sessions.ts";
import { imagesOf, textOf, toolEnded, usageOf, planFor } from "./mapper.ts";
import type { NormalizedEvent, AssistantBlock, StopReason } from "../types.ts";

type Rec = Record<string, any>;

const STOP: Record<string, StopReason> = { end_turn: "stop", stop_sequence: "stop", tool_use: "toolUse", max_tokens: "length", refusal: "error" };

function tsOf(r: Rec): number | undefined {
  const t = typeof r.timestamp === "string" ? Date.parse(r.timestamp) : NaN;
  return Number.isFinite(t) ? t : undefined;
}

/** The records of the active branch, oldest first: back from the last record, or from `upTo`. */
function activeBranch(records: Rec[], upTo?: string): Rec[] {
  const byUuid = new Map<string, Rec>();
  let leaf: Rec | null = null;
  for (const r of records) {
    if (typeof r.uuid !== "string" || r.isSidechain) continue;
    byUuid.set(r.uuid, r);
    if (r.type === "user" || r.type === "assistant" || r.type === "system" || r.type === "attachment") leaf = r;
  }
  if (upTo) leaf = byUuid.get(upTo) ?? null;
  const chain: Rec[] = [];
  const seen = new Set<string>();
  for (let r = leaf; r && !seen.has(r.uuid); ) {
    seen.add(r.uuid);
    chain.push(r);
    const up = r.parentUuid ?? r.logicalParentUuid;
    r = typeof up === "string" ? byUuid.get(up) ?? null : null;
  }
  return chain.reverse();
}

function localStdout(text: string): string | null {
  const m = /^\s*<local-command-stdout>([\s\S]*?)<\/local-command-stdout>\s*$/.exec(text);
  return m ? m[1]!.trim() : null;
}

type Ctx = { names: Map<string, string>; out: NormalizedEvent[]; sessionDir: string };

function emitAssistant(group: Rec[], ctx: Ctx, parent?: string): void {
  const first = group[0]!;
  const m: Rec = first.message ?? {};
  const blocks: Rec[] = group.flatMap((r) => (Array.isArray(r.message?.content) ? r.message.content : []));
  const last = group.at(-1)!.message ?? {};
  const ts = tsOf(first);
  const p = parent ? { parent } : {};
  const content: (AssistantBlock | null)[] = blocks.map((b) => {
    if (b.type === "text") return b.text ? { type: "text", text: String(b.text) } : null;
    if (b.type === "thinking") return b.thinking ? { type: "thinking", text: String(b.thinking) } : null;
    if (b.type === "tool_use") {
      ctx.names.set(String(b.id), String(b.name ?? "tool"));
      return { type: "toolCall", callId: String(b.id), name: String(b.name ?? "tool"), args: b.input };
    }
    return null;
  });
  if (parent) {
    // Live, a subagent's messages arrive one record at a time with no stop reason.
    for (const r of group) {
      const c: Rec[] = Array.isArray(r.message?.content) ? r.message.content : [];
      const texts = c.map((b) => (b.type === "text" && b.text ? { type: "text" as const, text: String(b.text) } : b.type === "thinking" && b.thinking ? { type: "thinking" as const, text: String(b.thinking) } : null));
      if (texts.some(Boolean)) ctx.out.push({ type: "assistant_end", content: texts, ...p, ...(tsOf(r) ? { ts: tsOf(r) } : {}) });
      for (const b of c) {
        if (b.type !== "tool_use") continue;
        ctx.names.set(String(b.id), String(b.name ?? "tool"));
        ctx.out.push({ type: "tool_call", callId: String(b.id), name: String(b.name ?? "tool"), args: b.input, ...p, ...(ts ? { ts } : {}) });
        const plan = planFor(String(b.name), b.input, parent);
        if (plan) ctx.out.push({ ...plan, ...(ts ? { ts } : {}) });
      }
    }
    return;
  }
  const synthetic = m.model === "<synthetic>";
  const stop = typeof last.stop_reason === "string" ? STOP[last.stop_reason] ?? "stop" : blocks.at(-1)?.type === "tool_use" ? "toolUse" : "stop";
  const isError = typeof first.error === "string" || first.isApiErrorMessage === true;
  const usage = synthetic ? undefined : usageOf(last.usage);
  ctx.out.push({
    type: "assistant_end", content, stopReason: isError ? "error" : stop, ...(isError ? { error: textOf(blocks) || String(first.error) } : {}),
    ...(usage ? { usage } : {}), ...(!synthetic && typeof m.model === "string" ? { model: m.model } : {}), ...(ts ? { ts } : {}),
  });
  for (const b of blocks) {
    if (b.type !== "tool_use") continue;
    const plan = planFor(String(b.name), b.input);
    if (plan) ctx.out.push({ ...plan, ...(ts ? { ts } : {}) });
  }
}

function emitRecords(records: Rec[], ctx: Ctx, parent?: string): void {
  let group: Rec[] = [];
  const flush = () => {
    if (group.length) emitAssistant(group, ctx, parent);
    group = [];
  };
  for (const r of records) {
    if (r.type === "assistant") {
      if (group.length && group[0]!.message?.id !== r.message?.id) flush();
      group.push(r);
      continue;
    }
    if (r.type !== "user" && r.type !== "system") continue;
    flush();
    const ts = tsOf(r);
    const t = ts ? { ts } : {};
    const p = parent ? { parent } : {};
    if (r.type === "system") {
      if (parent) continue;
      if (r.subtype === "compact_boundary") {
        const md: Rec = r.compactMetadata ?? r.compact_metadata ?? {};
        const before = md.preTokens ?? md.pre_tokens;
        ctx.out.push({ type: "notice", level: "info", source: "compaction", text: `Compacted the conversation (${Math.round((typeof before === "number" ? before : 0) / 1000)}k tokens before).`, ...t });
      } else if (r.subtype === "local_command" && typeof r.content === "string") {
        const stdout = localStdout(r.content);
        if (stdout !== null) {
          if (stdout) ctx.out.push({ type: "assistant_end", content: [{ type: "text", text: stdout }], stopReason: "stop", ...t });
        } else {
          const cmd = promptText({ type: "user", message: { content: r.content } });
          if (cmd) ctx.out.push({ type: "user_message", text: cmd, images: 0, source: "composer", ...t });
        }
      }
      continue;
    }
    const c = r.message?.content;
    if (Array.isArray(c) && c.some((b: Rec) => b?.type === "tool_result")) {
      for (const b of c) {
        if (b?.type !== "tool_result") continue;
        const declined = r.permissionDecision?.decision === "reject" || r.toolDenialKind === "permission-rule";
        const name = ctx.names.get(String(b.tool_use_id)) ?? "tool";
        ctx.out.push({ ...toolEnded(b, name, r.toolUseResult, declined, parent), ...t });
        // A subagent's own steps live in their own file, nested under its card.
        const agentId = r.toolUseResult?.agentId;
        if ((name === "Agent" || name === "Task") && typeof agentId === "string") {
          const file = join(ctx.sessionDir, "subagents", `agent-${agentId}.jsonl`);
          if (existsSync(file)) {
            const sub = readTranscript(file).filter((x) => x.type === "assistant" || (x.type === "user" && Array.isArray(x.message?.content) && x.message.content.some((b: Rec) => b?.type === "tool_result")));
            // The subagent's final report is the Agent card's output; live it isn't sent as a message.
            while (sub.length && sub.at(-1)!.type === "assistant" && !sub.at(-1)!.message?.content?.some((b: Rec) => b?.type === "tool_use")) sub.pop();
            const at = ctx.out.length - 1;
            const nested: Ctx = { ...ctx, out: [] };
            emitRecords(sub, nested, String(b.tool_use_id));
            // Nested steps come before the card ends, as live.
            ctx.out.splice(at, 0, ...nested.out);
          }
        }
      }
      continue;
    }
    if (parent) continue;
    const text = promptText(r);
    // Our /compact isn't a prompt (live it's a compaction, shown by the boundary's notice).
    if (text === null || /^\/compact(\s|$)/.test(text)) continue;
    const images = imagesOf(c);
    ctx.out.push({ type: "user_message", text, images: images.length, ...(images.length ? { imageBlocks: images } : {}), source: "composer", ...t, ...p });
  }
  flush();
}

/** `upTo`: the record the branch ends at (a fork's `--resume-session-at`), else the last one. */
export function historyEvents(path: string, upTo?: string): NormalizedEvent[] {
  const records = readTranscript(path);
  if (!records.length) return [];
  const ctx: Ctx = { names: new Map(), out: [], sessionDir: join(dirname(path), path.replace(/^.*\//, "").replace(/\.jsonl$/, "")) };
  emitRecords(activeBranch(records, upTo), ctx);
  return ctx.out;
}

/**
 * The person's prompts on the active branch, oldest first, each with `at`:
 * the last assistant message before it, where a fork resumes
 * (`--resume-session-at`); null for the first prompt (nothing before it).
 */
export function forkPoints(path: string): { id: string; text: string; at: string | null }[] {
  const out: { id: string; text: string; at: string | null }[] = [];
  let at: string | null = null;
  for (const r of activeBranch(readTranscript(path))) {
    if (r.type === "assistant") at = r.uuid;
    const text = promptText(r);
    if (text !== null && r.type === "user") out.push({ id: r.uuid, text, at });
  }
  return out;
}

/** Whether a transcript has anything to show. */
export function hasMessages(path: string): boolean {
  if (!existsSync(path)) return false;
  return readTranscript(path).some((r) => !r.isSidechain && (r.type === "assistant" || promptText(r) !== null));
}
