// Timeline rows → elements: user bubbles, assistant prose and rich blocks,
// thinking, tool cards (bash, read, edit diff, write, search, generic),
// work groups, notices, the turn footer, the hover action row and the live
// activity line (visual-v2.md §2, §3, §5, §6).
//
// `c` is the render context from main.js: theme `t`, `mono`, sets/maps of
// UI state (`expanded`, `full`), the column width `colW`, and the actions
// (toggle, more, copy, copied, enlarge, svgSize, openFile, editResend,
// hover, setHover, svgHover, setSvgHover, groupOpen, modelName, now).

import { div, image } from "gpui-kit";
import { appHome } from "herdr";
import { v_flex, h_flex, TextView } from "gpui-base";
import { absTime, alpha, count, duration, homeRel, icon, money, plural, relTime, shortPath, spinner, typedText, unwrapHc } from "./util.js";
import { blocks, copyButton, diffView, outputBox, prose, textDiff } from "./rich.js";
import { groupSummary } from "./rows.js";
import { SPACE } from "./space.js";

const MAX_LINES = 400;

function mono(text, c, color, size = 12) {
  return div().font_family(c.mono).text_size(size).line_height("18px").text_color(color ?? c.t.muted).child(text);
}

const asLines = (text) => (text ?? "").replace(/\n$/, "").split("\n").map((l) => [{ text: l }]);

// A row of the timeline (rows.js) → its element, before the column wrapper.
// Rows carry no vertical padding of their own: `r.gap` (space.js) is the
// space above each one.
export function row(r, c) {
  return div().pt(r.gap ?? 0).child(rowBody(r, c));
}

function rowBody(r, c) {
  if (r.kind === "group") return group(r, c);
  if (r.kind === "footer") return actions(null, r.footer, c);
  if (r.kind === "activity") return activity(c);
  return item(r.item, c, r.footer, r.slot);
}

// `slot`: an answer that ends its turn keeps its actions and footer in a row
// under it (inside the turn gap); otherwise they show over its last line on hover.
export function item(it, c, footer, slot = true) {
  switch (it.kind) {
    case "user": return user(it, c);
    case "assistant": return assistant(it, c, footer, slot);
    case "thinking": return thinking(it, c);
    case "tool": return tool(it, c);
    case "notice": return notice(it, c);
    case "custom": return custom(it, c);
    case "plan": return plan(it, c);
    default: return div().text_color(c.t.dim).child(`(${it.kind})`);
  }
}

// Thumbnails of image files (rounded, ≤ 320 px wide); a click enlarges.
// image() takes app-home-relative paths: a file elsewhere is a named chip.
function images(paths, owner, c) {
  if (!paths?.length) return null;
  const t = c.t;
  return h_flex().gap(8).flex_wrap().children(paths.map((p, i) => {
    const rel = homeRel(p, appHome());
    const el = h_flex().id(`img-${owner}-${i}`).cursor_pointer().rounded(10).overflow_hidden().border_1().border_color(t.border)
      .on_click((_e, cx) => c.enlarge(p, c.svgSize(p), cx, `img:${owner}:${i}`));
    if (!rel) return el.h(26).px(8).gap(6).items_center().text_size(11.5).text_color(t.muted).child(icon("image", 12)).child(p.split("/").pop());
    const sz = c.svgSize(p);
    const w = Math.min(320, c.colW * 0.6, sz?.w ?? 320);
    const h = sz ? Math.round((w * sz.h) / sz.w) : 200;
    return el.child(image(rel).w(w).h(Math.min(h, 320)));
  }));
}

