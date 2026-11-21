// The open extension dialog (state.dialog), drawn as a card above the
// composer: select → option buttons, confirm → Yes / No, input / editor →
// a field and Submit, questions → a QuestionsForm (questions.js). Esc cancels (main.js). Fields are made when the dialog
// first arrives (not in render): `DialogCard.sync` from the record handler.

import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, TextView } from "gpui-base";
import { alpha, icon } from "./util.js";
import { SPACE } from "./space.js";
import { toolIcon, toolTitle } from "./cards.js";
import { diffView } from "./rich.js";
import { QuestionsForm } from "./questions.js";
import { reasonPlaceholder } from "./reason.js";

export class DialogCard {
  constructor(onChange, focusComposer) {
    this.onChange = onChange; // the field's text changed (the debug dump shows it)
    this.focusComposer = focusComposer;
    this.id = null;
    this.field = null;
    this.form = null;
    this.textDialog = false;
    this.sel = 0;
  }

  // Called with the current dialog whenever state changes (task/event context).
  sync(dialog) {
    if ((dialog?.id ?? null) === this.id) return false;
    const hadKeyboard = this.textDialog || this.form?.otherFocus != null;
    this.field?.release?.();
    this.field = null;
    this.form?.release();
    this.form = null;
    this.id = dialog?.id ?? null;
    this.sel = 0;
    if (dialog?.method === "permission" && dialog.choices?.some((x) => x.kind === "deny")) {
      this.field = InputState.new({ placeholder: reasonPlaceholder(dialog.choices) });
    }
    if (dialog?.method === "questions") {
      this.form = new QuestionsForm(dialog.questions ?? [], { onChange: this.onChange, focusComposer: this.focusComposer });
    }
    if (dialog?.method === "input") this.field = InputState.new({ placeholder: dialog.placeholder ?? "", value: dialog.prefill ?? "" });
    if (dialog?.method === "editor") {
      this.field = TextareaState.new({ placeholder: dialog.placeholder ?? "", value: dialog.prefill ?? "" });
      this.field.set_auto_grow(3, 12);
    }
    this.field?.on?.("change", (_e, cx) => this.onChange?.(cx));
    this.textDialog = dialog?.method === "input" || dialog?.method === "editor";
    if (this.textDialog) this.field.focus();
    else if (hadKeyboard) this.focusComposer();
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

  // answer(kind, value, cx): kind "value" | "confirm" | "cancel" | "submit"
  view(d, pending, t, answer, c) {
    const btn = (id, label, primary, fn) => h_flex().id(id).h(28).px(12).items_center().rounded(7).cursor_pointer()
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium()
      .hover((s) => s.opacity(0.88)).on_click(fn).child(label);
    let body;
    if (d.method === "permission") return this.permissionView(d, pending, t, answer, c, btn);
    if (d.method === "questions") return this.frame(d, pending, t, answer, "help", "cancel").children(this.form.view(t, answer));
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
}
