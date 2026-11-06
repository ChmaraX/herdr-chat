// chat-menu: Herdr's right-click menu (menu-base.js, the shipped mods/menu/main.js
// copied at install time) with two items on top for a terminal that is a
// sub-agent's chat host (labeled pi-chat.chat by bin/pi-chat-subagent): Open
// as chat (the chat dialog, in place of the Rust peek that shows its
// transcript) and Open as a chat tab. For a Pi TUI (idle or done, its session known from the
// herdr-chat-lock extension's pi-chat.session label), a sub-agent or a
// top-level TUI in its own pane: Continue as chat, which hands it over to a
// chat on that session (new-chat's continueAsChat, run by the layout's
// always-shown new-chat copy, since this menu closes first); disabled, with
// "Wait for the run to end", while Pi works.
// Every other menu is the shipped one, drawn by it. The layout's root
// terminal_menu points here (install.sh).

import Menu from "./menu-base.js";
import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { appHome, closeOverlay, nextCommand, openOverlay, props, readTextFile, run, terminals, theme } from "herdr";
import * as fs from "fs/promises";

function chatOf(p) {
  if (p?.tab !== "pane") return null;
  const t = terminals().find((x) => x.address === p.target?.terminal);
  const chat = t?.labels?.["pi-chat.chat"];
  return chat && t.state === "live" ? { chat, address: t.address, provider: t.labels["pi-chat.provider"] ?? null } : null;
}

const word = (s) => (typeof s === "string" ? s : s?.state ?? null);
const isPi = (t) => [t.program?.key, t.app, t.status?.app, t.report?.app, t.agent].includes("pi");

/** Why a terminal can't continue as a chat (null: it can; `working`: once its run ends). A copy of new-chat's. */
export function cantContinue(t) {
  if (!t || t.state !== "live") return { why: "not live" };
  if (t.labels?.["pi-chat.chat"]) return { why: "already a chat" };
  if (!t.labels?.["pi-chat.session"]) return { why: "no pi-chat.session label (the herdr-chat-lock extension labels it)" };
  if (!isPi(t)) return { why: "not Pi" };
  const st = word(t.status);
  if (st === "working" || st === "blocked") return { why: "Wait for the run to end", working: true };
  if (!["idle", "done"].includes(st)) return { why: `status ${st}` };
  return null;
}

/** A Pi TUI (sub-agent or top-level) the menu offers Continue as chat for: {address, working}, else null. */
export function tuiOf(p) {
  if (p?.tab !== "pane") return null;
  const t = terminals().find((x) => x.address === p.target?.terminal);
  const no = cantContinue(t);
  return !no ? { address: t.address, working: false } : no.working ? { address: t.address, working: true } : null;
}

// With <appHome>/data/pi-chat/debug/enabled (the E2E): the menu's terminal and why it isn't offered.
async function dumpDebug(p) {
  const dir = `${appHome()}/data/pi-chat/debug`;
  if ((await readTextFile(`${dir}/enabled`)) === null) return;
  const t = terminals().find((x) => x.address === p?.target?.terminal) ?? null;
  await fs.writeFile(`${dir}/chat-menu.json`, JSON.stringify({ props: p, terminal: t, cantContinue: t && cantContinue(t) }, null, 1));
}

export default class ChatMenu extends Menu {
  init(p, cx) {
    super.init(p, cx);
    cx.spawn(async () => { try { await dumpDebug(props()); } catch {} });
    // `chat-menu.pick:<n>`: what a click on the n-th chat item runs (E2E).
    cx.spawn(async () => {
      for (;;) {
        const c = await nextCommand();
        const m = /^pick:(\d+)$/.exec(c);
        const it = m && this.items()[Number(m[1])];
        if (it?.[1]) this.pick(it[1]);
      }
    });
  }

  chatItems(c) {
    const base = { chat: c.chat, ...(c.provider ? { provider: c.provider } : {}) };
    return [
      ["Open as chat", () => openOverlay({ mod: "chat", kind: "dialog", width: 0.8, height: 0.8, props: { ...base, peek: c.address } })],
      // The chat opens as the peek dialog, whose header has ↗ Open as tab (the parent's space, the host left under its parent).
      ["Open as a chat tab", () => openOverlay({ mod: "chat", kind: "dialog", width: 0.8, height: 0.8, props: { ...base, peek: c.address, then: "tab" } })],
    ];
  }

  // The items drawn above the shipped menu, for the terminal it's open on.
  items() {
    const c = chatOf(props());
    if (c) return this.chatItems(c);
    const tui = tuiOf(props());
    if (!tui) return [];
    // While Pi works: shown, disabled (no action), with why.
    return [tui.working ? ["Continue as chat", null, "Wait for the run to end"] : ["Continue as chat", () => run(`new-chat.continue:${tui.address}`)]];
  }

  pick(fn) {
    closeOverlay(props()?.overlay);
    run("overlay.close", { id: "terminal-peek" });
    fn();
  }

  render(cx) {
    const base = super.render(cx);
    const items = this.items();
    if (!items.length) return base;
    const t = theme();
    return v_flex().w_full().min_h(0).bg(t.popover)
      .child(v_flex().px(5).pt(5).text_size(12.8).children(items.map(([label, fn, note], i) => h_flex()
        .id(`chat-mi-${i}`).h(31).px(8).gap(9).rounded(7).items_center().text_color(fn ? t.foreground : t.dim)
        .when(Boolean(fn), (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => this.pick(fn)))
        .child(svg("mods/workspace-chrome/terminal.svg").size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().child(label))
        .when(Boolean(note), (e) => e.child(div().text_size(11).text_color(t.dim).child(note ?? "")))))
        .child(div().mx(7).mt(4).h(1).bg(t.border)))
      .child(base);
  }
}
