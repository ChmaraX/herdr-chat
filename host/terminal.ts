// The host's own terminal: OSC 7501 status, `hc send` input (bracketed paste
// on stdin), and an append-only plain transcript for `hc read`.
import type { Readable, Writable } from "node:stream";
import type { Item } from "./timeline.ts";
import { typedText } from "./skill.ts";

export type TermState = "working" | "blocked" | "done" | "error" | "idle";

/** OSC 0 (window/tab title); control characters become spaces. */
export function osc0(title: string): string {
  return `\u001b]0;${title.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")}\u0007`;
}

export function osc7501(state: TermState, app: string, msg?: string): string {
  const m = msg ? `:msg=${Buffer.from(msg.split("\n")[0]!.slice(0, 200), "utf8").toString("base64")}` : "";
  return `\u001b]7501;state=${state}:app=${app}${m}\u001b\\`;
}

/** `<hc from="t7 review" reach="…">body</hc>` → {text: body, from}. */
export function parseHcEnvelope(text: string): { text: string; from?: string } {
  const m = /^\s*<hc\b([^>]*)>([\s\S]*?)<\/hc>\s*$/.exec(text);
  if (!m) return { text };
  const from = /\bfrom="([^"]*)"/.exec(m[1]!)?.[1];
  return { text: m[2]!.trim(), ...(from ? { from } : {}) };
}

/**
 * Raw-mode input parser: bracketed paste, Enter submits, a lone ESC or Ctrl-C
 * aborts, Backspace edits. Other escape sequences are ignored.
 */
export class InputParser {
  private buf = "";
  private pending = "";
  private inPaste = false;
  private escTimer: NodeJS.Timeout | null = null;
  onSubmit: (text: string) => void = () => {};
  onAbort: () => void = () => {};

  feed(chunk: string): void {
    if (this.escTimer) {
      clearTimeout(this.escTimer);
      this.escTimer = null;
    }
    let s = this.pending + chunk;
    this.pending = "";
    let i = 0;
    while (i < s.length) {
      if (this.inPaste) {
        const end = s.indexOf("\u001b[201~", i);
        if (end < 0) {
          // Keep a possible partial end marker for the next chunk.
          const tail = s.slice(i);
          const keep = partialSuffix(tail, "\u001b[201~");
          this.buf += tail.slice(0, tail.length - keep).replace(/\r\n?/g, "\n");
          this.pending = tail.slice(tail.length - keep);
          return;
        }
        this.buf += s.slice(i, end).replace(/\r\n?/g, "\n");
        this.inPaste = false;
        i = end + 6;
        continue;
      }
      const ch = s[i]!;
      if (ch === "\u001b") {
        const rest = s.slice(i);
        if (rest.length === 1) {
          // A lone ESC, unless more bytes follow very soon.
          this.pending = "\u001b";
          this.escTimer = setTimeout(() => {
            this.pending = "";
            this.escTimer = null;
            this.onAbort();
          }, 40);
          return;
        }
        if (rest.startsWith("\u001b[200~")) {
          this.inPaste = true;
          i += 6;
          continue;
        }
        if (rest[1] === "[" || rest[1] === "O") {
          let j = i + 2;
          while (j < s.length && !/[@-~]/.test(s[j]!)) j++;
          if (j >= s.length) {
            this.pending = rest;
            return;
          }
          i = j + 1;
          continue;
        }
        if (rest[1] === "\u001b") {
          // ESC ESC is one abort: the second ESC is consumed unless it starts a sequence.
          this.onAbort();
          i += rest[2] === "[" || rest[2] === "O" ? 1 : 2;
          continue;
        }
        i += 2; // Alt+key
        continue;
      }
      if (ch === "\r" || ch === "\n") {
        const text = this.buf;
        this.buf = "";
        if (text.trim()) this.onSubmit(text);
        i++;
        if (ch === "\r" && s[i] === "\n") i++;
        continue;
      }
      if (ch === "\u0003") {
        this.buf = "";
        this.onAbort();
        i++;
        continue;
      }
      if (ch === "\u007f" || ch === "\b") {
        this.buf = [...this.buf].slice(0, -1).join("");
        i++;
        continue;
      }
      if (ch === "\u0015") {
        this.buf = "";
        i++;
        continue;
      }
      if (ch < " " && ch !== "\t") {
        i++;
        continue;
      }
      this.buf += ch;
      i++;
    }
  }
}

