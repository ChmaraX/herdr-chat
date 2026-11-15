// The mod's debug dump, for the E2E checks: when
// <appHome>/data/herdr-chat/debug/enabled exists, <chat>.json is rewritten
// (at most every 150 ms) after anything it shows changes. Written from the
// store and the view's own changes, not from render: a window that isn't
// drawn renders nothing but still takes records and commands. The one
// exception is a Trace: what render drew, for checks that need frames.

import * as fs from "fs/promises";
import { readTextFile } from "herdr";
import { stateDir } from "./connection.js";

export class Debug {
  // onEnabled(): once, when the dump turns out to be enabled (to start traces).
  constructor(cx, chat, snapshot, onEnabled) {
    this.on = false;
    this.dirty = false;
    this.chat = chat;
    this.snapshot = snapshot;
    this.writes = 0;
    cx.spawn(async () => {
      this.on = (await readTextFile(`${stateDir()}/debug/enabled`)) !== null;
      this.fps = (await readTextFile(`${stateDir()}/debug/fps`)) !== null; // the FPS HUD (gpui-fps) over the chat
      if (this.on) onEnabled?.();
      this.dirty = true;
    });
    cx.timer.every(150, (cx) => this.flush(cx));
  }

  mark() {
    this.dirty = true;
  }

  trace() {
    return new Trace(() => this.mark());
  }

  flush(cx) {
    if (!this.on || !this.dirty || this.writing) return;
    this.dirty = false;
    this.writing = true;
    let body;
    try {
      body = JSON.stringify({ at: Date.now(), writes: ++this.writes, ...this.snapshot() }, null, 1);
    } catch (e) {
      body = JSON.stringify({ at: Date.now(), error: String(e?.message ?? e) });
    }
    cx.spawn(async () => {
      try {
        await fs.mkdir(`${stateDir()}/debug`, { recursive: true });
        await fs.writeFile(`${stateDir()}/debug/${this.chat}.json`, body);
      } catch {
      } finally {
        this.writing = false;
      }
    });
  }
}

// What render drew, per key: [ms, ...values] each time the values change,
// the first TRACE_MAX times (a row streaming an answer changes on most frames).
const TRACE_MAX = 8;

class Trace {
  constructor(mark) {
    this.seen = new Map();
    this.mark = mark;
  }

  add(key, ...values) {
    let list = this.seen.get(key);
    if (!list) this.seen.set(key, (list = []));
    const last = list[list.length - 1];
    if (list.length >= TRACE_MAX || (last && values.every((v, i) => v === last[i + 1]))) return;
    list.push([Date.now(), ...values]);
    this.mark();
  }

  dump() {
    return Object.fromEntries(this.seen);
  }
}
