// Pi session files for a cwd: where they live and what they contain.
import { readdirSync, statSync, openSync, readSync, closeSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { typedText } from "../../skill.ts";
import { parsePiSkill } from "./skill.ts";

export type SessionInfo = { path: string; name: string | null; firstMessage: string; modified: number; messageCount: number };

export function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

/** Pi's default per-cwd folder: leading separator removed, `/`, `\` and `:` → `-`. */
export function defaultSessionDir(cwd: string): string {
  const base = process.env.PI_CODING_AGENT_SESSION_DIR ?? readSetting("sessionDir", cwd) ?? join(agentDir(), "sessions");
  return join(base, `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
}

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
  return typeof v === "string" ? v.replace(/^~(?=\/)/, homedir()) : undefined;
}

const MAX_READ = 16 * 1024 * 1024;

function readHead(path: string, size: number): string {
  const n = Math.min(size, MAX_READ);
  const buf = Buffer.alloc(n);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, n, 0);
  } finally {
    closeSync(fd);
  }
  return buf.toString("utf8");
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((b) => b?.type === "text").map((b) => b.text).join(" ");
  return "";
}

export function describeSession(path: string): SessionInfo | null {
  let st;
  try {
    st = statSync(path);
  } catch {
    return null;
  }
  const text = readHead(path, st.size);
  let name: string | null = null;
  let first = "";
  let count = 0;
  let header = false;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === "session") {
      header = true;
      continue;
    }
    if (e.type === "session_info") name = typeof e.name === "string" && e.name ? e.name : null;
    if (e.type === "message" && e.message) {
      const role = e.message.role;
      if (role === "user" || role === "assistant") count++;
      if (role === "user" && !first) {
        const text = textOf(e.message.content);
        const skill = parsePiSkill(text);
        first = (skill ? typedText(skill.text, skill.skill) : text).slice(0, 200);
      }
    }
  }
  if (!header) return null;
  return { path, name, firstMessage: first, modified: st.mtimeMs, messageCount: count };
}

/** Sessions in the given folders, newest first. */
export function listSessions(dirs: string[], limit = 100): SessionInfo[] {
  const files = new Map<string, number>();
  for (const dir of dirs) {
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      if (!n.endsWith(".jsonl")) continue;
      const p = join(dir, n);
      try {
        files.set(p, statSync(p).mtimeMs);
      } catch {}
    }
  }
  const sorted = [...files.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
  const out: SessionInfo[] = [];
  for (const [p] of sorted) {
    const d = describeSession(p);
    if (d && d.messageCount > 0) out.push(d);
  }
  return out;
}