// Under a message: when it was, copy, and (user) edit and resend. Fades in
// on hover; the run's footer, when given, stays.
function actions(it, footer, c, { align = "start", text } = {}) {
  const t = c.t;
  const on = it && c.hover === it.id;
  const btn = (id, ic, tip, fn) => h_flex().id(id).h(22).w(24).items_center().justify_center().rounded(6).cursor_pointer()
    .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip).on_click(fn).child(icon(ic, 12.5));
  const acts = it ? h_flex().gap(2).items_center().opacity(on ? 1 : 0).transition("opacity", { duration: 120, easing: "ease-out" })
    .child(div().id(`ts-${it.id}`).px(4).text_size(11).text_color(t.dim).tooltip(absTime(it.ts)).child(relTime(it.ts, c.now)))
    .when(on, (e) => e.child(copyButton(`msg:${it.id}`, text ?? it.text ?? "", c, { size: 12.5 }))
      .when(it.kind === "user", (x) => x.child(btn(`edit-${it.id}`, "pencil", "Edit and resend", (_e, cx) => c.editResend(it, cx)))))
    : null;
  let foot = null;
  if (footer) {
    const parts = [];
    if (footer.model) parts.push(c.modelName(footer.model));
    if (footer.ms) parts.push(duration(footer.ms));
    if (footer.output) parts.push(`${count(footer.output)} tok`);
    if (footer.cost != null && c.showCost !== false) parts.push(money(footer.cost));
    const tip = [`in ${count(footer.input)} · out ${count(footer.output)}`, footer.cache ? `cache ${count(footer.cache)}` : null]
      .filter(Boolean).join(" · ");
    foot = div().id(`foot-${it?.id ?? "run"}`).text_size(11).text_color(t.dim).tooltip(tip).child(parts.join(" · "));
  }
  return h_flex().h(SPACE.slot).gap(8).items_center().when(align === "end", (e) => e.justify_end())
    .children(foot ? [foot] : []).children(acts ? [acts] : []);
}

function hoverable(el, it, c) {
  return el.id(`msg-${it.id}`).on_hover((h, cx) => c.setHover(it.id, h, cx));
}

function user(it, c) {
  const t = c.t;
  const env = unwrapHc(it.text);
  const from = it.from ?? env.from;
  const text = env.from ? env.text : it.text;
  if (from) return report(it, from, text, c); // an `hc send` report (external, or queued first)
  const tags = [];
  if (from) tags.push(h_flex().gap(4).items_center().child(icon("message", 11)).child(`from ${from}`));
  else if (it.source === "external") tags.push(div().child("from outside"));
  else if (it.source === "extension") tags.push(div().child("from an extension"));
  else if (it.source === "queued") tags.push(div().child("queued"));
  if (it.images) tags.push(h_flex().gap(4).items_center().child(icon("image", 11)).child(plural(it.images, "image")));
  // The actions sit left of the bubble, on its last line: no extra height.
  const b = SPACE.bubble;
  const body = (key) => div().text_size(14).line_height(`${SPACE.lineH}px`).child(prose(`md-${it.id}${key}`, text || " "));
  const skill = it.skill;
  // What the agent got for the skill, under its pill once opened.
  const skillBody = Boolean(skill?.body) && c.expanded.has(`skill:${it.id}`)
    ? [div().pl(12).border_l_1().border_color(t.border).text_size(12.5).line_height("19px").text_color(t.muted).child(prose(`skill-${it.id}`, skill.body))]
    : [];
  // A skill: its pill, then the message: beside it when that is one short line,
  // else under it (as the bubble's own rows: a nested column sizes the text too narrow).
  let content;
  if (!skill) content = [body("")];
  else if (!text) content = [h_flex().child(skillPill(it, c)), ...skillBody];
  else if (!text.includes("\n") && text.length <= 80) content = [h_flex().gap(8).items_center().child(skillPill(it, c)).child(body("-i").flex_1().min_w(0)), ...skillBody];
  else content = [h_flex().child(skillPill(it, c)), ...skillBody, body("-s")];
  return hoverable(h_flex().gap(6).items_end().justify_end(), it, c)
    .child(div().flex_none().pb(2).child(actions(it, null, c, { align: "end", text: typedText(it, text) })))
    .child(v_flex().max_w(Math.round(c.colW * 0.85)).gap(6).px(b.x).py(b.y).rounded(b.r).bg(t.raised)
      .when(tags.length > 0, (e) => e.child(h_flex().gap(8).text_size(11).text_color(t.dim).children(tags)))
      .children(content)
      .children([images(it.imagePaths, it.id, c)].filter(Boolean)));
}

