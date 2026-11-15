// Claude Code's todo tools → plan events, read from the normalized tool events
// that the live mapper and the history both emit.
// TodoWrite's input is the whole list of one agent. The task tools (TaskCreate,
// TaskUpdate, TaskList) edit one list per session, which subagents share (the
// CLI's task list id names no agent), and a task's id comes back only in
// TaskCreate's result: so that list is built from the results. The plan shows
// it in task id order, the CLI's own (TaskList's).
import type { NormalizedEvent, EventOf, PlanStep } from "../types.ts";

type Obj = Record<string, unknown>;
type Status = PlanStep["status"];
type TaskTool = "TaskCreate" | "TaskUpdate" | "TaskList";
type PlanEvent = EventOf<"plan"> | EventOf<"subagent_plan">;
/** What a task tool's result says it did to the list. */
type Change =
  | { kind: "create"; id: string; subject: string }
  | { kind: "update"; id: string; status?: Status | "deleted"; subject?: string }
  | { kind: "reset"; tasks: Map<string, PlanStep> };

const STATUSES: ReadonlySet<string> = new Set(["pending", "in_progress", "completed"]);
const TASK_TOOLS: ReadonlySet<string> = new Set(["TaskCreate", "TaskUpdate", "TaskList"]);
// The texts 2.1.x answers TaskCreate and TaskUpdate with. Live, a subagent's
// result has only these: its record carries no tool_use_result.
const CREATED = /^Task #(\S+) created successfully: ([\s\S]*)$/;
const UPDATED = "Updated task #";

const isObject = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const isStatus = (v: unknown): v is Status => typeof v === "string" && STATUSES.has(v);
const isTaskTool = (v: string): v is TaskTool => TASK_TOOLS.has(v);
const statusOf = (v: unknown): Status => (isStatus(v) ? v : "pending");

function todoPlan(args: unknown, parent?: string): PlanEvent | null {
  const todos = isObject(args) ? args.todos : undefined;
  if (!Array.isArray(todos)) return null;
  const steps = todos.filter(isObject).flatMap((t) => (typeof t.content === "string" ? [{ text: t.content, status: statusOf(t.status) }] : []));
  return parent ? { type: "subagent_plan", key: `todos:${parent}`, parent, steps } : { type: "plan", steps };
}

/** The change a task tool's result reports, from its structured result, else its text; null when it changed nothing. */
function changeOf(tool: TaskTool, input: Obj, ev: EventOf<"tool_ended">): Change | null {
  if (ev.isError) return null;
  const result = isObject(ev.result) ? ev.result : null;
  switch (tool) {
    case "TaskCreate": {
      const task = result && isObject(result.task) ? result.task : null;
      if (typeof task?.id === "string" && typeof task.subject === "string") return { kind: "create", id: task.id, subject: task.subject };
      const m = CREATED.exec(ev.output);
      return m ? { kind: "create", id: m[1]!, subject: m[2]! } : null;
    }
    case "TaskUpdate": {
      // A task that isn't there answers success: false ("Task not found"), not an error.
      const done = result ? result.success === true : ev.output.startsWith(UPDATED);
      if (!done) return null;
      const status = input.status === "deleted" || isStatus(input.status) ? input.status : undefined;
      return { kind: "update", id: String(input.taskId), ...(status ? { status } : {}), ...(typeof input.subject === "string" ? { subject: input.subject } : {}) };
    }
    case "TaskList": {
      if (!result || !Array.isArray(result.tasks)) return null;
      const tasks = new Map<string, PlanStep>();
      for (const t of result.tasks) if (isObject(t) && typeof t.id === "string" && typeof t.subject === "string") tasks.set(t.id, { text: t.subject, status: statusOf(t.status) });
      return { kind: "reset", tasks };
    }
  }
}

