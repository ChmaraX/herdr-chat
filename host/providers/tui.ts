// Continue as chat: the session a running agent TUI has open, so a chat can
// take it over (mod new-chat continueAsChat, via `herdr-chat-host tui-session`).
// Each agent's module says how it finds it (providers/index.ts `tuiSession`).
import { execFileSync } from "node:child_process";

/**
 * session: the file a chat resumes; model ("provider/id") and thinking: the
 * TUI's, for a chat taking over in place; args: the agent's own arguments for
 * the same, for a sub-agent's new host (its command line is all it gets).
 */
export type TuiSession = { session: string; model?: string | null; thinking?: string | null; args?: string[] };
/** pid: the TUI's process (the terminal's foreground); cwd: its folder; label: the terminal's `herdr-chat.session` label, if any. */
export type TuiQuery = { pid: number; cwd: string; label: string | null };

/** How many processes a walk under a TUI's process looks at, at most. */
const PROCESS_LIMIT = 64;

/** The process and its descendants (an agent's launcher may run the real one as a child). */
export function processTree(pid: number): number[] {
  const out = [pid];
  for (let i = 0; i < out.length && out.length < PROCESS_LIMIT; i++) {
    try {
      for (const c of execFileSync("pgrep", ["-P", String(out[i])], { encoding: "utf8", timeout: 3000 }).split("\n")) if (Number(c) > 0) out.push(Number(c));
    } catch {} // pgrep exits 1 with no children
  }
  return out;
}

/** A program's name, for telling an agent's process: its path's last part, without a script's extension (`…/cli.js` → `cli`). */
export const programName = (p: string) => p.replace(/^.*\//, "").replace(/\.[mc]?[jt]s$/, "");

// Programs that run an agent as their script (`node …/pi`): their argv[1] names the agent.
const INTERPRETERS = new Set(["node", "bun", "deno"]);

/** A process from `ps`: argv[0] is its program (`comm`, a path with its spaces), argv[1] its first argument. */
export type Proc = { pid: number; ppid: number; pgid: number; tpgid: number; argv: [string, string] };

/** Whether the process runs the agent `name` (`pi`, `claude`, `codex`): its program, else an interpreter's script. */
export function runsAgent(p: Proc, name: string): boolean {
  const program = programName(p.argv[0]);
  return program === name || (INTERPRETERS.has(program) && programName(p.argv[1]) === name);
}

/**
 * The agent `name`'s process in a terminal, from the process table: its foreground program when that's the agent (a
 * shell's job), else the terminal's own program, else one under the foreground. That last is a terminal whose own
 * command started the agent (`fish -ic 'claude --resume …; exec fish -i'`): a shell without job control, so the
 * shell is the foreground and the agent runs below it, in the terminal's foreground process group. One in another
 * group is a background or stopped job, not the TUI on screen. An agent under another match (a launcher running the
 * real one) is that one. Two (`pi & pi`) is ambiguous: this throws rather than guess, since the caller signals the
 * pid. `label`: the agent's name for messages ("Pi").
 */
export function tuiProcess(table: Proc[], foreground: number, terminal: number | null, name: string, label: string): number {
  const proc = (pid: number | null) => table.find((p) => p.pid === pid);
  for (const pid of [foreground, terminal]) {
    const p = proc(pid);
    if (p && runsAgent(p, name)) return p.pid;
  }
  const top = proc(foreground);
  if (!top) throw new Error(`no ${label} process in the terminal (its foreground, ${foreground}, is gone)`);
  const group = top.tpgid > 0 ? top.tpgid : top.pgid;
  const kids = new Map<number, Proc[]>();
  for (const p of table) {
    if (p.pid === p.ppid) continue;
    const list = kids.get(p.ppid);
    if (list) list.push(p);
    else kids.set(p.ppid, [p]);
  }
  const found: number[] = [];
  const todo = [foreground];
  for (let seen = 0; todo.length && seen < PROCESS_LIMIT; seen++) {
    for (const c of kids.get(todo.shift()!) ?? []) {
      if (c.pgid === group && runsAgent(c, name)) found.push(c.pid);
      else todo.push(c.pid);
    }
  }
  if (found.length > 1) throw new Error(`${found.length} ${label} processes under the terminal's command (pids ${found.join(", ")}): not sure which is the TUI, so none is stopped`);
  if (!found.length) throw new Error(`no ${label} process in the terminal (its foreground is ${top.argv[0]}, and none runs under it)`);
  return found[0]!;
}

/** Every process (`ps -A`). `comm` and `args` take a run each: only the last column keeps its spaces. */
export function processTable(): Proc[] {
  // execFileSync throws on a non-zero exit, a timeout or output over maxBuffer: no half-read table.
  const ps = (cols: string) => execFileSync("ps", ["-A", "-ww", "-o", cols], { encoding: "utf8", timeout: 5000, maxBuffer: 16 * 1024 * 1024 });
  const comms = ps("pid=,ppid=,pgid=,tpgid=,comm=");
  const args = new Map<number, string>();
  for (const l of ps("pid=,args=").split("\n")) {
    const m = /^\s*(\d+) (.*)$/.exec(l);
    if (m) args.set(Number(m[1]), m[2]!);
  }
  const out: Proc[] = [];
  for (const l of comms.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+) (.*)$/.exec(l);
    if (!m) continue;
    const pid = Number(m[1]), comm = m[5]!.trim();
    // A program that set its title (`process.title = "pi"`) has it as both comm and args.
    const line = args.get(pid) ?? "";
    const rest = line.startsWith(comm) ? line.slice(comm.length) : line.replace(/^\S+/, "");
    out.push({ pid, ppid: Number(m[2]), pgid: Number(m[3]), tpgid: Number(m[4]), argv: [comm, rest.trim().split(/\s+/)[0] ?? ""] });
  }
  return out;
}

/** When the process started (ms), or null. */
export function processStart(pid: number): number | null {
  try {
    const s = Number(execFileSync("ps", ["-o", "etime=", "-p", String(pid)], { encoding: "utf8", timeout: 3000 }).trim().replace(/^(\d+)-/, (_m, d) => `${d * 24}:`).split(":").reduce((a, x) => a * 60 + Number(x), 0));
    return Number.isFinite(s) ? Date.now() - s * 1000 : null;
  } catch {
    return null;
  }
}

/** The files the processes have open (`lsof`), or []. */
export function openFiles(pids: number[]): string[] {
  try {
    return execFileSync("lsof", ["-p", pids.join(","), "-Fn"], { encoding: "utf8", timeout: 5000 }).split("\n").filter((l) => l.startsWith("n")).map((l) => l.slice(1));
  } catch (e) {
    const out = (e as { stdout?: string }).stdout;
    return typeof out === "string" ? out.split("\n").filter((l) => l.startsWith("n")).map((l) => l.slice(1)) : [];
  }
}
