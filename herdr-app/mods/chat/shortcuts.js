// Chat-scoped shortcuts (KEYS.md). The defaults ship in keys.default.json;
// the person's overrides live in <appHome>/data/herdr-chat/keys.json, in the
// same shape: {"<action>": "<chord>"}, a list for several chords, null to
// unbind. They're bound in the chat's own key contexts only (the chat root,
// "HerdrChat", and the inputs inside it), so a terminal pane never loses a key
// to them, and they don't clash with Herdr's keys or the person's keys.json.
// Every agent gets the same actions; one the agent can't do says so (main.js).

import { appHome, readTextFile } from "herdr";
import { MOD } from "./util.js";

// action → what it does (menus, tooltips, KEYS.md)
export const SHORTCUTS = {
  steer: "Send; while the agent works, steer it (next turn)",
  followUp: "Send; while the agent works, queue a follow-up (after this run)",
  model: "Choose the model",
  effort: "Choose the thinking level (effort)",
  cycleEffort: "Next thinking level (effort)",
  mode: "Choose the permission mode",
  cycleMode: "Next permission mode (next thinking level for an agent without modes)",
  stop: "Stop the agent",
  tui: "Continue in the agent's terminal UI",
  resume: "Resume another session",
  latest: "Scroll to the latest message",
  focusComposer: "Focus the composer",
  newChat: "New chat in this folder, same agent",
};

export const actionName = (a) => `herdrchat_k_${a}`;

// The inputs inside the chat (composer.js, menus.js, dialogs.js): a chord
// must be bound "<ctx> > Input" too, or the input's own keys win.
const INPUTS = ["HerdrChatMenu", "HerdrChatEmpty", "HerdrChatComposer", "HerdrChatAsk", "HerdrChatDialog", "HerdrChatEditor"];
// The cycles (Shift+Tab) work only in the composer, and not while a menu is open.
const COMPOSER = ["HerdrChatEmpty > Input", "HerdrChatComposer > Input", "HerdrChatAsk > Input"];
// Sending is the composer's with text in it (or images): in a menu Enter picks,
// on an empty composer with an approval card it answers (composer.js).
const SENDING = ["HerdrChatEmpty > Input", "HerdrChatComposer > Input"];
const ONLY = { cycleMode: COMPOSER, cycleEffort: COMPOSER, steer: SENDING, followUp: SENDING };
// The composer can't send without these: used when keys.default.json can't be read.
const FALLBACK = { steer: "enter", followUp: "alt-enter" };

let map = {}; // action → [chords]
export let errors = [];

function chords(v) {
  if (v == null) return [];
  return (Array.isArray(v) ? v : [v]).filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim());
}

async function readJson(path) {
  try {
    const text = await readTextFile(path);
    return text ? JSON.parse(text) : {};
  } catch (e) {
    errors.push(`${path}: ${e?.message ?? e}`);
    return {};
  }
}

export const overridesPath = () => `${appHome()}/data/herdr-chat/keys.json`;

// Defaults, then the person's file over them. Returns action → [chords].
export async function loadShortcuts() {
  errors = [];
  const defaults = await readJson(`${appHome()}/mods/${MOD}/keys.default.json`);
  const mine = await readJson(overridesPath());
  const out = {};
  for (const a of Object.keys(SHORTCUTS)) out[a] = chords(a in mine ? mine[a] : a in defaults ? defaults[a] : FALLBACK[a]);
  // "global": the keys that open a chat, which install.sh puts in Herdr's keys.json (install/keys.ts).
  for (const a of Object.keys(mine)) if (a !== "global" && !(a in SHORTCUTS)) errors.push(`keys.json: unknown action "${a}"`);
  // A chord you give one action leaves the action that had it by default
  // ({"cycleEffort": "shift-tab"} takes Shift+Tab from cycleMode), so two never fight for it.
  const yours = new Map(); // chord → your action
  for (const a of Object.keys(SHORTCUTS)) {
    if (!(a in mine)) continue;
    for (const k of out[a]) {
      if (yours.has(k) && yours.get(k) !== a) errors.push(`keys.json: "${k}" is bound to both ${yours.get(k)} and ${a}`);
      yours.set(k, a);
    }
  }
  for (const a of Object.keys(SHORTCUTS)) if (!(a in mine)) out[a] = out[a].filter((k) => !yours.has(k));
  map = out;
  return out;
}

// The shortcuts' bindings in the app's keymap (keymap.js says when). One binding list per action:
// bind_keys refuses a whole list for one bad chord, so a typo in the person's file costs only that action.
export function bindShortcuts(cx) {
  for (const [a, list] of Object.entries(map)) {
    if (!list.length) continue;
    const b = [];
    const ctxs = ONLY[a] ?? ["HerdrChat", ...INPUTS.map((c) => `${c} > Input`)];
    for (const k of list) for (const context of ctxs) b.push({ keystroke: k, action: actionName(a), context });
    try {
      cx.bind_keys(b);
    } catch (e) {
      const err = `${a}: ${list.join(", ")}: ${e?.message ?? e}`;
      if (!errors.includes(err)) errors.push(err); // (installed again after Herdr's keys.json is written)
    }
  }
}

export function shortcuts() {
  return map;
}

// The first chord bound to an action, for people: "⇧⌘M"; null when unbound.
export function keyHint(a) {
  const k = map[a]?.[0];
  return k ? keyLabel(k) : null;
}

const GLYPH = { cmd: "⌘", ctrl: "⌃", alt: "⌥", shift: "⇧" };
const ORDER = ["ctrl", "alt", "shift", "cmd"];
const NAMES = { tab: "⇥", enter: "↩", escape: "Esc", up: "↑", down: "↓", left: "←", right: "→", space: "Space", backspace: "⌫" };

export function keyLabel(chord) {
  return chord.split(" ").map((step) => {
    const parts = step.split("-");
    // "cmd--" (minus) splits into an empty last part
    const key = parts[parts.length - 1] === "" ? "-" : parts.pop();
    const mods = parts.filter(Boolean);
    const m = ORDER.filter((x) => mods.includes(x)).map((x) => GLYPH[x]).join("");
    return m + (NAMES[key] ?? (key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1)));
  }).join(" ");
}

// "Model · /model · ⇧⌘M": a tooltip with the key when one is bound.
export function withKey(text, a) {
  const k = keyHint(a);
  return k ? `${text} · ${k}` : text;
}
