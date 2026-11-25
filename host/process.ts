// Processes, as the host reads, starts and stops them: ps, pgrep and lsof with process groups on macOS
// and Linux; Win32_Process through PowerShell, taskkill and resolved commands on Windows (winproc.ts).
// One backend, chosen once by platform.ts IS_WIN: callers never ask which OS it is.
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import type { ChildProcess, ExecFileOptions, ExecFileSyncOptions, SpawnOptions } from "node:child_process";
import { IS_WIN } from "./platform.ts";
import { splitCommandLine, winKillTree, winProcesses, winProcessesAsync, winResolveCommand, type WinProc } from "./winproc.ts";

/**
 * A process from the table (processTable). program: the program's path (`ps` comm; Windows: its executable);
 * script: the first argument after it, for an interpreter's script. `ps` has no argv, only one line of it, so a
 * script path with a space is cut there. Windows has no process groups: pgid and tpgid are 0.
 */
export type Proc = { pid: number; ppid: number; pgid: number; tpgid: number; program: string; script: string };
/** A process's command line, as arguments (`ps` splits at spaces; Windows as its C runtime does). */
export type CmdLine = { pid: number; args: string[] };

/** How many processes `processTree` collects, at most. */
const PROCESS_LIMIT = 64;

type Backend = {
  resolve(command: string, args: string[]): { command: string; args: string[] };
  /** Whether a child gets a process group of its own (detached), for groupAlive and killGroup. */
  ownGroup: boolean;
  groupAlive(pid: number): boolean;
  killGroup(pid: number, sig: NodeJS.Signals): void;
  tree(pid: number): number[];
  table(): Proc[];
  start(pid: number): number | null;
  stamp(pid: number): string | "gone" | null;
  commandLine(pid: number): string[] | null;
  commandLines(): Promise<CmdLine[]>;
  openFiles(pids: number[]): string[];
  /** An argv that runs `command args` with `env` set (the hand-off's TUI): `env K=V …` where there's an env program. */
  withEnv(env: Record<string, string>, command: string, args: string[]): string[];
};