// The skill a message ran: a tinted pill with its name. Its file shows on
// hover; a click shows what the agent got (when the agent says).
function skillPill(it, c) {
  const t = c.t;
  const s = it.skill;
  const open = c.expanded.has(`skill:${it.id}`);
  const tip = [s.path ? s.path.replace(/^\/Users\/[^/]+/, "~") : `/${s.command}`, s.body ? (open ? "click to hide it" : "click to read it") : null].filter(Boolean).join(" · ");
  return h_flex().id(`skill-pill-${it.id}`).flex_none().h(22).px(7).gap(5).items_center().rounded(6)
    .bg(alpha(t.accent, 0.14)).text_color(t.accent).text_size(12).font_medium().tooltip(tip)
    .when(Boolean(s.body), (e) => e.cursor_pointer().hover((x) => x.bg(alpha(t.accent, 0.22))).on_click((_e, cx) => c.toggle(`skill:${it.id}`, cx)))
    .child(icon("book", 12)).child(s.name)
    .when(Boolean(s.body), (e) => e.child(icon(open ? "chevron-up" : "chevron-down", 10)));
}

// A message another agent sent with `hc send` (a subagent's report, `<hc from=…>`):
// left-aligned like the agent's side, a card headed "↩ from t7 review", the body as
// markdown, folded to its first lines when long (a click on the header or "Show all" opens it).
const REPORT_LINES = 10;
function report(it, from, text, c) {
  const t = c.t;
  const lines = (text ?? "").split("\n");
  const long = lines.length > REPORT_LINES + 2 || (text ?? "").length > 1200;
  const open = !long || c.expanded.has(`report:${it.id}`);
  const shown = open ? text : lines.slice(0, REPORT_LINES).join("\n").slice(0, 1000).trimEnd() + "\n\n…";
  // Its actions sit in the header (a click there doesn't fold the card): no row under it.
  const acts = h_flex().id(`report-acts-${it.id}`).flex_none().on_click((_e, cx) => cx.stop_propagation()).child(actions(it, null, c, { text }));
  return hoverable(v_flex(), it, c)
    .child(v_flex().id(`report-${it.id}`).w_full().rounded(10).border_1().border_color(t.border).bg(t.surface).overflow_hidden()
      .child(h_flex().id(`report-head-${it.id}`).h(30).px(10).gap(7).items_center().text_size(12).text_color(t.muted)
        .when(long, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => c.toggle(`report:${it.id}`, cx)))
        .child(icon("corner-up-right", 12).text_color(t.dim))
        .child(div().flex_none().child("from"))
        .child(div().flex_1().min_w(0).truncate().font_medium().text_color(t.foreground).child(from))
        .child(acts)
        .when(long, (e) => e.child(h_flex().flex_none().gap(4).items_center().text_size(11.5).text_color(t.dim)
          .child(open ? "Fold" : plural(lines.length, "line")).child(icon(open ? "chevron-up" : "chevron-down", 11)))))
      .child(div().border_t_1().border_color(c.line).px(12).py(8).text_size(13.5).line_height("20px")
        .child(prose(`rp-${it.id}-${open ? 1 : 0}`, shown || " ")))
      .when(long && !open, (e) => e.child(div().id(`report-more-${it.id}`).px(12).pb(8).text_size(11.5).text_color(t.accent).cursor_pointer()
        .on_click((_e, cx) => c.toggle(`report:${it.id}`, cx)).child("Show all"))));
}

// `slot`: the actions and footer in a row under the answer (it ends its turn:
// the row sits inside the turn gap); else, on hover, over its last line's end.
function assistant(it, c, footer, slot) {
  const t = c.t;
  const over = !slot && !it.streaming && c.hover === it.id;
  return hoverable(v_flex().relative().gap(SPACE.slotGap), it, c)
    .when(Boolean(it.autonomous), (e) => e.child(h_flex().gap(5).items_center().text_size(11).text_color(t.dim).child(icon("rotate", 11)).child("on its own")))
    .when(Boolean(it.text), (e) => e.child(div().text_size(14).line_height(`${SPACE.lineH}px`).child(blocks(it, c))))
    .when(it.stopReason === "aborted", (e) => e.child(div().text_size(11.5).text_color(t.dim).child("Stopped")))
    .when(it.stopReason === "length", (e) => e.child(div().text_size(11.5).text_color(t.blocked).child("Stopped at the length limit")))
    .when(it.stopReason !== "aborted" && (Boolean(it.error) || it.stopReason === "error"), (e) => e.child(h_flex().gap(6).items_center().text_size(12).text_color(t.ansi1)
      .child(icon("alert", 12)).child(it.error ?? "The model returned an error")))
    .when(slot && !it.streaming, (e) => e.child(actions(it, footer, c)))
    .when(over, (e) => e.child(h_flex().absolute().right(0).bottom(0).pl(4).rounded(8).bg(t.background).child(actions(it, null, c))));
}

