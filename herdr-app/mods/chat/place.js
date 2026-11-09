// Where a chat lives, for certain. `props()` names no pane and `panes()`
// lists mod panes without their props, so `focused()` was the only clue,
// and a chat that started while another tab had focus took that tab (two
// hosts in one tab, a Pi tab with Claude's icon). The core's layout
// document ("herdr-app", the one the app saves) has every mod pane with its
// props: the pane whose props name this chat is this chat's.

import { getDoc } from "./hostpane.js";

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
