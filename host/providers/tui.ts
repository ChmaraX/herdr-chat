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

/** The process and its descendants (an agent's launcher may run the real one as a child). */
export function processTree(pid: number): number[] {
  const out = [pid];
  for (let i = 0; i < out.length && out.length < 64; i++) {
    try {
      for (const c of execFileSync("pgrep", ["-P", String(out[i])], { encoding: "utf8", timeout: 3000 }).split("\n")) if (Number(c) > 0) out.push(Number(c));
    } catch {} // pgrep exits 1 with no children
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
