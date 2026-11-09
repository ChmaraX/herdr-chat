// Rich rendering of items for the wire (protocol.md v2): assistant blocks with
// highlighted code and mermaid SVGs, tool `outputLines`, edit `diffLines`.
// `prepare` runs right before items are sent (flush, snapshot, history), so
// streaming text is re-split at most once per 50 ms flush. Closed code blocks
// and mermaid renders are cached by content hash.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { splitBlocks } from "./blocks.ts";
import { highlight, langForPath, plainLines, MAX_LINES } from "./highlight.ts";
import { renderMermaid, DEFAULT_THEME } from "./mermaid.ts";
import type { Theme } from "./mermaid.ts";
import { toSpans } from "./ansi.ts";
import type { Span } from "./ansi.ts";
import type { Item, AssistantItem, ToolItem, Block, DiffLine } from "./timeline.ts";

const CACHE_MAX = 400;
/** Highlighted spans per item, past which later code blocks go without `lines` (keeps records far below 8 MiB). */
const MAX_SPANS = 60_000;
/** Text in an edit's diffLines. */
const MAX_DIFF_TEXT = 256 * 1024;

function hash(...parts: string[]): string {
  const h = createHash("sha1");
  for (const p of parts) h.update(p).update("\0");
  return h.digest("hex").slice(0, 16);
}

/** A Map that drops its oldest entry past `max`. */
class Lru<V> {
  private m = new Map<string, V>();
  private max: number;
  constructor(max: number) {
    this.max = max;
  }
  get(k: string): V | undefined {
    const v = this.m.get(k);
    if (v !== undefined) {
      this.m.delete(k);
      this.m.set(k, v);
    }
    return v;
  }
  set(k: string, v: V): void {
    this.m.delete(k);
    this.m.set(k, v);
    if (this.m.size > this.max) this.m.delete(this.m.keys().next().value!);
  }
  clear(): void {
    this.m.clear();
  }
}

/** Splits spans (which may hold "\n") into lines. */
export function spanLines(spans: Span[]): Span[][] {
  const lines: Span[][] = [[]];
  for (const s of spans) {
    const parts = s.text.split("\n");
    parts.forEach((part, i) => {
      if (i > 0) lines.push([]);
      if (part) lines[lines.length - 1]!.push({ ...s, text: part });
    });
  }
  return lines;
}

/** Drops `n` characters (counting each line break) from the front of `lines`. */
function dropFront(lines: Span[][], n: number): Span[][] {
  let i = 0;
  while (i < lines.length && n > 0) {
    const len = lines[i]!.reduce((a, s) => a + s.text.length, 0);
    if (len + 1 <= n) {
      n -= len + 1;
      i++;
      continue;
    }
    const line: Span[] = [];
    for (const s of lines[i]!) {
      if (n >= s.text.length) n -= s.text.length;
      else {
        line.push({ ...s, text: s.text.slice(n) });
        n = 0;
      }
    }
    return [line, ...lines.slice(i + 1)];
  }
  return lines.slice(i);
}

