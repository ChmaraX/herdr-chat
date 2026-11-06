// The image viewer: an enlarged image or diagram in a dialog over the window
// (main.js enlarge() opens it), with zoom and pan.
//
//   zoom   ⌘ or ctrl + scroll, around the pointer · + / = and - around the
//          center · 0 fit · 1 100 % · the header's − % + Fit · 10 %–800 %
//   pan    plain scroll (both axes) · drag · clamped: an image larger than
//          the frame always covers it, a smaller one is centered on that axis
//
// Zoom is relative to the image's natural size (an SVG's width/height or
// viewBox, a raster's pixels). The image is drawn at the zoomed size inside an
// overflow-hidden frame, at an offset. GPUI rasterizes an SVG drawn by
// image() once, at its own width/height × 2, and caches it by path, so a
// bigger draw is a stretched bitmap. For sharpness the viewer writes copies of
// the SVG with width/height × 2, 4, 8 (viewBox kept) to data/pi-chat/zoom and
// draws the smallest one at least as big as the zoom, within RASTER_MAX (past
// that the bitmap stretches). The bucket below stays under the new one while
// it loads, so a switch never shows a blank frame. Pinch: GPUI has
// PinchEvent, but gpui-kit gives mods no on_pinch, so a pinch does nothing.
//
// Commands (`chat.viewer:<c>`, for the E2E): zoom:<pct>[:x:y] (around a
// frame point, default the center) · wheel:<dx>:<dy>[:cmd][:x:y] (the wheel
// handler) · drag:<dx>:<dy> (a drag from the frame's center) · key:<k> · fit.
// Its debug dump is debug/viewer.json.

import { div, image } from "gpui-kit";
import * as fs from "fs/promises";
import { h_flex, v_flex } from "gpui-base";
import { appHome, closeOverlay, nextCommand, props, readTextFile, theme } from "herdr";
import { stateDir } from "./connection.js";
import { Debug } from "./debug.js";
import { homeRel } from "./util.js";

const MIN = 0.1;
const MAX = 8;
const STEP = 1.25; // + and - (and the buttons)
const BUCKETS = [2, 4, 8];
// The largest SVG raster: GPUI draws width/height × 2 device px, so ≤ 8192 px a side
// (the Metal texture limit is 16384) and ≤ 32 Mpx (128 MB).
const RASTER_SIDE = 8192;
const RASTER_AREA = 32e6;
const UNDER_MS = 2000; // the previous bucket stays under a new one this long

