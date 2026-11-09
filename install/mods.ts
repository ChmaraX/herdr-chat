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

import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
  // Herdr 0.1.14: a row in a pane focuses it, any other still peeks (a chat's sub-agent has no pane).
  if (!/on_click\([^)]*\)\s*=>[^\n]*this\.peek\(/.test(row)) return { ok: false, why: "a sub-agent row's click no longer calls this.peek(): the chat override would never run" };
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

if (import.meta.main) {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === "bases" && a && b) process.stdout.write(JSON.stringify(writeBases(a, b)) + "\n");
  else {
    process.stderr.write("usage: node install/mods.ts bases <shipped mods dir> <stage dir>\n");
    process.exit(2);
  }
}