/** Pi read output with a line-number prefix ("  12\t…", "12│…", "12#ab:…"), when every line has one. */
const NUM_PREFIX = /^(\s*\d+(?:#[0-9a-zA-Z]+)?(?:\t|[│|:→] ?| {2}))/;

export function readLines(text: string, path: string): Span[][] {
  const all = text.split("\n");
  // Pi's trailing notes ("[Showing lines 1-2000 of 5000. …]") are not file content.
  let end = all.length;
  while (end > 0 && (/^\[.*\]$/.test(all[end - 1]!.trim()) || (!all[end - 1]!.trim() && end < all.length))) end--;
  const body = all.slice(0, end);
  const trailer = all.slice(end).map((l): Span[] => (l ? [{ text: l, dim: true }] : []));
  const nonEmpty = body.filter((l) => l.length);
  const numbered = nonEmpty.length > 0 && nonEmpty.every((l) => NUM_PREFIX.test(l));
  const lang = langForPath(path);
  if (!numbered) {
    const { lines } = highlight(body.join("\n"), lang, false);
    return [...lines, ...trailer];
  }
  const prefixes = body.map((l) => NUM_PREFIX.exec(l)?.[1] ?? "");
  const { lines } = highlight(body.map((l, i) => l.slice(prefixes[i]!.length)).join("\n"), lang, false);
  const out = lines.map((spans, i): Span[] => (prefixes[i] ? [{ text: prefixes[i]!, dim: true }, ...spans] : spans));
  return [...out, ...trailer];
}

/** Unified diff → typed, numbered, highlighted lines, plus +/− counts. */
export function diffLines(diff: string, path: string): { lines: DiffLine[]; added: number; removed: number } {
  const raw = diff.split("\n");
  if (raw.at(-1) === "") raw.pop();
  const lang = langForPath(path);
  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  let oldN: number | undefined;
  let newN: number | undefined;
  let inHunk = false;
  // Lines of the current hunk, highlighted per side when the hunk ends.
  let hunk: { line: DiffLine; side: "old" | "new" | "both"; text: string }[] = [];
  const endHunk = () => {
    if (!hunk.length) return;
    const oldSide = hunk.filter((h) => h.side !== "new");
    const newSide = hunk.filter((h) => h.side !== "old");
    const hiOld = highlight(oldSide.map((h) => h.text).join("\n"), lang, false).lines;
    const hiNew = highlight(newSide.map((h) => h.text).join("\n"), lang, false).lines;
    oldSide.forEach((h, i) => {
      if (h.side === "old") h.line.spans = hiOld[i] ?? [];
    });
    newSide.forEach((h, i) => (h.line.spans = hiNew[i] ?? []));
    hunk = [];
  };
  let size = 0;
  for (const l of raw) {
    size += l.length;
    const full = lines.length < MAX_LINES && size <= MAX_DIFF_TEXT;
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (l.startsWith("@@")) {
      endHunk();
      inHunk = true;
      oldN = h ? Number(h[1]) : undefined;
      newN = h ? Number(h[2]) : undefined;
      // A hunk with no positions (an edit's own old/new text, before its result's patch): a plain separator.
      if (full && (h || lines.length)) lines.push({ kind: "hunk", spans: [{ text: h ? l : "⋯" }] });
      continue;
    }
    if (!inHunk || l.startsWith("\\")) {
      if (full) lines.push({ kind: "meta", spans: [{ text: l }] });
      continue;
    }
    const c = l[0];
    const text = l.slice(1);
    if (c === "+") {
      added++;
      const line: DiffLine = { kind: "add", ...(newN !== undefined ? { new: newN++ } : {}), spans: [] };
      if (full) {
        lines.push(line);
        hunk.push({ line, side: "new", text });
      }
    } else if (c === "-") {
      removed++;
      const line: DiffLine = { kind: "del", ...(oldN !== undefined ? { old: oldN++ } : {}), spans: [] };
      if (full) {
        lines.push(line);
        hunk.push({ line, side: "old", text });
      }
    } else if (c === " " || l === "") {
      const line: DiffLine = { kind: "ctx", ...(oldN !== undefined ? { old: oldN++ } : {}), ...(newN !== undefined ? { new: newN++ } : {}), spans: [] };
      if (full) {
        lines.push(line);
        hunk.push({ line, side: "both", text });
      }
    } else if (full) {
      // "--- a" / "+++ b" of a following file, "diff --git", "index …".
      endHunk();
      inHunk = false;
      lines.push({ kind: "meta", spans: [{ text: l }] });
    }
  }
  endHunk();
  return { lines, added, removed };
}

type Seen = { text?: string; streaming?: boolean; theme?: string; output?: string; status?: string; detail?: object; diff?: string | null };

export class Renderer {
  theme: Theme = DEFAULT_THEME;
  private themeKey = hash(JSON.stringify(DEFAULT_THEME));
  private code = new Lru<Span[][]>(CACHE_MAX);
  private mermaid = new Lru<{ svg?: string; ascii?: Span[][]; error?: string }>(CACHE_MAX);
  private seen = new WeakMap<Item, Seen>();
  private dir: string | null;
  private raw: (itemId: string) => string | undefined;
  private log: (msg: string) => void;

  /**
   * @param dir where mermaid SVGs go (<stateDir>/images/<chat>); null: no SVGs, only ASCII art
   * @param raw a tool item's output with its ANSI escapes (the tail is enough)
   */
  constructor(dir: string | null, raw: (itemId: string) => string | undefined = () => undefined, log: (msg: string) => void = () => {}) {
    this.dir = dir;
    this.raw = raw;
    this.log = log;
  }

  /** Sets the colors for SVGs. Returns true when they changed (the caller re-sends the mermaid items). */
  setTheme(colors: Record<string, unknown>, dark: boolean): boolean {
    const t: Record<string, unknown> = { ...DEFAULT_THEME, dark };
    for (const [k, v] of Object.entries(colors ?? {})) {
      if (typeof v === "string" && /^#[0-9a-f]{3}([0-9a-f]{3})?([0-9a-f]{2})?$/i.test(v.trim())) t[k] = v.trim().slice(0, 7);
    }
    const key = hash(JSON.stringify(t));
    if (key === this.themeKey) return false;
    this.theme = t as Theme;
    this.themeKey = key;
    return true;
  }

  /** True when the item has a closed mermaid block (it changes with the theme). */
  hasMermaid(item: Item): boolean {
    return item.kind === "assistant" && !!item.blocks?.some((b) => b.type === "mermaid" && !b.open);
  }

  /** Brings an item's rich fields up to date (in place). Cheap when nothing changed. */
  prepare(item: Item): void {
    try {
      if (item.kind === "assistant") this.prepareAssistant(item);
      else if (item.kind === "tool") this.prepareTool(item);
    } catch (e) {
      this.log(`render ${item.id}: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    }
  }

  private prepareAssistant(item: AssistantItem): void {
    const s = this.seen.get(item);
    if (s && s.text === item.text && s.streaming === item.streaming && s.theme === this.themeKey) return;
    this.seen.set(item, { text: item.text, streaming: item.streaming, theme: this.themeKey });
    item.blocks = splitBlocks(item.text, item.streaming).map((b): Block => {
      if (b.type === "markdown") return b;
      if (b.type === "code") {
        if (b.open) return { ...b, lines: highlight(b.code, b.lang, false).lines };
        const key = hash(b.lang ?? "", b.code);
        let lines = this.code.get(key);
        if (!lines) {
          lines = highlight(b.code, b.lang, true).lines;
          this.code.set(key, lines);
        }
        return { ...b, lines };
      }
      if (b.open) return b;
      return { ...b, ...this.renderMermaid(b.source) };
    });
    let spans = 0;
    for (const b of item.blocks) {
      if (b.type !== "code" || !b.lines) continue;
      spans += b.lines.reduce((a, l) => a + l.length, 0);
      if (spans > MAX_SPANS) delete b.lines;
    }
  }

  private renderMermaid(source: string): { svg?: string; ascii?: Span[][]; error?: string } {
    const key = hash(source, this.themeKey);
    const hit = this.mermaid.get(key);
    if (hit && (!hit.svg || existsSync(hit.svg))) return hit;
    const r = renderMermaid(source, this.theme);
    let out: { svg?: string; ascii?: Span[][]; error?: string };
    if ("svg" in r) {
      if (this.dir) {
        const path = join(this.dir, `mermaid-${key}.svg`);
        try {
          mkdirSync(this.dir, { recursive: true, mode: 0o700 });
          if (!existsSync(path)) writeFileSync(path, r.svg, { mode: 0o600 });
          out = { svg: path };
        } catch (e) {
          out = { error: `could not save the diagram: ${e instanceof Error ? e.message : String(e)}` };
        }
      } else out = {};
    } else out = { ascii: r.ascii, error: r.error };
    this.mermaid.set(key, out);
    return out;
  }

  private prepareTool(item: ToolItem): void {
    const d = item.detail;
    const diff = d.type === "edit" ? d.diff : null;
    const s = this.seen.get(item);
    if (s && s.output === item.output && s.status === item.status && s.detail === d && s.diff === diff) return;
    this.seen.set(item, { output: item.output, status: item.status, detail: d, diff });
    if (d.type === "bash") {
      if (!item.output) delete item.outputLines;
      else {
        const lines = spanLines(toSpans(this.raw(item.id) ?? item.output));
        const plainLen = lines.reduce((a, l) => a + l.reduce((b, x) => b + x.text.length, 0), 0) + lines.length - 1;
        item.outputLines = plainLen > item.output.length ? dropFront(lines, plainLen - item.output.length) : lines;
      }
    } else if (d.type === "read") {
      if (!item.output) delete item.outputLines;
      else item.outputLines = item.status === "error" ? plainLines(item.output) : readLines(item.output, d.path);
    } else if (d.type === "edit") {
      if (!d.diff) {
        delete d.diffLines;
        delete d.added;
        delete d.removed;
      } else {
        const r = diffLines(d.diff, d.path);
        d.diffLines = r.lines;
        d.added = r.added;
        d.removed = r.removed;
      }
    }
  }
}
