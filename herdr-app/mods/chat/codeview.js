// A finished block (code card, or markdown that's no longer the streaming
// tail) as a retained nested view (cx.new): it rebuilds
// only when its props change (set_props), not on every render of the chat,
// so a long answer streaming under a few big highlighted blocks stays cheap.
// Its clicks go back to the chat view that owns it (`owners`, by `owner` id).
//
// A code card's lines scroll sideways by their scrollbar only, and select
// with the mouse: drag (double-click a word, triple-click a line), ⌘C copies,
// Esc or a press elsewhere clears. The lines are monospace, so a point is a
// line and a column: the column width is the widest line's width over its
// length.

import { View, div } from "gpui-kit";
import { v_flex, Scrollbar } from "gpui-base";
import { theme } from "herdr";
import { alpha, monoFont } from "./util.js";
import { LINE_H, codeCard, markdown } from "./rich.js";

export const owners = new Map(); // owner id → the chat view (main.js)

const COPY = "herdrchat_code_copy", CLEAR = "herdrchat_code_clear";
const PAD_X = 12, PAD_Y = 8;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const before = (a, b) => a.r < b.r || (a.r === b.r && a.c <= b.c);
const WORD = /[\p{L}\p{N}_$]/u;

// A code card's bindings in the app's keymap (keymap.js says when).
export function bindCodeKeys(cx) {
  cx.bind_keys([{ keystroke: "cmd-c", action: COPY, context: "HerdrChatCode" }, { keystroke: "ctrl-c", action: COPY, context: "HerdrChatCode" },
    { keystroke: "escape", action: CLEAR, context: "HerdrChatCode" }]);
}

export class CodeView extends View {
  init(props, cx) {
    this.p = props ?? {};
    if (this.p.markdown != null) return;
    this.focus = cx.focus_handle();
    this.sel = null; // {a, b}: where the press was and where the pointer is, as {r: line, c: column}
    this.dragging = false;
    this.linesW = 0; // the lines' own width (the widest)
    this.viewW = 0;
    owners.get(this.p.owner)?.codeSel?.set(this.p.key, this); // the E2E's chat.codesel command
  }

  update(props) {
    this.p = props ?? {};
  }

  // The selection as text (null when empty).
  selected(texts) {
    if (!this.sel) return null;
    const [s, e] = before(this.sel.a, this.sel.b) ? [this.sel.a, this.sel.b] : [this.sel.b, this.sel.a];
    if (s.r === e.r && s.c === e.c) return null;
    const out = [];
    for (let r = s.r; r <= e.r; r++) out.push((texts[r] ?? "").slice(r === s.r ? s.c : 0, r === e.r ? e.c : undefined));
    return out.join("\n");
  }

  // A redraw, and the chat's debug dump (main.js) rewritten with it.
  changed(cx) {
    cx.notify();
    owners.get(this.p.owner)?.debug?.mark();
  }

  clear(cx) {
    if (!this.sel) return;
    this.sel = null;
    this.dragging = false;
    this.changed(cx);
  }

