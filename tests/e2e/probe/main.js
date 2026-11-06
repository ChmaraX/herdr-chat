// header-probe: a pane header for the E2E's probe layout (flows-fix1.sh,
// `split`). The app makes one copy per pane it draws; each records its pane
// and how often, and when, it rendered to <appHome>/probe/header-<pane>.json.
// A pane whose header never rendered was never drawn.
import { View, div } from "gpui-kit";
import { appHome, props } from "herdr";
import * as fs from "fs/promises";

export default class HeaderProbe extends View {
  init(_p, cx) {
    this.pane = props()?.pane ?? "unknown";
    this.renders = 0;
    cx.timer.every(300, () => this.write());
  }

  async write() {
    if (this.written === this.renders) return;
    this.written = this.renders;
    try {
      await fs.mkdir(`${appHome()}/probe`, { recursive: true });
      await fs.writeFile(`${appHome()}/probe/header-${this.pane}.json`, JSON.stringify({ pane: this.pane, renders: this.renders, lastRender: this.lastRender }));
    } catch {}
  }

  render() {
    this.renders++;
    this.lastRender = Date.now();
    return div().size_full().child(`pane ${this.pane}`);
  }
}
