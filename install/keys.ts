// The global keys that open a chat, from the person's chat key file
// (<app home>/data/herdr-chat/keys.json, its "global" part) into Herdr's keys.json
// (its global section), and their exact undo.
//
//   "global": {"open": "cmd-i", "pi": null, "claude": null, "codex": null, "continue": null}
//
// - open: the launcher (mod.open:new-chat, which works in every layout);
//   pi/claude/codex: a chat with that agent at once (new-chat.<agent>, which
//   the new-chat copy in the layout's floating list takes: install/layout.ts);
//   continue: the focused Pi TUI continues as a chat (new-chat.continue, the
//   right-click menu's Continue as chat).
// - Left out: the default (open: cmd-i, the others unbound); null: unbound.
// - A chord the person chose replaces what had it; the old action is kept in
//   the record (data/herdr-chat/install.json), so uninstall puts it back. The
//   default cmd-i, when taken, falls back to cmd-j a, and says so.
// - Every install first undoes the bindings the last one made (an older
//   install's `cmd-j shift-p → mod.open:new-chat` too), then binds again: a
//   chord the person moved elsewhere goes back to what it was.
// - keys.json is replaced whole, only if nobody changed it meanwhile.
//
//   node install/keys.ts install <app home> [--no-direct] [--platform darwin|linux]
//   node install/keys.ts uninstall <app home>
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Json = any;
export const NAMES = ["open", "pi", "claude", "codex", "continue"] as const;
export type Name = (typeof NAMES)[number];
export const ACTION: Record<Name, string> = { open: "mod.open:new-chat", pi: "new-chat.pi", claude: "new-chat.claude", codex: "new-chat.codex", continue: "new-chat.continue" };
export const TITLE: Record<Name, string> = { open: "New chat", pi: "Pi chat", claude: "Claude Code chat", codex: "Codex chat", continue: "Continue as chat" };

export type Own = { [chord: string]: { action: string; was: string | null } };
export type Record2 = { version: 2; global: Own };

export function defaults(platform: string): { open: string; fallback: string | null } {
  return platform === "darwin" ? { open: "cmd-i", fallback: "cmd-j a" } : { open: "ctrl-alt-shift-p", fallback: null };
}

/** "cmd-j a" → "⌘J A" (macOS), "Ctrl+Alt+Shift+P" elsewhere. */
export function pretty(chord: string, platform: string): string {
  const mac = platform === "darwin";
  const SYM: Record<string, string> = mac ? { cmd: "⌘", ctrl: "⌃", alt: "⌥", shift: "⇧" } : { cmd: "Ctrl+", ctrl: "Ctrl+", alt: "Alt+", shift: "Shift+" };
  const KEY: Record<string, string> = { enter: "↩", escape: "Esc", space: "Space", tab: "⇥", backspace: "⌫", up: "↑", down: "↓", left: "←", right: "→" };
  return chord.split(" ").map((step) => {
    const parts = step.endsWith("--") ? [...step.slice(0, -2).split("-"), "-"] : step.split("-");
    const key = parts.pop()!;
    const k = KEY[key] ?? (key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1));
    return parts.map((m) => SYM[m] ?? `${m}+`).join("") + k;
  }).join(" ");
}

/** The person's choices: chords per name (`null`: unbound, `undefined`: the default), and what's wrong in the file. */
export function readPrefs(raw: Json): { prefs: Partial<Record<Name, string[] | null>>; errors: string[] } {
  const prefs: Partial<Record<Name, string[] | null>> = {};
  const errors: string[] = [];
  const g = raw?.global;
  if (g === undefined) return { prefs, errors };
  if (!g || typeof g !== "object" || Array.isArray(g)) return { prefs, errors: ['"global" is not an object: the defaults apply'] };
  for (const [k, v] of Object.entries(g)) {
    if (!(NAMES as readonly string[]).includes(k)) { errors.push(`"global": unknown "${k}" (known: ${NAMES.join(", ")})`); continue; }
    const list = v === null ? null : typeof v === "string" ? [v] : Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined;
    if (list === undefined) { errors.push(`"global"."${k}": a chord, a list of chords or null`); continue; }
    const bad = (list ?? []).filter((c) => !c.trim() || c !== c.trim());
    if (bad.length) { errors.push(`"global"."${k}": not a chord: ${JSON.stringify(bad[0])}`); continue; }
    prefs[k as Name] = list;
  }
  return { prefs, errors };
}

/** The bindings this install owns now (its record). */
export function owned(rec: Json): Own {
  return { ...(rec?.global ?? {}) };
}

/** Pure: undo `own` in the global section `g` (a chord the person rebound since stays theirs). */
export function restore(g: Json, own: Own): string[] {
  const out: string[] = [];
  for (const [k, { action, was }] of Object.entries(own)) {
    if (g[k] !== action) continue;
    if (was == null) delete g[k];
    else g[k] = was;
    out.push(k);
  }
  return out;
}

export type Plan = { own: Own; lines: string[]; bound: Partial<Record<Name, string>> };

