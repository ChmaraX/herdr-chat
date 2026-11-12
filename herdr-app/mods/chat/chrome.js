// What sits around the composer (visual-v2.md §1, §4): the footer row's
// controls (model and thinking chips, the context meter, extension status
// chips with their "+N" popover), the widget trays, the queue
// lanes, and the empty state's title.
// Extension-agnostic: statuses and widgets are shown by key, as sent.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Popover } from "gpui-base";
import { MOD, alpha, count, icon, money, providerIcon, spans, spansText, unwrapHc } from "./util.js";
import { withKey } from "./shortcuts.js";

const STATUS_MAX = 28;
const STATUS_W = (text) => Math.min(STATUS_MAX, [...text].length) * 6.3 + 18;

function ring(pct, t) {
  const p = Math.max(0, Math.min(100, Math.round((pct ?? 0) / 5) * 5));
  const color = pct > 90 ? t.ansi1 : pct > 75 ? t.blocked : t.muted;
  return svg(`mods/${MOD}/icons/ring/${p}.svg`).size(14).flex_none().text_color(color);
}

function chipEl(id, t, { tip, onClick, active } = {}) {
  let el = h_flex().id(id).h(28).px(8).gap(6).items_center().rounded(8).text_size(12).text_color(active ? t.foreground : t.muted)
    .flex_none();
  if (onClick) el = el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(onClick);
  if (active) el = el.bg(t.hover);
  if (tip) el = el.tooltip(tip);
  return el;
}

function surface(t) {
  return v_flex().p(4).gap(1).rounded(10).border_1().border_color(t.border).bg(t.popover).shadow_md();
}

// The composer footer's controls, left to right. `v` is the view (main.js).
// `width`: the room left of the send button. Narrow columns get narrower
// chips, never an overlap with the button (the row also clips):
//   xs (< 200 px, a ~240 px column): icons only (labels in the tooltips), every status in "+N";
//   sm (< 300 px): the model's short name, the level, a mode icon, no chevrons, every status in "+N";
//   md (< 520 px): shorter names, no cost; statuses as they fit;  full: everything.
export function footerTier(width) {
  return width < 200 ? "xs" : width < 300 ? "sm" : width < 520 ? "md" : "full";
}

