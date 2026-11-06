// SGR escapes → styled spans; every other escape sequence and control char is dropped.

export type Span = {
  text: string;
  fg?: string;
  bg?: string;
  bold?: true;
  dim?: true;
  italic?: true;
  underline?: true;
};

type Pen = { fg?: string; bg?: string; bold?: boolean; dim?: boolean; italic?: boolean; underline?: boolean; inverse?: boolean };

const ESC = "\u001b";

function cubeColor(n: number): string {
  if (n < 16) return `ansi${n}`;
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return hex(v, v, v);
  }
  const i = n - 16;
  const steps = [0, 95, 135, 175, 215, 255];
  return hex(steps[Math.floor(i / 36)]!, steps[Math.floor(i / 6) % 6]!, steps[i % 6]!);
}

function hex(r: number, g: number, b: number): string {
  const h = (v: number) => Math.max(0, Math.min(255, v | 0)).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

function applySgr(pen: Pen, params: number[]): void {
  if (params.length === 0) params = [0];
  for (let i = 0; i < params.length; i++) {
    const p = params[i]!;
    if (p === 0) {
      for (const k of Object.keys(pen)) delete (pen as Record<string, unknown>)[k];
    } else if (p === 1) pen.bold = true;
    else if (p === 2) pen.dim = true;
    else if (p === 3) pen.italic = true;
    else if (p === 4) pen.underline = true;
    else if (p === 7) pen.inverse = true;
    else if (p === 21 || p === 22) {
      pen.bold = false;
      pen.dim = false;
    } else if (p === 23) pen.italic = false;
    else if (p === 24) pen.underline = false;
    else if (p === 27) pen.inverse = false;
    else if (p >= 30 && p <= 37) pen.fg = `ansi${p - 30}`;
    else if (p >= 90 && p <= 97) pen.fg = `ansi${p - 90 + 8}`;
    else if (p === 39) delete pen.fg;
    else if (p >= 40 && p <= 47) pen.bg = `ansi${p - 40}`;
    else if (p >= 100 && p <= 107) pen.bg = `ansi${p - 100 + 8}`;
    else if (p === 49) delete pen.bg;
    else if (p === 38 || p === 48) {
      const mode = params[i + 1];
      let color: string | undefined;
      if (mode === 5) {
        const n = params[i + 2];
        if (n !== undefined && n >= 0 && n <= 255) color = cubeColor(n);
        i += 2;
      } else if (mode === 2) {
        const [r, g, b] = [params[i + 2], params[i + 3], params[i + 4]];
        if (r !== undefined && g !== undefined && b !== undefined) color = hex(r, g, b);
        i += 4;
      } else {
        i = params.length;
      }
      if (color) {
        if (p === 38) pen.fg = color;
        else pen.bg = color;
      }
    }
  }
}

function spanOf(text: string, pen: Pen): Span {
  const s: Span = { text };
  const fg = pen.inverse ? pen.bg ?? "ansi0" : pen.fg;
  const bg = pen.inverse ? pen.fg ?? "ansi7" : pen.bg;
  if (fg) s.fg = fg;
  if (bg) s.bg = bg;
  if (pen.bold) s.bold = true;
  if (pen.dim) s.dim = true;
  if (pen.italic) s.italic = true;
  if (pen.underline) s.underline = true;
  return s;
}

function sameStyle(a: Span, b: Span): boolean {
  return a.fg === b.fg && a.bg === b.bg && a.bold === b.bold && a.dim === b.dim && a.italic === b.italic && a.underline === b.underline;
}

/**
 * Parses one string (newlines kept as text) into spans. CSI sequences other
 * than SGR, OSC strings (BEL or ST terminated), other ESC sequences and C0
 * controls except \n and \t are removed.
 */
export function toSpans(input: string): Span[] {
  const spans: Span[] = [];
  const pen: Pen = {};
  let text = "";
  const flush = () => {
    if (!text) return;
    const s = spanOf(text, pen);
    const last = spans[spans.length - 1];
    if (last && sameStyle(last, s)) last.text += text;
    else spans.push(s);
    text = "";
  };
  let i = 0;
  const n = input.length;
  while (i < n) {
    const ch = input[i]!;
    const code = ch.charCodeAt(0);
    if (ch === ESC || code === 0x9b) {
      const next = code === 0x9b ? "[" : input[i + 1];
      const start = code === 0x9b ? i + 1 : i + 2;
      if (next === "[") {
        // CSI: params 0x30–0x3f, intermediates 0x20–0x2f, final 0x40–0x7e.
        let j = start;
        while (j < n && input.charCodeAt(j) >= 0x30 && input.charCodeAt(j) <= 0x3f) j++;
        while (j < n && input.charCodeAt(j) >= 0x20 && input.charCodeAt(j) <= 0x2f) j++;
        if (j >= n) break; // unfinished
        const final = input[j];
        if (final === "m") {
          const raw = input.slice(start, j);
          if (/^[0-9;:]*$/.test(raw)) {
            flush();
            applySgr(pen, raw === "" ? [] : raw.split(/[;:]/).map((x) => (x === "" ? 0 : Number(x))));
          }
        }
        i = j + 1;
        continue;
      }
      if (next === "]" || next === "P" || next === "_" || next === "^" || next === "X") {
        // OSC / DCS / APC / PM / SOS: up to BEL or ESC \.
        let j = start;
        while (j < n && input[j] !== "\u0007" && !(input[j] === ESC && input[j + 1] === "\\")) j++;
        i = j >= n ? n : input[j] === "\u0007" ? j + 1 : j + 2;
        continue;
      }
      // Two-char escapes (ESC c, ESC 7, ESC ( B …).
      if (next === "(" || next === ")" || next === "#" || next === "%") i += 3;
      else i += next === undefined ? 1 : 2;
      continue;
    }
    if ((code < 0x20 && ch !== "\n" && ch !== "\t") || code === 0x7f) {
      if (ch === "\r") {
        // A lone CR rewrites the line in a terminal; keep it simple and drop it.
      }
      i++;
      continue;
    }
    text += ch;
    i++;
  }
  flush();
  return spans;
}

export function stripAnsi(input: string): string {
  return toSpans(input).map((s) => s.text).join("");
}

/** Lines of spans for a widget: each input line becomes one span array. */
export function toSpanLines(lines: string[]): Span[][] {
  return lines.map((l) => toSpans(l.replace(/\n/g, " ")));
}
