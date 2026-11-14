// A questions card's answers and keys (Claude AskUserQuestion, Codex
// requestUserInput, an MCP form), made by DialogCard.sync for one dialog.
//
// The cursor `cur = {q, i}` is question q, row i: its options, then its Other
// field. It is only a highlight: `picked` and the Other fields hold the answers.

import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { alpha, icon } from "./util.js";
import { SPACE } from "./space.js";

export class QuestionsForm {
  constructor(questions, { onChange, focusComposer }) {
    this.questions = questions;
    this.onChange = onChange;
    this.focusComposer = focusComposer;
    this.picked = new Map(); // question id → Set of option labels
    this.others = new Map(); // question id → InputState ("Other")
    for (const q of questions) {
      this.picked.set(q.id, new Set());
      if (q.allowOther) {
        const f = InputState.new({ placeholder: "Other…" });
        f.on("change", () => this.onChange?.());
        this.others.set(q.id, f);
      }
    }
    this.cur = { q: 0, i: questions.length ? this.home(questions[0]) : 0 };
  }

  release() {
    for (const f of this.others.values()) f.release();
  }

  // A key on the card: "up", "down", "space", "enter" or "escape", from the
  // composer or (`inOther`: its question's index) from an Other field.
  // Returns the answers when the card is done.
  key(action, { inOther = null } = {}) {
    if (inOther != null) this.cur = { q: inOther, i: this.optionCount(this.questions[inOther]) };
    if (action === "up" || action === "down") this.move(action === "up" ? -1 : 1);
    else if (action === "space") this.space();
    else if (action === "escape") this.focusComposer();
    else if (action === "enter") return this.enter(inOther != null);
    return null;
  }

  // A number key: option n (1-based) of the highlighted question.
  digit(n) {
    this.pick(this.cur.q, n - 1);
  }

  // Question qi's Other text, as typing it does (the command dialog:other).
  setOther(qi, text) {
    const q = this.questions[qi];
    if (q) this.others.get(q.id)?.set_value(text);
  }

  debugState() {
    return {
      picked: Object.fromEntries([...this.picked].map(([k, v]) => [k, [...v]])),
      others: Object.fromEntries([...this.others].map(([k, f]) => [k, f.value()])),
      cursor: this.cur,
    };
  }

  // What Enter does now: on an empty Other field, "type" (the field takes the
  // keyboard) or, from inside it, "back" (to the composer). Else it answers
  // the question, with option `choose` when there is one, then goes to the
  // "next" unanswered question or "submit"s the card.
  enterPlan(inField) {
    const q = this.questions[this.cur.q];
    if (!q) return { then: "submit", choose: null };
    const other = this.isOther(q, this.cur.i);
    if (other && !this.otherText(q)) return { then: inField ? "back" : "type", choose: null };
    const choose = other || (q.multiSelect && this.answered(q)) ? null : this.cur.i;
    const done = this.questions.every((x, j) => j === this.cur.q || this.answered(x));
    return { then: done ? "submit" : "next", choose };
  }

  enter(inField) {
    const plan = this.enterPlan(inField);
    const q = this.questions[this.cur.q];
    if (plan.then === "type") return this.others.get(q.id).focus(), null;
    if (plan.then === "back") return this.focusComposer(), null;
    if (plan.choose != null) this.setOrToggle(q, plan.choose);
    if (inField) this.focusComposer();
    this.onChange?.();
    if (plan.then === "submit") return this.answers();
    this.advance();
    return null;
  }

  space() {
    const q = this.questions[this.cur.q];
    if (!q) return;
    if (this.isOther(q, this.cur.i)) this.others.get(q.id).focus();
    else this.pick(this.cur.q, this.cur.i);
  }

  // Option n of question qi, as a click or a number key does. A single-select answer moves on.
  pick(qi, n) {
    const q = this.questions[qi];
    if (!q?.options?.[n]) return;
    this.setOrToggle(q, n);
    this.cur = { q: qi, i: n };
    if (!q.multiSelect) this.advance();
    this.onChange?.();
  }

  // Single-select: option n becomes the answer. Multi-select: n is ticked or unticked.
  setOrToggle(q, n) {
    const label = q.options[n].label;
    const set = this.picked.get(q.id);
    if (!q.multiSelect) set.clear();
    if (set.has(label)) set.delete(label); else set.add(label);
  }

  // ↑ (-1) or ↓ (1), through every row of the card.
  move(step) {
    const rows = this.questions.flatMap((q, qi) => Array.from({ length: this.rowCount(q) }, (_, i) => ({ q: qi, i })));
    if (!rows.length) return;
    const at = rows.findIndex((r) => r.q === this.cur.q && r.i === this.cur.i);
    this.cur = rows[(at + step + rows.length) % rows.length];
  }

  advance() {
    const qs = this.questions;
    for (let k = 1; k < qs.length; k++) {
      const qi = (this.cur.q + k) % qs.length;
      if (!this.answered(qs[qi])) {
        this.cur = { q: qi, i: this.home(qs[qi]) };
        return;
      }
    }
  }

  // Where the cursor lands in question q: its pick, else the option Claude
  // marks "(Recommended)", else the first row.
  home(q) {
    const opts = q.options ?? [];
    const picked = opts.findIndex((o) => this.picked.get(q.id).has(o.label));
    return picked >= 0 ? picked : Math.max(0, opts.findIndex((o) => o.label.endsWith("(Recommended)")));
  }