export function footerControls(v, t, { width }) {
  const s = v.store.state;
  const caps = s.capabilities ?? null; // what this agent can do (null until the host says)
  const tier = footerTier(width);
  v.footerTier = tier;
  const drawn = []; // the chips drawn, by name (the dump: footerChips)
  const tiny = tier === "xs";
  const left = [];
  const name = s.model?.name ?? s.model?.id ?? "Model";
  const provider = v.providerId();
  const small = tiny || tier === "sm";
  const chevron = () => (small ? div() : icon("chevron-down", 11).text_color(t.dim));
  const modelTip = withKey(`${v.providerName()}${s.model ? ` · ${name} (${s.model.provider}/${s.model.id})` : ""} · /model`, "model");
  left.push(chipEl("chip-model", t, { tip: modelTip, onClick: (_e, cx) => v.control("chip:model", cx) }).when(tiny, (e) => e.px(6))
    .child(providerIcon(provider, 13))
    .when(!tiny, (e) => e.child(div().max_w(tier === "sm" ? 72 : tier === "md" ? 120 : 180).truncate().child(tier === "sm" ? shortModel(name) : name)))
    .child(chevron()));
  drawn.push("model");
  const thinkingChip = caps?.thinkingLevels?.length > 0;
  const level = s.thinking ?? "default";
  if (thinkingChip) {
    left.push(chipEl("chip-thinking", t, { tip: withKey(withKey(`Thinking level: ${level} · /thinking`, "effort"), "cycleEffort"), onClick: (_e, cx) => v.control("chip:thinking", cx) }).when(tiny, (e) => e.px(6))
      .child(icon("sparkles", 12.5)).when(!tiny, (e) => e.child(level)).child(chevron()));
    drawn.push("thinking");
  }
  const modes = caps?.permissionModes ?? [];
  if (modes.length) {
    const m = modes.find((x) => x.id === s.permissionMode);
    const label = m?.label ?? s.permissionMode ?? "mode";
    const iconOnly = tier === "xs" || tier === "sm";
    left.push(chipEl("chip-permission", t, { tip: withKey(withKey(`${label}: ${m?.description ?? "Permission mode"} · click to change`, "mode"), "cycleMode"), onClick: (_e, cx) => v.control("chip:permission", cx) })
      .when(iconOnly, (e) => e.px(6))
      .child(icon("shield", 12.5)).when(!iconOnly, (e) => e.child(div().max_w(tier === "md" ? 80 : 120).truncate().child(label))).child(chevron()));
    drawn.push("permission");
  }
  const u = s.usage;
  const cost = caps?.cost === false || tier !== "full" ? null : u?.cost ?? null;
  if (u && (u.percent != null || cost != null)) {
    const win = u.contextWindow ?? s.model?.contextWindow ?? null;
    const tip = [
      u.percent != null ? `${Math.round(u.percent)}% of the context window` : null,
      u.contextTokens != null ? `${count(u.contextTokens)}${win ? ` / ${count(win)}` : ""} tokens` : null,
      (caps?.cost === false ? null : u?.cost ?? null) != null ? `${money(u.cost)} this session` : null,
    ].filter(Boolean).join(" · ");
    left.push(chipEl("chip-context", t, { tip }).when(tiny, (e) => e.px(6))
      .when(u.percent != null, (e) => e.child(ring(u.percent, t)).when(!small, (x) => x.child(div().text_size(11.5).child(`${Math.round(u.percent)}%`))))
      .when(cost != null, (e) => e.child(div().text_size(11.5).text_color(t.dim).child(money(cost)))));
    drawn.push("context", ...(cost != null ? ["cost"] : []));
  }
  v.footerChips = drawn;
  // Statuses: as many chips as fit, then "+N".
  const leftW = 20 + Math.min(name.length * 6.8, tier === "md" ? 120 : 180) + 46 + (thinkingChip ? 80 : 0) + (modes.length ? (tier === "md" ? 80 : 100) : 0) + (u ? (cost != null ? 90 : 50) : 0);
  let room = tier === "xs" || tier === "sm" ? 0 : Math.max(0, width - leftW - 40);
  const list = caps?.extensionUi === false ? [] : v.visibleStatuses();
  const shown = [];
  for (const x of list) {
    const w = STATUS_W(x.text);
    if (w > room && shown.length < list.length) break;
    room -= w + 4;
    shown.push(x);
  }
  const extra = list.length - shown.length + (caps?.extensionUi === false ? 0 : v.hiddenStatuses().length);
  v.footerStatuses = { shown: shown.map((x) => x.key), extra }; // (the dump)
  const right = [];
  const chips = shown.map((x) => {
    const short = [...x.text].length > STATUS_MAX ? [...x.text].slice(0, STATUS_MAX - 1).join("") + "…" : x.text;
    return chipEl(`status-${x.key}`, t, { tip: `${x.key}: ${x.text}` }).px(6).text_size(11.5).cursor_pointer().hover((st) => st.bg(t.hover))
      .child(spans(short === x.text ? x.spans : [{ text: short }], t, t.dim));
  });
  if (extra > 0) chips.push(chipEl("status-more", t, { tip: "All extension statuses", active: v.statusesOpen }).px(6).text_size(11.5)
    .cursor_pointer().hover((st) => st.bg(t.hover).text_color(t.foreground)).child(`+${extra}`));
  // The chips are the popover's trigger: a click on any lists them all (and hides some).
  if (chips.length) {
    right.push(Popover.new("statuses").anchor("bottom_right").open(Boolean(v.statusesOpen))
      .on_open_change((open, cx) => v.setStatusesOpen(open, cx))
      .trigger(h_flex().id("statuses").gap(2).items_center().children(chips))
      .content(statusesPopover(v, t)));
  }
  return h_flex().flex_1().min_w(0).gap(2).items_center().overflow_hidden()
    .children(left)
    .child(div().flex_1().min_w(tiny ? 2 : 8))
    .children(right);
}

// "Claude Haiku 4.5" → "Haiku 4.5"; "GPT-5.6 Luna" → "GPT-5.6 Luna" (no vendor word to drop).
function shortModel(name) {
  return String(name).replace(/^(Claude|Anthropic|OpenAI|Google)\s+/i, "");
}