/** Pure: bind the person's choices into `doc` (after restoring what the last install owned). */
export function apply(doc: Json, rec: Json, o: { prefs: Partial<Record<Name, string[] | null>>; platform: string; direct: boolean }): Plan {
  const g = (doc.global ??= {});
  restore(g, owned(rec));
  const own: Own = {};
  const lines: string[] = [];
  const bound: Partial<Record<Name, string>> = {};
  const p = (c: string) => pretty(c, o.platform);
  const term = doc.terminal ?? {};
  const bind = (n: Name, chord: string) => {
    const was = g[chord];
    if (own[chord]) { lines.push(`${TITLE[n]}: ${p(chord)} is another chat key's already; not bound twice`); return; }
    if (was !== undefined && was !== ACTION[n]) lines.push(`${TITLE[n]}: ${p(chord)} replaces ${was} (uninstall puts it back)`);
    g[chord] = ACTION[n];
    // A binding of the same action that wasn't ours stays after uninstall (was: itself).
    own[chord] = { action: ACTION[n], was: was ?? null };
    if (term[chord] && term[chord] !== "terminal") lines.push(`${TITLE[n]}: in a terminal, ${p(chord)} is the terminal section's ${term[chord]}`);
    bound[n] ??= chord;
  };
  for (const n of NAMES) {
    const chosen = o.prefs[n];
    if (n !== "open" && !o.direct && chosen?.length) { lines.push(`${TITLE[n]}: ${chosen.map(p).join(", ")} not bound: it needs the layout's new-chat copy (install without --no-layout)`); continue; }
    if (chosen === null) continue;
    if (chosen !== undefined) { for (const c of chosen) bind(n, c); continue; }
    if (n !== "open") continue; // unbound by default
    const d = defaults(o.platform);
    const free = (c: string) => g[c] === undefined || g[c] === ACTION.open;
    if (free(d.open)) bind(n, d.open);
    else if (d.fallback && free(d.fallback)) {
      lines.push(`${p(d.open)} is taken (${g[d.open]}): New chat is ${p(d.fallback)} instead. To choose: "global": {"open": "<chord>"} in data/herdr-chat/keys.json, then install again`);
      bind(n, d.fallback);
    } else lines.push(`${p(d.open)}${d.fallback ? ` and ${p(d.fallback)} are` : " is"} taken: New chat has no key. To choose: "global": {"open": "<chord>"} in data/herdr-chat/keys.json, then install again`);
  }
  return { own, lines, bound };
}

/** The one line install ends with: "New chat: ⌘I · Pi chat: ⌘J P". */
export function summary(bound: Partial<Record<Name, string>>, platform: string): string {
  const parts = NAMES.filter((n) => bound[n]).map((n) => `${TITLE[n]}: ${pretty(bound[n]!, platform)}`);
  return parts.length ? parts.join(" · ") : "New chat: no key (Herdr's mod.open:new-chat opens it)";
}

/** Read keys.json, change it, replace it whole unless it changed meanwhile. Returns whether it wrote. */
function editKeys(path: string, edit: (doc: Json) => void): boolean {
  for (let i = 0; i < 5; i++) {
    const before = existsSync(path) ? readFileSync(path, "utf8") : null;
    const doc = before === null ? {} : JSON.parse(before);
    const was = JSON.stringify(doc);
    edit(doc);
    if (JSON.stringify(doc) === was) return false;
    const tmp = join(path, "..", ".keys.json.herdr-chat.tmp");
    writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n");
    if ((existsSync(path) ? readFileSync(path, "utf8") : null) !== before) { rmSync(tmp, { force: true }); continue; }
    renameSync(tmp, path);
    return true;
  }
  throw new Error(`${path} keeps changing; run the install again`);
}

const readJson = (f: string): Json => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } };

export function install(home: string, o: { direct: boolean; platform: string }): string[] {
  const state = join(home, "data", "herdr-chat");
  const recFile = join(state, "install.json");
  const mine = existsSync(join(state, "keys.json")) ? readJson(join(state, "keys.json")) : {};
  const lines: string[] = [];
  if (mine === null) lines.push("data/herdr-chat/keys.json isn't valid JSON: the default keys apply");
  const { prefs, errors } = readPrefs(mine ?? {});
  lines.push(...errors.map((e) => `data/herdr-chat/keys.json: ${e}`));
  let plan: Plan = { own: {}, lines: [], bound: {} };
  const rec = readJson(recFile);
  editKeys(join(home, "keys.json"), (doc) => { plan = apply(doc, rec, { prefs, platform: o.platform, direct: o.direct }); });
  writeFileSync(recFile, JSON.stringify({ version: 2, global: plan.own } satisfies Record2, null, 2) + "\n");
  return [...lines, ...plan.lines, `=${summary(plan.bound, o.platform)}`];
}

export function uninstall(home: string): string[] {
  const recFile = join(home, "data", "herdr-chat", "install.json");
  const rec = readJson(recFile);
  let undone: string[] = [];
  if (existsSync(join(home, "keys.json"))) editKeys(join(home, "keys.json"), (doc) => { undone = restore(doc.global ?? {}, owned(rec)); });
  rmSync(recFile, { force: true });
  return [undone.length ? `keys: ${undone.join(", ")} back to what they were` : "keys: nothing of ours in keys.json"];
}

if (import.meta.main) {
  const [cmd, home, ...rest] = process.argv.slice(2);
  const value = (f: string) => { const i = rest.indexOf(f); return i >= 0 ? rest[i + 1] ?? null : null; };
  if (!home || (cmd !== "install" && cmd !== "uninstall")) {
    process.stderr.write("usage: node install/keys.ts install|uninstall <app home> [--no-direct] [--platform darwin|linux]\n");
    process.exit(2);
  }
  try {
    const lines = cmd === "install" ? install(home, { direct: !rest.includes("--no-direct"), platform: value("--platform") ?? process.platform }) : uninstall(home);
    // "=" marks the summary: printed as it is, the install's last line.
    for (const l of lines) process.stdout.write(l.startsWith("=") ? `${l.slice(1)}\n` : `herdr-chat: ${l}\n`);
  } catch (e) {
    process.stderr.write(`herdr-chat: keys: ${e instanceof Error ? e.message : e}\n`);
    process.exit(1);
  }
}
