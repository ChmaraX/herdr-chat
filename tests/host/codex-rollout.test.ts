// The plans a Codex resume reads back from rollout files, checked against what
// codex-cli 0.163 sent live in the same session (tests/fixtures/codex/plan-rollout*,
// recorded by record.mjs): its update_plan calls are code mode's `exec` JS, one
// turn has a steer between two calls, and a fork's file starts after its source's
// history. What could go wrong: the code-mode form is missed; a turn id differs
// from thread/turns/list's; a plan after a steer is placed after the first
// prompt; a fork loses its source's turns; a long turn pushes its start out of reach.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rolloutPlans } from "../../host/providers/codex/rollout.ts";
import { CODEX_FIXTURES } from "../fake-codex/host.ts";

type Rec = Record<string, any>;
const SOURCE = join(CODEX_FIXTURES, "plan-rollout.rollout.jsonl");
const FORK = join(CODEX_FIXTURES, "plan-rollout.fork.rollout.jsonl");
const recording: Rec[] = readFileSync(join(CODEX_FIXTURES, "plan-rollout.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).msg);
const STATUS: Record<string, string> = { pending: "pending", inProgress: "in_progress", completed: "completed" };

/** What the app-server sent live: each turn's turn/plan/updated as a plan event, with how many of the turn's user messages it came after. */
function live(): Map<string, { prompts: number; plan: Rec }[]> {
  const out = new Map<string, { prompts: number; plan: Rec }[]>();
  const prompts = new Map<string, number>();
  for (const m of recording) {
    if (m?.method === "item/completed" && m.params.item.type === "userMessage") prompts.set(m.params.turnId, (prompts.get(m.params.turnId) ?? 0) + 1);
    if (m?.method !== "turn/plan/updated") continue;
    const p = m.params;
    const plan = { type: "plan", ...(p.explanation ? { explanation: p.explanation } : {}), steps: p.plan.map((s: Rec) => ({ text: s.step, status: STATUS[s.status] })) };
    out.set(p.turnId, [...(out.get(p.turnId) ?? []), { prompts: prompts.get(p.turnId) ?? 0, plan }]);
  }
  return out;
}

/** thread/turns/list's turn ids, per response, in the order the recording asked. */
const listed: string[][] = recording.filter((m) => Array.isArray(m?.result?.data) && m.result.data[0]?.items).map((m) => m.result.data.map((t: Rec) => t.id));
const threadOf = (path: string) => JSON.parse(readFileSync(path, "utf8").split("\n")[0]!).payload.id as string;
const pathOf = async (id: string) => (id === threadOf(SOURCE) ? SOURCE : null);
const withoutTs = (plans: Map<string, { prompts: number; plan: Rec }[]>) =>
  new Map([...plans].map(([turn, list]) => [turn, list.map(({ prompts, plan: { ts, ...plan } }) => (void ts, { prompts, plan }))]));
const pick = <T>(m: Map<string, T>, keys: string[]) => new Map(keys.filter((k) => m.has(k)).map((k) => [k, m.get(k)!]));

test("codex rollout: code mode's update_plan calls give the plans Codex sent live, under thread/turns/list's turn ids, after the user message each came after", async () => {
  const plans = await rolloutPlans(SOURCE, pathOf);
  const [sourceTurns] = listed;
  assert.equal(sourceTurns!.length, 2, "the recording listed the source's two turns");
  assert.deepEqual([...plans.keys()], sourceTurns, "one entry per listed turn, by the same id");
  assert.deepEqual(withoutTs(plans), pick(live(), sourceTurns!));
  assert.deepEqual(plans.get(sourceTurns![0]!)!.map((p) => p.prompts), [1, 2], "the steered turn's second plan came after its second user message");
  assert.ok([...plans.values()].flat().every((p) => Number.isFinite(p.plan.ts)), "each plan has the time Codex wrote it");
});

test("codex rollout: a fork's file reads its source's history up to the fork, then its own turns", async () => {
  const plans = await rolloutPlans(FORK, pathOf);
  const forkTurns = listed[1]!;
  assert.equal(forkTurns[0], listed[0]![0], "Codex lists the source's first turn in the fork, by its id");
  assert.deepEqual([...plans.keys()], forkTurns);
  assert.deepEqual(withoutTs(plans), pick(live(), forkTurns), "the source's turn after the fork point is left out");
  assert.deepEqual(await rolloutPlans(FORK, async () => null), pick(await rolloutPlans(FORK, pathOf), [forkTurns[1]!]), "a source Codex can't find leaves the fork's own plans");
});

test("codex rollout: a plan 40 MiB after its turn started is still that turn's; a missing file has none", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pich-rollout-"));
  const path = join(dir, "rollout.jsonl");
  const real = readFileSync(SOURCE, "utf8").split("\n").filter(Boolean);
  const turn = listed[0]![0]!;
  const [meta, started, context, prompt] = real;
  const call = real.find((l) => l.includes("custom_tool_call") && l.includes(turn))!;
  writeFileSync(path, [meta, started, context, prompt].join("\n") + "\n");
  const filler = JSON.stringify({ timestamp: "2026-11-15T16:30:00.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "call_x", output: "x".repeat(1 << 20) } }) + "\n";
  for (let i = 0; i < 40; i++) appendFileSync(path, filler);
  appendFileSync(path, call + "\n");
  const plans = await rolloutPlans(path, async () => null);
  assert.deepEqual([...plans.keys()], [turn]);
  assert.deepEqual(plans.get(turn)!.map((p) => [p.prompts, p.plan.steps.length]), [[1, 3]]);
  assert.deepEqual(await rolloutPlans(join(dir, "gone.jsonl"), async () => null), new Map());
});
