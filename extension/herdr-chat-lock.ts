// herdr-chat-lock: keeps Pi's TUI from writing a session that a Herdr chat
// (herdr-chat-host) has open. Pi has no session-file lock, and two Pi processes
// appending to one session JSONL corrupt it.
//
// herdr-chat-host writes `<sessionFile>.herdr-chat.lock` ({pid, chat, terminal,
// startedAt}) while its Pi child runs and removes it when the child stops.
// This extension, installed into the person's normal Pi, checks that lock:
//   - on `/resume` into a locked session: cancels the switch, says why;
//   - when a session opens locked (`pi --session <file>`, `-c`): asks whether
//     to quit, and warns if the person stays.
// A lock whose pid is dead is stale and ignored. The host's own Pi child runs
// with HERDR_CHAT_HOST=1, where this extension does nothing.
//
// In a herdr-core terminal (HC_TERMINAL_ID), it also labels that terminal
// with the session it opens (`herdr-chat.session=<file>`, on start and on every
// switch): Herdr's right-click menu (mod chat-menu) offers Continue as chat
// for a Pi sub-agent with that label, which resumes the session in a chat.
//
// Installed by herdr-chat's install.sh into ~/.pi/agent/extensions/.

import { execFile } from "node:child_process";
import { readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Lock = { pid: number; chat?: string; terminal?: string | null; startedAt?: number };

const LOCK_SUFFIX = ".herdr-chat.lock";

function liveLock(sessionFile: string | undefined | null): Lock | null {
  if (!sessionFile) return null;
  let lock: Lock;
  try {
    lock = JSON.parse(readFileSync(sessionFile + LOCK_SUFFIX, "utf8"));
  } catch {
    return null; // no lock (or unreadable): nothing to guard
  }
  if (!Number.isInteger(lock.pid) || lock.pid <= 0 || lock.pid === process.pid) return null;
  try {
    process.kill(lock.pid, 0);
  } catch (e) {
    // ESRCH: gone, a stale lock. EPERM: alive but not ours, still a writer.
    if ((e as NodeJS.ErrnoException).code !== "EPERM") return null;
  }
  return lock;
}

function where(lock: Lock): string {
  return lock.terminal ? `a Herdr chat (terminal ${lock.terminal})` : "a Herdr chat";
}

// A TUI opened by a chat's hand-off (`/tui`, `/fork`…) runs with HERDR_CHAT_HANDOFF
// set to a file. Every session it opens (the hand-off's, then a fork or a
// /resume) is written there, so the chat continues on the session the TUI
// ended on.
function reportHandoffSession(file: string | undefined) {
  const out = process.env.HERDR_CHAT_HANDOFF;
  if (!out || !file) return;
  try {
    mkdirSync(dirname(out), { recursive: true });
    const tmp = `${out}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ sessionFile: file, pid: process.pid, at: Date.now() }));
    renameSync(tmp, out);
  } catch {
    // best effort: the chat then resumes the session it handed off
  }
}

// Best effort and not awaited: without hc (or outside a core terminal) Pi runs
// as before. One call at a time, in order: a quick switch never leaves the
// label on the session before it.
let labelling: Promise<void> = Promise.resolve();
function labelSession(file: string | undefined) {
  const terminal = process.env.HC_TERMINAL_ID;
  if (!terminal || !file) return;
  const hc = process.env.HERDR_CHAT_HC || "hc";
  labelling = labelling.then(() => new Promise<void>((done) => {
    try {
      execFile(hc, ["label", terminal, `herdr-chat.session=${file}`], { timeout: 5000 }, () => done());
    } catch {
      done(); // no hc: nothing to label
    }
  }));
}

export default function herdrChatLock(pi: ExtensionAPI) {
  if (process.env.HERDR_CHAT_HOST === "1") return;

  pi.on("session_before_switch", async (event, ctx) => {
    if (event.reason !== "resume") return;
    const lock = liveLock(event.targetSessionFile);
    if (!lock) return;
    if (ctx.hasUI) {
      ctx.ui.notify(
        `That session is open in ${where(lock)}. Close the chat (or use its "TUI" button) before resuming it here.`,
        "warning",
      );
    }
    return { cancel: true };
  });

  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    reportHandoffSession(ctx.sessionManager.getSessionFile());
    labelSession(ctx.sessionManager.getSessionFile());
    const lock = liveLock(ctx.sessionManager.getSessionFile());
    if (!lock || !ctx.hasUI) return;
    // Not awaited: Pi awaits session_start handlers before it reads input, so a
    // dialog awaited here could never be answered in RPC mode (verified on Pi
    // 1.5.0) and would delay startup in the TUI.
    void (async () => {
      const quit = await ctx.ui.confirm(
        "This session is open in Herdr",
        `It is open in ${where(lock)}. Two Pi processes writing one session file corrupt it. Quit this Pi?`,
      );
      if (quit) {
        ctx.shutdown();
        return;
      }
      ctx.ui.notify(`Session also open in ${where(lock)}: don't send messages from both.`, "warning");
    })();
  });
}
