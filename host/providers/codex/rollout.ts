// `thread/turns/list` has no item for `update_plan` calls, so a resumed chat
// reads its plans from the thread's rollout file, read-only, line by line.
// Codex 0.163 writes the call as code mode's `exec` custom tool call, whose JS
// calls `tools.update_plan({...})`; without code mode it is a `function_call`
// named update_plan with JSON arguments. A call belongs to the turn the last
// `task_started` / `turn_context` record named, after as many of that turn's
// user messages (`item_completed` UserMessage; a steer adds one) as came
// before it. A fork's file starts after its source's history: its
// `session_meta.history_base` names the source thread and the first of the
// source's records it doesn't share.
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { planStatus } from "./map.ts";
import { literalArgs } from "./literal.ts";
import type { EventOf } from "../types.ts";

/** One update_plan call, and how many of its turn's user messages came before it. */
export type RolloutPlan = { prompts: number; plan: EventOf<"plan"> };
/** A thread's rollout file, from Codex (`thread/read`); null when it has none. */
export type RolloutPath = (threadId: string) => Promise<string | null>;

type Obj = Record<string, unknown>;

const RELEVANT = ["session_meta", "task_started", "turn_context", "UserMessage", "update_plan"];

const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** update_plan's arguments → the plan event; null when they aren't a plan. */
function planOf(args: unknown, ts: number | undefined): EventOf<"plan"> | null {
  if (!isObj(args) || !Array.isArray(args.plan)) return null;
  const explanation = str(args.explanation);
  return {
    type: "plan",
    ...(ts !== undefined ? { ts } : {}),
    ...(explanation ? { explanation } : {}),
    steps: args.plan.map((s) => {
      const step: Obj = isObj(s) ? s : {};
      return { text: String(step.step ?? ""), status: planStatus(step.status) };
    }),
  };
}

/** The update_plan arguments a `response_item` record carries. */
function planCalls(p: Obj): unknown[] {
  if (p.type === "function_call" && p.name === "update_plan") return [parse(str(p.arguments) ?? "")];
  if (p.type === "custom_tool_call" && p.name === "exec") return literalArgs(str(p.input) ?? "", "tools.update_plan");
  return [];
}

/** Each turn's plan updates, oldest first, by turn id, into `out`, up to the record with ordinal `end`. A file that can't be read adds what came before the failure. */
async function read(path: string, pathOf: RolloutPath, out: Map<string, RolloutPlan[]>, seen: Set<string>, end = Infinity): Promise<void> {
  let turn = null as { id: string; prompts: number } | null;
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!RELEVANT.some((k) => line.includes(k))) continue;
      const r = parse(line);
      if (!isObj(r) || !isObj(r.payload)) continue;
      if (typeof r.ordinal === "number" && r.ordinal >= end) break;
      const p = r.payload;
      if (r.type === "session_meta") {
        const base = isObj(p.history_base) ? p.history_base : null;
        const source = str(base?.thread_id);
        if (!base || !source || seen.has(source) || typeof base.end_ordinal_exclusive !== "number") continue;
        seen.add(source);
        const file = await pathOf(source);
        if (file) await read(file, pathOf, out, seen, base.end_ordinal_exclusive);
        continue;
      }
      const turnId = str(p.turn_id);
      if ((r.type === "event_msg" && p.type === "task_started") || r.type === "turn_context") {
        if (turnId && turnId !== turn?.id) turn = { id: turnId, prompts: 0 };
        continue;
      }
      if (r.type === "event_msg" && p.type === "item_completed" && isObj(p.item) && p.item.type === "UserMessage") {
        if (turn && (!turnId || turnId === turn.id)) turn.prompts++;
        continue;
      }
      if (r.type !== "response_item" || !turn) continue;
      const ts = typeof r.timestamp === "string" ? Date.parse(r.timestamp) : NaN;
      for (const args of planCalls(p)) {
        const plan = planOf(args, Number.isFinite(ts) ? ts : undefined);
        if (!plan) continue;
        let list = out.get(turn.id);
        if (!list) out.set(turn.id, (list = []));
        list.push({ prompts: turn.prompts, plan });
      }
    }
  } catch {}
}

/** Each turn's plan updates, oldest first, by turn id; a fork's include its source's. */
export async function rolloutPlans(path: string, pathOf: RolloutPath): Promise<Map<string, RolloutPlan[]>> {
  const out = new Map<string, RolloutPlan[]>();
  await read(path, pathOf, out, new Set());
  return out;
}
