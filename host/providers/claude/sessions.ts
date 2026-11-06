// Claude Code's session files: ~/.claude/projects/<cwd, non-alphanumerics → '-'>/<id>.jsonl
// ($CLAUDE_CONFIG_DIR instead of ~/.claude), and the CLI's live-process registry
// ~/.claude/sessions/<pid>.json.
import { readdirSync, statSync, readFileSync, realpathSync, openSync, readSync, closeSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import type { SessionInfo } from "../types.ts";

type Rec = Record<string, any>;

export function configDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

/** The CLI resolves the cwd (macOS /tmp → /private/tmp), then replaces every non-alphanumeric with '-'. */
export function projectDir(cwd: string): string {
  let real = cwd;
  try {
    real = realpathSync(cwd);
  } catch {}
  let enc = real.replace(/[^A-Za-z0-9]/g, "-");
  // Long names are cut and given a hash (sessions docs); 200 is the CLI's limit.
  if (enc.length > 200) enc = enc.slice(0, 200) + "-" + createHash("sha256").update(real).digest("hex").slice(0, 8);
  return join(configDir(), "projects", enc);
}

export function sessionPath(cwd: string, id: string): string {
  return join(projectDir(cwd), `${id}.jsonl`);
}

export function sessionIdOf(path: string): string {
  return basename(path).replace(/\.jsonl$/, "");
}

const MAX_READ = 32 * 1024 * 1024;

/** The records of a transcript (at most 32 MiB of it); unparsable lines are skipped. */
export function readTranscript(path: string): Rec[] {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return [];
  }
  const n = Math.min(size, MAX_READ);
  const buf = Buffer.alloc(n);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, n, 0);
  } finally {
    closeSync(fd);
  }
  const out: Rec[] = [];
  for (const line of buf.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && typeof r === "object") out.push(r);
    } catch {}
  }
  return out;
}

/** A user record that a person typed (not a tool result, a CLI marker or a meta record). */
export function promptText(r: Rec): string | null {
  if (r.type !== "user" || r.isSidechain || r.isMeta || r.isCompactSummary) return null;
  const c = r.message?.content;
  let text: string;
  if (typeof c === "string") text = c;
  else if (Array.isArray(c)) {
    if (c.some((b: Rec) => b?.type === "tool_result")) return null;
    text = c.filter((b: Rec) => b?.type === "text").map((b: Rec) => b.text).join("\n");
    if (!text && !c.some((b: Rec) => b?.type === "image")) return null;
  } else return null;
  const cmd = /^<command-name>\/?([^<]*)<\/command-name>[\s\S]*?(?:<command-args>([\s\S]*?)<\/command-args>)?/.exec(text.trim());
  if (cmd) return `/${cmd[1]!.trim()}${cmd[2]?.trim() ? " " + cmd[2].trim() : ""}`;
  if (/^<local-command-(stdout|stderr|caveat)>/.test(text.trim())) return null;
  if (/^\[Request interrupted by user/.test(text.trim())) return null;
  return text;
}

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
  const ids = new Set<string>();
  for (const r of readTranscript(path)) {
    if (r.type === "custom-title" && typeof r.customTitle === "string") name = r.customTitle || null;
    if (r.isSidechain) continue;
    const p = promptText(r);
    if (p !== null) {
      count++;
      if (!first) first = p.slice(0, 200);
    } else if (r.type === "assistant" && typeof r.message?.id === "string" && !ids.has(r.message.id)) {
      ids.add(r.message.id);
      count++;
    }
  }
  return { path, name, firstMessage: first, modified: st.mtimeMs, messageCount: count };
}

/** This cwd's sessions, newest first (ours are `entrypoint: sdk-cli`; the TUI's own picker hides them, ours doesn't). */
export function listSessions(cwd: string, limit = 100): SessionInfo[] {
  const dir = projectDir(cwd);
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const files: [string, number][] = [];
  for (const n of names) {
    if (!n.endsWith(".jsonl")) continue;
    const p = join(dir, n);
    try {
      files.push([p, statSync(p).mtimeMs]);
    } catch {}
  }
  files.sort((a, b) => b[1] - a[1]);
  const out: SessionInfo[] = [];
  for (const [p] of files.slice(0, limit)) {
    const d = describeSession(p);
    if (d && d.messageCount > 0) out.push(d);
  }
  return out;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Another live Claude Code process on this session, from the CLI's own registry. */
export function liveHolder(sessionId: string, exceptPid?: number): { pid: number; kind?: string } | null {
  const dir = join(configDir(), "sessions");
  if (!existsSync(dir)) return null;
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    try {
      const r = JSON.parse(readFileSync(join(dir, n), "utf8"));
      if (r?.sessionId === sessionId && typeof r.pid === "number" && r.pid !== exceptPid && pidAlive(r.pid)) return { pid: r.pid, kind: r.kind };
    } catch {}
  }
  return null;
}

/** `effortLevel` and `permissions.defaultMode` from the user's settings, if set. */
export function readUserSettings(): { effortLevel?: string; defaultMode?: string } {
  try {
    const s = JSON.parse(readFileSync(join(configDir(), "settings.json"), "utf8"));
    return {
      ...(typeof s?.effortLevel === "string" ? { effortLevel: s.effortLevel } : {}),
      ...(typeof s?.permissions?.defaultMode === "string" ? { defaultMode: s.permissions.defaultMode } : {}),
    };
  } catch {
    return {};
  }
}
