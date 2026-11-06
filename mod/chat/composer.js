// The composer: a growing Textarea, its key bindings, the slash and @file
// menus, image chips and prompt history. The view owns what Enter, Esc and
// the menus do (main.js `actions`); this keeps the text state and the keys.
//
// Keys (spike d): the Textarea takes Up/Down/Enter before any on_key_down,
// but bindings in a context of ours *around* it ("PiChatMenu > Input") win,
// so the wrapper's key_context says which keys we want right now:
//   PiChatMenu     a menu is open: ↑ ↓ Enter Tab Esc drive it
//   PiChatEmpty    nothing typed (or a recalled prompt): ↑ ↓ walk history
//   PiChatComposer text typed: Enter sends (steers while working), Alt+Enter
//                  queues a follow-up, Shift+Enter is a newline
//   PiChatAsk      a permission or questions card is open and nothing is
//                  typed: 1–9 choose, ↑ ↓ move, Enter answers, Esc denies
// Esc is ours in all three.

import { div } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea } from "gpui-base";
import { alpha, icon } from "./util.js";
import { follow } from "./menus.js";
import { keyHint } from "./shortcuts.js";

const CONTEXTS = ["PiChatMenu", "PiChatEmpty", "PiChatComposer", "PiChatAsk"];
const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];
export const ACTIONS = ["pichat_enter", "pichat_up", "pichat_down", "pichat_tab", "pichat_escape", ...DIGITS.map((d) => `pichat_digit_${d}`)];

// Once per build of the mod (module state resets on reload, like the keymap
// entries the old build installed may).
let bound = false;
export function bindKeys(cx) {
  if (bound) return;
  bound = true;
  const b = [];
  for (const ctx of CONTEXTS) {
    // Sending (Enter steers, Alt+Enter queues a follow-up) is the `steer` and `followUp` shortcuts
    // (shortcuts.js), so the person can rebind them; in a menu and on an approval card Enter stays ours.
    if (ctx === "PiChatMenu" || ctx === "PiChatAsk") b.push({ keystroke: "enter", action: "pichat_enter", context: `${ctx} > Input` });
    b.push({ keystroke: "escape", action: "pichat_escape", context: ctx });
    // An Input's own Esc (a picker's filter field) would win over the context around it.
    b.push({ keystroke: "escape", action: "pichat_escape", context: `${ctx} > Input` });
  }
  for (const d of DIGITS) b.push({ keystroke: d, action: `pichat_digit_${d}`, context: "PiChatAsk > Input" });
  for (const ctx of ["PiChatMenu", "PiChatEmpty", "PiChatAsk"]) {
    b.push({ keystroke: "up", action: "pichat_up", context: `${ctx} > Input` });
    b.push({ keystroke: "down", action: "pichat_down", context: `${ctx} > Input` });
  }
  b.push({ keystroke: "tab", action: "pichat_tab", context: "PiChatMenu" });
  // The dialog card: Enter submits an input; Esc cancels (an editor keeps Enter).
  b.push({ keystroke: "enter", action: "pichat_dialog_enter", context: "PiChatDialog > Input" });
  b.push({ keystroke: "escape", action: "pichat_dialog_escape", context: "PiChatDialog" });
  b.push({ keystroke: "escape", action: "pichat_dialog_escape", context: "PiChatEditor" });
  b.push({ keystroke: "cmd-enter", action: "pichat_dialog_enter", context: "PiChatEditor > Input" });
  cx.bind_keys(b);
}

// Fuzzy-ish rank: prefix > word start > substring > subsequence.
export function rank(name, q) {
  if (!q) return 1;
  const n = name.toLowerCase();
  q = q.toLowerCase();
  if (n.startsWith(q)) return 4 - n.length / 1000;
  if (n.split(/[-:_/ ]/).some((w) => w.startsWith(q))) return 3 - n.length / 1000;
  if (n.includes(q)) return 2 - n.length / 1000;
  let i = 0;
  for (const ch of n) if (ch === q[i]) i++;
  return i === q.length ? 1 - n.length / 1000 : 0;
}

export class Composer {
  constructor(cx, { onChange, onPasteOther, placeholder }) {
    this.ta = TextareaState.new({ placeholder: placeholder ?? "Message…" });
    this.ta.set_auto_grow(1, 10);
    this.value = "";
    this.chips = []; // {path, label}
    this.menu = null; // {kind: "slash"|"files", query, items, sel}
    this.history = null; // {list, i, text}
    this.focused = false;
    this.ta.on("change", (_e, cx) => {
      this.value = this.ta.value();
      if (this.history && this.value !== this.history.text) this.history = null;
      onChange?.(cx);
    });
    this.ta.on("focus", (_e, cx) => { this.focused = true; cx.notify(); });
    this.ta.on("blur", (_e, cx) => { this.focused = false; cx.notify(); });
    this.ta.on("paste_other", (_e, cx) => onPasteOther?.(cx));
    bindKeys(cx);
  }

