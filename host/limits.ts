// The plan limits a chat's agent last reported (Claude Code's rate_limit_event), kept for other programs on this
// computer, such as a panel that shows them: `<state dir>/limits/<provider>.json`, in the shape Claude Code hands a
// status line, with the time they were seen:
//   {"at": <seconds>, "five_hour": {"used_percentage": 12.5, "resets_at": <seconds>}, "seven_day": {...}}
// Nothing else the agent says goes there. Written whole (a temp file renamed), 600 in a 700 folder. Every chat writes
// it; the last report wins.
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
    writeFileSync(tmp, JSON.stringify({ at: Math.floor(now / 1000), ...limits }) + "\n", { mode: 0o600 });
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}
