// The install-time copies of Herdr's shipped mods that chat-agents and
// chat-menu extend (a mod may import only files in its own folder, and shipped
// mods are restored on every start, so they can't be edited: research
// subagent-chat.md §1.3). Each copy is checked first: if the shipped mod no
// longer has what the extension relies on, that mod isn't installed (and the
// layout doesn't point at it), with the reason.
//
//   node install/mods.ts bases <shipped mods dir> <stage dir>
//     writes <stage>/chat-agents/agents-base.js and <stage>/chat-menu/menu-base.js
//     where they pass; prints {"chat-agents": "ok" | "<why not>", "chat-menu": …}
//
// And whether an old mod name (`pi`, the chat before its rename) is still in
// use: a pane keeps its mod's name, so an open or saved tab showing `pi` needs
// mods/pi. The tabs are the core's layout document ("herdr-app", doc.get
// over `hc connect`); the layouts are the app home's layouts/*.json.
//
//   node install/mods.ts legacy <app home> <mod> [--hc <hc>]
//     prints "remove" or "keep: <why>"
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Base = { ok: true; base: string } | { ok: false; why: string };

const HEADER = (from: string) => `// Herdr's shipped ${from}, copied by herdr-chat's install.sh. Don't edit: the next install replaces it.\n`;
const DEFAULT_VIEW = /^export default class \w+ extends View\b/m;

// The body of method `name` (from its line to the next method at the same indent).
function methodBody(src: string, name: string): string | null {
  const m = new RegExp(`^(\\s+)${name}\\([^)]*\\)\\s*\\{`, "m").exec(src);
  if (!m) return null;
  const rest = src.slice(m.index + m[0].length);
  const next = new RegExp(`^${m[1]}(?:async\\s+)?[A-Za-z_]\\w*\\([^)]*\\)\\s*\\{`, "m").exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

/** The agents list: a sub-agent row's click must go through `peek(addr)`, the one method chat-agents overrides. */
export function agentsBase(src: string): Base {
  if (!DEFAULT_VIEW.test(src)) return { ok: false, why: "mods/agents/main.js has no `export default class … extends View`" };
  const peek = methodBody(src, "peek");
  if (peek === null) return { ok: false, why: "mods/agents/main.js defines no peek(addr) method" };
  if (!/terminal\.peek/.test(peek)) return { ok: false, why: "mods/agents/main.js's peek() no longer runs terminal.peek" };
  const row = methodBody(src, "subRow");
  if (row === null) return { ok: false, why: "mods/agents/main.js has no subRow() (the sub-agent rows)" };
  if (!/on_click\([^)]*\)\s*=>\s*this\.peek\(/.test(row)) return { ok: false, why: "a sub-agent row's click no longer calls this.peek(): the chat override would never run" };
  return { ok: true, base: HEADER("mods/agents/main.js") + src };
}

/** The right-click menu: chat-menu draws its items above the base view's render(). */
export function menuBase(src: string): Base {
  if (!DEFAULT_VIEW.test(src)) return { ok: false, why: "mods/menu/main.js has no `export default class … extends View`" };
  if (methodBody(src, "render") === null) return { ok: false, why: "mods/menu/main.js has no render()" };
  return { ok: true, base: HEADER("mods/menu/main.js") + src };
}

export const BASES = [
  { mod: "chat-agents", shipped: "agents", file: "agents-base.js", check: agentsBase },
  { mod: "chat-menu", shipped: "menu", file: "menu-base.js", check: menuBase },
] as const;

/** Writes each base into its staged mod folder; returns "ok" or why not, per mod. */
export function writeBases(shippedDir: string, stageDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const b of BASES) {
    const src = join(shippedDir, b.shipped, "main.js");
    if (!existsSync(src)) { out[b.mod] = `no ${src} (start the app once, so it writes its own mods)`; continue; }
    const r = b.check(readFileSync(src, "utf8"));
    if (!r.ok) { out[b.mod] = r.why; continue; }
    if (existsSync(join(stageDir, b.mod))) writeFileSync(join(stageDir, b.mod, b.file), r.base);
    out[b.mod] = "ok";
  }
  return out;
}

type Json = any;
function uses(n: Json, mod: string): boolean {
  if (!n || typeof n !== "object") return false;
  if (n.mod === mod && (n.props === undefined || typeof n.props === "object")) return true;
  return Object.values(n).some((v) => uses(v, mod));
}

/** The core's layout document (every space's tabs, open and saved), or why it can't be read. */
export function readTabs(hc: string): { value: Json } | { error: string } {
  const hello = '{"jsonrpc":"2.0","id":1,"method":"hello","params":{"generation":1}}';
  const get = '{"jsonrpc":"2.0","id":2,"method":"doc.get","params":{"name":"herdr-app"}}';
  const r = spawnSync(hc, ["connect"], { input: `${hello}\n${get}\n`, encoding: "utf8", timeout: 5000 });
  if (r.status !== 0) return { error: (r.stderr || r.stdout || `hc connect: exit ${r.status}`).trim().split("\n")[0]! };
  for (const l of r.stdout.split("\n")) {
    let m: Json;
    try { m = JSON.parse(l); } catch { continue; }
    if (m?.id !== 2) continue;
    if (m.error || !m.result?.value?.spaces) return { error: m.error?.message ?? "no layout document" };
    return { value: m.result.value };
  }
  return { error: "doc.get: no answer" };
}

/** Pure: why `mod` is still needed, or null. `tabs`: the layout document; `layouts`: [name, layout]. */
export function legacyUse(mod: string, tabs: Json, layouts: [string, Json][]): string | null {
  for (const s of tabs?.spaces ?? []) for (const t of s.tabs ?? []) if (uses(t, mod)) return `a tab still shows it (${t.name || t.id})`;
  for (const [name, l] of layouts) if (uses(l, mod)) return `layout ${name} uses it`;
  return null;
}

export function legacy(home: string, mod: string, hc: string): string {
  const dir = join(home, "layouts");
  const layouts: [string, Json][] = existsSync(dir)
    ? readdirSync(dir).filter((f) => f.endsWith(".json")).flatMap((f): [string, Json][] => { try { return [[f.slice(0, -5), JSON.parse(readFileSync(join(dir, f), "utf8"))]]; } catch { return []; } })
    : [];
  const fromLayouts = legacyUse(mod, null, layouts);
  if (fromLayouts) return `keep: ${fromLayouts}`;
  const tabs = readTabs(hc);
  if ("error" in tabs) return `keep: can't read Herdr's open tabs to tell whether one still shows it (${tabs.error})`;
  const why = legacyUse(mod, tabs.value, []);
  return why ? `keep: ${why}` : "remove";
}

if (import.meta.main) {
  const [cmd, a, b, ...rest] = process.argv.slice(2);
  if (cmd === "bases" && a && b) process.stdout.write(JSON.stringify(writeBases(a, b)) + "\n");
  else if (cmd === "legacy" && a && b) {
    const i = rest.indexOf("--hc");
    process.stdout.write(legacy(a, b, (i >= 0 && rest[i + 1]) || "hc") + "\n");
  } else {
    process.stderr.write("usage: node install/mods.ts bases <shipped mods dir> <stage dir> | legacy <app home> <mod> [--hc <hc>]\n");
    process.exit(2);
  }
}
