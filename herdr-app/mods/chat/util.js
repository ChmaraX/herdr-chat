// Small shared pieces: icons, colors, spans, text helpers.

import { div, image, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { settings } from "herdr";

export const MOD = "chat"; // the folder: mods/chat (also the pane title)
export const icon = (name, size = 14) => svg(`mods/${MOD}/icons/${name}.svg`).size(size).flex_none();
// Herdr's own spinner (workspace-chrome/spinner.svg, spin(900)). On its own the
// native spin repaints at ~8 fps (a 50° jump every ~120 ms: the "laggy" look); a
// near-invisible native opacity loop on it (~30 fps) makes the window repaint
// often enough for ~25 fps (23° steps). Measured: ~2.5 % app CPU while one shows.
export const spinner = (size = 12, color) => {
  const s = svg(`mods/${MOD}/icons/spinner.svg`).size(size).flex_none().spin(900).loop("opacity", { from: 0.97, to: 1, period: 1000 });
  return color ? s.text_color(color) : s;
};
// An agent's mark: Herdr's program icons (copied into icons/providers/).
// Pi's is one color (tinted like text); the others keep their colors.
const FULL_COLOR = new Set(["claude", "codex"]);
// The agents a chat can run (host/providers/index.ts has the same ids): name and icon.
export const PROVIDER_NAMES = { pi: "Pi", claude: "Claude Code", codex: "Codex" }; // until the host says (state.providerName)
export const PROVIDERS = Object.keys(PROVIDER_NAMES);
// A chat opened with no agent named (a layout block `{mod: "chat"}`) and no registry entry.
export const DEFAULT_PROVIDER = "pi";
export function providerIcon(provider, size = 14) {
  if (!PROVIDERS.includes(provider)) return icon("terminal", size).flex_none();
  const path = `mods/${MOD}/icons/providers/${provider}.svg`;
  return (FULL_COLOR.has(provider) ? image(path) : svg(path)).size(size).flex_none();
}

export function monoFont() {
  const s = settings() ?? {};
  return s.font_family ?? s.font ?? "JetBrains Mono";
}

// "#rrggbb" + alpha (0..1) → "#rrggbbaa".
// A color that already has an alpha keeps it, scaled.
export function alpha(color, a) {
  if (typeof color !== "string" || !/^#[0-9a-fA-F]{6}/.test(color)) return color;
  const base = color.length >= 9 ? parseInt(color.slice(7, 9), 16) / 255 : 1;
  return color.slice(0, 7) + Math.round(Math.max(0, Math.min(1, a * base)) * 255).toString(16).padStart(2, "0");
}

// Syntax tokens (`syn:<token>` span colors from the host) → theme colors
// (visual-v2.md §3). Comments are also italic.
const SYN = {
  keyword: "ansi5", string: "ansi2", regexp: "ansi2", number: "ansi3", literal: "ansi3", symbol: "ansi3", bullet: "ansi3",
  function: "ansi4", title: "ansi4", section: "ansi4", link: "ansi4", type: "ansi6", class: "ansi6", built_in: "ansi6",
  comment: "dim", variable: "foreground", attr: "foreground", property: "foreground", params: "foreground",
  meta: "ansi1", tag: "ansi1", punctuation: "muted", operator: "muted", addition: "ansi2", deletion: "ansi1",
  emphasis: "foreground", strong: "foreground",
};

// A protocol color ("ansi0".."ansi15", "syn:<token>" or "#rrggbb") as a theme color.
export function spanColor(c, t) {
  if (!c) return null;
  if (/^ansi\d+$/.test(c)) return t[c] ?? null;
  if (c.startsWith("syn:")) return t[SYN[c.slice(4)] ?? "foreground"] ?? null;
  return c;
}

function span(s, t, base) {
  let el = div().flex_none().child(s.text ?? "");
  const fg = spanColor(s.fg, t);
  const bg = spanColor(s.bg, t);
  if (fg) el = el.text_color(fg);
  else if (base) el = el.text_color(base);
  if (bg) el = el.bg(bg);
  if (s.bold || s.fg === "syn:strong" || s.fg === "syn:section") el = el.font_semibold();
  if (s.dim) el = el.opacity(0.6);
  if (s.italic || s.fg === "syn:comment" || s.fg === "syn:emphasis") el = el.italic();
  if (s.underline || s.fg === "syn:link") el = el.text_decoration_1();
  return el;
}

// Span[] → one row of styled text (wraps between spans).
export function spans(list, t, base) {
  return h_flex().flex_wrap().min_w(0).children((list ?? []).map((s) => span(s, t, base)));
}

// Adjacent spans that draw the same (same color and style, or blank) as one
// text run: fewer elements to lay out every frame.
function look(s, t, base) {
  return `${spanColor(s.fg, t) ?? base}|${s.bg ?? ""}|${s.bold || s.fg === "syn:strong" || s.fg === "syn:section" ? 1 : 0}|${s.dim ? 1 : 0}|${s.italic || s.fg === "syn:comment" || s.fg === "syn:emphasis" ? 1 : 0}|${s.underline || s.fg === "syn:link" ? 1 : 0}`;
}

export function mergeSpans(list, t, base) {
  const out = [];
  let lastLook = null;
  for (const s of list) {
    const text = s.text ?? "";
    if (!text) continue;
    const blank = !s.bg && !s.underline && /^\s+$/.test(text);
    const l = blank ? lastLook : look(s, t, base);
    if (out.length && (blank || l === lastLook)) out[out.length - 1] = { ...out[out.length - 1], text: out[out.length - 1].text + text };
    else { out.push(blank ? { text } : s); lastLook = l; }
  }
  return out;
}

// Span[] → one line of code: no wrapping, whitespace kept, never empty.
export function codeLine(list, t, base) {
  const m = list?.length ? mergeSpans(list, t, base) : [];
  if (!m.length) return div().h_full().child(" ");
  if (m.length === 1 && !m[0].fg && !m[0].bg) return div().flex_none().whitespace_nowrap().text_color(base).child(m[0].text);
  return h_flex().flex_none().whitespace_nowrap().children(m.map((s) => span(s, t, base)));
}

export const spansText = (list) => (list ?? []).map((s) => s.text ?? "").join("");

export function duration(ms) {
  if (ms == null) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
  const m = Math.floor(ms / 60000);
  return `${m}m${Math.round((ms % 60000) / 1000)}s`;
}

// 1234 → "1.2k", 1234567 → "1.2M".
export function count(n) {
  if (n == null) return "";
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
  return `${(n / 1e6).toFixed(1)}M`;
}

export function money(c) {
  if (c == null) return "";
  return c < 0.995 ? `$${c.toFixed(2)}` : `$${c.toFixed(c < 100 ? 2 : 0)}`;
}

// "2m" under an hour, "14:32" today, else "3 Nov 14:32".
export function relTime(ts, now = Date.now()) {
  if (!ts) return "";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return "now";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  const d = new Date(ts);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const n = new Date(now);
  if (d.toDateString() === n.toDateString()) return hm;
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${hm}`;
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function absTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;

// A path under the app home, relative to it (what image() takes), else null.
export function homeRel(p, appHomeDir) {
  const home = appHomeDir.replace(/\/$/, "") + "/";
  return p?.startsWith(home) ? p.slice(home.length) : null;
}

export function shortPath(p, cwd) {
  if (!p) return "";
  if (cwd && p.startsWith(cwd + "/")) return p.slice(cwd.length + 1);
  return p;
}

// `<hc from="t7 name">text</hc>` → {from, text} (hc send's envelope).
export function unwrapHc(text) {
  const m = /^\s*<hc from="([^"]*)"[^>]*>([\s\S]*?)<\/hc>\s*$/.exec(text ?? "");
  return m ? { from: m[1], text: m[2] } : { from: null, text: text ?? "" };
}

// A user message as the person would type it again: a skill's `/command`, then the text.
export function typedText(it, text = it?.text ?? "") {
  const s = it?.skill;
  return s ? `/${s.command}${text ? ` ${text}` : ""}` : text;
}

export function message(e) {
  return String(e?.message ?? e ?? "error");
}

// A one-line label button.
export function pill(id, label, t, { onClick, active = false, title } = {}) {
  let el = h_flex().id(id).h(22).px(8).gap(5).items_center().rounded(6).text_size(12)
    .text_color(active ? t.foreground : t.muted).cursor_pointer()
    .hover((s) => s.bg(t.hover).text_color(t.foreground));
  if (active) el = el.bg(t.raised);
  if (onClick) el = el.on_click(onClick);
  if (title) el = el.tooltip(title);
  return el.child(label);
}