// "Thinking… 4s" (pulsing) while it streams; "Thought for 6s" after,
// collapsed, the text in dim italic when opened.
export function thinking(it, c) {
  const t = c.t;
  const open = c.expanded.has(it.id);
  const secs = it.streaming ? Math.max(0, Math.floor((c.now - it.ts) / 1000)) : null;
  const label = it.streaming ? "Thinking…" : it.durationMs != null ? `Thought for ${duration(Math.max(1000, it.durationMs)).replace(/\.\d+s$/, "s")}` : "Thought";
  return v_flex()
    .child(h_flex().id(`think-${it.id}`).h(28).gap(6).items_center().rounded(6).px(4).cursor_pointer().text_size(12.5).text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.muted)).on_click((_e, cx) => c.toggle(it.id, cx))
      .child(icon(open ? "chevron-down" : "chevron-right", 12))
      .child(it.streaming
        ? div().flex_none().text_color(t.muted).child(label).loop("opacity", { from: 0.35, to: 1, period: 1400 })
        : div().flex_none().child(label))
      .when(secs != null, (e) => e.child(div().flex_none().text_color(t.dim).child(`${secs}s`))))
    .when(open, (e) => e.child(div().ml(9).mt(2).mb(6).pl(14).border_l_1().border_color(t.border).text_size(13).line_height("20px")
      .text_color(t.dim).italic().child(prose(`th-${it.id}`, it.text || " "))));
}

const TOOL_ICON = { bash: "terminal", read: "file-text", edit: "pencil", write: "file-plus", search: "search", web: "globe", agent: "bot", generic: "wrench" };
const VERB = { read: "Read", edit: "Edit", write: "Write" };

export function statusIcon(status, t, size = 13) {
  if (status === "running" || status === "pending") return spinner(size - 1, t.working);
  if (status === "error") return icon("x", size).text_color(t.ansi1);
  if (status === "declined") return icon("ban", size - 1).text_color(t.blocked);
  return icon("check", size).text_color(t.ansi2);
}

function chip(text, color, t) {
  return div().flex_none().h(18).px(6).rounded(6).flex().items_center().text_size(11).text_color(color).bg(alpha(color, 0.13)).child(text);
}

// The line a file tool opens at: read's offset, the edit's first hunk.
export function lineOf(d) {
  if (d.type === "read") return d.offset ?? 1;
  if (d.type === "edit") return d.diffLines?.find((l) => l.new != null && l.kind !== "hunk")?.new ?? Number(/@@ -\d+(?:,\d+)? \+(\d+)/.exec(d.diff ?? "")?.[1] ?? 1);
  return 1;
}

// A tool's one-line title, detail-aware: "$ cmd", "Read <path link> :10-40",
// "mcp server · tool". `it`: a tool item, or a permission dialog's `tool`.
export function toolTitle(it, d, c) {
  const t = c.t;
  if (VERB[d.type] && d.path) {
    const rest = (it.title ?? "").replace(/^\S+\s+/, "").slice(String(d.path).length);
    const shown = shortPath(d.path, c.cwd);
    return h_flex().flex_1().min_w(0).gap(6).items_center()
      .child(div().flex_none().text_size(12.5).text_color(t.muted).child(VERB[d.type]))
      .child(div().id(`path-${it.id}`).min_w(0).truncate().font_family(c.mono).text_size(12.5).text_color(t.foreground).cursor_pointer()
        .hover((s) => s.text_color(t.accent).text_decoration_1()).tooltip(`Open ${shown}`)
        .on_click((_e, cx) => { cx.stop_propagation(); c.openFile(d.path, lineOf(d), cx); })
        .child(shown))
      .when(Boolean(rest) && !/^\s*$/.test(rest), (e) => e.child(div().flex_none().font_family(c.mono).text_size(12).text_color(t.dim).child(rest.trim())));
  } else {
    return div().flex_1().min_w(0).truncate().font_family(c.mono).text_size(12.5).text_color(t.foreground).child(it.title || it.name);
  }
}

export const toolIcon = (d) => TOOL_ICON[d?.type] ?? "wrench";

