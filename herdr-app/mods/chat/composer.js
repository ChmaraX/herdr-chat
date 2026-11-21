// The composer: a growing Textarea, its key bindings, the slash and @file
// menus, image chips and prompt history. The view owns what Enter, Esc and
// the menus do (main.js `actions`); this keeps the text state and the keys.
//
// Keys (spike d): the Textarea takes Up/Down/Enter before any on_key_down,
// but bindings in a context of ours *around* it ("HerdrChatMenu > Input") win,
// so the wrapper's key_context says which keys we want right now:
//   HerdrChatMenu     a menu is open: ↑ ↓ Enter Tab Esc drive it
//   HerdrChatEmpty    nothing typed (or a recalled prompt): ↑ ↓ walk history
//   HerdrChatComposer text typed: Enter sends (steers while working), Alt+Enter
//                  queues a follow-up, Shift+Enter is a newline
//   HerdrChatAsk      a permission card is open and nothing is typed: 1–9
//                  choose, ↑ ↓ move, Enter answers, Esc denies
//   HerdrChatQuestions the same for a questions card, and Space ticks
// Esc is ours in all of them.

import { div } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea } from "gpui-base";
import { alpha, fileChip, icon, thumbnail } from "./util.js";
import { follow } from "./menus.js";
import { keyHint } from "./shortcuts.js";
import { PLATFORM } from "./platform.js";

const CONTEXTS = ["HerdrChatMenu", "HerdrChatEmpty", "HerdrChatComposer", "HerdrChatAsk", "HerdrChatQuestions"];
const CARDS = ["HerdrChatAsk", "HerdrChatQuestions"];
const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];
export const ACTIONS = ["herdrchat_enter", "herdrchat_up", "herdrchat_down", "herdrchat_tab", "herdrchat_escape", "herdrchat_space", ...DIGITS.map((d) => `herdrchat_digit_${d}`)];

