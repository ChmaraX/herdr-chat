// `@file` search: git ls-files (else a bounded walk), cached 30 s, fuzzy-ranked.
import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const MAX_FILES = 50_000;
const SKIP = new Set([".git", "node_modules", ".hg", ".svn", "dist", "build", "target", ".next", ".cache", "__pycache__", ".venv"]);

function gitFiles(cwd: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    execFile("git", ["ls-files", "-co", "--exclude-standard"], { cwd, maxBuffer: 64 * 1024 * 1024, timeout: 10_000 }, (err, stdout) => {
      if (err) resolve(null);
      else resolve(stdout.split("\n").filter(Boolean).slice(0, MAX_FILES));
    });
  });
}

function walk(cwd: string): string[] {
  const out: string[] = [];
  const stack = [""];
  while (stack.length && out.length < MAX_FILES) {
    const rel = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(join(cwd, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) stack.push(p);
      } else if (e.isFile()) {
        out.push(p);
        if (out.length >= MAX_FILES) break;
      }
    }
  }
  return out;
}

/** Subsequence score: higher is better; -1 = no match. */
export function fuzzyScore(path: string, query: string): number {
  if (!query) return 1;
  const p = path.toLowerCase();
  const q = query.toLowerCase();
  const base = p.slice(p.lastIndexOf("/") + 1);
  let score = 0;
  if (base === q) score += 1000;
  else if (base.startsWith(q)) score += 600;
  else if (base.includes(q)) score += 400;
  else if (p.includes(q)) score += 200;
  let pi = 0;
  let run = 0;
  for (const ch of q) {
    const at = p.indexOf(ch, pi);
    if (at < 0) return -1;
    run = at === pi ? run + 1 : 0;
    score += 1 + run * 2;
    if (at === 0 || p[at - 1] === "/" || p[at - 1] === "-" || p[at - 1] === "_" || p[at - 1] === ".") score += 5;
    pi = at + 1;
  }
  return score - path.length * 0.05;
}

export class FileIndex {
  private cwd: string;
  private files: string[] | null = null;
  private at = 0;
  private loading: Promise<string[]> | null = null;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  private async list(): Promise<string[]> {
    if (this.files && Date.now() - this.at < 30_000) return this.files;
    if (!this.loading) {
      this.loading = (async () => {
        const files = (await gitFiles(this.cwd)) ?? walk(this.cwd);
        this.files = files;
        this.at = Date.now();
        this.loading = null;
        return files;
      })();
    }
    // Serve stale results while refreshing.
    return this.files ?? this.loading;
  }

  async search(query: string, limit = 50): Promise<string[]> {
    const files = await this.list();
    const q = query.trim();
    const scored: [number, string][] = [];
    for (const f of files) {
      const s = fuzzyScore(f, q);
      if (s >= 0) scored.push([s, f]);
    }
    scored.sort((a, b) => b[0] - a[0] || a[1].localeCompare(b[1]));
    return scored.slice(0, Math.max(1, Math.min(limit, 500))).map((x) => x[1]);
  }
}
