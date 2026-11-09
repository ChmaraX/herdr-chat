// The mod's debug dump, for the E2E checks: when
// <appHome>/data/herdr-chat/debug/enabled exists, <chat>.json is rewritten
// (at most every 150 ms) after anything it shows changes. Written from the
// store and the view's own changes, not from render: a window that isn't
// drawn renders nothing but still takes records and commands.

import * as fs from "fs/promises";
import { readTextFile } from "herdr";
import { stateDir } from "./connection.js";

export class Debug {
  constructor(cx, chat, snapshot) {
    this.on = false;
    this.dirty = false;
    this.chat = chat;
    this.snapshot = snapshot;
    this.writes = 0;
    cx.spawn(async () => {
      this.on = (await readTextFile(`${stateDir()}/debug/enabled`)) !== null;
      this.fps = (await readTextFile(`${stateDir()}/debug/fps`)) !== null; // the FPS HUD (gpui-fps) over the chat
      this.dirty = true;
    });
    cx.timer.every(150, (cx) => this.flush(cx));
  }

  mark() {
    this.dirty = true;
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
