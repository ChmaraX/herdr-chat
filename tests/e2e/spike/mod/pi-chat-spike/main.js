// pi-chat spike (throwaway, kept for the record of the measurements).
// One mod, four experiments by props.mode:
//   net       (a) a net socket reading a JSONL stream for minutes
//   list      (b) list() of 150 markdown items, the last one streaming
//   flex      (b) the same items as ordinary elements in one scroll area
//   measured  (b) the same items in an own scroller: only visible rows,
//                 heights measured with on_size_change, anchored to the bottom
//   textarea  (d) Textarea: Enter, Shift+Enter, auto-grow, key interception
// Results go to <appHome>/data/spike/<mode>.json (once a second).
// Commands (pi-chat-spike.<c>): stream, stop, fps, expand:<id>, up, bottom,
// menu:on, menu:off, focus, dump.

import { View, div, list } from "gpui-kit";
import { v_flex, h_flex, TextView, Scrollbar, VirtualListScrollHandle, TextareaState, Textarea } from "gpui-base";
import { fps_monitor } from "gpui-fps";
import { appHome, nextCommand, props, theme, agents, terminals, spaces, panes, readTextFile } from "herdr";
import net from "net";
import * as fs from "fs/promises";
import { Buffer } from "buffer";

const now = () => (globalThis.performance?.now ? globalThis.performance.now() : Date.now());
const DIR = () => `${appHome()}/data/spike`;

// ---- content -------------------------------------------------------------------
const WORDS = "the host coalesces records and the mod renders only what changed since the last flush while pi keeps streaming tokens".split(" ");
function para(seed, n) {
  let s = "";
  for (let i = 0; i < n; i++) s += WORDS[(seed * 7 + i * 13) % WORDS.length] + (i % 11 === 10 ? ". " : " ");
  return s.trim() + ".";
}
function sample(i) {
  const kind = i % 5;
  if (kind === 0) return { id: `u${i}`, kind: "user", text: para(i, 12) };
  if (kind === 1) return { id: `a${i}`, kind: "assistant", text: `## Step ${i}\n\n${para(i, 40)}\n\n- **first** point: ${para(i + 1, 8)}\n- second point with \`code\`\n- third point\n\n${para(i + 2, 25)}` };
  if (kind === 2) return { id: `t${i}`, kind: "tool", title: `$ rg -n pattern src/${i}.ts`, text: Array.from({ length: 30 }, (_, k) => `src/file${k}.ts:${k * 3}: const value${k} = compute(${k});`).join("\n") };
  if (kind === 3) return { id: `a${i}`, kind: "assistant", text: `Here is the change:\n\n\`\`\`ts\nexport function f${i}(x: number): number {\n  const y = x * ${i};\n  if (y > 10) {\n    return y - 1;\n  }\n  return y + 1;\n}\n\`\`\`\n\n${para(i, 30)}\n\n1. one\n2. two\n3. three` };
  return { id: `k${i}`, kind: "thinking", text: para(i, 60) };
}
const STREAM_CHUNKS = (() => {
  const full = `# A long answer\n\n${para(1, 80)}\n\n\`\`\`js\n${Array.from({ length: 40 }, (_, k) => `console.log("line ${k}", ${k} * 2);`).join("\n")}\n\`\`\`\n\n${Array.from({ length: 30 }, (_, k) => `- item ${k}: ${para(k, 14)}`).join("\n")}\n\n${para(3, 200)}\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n${para(5, 300)}`;
  const out = [];
  for (let i = 0; i < full.length; i += 40) out.push(full.slice(0, i + 40));
  return out;
})();

