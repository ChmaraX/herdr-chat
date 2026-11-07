// A Codex TUI's session: the rollout file it has open (`codex --no-daemon`),
// else the newest rollout in its folder written since it started (a TUI on the
// shared daemon leaves the file to the daemon). The model and effort are the
// last turn's (`turn_context`).
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { openFiles, processStart, processTree, type TuiQuery, type TuiSession } from "../tui.ts";

const home = () => process.env.CODEX_HOME || join(homedir(), ".codex");
const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** Rollout files under sessions/YYYY/MM/DD, newest days first, as far back as `since`. */
function rollouts(since: number): string[] {
  const root = join(home(), "sessions");
  const out: string[] = [];
  const dirs = (p: string) => {
    try {
      return readdirSync(p).filter((n) => /^\d+$/.test(n)).sort().reverse();
    } catch {
      return [];
    }
  };
  const oldest = new Date(since - 86_400_000);
  for (const y of dirs(root)) for (const m of dirs(join(root, y))) for (const d of dirs(join(root, y, m))) {
    if (new Date(`${y}-${m}-${d}T23:59:59`) < oldest) return out;
    for (const f of readdirSync(join(root, y, m, d))) if (/^rollout-.*\.jsonl$/.test(f)) out.push(join(root, y, m, d, f));
  }
  return out;
}

function meta(file: string): { cwd: string | null; model: string | null; effort: string | null } {
  let cwd: string | null = null, model: string | null = null, effort: string | null = null;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.includes('"session_meta"') && !line.includes('"turn_context"')) continue;
    try {
      const e = JSON.parse(line);
      if (e.type === "session_meta" && typeof e.payload?.cwd === "string") cwd ??= e.payload.cwd;
      if (e.type === "turn_context") {
        if (typeof e.payload?.model === "string") model = e.payload.model;
        if (typeof e.payload?.effort === "string") effort = e.payload.effort;
      }
    } catch {}
  }
  return { cwd, model, effort };
}

export function codexTuiSession(q: TuiQuery): TuiSession {
  let file = openFiles(processTree(q.pid)).find((f) => /\/rollout-[^/]*\.jsonl$/.test(f)) ?? null;
  if (!file) {
    const since = (processStart(q.pid) ?? Date.now() - 86_400_000) - 5000;
    const cwd = real(q.cwd);
    let best: { f: string; t: number } | null = null;
    for (const f of rollouts(since)) {
      const t = statSync(f).mtimeMs;
      if (t < since || (best && t <= best.t)) continue;
      const m = meta(f);
      if (m.cwd && real(m.cwd) === cwd) best = { f, t };
    }
    file = best?.f ?? null;
  }
  if (!file) throw new Error("no Codex session in this folder since it started: send it a message first");
  const m = meta(file);
  return {
    session: file, model: m.model ? `openai/${m.model}` : null, thinking: m.effort,
    args: [...(m.model ? ["-c", `model=${JSON.stringify(m.model)}`] : []), ...(m.effort ? ["-c", `model_reasoning_effort=${JSON.stringify(m.effort)}`] : [])],
  };
}