export function tool(it, c) {
  const t = c.t;
  const d = it.detail ?? { type: "generic", tool: it.name };
  if (d.type === "agent") return agentCard(it, d, c);
  const open = c.expanded.has(it.id);
  const title = toolTitle(it, d, c);
  const added = d.added ?? null, removed = d.removed ?? null;
  const head = h_flex().id(`tool-${it.id}`).h(34).px(10).gap(8).items_center().cursor_pointer()
    .hover((s) => s.bg(t.hover)).on_click((_e, cx) => c.toggle(it.id, cx))
    .child(icon(TOOL_ICON[d.type] ?? "wrench", 13).text_color(t.dim))
    .child(title)
    .when(d.type === "edit" && (added != null || removed != null), (e) => e.child(h_flex().flex_none().gap(6).font_family(c.mono).text_size(11.5)
      .child(div().text_color(t.ansi2).child(`+${added ?? 0}`)).child(div().text_color(t.ansi1).child(`−${removed ?? 0}`))))
    .when(d.type === "bash" && d.exitCode != null && d.exitCode !== 0, (e) => e.child(chip(`exit ${d.exitCode}`, t.ansi1, t)))
    .when(it.durationMs != null && it.durationMs >= 100, (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(duration(it.durationMs))))
    .child(statusIcon(it.status, t));
  let body = null;
  if (open) body = toolBody(it, d, c);
  else if (it.status === "running" && it.output) {
    // Running: the output's last lines, so a long command shows life.
    const lines = it.outputLines?.length ? it.outputLines.slice(-4) : asLines(it.output).slice(-4);
    body = div().border_t_1().border_color(c.line).px(10).py(6).child(outputBox(`${it.id}-tail`, lines, c, { color: t.dim }));
  }
  return v_flex().rounded(10).overflow_hidden().border_1()
    .border_color(it.status === "error" ? alpha(t.ansi1, 0.45) : it.status === "declined" ? alpha(t.blocked, 0.45) : t.border).bg(t.surface)
    .child(head).children(body ? [body] : [])
    .when(it.status === "declined", (e) => e.child(div().border_t_1().border_color(c.line).px(10).py(5).text_size(11.5).text_color(t.blocked).child("Declined: not run")))
    .children(it.images?.length ? [div().px(10).pb(10).child(images(it.images, it.id, c))] : []);
}

function toolBody(it, d, c) {
  const t = c.t;
  const fullText = c.full.get(it.id);
  const out = fullText ?? it.output ?? "";
  const truncated = it.outputTruncated && fullText == null;
  const box = v_flex().border_t_1().border_color(c.line).px(10).py(8).gap(8).max_w_full();
  const parts = [];
  if (d.type === "bash") {
    parts.push(h_flex().gap(8).font_family(c.mono).text_size(12.5).line_height("19px")
      .child(div().flex_none().text_color(t.dim).child("$")).child(div().flex_1().min_w(0).text_color(t.foreground).child(d.command ?? "")));
  }
  const isDiff = d.type === "edit" && (d.diffLines?.length || d.diff);
  if (d.type === "edit") {
    if (d.diffLines?.length) parts.push(diffView(it.id, d.diffLines, c));
    else if (d.diff) parts.push(textDiff(it.id, d.diff, c));
    else parts.push(mono(d.path ?? "", c));
  }
  if (d.type === "write" && d.bytes != null) parts.push(div().text_size(11.5).text_color(t.dim).child(`${count(d.bytes)} bytes`));
  if (d.type === "generic" || (d.type !== "bash" && d.type !== "edit" && !out)) {
    if (it.args && it.args !== "{}") parts.push(mono(it.args, c, t.dim));
  }
  if (out && !isDiff) {
    if (truncated) parts.push(h_flex().gap(8).text_size(11).text_color(t.dim).child("… earlier output")
      .child(div().id(`more-${it.id}`).text_color(t.accent).cursor_pointer().on_click((_e, cx) => c.more(it.id, cx)).child("Show all")));
    const lines = fullText == null && it.outputLines?.length ? it.outputLines : asLines(out);
    const numbered = d.type === "read" && !/^\s*\d+[\t│|:]/.test(lines[0]?.map?.((s) => s.text).join("") ?? "");
    parts.push(outputBox(it.id, lines, c, { first: numbered ? d.offset ?? 1 : null, cap: MAX_LINES, color: d.type === "read" ? t.foreground : t.muted }));
  }
  if (d.type === "bash" && d.exitCode != null) parts.push(h_flex().child(chip(`exit ${d.exitCode}`, d.exitCode === 0 ? t.dim : t.ansi1, t)));
  if (!parts.length) parts.push(div().text_size(11.5).text_color(t.dim).child(it.status === "running" ? "Running…" : "No output"));
  return box.children(parts);
}

