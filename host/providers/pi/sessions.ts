// Pi session files for a cwd: where they live and what they contain.
import { statSync, readFileSync } from "node:fs";
import { eachLine, realDir, subdirs } from "../../jsonl.ts";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { typedText } from "../../skill.ts";
import { userText, fileArgsAsTyped } from "./skill.ts";
import type { SessionInfo, SessionScope } from "../types.ts";

export function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

/**
 * The folders Pi keeps sessions in, as Pi resolves them: a custom session dir
 * (`--session-dir`, $PI_CODING_AGENT_SESSION_DIR, the `sessionDir` setting) holds
 * every folder's sessions flat; else each cwd has its own folder under
 * <agent dir>/sessions, named from the real path, as Pi's process.cwd() is (leading
 * separator removed, `/`, `\\` and `:` → `-`).
 * `cwd`: this folder's; `all`: every folder's. Pi's list keeps a flat dir's to the cwd.
 */
export function sessionDirs(cwd: string, args: string[], scope: SessionScope): string[] {
  const flag = args.indexOf("--session-dir");
  const env = process.env.PI_CODING_AGENT_SESSION_DIR;
  const custom = (flag >= 0 ? args[flag + 1] : undefined) ?? (env ? tilde(env) : undefined) ?? readSetting("sessionDir", cwd);
  if (custom) return [resolve(cwd, custom)];
  const root = join(agentDir(), "sessions");
  if (scope === "all") return subdirs(root);
  return [join(root, `--${realDir(resolve(cwd)).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`)];
}

const tilde = (p: string) => p.replace(/^~(?=\/|$)/, homedir());

export function readSettings(cwd: string): Record<string, any> {
  let merged: Record<string, any> = {};
  for (const p of [join(agentDir(), "settings.json"), join(cwd, ".pi", "settings.json")]) {
    try {
      merged = { ...merged, ...JSON.parse(readFileSync(p, "utf8")) };
    } catch {}
  }
  return merged;
}

function readSetting(key: string, cwd: string): string | undefined {
  const v = readSettings(cwd)[key];
  return typeof v === "string" && v ? tilde(v) : undefined;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((b) => b?.type === "text").map((b) => b.text).join(" ");
  return "";
}

// Only the lines that say something about the session are parsed: the header, the
// name, and the first user message; every other message is counted from its first bytes.
export function describeSession(path: string): SessionInfo | null {
  let st;
  try {
    st = statSync(path);
  } catch {
    return null;
  }
  let name: string | null = null;
  let first = "";
  let count = 0;
  let header = false;
  let cwd: string | null = null;
  const take = (line: string) => {
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      return;
    }
    if (e.type === "session") {
      header = true;
      if (typeof e.cwd === "string" && e.cwd) cwd = e.cwd;
    } else if (e.type === "session_info") name = typeof e.name === "string" && e.name ? e.name : null;
    else if (e.type === "message" && (e.message?.role === "user" || e.message?.role === "assistant")) {
      count++;
      if (e.message.role === "user" && !first) {
        const text = textOf(e.message.content);
        const u = userText(text);
        first = fileArgsAsTyped(typedText(u.text, u.skills)).slice(0, 200);
      }
    }
  };
  const want = (head: string) => {
    const type = /^\{"type":"([a-z_]+)"/.exec(head)?.[1];
    if (type === undefined) return true; // not as Pi writes it: parse to be sure
    if (type !== "message") return type === "session" || type === "session_info";
    const role = /"role":"(\w+)"/.exec(head)?.[1];
    if (role === undefined) return true;
    if (role === "assistant" || (role === "user" && first)) count++;
    return role === "user" && !first;
  };
  try {
    eachLine(path, want, take);
  } catch {
    return null;
  }
  if (!header) return null;
  return { path, name, firstMessage: first, modified: st.mtimeMs, messageCount: count, cwd };
}
