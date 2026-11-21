// Herdr's chord syntax ("cmd-shift-m", "ctrl-j a"): one reading of it for the
// chat (shortcuts.js, platform.js) and the installer (install/keys.ts imports
// this file). No imports: it runs in the app and in Node alike.
//
// `cmd` is GPUI's platform key: ⌘ on macOS, Super on Linux (not Ctrl).
// `super`/`win` are other spellings of it; `secondary` is ⌘ on macOS, Ctrl elsewhere.

// macOS writes ⌃⌥⇧⌘; Linux desktops write Super first ("Super+Shift+P", "Ctrl+Alt+Shift+P").
const MAC_ORDER = ["ctrl", "alt", "shift", "cmd"];
const ORDER = ["cmd", "ctrl", "alt", "shift"];
const ALIAS = { super: "cmd", win: "cmd" };
const GLYPH = { cmd: "⌘", ctrl: "⌃", alt: "⌥", shift: "⇧" };
const WORD = { cmd: "Super", ctrl: "Ctrl", alt: "Alt", shift: "Shift" };
const MAC_KEYS = { tab: "⇥", enter: "↩", escape: "Esc", up: "↑", down: "↓", left: "←", right: "→", space: "Space", backspace: "⌫" };
const KEYS = { tab: "Tab", enter: "Enter", escape: "Esc", up: "↑", down: "↓", left: "←", right: "→", space: "Space", backspace: "Backspace", pageup: "PageUp", pagedown: "PageDown" };

const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** One step of a chord ("cmd-shift-m"): its key and its modifiers, in this platform's order (unknown ones apart). */
function step(text, mac) {
  const parts = text.toLowerCase().split("-");
  // "cmd--" (minus) splits into an empty last part
  const key = parts[parts.length - 1] === "" ? (parts.pop(), "-") : parts.pop();
  const mods = parts.filter(Boolean).map((m) => (m === "secondary" ? (mac ? "cmd" : "ctrl") : ALIAS[m] ?? m));
  return {
    key,
    mods: (mac ? MAC_ORDER : ORDER).filter((m) => mods.includes(m)),
    other: [...new Set(mods.filter((m) => !ORDER.includes(m)))],
  };
}

/**
 * A chord as people read it: "cmd-shift-m" → "⇧⌘M" on macOS, "Super+Shift+M"
 * elsewhere, where Herdr writes keys out ("Ctrl+Alt+Shift+P").
 * @param {string} chord Herdr's chord syntax, steps separated by spaces ("cmd-j a").
 * @param {boolean} mac macOS's glyphs ("⇧⌘M") or words ("Ctrl+Shift+M").
 * @returns {string}
 */
export function keyLabel(chord, mac) {
  return chord.split(" ").map((text) => {
    const { key, mods, other } = step(text, mac);
    const name = (mac ? MAC_KEYS : KEYS)[key] ?? (key.length === 1 ? key.toUpperCase() : capital(key));
    if (mac) return other.map((m) => `${capital(m)}+`).join("") + mods.map((m) => GLYPH[m]).join("") + name;
    return [...other.map(capital), ...mods.map((m) => WORD[m]), name].join("+");
  }).join(" ");
}

/**
 * A chord's first keystroke in one spelling, to compare chords: lowercase,
 * aliases resolved, modifiers in one order ("Shift-Ctrl-End" → "ctrl-shift-end";
 * "secondary-c" → "ctrl-c" off macOS).
 * @param {string} chord
 * @param {boolean} mac
 * @returns {string}
 */
export function firstKeystroke(chord, mac) {
  const { key, mods, other } = step(chord.trim().split(/\s+/)[0], mac);
  return [...MAC_ORDER.filter((m) => mods.includes(m)), ...other, key].join("-");
}
