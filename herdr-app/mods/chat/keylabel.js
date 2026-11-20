// A chord as people read it: "cmd-shift-m" → "⇧⌘M" on macOS, "Super+Shift+M"
// elsewhere, where Herdr writes keys out ("Ctrl+Alt+Shift+P"). One table for
// the chat's own hints (shortcuts.js) and the installer's lines
// (install/keys.ts imports this file), so both name a key the same way.
// No imports: it runs in the app and in Node alike.
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
const KEYS = { tab: "Tab", enter: "Enter", escape: "Esc", up: "↑", down: "↓", left: "←", right: "→", space: "Space", backspace: "Backspace" };

const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * @param {string} chord Herdr's chord syntax, steps separated by spaces ("cmd-j a").
 * @param {boolean} mac macOS's glyphs ("⇧⌘M") or words ("Ctrl+Shift+M").
 * @returns {string}
 */
export function keyLabel(chord, mac) {
  return chord.split(" ").map((step) => {
    const parts = step.split("-");
    // "cmd--" (minus) splits into an empty last part
    const key = parts[parts.length - 1] === "" ? (parts.pop(), "-") : parts.pop();
    const mods = parts.filter(Boolean).map((m) => (m === "secondary" ? (mac ? "cmd" : "ctrl") : ALIAS[m] ?? m));
    const known = (mac ? MAC_ORDER : ORDER).filter((m) => mods.includes(m));
    const other = [...new Set(mods.filter((m) => !ORDER.includes(m)))];
    const name = (mac ? MAC_KEYS : KEYS)[key] ?? (key.length === 1 ? key.toUpperCase() : capital(key));
    if (mac) return other.map((m) => `${capital(m)}+`).join("") + known.map((m) => GLYPH[m]).join("") + name;
    return [...other.map(capital), ...known.map((m) => WORD[m]), name].join("+");
  }).join(" ");
}