export class Viewer {
  constructor(v, cx) {
    this.path = v.path; // relative to the app's home
    this.abs = `${appHome().replace(/\/$/, "")}/${v.path}`;
    this.svg = /\.svg$/i.test(v.path);
    this.natural = v.w > 0 && v.h > 0 ? { w: v.w, h: v.h } : null;
    const [W, H] = v.want ?? [900, 600];
    this.frame = { w: W - 32, h: H - 84, measured: false }; // until on_size_change says
    this.fit = true;
    this.z = 1;
    this.x = 0;
    this.y = 0;
    this.drag = null;
    this.buckets = new Map([[1, this.path]]); // scale → rel path of a written copy
    this.writing = new Set();
    this.shown = 1; // the bucket drawn last
    this.under = null; // {scale, until}: drawn under a bucket that may still be loading
    this.wheels = 0;
    this.focus = cx.focus_handle();
    this.debug = new Debug(cx, "viewer", () => this.dump());
    if (!this.natural) {
      cx.spawn(async (cx) => {
        this.natural = (await readImageSize(this.abs)) ?? { w: 1600, h: 1000 };
        this.refit();
        cx.notify();
      });
    }
    this.refit();
    cx.spawn(async (cx) => {
      await cx.sleep(30);
      this.focus.focus();
      cx.notify();
    });
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "focus") this.focus.focus();
        else if (c.startsWith("viewer:")) {
          try {
            this.command(c.slice(7), cx);
          } catch (e) {
            this.lastError = String(e?.message ?? e);
          }
        }
        this.debug.mark();
        cx.notify();
      }
    });
  }

  // ---- geometry ----------------------------------------------------------------------

  fitScale() {
    const n = this.natural ?? { w: 1600, h: 1000 };
    return Math.min(this.frame.w / n.w, this.frame.h / n.h, 3);
  }

  limits() {
    return [Math.min(MIN, this.fitScale()), MAX];
  }

  refit() {
    this.fit = true;
    this.z = this.fitScale();
    this.clamp();
    this.debug.mark();
  }

  // An image larger than the frame covers it (no empty edge); a smaller one is centered.
  clamp() {
    const n = this.natural ?? { w: 1600, h: 1000 };
    const W = n.w * this.z, H = n.h * this.z;
    this.x = W <= this.frame.w ? (this.frame.w - W) / 2 : Math.min(0, Math.max(this.frame.w - W, this.x));
    this.y = H <= this.frame.h ? (this.frame.h - H) / 2 : Math.min(0, Math.max(this.frame.h - H, this.y));
  }

  // Zoom to `z` keeping the image point under frame point (px, py) where it is.
  zoomTo(z, px = this.frame.w / 2, py = this.frame.h / 2) {
    const [lo, hi] = this.limits();
    z = Math.min(hi, Math.max(lo, z));
    const ix = (px - this.x) / this.z, iy = (py - this.y) / this.z;
    this.z = z;
    this.x = px - ix * z;
    this.y = py - iy * z;
    this.fit = false;
    this.clamp();
    this.debug.mark();
  }

  pan(dx, dy) {
    this.x += dx;
    this.y += dy;
    this.clamp();
    this.debug.mark();
  }

  // ---- input -------------------------------------------------------------------------

  wheel(dx, dy, zoom, px, py) {
    this.wheels++;
    if (zoom) this.zoomTo(this.z * Math.min(2, Math.max(0.5, Math.exp(dy * 0.01))), px, py);
    else this.pan(dx, dy);
  }

  key(k) {
    if (k === "+" || k === "=") this.zoomTo(this.z * STEP);
    else if (k === "-" || k === "_") this.zoomTo(this.z / STEP);
    else if (k === "0") this.refit();
    else if (k === "1") this.zoomTo(1);
    else return false;
    this.lastKey = k;
    return true;
  }

  command(c, cx) {
    const [op, ...a] = c.split(":");
    const num = (i, d) => (a[i] === undefined || a[i] === "" ? d : Number(a[i]));
    if (op === "zoom") this.zoomTo(num(0, 100) / 100, num(1, undefined), num(2, undefined));
    else if (op === "wheel") {
      const zoom = a[2] === "cmd" || a[2] === "ctrl";
      const at = zoom ? 3 : 2;
      this.wheel(num(0, 0), num(1, 0), zoom, num(at, this.frame.w / 2), num(at + 1, this.frame.h / 2));
    } else if (op === "drag") {
      const cx0 = this.frame.w / 2, cy0 = this.frame.h / 2;
      this.dragStart(cx0, cy0);
      this.dragMove(cx0 + num(0, 0), cy0 + num(1, 0));
      this.dragEnd();
    } else if (op === "key") this.key(a.join(":"));
    else if (op === "fit") this.refit();
    this.want(cx);
  }

  dragStart(px, py) {
    this.drag = { px, py, x: this.x, y: this.y };
    this.debug.mark();
  }

  dragMove(px, py) {
    if (!this.drag) return false;
    this.x = this.drag.x + px - this.drag.px;
    this.y = this.drag.y + py - this.drag.py;
    this.clamp();
    this.debug.mark();
    return true;
  }

  dragEnd() {
    if (!this.drag) return;
    this.drag = null;
    this.drags = (this.drags ?? 0) + 1;
    this.debug.mark();
  }

  // ---- sharp SVGs: copies drawn bigger -------------------------------------------------

  // The scale the zoom wants (the smallest bucket ≥ z within the raster cap).
  bucketFor(z) {
    if (!this.svg || !this.natural || z <= 1) return 1;
    const { w, h } = this.natural;
    let best = 1;
    for (const b of BUCKETS) {
      const rw = w * b * 2, rh = h * b * 2;
      if (rw > RASTER_SIDE || rh > RASTER_SIDE || rw * rh > RASTER_AREA) break;
      best = b;
      if (b >= z) break;
    }
    return best;
  }

  // The best bucket written so far for the zoom (the wanted one is written in the background).
  bucket() {
    const want = this.bucketFor(this.z);
    let b = 1;
    for (const [s] of this.buckets) if (s <= want && s > b) b = s;
    return b;
  }

  want(cx) {
    const b = this.bucketFor(this.z);
    if (this.buckets.has(b) || this.writing.has(b)) return;
    this.writing.add(b);
    cx.spawn(async (cx) => {
      try {
        const text = this.source ?? (this.source = (await readTextFile(this.abs)) ?? "");
        const out = scaledSvg(text, this.natural, b);
        if (!out) throw new Error("no <svg> root to scale");
        const dir = `${stateDir()}/zoom`;
        const file = `${dir}/${hash(this.abs)}-${this.abs.split("/").pop().replace(/\.svg$/i, "")}@${b}x.svg`;
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(file, out);
        const rel = homeRel(file, appHome());
        if (rel) this.buckets.set(b, rel);
      } catch (e) {
        this.bucketError = String(e?.message ?? e);
      } finally {
        this.writing.delete(b);
        this.debug.mark();
        cx.notify();
      }
    });
  }

  // ---- view --------------------------------------------------------------------------

  render(cx) {
    this.renders = (this.renders ?? 0) + 1;
    const t = theme();
    const n = this.natural ?? { w: 1600, h: 1000 };
    const W = Math.round(n.w * this.z), H = Math.round(n.h * this.z);
    this.want(cx);
    const b = this.bucket();
    if (b !== this.shown) {
      this.under = { scale: this.shown, until: Date.now() + UNDER_MS };
      this.shown = b;
      cx.spawn(async (cx) => { await cx.sleep(UNDER_MS + 50); cx.notify(); });
    }
    if (this.under && Date.now() > this.under.until) this.under = null;
    const drawn = { w: W, h: H, x: Math.round(this.x), y: Math.round(this.y), scale: b, path: this.buckets.get(b) };
    if (JSON.stringify(drawn) !== JSON.stringify(this.drawn)) { this.drawn = drawn; this.debug.mark(); }
    const placed = (scale) => div().absolute().left(Math.round(this.x)).top(Math.round(this.y)).w(W).h(H)
      .child(image(this.buckets.get(scale) ?? this.path).size_full());
    const pct = Math.round(this.z * 100);
    const btn = (id, label, tip, onClick) => h_flex().id(id).h(26).min_w(26).px(8).justify_center().items_center().rounded(6).cursor_pointer()
      .text_size(12).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
      .on_click((_e, cx) => { onClick(); this.want(cx); cx.notify(); }).child(label);
    const frame = div().id("viewer-frame").flex_1().min_h(0).w_full().relative().overflow_hidden().rounded(8)
      .when(Boolean(this.drag), (e) => e.cursor_grabbing()).when(!this.drag, (e) => e.cursor_grab())
      .on_size_change((sz, cx) => {
        if (this.frame.measured && Math.abs(sz.width - this.frame.w) < 0.5 && Math.abs(sz.height - this.frame.h) < 0.5) return;
        this.frame = { w: sz.width, h: sz.height, measured: true };
        if (this.fit) this.refit(); else this.clamp();
        this.debug.mark();
        cx.notify();
      })
      .on_scroll_wheel((e, cx) => {
        const p = local(e);
        this.wheel(e.delta.x, e.delta.y, e.modifiers.platform || e.modifiers.control, p.x, p.y);
        cx.stop_propagation();
        cx.notify();
      })
      .on_mouse_down("left", (e, cx) => {
        this.focus.focus();
        const p = local(e);
        this.dragStart(p.x, p.y);
        this.dragOrigin = { x: e.position.x - p.x, y: e.position.y - p.y }; // the frame's window position
        cx.notify();
      })
      .children(this.under && this.under.scale !== b ? [placed(this.under.scale)] : [])
      .child(placed(b));
    return v_flex().id("viewer").size_full().bg(t.background).p(16).gap(10)
      .track_focus(this.focus)
      .on_key_down((e, cx) => {
        const m = e.modifiers;
        if (m.platform || m.control || m.alt) return;
        if (this.key(e.key_char ?? e.key)) { this.want(cx); cx.stop_propagation(); cx.notify(); }
      })
      .on_mouse_move((e, cx) => {
        if (!this.drag || !this.dragOrigin) return;
        if (this.dragMove(e.position.x - this.dragOrigin.x, e.position.y - this.dragOrigin.y)) cx.notify();
      })
      .on_mouse_up("left", (_e, cx) => { if (this.drag) { this.dragEnd(); cx.notify(); } })
      .on_hover((h, cx) => { if (!h && this.drag) { this.dragEnd(); cx.notify(); } })
      .child(h_flex().gap(4).items_center()
        .child(div().flex_none().max_w(260).truncate().text_size(12).text_color(t.dim).child(this.path.split("/").pop()))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).pl(8).child("⌘ scroll to zoom · drag to pan · 0 fit"))
        .child(btn("viewer-out", "−", "Zoom out (-)", () => this.zoomTo(this.z / STEP)))
        .child(btn("viewer-pct", `${pct} %`, "Fit (0)", () => this.refit()).min_w(52))
        .child(btn("viewer-in", "+", "Zoom in (+)", () => this.zoomTo(this.z * STEP)))
        .child(btn("viewer-fit", "Fit", "Fit (0)", () => this.refit()))
        .child(div().w(8))
        .child(btn("viewer-close", "Close · Esc", "Close (Esc)", () => closeOverlay(props()?.overlay))))
      .child(frame);
  }

  dump() {
    return {
      viewer: {
        renders: this.renders ?? 0, path: this.path, svg: this.svg, natural: this.natural, frame: this.frame, fit: this.fit,
        zoom: +this.z.toFixed(4), pct: Math.round(this.z * 100), fitPct: Math.round(this.fitScale() * 100),
        pan: { x: Math.round(this.x), y: Math.round(this.y) }, drawn: this.drawn ?? null,
        buckets: Object.fromEntries(this.buckets), wanted: this.bucketFor(this.z), under: this.under?.scale ?? null,
        focused: this.focus.is_focused(), dragging: Boolean(this.drag), drags: this.drags ?? 0, wheels: this.wheels,
        lastKey: this.lastKey ?? null, bucketError: this.bucketError ?? null, error: this.lastError ?? null,
      },
    };
  }
}