// ---- stats ----------------------------------------------------------------------
class Stats {
  constructor() { this.reset(); }
  reset() {
    this.renders = 0; this.renderMs = 0; this.renderMax = 0;
    this.items = 0; this.itemMs = 0;
    this.ticks = []; this.lastTick = 0; this.sizeChanges = 0;
    this.started = Date.now();
  }
  tick() {
    const t = now();
    if (this.lastTick) this.ticks.push(t - this.lastTick);
    this.lastTick = t;
  }
  summary() {
    const d = [...this.ticks].sort((a, b) => a - b);
    const q = (p) => (d.length ? d[Math.min(d.length - 1, Math.floor(p * d.length))] : null);
    const secs = (Date.now() - this.started) / 1000;
    return {
      seconds: +secs.toFixed(1), renders: this.renders, rendersPerSec: +(this.renders / secs).toFixed(1),
      renderMsAvg: this.renders ? +(this.renderMs / this.renders).toFixed(3) : null, renderMsMax: +this.renderMax.toFixed(3),
      renderMsPerSec: +(this.renderMs / secs).toFixed(2),
      itemCalls: this.items, itemMsPerSec: +(this.itemMs / secs).toFixed(2), itemCallsPerRender: this.renders ? +(this.items / this.renders).toFixed(1) : null,
      sizeChanges: this.sizeChanges,
      tickMs: { n: d.length, p50: q(0.5), p95: q(0.95), max: d.length ? d[d.length - 1] : null },
    };
  }
}

