// The open extension dialog (state.dialog), drawn as a card above the
// composer: select → option buttons, confirm → Yes / No, input / editor →
// a field and Submit. Esc cancels (main.js). Fields are made when the dialog
// first arrives (not in render): `DialogCard.sync` from the record handler.
//
// A questions card's cursor, `cur = {q, i}`, is question q, row i (its
// options, then its "Other" field). It is only a highlight: `picked` and the
// Other fields hold the answers.

import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, TextView } from "gpui-base";
import { alpha, icon } from "./util.js";
import { SPACE } from "./space.js";
import { toolIcon, toolTitle } from "./cards.js";
import { diffView } from "./rich.js";

export class DialogCard {
  constructor(onChange, onLeave) {
    this.onChange = onChange; // the field's text changed (the debug dump shows it)
    this.onLeave = onLeave; // an "Other" field hands the keyboard back to the composer
    this.id = null;
    this.field = null;
    this.sel = 0;
  }

  // Called with the current dialog whenever state changes (task/event context).
  sync(dialog) {
    if ((dialog?.id ?? null) === this.id) return false;
    this.field?.release?.();
    this.field = null;
    this.id = dialog?.id ?? null;
    this.sel = 0;
    this.picked = new Map(); // questions: question id → Set of option labels
    this.others = new Map(); // questions: question id → InputState ("Other")
    this.cur = { q: 0, i: 0 }; // questions: the highlighted row; the number keys answer question q
    if (dialog?.method === "permission" && dialog.choices?.some((x) => x.kind === "deny")) {
      this.field = InputState.new({ placeholder: "Why not? (optional, sent with Deny)" });
    }
    if (dialog?.method === "questions") {
      for (const q of dialog.questions ?? []) {
        this.picked.set(q.id, new Set());
        if (q.allowOther) {
          const f = InputState.new({ placeholder: "Other…" });
          f.on("change", () => this.onChange?.());
          this.others.set(q.id, f);
        }
      }
      if (dialog.questions?.length) this.cur.i = this.home(dialog.questions[0]);
    }
    if (dialog?.method === "input") this.field = InputState.new({ placeholder: dialog.placeholder ?? "", value: dialog.prefill ?? "" });
    if (dialog?.method === "editor") {
      this.field = TextareaState.new({ placeholder: dialog.placeholder ?? "", value: dialog.prefill ?? "" });
      this.field.set_auto_grow(3, 12);
    }
    this.field?.on?.("change", () => this.onChange?.());
    return true;
  }

  value() {
    return this.field?.value() ?? "";
  }

  // permission: the choice for a key (1-based number, "enter" = the primary
  // allow, "escape" = deny), with the deny reason when there is one.
  choiceFor(d, key) {
    const list = d.choices ?? [];
    let ch = null;
    if (typeof key === "number") ch = list[key - 1] ?? null;
    else if (key === "enter") ch = list.find((x) => x.kind === "allow") ?? list[this.sel] ?? null;
    else if (key === "escape") ch = list.find((x) => x.kind === "deny") ?? null;
    return ch ? this.choiceAnswer(ch) : null;
  }

  // Choice ch as an answer: a deny carries the reason typed in the field.
  choiceAnswer(ch) {
    const reason = ch.kind === "deny" ? this.value().trim() : "";
    return { choice: ch.id, ...(reason ? { message: reason } : {}) };
  }

  // questions: pick (or toggle, multi-select) option n of question qi, as a
  // click, a number key or Space does. A single-select answer moves on.
  pick(d, qi, n) {
    const q = d.questions?.[qi];
    if (!q?.options?.[n]) return false;
    this.choose(q, n);
    this.cur = { q: qi, i: n };
    if (!q.multiSelect) this.advance(d);
    this.onChange?.();
    return true;
  }

  choose(q, n) {
    const label = q.options[n].label;
    const set = this.picked.get(q.id);
    if (!q.multiSelect) set.clear();
    if (set.has(label)) set.delete(label); else set.add(label);
  }

  // questions: ↑ (-1) or ↓ (1), through every row of the card.
  move(d, step) {
    const rows = (d.questions ?? []).flatMap((q, qi) => Array.from({ length: this.rowCount(q) }, (_, i) => ({ q: qi, i })));
    const at = rows.findIndex((r) => r.q === this.cur.q && r.i === this.cur.i);
    this.cur = rows[(at + step + rows.length) % rows.length] ?? this.cur;
  }