// The composer's bindings in the app's keymap (keymap.js says when).
export function bindComposerKeys(cx) {
  const b = [];
  for (const ctx of CONTEXTS) {
    // Sending (Enter steers, Alt+Enter queues a follow-up) is the `steer` and `followUp` shortcuts
    // (shortcuts.js), so the person can rebind them; in a menu and on an approval card Enter stays ours.
    if (ctx === "HerdrChatMenu" || CARDS.includes(ctx)) b.push({ keystroke: "enter", action: "herdrchat_enter", context: `${ctx} > Input` });
    b.push({ keystroke: "escape", action: "herdrchat_escape", context: ctx });
    // An Input's own Esc (a picker's filter field) would win over the context around it.
    b.push({ keystroke: "escape", action: "herdrchat_escape", context: `${ctx} > Input` });
  }
  for (const ctx of CARDS) for (const d of DIGITS) b.push({ keystroke: d, action: `herdrchat_digit_${d}`, context: `${ctx} > Input` });
  // Handled by the composer (pasteKey) and the picker's search field (menus.js), the two fields in these contexts.
  for (const ctx of CONTEXTS) for (const k of PLATFORM.pasteChords) b.push({ keystroke: k, action: "herdrchat_paste", context: `${ctx} > Input` });
  b.push({ keystroke: "space", action: "herdrchat_space", context: "HerdrChatQuestions > Input" });
  for (const ctx of ["HerdrChatMenu", "HerdrChatEmpty", ...CARDS]) {
    b.push({ keystroke: "up", action: "herdrchat_up", context: `${ctx} > Input` });
    b.push({ keystroke: "down", action: "herdrchat_down", context: `${ctx} > Input` });
  }
  b.push({ keystroke: "tab", action: "herdrchat_tab", context: "HerdrChatMenu" });
  // The dialog card: Enter submits an input; Esc cancels (an editor keeps Enter).
  b.push({ keystroke: "enter", action: "herdrchat_dialog_enter", context: "HerdrChatDialog > Input" });
  b.push({ keystroke: "escape", action: "herdrchat_dialog_escape", context: "HerdrChatDialog" });
  b.push({ keystroke: "escape", action: "herdrchat_dialog_escape", context: "HerdrChatEditor" });
  b.push({ keystroke: PLATFORM.submitChord, action: "herdrchat_dialog_enter", context: "HerdrChatEditor > Input" });
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

// A skill in the text is a pill (an inline token): its text is the command
// (`/skill:diagnose`), so the value reads as typed; the pill shows its name.
export const skillToken = (s) => ({ id: `skill:${s.command}`, text: `/${s.command}`, label: s.name });

// An image chip's thumbnail: a fixed box, so the composer keeps its height while the image loads.
const THUMB = { w: 64, h: 48 };

export class Composer {
  // `skills()`: the chat's skill commands, [{command, name}] (main.js).
  // `onRemoveChip(chip)`: an image chip's ✕.
  constructor(cx, { onChange, onPasteOther, onRemoveChip, placeholder, skills }) {
    this.ta = TextareaState.new({ placeholder: placeholder ?? "Message…" });
    this.ta.set_auto_grow(1, 10);
    this.skills = skills ?? (() => []);
    this.onRemoveChip = onRemoveChip;
    this.value = "";
    this.cursor = 0; // where the last edit ended: the state has no getter for it
    this.chips = []; // {path, size, label, pending}: `size` as the host reads it (protocol.md v3.7), else null
    this.menu = null; // {kind: "slash"|"files", query, items, sel, start}
    this.history = null; // {list, i, text}
    this.focused = false;
    this.ta.on("change", (_e, cx) => {
      const before = this.value;
      this.value = this.ta.value();
      this.cursor = editEnd(before, this.value);
      if (this.history && this.value !== this.history.text) this.history = null;
      this.pillTyped(before);
      onChange?.(cx);
    });
    this.ta.on("focus", (_e, cx) => { this.focused = true; cx.notify(); });
    this.ta.on("blur", (_e, cx) => { this.focused = false; cx.notify(); });
    this.onPasteOther = onPasteOther;
    this.ta.on("paste_other", (_e, cx) => this.onPasteOther?.(cx));
  }

  // One of PLATFORM.pasteChords: the clipboard's text where the cursor is, as Ctrl+V puts it (the
  // field's change event follows), else what a paste of no text does (an image).
  pasteKey(cx) {
    const text = cx.read_from_clipboard();
    if (text) this.ta.replace(text);
    else this.onPasteOther?.(cx);
  }

  focus() {
    this.ta.focus();
  }

  // The text, with its skill commands as pills.
  set(text) {
    const tokens = this.skillSpans(text);
    this.ta.set_value(tokens.length ? { text, tokens } : text);
    this.value = text;
    this.cursor = text.length;
    this.ta.set_selected_range({ start: text.length, end: text.length });
  }

  // Where `/command` of a known skill stands as a word in `text`.
  skillSpans(text) {
    const out = [];
    for (const s of this.skills()) {
      const word = `/${s.command}`;
      const re = new RegExp(`(^|\\s)${escapeRe(word)}(?=\\s|$)`, "g");
      for (const m of text.matchAll(re)) out.push({ range: { start: m.index + m[1].length, end: m.index + m[1].length + word.length }, token: skillToken(s) });
    }
    return out.sort((a, b) => a.range.start - b.range.start);
  }

  tokens() {
    return this.ta.tokens?.() ?? [];
  }

  // What to send: the skill pills become the message's leading `/command`s,
  // in the order they stand, and the rest follows. A pill inside the text
  // leaves its name there; the same skill twice runs once.
  message() {
    const text = this.value;
    const pills = this.skillPills();
    if (!pills.length) return text;
    let rest = "";
    let at = 0;
    for (const { range, token } of pills) {
      rest += text.slice(at, range.start);
      if (rest.trim()) rest += token.label ?? token.text.slice(1);
      at = range.end;
    }
    rest = (rest + text.slice(at)).trim();
    const lead = [...new Set(pills.map((p) => p.token.text))].join(" ");
    return `${lead}${rest ? ` ${rest}` : ""}`;
  }

  // The skill pills in the text, in order.
  skillPills() {
    return this.tokens().filter((t) => t.token.id.startsWith("skill:")).sort((a, b) => a.range.start - b.range.start);
  }

  // A skill command typed out in full, then a space or newline: a pill.
  pillTyped(before) {
    if (this.value.length !== before.length + 1 || !/\s/.test(this.value[this.cursor - 1] ?? "")) return;
    const head = this.value.slice(0, this.cursor - 1);
    const m = /(^|\s)\/(\S+)$/.exec(head);
    const s = m && this.skills().find((x) => x.command === m[2]);
    if (!s) return;
    const start = head.length - m[2].length - 1;
    if (this.tokens().some((t) => t.range.start < head.length && t.range.end > start)) return;
    this.ta.set_selected_range({ start, end: head.length });
    this.ta.replace_with_token(skillToken(s));
    this.ta.set_selected_range({ start: this.cursor, end: this.cursor });
    this.value = this.ta.value();
  }

  // A skill picked from the menu: a pill in place of the "/query" being typed, then a space.
  insertSkill(s) {
    const m = this.menu;
    const start = m?.start ?? 0;
    const end = start + 1 + (m?.query?.length ?? 0);
    this.ta.set_selected_range({ start, end });
    this.ta.replace_with_token(skillToken(s));
    this.ta.replace(" ");
    this.value = this.ta.value();
    this.cursor = start + skillToken(s).text.length + 1;
    this.menu = null;
  }

  // `pending`: a dropped file the host is still copying (main.js attachImage); it gets the thumbnail's box.
  addChip(path, { pending = false, size = null } = {}) {
    const chip = { path, size, label: path.split("/").pop(), pending };
    this.chips.push(chip);
    return chip;
  }

  removeChip(i) {
    const [ch] = this.chips.splice(i, 1);
    if (ch) this.onRemoveChip?.(ch);
  }

  clear() {
    this.set("");
    this.chips = [];
    this.menu = null;
    this.history = null;
  }

  context() {
    // A menu, or a select/confirm dialog while nothing is typed: ↑ ↓ Enter choose.
    if (this.menu?.items?.length || (this.dialogKeys && !this.value.trim())) return "HerdrChatMenu";
    if (this.askCard && !this.value.trim()) return this.askCard === "questions" ? "HerdrChatQuestions" : "HerdrChatAsk";
    if (!this.value.trim() || (this.history && this.value === this.history.text)) return "HerdrChatEmpty";
    return "HerdrChatComposer";
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

  // What the text asks for: "/cmd" alone (every command), "/name" being
  // typed anywhere else (skills only: the rest need the whole message), or
  // "@query" at the end.
  wanted() {
    const v = this.value;
    const inPill = (at) => this.tokens().some((t) => t.range.start <= at && t.range.end > at);
    const slash = /^\/([^\s]*)$/.exec(v);
    if (slash && !inPill(0)) return { kind: "slash", query: slash[1], start: 0 };
    const head = v.slice(0, this.cursor);
    const mid = /(^|\s)\/([^\s/]*)$/.exec(head);
    if (mid) {
      const start = head.length - mid[2].length - 1;
      if (!inPill(start)) return { kind: "slash", query: mid[2], start, skillsOnly: true };
    }
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
  // send / stop button. `c` is the view's render context (cards.js).
  view(t, c) {
    const chips = this.chips.map((ch, i) => {
      const x = div().id(`chip-x-${i}`).cursor_pointer().rounded(4).hover((s) => s.text_color(t.foreground).bg(t.hover))
        .on_click((_e, cx) => { cx.stop_propagation(); this.removeChip(i); cx.notify(); }).child(icon("x", 11));
      const thumb = ch.pending
        ? h_flex().id(`chip-${i}`).flex_none().rounded(10).border_1().border_color(t.border)
          .child(h_flex().w(THUMB.w).h(THUMB.h).items_center().justify_center().text_color(t.muted).child(icon("image", 16)))
        : thumbnail(`chip-${i}`, ch, THUMB.w, THUMB.h, c);
      if (thumb) {
        return div().relative().flex_none().child(thumb.tooltip(ch.label))
          .child(x.absolute().top(4).right(4).p(1).bg(t.raised).border_1().border_color(t.border).text_color(t.muted));
      }
      return fileChip(`chip-${i}`, ch.label, t).pr(6).bg(t.raised).child(x);
    });
    let wrap = div().id("composer-box").w_full().min_w(0).key_context(this.context());
    for (const a of ACTIONS) wrap = wrap.on_action(a, (_e, cx) => c.action(a, cx));
    if (PLATFORM.pasteChords.length) wrap = wrap.on_action("herdrchat_paste", (_e, cx) => this.pasteKey(cx));
    wrap = wrap.child(Textarea.new(this.ta).w_full().px(14).pt(12).pb(4).text_size(14).text_color(t.foreground).bg(alpha(t.background, 0))
      .token((tok, _cx) => skillPillEl(tok, t)));
    const working = c.working;
    const typed = Boolean(this.value.trim() || this.chips.length);
    const stop = working && !typed;
    // The composer has the keyboard here: a stop key the field keeps (Ctrl+C off macOS) wouldn't stop.
    const stopKey = keyHint("stop", { inFields: true });
    const btn = h_flex().id(stop ? "stop" : "send").flex_none().w(30).h(30).rounded(10).items_center().justify_center().cursor_pointer()
      .bg(stop ? t.foreground : typed ? t.solid : t.raised)
      .text_color(stop ? t.background : typed ? t.solid_foreground : t.dim)
      .hover((s) => s.opacity(0.85))
      .tooltip(stop ? `Stop (Esc${stopKey ? ` · ${stopKey}` : ""})` : working ? "Steer (Enter)" : "Send (Enter)")
      .on_click((_e, cx) => c.action(stop ? "herdrchat_stop" : "herdrchat_enter", cx))
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

// The pill a skill token draws in the text (cards.js draws the same in a sent message).
function skillPillEl(tok, t) {
  if (!tok.token.id.startsWith("skill:")) return null;
  const h = Math.max(18, Math.min(22, Math.round(tok.line_height) - 2));
  return h_flex().h(h).px(6).gap(4).items_center().rounded(5).text_size(12.5).font_medium()
    .bg(alpha(t.accent, tok.selected ? 0.3 : 0.14)).text_color(t.accent)
    .child(icon("book", 11.5)).child(tok.token.label ?? tok.token.text);
}

// Where an edit from `a` to `b` ends in `b`: after what was typed or pasted.
function editEnd(a, b) {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return b.length - s;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