  optionCount(q) {
    return q.options?.length ?? 0;
  }

  rowCount(q) {
    return this.optionCount(q) + (this.others.has(q.id) ? 1 : 0);
  }

  isOther(q, i) {
    return this.others.has(q.id) && i === this.optionCount(q);
  }

  otherText(q) {
    return this.others.get(q.id)?.value().trim() ?? "";
  }

  answered(q) {
    return this.picked.get(q.id).size > 0 || Boolean(this.otherText(q));
  }

  // {questionId: label | [labels]}, or null while one is unanswered.
  answers() {
    const out = {};
    for (const q of this.questions) {
      if (!this.answered(q)) return null;
      const other = this.otherText(q);
      const set = [...this.picked.get(q.id), ...(other ? [other] : [])];
      out[q.id] = q.multiSelect ? set : other || set[0];
    }
    return out;
  }

  hint() {
    const q = this.questions[this.cur.q];
    if (!q) return "Esc cancels";
    const plan = this.enterPlan(false);
    const enter = plan.then === "type" ? "Enter types an answer" : plan.then === "submit" ? "Enter submits" : plan.choose == null ? "Enter next" : "Enter picks";
    const n = Math.min(this.optionCount(q), 9);
    return ["↑↓ move", q.multiSelect && "Space ticks", enter, n > 1 ? `1–${n} choose` : n === 1 && "1 chooses", "Esc cancels"].filter(Boolean).join(" · ");
  }

  // Each question with its options (toggles when multi-select), an "Other"
  // field when allowed, then Submit. answer(kind, value, cx) as DialogCard's.
  view(t, answer) {
    const qs = this.questions;
    const ready = this.answers() != null;
    const blocks = qs.map((q, qi) => {
      const set = this.picked.get(q.id);
      const current = qi === this.cur.q && qs.length > 1;
      const lit = (i) => qi === this.cur.q && i === this.cur.i;
      return v_flex().gap(6)
        .child(h_flex().gap(8).items_center()
          .when(Boolean(q.header), (e) => e.child(div().flex_none().h(18).px(6).rounded(6).flex().items_center().text_size(10.5)
            .text_color(current ? t.accent : t.dim).bg(alpha(current ? t.accent : t.muted, 0.14)).child(q.header)))
          .child(div().flex_1().min_w(0).text_size(13).text_color(t.foreground).child(q.question))
          .when(q.multiSelect, (e) => e.child(div().text_size(11).text_color(t.dim).child("choose any"))))
        .child(v_flex().gap(4).children((q.options ?? []).map((o, i) => {
          const on = set.has(o.label);
          const mark = q.multiSelect
            ? div().flex_none().w(14).h(14).rounded(4).border_1().border_color(on ? t.accent : t.input).bg(on ? t.accent : alpha(t.background, 0))
              .flex().items_center().justify_center().child(on ? icon("check", 10).text_color(t.accent_foreground ?? t.background) : div())
            : div().flex_none().w(14).h(14).rounded_full().border_1().border_color(on ? t.accent : t.input)
              .flex().items_center().justify_center().child(on ? div().w(6).h(6).rounded_full().bg(t.accent) : div());
          return h_flex().id(`dlg-q-${q.id}-${i}`).min_h(32).px(10).py(5).gap(10).items_center().rounded(10)
            .border_1().border_color(lit(i) ? t.accent : on ? alpha(t.accent, 0.4) : t.border).bg(on ? alpha(t.accent, 0.08) : lit(i) ? t.hover : t.background).cursor_pointer()
            .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.pick(qi, i); cx.notify(); })
            .child(mark)
            .child(v_flex().flex_1().min_w(0)
              .child(div().text_size(12.5).text_color(t.foreground).child(o.label))
              .when(Boolean(o.description), (e) => e.child(div().text_size(11.5).text_color(t.dim).child(o.description))))
            .when(qi === this.cur.q, (e) => e.child(div().flex_none().text_size(10.5).text_color(t.dim).child(i < 9 ? String(i + 1) : "")));
        })))
        .when(this.others.has(q.id), (e) => e.child(div().id(`dlg-other-${q.id}`).key_context("HerdrChatDialog")
          .on_action("herdrchat_dialog_enter", (_e, cx) => {
            const out = this.key("enter", { inOther: qi });
            if (out) answer("answers", out, cx);
            cx.notify();
          })
          .on_action("herdrchat_dialog_escape", (_e, cx) => answer("cancel", null, cx))
          .child(Input.new(this.others.get(q.id)).h(30).px(10).rounded(8).border_1().border_color(lit(this.optionCount(q)) ? t.accent : t.input)
            .bg(t.background).text_size(12.5))));
    });
    return [
      v_flex().gap(SPACE.block).children(blocks),
      h_flex().gap(10).items_center()
        .child(h_flex().id("dlg-submit").h(30).px(14).items_center().rounded(10).cursor_pointer()
          .bg(ready ? t.solid : t.raised).text_color(ready ? t.solid_foreground : t.dim).text_size(12.5).font_medium()
          .hover((s) => s.opacity(0.88)).on_click((_e, cx) => { const a = this.answers(); if (a) answer("answers", a, cx); })
          .child("Submit"))
        .child(div().text_size(11).text_color(t.dim).child(this.hint())),
    ];
  }
}