  // questions: Space. Picks or ticks the highlighted option, or opens the Other field.
  tick(d) {
    const q = d.questions[this.cur.q];
    if (this.isOther(q, this.cur.i)) this.others.get(q.id).focus();
    else this.pick(d, this.cur.q, this.cur.i);
  }

  // questions: Enter. Answers question q with row i (multi-select: only while
  // nothing is ticked) and moves on to the next unanswered one. Returns the
  // answers once none is missing. An empty Other field takes the keyboard.
  enter(d) {
    const q = d.questions[this.cur.q];
    if (this.isOther(q, this.cur.i)) {
      const field = this.others.get(q.id);
      if (!field.value().trim()) {
        field.focus();
        return null;
      }
      this.onLeave?.();
    } else if (!q.multiSelect || !this.answered(q)) this.choose(q, this.cur.i);
    const out = this.answers(d);
    if (!out) this.advance(d);
    this.onChange?.();
    return out;
  }

  advance(d) {
    const qs = d.questions;
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

  rowCount(q) {
    return (q.options?.length ?? 0) + (this.others.has(q.id) ? 1 : 0);
  }

  isOther(q, i) {
    return i === (q.options?.length ?? 0);
  }

  otherText(q) {
    return this.others.get(q.id)?.value().trim() ?? "";
  }

  answered(q) {
    return this.picked.get(q.id).size > 0 || Boolean(this.otherText(q));
  }

  // questions: {questionId: label | [labels]}, or null while one is unanswered.
  answers(d) {
    const out = {};
    for (const q of d.questions ?? []) {
      if (!this.answered(q)) return null;
      const other = this.otherText(q);
      const set = [...this.picked.get(q.id), ...(other ? [other] : [])];
      out[q.id] = q.multiSelect ? set : other || set[0];
    }
    return out;
  }

  // answer(kind, value, cx): kind "value" | "confirm" | "cancel" | "submit"
  view(d, pending, t, answer, c) {
    const btn = (id, label, primary, fn) => h_flex().id(id).h(28).px(12).items_center().rounded(7).cursor_pointer()
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium()
      .hover((s) => s.opacity(0.88)).on_click(fn).child(label);
    let body;
    if (d.method === "permission") return this.permissionView(d, pending, t, answer, c, btn);
    if (d.method === "questions") return this.questionsView(d, pending, t, answer, c, btn);
    if (d.method === "select") {
      body = v_flex().gap(4).children((d.options ?? []).map((o, i) => h_flex().id(`dlg-opt-${i}`).min_h(30).px(10).py(5).gap(8).items_center()
        .rounded(7).border_1().border_color(i === this.sel ? t.accent : t.border).bg(t.background).cursor_pointer()
        .hover((s) => s.bg(t.hover)).on_click((_e, cx) => answer("value", o, cx))
        .child(div().flex_none().w(16).text_size(11).text_color(t.dim).child(i < 9 ? String(i + 1) : ""))
        .child(div().flex_1().text_size(12.5).text_color(t.foreground).child(o))))
        .child(div().text_size(11).text_color(t.dim).child("↑↓ choose · Enter pick (with the composer empty)"));
    } else if (d.method === "confirm") {
      body = h_flex().gap(8).child(btn("dlg-yes", "Yes", this.sel === 0, (_e, cx) => answer("confirm", true, cx)))
        .child(btn("dlg-no", "No", this.sel === 1, (_e, cx) => answer("confirm", false, cx)))
        .child(div().text_size(11).text_color(t.dim).child("↑↓ Enter"));
    } else {
      const field = d.method === "editor"
        ? Textarea.new(this.field).w_full().px(8).py(6).rounded(7).border_1().border_color(t.input).bg(t.background).text_size(12.5)
        : Input.new(this.field).h(30).px(8).rounded(7).border_1().border_color(t.input).bg(t.background).text_size(12.5);
      const wrap = div().id("dlg-field").key_context(d.method === "editor" ? "HerdrChatEditor" : "HerdrChatDialog")
        .on_action("herdrchat_dialog_enter", (_e, cx) => answer("submit", null, cx))
        .on_action("herdrchat_dialog_escape", (_e, cx) => answer("cancel", null, cx))
        .child(field);
      body = v_flex().gap(8).child(wrap)
        .child(h_flex().gap(8).child(btn("dlg-submit", "Submit", true, (_e, cx) => answer("submit", null, cx))));
    }
    const left = d.timeoutAt ? Math.max(0, Math.round((d.timeoutAt - Date.now()) / 1000)) : null;
    return v_flex().gap(8).p(12).rounded(10).border_1().border_color(t.blocked).bg(t.popover)
      .child(h_flex().gap(8).items_center()
        .child(icon("alert", 13).text_color(t.blocked))
        .child(div().flex_1().min_w(0).text_size(13).font_semibold().text_color(t.foreground).child(d.title))
        .when(pending > 1, (e) => e.child(div().text_size(11).text_color(t.dim).child(`${pending - 1} more waiting`)))
        .when(left != null, (e) => e.child(div().text_size(11).text_color(t.dim).child(`answers itself in ${left}s`)))
        .child(div().id("dlg-cancel").cursor_pointer().text_size(11).text_color(t.dim).hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => answer("cancel", null, cx)).child("Esc")))
      .when(Boolean(d.message), (e) => e.child(div().text_size(12.5).text_color(t.muted).child(d.message)))
      .child(body);
  }