  body(rendered, texts, t) {
    const id = `code-${this.p.owner}-${this.p.key}`;
    const longest = Math.max(1, ...texts.map((s) => s.length));
    const colW = this.linesW > 0 ? this.linesW / longest : 7.5;
    const at = (e) => {
      const p = e.local_position;
      if (!p) return null;
      const r = clamp(Math.floor((p.y - PAD_Y) / LINE_H), 0, texts.length - 1);
      return { r, c: clamp(Math.round((p.x - PAD_X) / colW), 0, (texts[r] ?? "").length) };
    };
    const word = (p) => {
      const s = texts[p.r] ?? "";
      let a = p.c, b = p.c;
      while (a > 0 && WORD.test(s[a - 1])) a--;
      while (b < s.length && WORD.test(s[b])) b++;
      return [{ r: p.r, c: a }, { r: p.r, c: b }];
    };
    // The selection, drawn behind the text: one band per line it covers.
    const marks = [];
    if (this.sel) {
      const [s, e] = before(this.sel.a, this.sel.b) ? [this.sel.a, this.sel.b] : [this.sel.b, this.sel.a];
      for (let r = s.r; r <= e.r; r++) {
        const c0 = r === s.r ? s.c : 0;
        const c1 = r === e.r ? e.c : (texts[r] ?? "").length + 1; // a line's end: its newline, one column
        if (c1 > c0) marks.push(div().absolute().top(PAD_Y + r * LINE_H).left(PAD_X + c0 * colW).w((c1 - c0) * colW).h(LINE_H).bg(t.selection ?? alpha(t.accent, 0.35)));
      }
    }
    // The lines' content, at least as wide as the card: a press anywhere on it selects.
    const content = v_flex().relative().flex_none().items_start().min_w("100%").px(PAD_X).py(PAD_Y).cursor_text()
      .on_mouse_down("left", (e, cx) => {
        const p = at(e);
        if (!p) return;
        this.focus?.focus();
        if (e.click_count >= 3) this.sel = { a: { r: p.r, c: 0 }, b: { r: p.r, c: (texts[p.r] ?? "").length } };
        else if (e.click_count === 2) { const [a, b] = word(p); this.sel = { a, b }; }
        else if (e.modifiers?.shift && this.sel) this.sel = { a: this.sel.a, b: p };
        else this.sel = { a: p, b: p };
        this.dragging = e.click_count < 2;
        this.changed(cx);
      })
      .on_mouse_move((e, cx) => {
        if (!this.dragging || !this.sel) return;
        const p = at(e);
        if (!p || (p.r === this.sel.b.r && p.c === this.sel.b.c)) return;
        this.sel = { a: this.sel.a, b: p };
        this.changed(cx);
      })
      .on_mouse_up("left", () => { this.dragging = false; })
      .on_hover((on) => { if (!on) this.dragging = false; })
      // The wheel never moves the lines (up/down scrolls the chat: overflow_scroll on both axes
      // keeps GPUI from turning it sideways); a sideways swipe goes nowhere.
      .on_scroll_wheel((e, cx) => { if (Math.abs(e.delta.x) > Math.abs(e.delta.y)) cx.stop_propagation(); })
      .children(marks)
      .child(v_flex().flex_none().items_start().children(rendered)
        .on_size_change((sz, cx) => { if (Math.abs(sz.width - this.linesW) > 0.5) { this.linesW = sz.width; this.changed(cx); } }));
    const wide = this.linesW + 2 * PAD_X > this.viewW + 0.5 && this.viewW > 0;
    return div().relative().w_full().key_context("HerdrChatCode").track_focus(this.focus)
      .on_action(COPY, (_e, cx) => {
        const text = this.selected(texts);
        if (text != null) owners.get(this.p.owner)?.copySelection(text, cx);
      })
      .on_action(CLEAR, (_e, cx) => { this.clear(cx); owners.get(this.p.owner)?.focusInput(); })
      .on_mouse_down_out((_e, cx) => this.clear(cx))
      .child(v_flex().id(id).w_full().items_start().overflow_scroll()
        .on_size_change((sz, cx) => { if (Math.abs(sz.width - this.viewW) > 0.5) { this.viewW = sz.width; this.changed(cx); } })
        .child(content))
      .when(wide, (el) => el.pb(10).child(div().absolute().left(0).right(0).bottom(0).h(10).child(Scrollbar.horizontal(id).mode("always"))));
  }

  render() {
    const p = this.p;
    if (p.markdown != null) return markdown(p.id, p.markdown);
    const t = theme();
    const key = p.key;
    const owner = () => owners.get(p.owner);
    const c = {
      t, mono: monoFont(), line: alpha(t.border, 0.7), codeBg: t.background,
      expanded: new Set(p.full ? [`code:${key}`] : []),
      copied: () => Boolean(p.copied),
      copy: (id, text, cx) => owner()?.copy(id, text, cx),
      toggle: (id, cx) => owner()?.toggle(id, cx),
      codeBody: (rendered, texts) => this.body(rendered, texts, t),
    };
    return codeCard(key, p.lang, p.code ?? "", p.lines, false, c);
  }
}
