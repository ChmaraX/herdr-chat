// The layout edits that put the chat where a sub-agent's peek opens: the
// agents slot shows chat-agents (the shipped list, a chat-host sub-agent's
// click opening the chat), and the root's terminal_menu is chat-menu (Open as
// chat in a right-click, e.g. in the Rust peek of the host's transcript).
// As herdr-gitview does (src/appsetup.rs): Herdr's own layouts can't be edited,
// so a personal one is: the one on screen when it is personal, else the
// person's one copy of the shipped one on screen, else a fresh clone
// (`layout.clone`, which also switches to it). Uninstall undoes exactly these
// edits in every personal layout: the agents slot gets back what it showed
// (kept in its `props.replaces`), terminal_menu what it was (the record).
// A slot another plugin holds (the agents block showing another mod, a
// terminal_menu that isn't Herdr's `menu`) is left to it and named, unless
// --take-agents-slot / --take-menu: then it's taken and uninstall gives back
// exactly what it was (the block's `props.replaces`, the record's menuWas).
// It also adds an empty floating block, a copy of new-chat that is always on
// screen at no size (as herdr-nvim's controller): `<mod>.<command>` reaches
// only shown copies, so it is what takes new-chat.open|pi|claude|codex (the
// keys) and new-chat.continue:<terminal> (chat-menu's Continue as chat).
//
//   node install/layout.ts install <app home> [--app <herdr-app>] [--no-agents] [--no-menu] [--no-commands]
//                                  [--take-agents-slot] [--take-menu] [--record <file>]
//   node install/layout.ts uninstall <app home> [--record <file>]
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Json = any;
export const AGENTS_MOD = "chat-agents";
export const MENU_MOD = "chat-menu";
export const COMMANDS = { id: "new-chat-commands", edge: "bottom", align: "start", content: { mod: "new-chat", props: { role: "commands" } } };
const isCommands = (f: Json) => f?.id === COMMANDS.id && f?.content?.mod === "new-chat" && f?.content?.props?.role === "commands";

export type Patched = {
  agents: "changed" | "already" | "noslot" | "taken" | "skipped";
  menu: "changed" | "already" | "taken" | "skipped";
  /** The other plugin's mod in a slot: left to it ("taken"), or taken from it ("changed"). */
  agentsHolder?: string;
  menuHolder?: string;
  commands: "changed" | "already" | "skipped";
  menuWas?: string | null;
  /** The layout had no `floating` list before (uninstall then takes the empty list out). */
  floatingAdded?: boolean;
};

function walk(n: Json, fn: (n: Json) => void): void {
  if (!n || typeof n !== "object") return;
  fn(n);
  for (const c of n.children ?? []) walk(c, fn);
}

/** Pure: point the agents slot and terminal_menu at ours; another plugin's only with `take`. `menuWas`: terminal_menu before (null: unset). */
export function patchLayout(layout: Json, want: { agents: boolean; menu: boolean; commands?: boolean; take?: { agents?: boolean; menu?: boolean } }): Patched {
  const out: Patched = { agents: "skipped", menu: "skipped", commands: "skipped" };
  if (want.agents) {
    // The agents slot: Herdr's list, else a block another plugin put in its place
    // (what it replaced in props.replaces, gitview's convention, or the shipped id).
    let shipped: Json = null, other: Json = null, ours = false;
    walk(layout, (n) => {
      const c = n.content;
      if (c?.mod === AGENTS_MOD) ours = true;
      else if (c?.mod === "agents" && !c.props?.sortMenu && (!shipped || n.id === "agents")) shipped = n;
      else if (c?.mod && (c.props?.replaces?.mod === "agents" || n.id === "agents") && !other) other = n;
    });
    if (ours) out.agents = "already";
    else if (shipped) {
      const old = shipped.content;
      shipped.content = { mod: AGENTS_MOD, props: { ...(old.props ?? {}), replaces: old } };
      out.agents = "changed";
    } else if (!other) out.agents = "noslot";
    else {
      out.agentsHolder = other.content.mod;
      if (want.take?.agents) {
        other.content = { mod: AGENTS_MOD, props: { replaces: other.content } }; // its props are the other mod's
        out.agents = "changed";
      } else out.agents = "taken";
    }
  }
  if (want.menu) {
    const cur = layout.terminal_menu;
    if (cur === MENU_MOD) out.menu = "already";
    else if (cur && cur !== "menu" && !want.take?.menu) { out.menu = "taken"; out.menuHolder = cur; }
    else {
      if (cur && cur !== "menu") out.menuHolder = cur;
      out.menuWas = cur ?? null;
      layout.terminal_menu = MENU_MOD;
      out.menu = "changed";
    }
  }
  if (want.commands) {
    if ((layout.floating ?? []).some(isCommands)) out.commands = "already";
    else {
      out.floatingAdded = !Array.isArray(layout.floating);
      layout.floating = [...(layout.floating ?? []), structuredClone(COMMANDS)];
      out.commands = "changed";
    }
  }
  return out;
}