// A work group: one summary row; open, its cards (6 px apart). The running
// group shows its live card; a finished one is closed unless it failed.
function group(r, c) {
  const t = c.t;
  const s = groupSummary(r.items);
  const want = c.groupOpen(r.id);
  const open = want ?? (s.failed || s.declined);
  const live = !open && s.running ? r.items.filter((x) => x.status === "running" || x.status === "pending" || x.streaming) : [];
  const members = open ? r.items : live;
  const head = h_flex().id(`grp-${r.id}`).h(30).px(6).gap(7).items_center().rounded(8).cursor_pointer()
    .text_size(12.5).text_color(t.muted).hover((x) => x.bg(t.hover).text_color(t.foreground))
    .on_click((_e, cx) => c.toggle(r.id, cx))
    .child(icon(open ? "chevron-down" : "chevron-right", 12).text_color(t.dim))
    .child(div().flex_none().max_w_full().truncate().child(s.text))
    .when(s.ms != null && s.ms >= 1000 && !s.running, (e) => e.child(div().flex_none().text_size(11.5).text_color(t.dim).child(duration(s.ms))))
    .child(statusIcon(s.failed ? "error" : s.declined ? "declined" : s.running ? "running" : "done", t, 12));
  // Opening and closing animate the cards' height (main.js `groupAnim`):
  // an explicit height that changes once, with a native transition.
  const anim = c.groupAnim(r.id);
  const shownMembers = anim?.target === "close" ? r.items : members;
  let body = shownMembers.length
    ? v_flex().id(`grp-cards-${r.id}`).flex_none().gap(SPACE.card).pt(SPACE.card).on_size_change((sz, cx) => c.groupMeasured(r.id, sz.height, cx))
      .children(shownMembers.map((m) => (m.kind === "thinking" ? thinking(m, c) : tool(m, c))))
    : null;
  if (body && anim) {
    const h = anim.step === 0 ? (anim.target === "open" ? 0 : anim.h ?? 0) : anim.target === "open" ? anim.h ?? 0 : 0;
    body = div().id(`grp-body-${r.id}`).overflow_hidden().h(h).opacity(anim.target === "close" && anim.step === 1 ? 0 : 1)
      .transition("height", { duration: 160, easing: "ease-out" }).transition("opacity", { duration: 160, easing: "ease-out" }).child(body);
  }
  return v_flex()
    .child(head)
    .children(body ? [body] : []);
}

// While Pi works: what it's doing now, at the bottom of the timeline.
function activity(c) {
  const t = c.t;
  const a = c.activity;
  if (!a) return div();
  return h_flex().h(30).gap(8).items_center().text_size(12.5).text_color(t.muted)
    .child(a.waiting
      ? div().flex_none().w(8).h(8).rounded_full().bg(t.blocked).loop("opacity", { from: 0.35, to: 1, period: 1200 })
      : spinner(12, t.working))
    .child(div().flex_none().child(a.text))
    .when(a.since != null, (e) => e.child(div().flex_none().text_color(t.dim).child(`· ${Math.max(0, Math.floor((c.now - a.since) / 1000))}s`)));
}

function notice(it, c) {
  const t = c.t;
  const color = it.level === "error" ? t.ansi1 : it.level === "warning" ? t.blocked : t.dim;
  return h_flex().gap(8).items_start().text_size(12)
    .child(div().pt(2).child(icon(it.level === "info" ? "info" : "alert", 12).text_color(color)))
    .child(div().flex_1().min_w(0).text_color(t.muted).child(it.spans?.length ? spansOrText(it, c, t.muted) : it.text ?? ""));
}

function spansOrText(it, c, base) {
  return h_flex().flex_wrap().children(it.spans.map((s) => div().text_color(s.fg ? c.color(s.fg) ?? base : base).child(s.text ?? "")));
}

