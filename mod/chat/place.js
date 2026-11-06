// Where a chat lives, for certain. `props()` names no pane and `panes()`
// lists mod panes without their props, so `focused()` was the only clue,
// and a chat that started while another tab had focus took that tab (two
// hosts in one tab, a Pi tab with Claude's icon). The core's layout
// document ("herdr-app", the one the app saves) has every mod pane with its
// props: the pane whose props name this chat is this chat's.

import { exec } from "herdr";
import { getDoc } from "./hostpane.js";

const REQ = [
  '{"jsonrpc":"2.0","id":1,"method":"hello","params":{"generation":1}}',
  '{"jsonrpc":"2.0","id":2,"method":"doc.get","params":{"name":"herdr-app"}}',
];

// The app's layout document, or null (no hc, no core).
export async function readDoc() {
  return (await getDoc()).value;
}

// Every mod pane of `mod`: [{pane, tab, space, props}].
export function modPanes(doc, mod) {
  const out = [];
  const walk = (space, tab, n) => {
    const c = n?.content;
    if (c?.mod === mod) out.push({ pane: n.id, tab, space, props: c.props ?? {} });
    for (const ch of n?.children ?? []) walk(space, tab, ch);
  };
  for (const s of doc?.spaces ?? []) for (const t of s.tabs ?? []) walk(s.id, t.id, t.root);
  return out;
}

// The view's close() can't tell a closed pane from the app quitting
// (panes() still lists the pane then). The chat's pane closed alone leaves
// the host's hidden pane in the tab (nothing drawn, the tab stays): a
// detached check, a moment later, ends the host when the layout document no
// longer has this chat's pane; its pane, and with it the tab, then goes.
// After a quit the pane is still in the document, and the host lives on.
// Only for a host from before host/panewatch.ts (no pi-chat.reaps label):
// a current host watches the document's events and closes its own pane.
export function reapLater(chat, terminal) {
  const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
  const script = [
    "sleep 2",
    `doc=$(printf '%s\\n' '${REQ[0]}' '${REQ[1]}' | hc connect | tail -1)`,
    `case "$doc" in *'"spaces"'*) ;; *) exit 0 ;; esac`,
    `case "$doc" in *'"chat":"'${q(chat)}'"'*) exit 0 ;; esac`,
    `hc kill ${q(terminal)}`,
  ].join("\n");
  return exec("/bin/sh", ["-c", `(${script}) >/dev/null 2>&1 </dev/null &`]);
}