function statusesPopover(v, t) {
  const all = v.store.state.statuses.filter((x) => spansText(x.spans).trim());
  const hidden = new Set(v.hiddenStatuses().map((x) => x.key));
  const rows = all.filter((x) => v.showHidden || !hidden.has(x.key)).map((x) => {
    const off = hidden.has(x.key);
    return h_flex().id(`st-row-${x.key}`).min_h(30).px(8).py(4).gap(10).items_start().rounded(7).hover((s) => s.bg(t.hover))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().text_size(11).text_color(t.dim).child(x.key))
        .child(div().text_size(12).opacity(off ? 0.5 : 1).child(spans(x.spans, t, t.foreground))))
      .child(div().id(`st-hide-${x.key}`).mt(2).p(3).rounded(5).cursor_pointer().text_color(t.dim).hover((s) => s.text_color(t.foreground).bg(t.raised))
        .tooltip(off ? "Show in the footer" : "Hide from the footer")
        .on_click((_e, cx) => v.control(`status:${off ? "show" : "hide"}:${x.key}`, cx)).child(icon(off ? "eye" : "eye-off", 12)));
  });
  return surface(t).w(340).max_h(360)
    .child(div().px(8).pt(4).pb(2).text_size(11).text_color(t.dim).child("Extension status"))
    .children(rows)
    .when(hidden.size > 0, (e) => e.child(h_flex().id("st-show-hidden").h(28).px(8).items_center().rounded(7).cursor_pointer().text_size(11.5).text_color(t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => v.control("status:toggle-hidden", cx))
      .child(v.showHidden ? "Hide the hidden ones" : `Show hidden (${hidden.size})`)));
}

// A widget's summary: its first line that says something (not only
// box-drawing, dashes or blanks).
const DECOR = /^[\s\u2500-\u259f\-=_~*·•.:|+#]*$/;
const RULED = /^[\u2500-\u259f\-=_~]{2,}.*[\u2500-\u259f\-=_~]{2,}$/; // "── queue ──": a heading rule
export function widgetSummary(w) {
  const line = w.lines.map((l) => spansText(l).trim()).find((x) => x && !DECOR.test(x) && !RULED.test(x));
  return line ?? w.key;
}

// Widgets (setWidget). All closed: one quiet line of their summaries.
// One open: a tray, each widget a row (summary, key dim) that opens to its lines.
export function widgetTray(v, list, t) {
  if (!list.length) return null;
  if (!list.some((w) => v.widgetOpen(w.key))) {
    return h_flex().w_full().h(22).px(6).gap(6).items_center().text_size(11.5).text_color(t.dim)
      .children(list.map((w, i) => h_flex().id(`widget-${w.key}`).min_w(0).gap(5).items_center().px(4).rounded(5).cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.muted)).tooltip(`${w.key} · click to open`)
        .on_click((_e, cx) => v.control(`widget:${w.key}`, cx))
        .child(icon("chevron-right", 10)).child(div().min_w(0).truncate().child(widgetSummary(w)))));
  }
  return v_flex().w_full().rounded(10).border_1().border_color(t.border).bg(t.surface).overflow_hidden()
    .children(list.map((w, i) => {
      const open = v.widgetOpen(w.key);
      return v_flex().when(i > 0, (e) => e.border_t_1().border_color(alpha(t.border, 0.6)))
        .child(h_flex().id(`widget-${w.key}`).h(28).px(10).gap(8).items_center().cursor_pointer().text_size(12)
          .hover((s) => s.bg(t.hover)).on_click((_e, cx) => v.control(`widget:${w.key}`, cx))
          .child(icon(open ? "chevron-down" : "chevron-right", 11).text_color(t.dim))
          .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(open ? "" : widgetSummary(w)))
          .child(div().flex_none().text_size(10.5).text_color(t.dim).child(w.key)))
        .when(open, (e) => e.child(v_flex().px(10).pb(8).pl(29).gap(1).text_size(12).children(w.lines.map((l) => spans(l, t, t.muted)))));
    }));
}

// Queued steers and follow-ups: [label, text]. A subagent's report (an
// `hc send`, queue.steeringFrom / followUpFrom in protocol v3.1, else the
// text's `<hc from=…>` envelope) says so: "Report from t7 review".
export function queueLabels(s) {
  const label = (k, x, from) => {
    const env = unwrapHc(x);
    const who = from ?? env.from;
    return who ? [`Report from ${who}`, (env.from ? env.text : x).trim()] : [k, x];
  };
  return [...s.queue.steering.map((x, i) => label("Steer", x, s.queue.steeringFrom?.[i])),
    ...s.queue.followUp.map((x, i) => label("Follow-up", x, s.queue.followUpFrom?.[i]))];
}

