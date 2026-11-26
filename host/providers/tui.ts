// Continue as chat: the session a running agent TUI has open, so a chat can
// take it over (mod new-chat continueAsChat, via `herdr-chat-host tui-session`).
// Each agent's module says how it finds it (providers/index.ts `tuiSession`).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { IS_WIN } from "../platform.ts";
import type { Proc } from "../process.ts";

export type { Proc };

/**
 * session: the file a chat resumes; model ("provider/id") and thinking: the
 * TUI's, for a chat taking over in place; args: the agent's own arguments for
 * the same, for a sub-agent's new host (its command line is all it gets).
 */
export type TuiSession = { session: string; model?: string | null; thinking?: string | null; args?: string[] };
/** pid: the TUI's process (the terminal's foreground); cwd: its folder; label: the terminal's `herdr-chat.session` label, if any. */
export type TuiQuery = { pid: number; cwd: string; label: string | null };

/** A program's name, for telling an agent's process: its path's last part, without a script's extension (`…/cli.js` → `cli`). */
// Windows: paths with backslashes and programs with .exe (`C:\…\claude.exe` → claude).
export const programName = (p: string) => p.replace(/^.*[\\/]/, "").replace(/\.([mc]?[jt]s|exe|cmd)$/i, "");
const basename = (p: string | undefined) => (p ?? "").replace(/^.*[\\/]/, "").replace(/\.(exe|cmd)$/i, "");

/** A process as Herdr reports it (`hc get --json`: the terminal's own program, its foreground). */
export type Launched = { pid: number; argv: string[] };
/** A terminal, from Herdr: its foreground program, and its own (the command it was started with), when known. */
export type TerminalView = { foreground: Launched; own: Launched | null };

const isPid = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n > 0;
function launched(v: unknown): Launched | null {
  const o = v as { pid?: unknown; argv?: unknown } | null;
  if (!o || !isPid(o.pid)) return null;
  return { pid: o.pid, argv: Array.isArray(o.argv) ? o.argv.filter((x): x is string => typeof x === "string") : [] };
}

/** The terminal from its `hc get --json` (pid, argv, foreground {pid, argv}); its own program stands in for a missing foreground. Throws on neither. */
export function terminalView(hcGet: unknown): TerminalView {
  const own = launched(hcGet);
  const foreground = launched((hcGet as { foreground?: unknown } | null)?.foreground) ?? own;
  if (!foreground) throw new Error("the terminal reports no process (no pid > 0 for it or its foreground)");
  return { foreground, own };
}

// Programs that run an agent as their script (`node …/pi`): their argv[1] names the agent. Not deno, nor
// `bun run`: their argv[1] is a subcommand.
const INTERPRETERS = new Set(["node", "bun"]);

/** Whether a process under the terminal's command runs the agent `command` (`pi`): its program, else an interpreter's script. */
export function runsAgent(p: Proc, command: string): boolean {
  const program = programName(p.program);
  return program === command || (INTERPRETERS.has(program) && scriptRuns(p.script, command));
}

/**
 * Whether an interpreter's script is the agent `command`: its name (`…/bin/pi`, a symlink npm made), or,
 * on Windows, where npm's pi.cmd runs node on the package's own file (`…\node_modules\…\cli.js`), the
 * package whose package.json names `command` among its bins.
 */
function scriptRuns(script: string, command: string): boolean {
  if (programName(script) === command) return true;
  return IS_WIN && Boolean(script) && npmBins(script).includes(command);
}

