// chat-agents: Herdr's agents list with one change. A sub-agent that is a chat
// host (bin/herdr-chat-subagent labels its terminal herdr-chat.chat) opens as the chat,
// in a dialog where and as large as the peek opens (0.8 × 0.8, dimmed, a click
// beside it closes it), instead of its TUI peek. Every other row, and every
// other sub-agent, is the shipped list's.
//
// agents-base.js is the shipped mods/agents/main.js, copied at install time
// (a mod may import only files in its own folder): install/mods.ts checks that
// it still defines peek() and that a sub-agent row's click goes through it,
// else it installs nothing. The layout's agents slot points here (install.sh).

import Agents from "./agents-base.js";
import { closeOverlay, nextCommand, openOverlay, props, run, terminals } from "herdr";

let shown = null; // the chat dialog this list opened last

export function openChatPeek(addr) {
  const t = terminals().find((x) => x.address === addr);
  const chat = t?.labels?.["herdr-chat.chat"];
  if (!chat) return false;
  run("overlay.close", { id: "terminal-peek" }); // a Rust peek open meanwhile
  if (shown) closeOverlay(shown);
  const provider = t.labels["herdr-chat.provider"];
  shown = openOverlay({ mod: "chat", kind: "dialog", width: 0.8, height: 0.8, props: { chat, peek: addr, ...(provider ? { provider } : {}) } });
  return true;
}

export default class ChatAgents extends Agents {
  init(p, cx) {
    super.init(p, cx);
    if (props()?.sortMenu) return;
    // `chat-agents.peek:<address>`: what a sub-agent row's click runs (this.peek), for E2E and keys.
    // `chat-agents.menu:<address>`: the right-click menu (chat-menu) for that terminal, as a right-click opens it.
    cx.spawn(async () => {
      for (;;) {
        const c = await nextCommand();
        if (c.startsWith("peek:")) this.peek(c.slice(5));
        else if (c.startsWith("menu:")) openOverlay({ mod: "chat-menu", kind: "popup", width: 240, props: { tab: "pane", target: { terminal: c.slice(5) } } });
      }
    });
  }

  peek(addr) {
    if (!openChatPeek(addr)) super.peek(addr);
  }
}