const posix: Backend = {
  resolve: (command, args) => ({ command, args }),
  ownGroup: true,
  groupAlive(pid) {
    try {
      process.kill(-pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  killGroup(pid, sig) {
    try {
      process.kill(-pid, sig);
    } catch {}
  },
  tree(pid) {
    const out = [pid];
    for (let i = 0; i < out.length && out.length < PROCESS_LIMIT; i++) {
      try {
        for (const c of execFileSync("pgrep", ["-P", String(out[i])], { encoding: "utf8", timeout: 3000 }).split("\n")) if (Number(c) > 0) out.push(Number(c));
      } catch {} // pgrep exits 1 with no children
    }
    return out;
  },
  // Two runs of `ps -A`, joined by pid: only the last column keeps its spaces, so `comm` (the program) and `args`
  // (its line, for the script) need one each. A process that starts between them has no script.
  table() {
    const ps = (cols: string) => {
      try {
        return execFileSync("ps", ["-A", "-ww", "-o", cols], { encoding: "utf8", timeout: 5000, maxBuffer: 16 * 1024 * 1024 });
      } catch (e) {
        throw new Error(`can't read the process table (ps -o ${cols}): ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
      }
    };
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
      const pid = Number(m[1]), program = m[5]!.trim();
      // A program that set its title (`process.title = "pi"`) has it as both comm and args.
      const line = args.get(pid) ?? "";
      const rest = line.startsWith(program) ? line.slice(program.length) : line.replace(/^\S+/, "");
      out.push({ pid, ppid: Number(m[2]), pgid: Number(m[3]), tpgid: Number(m[4]), program, script: rest.trim().split(/\s+/)[0] ?? "" });
    }
    return out;
  },
  start(pid) {
    try {
      const s = Number(execFileSync("ps", ["-o", "etime=", "-p", String(pid)], { encoding: "utf8", timeout: 3000 }).trim().replace(/^(\d+)-/, (_m, d) => `${d * 24}:`).split(":").reduce((a, x) => a * 60 + Number(x), 0));
      return Number.isFinite(s) ? Date.now() - s * 1000 : null;
    } catch {
      return null;
    }
  },
  // `ps -o lstart` in UTC, so every caller prints the same (to the second).
  stamp(pid) {
    const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 5000, env: { ...process.env, LC_ALL: "C", TZ: "UTC" } });
    if (r.error || r.status === null) return null;
    const out = r.stdout.trim();
    return out || (r.status !== 0 ? "gone" : null);
  },
  commandLine(pid) {
    const r = spawnSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8", timeout: 5000 });
    return r.status === 0 ? r.stdout.trim().split(/\s+/).filter(Boolean) : null;
  },
  commandLines() {
    return new Promise((resolve, reject) => {
      execFile("ps", ["-Ao", "pid=,args="], { timeout: 5000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
        if (err) return reject(err);
        const out: CmdLine[] = [];
        for (const line of String(stdout).split("\n")) {
          const m = /^\s*(\d+)\s+(.*)$/.exec(line);
          if (m) out.push({ pid: Number(m[1]), args: m[2]!.split(/\s+/) });
        }
        resolve(out);
      });
    });
  },
  openFiles(pids) {
    const names = (out: string) => out.split("\n").filter((l) => l.startsWith("n")).map((l) => l.slice(1));
    try {
      return names(execFileSync("lsof", ["-p", pids.join(","), "-Fn"], { encoding: "utf8", timeout: 5000 }));
    } catch (e) {
      const out = (e as { stdout?: string }).stdout;
      return typeof out === "string" ? names(out) : [];
    }
  },
  withEnv(env, command, args) {
    const kv = Object.entries(env).map(([k, v]) => `${k}=${v}`);
    return [...(kv.length ? ["env", ...kv] : []), command, ...args];
  },
};

// Windows has no env program: node sets the variables and runs the command in the same console (unwrapEnv reads it back).
const ENV_SCRIPT = "const a = process.argv.slice(1); const env = { ...process.env }; let i = 0;"
  + " for (; i < a.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(a[i]); i++) { const j = a[i].indexOf('='); env[a[i].slice(0, j)] = a[i].slice(j + 1); }"
  + " require('child_process').spawn(a[i], a.slice(i + 1), { stdio: 'inherit', env }).on('exit', (c) => process.exit(c ?? 1));";

const win: Backend = {
  resolve: winResolveCommand,
  // No process groups: a child is its own tree, ended with taskkill /T (a signal there ends only the one process).
  ownGroup: false,
  groupAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  killGroup: (pid) => winKillTree(pid),
  tree(pid) {
    let procs: WinProc[] = [];
    try {
      procs = winProcesses();
    } catch {}
    const out = [pid];
    for (let i = 0; i < out.length && out.length < PROCESS_LIMIT; i++) for (const p of procs) if (p.ppid === out[i] && p.pid !== p.ppid && !out.includes(p.pid)) out.push(p.pid);
    return out;
  },
  // No terminal foreground group: every process gets group 0. program: the executable's path (its name when
  // Windows hides the path); script: argv[1].
  table() {
    let procs: WinProc[];
    try {
      procs = winProcesses();
    } catch (e) {
      throw new Error(`can't read the process table (Win32_Process): ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
    }
    return procs.map((p) => ({ pid: p.pid, ppid: p.ppid, pgid: 0, tpgid: 0, program: p.path || p.name, script: splitCommandLine(p.cmdline)[1] ?? "" }));
  },
  start(pid) {
    try {
      return winProcesses(pid)[0]?.start ?? null;
    } catch {
      return null;
    }
  },
  // The creation time Win32_Process keeps (ms since the epoch, UTC).
  stamp(pid) {
    try {
      const [p] = winProcesses(pid);
      return p ? (p.start === null ? null : `win:${p.start}`) : "gone";
    } catch {
      return null;
    }
  },
  commandLine(pid) {
    try {
      const [p] = winProcesses(pid);
      return p ? splitCommandLine(p.cmdline) : null;
    } catch {
      return null;
    }
  },
  commandLines: () => winProcessesAsync().then((procs) => procs.map((p) => ({ pid: p.pid, args: splitCommandLine(p.cmdline) }))),
  openFiles: () => [], // no lsof: the callers fall back (Codex: the folder's newest session)
  withEnv(env, command, args) {
    const kv = Object.entries(env).map(([k, v]) => `${k}=${v}`);
    return kv.length ? [process.execPath, "-e", ENV_SCRIPT, ...kv, command, ...args] : [command, ...args];
  },
};

const os = IS_WIN ? win : posix;

/** A command as this OS starts it without a shell (Windows: npm's .cmd shims and scripts through node). Throws for a .cmd it can't run. */
export const resolveCommand = (command: string, args: string[]) => os.resolve(command, args);
/** spawn, with the command resolved. `ownGroup: true` gives it a process group of its own where there are any. */
export function spawnResolved(command: string, args: string[], opts: SpawnOptions & { ownGroup?: boolean } = {}): ChildProcess {
  const { ownGroup, ...rest } = opts;
  const run = os.resolve(command, args);
  return spawn(run.command, run.args, { ...rest, ...(ownGroup ? { detached: os.ownGroup } : {}) });
}
/** execFile, with the command resolved. */
export function execFileResolved(command: string, args: string[], opts: ExecFileOptions, cb: (err: Error | null, stdout: string, stderr: string) => void): void {
  const run = os.resolve(command, args);
  execFile(run.command, run.args, { ...opts, encoding: "utf8" }, (err, stdout, stderr) => cb(err, String(stdout), String(stderr)));
}
/** execFileSync, with the command resolved. */
export function execFileSyncResolved(command: string, args: string[], opts: ExecFileSyncOptions): void {
  const run = os.resolve(command, args);
  execFileSync(run.command, run.args, opts);
}
/** Whether the group of a child spawned with ownGroup (its pid) still runs anything. */
export const groupAlive = (pid: number) => os.groupAlive(pid);
/** Signals that group (Windows: ends the child's tree). */
export const killGroup = (pid: number, sig: NodeJS.Signals) => os.killGroup(pid, sig);
/** The process and its descendants (an agent's launcher may run the real one as a child). */
export const processTree = (pid: number) => os.tree(pid);
/** Every process. Throws when the table can't be read, times out or is too big: never a half-read table. */
export const processTable = () => os.table();
/** When the process started (ms), or null. */
export const processStart = (pid: number) => os.start(pid);
/** Who `pid` is: its start time, which a reused pid doesn't share. "gone": no such process; null: couldn't say. */
export const startStamp = (pid: number) => os.stamp(pid);
/** The process's command line, or null when it can't be read (or it's gone). */
export const commandLine = (pid: number) => os.commandLine(pid);
/** Every process's command line. Rejects when they can't be read. */
export const commandLines = () => os.commandLines();
/** The files the processes have open, or [] (always on Windows). */
export const openFiles = (pids: number[]) => os.openFiles(pids);
/** An argv that runs `command args` with `env` set (unwrapEnv reads it back). */
export const withEnv = (env: Record<string, string>, command: string, args: string[]) => os.withEnv(env, command, args);

/** What a withEnv argv sets and runs: its env and the rest (the plain argv, when it set none). */
export function unwrapEnv(argv: string[]): { env: Record<string, string>; argv: string[] } {
  let i = 0;
  if (argv[0] === "env") i = 1;
  else if (argv[1] === "-e" && argv[2] === ENV_SCRIPT) i = 3;
  const env: Record<string, string> = {};
  if (i) for (; i < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i]!); i++) {
    const j = argv[i]!.indexOf("=");
    env[argv[i]!.slice(0, j)] = argv[i]!.slice(j + 1);
  }
  return { env, argv: argv.slice(i) };
}
