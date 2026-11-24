// The platform's key facts, in one place. macOS has Cmd for the app's own
// keys; on Linux (and Windows) Ctrl does that work, Super belongs to the
// desktop, and Ctrl+C and the other Ctrl editing keys are a text field's.

import os from "os";
import { firstKeystroke } from "./chord.js";

// The app's runtime says "macos" (not Node's "darwin").
const mac = os.platform() === "macos";

// GPUI's text fields' Ctrl editing keys off macOS (gpui-kit crates/base/src/input/base/state.rs).
// On macOS the defaults use none of the fields' ⌘ keys, and a chord you bind there wins, as it always has.
const FIELD_KEYS = ["ctrl-a", "ctrl-c", "ctrl-x", "ctrl-v", "ctrl-z", "ctrl-y", "ctrl-f", "ctrl-h", "ctrl-.", "ctrl-[", "ctrl-]",
  "ctrl-left", "ctrl-right", "ctrl-home", "ctrl-end", "ctrl-shift-left", "ctrl-shift-right", "ctrl-shift-home", "ctrl-shift-end",
  "ctrl-backspace", "ctrl-delete"];
const fieldKeys = new Set(mac ? [] : FIELD_KEYS);

export const PLATFORM = {
  mac,
  /** The chords that differ from keys.default.json here (shortcuts.js merges them over it); null on macOS. */
  keyOverrides: mac ? null : "keys.default.linux.json",
  /** Submits the editor dialog, where Enter is a new line. */
  submitChord: mac ? "cmd-enter" : "ctrl-enter",
  /**
   * More keys the composer pastes on, besides the field's own. Linux: a terminal app's paste keys, since
   * dictation tools and clipboard managers paste into a terminal app's window with Ctrl+Shift+V or
   * Shift+Insert, whatever its pane shows. Both paste the clipboard here, as GTK and Qt apps do
   * (an X11 terminal's Shift+Insert pastes the PRIMARY selection instead).
   */
  pasteChords: mac ? [] : ["ctrl-shift-v", "shift-insert"],
  /** How the viewer's hint writes "zoom with the modifier and the wheel". */
  zoomScroll: mac ? "⌘ scroll" : "Ctrl+scroll",
  /** Whether a chord's first key is a text field's own (copy, select all…): the chat leaves it to the field. */
  fieldOwns: (chord) => fieldKeys.has(firstKeystroke(chord, mac)),
};
