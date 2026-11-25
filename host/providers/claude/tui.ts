// A Claude Code TUI's session: Claude Code registers each live process in
// <config>/sessions/<pid>.json ({pid, sessionId, cwd}); the transcript is
// written once the session has a message.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { codeModeSession, configDir, sessionPath } from "./sessions.ts";
import { processTree, type TuiQuery, type TuiSession } from "../tui.ts";

export function claudeTuiSession(q: TuiQuery): TuiSession {
  for (const pid of processTree(q.pid)) {
    let r: Record<string, any>;
    try {
      r = JSON.parse(readFileSync(join(configDir(), "sessions", `${pid}.json`), "utf8"));
    } catch {
      continue;
    }
    if (typeof r?.sessionId !== "string") continue;
    const file = sessionPath(typeof r.cwd === "string" ? r.cwd : q.cwd, r.sessionId);
    if (!existsSync(file)) throw new Error("this Claude Code session has no messages yet: nothing to continue");
    // Before the TUI is stopped: the chat's `claude -p --resume` would be refused.
    if (codeModeSession(file)) throw new Error("this Claude Code session runs in Code Mode, which Claude Code resumes only in its terminal for now: keep it there");
    return { session: file };
  }
  throw new Error("Claude Code didn't register this process (no ~/.claude/sessions/<pid>.json)");
}
