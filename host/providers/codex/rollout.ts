// `thread/turns/list` has no item for `update_plan` calls, so a resumed chat
// reads its plans from the rollout file: `response_item` function calls named
// update_plan, in the turn the last `task_started` / `turn_context` record named.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { planStatus } from "./map.ts";
import type { PlanStep } from "../types.ts";

export type RolloutPlan = { ts?: number; explanation?: string; steps: PlanStep[] };

const MAX_READ = 32 * 1024 * 1024;

type Rec = Record<string, any>;

function tail(path: string): string {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const n = Math.min(size, MAX_READ);
    const buf = Buffer.alloc(n);
    readSync(fd, buf, 0, n, size - n);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** Each turn's plan updates, oldest first, by turn id. A file that can't be read has none. */
export function rolloutPlans(path: string): Map<string, RolloutPlan[]> {
  const out = new Map<string, RolloutPlan[]>();
  let text: string;
  try {
    text = tail(path);
  } catch {
    return out;
  }
  let turn: string | null = null;
  for (const line of text.split("\n")) {
    if (!line.includes("task_started") && !line.includes("turn_context") && !line.includes("update_plan")) continue;
    let r: Rec;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    const p: Rec = r?.payload ?? {};
    if ((r.type === "event_msg" && p.type === "task_started") || r.type === "turn_context") {
      if (typeof p.turn_id === "string") turn = p.turn_id;
      continue;
    }
    if (r.type !== "response_item" || p.type !== "function_call" || p.name !== "update_plan" || !turn) continue;
    let args: Rec;
    try {
      args = JSON.parse(String(p.arguments ?? ""));
    } catch {
      continue;
    }
    if (!Array.isArray(args?.plan)) continue;
    const ts = typeof r.timestamp === "string" ? Date.parse(r.timestamp) : NaN;
    const plan: RolloutPlan = {
      ...(Number.isFinite(ts) ? { ts } : {}),
      ...(typeof args.explanation === "string" && args.explanation ? { explanation: args.explanation } : {}),
      steps: args.plan.map((s: Rec) => ({ text: String(s?.step ?? ""), status: planStatus(s?.status) })),
    };
    (out.get(turn) ?? out.set(turn, []).get(turn)!).push(plan);
  }
  return out;
}