const binsOf = new Map<string, string[]>();
/** The bins (`"bin"` names) of the npm package a script belongs to: the nearest package.json above it, up to 4 folders. */
function npmBins(script: string): string[] {
  let dir = dirname(script);
  for (let i = 0; i < 4; i++, dir = dirname(dir)) {
    const cached = binsOf.get(dir);
    if (cached) return cached;
    const f = join(dir, "package.json");
    if (!existsSync(f)) continue;
    let bins: string[] = [];
    try {
      const pkg = JSON.parse(readFileSync(f, "utf8"));
      bins = typeof pkg.bin === "string" ? [String(pkg.name ?? "").replace(/^.*\//, "")] : Object.keys(pkg.bin ?? {});
    } catch {}
    binsOf.set(dir, bins);
    return bins;
  }
  return [];
}

/**
 * The TUI's process group, when the TUI was found under the terminal's command, as it was before the agent got
 * SIGTERM: id, the terminal's foreground group; shell, the terminal's command (the foreground); before, the other
 * processes in the group then, besides the agent and what runs under it. tuiBusy reads it once the agent is gone.
 */
export type TuiGroup = { id: number; shell: number; before: number[] };
/** The TUI's process; group: null when the TUI is the terminal's foreground or own program (Herdr's foreground says when it's gone). */
export type TuiFound = { pid: number; group: TuiGroup | null };

/**
 * The agent `command`'s process in a terminal: its foreground program when that's the agent (a shell's job), else
 * the terminal's own program, by Herdr's argv: argv[0] or argv[1] names it, whatever the program. Else one under the
 * foreground, from the process table: a terminal whose own command started the agent (`fish -ic 'claude --resume …;
 * exec fish -i'`). That's a shell without job control, so the shell is the foreground and the agent runs below it,
 * in the terminal's foreground process group. One in another group is a background or stopped job, not the TUI on
 * screen. An agent under another match (a launcher running the real one) is that one. Two (`pi & pi`) is ambiguous:
 * this throws rather than guess, since the caller signals the pid. `label`: the agent's name for messages ("Pi").
 * `processes`: the process table, read only when Herdr's argv doesn't tell.
 */
export function tuiProcess(o: { terminal: TerminalView; command: string; label: string; processes: () => Proc[] }): TuiFound {
  const { terminal, command, label } = o;
  for (const p of [terminal.foreground, terminal.own]) {
    if (p && (basename(p.argv[0]) === command || basename(p.argv[1]) === command)) return { pid: p.pid, group: null };
    // Windows: npm's agents run as `node …\node_modules\<package>\cli.js` (see scriptRuns).
    if (p && IS_WIN && INTERPRETERS.has(programName(p.argv[0] ?? "")) && p.argv[1] && scriptRuns(p.argv[1], command)) return { pid: p.pid, group: null };
  }
  const table = o.processes();
  const top = table.find((p) => p.pid === terminal.foreground.pid);
  if (!top) throw new Error(`no ${label} process in the terminal (its foreground, ${terminal.foreground.pid}, is gone)`);
  const group = top.tpgid > 0 ? top.tpgid : top.pgid;
  const kids = childrenMap(table);
  const found: Proc[] = [];
  // The whole tree under the foreground (the table is in memory): a cap could hide a second agent.
  walk(kids, top.pid, (c) => {
    if (c.pgid !== group || !runsAgent(c, command)) return true;
    found.push(c);
    return false;
  });
  if (found.length > 1) throw new Error(`${found.length} ${label} processes under the terminal's command (pids ${found.map((p) => p.pid).join(", ")}): not sure which is the TUI, so none is stopped`);
  const [agent] = found;
  if (!agent) throw new Error(`no ${label} process in the terminal (its foreground is ${terminal.foreground.argv[0] ?? top.program}, and none runs under it)`);
  const tree = new Set([agent.pid]);
  walk(kids, agent.pid, (c) => (tree.add(c.pid), true));
  const before = table.filter((p) => p.pgid === group && p.pid !== top.pid && !tree.has(p.pid)).map((p) => p.pid);
  // Windows has no process groups (its process table gives every process group 0): no group to watch. The mod then
  // asks Herdr's foreground whether the terminal is idle again, as for a TUI that is the foreground.
  if (IS_WIN) return { pid: agent.pid, group: null };
  return { pid: agent.pid, group: { id: group, shell: top.pid, before } };
}

/**
 * Once the agent is gone, what the shell that ran it still runs, or null when it's idle: a process in its group
 * that was there before (`pi & other`), or a new child of the shell (the command goes on: `pi; sleep 5`). Not one
 * the agent left (an MCP server outliving it: no longer the shell's child) nor a helper the interactive shell
 * starts after `exec fish -i` (with job control, in a group of its own). Limit: a helper an rc file starts in the
 * shell's own group (`setopt no_monitor; … &`) counts as busy, so the pane stays and says so.
 */
export function tuiBusy(table: Proc[], group: TuiGroup): Proc | null {
  const before = new Set(group.before);
  return table.find((p) => p.pgid === group.id && p.pid !== group.shell && (before.has(p.pid) || p.ppid === group.shell)) ?? null;
}

/** The TuiGroup the CLI is given back (`tui-busy --group <json>`), checked, or null. */
export function parseTuiGroup(json: string): TuiGroup | null {
  let g: { id?: unknown; shell?: unknown; before?: unknown };
  try {
    g = JSON.parse(json);
  } catch {
    return null;
  }
  if (!g || !isPid(g.id) || !isPid(g.shell) || !Array.isArray(g.before) || !g.before.every(isPid)) return null;
  return { id: g.id, shell: g.shell, before: g.before };
}

function childrenMap(table: Proc[]): Map<number, Proc[]> {
  const kids = new Map<number, Proc[]>();
  for (const p of table) {
    if (p.pid === p.ppid) continue;
    const list = kids.get(p.ppid);
    if (list) list.push(p);
    else kids.set(p.ppid, [p]);
  }
  return kids;
}

/** Visits every process under `root`, breadth first; `visit` returns whether to go below it. */
function walk(kids: Map<number, Proc[]>, root: number, visit: (p: Proc) => boolean): void {
  const seen = new Set([root]);
  const todo = [root];
  for (let pid = todo.shift(); pid !== undefined; pid = todo.shift()) {
    for (const c of kids.get(pid) ?? []) {
      if (seen.has(c.pid)) continue;
      seen.add(c.pid);
      if (visit(c)) todo.push(c.pid);
    }
  }
}
