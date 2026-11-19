// The plan limits a chat's agent last reported (Claude Code's rate_limit_event), kept for other programs on this
// computer, such as a panel that shows them: `<state dir>/limits/<provider>.json`, in the shape Claude Code hands a
// status line, with the time they were seen:
//   {"at": <seconds>, "five_hour": {"used_percentage": 12.5, "resets_at": <seconds>}, "seven_day": {...}}
// Nothing else the agent says goes there. Written whole (a temp file renamed), 600 in a 700 folder. Every chat writes
// it. A report can name one window alone (Claude Code tracks them apart): the other keeps the last number seen for it.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PlanLimits } from "./providers/types.ts";

export function limitsFile(stateDir: string, provider: string): string {
  return join(stateDir, "limits", `${provider}.json`);
}

export function saveLimits(stateDir: string, provider: string, limits: PlanLimits, now = Date.now()): void {
  const dir = join(stateDir, "limits");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = limitsFile(stateDir, provider), tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ at: Math.floor(now / 1000), ...lastSaved(file), ...limits }) + "\n", { mode: 0o600 });
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** The windows saved before, those of a shape this file gives; none from a missing or odd file. */
function lastSaved(file: string): PlanLimits {
  let saved: any;
  try {
    saved = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
  const out: PlanLimits = {};
  for (const key of ["five_hour", "seven_day"] as const) {
    const w = saved?.[key];
    if (w && typeof w.used_percentage === "number" && (w.resets_at === null || typeof w.resets_at === "number"))
      out[key] = { used_percentage: w.used_percentage, resets_at: w.resets_at };
  }
  return out;
}
