// Claude Code's todo tools → plan events, read from the normalized tool events
// that the live mapper and the history both emit.
// TodoWrite's input is the whole list of one agent. The task tools (TaskCreate,
// TaskUpdate, TaskList) edit one list per session, which subagents share (the
// CLI's task list id names no agent), and a task's id comes back only in
// TaskCreate's result: so that list is built from the results.
import type { NormalizedEvent, EventOf, PlanStep } from "../types.ts";

type Obj = Record<string, unknown>;
type Status = PlanStep["status"];
type TaskTool = "TaskCreate" | "TaskUpdate" | "TaskList";
type Plan = EventOf<"plan">;
/** What a task tool's result says it did to the list. */
type Change =
  | { kind: "create"; id: string; subject: string }
  | { kind: "update"; id: string; status?: Status | "deleted"; subject?: string }
  | { kind: "reset"; tasks: Map<string, PlanStep> };

const STATUSES: ReadonlySet<string> = new Set(["pending", "in_progress", "completed"]);
const TASK_TOOLS: ReadonlySet<string> = new Set(["TaskCreate", "TaskUpdate", "TaskList"]);

const isObject = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const isStatus = (v: unknown): v is Status => typeof v === "string" && STATUSES.has(v);
const isTaskTool = (v: string): v is TaskTool => TASK_TOOLS.has(v);
const statusOf = (v: unknown): Status => (isStatus(v) ? v : "pending");

function todoPlan(args: unknown, parent?: string): Plan | null {
  const todos = isObject(args) ? args.todos : undefined;
  if (!Array.isArray(todos)) return null;
  const steps = todos.filter(isObject).flatMap((t) => (typeof t.content === "string" ? [{ text: t.content, status: statusOf(t.status) }] : []));
  return { type: "plan", key: parent ? `todos:${parent}` : "todos", steps, ...(parent ? { parent } : {}) };
}

/** The change a task tool's result reports; null when it changed nothing. */
function changeOf(tool: TaskTool, input: Obj, ev: EventOf<"tool_ended">): Change | null {
  const result = isObject(ev.result) ? ev.result : null;
  if (ev.isError || !result) return null;
  switch (tool) {
    case "TaskCreate": {
      const task = isObject(result.task) ? result.task : null;
      return typeof task?.id === "string" && typeof task.subject === "string" ? { kind: "create", id: task.id, subject: task.subject } : null;
    }
    case "TaskUpdate": {
      // A task that isn't there answers success: false, not an error.
      if (result.success !== true) return null;
      const status = input.status === "deleted" || isStatus(input.status) ? input.status : undefined;
      return { kind: "update", id: String(input.taskId), ...(status ? { status } : {}), ...(typeof input.subject === "string" ? { subject: input.subject } : {}) };
    }
    case "TaskList": {
      if (!Array.isArray(result.tasks)) return null;
      const tasks = new Map<string, PlanStep>();
      for (const t of result.tasks) if (isObject(t) && typeof t.id === "string" && typeof t.subject === "string") tasks.set(t.id, { text: t.subject, status: statusOf(t.status) });
      return { kind: "reset", tasks };
    }
  }
}

export class ClaudePlans {
  /** The session's task list by task id, in the order the tasks were created. */
  private tasks = new Map<string, PlanStep>();
  /** Task tool calls waiting for their result, by call id. */
  private calls = new Map<string, { tool: TaskTool; input: Obj }>();

  /** The plan event an event makes, if any. */
  observe(ev: NormalizedEvent): Plan | null {
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
    return change && this.apply(change) ? { type: "plan", key: "tasks", steps: [...this.tasks.values()] } : null;
  }

  /** History's events, each followed by the plan event it makes, at its time. */
  replay(events: NormalizedEvent[]): NormalizedEvent[] {
    return events.flatMap((ev) => {
      const plan = this.observe(ev);
      return plan ? [ev, { ...plan, ...(ev.ts !== undefined ? { ts: ev.ts } : {}) }] : [ev];
    });
  }

  private apply(change: Change): boolean {
    switch (change.kind) {
      case "create":
        this.tasks.set(change.id, { text: change.subject, status: "pending" });
        return true;
      case "update": {
        const task = this.tasks.get(change.id);
        if (!task) return false;
        if (change.status === "deleted") return this.tasks.delete(change.id);
        this.tasks.set(change.id, { text: change.subject ?? task.text, status: change.status ?? task.status });
        return true;
      }
      case "reset":
        this.tasks = change.tasks;
        return true;
    }
  }
}