/** Pure: undo patchLayout. `menuWas`, `floatingAdded`: from the record (unknown: unset, and an emptied list goes). Returns whether it changed anything. */
export function restoreLayout(layout: Json, menuWas?: string | null, floatingAdded?: boolean): boolean {
  let changed = false;
  walk(layout, (n) => {
    const c = n.content;
    if (c?.mod === AGENTS_MOD && c.props?.replaces) {
      n.content = c.props.replaces;
      changed = true;
    }
  });
  if (layout.terminal_menu === MENU_MOD) {
    if (menuWas) layout.terminal_menu = menuWas;
    else delete layout.terminal_menu;
    changed = true;
  }
  if (Array.isArray(layout.floating) && layout.floating.some(isCommands)) {
    layout.floating = layout.floating.filter((f: Json) => !isCommands(f));
    if (!layout.floating.length && floatingAdded !== false) delete layout.floating;
    changed = true;
  }
  return changed;
}

export type Target = { edit: string } | { clone: string } | { error: string };

/** Pure: which layout to edit while `shown` is on screen (gitview's choose). */
export function chooseLayout(shown: string, shipped: Set<string>, personal: [string, Json][]): Target {
  if (!shipped.has(shown)) return { edit: shown };
  const copies = personal.filter(([, l]) => l?.cloned_from?.name === shown).map(([n]) => n);
  if (copies.includes(`${shown}-copy`)) return { edit: `${shown}-copy` };
  if (copies.length === 1) return { edit: copies[0]! };
  if (!copies.length) {
    if (personal.some(([n]) => n === `${shown}-copy`)) return { error: `${shown}-copy exists but isn't a copy of ${shown}: switch to the layout you want sub-agent chats in and run the install again` };
    return { clone: shown };
  }
  return { error: `you have several copies of ${shown} (${copies.join(", ")}): switch to the one you want sub-agent chats in and run the install again` };
}

function shippedLayouts(home: string): Set<string> {
  const rec = JSON.parse(readFileSync(join(home, "installed.json"), "utf8"));
  return new Set(Object.keys(rec).filter((k) => k.startsWith("layout:")).map((k) => k.slice(7)));
}

function personalLayouts(home: string, shipped: Set<string>): [string, Json][] {
  const dir = join(home, "layouts");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).filter((n) => !shipped.has(n)).sort()
    .flatMap((n): [string, Json][] => { try { return [[n, JSON.parse(readFileSync(join(dir, `${n}.json`), "utf8"))]]; } catch { return []; } });
}

function shownLayout(home: string, app: string | null): string {
  if (app) {
    try {
      const s = JSON.parse(execFileSync(app, ["status"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, HERDR_APP_HOME: home } }));
      if (typeof s.layout === "string") return s.layout;
    } catch {}
  }
  try { return JSON.parse(readFileSync(join(home, "shared.json"), "utf8")).layout ?? "main"; } catch { return "main"; }
}

/** Read, change and replace `path` whole, unless it changed meanwhile (then again). */
function editJson(path: string, edit: (v: Json) => boolean): boolean {
  for (let i = 0; i < 5; i++) {
    const before = readFileSync(path, "utf8");
    const v = JSON.parse(before);
    if (!edit(v)) return false;
    const tmp = join(path, "..", `.${path.split("/").pop()}.pi-chat.tmp`);
    writeFileSync(tmp, JSON.stringify(v, null, 2) + "\n");
    if (readFileSync(path, "utf8") !== before) { rmSync(tmp, { force: true }); continue; }
    renameSync(tmp, path);
    return true;
  }
  throw new Error(`${path} keeps changing; run the install again`);
}

type InstallRecord = { layouts: { [name: string]: { menuWas?: string | null; floatingAdded?: boolean } } };
const readRecord = (f: string): InstallRecord => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return { layouts: {} }; } };

