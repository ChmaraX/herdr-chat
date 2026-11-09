// The bar over an agent's terminal that a chat opened in a dialog (main.js
// startHandoff): /login, /settings, /tui, /tree… The dialog is a layout
// overlay, this bar over the terminal; it closes itself when the terminal
// ends. Esc goes to the terminal, so the bar's buttons are the way out.
//
//   Done (a utility)        ends the terminal: nothing in it is the chat's
//   Back to chat (session)  ends the agent's TUI, after a confirm: the chat
//                           takes the session back (the host resumes it)
//   Open as tab (session)   gives the terminal a tab of its own and closes the dialog
//
// props().termbar: {terminal, title, provider, mode: "utility" | "session", agent}

import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { closeOverlay, nextCommand, props, run, theme } from "herdr";
import { providerIcon } from "./util.js";

export class TermBar {
  constructor(p, cx) {
    this.p = p;
    this.overlay = props()?.overlay ?? null;
    this.confirm = false;
    // The buttons by command too (`chat.termbar:<done|back|quit|cancel|tab>`, for the E2E).
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (!c.startsWith("termbar:")) continue;
        this.act(c.slice(8));
        cx.notify();
      }
    });
  }

  act(what) {
    const p = this.p;
    if (what === "done" || what === "quit") this.end();
    else if (what === "back") this.confirm = true;
    else if (what === "cancel") this.confirm = false;
    else if (what === "tab") {
      run("terminal.keep", { terminal: p.terminal, place: "tab" });
      this.close();
    }
  }

  close() {
    if (this.overlay) closeOverlay(this.overlay);
  }

  end() {
    run("terminal.kill", { terminal: this.p.terminal });
    this.close();
  }

  render(cx) {
    const t = theme();
    const p = this.p;
    const session = p.mode === "session";
    const btn = (id, label, onClick, strong = false) => h_flex().id(id).flex_none().h(26).px(10).items_center().rounded(6).cursor_pointer()
      .text_size(12).text_color(strong ? t.foreground : t.muted).when(strong, (e) => e.bg(t.raised))
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { onClick(); cx.notify(); }).child(label);
    const hint = this.confirm
      ? `Quit ${p.agent}'s terminal UI? What it's doing there stops.`
      : session ? `${p.agent} has this session while it's open here. Quit it, or come back to the chat.` : `Esc and keys go to ${p.agent}. Done closes it.`;
    const buttons = this.confirm
      ? [btn("tb-quit", "Quit it", () => this.act("quit"), true), btn("tb-cancel", "Cancel", () => this.act("cancel"))]
      : session
        ? [btn("tb-tab", "↗ Open as tab", () => this.act("tab")), btn("tb-back", "Back to chat", () => this.act("back"), true)]
        : [btn("tb-done", "Done", () => this.act("done"), true)];
    return h_flex().size_full().px(12).gap(10).items_center().bg(t.surface ?? t.background).border_b_1().border_color(t.border)
      .child(providerIcon(p.provider, 14))
      .child(div().flex_none().text_size(13).font_medium().text_color(t.foreground).child(p.title))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(this.confirm ? t.blocked ?? t.muted : t.dim).child(hint))
      .children(buttons);
  }
}
