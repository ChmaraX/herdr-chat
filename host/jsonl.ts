// Reading agents' JSONL session stores: which files, their lines without
// decoding what isn't needed, and folders as the agents record them.
import { closeSync, openSync, readdirSync, readSync, realpathSync } from "node:fs";
import { join } from "node:path";

const CHUNK = 1 << 20;
const HEAD = 512;
let chunk: Buffer | null = null; // one for every read (eachLine is synchronous), made on the first

/**
 * A JSONL file's lines without decoding all of it: `want` sees each line's first
 * bytes (up to 512) and says whether `take` gets the whole line. A session's tool
 * output and images (most of a Pi session's bytes) are skipped, not decoded.
 */
export function eachLine(path: string, want: (head: string) => boolean, take: (line: string) => void): void {
  const fd = openSync(path, "r");
  const buf = (chunk ??= Buffer.allocUnsafe(CHUNK));
  let parts: Buffer[] = [];
  let size = 0;
  let keep: boolean | null = null; // null: not decided yet
  const decide = () => {
    if (keep === null) keep = want(Buffer.concat(parts).subarray(0, HEAD).toString("utf8"));
    if (!keep) parts = [];
  };
  try {
    for (let n: number; (n = readSync(fd, buf, 0, CHUNK, null)) > 0; ) {
      for (let i = 0; i < n; ) {
        const nl = buf.indexOf(10, i);
        const end = nl === -1 || nl >= n ? n : nl;
        let from = i;
        if (keep === null && end > from) { // the head first: most lines stop there
          const to = Math.min(end, from + HEAD - size);
          parts.push(Buffer.from(buf.subarray(from, to)));
          size += to - from;
          from = to;
          if (size >= HEAD) decide();
        }
        if (keep === true && end > from) {
          parts.push(Buffer.from(buf.subarray(from, end)));
          size += end - from;
        }
        if (end === n) break;
        decide();
        if (keep) take(Buffer.concat(parts).toString("utf8"));
        parts = [];
        size = 0;
        keep = null;
        i = end + 1;
      }
    }
    if (size) {
      decide();
      if (keep) take(Buffer.concat(parts).toString("utf8"));
    }
  } finally {
    closeSync(fd);
  }
}

/** The folders in `root` (an agent's per-project session folders); none if it can't be read. */
export function subdirs(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => join(root, e.name));
  } catch {
    return [];
  }
}

/** The `.jsonl` files in these folders. */
export function jsonlFiles(dirs: string[]): string[] {
  const out: string[] = [];
  for (const dir of dirs) {
    try {
      for (const n of readdirSync(dir)) if (n.endsWith(".jsonl")) out.push(join(dir, n));
    } catch {}
  }
  return out;
}

/** A folder as the agents record it, resolved (macOS /tmp → /private/tmp); a gone one as given. */
export function realDir(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p.replace(/\/+$/, "");
  }
}
