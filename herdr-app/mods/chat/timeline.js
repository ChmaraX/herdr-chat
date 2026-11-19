// The timeline's own scroller. Only the rows on screen (plus some margin)
// are built, as ordinary elements, so cards can have their own click and
// hover handlers (rows of the app's virtual lists can't). Each row's height
// is measured with on_size_change once drawn; unmeasured rows use an
// estimate. While sticky, the last row's bottom is pinned to the viewport's
// bottom (absolute bottom 0), so a growing streamed answer needs no second
// layout pass. Scrolling up unsticks; reaching the bottom sticks again.
// A new row is drawn in the frame that makes room for it, with no fade: the
// rows above move at once, so a fade would show a blank hole first (#16).
//
// Every height here is in layout px, the unit top() and bottom() take. With
// the app's UI zoom other than 1, on_size_change reports zoomed px instead, so
// a 100 px probe measures the ratio and each measure is divided by it (#28).

import { div } from "gpui-kit";
import { v_flex } from "gpui-base";

const OVERSCAN = 400;
const EST = { user: 80, assistant: 120, thinking: 34, tool: 44, notice: 32, custom: 56, group: 40, footer: 32, activity: 38 };

export class Timeline {
  constructor(id) {
    this.id = id;
    this.heights = new Map();
    this.offsets = new Map();
    this.sticky = true;
    this.top = 0;
    this.viewH = 0;
    this.total = 0;
    this.shown = [];
    this.scale = 1; // px on_size_change reports per layout px: the UI zoom, measured by the probe
    this.viewRaw = 0; // the viewport's height as reported (zoomed)
    this.anchor = null; // history went in front: the rows on screen, to keep where they were [{id, dy}]
    this.heightsSeen = null; // debug only (trace()): row id → [[ms, height]…], the heights it was measured at
  }

  h(r) {
    return this.heights.get(r.id) ?? EST[r.kind === "item" ? r.item.kind : r.kind] ?? 60;
  }

  scrollBy(dy) {
    if (this.sticky && dy > 0) {
      this.sticky = false;
      this.top = Math.max(0, this.total - this.viewH);
    }
    if (this.sticky) return;
    this.top -= dy;
    if (this.top < 0) this.top = 0;
    if (this.top >= this.total - this.viewH - 2) this.sticky = true;
  }

  trace(debug) {
    this.heightsSeen = debug.trace();
  }

  toBottom() {
    this.sticky = true;
  }

  // Items were put in front (history): keep what's on screen where it is. The
  // next view() finds one of the rows shown now and puts it back at the same
  // y. (The items themselves don't say how much room they take: tools and
  // thinking fold into groups, and some items draw nothing.)
  prepended() {
    if (this.sticky) return;
    this.anchor = this.shown.map((id) => ({ id, dy: (this.offsets.get(id) ?? 0) - this.top }));
  }

  // The probe's report: the zoom changed (or was first measured).
  rescale(k) {
    if (!(k > 0) || Math.abs(k - this.scale) < 0.001) return false;
    const r = this.scale / k;
    for (const [id, h] of this.heights) this.heights.set(id, h * r);
    this.top *= r;
    this.scale = k;
    this.viewH = this.viewRaw / k;
    return true;
  }

  // items: the rows (rows.js); row(r): its element; onNearTop(): page older
  // items; thumb: the scrollbar's color (drawn at the pane's edge while scrolled up).
  view(items, row, { onNearTop, thumb } = {}) {
    let total = 0;
    const offs = new Array(items.length);
    for (let i = 0; i < items.length; i++) {
      offs[i] = total;
      total += this.h(items[i]);
    }
    this.total = total;
    if (this.anchor) {
      const at = new Map(items.map((it, i) => [it.id, i]));
      const a = this.anchor.find((x) => at.has(x.id));
      if (a && !this.sticky) this.top = offs[at.get(a.id)] - a.dy;
      this.anchor = null;
    }
    const rows = [];
    let place;
    if (this.sticky || total <= this.viewH) {
      let used = 0;
      let i = items.length - 1;
      while (i >= 0 && used < this.viewH + OVERSCAN) used += this.h(items[i--]);
      for (let k = i + 1; k < items.length; k++) rows.push(k);
      this.top = Math.max(0, total - this.viewH);
      place = (e) => (total <= this.viewH ? e.top(0) : e.bottom(0));
    } else {
      this.top = Math.max(0, Math.min(this.top, total - this.viewH));
      let i = 0;
      while (i < items.length && offs[i] + this.h(items[i]) < this.top - OVERSCAN) i++;
      const first = i < items.length ? offs[i] : 0;
      while (i < items.length && offs[i] < this.top + this.viewH + OVERSCAN) rows.push(i++);
      place = (e) => e.top(first - this.top);
    }
    this.offsets = new Map(rows.map((i) => [items[i].id, offs[i]]));
    this.shown = rows.map((i) => items[i].id);
    if (this.top < 300 && onNearTop && !this.sticky) onNearTop();
    else if (this.sticky && total < this.viewH && onNearTop) onNearTop();
    const measured = (it) => div().id(`row-${it.id}`).w_full()
      .child(row(it)).on_size_change((s, cx) => {
      const h = s.height / this.scale;
      const old = this.heights.get(it.id);
      if (old !== undefined && Math.abs(old - h) < 0.01) return;
      const was = this.h(it); // the height it was laid out with: its last measure, else the estimate
      this.heights.set(it.id, h);
      this.heightsSeen?.add(it.id, Math.round(h));
      // A row above the viewport changed size: keep the view still.
      const off = this.offsets.get(it.id);
      if (!this.sticky && off !== undefined && off < this.top) this.top += h - was;
      // Sticky, a known row growing needs no redraw: it's pinned to the bottom.
      if (!this.sticky || old === undefined) cx.notify();
    });
    return div().id(this.id).relative().flex_1().min_h(0).w_full().overflow_hidden()
      .on_size_change((s, cx) => {
        if (s.height === this.viewRaw) return;
        this.viewRaw = s.height;
        this.viewH = s.height / this.scale;
        cx.notify();
      })
      .on_scroll_wheel((e, cx) => {
        const before = [this.top, this.sticky];
        this.scrollBy(e.delta.y);
        if (before[0] !== this.top || before[1] !== this.sticky) cx.notify();
      })
      .child(div().absolute().top(0).left(0).w(1).h(100).on_size_change((s, cx) => this.rescale(s.height / 100) && cx.notify()))
      .child(place(v_flex().absolute().left(0).right(0)).children(rows.map((i) => measured(items[i]))))
      .when(!this.sticky && total > this.viewH && Boolean(thumb), (e) => {
        const h = Math.max(28, (this.viewH * this.viewH) / total);
        const y = ((this.viewH - h) * this.top) / Math.max(1, total - this.viewH);
        return e.child(div().absolute().right(3).top(y).w(5).h(h).rounded(3).bg(thumb));
      });
  }
}
