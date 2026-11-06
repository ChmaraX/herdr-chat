// A finished block (code card, or markdown that's no longer the streaming
// tail) as a retained nested view (cx.new): it rebuilds
// only when its props change (set_props), not on every render of the chat,
// so a long answer streaming under a few big highlighted blocks stays cheap.
// Its clicks go back to the chat view that owns it (`owners`, by `owner` id).

import { View } from "gpui-kit";
import { theme } from "herdr";
import { alpha, monoFont } from "./util.js";
import { codeCard, markdown } from "./rich.js";

export const owners = new Map(); // owner id → the chat view (main.js)

export class CodeView extends View {
  init(props) {
    this.p = props ?? {};
  }

  update(props) {
    this.p = props ?? {};
  }

  render() {
    const p = this.p;
    if (p.markdown != null) return markdown(p.id, p.markdown);
    const t = theme();
    const key = p.key;
    const owner = () => owners.get(p.owner);
    const c = {
      t, mono: monoFont(), line: alpha(t.border, 0.7), codeBg: t.background,
      expanded: new Set(p.full ? [`code:${key}`] : []),
      copied: () => Boolean(p.copied),
      copy: (id, text, cx) => owner()?.copy(id, text, cx),
      toggle: (id, cx) => owner()?.toggle(id, cx),
    };
    return codeCard(key, p.lang, p.code ?? "", p.lines, false, c);
  }
}