// An event's point in the element it was delivered to.
function local(e) {
  if (e.local_position) return e.local_position;
  if (e.bounds) return { x: e.position.x - e.bounds.x, y: e.position.y - e.bounds.y };
  return e.position;
}

// The SVG with its root drawn `b` times bigger: width/height × b, the viewBox kept (added when missing).
export function scaledSvg(text, natural, b) {
  const m = /<svg\b[^>]*>/.exec(text);
  if (!m || !natural) return null;
  let root = m[0].replace(/\s(width|height)="[^"]*"/g, "");
  if (!/\sviewBox="/.test(root)) root = root.replace(/<svg\b/, `<svg viewBox="0 0 ${natural.w} ${natural.h}"`);
  root = root.replace(/<svg\b/, `<svg width="${natural.w * b}" height="${natural.h * b}"`);
  return text.slice(0, m.index) + root + text.slice(m.index + m[0].length);
}

function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// An image's natural size: an SVG's width/height (else its viewBox), a PNG,
// GIF or JPEG's pixels from its header. Null when unknown.
export async function readImageSize(path) {
  if (!/\.svg$/i.test(path)) return imageSize(await fs.readFile(path));
  const head = ((await readTextFile(path)) ?? "").slice(0, 2000);
  const vb = /viewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(head);
  const w = Number(/\swidth="([\d.]+)(px)?"/.exec(head)?.[1] ?? vb?.[1]);
  const h = Number(/\sheight="([\d.]+)(px)?"/.exec(head)?.[1] ?? vb?.[2]);
  return w > 0 && h > 0 ? { w, h } : null;
}

function imageSize(b) {
  if (!b || b.length < 24) return null;
  if (b[0] === 0x89 && b[1] === 0x50) return { w: (b[16] << 24 | b[17] << 16 | b[18] << 8 | b[19]) >>> 0, h: (b[20] << 24 | b[21] << 16 | b[22] << 8 | b[23]) >>> 0 };
  if (b[0] === 0x47 && b[1] === 0x49) return { w: b[6] | b[7] << 8, h: b[8] | b[9] << 8 };
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const m = b[i + 1], len = b[i + 2] << 8 | b[i + 3];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: b[i + 5] << 8 | b[i + 6], w: b[i + 7] << 8 | b[i + 8] };
      i += 2 + len;
    }
  }
  return null;
}