export default class Spike extends View {
  init(_props, cx) {
    this.mode = props()?.mode ?? "list";
    this.stats = new Stats();
    this.expanded = new Set();
    this.out = {};
    this.items = Array.from({ length: 149 }, (_, i) => sample(i));
    this.items.push({ id: "stream", kind: "assistant", text: "" });
    this.chunk = 0;
    this.streaming = false;
    this.handle = VirtualListScrollHandle.new();
    this.focus = cx.focus_handle();
    this.sticky = true;
    this.top = 0;
    this.viewH = 0;
    this.heights = new Map();
    // show_fps_monitor() needs a ShellRoot window, which Herdr's isn't: the
    // HUD element goes in the mod's own tree (props.fps).
    this.fps = Boolean(props()?.fps);
    if (this.mode === "net") this.net(cx);
    if (this.mode === "textarea") this.textarea(cx);
    cx.timer.every(1000, (cx) => this.save(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        this.command(c, cx);
        cx.notify();
      }
    });
  }

  save(cx) {
    const body = { mode: this.mode, at: Date.now(), stats: this.stats.summary(), ...this.out };
    if (this.mode === "list" || this.mode === "flex" || this.mode === "measured") {
      body.streamLen = this.items[this.items.length - 1].text.length;
      body.expanded = [...this.expanded];
      body.sticky = this.sticky;
      body.top = this.top; body.viewH = this.viewH;
    }
    body.live = {
      agents: agents().map((a) => ({ address: a.address, status: a.status, app: a.app, tab: a.tab, pane: a.pane })),
      terminals: terminals().map((t) => ({ address: t.address, status: t.status, report: t.report, labels: t.labels, parent: t.parent, state: t.state })),
      tabs: spaces().flatMap((s) => s.tabs.map((t) => ({ space: s.id, id: t.id, name: t.name, status: t.status, panes: t.panes }))),
      panes: panes().map((p) => ({ pane: p.pane, tab: p.tab, terminal: p.terminal, mod: p.mod ?? null, status: p.status })),
    };
    cx.spawn(async () => {
      await fs.mkdir(DIR(), { recursive: true });
      await fs.writeFile(`${DIR()}/${this.mode}${props()?.tag ? "-" + props().tag : ""}.json`, JSON.stringify(body, null, 1));
    });
  }

  command(c, cx) {
    if (c === "stream") {
      this.stats.reset();
      this.chunk = 0;
      this.streaming = true;
      this.sticky = true;
      if (!this.streamTimer) {
        this.streamTimer = true;
        cx.timer.every(50, (cx) => {
          if (!this.streaming) return;
          this.stats.tick();
          const last = this.items[this.items.length - 1];
          last.text = STREAM_CHUNKS[Math.min(this.chunk++, STREAM_CHUNKS.length - 1)];
          if (this.chunk >= STREAM_CHUNKS.length) this.chunk = 0; // loop forever while streaming
          if (this.mode === "list" && this.sticky) this.handle.scroll_to_bottom();
          cx.notify();
        });
      }
    } else if (c === "stop") this.streaming = false;
    else if (c === "fps") this.fps = true;
    else if (c.startsWith("expand:")) this.toggle(c.slice(7));
    else if (c === "up") { this.sticky = false; this.top = Math.max(0, this.top - 600); if (this.mode === "list") this.handle.scroll_to_item(100, "top"); }
    else if (c === "bottom") { this.sticky = true; if (this.mode === "list") this.handle.scroll_to_bottom(); }
    else if (c === "menu:on") { this.menu = true; this.ta?.focus(); }
    else if (c === "menu:off") { this.menu = false; this.ta?.focus(); }
    else if (c === "focus") this.ta?.focus();
    else if (c === "dump") this.save(cx);
  }

  toggle(id) {
    if (this.expanded.has(id)) this.expanded.delete(id);
    else this.expanded.add(id);
    (this.out.clicks ??= []).push({ id, at: Date.now(), expanded: this.expanded.has(id) });
  }

  // ---- (a) net -------------------------------------------------------------------
  net(cx) {
    const o = (this.out.net = { connects: 0, failures: 0, records: 0, bytes: 0, gaps: 0, dupes: 0, bad: 0, big: 0, unicodeOk: 0, unicodeBad: 0, lat: [], latMax: 0, byConn: {}, events: [] });
    cx.spawn(async (cx) => {
      let backoff = 250;
      for (;;) {
        let sock = null;
        try {
          const port = Number(((await readTextFile(`${DIR()}/port`)) ?? "").trim());
          if (!port) throw new Error("no port file");
          sock = await net.connect("127.0.0.1", port);
          o.connects++;
          o.events.push({ at: Date.now(), ev: "connected", port });
          backoff = 250;
          let buf = new Uint8Array(0);
          for (;;) {
            const chunk = await sock.read(1 << 20);
            if (chunk === null) break;
            o.bytes += chunk.length;
            const merged = new Uint8Array(buf.length + chunk.length);
            merged.set(buf); merged.set(chunk, buf.length);
            buf = merged;
            let start = 0;
            for (let i = 0; i < buf.length; i++) {
              if (buf[i] !== 10) continue;
              const line = Buffer.from(buf.subarray(start, i)).toString("utf8");
              start = i + 1;
              let r;
              try { r = JSON.parse(line); } catch { o.bad++; continue; }
              o.records++;
              const c = (o.byConn[r.conn] ??= { last: -1, n: 0 });
              if (r.seq === c.last + 1) {} else if (r.seq <= c.last) o.dupes++; else o.gaps += r.seq - c.last - 1;
              c.last = r.seq; c.n++;
              const lat = Date.now() - r.ts;
              if (o.records % 10 === 0) o.lat.push(lat);
              if (lat > o.latMax) o.latMax = lat;
              if (r.kind === "big") o.big++;
              if (r.kind === "unicode") { if (r.pad === "line\u2028sep\u2029para — ünïcødé 🚀 中文") o.unicodeOk++; else o.unicodeBad++; }
            }
            buf = buf.slice(start);
          }
          o.events.push({ at: Date.now(), ev: "eof" });
        } catch (e) {
          o.failures++;
          if (o.events.length < 200) o.events.push({ at: Date.now(), ev: "error", e: String(e?.message ?? e) });
        } finally {
          try { sock?.close(); } catch {}
        }
        if (o.lat.length > 20000) o.lat = o.lat.slice(-10000);
        await cx.sleep(backoff);
        backoff = Math.min(2000, backoff * 2);
      }
    });
  }

  // ---- (d) textarea --------------------------------------------------------------
  textarea(cx) {
    const o = (this.out.textarea = { events: [], keys: [], heights: [] });
    this.ta = TextareaState.new({ placeholder: "Message pi…" });
    this.ta.set_auto_grow(1, 8);
    const log = (ev) => (e, _cx) => o.events.push({ ev, at: Date.now(), value: this.ta.value(), shift: e?.shift ?? null, secondary: e?.secondary ?? null });
    for (const ev of ["change", "submit", "focus", "blur", "paste_other"]) this.ta.on(ev, log(ev));
    this.ta.focus();
    cx.timer.after(500, () => this.ta.focus());
    o.actions = [];
    o.keyups = [];
    // Bindings in our own context (the wrapper, shallower than the textarea)
    // and in a context-free one, to see which keys a composer can take.
    const keysToTry = ["up", "down", "tab", "enter", "escape", "shift-tab"];
    o.bound = cx.bind_keys([
      ...keysToTry.map((k) => ({ keystroke: k, action: `pichat_menu_${k}`, context: "PiChatMenu" })),
      ...["Input", "TextArea", "Textarea", "Editor", "TextInput"].flatMap((ctx) => ["up", "down", "enter"].map((k) => ({ keystroke: k, action: `pichat_${ctx}_${k}`, context: `PiChatMenu > ${ctx}` }))),
    ]);
    this.ctxActions = ["Input", "TextArea", "Textarea", "Editor", "TextInput"].flatMap((ctx) => ["up", "down", "enter"].map((k) => `pichat_${ctx}_${k}`));
  }

  // ---- views ---------------------------------------------------------------------
  row(it, t, interactive) {
    const exp = this.expanded.has(it.id);
    const head = (label, color) => h_flex().gap(6).items_center().text_size(11.5).text_color(color).child(label);
    let body;
    if (it.kind === "user") body = div().px(12).py(8).rounded(8).bg(t.raised).child(TextView.markdown(`md-${it.id}`, it.text).selectable(true));
    else if (it.kind === "assistant") body = TextView.markdown(`md-${it.id}`, it.text || "…").selectable(true);
    else if (it.kind === "thinking") body = v_flex().child(head(exp ? "▾ Thinking" : "▸ Thinking", t.dim)).when(exp, (e) => e.child(div().text_color(t.muted).child(it.text)));
    else body = v_flex().rounded(8).border_1().border_color(t.border).bg(t.surface)
      .child(h_flex().px(10).h(28).gap(8).items_center().child(div().text_color(t.ansi2).child("✓")).child(div().flex_1().truncate().font_family("JetBrains Mono").text_size(12).child(it.title)).child(div().text_color(t.dim).text_size(11).child("0.4s")))
      .when(exp, (e) => e.child(div().px(10).py(6).border_t_1().border_color(t.border).font_family("JetBrains Mono").text_size(12).text_color(t.muted).child(it.text)));
    let el = div().id(`row-${it.id}`).w_full().px(16).py(6).child(body);
    if (interactive && (it.kind === "tool" || it.kind === "thinking")) el = el.cursor_pointer().on_click((_e, cx) => { this.toggle(it.id); cx.notify(); });
    return el;
  }

  render(cx) {
    const t0 = now();
    const t = theme();
    let content;
    if (this.mode === "net") content = div().p(16).child(`net: ${JSON.stringify({ ...this.out.net, lat: undefined, events: undefined, byConn: undefined })}`);
    else if (this.mode === "textarea") content = this.renderTextarea(t);
    else if (this.mode === "list") content = this.renderList(t);
    else if (this.mode === "flex") content = v_flex().id("flex").flex_1().min_h(0).overflow_y_scroll().children(this.items.map((it) => this.row(it, t, true)));
    else content = this.renderMeasured(t);
    const el = v_flex().id("spike-root").relative().size_full().bg(t.background).text_color(t.foreground).text_size(13)
      .child(h_flex().h(30).px(12).items_center().gap(10).border_b_1().border_color(t.border).text_size(12).text_color(t.muted)
        .child(`spike · ${this.mode}`).child(div().text_color(t.working).child("⠋").frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 80)))
      .child(content)
      .when(this.fps, (e) => e.child(fps_monitor()));
    const dt = now() - t0;
    this.stats.renders++; this.stats.renderMs += dt; if (dt > this.stats.renderMax) this.stats.renderMax = dt;
    return el;
  }

  renderList(t) {
    const items = this.items;
    return v_flex().relative().flex_1().min_h(0)
      .on_scroll_wheel((e, _cx) => { if (e.delta.y > 0) this.sticky = false; })
      .child(list("tl", items.length, (i) => items[i].id, (i) => {
        const s = now();
        const el = this.row(items[i], t, false);
        this.stats.items++; this.stats.itemMs += now() - s;
        return el;
      }).track_scroll(this.handle).on_item_click((key, cx) => { this.toggle(key); cx.notify(); }).size_full())
      .child(Scrollbar.vertical("tl").absolute().inset_0());
  }

  // Own scroller: every row's height measured once drawn (estimate until
  // then); sticky = the last row's bottom pinned to the viewport's bottom, so
  // a growing last row needs no second pass.
  renderMeasured(t) {
    const items = this.items;
    const est = 140;
    const h = (it) => this.heights.get(it.id) ?? est;
    let total = 0;
    for (const it of items) total += h(it);
    const rows = [];
    let anchor;
    if (this.sticky) {
      let used = 0;
      let i = items.length - 1;
      while (i >= 0 && used < this.viewH + 400) { used += h(items[i]); i--; }
      for (let k = i + 1; k < items.length; k++) rows.push(items[k]);
      this.top = Math.max(0, total - this.viewH);
      anchor = (e) => e.bottom(0);
    } else {
      this.top = Math.max(0, Math.min(this.top, total - this.viewH));
      let y = 0, i = 0;
      while (i < items.length && y + h(items[i]) < this.top - 200) { y += h(items[i]); i++; }
      const first = y;
      while (i < items.length && y < this.top + this.viewH + 200) { rows.push(items[i]); y += h(items[i]); i++; }
      anchor = (e) => e.top(first - this.top);
    }
    const measured = (it) => this.row(it, t, true).on_size_change((s, cx) => {
      this.stats.sizeChanges++;
      if (this.heights.get(it.id) === s.height) return;
      this.heights.set(it.id, s.height);
      if (!this.sticky) cx.notify();
    });
    return div().id("measured").relative().flex_1().min_h(0).w_full().overflow_hidden()
      .on_size_change((s, cx) => { if (s.height !== this.viewH) { this.viewH = s.height; cx.notify(); } })
      .on_scroll_wheel((e, cx) => {
        if (this.sticky && e.delta.y > 0) { this.sticky = false; this.top = Math.max(0, total - this.viewH); }
        this.top -= e.delta.y;
        if (this.top >= total - this.viewH - 2) this.sticky = true;
        cx.notify();
      })
      .child(anchor(v_flex().absolute().left(0).right(0)).children(rows.map(measured)));
  }

  renderTextarea(t) {
    const o = this.out.textarea;
    return v_flex().id("ta-wrap").flex_1().p(16).gap(10).justify_end()
      .child(div().text_color(t.dim).child(`menu ${this.menu ? "on" : "off"} · events ${o.events.length} · keys ${o.keys.length}`))
      .child(div().id("ta-box").on_size_change((s, _cx) => o.heights.push({ at: Date.now(), h: s.height }))
        .key_context(this.menu ? "PiChatMenu" : "PiChatComposer")
        .on_key_down((e, cx) => {
          o.keys.push({ key: e.key, mods: e.modifiers, at: Date.now(), menu: !!this.menu, value: this.ta.value() });
          if (this.menu && ["up", "down", "tab", "enter", "escape"].includes(e.key)) cx.stop_propagation();
        })
        .on_key_up((e) => { if (!/^[a-z0-9]$/.test(e.key)) o.keyups.push({ key: e.key, menu: !!this.menu, value: this.ta.value() }); })
        .on_action("pichat_menu_up", (e) => o.actions.push({ a: e.action, value: this.ta.value() }))
        .on_action("pichat_menu_down", (e) => o.actions.push({ a: e.action, value: this.ta.value() }))
        .on_action("pichat_menu_tab", (e) => o.actions.push({ a: e.action, value: this.ta.value() }))
        .on_action("pichat_menu_enter", (e) => o.actions.push({ a: e.action, value: this.ta.value() }))
        .on_action("pichat_menu_escape", (e) => o.actions.push({ a: e.action, value: this.ta.value() }))
        .when(true, (el) => { for (const a of this.ctxActions) el = el.on_action(a, (e) => o.actions.push({ a: e.action, value: this.ta.value() })); return el; })
        .child(Textarea.new(this.ta).w_full().px(10).py(8).rounded(8).border_1().border_color(t.input).bg(t.surface).text_size(13)));
  }
}