  frame(d, pending, t, answer, iconName, cancelLabel) {
    const left = d.timeoutAt ? Math.max(0, Math.round((d.timeoutAt - Date.now()) / 1000)) : null;
    return v_flex().gap(SPACE.block).p(12).rounded(14).border_1().border_color(alpha(t.blocked, 0.7)).bg(t.popover).shadow_md()
      .child(h_flex().gap(8).items_center()
        .child(icon(iconName, 14).text_color(t.blocked))
        .child(div().flex_1().min_w(0).text_size(13).font_semibold().text_color(t.foreground).child(d.title || "The agent asks"))
        .when(pending > 1, (e) => e.child(div().text_size(11).text_color(t.dim).child(`${pending - 1} more waiting`)))
        .when(left != null, (e) => e.child(div().text_size(11).text_color(t.dim).child(`answers itself in ${left}s`)))
        .child(div().id("dlg-cancel").cursor_pointer().text_size(11).text_color(t.dim).hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => (cancelLabel === "deny" ? answer("choice", this.choiceFor(d, "escape"), cx) : answer("cancel", null, cx)))
          .child(cancelLabel === "deny" ? "Esc deny" : "Esc")));
  }

  // The agent wants to run a tool: what (like a tool card's header), why, and
  // the choices (allow = primary, deny = destructive), keys 1–n.
  permissionView(d, pending, t, answer, c) {
    const tl = d.tool;
    const choices = d.choices ?? [];
    const hasDeny = choices.some((x) => x.kind === "deny");
    const head = tl ? h_flex().h(34).px(10).gap(8).items_center().rounded(10).border_1().border_color(t.border).bg(t.surface)
      .child(icon(toolIcon(tl.detail), 13).text_color(t.dim))
      .child(toolTitle({ ...tl, id: `perm-${d.id}` }, tl.detail ?? { type: "generic", tool: tl.name }, c)) : null;
    // An edit to approve: its change, as an edit card shows it.
    const diff = tl?.detail?.diffLines?.length ? div().id(`dlg-diff-${d.id}`).max_h(240).overflow_y_scroll().child(diffView(`perm-${d.id}`, tl.detail.diffLines, c)) : null;
    const args = tl && !tl.detail && tl.args && tl.args !== "{}" ? div().px(10).py(6).rounded(8).bg(t.background).font_family(c.mono).text_size(11.5)
      .text_color(t.dim).max_h(120).overflow_hidden().child(tl.args) : null;
    const button = (ch, i) => {
      const allow = ch.kind === "allow", deny = ch.kind === "deny";
      const bg = allow ? t.solid : deny ? alpha(t.ansi1, 0.14) : t.raised;
      const fg = allow ? t.solid_foreground : deny ? t.ansi1 : t.foreground;
      return h_flex().id(`dlg-choice-${ch.id}`).h(30).px(12).gap(8).items_center().rounded(10).cursor_pointer()
        .border_1().border_color(allow ? t.solid : deny ? alpha(t.ansi1, 0.45) : t.input).bg(bg).text_color(fg)
        .text_size(12.5).font_medium().hover((s) => s.opacity(0.88)).tooltip(ch.description ?? ch.label)
        .on_click((_e, cx) => answer("choice", this.choiceAnswer(ch), cx))
        .child(div().text_size(10.5).opacity(0.65).child(String(i + 1))).child(ch.label);
    };
    let wrap = null;
    if (hasDeny && this.field) {
      wrap = div().id("dlg-field").key_context("HerdrChatDialog")
        .on_action("herdrchat_dialog_enter", (_e, cx) => answer("choice", this.choiceFor(d, "escape"), cx))
        .on_action("herdrchat_dialog_escape", (_e, cx) => answer("choice", this.choiceFor(d, "escape"), cx))
        .child(Input.new(this.field).h(30).px(10).rounded(8).border_1().border_color(t.input).bg(t.background).text_size(12.5));
    }
    return this.frame(d, pending, t, answer, "shield", hasDeny ? "deny" : "cancel")
      .children(head ? [head] : [])
      .children(diff ? [diff] : [])
      // A plan to approve (Claude's ExitPlanMode) is markdown: render it as such, scrolling when long.
      .when(Boolean(d.message), (e) => e.child(/\n|^#|\*\*/.test(d.message)
        ? div().id("dlg-message").max_h(260).overflow_y_scroll().px(10).py(8).rounded(8).bg(t.background).text_size(13).child(TextView.markdown(`dlg-md-${d.id}`, d.message))
        : div().text_size(12.5).text_color(t.muted).child(d.message)))
      .children(args ? [args] : [])
      .child(h_flex().gap(8).flex_wrap().children(choices.map(button)))
      .children(wrap ? [wrap] : [])
      .child(div().text_size(11).text_color(t.dim).child(`1–${choices.length} choose · Enter ${choices.find((x) => x.kind === "allow")?.label ?? "the first"}${hasDeny ? " · Esc deny" : ""} (with the composer empty)`));
  }

  // The agent asks the person: each question with its options (toggles when
  // multi-select), an "Other" field when allowed, then Submit.
  questionsView(d, pending, t, answer, c, btn) {
    const qs = d.questions ?? [];
    const ready = this.answers(d) != null;
    const blocks = qs.map((q, qi) => {
      const set = this.picked.get(q.id) ?? new Set();
      const current = qi === this.cur.q && qs.length > 1;
      const lit = (i) => qi === this.cur.q && i === this.cur.i;
      const otherRow = q.options?.length ?? 0;
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
            .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.pick(d, qi, i); cx.notify(); })
            .child(mark)
            .child(v_flex().flex_1().min_w(0)
              .child(div().text_size(12.5).text_color(t.foreground).child(o.label))
              .when(Boolean(o.description), (e) => e.child(div().text_size(11.5).text_color(t.dim).child(o.description))))
            .when(qi === this.cur.q, (e) => e.child(div().flex_none().text_size(10.5).text_color(t.dim).child(i < 9 ? String(i + 1) : "")));
        })))
        .when(this.others.has(q.id), (e) => e.child(div().id(`dlg-other-${q.id}`).key_context("HerdrChatDialog")
          .on_action("herdrchat_dialog_enter", (_e, cx) => {
            this.cur = { q: qi, i: otherRow };
            if (!this.otherText(q)) this.onLeave?.();
            else { const out = this.enter(d); if (out) answer("answers", out, cx); }
            cx.notify();
          })
          .on_action("herdrchat_dialog_escape", (_e, cx) => answer("cancel", null, cx))
          .child(Input.new(this.others.get(q.id)).h(30).px(10).rounded(8).border_1().border_color(lit(otherRow) ? t.accent : t.input)
            .bg(t.background).text_size(12.5))));
    });
    return this.frame(d, pending, t, answer, "help", "cancel")
      .child(v_flex().gap(SPACE.block).children(blocks))
      .child(h_flex().gap(10).items_center()
        .child(h_flex().id("dlg-submit").h(30).px(14).items_center().rounded(10).cursor_pointer()
          .bg(ready ? t.solid : t.raised).text_color(ready ? t.solid_foreground : t.dim).text_size(12.5).font_medium()
          .hover((s) => s.opacity(0.88)).on_click((_e, cx) => { const a = this.answers(d); if (a) answer("answers", a, cx); })
          .child("Submit"))
        .child(div().text_size(11).text_color(t.dim).child(this.questionsHint(d))));
  }

  questionsHint(d) {
    const qs = d.questions ?? [];
    const q = qs[this.cur.q];
    if (!q) return "Esc cancels";
    const n = Math.min(q.options?.length ?? 0, 9);
    const enter = this.isOther(q, this.cur.i) && !this.otherText(q) ? "Enter types an answer"
      : qs.every((x, j) => j === this.cur.q || this.answered(x)) ? "Enter submits"
      : q.multiSelect && this.answered(q) ? "Enter next" : "Enter picks";
    return ["↑↓ move", q.multiSelect && "Space ticks", enter, n > 1 ? `1–${n} choose` : n === 1 && "1 chooses", "Esc cancels"].filter(Boolean).join(" · ");
  }
}
