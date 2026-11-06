// Mermaid → a self-contained SVG that a native (resvg-style) renderer can draw:
// no CSS variables, no color-mix(), no web fonts, no foreignObject. Falls back
// to beautiful-mermaid's box-drawing ASCII art.
import { renderMermaidSVG, renderMermaidASCII } from "beautiful-mermaid";
import { toSpans } from "./ansi.ts";
import type { Span } from "./ansi.ts";

export type Theme = {
  background: string; foreground: string; muted: string; border: string; accent: string;
  dark: boolean;
} & Record<`ansi${number}`, string>;

/** Used until the client sends `set_theme`. */
export const DEFAULT_THEME: Theme = {
  background: "#1e1f22", foreground: "#d4d4d8", muted: "#8b8d94", border: "#3f4147", accent: "#7aa2f7", dark: true,
  ansi0: "#1e1f22", ansi1: "#f7768e", ansi2: "#9ece6a", ansi3: "#e0af68", ansi4: "#7aa2f7", ansi5: "#bb9af7", ansi6: "#7dcfff", ansi7: "#c0caf5",
  ansi8: "#565f89", ansi9: "#f7768e", ansi10: "#9ece6a", ansi11: "#e0af68", ansi12: "#7aa2f7", ansi13: "#bb9af7", ansi14: "#7dcfff", ansi15: "#ffffff",
};

const MAX_SOURCE = 32 * 1024;

function parseHex(c: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim());
  if (!m) return null;
  const h = m[1]!.length === 3 ? [...m[1]!].map((x) => x + x).join("") : m[1]!;
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

function toHex(rgb: number[]): string {
  return "#" + rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
}

/** `color-mix(in srgb, A p%, B)` with hex colors. */
function mix(a: string, p: number, b: string): string {
  const x = parseHex(a);
  const y = parseHex(b);
  if (!x || !y) return a;
  return toHex(x.map((v, i) => v * p + y[i]! * (1 - p)));
}

/** The index of the `)` matching the `(` at `open`. */
function closeParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

/** Splits on top-level commas. */
function args(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const c of s) {
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

/** Resolves var() and color-mix() in a CSS value. */
function resolve(value: string, vars: Map<string, string>, depth = 0): string {
  if (depth > 20) return value;
  let s = value;
  for (;;) {
    const i = s.search(/\b(var|color-mix)\(/);
    if (i < 0) return s;
    const fn = s.startsWith("var(", i) ? "var" : "color-mix";
    const open = i + fn.length;
    const close = closeParen(s, open);
    if (close < 0) return s;
    const inner = s.slice(open + 1, close);
    let rep: string;
    if (fn === "var") {
      const [name, ...fb] = args(inner);
      const v = vars.get(name!);
      rep = v !== undefined ? resolve(v, vars, depth + 1) : fb.length ? resolve(fb.join(","), vars, depth + 1) : "none";
    } else {
      // color-mix(in srgb, A p%, B [q%])
      const [, a = "", b = ""] = args(inner).map((x) => resolve(x, vars, depth + 1));
      const pa = /^(.*?)\s+([\d.]+)%$/.exec(a);
      const colA = pa ? pa[1]!.trim() : a;
      const p = pa ? Number(pa[2]) / 100 : 0.5;
      const colB = b.replace(/\s+[\d.]+%$/, "").trim();
      rep = mix(colA, p, colB);
    }
    s = s.slice(0, i) + rep + s.slice(close + 1);
  }
}

/** Makes beautiful-mermaid's SVG drawable without a browser. */
export function flattenSvg(svg: string, bg: string): string {
  const vars = new Map<string, string>();
  const collect = (decls: string) => {
    for (const d of decls.split(";")) {
      const m = /^\s*(--[\w-]+)\s*:\s*([\s\S]+?)\s*$/.exec(d);
      if (m) vars.set(m[1]!, m[2]!);
    }
  };
  const root = /<svg\b[^>]*>/.exec(svg);
  if (!root) throw new Error("no <svg> element");
  const rootStyle = / style="([^"]*)"/.exec(root[0])?.[1] ?? "";
  collect(rootStyle);
  for (const m of svg.matchAll(/<style>([\s\S]*?)<\/style>/g)) {
    for (const r of m[1]!.matchAll(/(?:^|\})\s*svg\s*\{([^}]*)\}/g)) collect(r[1]!.replace(/\/\*[\s\S]*?\*\//g, ""));
  }
  // Root: no CSS variables or CSS background; a generic font family, inherited by every <text>.
  const newRoot = root[0].replace(/ style="[^"]*"/, "").replace(/<svg\b/, '<svg font-family="sans-serif"');
  let out = svg.slice(0, root.index) + newRoot + svg.slice(root.index + root[0].length);
  // Styles: plain rules only (resvg reads simple selectors): no @import, no custom-property blocks,
  // values resolved, generic font families.
  out = out.replace(/<style>([\s\S]*?)<\/style>/g, (_, css: string) => {
    const rules = css
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/@import\s+url\([^)]*\)\s*;?/g, "")
      .replace(/(^|\})\s*svg\s*\{[^}]*\}/g, "$1")
      .replace(/font-family:\s*([^;}]*)/g, (_m, v: string) => `font-family: ${/mono/i.test(v) ? "monospace" : "sans-serif"}`)
      .replace(/:\s*([^;{}]*\b(?:var|color-mix)\([^;{}]*)/g, (_m, v: string) => `: ${resolve(v, vars)}`);
    return `<style>${rules.replace(/\n\s*\n/g, "\n")}</style>`;
  });
  out = out.replace(/"([^"]*\b(?:var|color-mix)\([^"]*)"/g, (_, v: string) => `"${resolve(v, vars)}"`);
  out = out.replace(/font-family="[^"]*"/g, (m) => (/mono/i.test(m) ? 'font-family="monospace"' : 'font-family="sans-serif"'));
  const vb = /viewBox="([\d.\s-]+)"/.exec(newRoot)?.[1]?.trim().split(/\s+/).map(Number);
  if (vb && vb.length === 4) {
    const rect = `<rect x="${vb[0]}" y="${vb[1]}" width="${vb[2]}" height="${vb[3]}" fill="${bg}"/>`;
    out = out.replace(/(<\/style>)/, `$1\n${rect}`);
  }
  if (/\b(var|color-mix)\(|<foreignObject/i.test(out)) throw new Error("SVG still needs a browser (CSS variables or foreignObject)");
  return out;
}

export function svgColors(t: Theme) {
  return {
    bg: t.background,
    fg: t.foreground,
    line: mix(t.foreground, 0.5, t.background),
    accent: t.accent,
    muted: t.muted,
    surface: mix(t.foreground, t.dark ? 0.06 : 0.04, t.background),
    border: t.border,
  };
}

export type MermaidResult = { svg: string } | { ascii: Span[][]; error: string };

/** Renders a closed mermaid block: SVG, else ASCII art plus the error. */
export function renderMermaid(source: string, theme: Theme): MermaidResult {
  let error: string;
  try {
    if (source.length > MAX_SOURCE) throw new Error(`diagram too large (${Math.round(source.length / 1024)} KiB)`);
    const svg = renderMermaidSVG(source, { ...svgColors(theme), font: "sans-serif" });
    return { svg: flattenSvg(svg, theme.background) };
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  try {
    if (source.length > MAX_SOURCE) throw new Error(error);
    const art = renderMermaidASCII(source, { colorMode: "ansi16" });
    return { ascii: art.split("\n").map((l) => toSpans(l)), error };
  } catch {
    return { ascii: source.split("\n").map((l) => (l ? [{ text: l }] : [])), error };
  }
}
