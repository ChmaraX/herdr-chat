// The composer's menus (slash commands, @files) and the pickers (model,
// thinking level, permission mode, sessions). Menus filter by what's typed
// in the composer; a picker has its own filter field and takes the keyboard
// while open. Both are drawn as an overlay above the composer (main.js puts
// the card in a Popup anchored to it), never in the layout's flow: a
// window of rows that ↑↓ and the mouse wheel move, Esc or a press outside
// closes it.

import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { icon, plural } from "./util.js";
import { rank } from "./composer.js";

export const ROWS = 8;
const ROW_H = 28;

// The rows on screen: `m.top` is the first, kept around the selection by the
// keys (follow) and moved on its own by the wheel (scroll).
function windowOf(items, m, rows) {
  const n = items.length;
  m.top = Math.max(0, Math.min(m.top ?? 0, Math.max(0, n - rows)));
  return { start: m.top, list: items.slice(m.top, m.top + rows) };
}

// After ↑↓: the selection on screen.
export function follow(m, rows = ROWS) {
  if (m.top == null) m.top = Math.max(0, m.sel - Math.floor(rows / 2));
  if (m.sel < m.top) m.top = m.sel;
  if (m.sel >= m.top + rows) m.top = m.sel - rows + 1;
}

// The wheel: px (positive = up, as GPUI reports it) → whole rows.
export function wheel(m, dy, n, rows = ROWS) {
  m.acc = (m.acc ?? 0) + dy;
  const steps = Math.trunc(m.acc / ROW_H);
  if (!steps) return false;
  m.acc -= steps * ROW_H;
  const before = m.top ?? 0;
  m.top = Math.max(0, Math.min(before - steps, Math.max(0, n - rows)));
  m.wheeled = (m.wheeled ?? 0) + 1;
  return m.top !== before;
}

export function slashItems(commands, query) {
  return (commands ?? [])
    .map((c, i) => ({ c, r: rank(c.name, query), i }))
    .filter((x) => x.r > 0)
    .sort((a, b) => b.r - a.r || a.i - b.i)
    .map((x) => x.c);
}

const SOURCE = { builtin: "", extension: "ext", prompt: "prompt", skill: "skill" };

// The card every menu and picker sits in. `o`: {id, onWheel(dy, cx), onOutside(cx)}.
function card(t, o) {
  let el = v_flex().id(o.id).p(4).rounded(10).border_1().border_color(t.border).bg(t.popover).shadow_md();
  if (o.onWheel) el = el.on_scroll_wheel((e, cx) => { cx.stop_propagation(); o.onWheel(e.delta.y, cx); });
  if (o.onOutside) el = el.on_mouse_down_out((_e, cx) => o.onOutside(cx));
  return el;
}

// menu: {kind, query, items, sel, top}; o: {onPick(index, cx), onWheel, onOutside, keys(name) → "⇧⌘M"|null}
export function menuView(menu, t, o) {
  if (!menu?.items?.length) {
    if (menu?.kind === "files" && menu.loading) return card(t, { id: "menu-card", onOutside: o.onOutside }).child(div().px(10).py(8).text_size(12).text_color(t.dim).child("Searching files…"));
    return null;
  }
  const { start, list } = windowOf(menu.items, menu, ROWS);
  const rows = list.map((it, k) => {
    const i = start + k;
    const sel = i === menu.sel;
    let row = h_flex().id(`menu-${i}`).h(ROW_H).px(10).gap(10).items_center().rounded(6).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { cx.stop_propagation(); o.onPick(i, cx); });
    if (sel) row = row.bg(t.selected);
    if (menu.kind === "slash") {
      const key = o.keys?.(it.name);
      row = row.child(div().flex_none().text_size(12.5).text_color(t.foreground).child(`/${it.name}`))
        .when(Boolean(it.args), (e) => e.child(div().flex_none().text_size(11.5).text_color(t.dim).child(it.args)))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(it.description ?? ""))
        .when(Boolean(key), (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(key)))
        .when(Boolean(SOURCE[it.source]), (e) => e.child(div().flex_none().text_size(10.5).text_color(t.dim).child(SOURCE[it.source])));
    } else {
      const slash = it.lastIndexOf("/");
      row = row.child(icon("file-text", 12).text_color(t.dim))
        .child(div().flex_none().text_size(12.5).text_color(t.foreground).child(slash >= 0 ? it.slice(slash + 1) : it))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(slash >= 0 ? it.slice(0, slash) : ""));
    }
    return row;
  });
  const more = menu.items.length > ROWS ? ` · ${start + 1}–${start + list.length} of ${menu.items.length}` : "";
  const footer = h_flex().px(10).pt(4).gap(10).text_size(10.5).text_color(t.dim)
    .child(div().flex_1().child(`${plural(menu.items.length, menu.kind === "files" ? "file" : menu.skillsOnly ? "skill" : "command")}${more}`))
    .child("↑↓ choose · Enter " + (menu.kind === "slash" && !menu.skillsOnly ? "run" : "insert") + (menu.skillsOnly ? "" : " · Tab complete") + " · Esc close");
  return card(t, { id: "menu-card", onWheel: (dy, cx) => o.onWheel(dy, cx), onOutside: o.onOutside })
    .child(v_flex().gap(1).children(rows)).child(footer);
}

