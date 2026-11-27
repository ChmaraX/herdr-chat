// Claude Code's background work → the chat's list of it (state.background,
// protocol v3.12). No I/O: the adapter feeds it system records and emits the
// list when it changes.
//
// `background_tasks_changed` lists every task still running in the background
// (a Bash with run_in_background, a Monitor, a background subagent), whole,
// each time one starts or ends; a foreground Bash that turned into a task is
// never in it. It comes just before that task's `task_started`, which is the
// only record naming the tool call, so a Monitor (task_type local_bash, as a
// Bash) gets its name a moment after it shows.
import type { BackgroundTask } from "../types.ts";

type Rec = Record<string, any>;

/** By task_type, when the tool that started the task isn't known. */
const KIND_BY_TYPE: Readonly<Record<string, string>> = {
  local_bash: "Bash",
  local_agent: "Agent",
  remote_agent: "Remote agent",
  local_workflow: "Workflow",
};
const AGENT_TOOLS = new Set(["Agent", "Task"]);

const str = (x: unknown): string => (typeof x === "string" ? x.trim() : "");

export class ClaudeBackground {
  private list: readonly BackgroundTask[] = [];
  /** The records of the last list, to rename a task once task_started names its tool. */
  private raw: Rec[] = [];
  /** Task id → the tool that started it (task_started), kept until the task leaves the list. */
  private tools = new Map<string, string>();
  /** Task id → when it was first listed. */
  private seen = new Map<string, number>();
  /** The tool a call id belongs to (the mapper's toolNames). */
  private readonly toolName: (callId: string) => string | undefined;
  private readonly now: () => number;

  constructor(toolName: (callId: string) => string | undefined, now: () => number = Date.now) {
    this.toolName = toolName;
    this.now = now;
  }

  get tasks(): BackgroundTask[] {
    return [...this.list];
  }

  /** A system record; the whole new list when it changed what the chat shows, else null. */
  onSystem(rec: Rec): BackgroundTask[] | null {
    if (rec.subtype === "background_tasks_changed") {
      if (!Array.isArray(rec.tasks)) return null;
      return this.replace(rec.tasks.filter((t: unknown): t is Rec => !!t && typeof t === "object" && str((t as Rec).task_id) !== ""));
    }
    if (rec.subtype === "task_started") {
      const id = str(rec.task_id);
      const name = this.toolName(str(rec.tool_use_id));
      if (!id || !name || this.tools.get(id) === name) return null;
      this.tools.set(id, name);
      return this.list.some((t) => t.id === id) ? this.replace(this.raw) : null;
    }
    return null;
  }

  /** The agent's process is gone, and its tasks with it: [] when the chat showed some, else null. */
  reset(): BackgroundTask[] | null {
    const had = this.list.length > 0;
    this.list = [];
    this.raw = [];
    this.tools.clear();
    this.seen.clear();
    return had ? [] : null;
  }

  private replace(records: Rec[]): BackgroundTask[] | null {
    this.raw = records;
    const ids = new Set(records.map((t) => str(t.task_id)));
    for (const id of [...this.seen.keys()]) if (!ids.has(id)) this.seen.delete(id);
    for (const id of [...this.tools.keys()]) if (!ids.has(id)) this.tools.delete(id);
    const next = records.map((t) => this.task(t));
    if (sameTasks(next, this.list)) return null;
    this.list = next;
    return this.tasks;
  }

  private task(t: Rec): BackgroundTask {
    const id = str(t.task_id);
    const startedAt = this.seen.get(id) ?? this.now();
    this.seen.set(id, startedAt);
    const kind = this.kind(id, t);
    return { id, kind, label: str(t.description) || kind, startedAt };
  }

  private kind(id: string, t: Rec): string {
    const tool = this.tools.get(id);
    const type = str(t.task_type);
    if (type === "local_agent" || (tool && AGENT_TOOLS.has(tool))) {
      const agent = str(t.subagent_type);
      return agent ? `${agent} agent` : "Agent";
    }
    return tool || KIND_BY_TYPE[type] || type || "Task";
  }
}

function sameTasks(a: readonly BackgroundTask[], b: readonly BackgroundTask[]): boolean {
  return a.length === b.length && a.every((t, i) => {
    const o = b[i]!;
    return t.id === o.id && t.kind === o.kind && t.label === o.label && t.startedAt === o.startedAt;
  });
}
