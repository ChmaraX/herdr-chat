// Rich content (visual-v2.md §3): an assistant message's blocks (markdown,
// highlighted code cards, mermaid diagrams), diffs with a line-number
// gutter, highlighted file excerpts and ANSI-colored command output.
// The host splits and highlights (protocol.md v2 `Block`, `syn:` spans);
// without blocks a message is one markdown block, as in v1.

import { div, image } from "gpui-kit";
import { appHome } from "herdr";
import { v_flex, h_flex, TextView } from "gpui-base";
import { alpha, codeLine, homeRel, icon, plural, spinner } from "./util.js";
import { SPACE } from "./space.js";

export const CODE_CAP = 30; // lines shown before "Show all N lines"
const RENDER_MAX = 600; // lines ever built for one block (the rest: copy it)
export const LINE_H = 19;

export const prose = (id, text) => TextView.markdown(id, text).selectable(true);

// Markdown → the chunks drawn one TextView each, so the space between
// paragraphs, lists, tables and headings is ours (space.js), not the
// renderer's: a heading line alone; else split at blank lines, outside code
// fences, and not inside a list (a loose list stays one chunk, its item
// spacing the renderer's). Reference-style link definitions need the whole
// text: then one chunk.
const FENCE = /^\s*(`{3,}|~{3,})/;
const HEADING = /^ {0,3}#{1,6}(\s|$)/;
const LIST = /^ {0,3}([-*+]|\d{1,9}[.)])(\s|$)/;
const REFDEF = /^ {0,3}\[[^\]]+\]:\s/m;
export function mdChunks(text) {
  if (REFDEF.test(text)) return [{ text, heading: false }];
  const out = [];
  let cur = [], fence = null, blank = false;
  const push = () => { if (cur.length) out.push({ text: cur.join("\n"), heading: false }); cur = []; };
  for (const line of text.split("\n")) {
    if (fence) {
      cur.push(line);
      const f = FENCE.exec(line);
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !line.trim().slice(f[1].length).trim()) fence = null;
      continue;
    }
    if (!line.trim()) { blank = cur.length > 0; continue; }
    if (HEADING.test(line)) { push(); out.push({ text: line, heading: true }); blank = false; continue; }
    if (blank) {
      if (LIST.test(cur[0]) && (LIST.test(line) || /^\s/.test(line))) cur.push("");
      else push();
      blank = false;
    }
    const f = FENCE.exec(line);
    if (f) fence = f[1];
    cur.push(line);
  }
  push();
  return out.length ? out : [{ text: " ", heading: false }];
}

// The space above a piece of an answer, after `prev` (null: the first).
const above = (heading, prev) => (prev == null ? 0 : heading ? SPACE.headingAbove : prev.heading ? SPACE.headingBelow : SPACE.block);

// Markdown as its chunks, spaced (one TextView when it's one chunk).
export function markdown(id, text) {
  const parts = mdChunks(text || " ");
  if (parts.length === 1) return prose(id, parts[0].text);
  return v_flex().min_w(0).children(parts.map((p, j) => div().pt(above(p.heading, parts[j - 1])).child(prose(`${id}-${j}`, p.text))));
}

// Whether a block starts or ends with a heading (for the space around it).
function edges(b) {
  if (b.type !== "markdown") return { first: false, last: false };
  const lines = (b.text ?? "").split("\n").filter((l) => l.trim());
  return { first: HEADING.test(lines[0] ?? ""), last: HEADING.test(lines[lines.length - 1] ?? "") };
}

// An assistant message's body.
export function blocks(it, c) {
  const list = it.blocks?.length ? it.blocks : [{ type: "markdown", text: it.text ?? "" }];
  let prev = null;
  return v_flex().min_w(0).children(list.map((b, i) => {
    const key = `${it.id}:${i}`;
    const e = edges(b);
    const gap = above(e.first, prev && { heading: prev.last });
    prev = e;
    let el;
    if (b.type === "code") el = (!b.open && c.codeView?.(key)) || codeCard(key, b.lang, b.code ?? "", b.lines, b.open, c);
    else if (b.type === "mermaid") el = mermaid(key, b, c);
    else el = c.codeView?.(key) || markdown(`md-${it.id}-${i}`, b.text);
    return div().pt(gap).child(el);
  }));
}

function plainLines(code) {
  return code.replace(/\n$/, "").split("\n").map((l) => [{ text: l }]);
}

// A copy button that shows ✓ for 1.5 s after copying.
export function copyButton(id, text, c, { size = 12, label = null } = {}) {
  const t = c.t;
  const done = c.copied(id);
  return h_flex().id(`copy-${id}`).h(22).px(6).gap(5).items_center().rounded(6).cursor_pointer()
    .text_size(11.5).text_color(done ? t.ansi2 : t.dim).hover((s) => s.bg(t.hover).text_color(done ? t.ansi2 : t.foreground))
    .tooltip(done ? "Copied" : "Copy").on_click((_e, cx) => c.copy(id, text, cx))
    .child(icon(done ? "check" : "copy", size)).when(Boolean(label), (e) => e.child(done ? "Copied" : label));
}

// A code card: language and copy on top, highlighted monospace lines below,
// capped at CODE_CAP lines until "Show all N lines".
export function codeCard(key, lang, code, lines, open, c) {
  const t = c.t;
  // Streaming (open fence): plain lines, one text run each, far cheaper to
  // rebuild every flush; highlighting arrives when the fence closes.
  const all = lines?.length && !open ? lines : plainLines(code);
  const n = all.length;
  const full = c.expanded.has(`code:${key}`);
  const shown = full ? all.slice(0, RENDER_MAX) : all.slice(0, CODE_CAP);
  const more = n - shown.length;
  const head = h_flex().h(30).pl(12).pr(6).gap(8).items_center().border_b_1().border_color(c.line)
    .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(lang || "text"))
    .when(Boolean(open), (e) => e.child(spinner(11, t.dim)))
    .child(copyButton(`code:${key}`, code, c));
  const rendered = shown.map((l) => codeLine(l, t, t.foreground));
  // A finished block (codeview.js) scrolls sideways and selects; a streaming one is clipped.
  const body = (c.codeBody ? c.codeBody(rendered, code.replace(/\n$/, "").split("\n").slice(0, shown.length))
    : v_flex().px(12).py(8).overflow_hidden().children(rendered))
    .font_family(c.mono).text_size(12.5).line_height(`${LINE_H}px`).text_color(t.foreground);
  const foot = more > 0 || (full && n > CODE_CAP)
    ? h_flex().id(`code-more-${key}`).h(28).px(12).items_center().gap(6).border_t_1().border_color(c.line).cursor_pointer()
      .text_size(11.5).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => c.toggle(`code:${key}`, cx))
      .child(icon(full ? "chevron-up" : "chevron-down", 12))
      .child(full ? (more > 0 ? `Showing ${shown.length} of ${n} lines · copy for the rest` : "Show less") : `Show all ${n} lines`)
    : null;
  return v_flex().w_full().rounded(10).overflow_hidden().border_1().border_color(t.border).bg(c.codeBg)
    .child(head).child(body).children(foot ? [foot] : []);
}

// A mermaid block: the host's SVG (click to enlarge, "Show source"), its
// ASCII fallback, or the source while the fence streams.
function mermaid(key, b, c) {
  const t = c.t;
  if (b.open || (!b.svg && !b.ascii?.length)) return codeCard(key, "mermaid", b.source ?? "", null, b.open, c);
  const src = c.expanded.has(`src:${key}`);
  const rel = b.svg ? homeRel(b.svg, appHome()) : null;
  const size = rel ? c.svgSize(b.svg) : null;
  const head = h_flex().h(30).pl(12).pr(6).gap(4).items_center().border_b_1().border_color(c.line)
    .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(b.error && !rel ? "mermaid · shown as text" : "mermaid"))
    .child(h_flex().id(`src-${key}`).h(22).px(6).gap(5).items_center().rounded(6).cursor_pointer().text_size(11.5).text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => c.toggle(`src:${key}`, cx))
      .child(icon("code", 12)).child(src ? "Hide source" : "Show source"))
    .when(Boolean(rel), (e) => e.child(h_flex().id(`zoom-${key}`).h(22).px(6).items_center().rounded(6).cursor_pointer().text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Enlarge").on_click((_e, cx) => c.enlarge(b.svg, size, cx))
      .child(icon("maximize", 12))))
    .child(copyButton(`code:${key}`, b.source ?? "", c));
  let body;
  if (rel) {
    // Fit the column: the SVG's own aspect ratio once known (else a guess).
    const w = Math.min(c.colW - 26, size?.w ?? 600);
    const h = size ? Math.round((w * size.h) / size.w) : 260;
    // On hover a ⤢ at the top right says a click opens the zoomable viewer (the click is the body's).
    body = div().id(`svg-${key}`).relative().p(12).flex().justify_center().cursor_pointer().on_click((_e, cx) => c.enlarge(b.svg, size, cx))
      .on_hover((on, cx) => c.setSvgHover(key, on, cx))
      .child(image(rel).w(w).h(Math.min(h, 640)))
      .when(c.svgHover === key, (e) => e.child(div().absolute().top(8).right(8).w(26).h(26).flex().items_center().justify_center()
        .rounded(6).bg(alpha(t.popover, 0.92)).border_1().border_color(t.input).text_size(14).text_color(t.foreground).child("⤢")));
  } else {
    body = v_flex().id(`ascii-${key}`).px(12).py(8).overflow_hidden().font_family(c.mono).text_size(12.5).line_height(`${LINE_H}px`)
      .children(b.ascii.map((l) => codeLine(l, t, t.foreground)));
  }
  return v_flex().w_full().rounded(10).overflow_hidden().border_1().border_color(t.border).bg(c.codeBg)
    .child(head).child(body)
    .when(src, (e) => e.child(div().border_t_1().border_color(c.line).child(codeCard(`${key}:src`, "mermaid", b.source ?? "", null, false, c))));
}

// Styled lines (tool output, file excerpts) in a mono box, with an optional
// line-number gutter starting at `first`.
export function outputBox(key, lines, c, { first = null, cap = 400, color } = {}) {
  const t = c.t;
  if (lines.length > 1 && !lines[lines.length - 1]?.some?.((x) => x.text)) lines = lines.slice(0, -1);
  const n = lines.length;
  const from = Math.max(0, n - cap);
  const shown = lines.slice(from);
  const gutterW = first != null ? Math.max(2, String(first + n).length) * 7.6 + 14 : 0;
  const rows = shown.map((l, i) => {
    const line = codeLine(l, t, color ?? t.muted);
    if (first == null) return line;
    return h_flex().flex_none().child(div().flex_none().w(gutterW).pr(10).text_color(t.dim).opacity(0.7).flex().justify_end().child(String(first + from + i)))
      .child(line);
  });
  return v_flex().id(`out-${key}`).w_full().overflow_x_scroll().font_family(c.mono).text_size(12).line_height(`${LINE_H - 1}px`)
    .when(from > 0, (e) => e.child(div().text_size(11).text_color(t.dim).child(`… ${plural(from, "earlier line")}`)))
    .children(rows);
}

// diffLines (protocol v2): gutter with old/new numbers, +/− tints, highlighted spans.
export function diffView(key, lines, c, { cap = 600 } = {}) {
  const t = c.t;
  const shown = lines.filter((l) => l.kind !== "meta").slice(0, cap); // the card's title names the file
  const maxN = Math.max(...shown.map((l) => Math.max(l.old ?? 0, l.new ?? 0)), 9);
  const nw = String(maxN).length * 7.4 + 8;
  const rows = shown.map((l) => {
    if (l.kind === "hunk" || l.kind === "meta") {
      return h_flex().flex_none().h(LINE_H + 3).items_center().px(8).bg(alpha(t.ansi4, 0.07)).text_color(t.dim)
        .child(codeLine(l.spans, t, t.dim));
    }
    const add = l.kind === "add", del = l.kind === "del";
    const tint = add ? alpha(t.ansi2, 0.13) : del ? alpha(t.ansi1, 0.13) : null;
    let row = h_flex().flex_none().min_w_full()
      .child(div().flex_none().w(nw).pr(6).flex().justify_end().text_color(t.dim).opacity(0.75).child(l.old != null && !add ? String(l.old) : ""))
      .child(div().flex_none().w(nw).pr(6).flex().justify_end().text_color(t.dim).opacity(0.75).child(l.new != null && !del ? String(l.new) : ""))
      .child(div().flex_none().w(16).text_color(add ? t.ansi2 : del ? t.ansi1 : t.dim).child(add ? "+" : del ? "−" : " "))
      .child(codeLine(l.spans, t, t.foreground));
    if (tint) row = row.bg(tint);
    return row;
  });
  return v_flex().id(`diff-${key}`).w_full().rounded(6).overflow_hidden().overflow_x_scroll().bg(c.codeBg).py(4)
    .font_family(c.mono).text_size(12).line_height(`${LINE_H}px`)
    .children(rows)
    .when(lines.length > cap, (e) => e.child(div().px(8).text_size(11).text_color(t.dim).child(`… ${plural(lines.length - cap, "more line")}`)));
}

// A unified diff as text (v1 hosts): +/− tints only.
export function textDiff(key, text, c) {
  const lines = (text ?? "").replace(/\n$/, "").split("\n").slice(0, 600);
  let o = null, n = null;
  const dl = lines.map((l) => {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(l);
    if (m) { o = Number(m[1]); n = Number(m[2]); return { kind: "hunk", spans: [{ text: l }] }; }
    if (l.startsWith("+++") || l.startsWith("---")) return { kind: "meta", spans: [{ text: l }] };
    if (l.startsWith("+")) return { kind: "add", new: n != null ? n++ : null, spans: [{ text: l.slice(1) }] };
    if (l.startsWith("-")) return { kind: "del", old: o != null ? o++ : null, spans: [{ text: l.slice(1) }] };
    const r = { kind: "ctx", old: o != null ? o++ : null, new: n != null ? n++ : null, spans: [{ text: l.replace(/^ /, "") }] };
    return r;
  });
  return diffView(key, dl, c);
}