// The two lanes just above the composer (protocol v3.2), each first in,
// first out: steering (blue, the agent's next turn), then the follow-ups
// (yellow, after this run). A row the host can take back (queue.*Removable)
// opens for editing on a click, and has ⇄ (to the other lane) and ×.
// A report's row says who sent it.
export function queueChips(v, s, t) {
  const q = s.queue ?? {};
  const lane = (kind, texts, ids, removable, from, color, iconName, title) => {
    if (!texts?.length) return null;
    const rows = texts.map((x, i) => {
      const id = ids?.[i] ?? null;
      const can = Boolean(id && removable?.[i]);
      const env = unwrapHc(x);
      const who = from?.[i] ?? env.from;
      const text = (env.from ? env.text : x).trim();
      const btn = (name, tip, what) => div().id(`queued-${name}-${kind}-${i}`).flex_none().p(3).rounded(5).cursor_pointer().text_color(t.dim)
        .hover((st) => st.text_color(t.foreground).bg(t.hover)).tooltip(tip)
        .on_click((_e, cx) => { cx.stop_propagation(); v.control(`queue:${what}:${id}`, cx); })
        .child(icon(name === "move" ? "arrow-left-right" : "x", 11.5));
      return h_flex().id(`queued-${kind}-${i}`).min_h(26).pl(10).pr(4).gap(6).items_center().text_size(12)
        .when(i > 0, (e) => e.border_t_1().border_color(alpha(color, 0.18)))
        .when(can, (e) => e.cursor_pointer().hover((st) => st.bg(alpha(color, 0.1))).tooltip("Click to edit it in the composer")
          .on_click((_e, cx) => v.control(`queue:edit:${id}`, cx)))
        .when(Boolean(who), (e) => e.child(div().flex_none().text_color(t.dim).child(`Report from ${who}`)))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(text))
        .when(can, (e) => e
          .child(btn("move", kind === "steer" ? "Move to the follow-ups (after this run)" : "Steer with it now (next turn)", "move"))
          .child(btn("remove", "Remove from the queue", "remove")));
    });
    return v_flex().w_full().rounded(10).border_1().border_color(alpha(color, 0.35)).bg(alpha(color, 0.07)).overflow_hidden()
      .child(h_flex().h(22).px(10).gap(6).items_center().text_size(11).text_color(color)
        .child(icon(iconName, 11)).child(div().child(title)).child(div().text_color(t.dim).child(texts.length > 1 ? `· ${texts.length}` : "")))
      .children(rows);
  };
  const steer = lane("steer", q.steering, q.steeringIds, q.steeringRemovable, q.steeringFrom, t.ansi4, "corner-up-right", "Steer: next turn");
  const follow = lane("followUp", q.followUp, q.followUpIds, q.followUpRemovable, q.followUpFrom, t.ansi3, "clock", "Follow-up: after this run");
  if (!steer && !follow) return null;
  return v_flex().w_full().gap(6).children([steer, follow].filter(Boolean));
}

// The branch of the chat's folder (host git.ts, state.git), right of the hint
// line under the composer; a detached HEAD shows its commit. A click copies it.
export function branchChip(v, t, { width }) {
  const g = v.store.state.git;
  const name = g?.name ?? null;
  v.branchShown = name;
  if (!name) return null;
  return h_flex().id("branch").flex_none().max_w(Math.max(60, Math.round(width * 0.45))).min_w(0).h(16).px(4).gap(4).items_center()
    .rounded(4).text_size(11).text_color(t.dim).cursor_pointer().hover((st) => st.bg(t.hover).text_color(t.muted))
    .on_click((_e, cx) => v.control("branch", cx))
    .child(icon(g.detached ? "git-commit" : "git-branch", 11))
    .child(div().min_w(0).truncate().child(name));
}

// A new chat: the agent's name and the folder it runs in.
export function emptyState(v, t) {
  const s = v.store.state;
  const cwd = (s.cwd || v.cwd || "").replace(v.homeDir, "~");
  return v_flex().items_center().gap(6).pb(20)
    .child(h_flex().gap(10).items_center().text_color(t.foreground)
      .child(providerIcon(v.providerId(), 26))
      .child(div().text_size(28).font_semibold().child(v.providerName())))
    .child(div().text_size(12.5).text_color(t.dim).child(cwd));
}