  focus() {
    this.ta.focus();
  }

  set(text) {
    this.ta.set_value(text);
    this.value = text;
    this.ta.set_selected_range({ start: text.length, end: text.length });
  }

  clear() {
    this.set("");
    this.chips = [];
    this.menu = null;
    this.history = null;
  }

  context() {
    // A menu, or a select/confirm dialog while nothing is typed: ↑ ↓ Enter choose.
    if (this.menu?.items?.length || (this.dialogKeys && !this.value.trim())) return "PiChatMenu";
    if (this.askKeys && !this.value.trim()) return "PiChatAsk";
    if (!this.value.trim() || (this.history && this.value === this.history.text)) return "PiChatEmpty";
    return "PiChatComposer";
  }

  // Up/Down through the prompts sent before (newest first).
  recall(list, dir) {
    if (!list.length) return false;
    if (!this.history) {
      if (dir > 0) return false;
      this.history = { list, i: -1, draft: this.value };
    }
    const i = this.history.i - dir; // up = older = higher index
    if (i < 0) {
      const draft = this.history.draft ?? "";
      this.history = null;
      this.set(draft);
      return true;
    }
    if (i >= this.history.list.length) return false;
    this.history.i = i;
    this.history.text = this.history.list[i];
    this.set(this.history.text);
    return true;
  }

  // What the text asks for: "/cmd" at the start (no space yet), or "@query" at the end.
  wanted() {
    const v = this.value;
    const slash = /^\/([^\s]*)$/.exec(v);
    if (slash) return { kind: "slash", query: slash[1] };
    const at = /(^|\s)@([^\s@]*)$/.exec(v);
    if (at) return { kind: "files", query: at[2] };
    return null;
  }

  moveSel(d) {
    const m = this.menu;
    if (!m?.items?.length) return;
    m.sel = (m.sel + d + m.items.length) % m.items.length;
    follow(m);
  }

  // Replace "@query" at the end with "@path ".
  insertFile(path) {
    const v = this.value.replace(/(^|\s)@([^\s@]*)$/, (_m, pre) => `${pre}@${path} `);
    this.set(v);
    this.menu = null;
  }

  // The composer card (visual-v2.md §1): the text, image chips, then the
  // footer row `c.footer` (model, thinking, context; statuses, ⋯) and the
  // send / stop button.
  view(t, c) {
    const chips = this.chips.map((ch, i) => h_flex().id(`chip-${i}`).h(26).pl(8).pr(6).gap(6).items_center().rounded(6).bg(t.raised)
      .border_1().border_color(t.border).text_size(11.5).text_color(t.muted)
      .child(icon("image", 12)).child(div().max_w(220).truncate().child(ch.label))
      .child(div().id(`chip-x-${i}`).cursor_pointer().rounded(4).hover((s) => s.text_color(t.foreground).bg(t.hover))
        .on_click((_e, cx) => { this.chips.splice(i, 1); cx.notify(); }).child(icon("x", 11))));
    let wrap = div().id("composer-box").w_full().min_w(0).key_context(this.context());
    for (const a of ACTIONS) wrap = wrap.on_action(a, (_e, cx) => c.action(a, cx));
    wrap = wrap.child(Textarea.new(this.ta).w_full().px(14).pt(12).pb(4).text_size(14).text_color(t.foreground).bg(alpha(t.background, 0)));
    const working = c.working;
    const typed = Boolean(this.value.trim() || this.chips.length);
    const stop = working && !typed;
    const btn = h_flex().id(stop ? "stop" : "send").flex_none().w(30).h(30).rounded(10).items_center().justify_center().cursor_pointer()
      .bg(stop ? t.foreground : typed ? t.solid : t.raised)
      .text_color(stop ? t.background : typed ? t.solid_foreground : t.dim)
      .hover((s) => s.opacity(0.85))
      .tooltip(stop ? `Stop (Esc${keyHint("stop") ? ` · ${keyHint("stop")}` : ""})` : working ? "Steer (Enter)" : "Send (Enter)")
      .on_click((_e, cx) => c.action(stop ? "pichat_stop" : "pichat_enter", cx))
      .child(icon(stop ? "square" : "arrow-up", stop ? 11 : 15));
    return v_flex().w_full().rounded(14).border_1().border_color(this.focused ? alpha(t.accent, 0.55) : t.input).bg(t.surface)
      .when(this.focused, (e) => e.shadow_sm())
      .child(wrap)
      .when(chips.length > 0, (e) => e.child(h_flex().px(12).pb(6).gap(6).flex_wrap().children(chips)))
      .child(h_flex().h(42).pl(8).pr(6).gap(4).items_center()
        .child(h_flex().flex_1().min_w(0).gap(2).items_center().overflow_hidden().child(c.footer ?? div())) // clips, never under the button
        .child(btn));
  }
}