function partialSuffix(s: string, marker: string): number {
  for (let k = Math.min(marker.length - 1, s.length); k > 0; k--) {
    if (s.endsWith(marker.slice(0, k))) return k;
  }
  return 0;
}

export class Terminal {
  private out: Writable;
  private input: Readable | null;
  private lastStatus = "";
  private lastTitle = "";
  private printed = new Map<string, string>();
  private parser = new InputParser();
  private isTty: boolean;
  /** The provider, reported as `app=` in OSC 7501 so Herdr shows its icon. */
  private app: string;
  onSubmit: (text: string, from?: string) => void = () => {};
  onAbort: () => void = () => {};

  constructor(out: Writable, input: Readable | null, app: string) {
    this.out = out;
    this.app = app;
    this.input = input;
    this.isTty = !!(input as NodeJS.ReadStream | null)?.isTTY;
    this.parser.onSubmit = (raw) => {
      const { text, from } = parseHcEnvelope(raw);
      if (text.trim()) this.onSubmit(text, from);
    };
    this.parser.onAbort = () => this.onAbort();
  }

  start(): void {
    const input = this.input;
    if (!input) return;
    if (this.isTty) {
      (input as NodeJS.ReadStream).setRawMode?.(true);
      this.out.write("\u001b[?2004h");
    }
    input.setEncoding("utf8");
    input.on("data", (d: string) => this.parser.feed(d));
    input.on("error", () => {});
    input.resume();
  }

  close(): void {
    if (this.isTty) {
      this.out.write("\u001b[?2004l");
      try {
        (this.input as NodeJS.ReadStream).setRawMode?.(false);
      } catch {}
    }
    this.input?.pause();
  }

  status(state: TermState, msg?: string): void {
    const s = osc7501(state, this.app, msg);
    if (s === this.lastStatus) return;
    this.lastStatus = s;
    this.out.write(s);
  }

  title(title: string): void {
    if (title === this.lastTitle) return;
    this.lastTitle = title;
    this.out.write(osc0(title));
  }

  line(text: string): void {
    this.out.write(text.replace(/\r?\n/g, "\r\n") + "\r\n");
  }

  /** Prints each item once it's final (and again if a final notice's text changes). */
  observe(items: Item[]): void {
    for (const it of items) {
      const own = this.render(it);
      if (own === null) continue;
      // A subagent's items (nested under its card) are indented.
      const line = it.parent ? own.replace(/^/gm, "  ") : own;
      if (this.printed.get(it.id) === line) continue;
      this.printed.set(it.id, line);
      this.line(line);
    }
  }

  reset(): void {
    this.printed.clear();
    this.line("── new timeline ──");
  }

  private render(it: Item): string | null {
    switch (it.kind) {
      case "user": {
        const from = it.from ? `[${it.from}] ` : "";
        const img = it.images ? ` [${it.images} image${it.images > 1 ? "s" : ""}]` : "";
        const text = typedText(it.text, it.skill);
        return "> " + from + text.split("\n").join("\n  ") + img;
      }
      case "assistant":
        if (it.streaming) return null;
        if (it.stopReason === "aborted") return it.text ? `${it.text}\n· (aborted)` : "· (aborted)";
        if (!it.text && !it.error) return null;
        return (it.text ? it.text : "") + (it.error ? `${it.text ? "\n" : ""}! ${it.error}` : "");
      case "thinking":
        return null;
      case "tool":
        if (it.status === "pending" || it.status === "running") return null;
        return `· ${it.title} ${it.status === "done" ? "✓" : "✗"}`;
      case "notice":
        return `${it.level === "info" ? "·" : "!"} ${it.text}`;
      case "custom":
        return `· [${it.customType}] ${it.text.split("\n")[0]}`;
      case "plan":
        return null;
    }
  }
}
