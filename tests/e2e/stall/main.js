// E2E `stall`: when $HERDR_APP_HOME/stall-<k> appears (k = 1, 2, …) holding N, keeps the app's JS
// thread busy for N ms, then writes stalled-<k>. In 400 ms slices: Herdr stops a task that runs 500 ms.
import { View, div } from "gpui-kit";
import { appHome, readTextFile, writeTextFile } from "herdr";

export default class Staller extends View {
  init(_props, cx) {
    this.done = 0;
    this.error = "";
    cx.spawn(async (cx) => {
      for (;;) {
        await cx.sleep(100);
        const k = this.done + 1;
        let ms = 0;
        try {
          ms = Number(String(await readTextFile(`${appHome()}/stall-${k}`)).trim()) || 0;
        } catch {}
        if (!ms) continue;
        for (let left = ms; left > 0; left -= 400) {
          const t = Date.now();
          while (Date.now() - t < Math.min(400, left)) {}
          if (left > 400) await cx.sleep(5);
        }
        this.done = k;
        try {
          await writeTextFile(`${appHome()}/stalled-${k}`, String(ms), null);
        } catch (e) {
          this.error = String(e);
        }
        cx.notify();
      }
    });
  }
  render() {
    return div().child(`staller ${this.done} ${this.error}`);
  }
}