export class ClaudePlans {
  /** The session's task list by task id. */
  private tasks = new Map<string, PlanStep>();
  /** The ids this list gave out. The CLI never gives one out twice, so a repeat is a new list: a fork's starts empty. */
  private given = new Set<string>();
  /** The task list's steps as last sent; null while there is no plan. */
  private shown: PlanStep[] | null = null;
  /** Task tool calls waiting for their result, by call id. */
  private calls = new Map<string, { tool: TaskTool; input: Obj }>();

  /** The plan event an event makes, if any. */
  observe(ev: NormalizedEvent): PlanEvent | null {
    if (ev.type === "tool_call") {
      if (ev.name === "TodoWrite") return todoPlan(ev.args, ev.parent);
      if (isTaskTool(ev.name)) this.calls.set(ev.callId, { tool: ev.name, input: isObject(ev.args) ? ev.args : {} });
      return null;
    }
    if (ev.type !== "tool_ended") return null;
    const call = this.calls.get(ev.callId);
    if (!call) return null;
    this.calls.delete(ev.callId);
    const change = changeOf(call.tool, call.input, ev);
    if (!change) return null;
    this.apply(change);
    return this.listPlan();
  }

  /**
   * History's events with the plan events they make. They go through in time
   * order, as live: history nests a background agent's steps at its card, ahead
   * of main-thread steps (and user messages) that came first. A chat's plan made
   * by a subagent's step lands after the last top-level event before it in time,
   * since a user message in between clears a finished plan. Every chat's plan
   * lands after the previous one, and a subagent's card after its previous
   * update, so the last one is the newest.
   */
  replay(events: NormalizedEvent[]): NormalizedEvent[] {
    let now = 0;
    const timed = events.map((ev, at) => {
      now = ev.ts ?? now;
      return { ev, at, ts: now };
    });
    const topLevel = timed.filter((t) => t.ev.parent === undefined);
    const after = new Map<number, NormalizedEvent[]>();
    let lastPlan = -1;
    const lastCard = new Map<string, number>();
    for (const { ev, at, ts } of [...timed].sort((a, b) => a.ts - b.ts)) {
      const plan = this.observe(ev);
      if (!plan) continue;
      let pos: number;
      if (plan.type === "subagent_plan") {
        pos = Math.max(at, lastCard.get(plan.key) ?? at);
        lastCard.set(plan.key, pos);
      } else {
        const inTime = ev.parent === undefined ? at : (topLevel.findLast((t) => t.ts <= ts)?.at ?? at);
        pos = Math.max(at, inTime, lastPlan);
        lastPlan = pos;
      }
      after.set(pos, [...(after.get(pos) ?? []), { ...plan, ...(ev.ts !== undefined ? { ts: ev.ts } : {}) }]);
    }
    return events.flatMap((ev, at) => [ev, ...(after.get(at) ?? [])]);
  }

  private apply(change: Change): void {
    switch (change.kind) {
      case "create":
        if (this.given.has(change.id)) {
          this.tasks.clear();
          this.given.clear();
        }
        this.given.add(change.id);
        this.tasks.set(change.id, { text: change.subject, status: "pending" });
        return;
      case "update": {
        const task = this.tasks.get(change.id);
        if (!task) return;
        if (change.status === "deleted") this.tasks.delete(change.id);
        else this.tasks.set(change.id, { text: change.subject ?? task.text, status: change.status ?? task.status });
        return;
      }
      case "reset":
        this.tasks = change.tasks;
        return;
    }
  }

  /** The task list's plan when its steps changed. An empty list makes no plan, though it clears one. */
  private listPlan(): PlanEvent | null {
    const steps = [...this.tasks].sort(([a], [b]) => Number(a) - Number(b)).map(([, step]) => step);
    if (this.shown ? sameSteps(this.shown, steps) : !steps.length) return null;
    this.shown = steps;
    return { type: "plan", steps };
  }
}

function sameSteps(a: PlanStep[], b: PlanStep[]): boolean {
  return a.length === b.length && a.every((s, i) => s.text === b[i]!.text && s.status === b[i]!.status);
}