function custom(it, c) {
  const t = c.t;
  return v_flex()
    .child(v_flex().gap(4).px(12).py(8).rounded(10).border_1().border_color(t.border)
      .child(div().text_size(11).text_color(t.dim).child(it.customType ?? "message"))
      .child(div().text_size(13.5).child(TextView.markdown(`cu-${it.id}`, it.text || " ").selectable(true))));
}

// A subagent (ToolDetail "agent"): its description, then the steps its run
// produced (items with `parent` = this card), folded to "N steps" until opened.
function agentCard(it, d, c) {
  const t = c.t;
  const kids = (c.children?.get(it.id) ?? []).filter((k) => k.kind !== "assistant" || k.text?.trim());
  const open = c.expanded.has(`kids:${it.id}`);
  const running = it.status === "running" || it.status === "pending";
  const live = !open && running ? kids.filter((k) => k.kind === "tool").slice(-1)[0] : null;
  const head = h_flex().id(`agent-${it.id}`).h(34).px(10).gap(8).items_center().cursor_pointer()
    .hover((s) => s.bg(t.hover)).on_click((_e, cx) => c.toggle(`kids:${it.id}`, cx))
    .child(icon("bot", 13).text_color(t.dim))
    .child(div().flex_none().text_size(12.5).text_color(t.muted).child("Agent"))
    .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.foreground).child(d.description || it.title || it.name))
    .when(Boolean(d.agentType), (e) => e.child(chip(d.agentType, t.muted, t)))
    .child(h_flex().flex_none().gap(4).items_center().text_size(11.5).text_color(t.dim)
      .child(plural(kids.length, "step")).child(icon(open ? "chevron-down" : "chevron-right", 11)))
    .when(it.durationMs != null && it.durationMs >= 100, (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(duration(it.durationMs))))
    .child(statusIcon(it.status, t));
  let body = null;
  if (open && kids.length) {
    body = v_flex().border_t_1().border_color(c.line).pl(12).pr(8).py(8).gap(6)
      .children(kids.map((k) => (k.kind === "tool" ? tool(k, c) : k.kind === "thinking" ? thinking(k, c)
        : k.kind === "assistant" ? div().px(2).text_size(13.5).line_height("20px").child(blocks(k, c)) : item(k, c))));
  } else if (live) {
    body = h_flex().border_t_1().border_color(c.line).px(10).py(6).gap(8).items_center().text_size(12).text_color(t.dim)
      .child(spinner(11, t.working)).child(div().flex_1().min_w(0).truncate().font_family(c.mono).child(live.title || live.name));
  }
  return v_flex().rounded(10).overflow_hidden().border_1().border_color(it.status === "error" ? alpha(t.ansi1, 0.45) : t.border).bg(t.surface)
    .child(head).children(body ? [body] : []);
}

// A plan / todo list (item kind "plan"), replaced in place as it changes.
function plan(it, c) {
  const t = c.t;
  const steps = it.steps ?? [];
  const done = steps.filter((x) => x.status === "completed").length;
  return v_flex().rounded(10).border_1().border_color(t.border).bg(t.surface).px(12).py(10).gap(6)
    .child(h_flex().gap(8).items_center()
      .child(icon("list-checks", 13).text_color(t.dim))
      .child(div().flex_1().text_size(12.5).font_medium().text_color(t.foreground).child("Plan"))
      .child(div().text_size(11.5).text_color(t.dim).child(`${done} of ${steps.length} done`)))
    .when(Boolean(it.explanation), (e) => e.child(div().text_size(12.5).text_color(t.muted).child(it.explanation)))
    .child(v_flex().gap(3).children(steps.map((x) => {
      const st = x.status;
      const mark = st === "completed" ? icon("circle-check", 13).text_color(t.ansi2)
        : st === "in_progress" ? icon("circle-half", 13).text_color(t.accent) : icon("circle", 13).text_color(t.dim);
      return h_flex().gap(8).items_start().text_size(13)
        .child(div().pt(3).child(mark))
        .child(div().flex_1().min_w(0).line_height("20px")
          .text_color(st === "completed" ? t.dim : st === "in_progress" ? t.foreground : t.muted)
          .when(st === "completed", (e) => e.line_through())
          .when(st === "in_progress", (e) => e.font_medium())
          .child(x.text));
    })));
}