export function install(home: string, o: { app: string | null; agents: boolean; menu: boolean; commands?: boolean; take?: { agents?: boolean; menu?: boolean }; record: string }): string[] {
  const say: string[] = [];
  const shipped = shippedLayouts(home);
  const shown = shownLayout(home, o.app);
  const target = chooseLayout(shown, shipped, personalLayouts(home, shipped));
  if ("error" in target) return [`layout: ${target.error}; sub-agents keep their TUI peek`];
  let name: string;
  if ("clone" in target) {
    if (!o.app) return [`layout: ${shown} is Herdr's own and herdr-app isn't found to clone it; sub-agents keep their TUI peek`];
    execFileSync(o.app, ["do", "layout.clone", "--name", target.clone], { encoding: "utf8", timeout: 10000, env: { ...process.env, HERDR_APP_HOME: home } });
    name = `${target.clone}-copy`;
    const deadline = Date.now() + 3000;
    while (!existsSync(join(home, "layouts", `${name}.json`))) {
      if (Date.now() > deadline) throw new Error(`layout.clone ${target.clone} made no ${name}`);
      execFileSync("sleep", ["0.05"]);
    }
    say.push(`layout: cloned ${target.clone} as ${name}, your personal layout from now on (Herdr's own layouts can't be edited)`);
  } else {
    name = target.edit;
    if (name !== shown) say.push(`layout: ${shown} is Herdr's own: editing your copy ${name} (switch to it to see sub-agent chats)`);
  }
  let r: Patched = { agents: "skipped", menu: "skipped", commands: "skipped" };
  editJson(join(home, "layouts", `${name}.json`), (l) => {
    r = patchLayout(l, { agents: o.agents, menu: o.menu, commands: o.commands ?? true, take: o.take });
    return r.agents === "changed" || r.menu === "changed" || r.commands === "changed";
  });
  if (r.menu === "changed" || r.commands === "changed") {
    const rec = readRecord(o.record);
    const was = rec.layouts[name] ?? {};
    rec.layouts[name] = {
      ...was,
      ...(r.menu === "changed" ? { menuWas: r.menuWas ?? null } : {}),
      ...(r.commands === "changed" ? { floatingAdded: r.floatingAdded ?? false } : {}),
    };
    writeFileSync(o.record, JSON.stringify(rec, null, 2) + "\n");
  }
  const giveBack = (holder?: string) => (holder ? `was ${holder}'s: uninstall gives it back` : "");
  const agents = {
    changed: `the agents list opens a chat sub-agent as the chat${r.agentsHolder ? ` (${giveBack(r.agentsHolder)})` : ""}`,
    already: "the agents list already opens chat sub-agents as chats",
    noslot: "no agents block (a mod `agents`): left as it is",
    taken: "the agents block is another plugin's (below)",
    skipped: "agents list left as it is",
  }[r.agents];
  const menu = {
    changed: `right-click offers Open as chat (terminal_menu: chat-menu${r.menuHolder ? `; ${giveBack(r.menuHolder)}` : ""})`,
    already: "right-click already offers Open as chat",
    taken: "terminal_menu is another plugin's (below)",
    skipped: "right-click menu left as it is",
  }[r.menu];
  const commands = { changed: "new-chat's keys work (a new-chat copy in its floating list)", already: "new-chat's keys already work", skipped: "" }[r.commands];
  say.push(`layout ${name}: ${agents}; ${menu}${commands ? `; ${commands}` : ""}`);
  if (r.agents === "taken") say.push(`layout ${name}: the agents block shows ${r.agentsHolder} (another plugin's): left to it, so a chat sub-agent's row opens Herdr's peek, not the chat. To take it: ./install.sh --take-agents-slot (uninstall gives it back)`);
  if (r.menu === "taken") say.push(`layout ${name}: terminal_menu is ${r.menuHolder} (another plugin's): left to it, so right-click has no Open as chat or Continue as chat. To take it: ./install.sh --take-menu (uninstall gives it back)`);
  return say;
}

export function uninstall(home: string, recordFile: string): string[] {
  const say: string[] = [];
  const rec = readRecord(recordFile);
  let shipped: Set<string>;
  try { shipped = shippedLayouts(home); } catch { return ["layout: no installed.json, can't tell Herdr's layouts from yours: left as they are"]; }
  for (const [name] of personalLayouts(home, shipped)) {
    if (editJson(join(home, "layouts", `${name}.json`), (l) => restoreLayout(l, rec.layouts[name]?.menuWas, rec.layouts[name]?.floatingAdded))) say.push(`layout ${name}: the agents list and right-click menu are Herdr's again`);
  }
  rmSync(recordFile, { force: true });
  return say;
}

if (import.meta.main) {
  const [cmd, home, ...rest] = process.argv.slice(2);
  const flag = (f: string) => rest.includes(f);
  const value = (f: string) => { const i = rest.indexOf(f); return i >= 0 ? rest[i + 1] ?? null : null; };
  if (!home || (cmd !== "install" && cmd !== "uninstall")) {
    process.stderr.write("usage: node install/layout.ts install|uninstall <app home> [--app <herdr-app>] [--no-agents] [--no-menu] [--no-commands] [--take-agents-slot] [--take-menu] [--record <file>]\n");
    process.exit(2);
  }
  const record = value("--record") ?? join(home, "data", "pi-chat", "install-layout.json");
  try {
    const lines = cmd === "install" ? install(home, { app: value("--app"), agents: !flag("--no-agents"), menu: !flag("--no-menu"), commands: !flag("--no-commands"), take: { agents: flag("--take-agents-slot"), menu: flag("--take-menu") }, record }) : uninstall(home, record);
    for (const l of lines) process.stdout.write(`pi-chat: ${l}\n`);
  } catch (e) {
    process.stderr.write(`pi-chat: layout: ${e instanceof Error ? e.message : e}\n`);
    process.exit(1);
  }
}
