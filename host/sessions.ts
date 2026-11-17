// /resume's list: every session of a scope, newest first, searched by name,
// first message and folder (as Codex's and Claude Code's own pickers search;
// not the messages). An adapter says where sessions come from (SessionSource);
// the catalog reads them, remembers each file's description until it changes,
// and answers a query from that. A pass over files yields between files, so a
// long first pass (every Pi session ever) never holds up the agent's events;
// the client asks again while `loading` says how far it got.
import { statSync } from "node:fs";
import { realDir } from "./jsonl.ts";
import type { SessionInfo, SessionScope, SessionSource } from "./providers/types.ts";

export type ListedSession = SessionInfo & { here: boolean };
/** `loading`: still reading; `total` 0 while the agent hasn't said how many (Codex's pages). */
export type SessionList = { sessions: ListedSession[]; loading: { done: number; total: number } | null };

type FileSource = Extract<SessionSource, { kind: "files" }>;
type AgentSource = Extract<SessionSource, { kind: "agent" }>;
type Pass = { done: number; total: number; found: SessionInfo[]; finished: boolean; error: unknown; ended: Promise<void> };

/** How long a request waits for its pass before answering with what's there. */
const ANSWER_WITHIN_MS = 150;
/** The longest a pass runs before letting other work in. */
const SLICE_MS = 15;

export class SessionCatalog {
  private known = new Map<string, { size: number; mtime: number; info: SessionInfo | null }>();
  private passes = new Map<SessionScope, Pass>();
  private reals = new Map<string, string>(); // a session's folder → resolved
  private source: SessionSource;
  private cwd: string; // resolved
  private current: () => string | null;

  constructor(source: SessionSource, cwd: string, current: () => string | null) {
    this.source = source;
    this.cwd = realDir(cwd);
    this.current = current;
  }

  /**
   * `refresh`: look again (the picker opening); else answer from the last pass of
   * this scope, or start one. `query`: words that must all appear in the name or
   * first message, or (every folder's) the folder; name or first message first.
   * Every match: a few thousand rows are ~1 MB, and the picker shows a window of them.
   */
  async list(scope: SessionScope, { query = "", refresh = false } = {}): Promise<SessionList> {
    let pass = this.passes.get(scope);
    if (!pass || (refresh && pass.finished)) {
      pass = this.start(scope);
      this.passes.set(scope, pass);
    }
    if (!pass.finished) await Promise.race([pass.ended, new Promise((r) => setTimeout(r, ANSWER_WITHIN_MS))]);
    if (pass.error) {
      this.passes.delete(scope);
      throw pass.error;
    }
    let rows = pass.found.map((s) => ({ ...s, here: !s.cwd || this.real(s.cwd) === this.cwd }));
    if (scope === "cwd") rows = rows.filter((s) => s.here);
    // In this folder's list every row has this folder: a word from its path would match them all.
    rows = search(rows.sort((a, b) => b.modified - a.modified), query, { folder: scope === "all" });
    return { sessions: rows, loading: pass.finished ? null : { done: pass.done, total: pass.total } };
  }

  private real(dir: string): string {
    let r = this.reals.get(dir);
    if (r === undefined) this.reals.set(dir, (r = realDir(dir)));
    return r;
  }

  private start(scope: SessionScope): Pass {
    const pass: Pass = { done: 0, total: 0, found: [], finished: false, error: null, ended: Promise.resolve() };
    const src = this.source;
    pass.ended = (src.kind === "agent" ? this.ask(src, scope, pass) : this.read(src, scope, pass))
      .catch((e) => void (pass.error = e))
      .finally(() => void (pass.finished = true));
    return pass;
  }

  private async ask(src: AgentSource, scope: SessionScope, pass: Pass): Promise<void> {
    pass.found = await src.list(scope);
    pass.done = pass.total = pass.found.length;
  }

  private async read(src: FileSource, scope: SessionScope, pass: Pass): Promise<void> {
    const files: { path: string; size: number; mtime: number }[] = [];
    for (const path of new Set(src.files(this.current(), scope))) {
      try {
        const st = statSync(path);
        files.push({ path, size: st.size, mtime: st.mtimeMs });
      } catch {}
    }
    files.sort((a, b) => b.mtime - a.mtime);
    pass.total = files.length;
    let slice = Date.now();
    for (const f of files) {
      let k = this.known.get(f.path);
      if (!k || k.size !== f.size || k.mtime !== f.mtime) {
        k = { size: f.size, mtime: f.mtime, info: src.describe(f.path) };
        this.known.set(f.path, k);
      }
      if (k.info && k.info.messageCount !== 0) pass.found.push(k.info);
      pass.done++;
      if (Date.now() - slice > SLICE_MS) {
        await new Promise((r) => setImmediate(r));
        slice = Date.now();
      }
    }
    // Every folder's files: what isn't there any more is forgotten.
    if (scope === "all") {
      const seen = new Set(files.map((f) => f.path));
      for (const p of this.known.keys()) if (!seen.has(p)) this.known.delete(p);
    }
  }
}

/** Newest first in, newest first out: matches in the name or first message, then (`folder`) those only in the folder. */
export function search<T extends SessionInfo>(list: T[], query: string, { folder = true } = {}): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return list;
  const inTitle: T[] = [];
  const inFolderOnly: T[] = [];
  for (const s of list) {
    const t = `${s.name ?? ""}\n${s.firstMessage}`.toLowerCase();
    const f = folder ? (s.cwd ?? "").toLowerCase() : "";
    let inFolder = false;
    let all = true;
    for (const w of words) {
      if (t.includes(w)) continue;
      if (f.includes(w)) inFolder = true;
      else {
        all = false;
        break;
      }
    }
    if (all) (inFolder ? inFolderOnly : inTitle).push(s);
  }
  return [...inTitle, ...inFolderOnly];
}
