// Claude Code's todo tools → plan events, for the live mapper and the history alike.
// TodoWrite's input is the whole list of one agent. The task tools (TaskCreate,
// TaskUpdate, TaskList) edit one list per session, which subagents share (the
// CLI's task list id names no agent), and a task's id comes back only in
// TaskCreate's result: so that list is built from the results.
import type { NormalizedEvent, EventOf, PlanStep } from "../types.ts";

type Rec = Record<string, any>;
type Status = PlanStep["status"];
type TaskTool = "TaskCreate" | "TaskUpdate" | "TaskList";

const TASK_TOOLS = new Set<string>(["TaskCreate", "TaskUpdate", "TaskList"]);
const STATUSES = new Set<string>(["pending", "in_progress", "completed"]);

function record(v: unknown): Rec | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : null;
}

function todoPlan(input: unknown, parent?: string): NormalizedEvent | null {
  const todos = record(input)?.todos;
  if (!Array.isArray(todos)) return null;
  const steps: PlanStep[] = todos
    .filter((t: Rec) => t && typeof t.content === "string")
    .map((t: Rec) => ({ text: t.content, status: STATUSES.has(t.status) ? t.status : "pending" }));
  return { type: "plan", key: parent ? `todos:${parent}` : "todos", steps, ...(parent ? { parent } : {}) };
}

export class ClaudePlans {
  /** The session's tasks by id, in the order they were created. */
  private tasks = new Map<string, { subject: string; status: Status }>();
  /** Task tool calls waiting for their result, by call id. */
  private calls = new Map<string, { name: TaskTool; input: Rec }>();

  /** A tool call. TodoWrite's plan comes now; a task tool's waits for its result. */
  call(callId: string, name: string, input: unknown, parent?: string): NormalizedEvent | null {
    if (name === "TodoWrite") return todoPlan(input, parent);
    if (TASK_TOOLS.has(name)) this.calls.set(callId, { name: name as TaskTool, input: record(input) ?? {} });
    return null;
  }

  /** A tool result: the task list's plan, when the result changed it. */
  ended(ev: EventOf<"tool_ended">): NormalizedEvent | null {
    const call = this.calls.get(ev.callId);
    if (!call) return null;
    this.calls.delete(ev.callId);
    const result = record(ev.result);
    if (ev.isError || !result || !this.apply(call.name, call.input, result)) return null;
    return { type: "plan", key: "tasks", steps: [...this.tasks.values()].map((t) => ({ text: t.subject, status: t.status })) };
  }

  private apply(name: TaskTool, input: Rec, result: Rec): boolean {
    switch (name) {
      case "TaskCreate": {
        const task = record(result.task);
        if (typeof task?.id !== "string" || typeof task.subject !== "string") return false;
        this.tasks.set(task.id, { subject: task.subject, status: "pending" });
        return true;
      }
      case "TaskUpdate": {
        const id = String(input.taskId);
        const task = this.tasks.get(id);
        // A task that isn't there answers success: false, not an error.
        if (result.success !== true || !task) return false;
        if (input.status === "deleted") return this.tasks.delete(id);
        if (STATUSES.has(input.status)) task.status = input.status;
        if (typeof input.subject === "string") task.subject = input.subject;
        return true;
      }
      case "TaskList": {
        if (!Array.isArray(result.tasks)) return false;
        this.tasks = new Map(
          result.tasks
            .filter((t: Rec) => typeof t?.id === "string" && typeof t.subject === "string")
            .map((t: Rec) => [t.id, { subject: t.subject, status: STATUSES.has(t.status) ? t.status : "pending" }]),
        );
        return true;
      }
    }
  }
}