// A list to choose from, with its own filter field.
// items: [{value, label, detail?, current?}]; hint: its shortcut ("⇧⌘M"), shown by the title.
export class Picker {
  constructor(kind, title, items, onChoose, { hint = null } = {}) {
    this.kind = kind;
    this.title = title;
    this.hint = hint;
    this.all = items;
    this.onChoose = onChoose;
    this.input = InputState.new({ placeholder: "Filter…" });
    this.query = "";
    this.sel = Math.max(0, items.findIndex((x) => x.current));
    this.top = null;
    follow(this, 10);
    this.input.on("change", (_e, cx) => {
      this.query = this.input.value();
      this.sel = 0;
      this.top = 0;
      cx.notify();
    });
  }

  items() {
    if (!this.query) return this.all;
    return this.all
      .map((x) => ({ x, r: Math.max(rank(x.label, this.query), rank(x.value, this.query), rank(x.detail ?? "", this.query) * 0.5) }))
      .filter((y) => y.r > 0).sort((a, b) => b.r - a.r).map((y) => y.x);
  }

  move(d) {
    const n = this.items().length;
    if (n) this.sel = (this.sel + d + n) % n;
    follow(this, 10);
  }

  wheel(dy) {
    return wheel(this, dy, this.items().length, 10);
  }

  choose(i, cx) {
    const it = this.items()[i ?? this.sel];
    if (it) this.onChoose(it, cx);
  }

  focus() {
    this.input.focus();
  }

  // actions(a, cx): the view's key handler; o: {onOutside(cx)}
  view(t, actions, o = {}) {
    const items = this.items();
    const { start, list } = windowOf(items, this, 10);
    let wrap = div().id("picker-input").key_context("HerdrChatMenu");
    for (const a of ["herdrchat_enter", "herdrchat_up", "herdrchat_down", "herdrchat_tab", "herdrchat_escape"]) wrap = wrap.on_action(a, (_e, cx) => actions(a, cx));
    wrap = wrap.child(Input.new(this.input).h(30).px(8).rounded(7).border_1().border_color(t.input).bg(t.background).text_size(12.5));
    const more = items.length > 10 ? ` · ${start + 1}–${start + list.length} of ${items.length}` : "";
    return card(t, { id: "picker-card", onWheel: (dy, cx) => { if (this.wheel(dy)) cx.notify(); }, onOutside: o.onOutside }).w_full().gap(4)
      .child(h_flex().px(6).pt(2).gap(8).items_center().child(div().flex_1().text_size(12).font_semibold().text_color(t.foreground).child(this.title))
        .when(Boolean(this.hint), (e) => e.child(div().text_size(11).text_color(t.dim).child(this.hint)))
        .child(div().id("picker-close").cursor_pointer().text_color(t.dim).on_click((_e, cx) => { cx.stop_propagation(); actions("herdrchat_escape", cx); }).child(icon("x", 12))))
      .child(wrap)
      .child(v_flex().gap(1).children(list.map((it, k) => {
        const i = start + k;
        let row = h_flex().id(`pick-${i}`).h(ROW_H).px(8).gap(10).items_center().rounded(6).cursor_pointer()
          .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { cx.stop_propagation(); this.choose(i, cx); })
          .child(div().w(12).flex_none().child(it.current ? icon("check", 12).text_color(t.accent) : div()))
          .child(div().flex_none().text_size(12.5).text_color(t.foreground).child(it.label))
          .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(it.detail ?? ""));
        if (i === this.sel) row = row.bg(t.selected);
        return row;
      })))
      .when(items.length === 0, (e) => e.child(div().px(8).py(6).text_size(12).text_color(t.dim).child("Nothing matches")))
      .child(div().px(8).text_size(10.5).text_color(t.dim).child(`${items.length}${more} · ↑↓ choose · Enter pick · Esc close`));
  }
}
