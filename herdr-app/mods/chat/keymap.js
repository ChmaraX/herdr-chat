// The chat's key bindings in the app's keymap, and keeping them there.
// composer.js, shortcuts.js and codeview.js say what the bindings are; this
// says when they're installed.
//
// Herdr rebuilds the app's keymap whenever its keys.json is written, even
// with nothing changed, and the rebuild drops every binding a mod added.
// Nothing tells the mod (Herdr 0.1.15; issue #6). So every open chat watches
// for writes to keys.json, and after the last write of a burst the bindings
// go in again twice: once Herdr has normally rebuilt, and once more in case it
// was slower. The keymap can't be read: an install of bindings Herdr didn't
// drop adds them twice, which changes nothing (the same chords, the same actions).
//
// A watch belongs to the chat that asked for it and ends when that chat
// closes. With no chat open nothing watches, but Herdr keeps the changes
// until the next watch (past a limit it reports the folder itself), so the
// next chat's watch sees the write and the bindings go back in.

import { appHome, exec, watchFolder } from "herdr";
import { bindComposerKeys } from "./composer.js";
import { bindCodeKeys } from "./codeview.js";
import { bindShortcuts } from "./shortcuts.js";

const AFTER_WRITE = [300, 1500]; // ms after the last write to keys.json: the installs
const RETRY = 5000; // ms before watching again after a watch failed

let installed = false; // by the first chat
let pending = []; // the installs waiting after the last write
let home = null; // Promise of the app's folder as the watcher reports paths in it

function install(cx) {
  bindComposerKeys(cx);
  bindShortcuts(cx);
  bindCodeKeys(cx);
}

// Each watching chat sees the write; the installs are no chat's, so one that
// closes meanwhile cancels nothing.
function written(cx) {
  for (const t of pending) t.cancel();
  pending = AFTER_WRITE.map((ms) => cx.timer.after(ms, install, { owner: null }));
}

// Resolved: /tmp is /private/tmp and ~/.config may be a link (macOS; the mod
// runs nowhere else).
async function resolvedHome() {
  const dir = appHome().replace(/\/+$/, "");
  const r = await exec("/bin/pwd", ["-P"], { cwd: dir }).catch(() => null);
  return r?.code === 0 && r.stdout.trim() ? r.stdout.trim() : dir;
}

// A chat, once the person's shortcuts are loaded (shortcuts.js): its keys work
// from here, and it watches keys.json until it closes.
export function keepKeys(cx) {
  if (!installed) {
    installed = true;
    install(cx);
  }
  cx.spawn(async (cx) => {
    const dir = await (home ??= resolvedHome());
    const keys = `${dir}/keys.json`;
    for (;;) {
      let changed;
      try {
        changed = await watchFolder(dir);
      } catch {
        await cx.sleep(RETRY); // a watch can fail (a folder too big to watch): try again
        continue;
      }
      // A batch with the folder itself: too many changes to list, keys.json may be one.
      if (changed.some((p) => p === keys || p === dir)) written(cx);
    }
  });
}
