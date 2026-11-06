// The Herdr versions this was tested with, against the ones installed. The
// tested and minimum versions live in package.json's "herdr" entry. The mods
// lean on Herdr internals (README "Limits": the hidden host pane, the copies
// of the shipped agents list and menu, the floating new-chat block,
// terminal_menu), so a newer Herdr is a warning and one older than the
// minimum is refused.
//
//   node install/compat.ts check --app <herdr-app> --hc <hc>   warnings on stdout; a refusal on stderr, exit 1
//   node install/compat.ts app-version <herdr-app>             the version, or "unknown"
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type Compat = { tested: { app: string; core: string }; minimum: { app: string; why: string } };
export const COMPAT: Compat = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")).herdr;

// How the person ran the install: ./install.sh in a clone, the curl one-liner for a release.
const INSTALL = process.env.HERDR_CHAT_INSTALL_CMD || "./install.sh";
const UNINSTALL = `If something breaks, \`${INSTALL} --uninstall\``;

/** `<bin> --version`'s x.y.z, or null when it says nothing usable. */
export function versionOf(bin: string): string | null {
  const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 5000 });
  return r.status === 0 ? (/(\d+\.\d+\.\d+)/.exec(r.stdout)?.[1] ?? null) : null;
}

/** <0, 0, >0 by number (0.1.9 < 0.1.12); a pre-release suffix is ignored. */
export function compare(a: string, b: string): number {
  const p = (v: string) => v.split(/[.-]/).slice(0, 3).map((n) => parseInt(n, 10) || 0);
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}

/** Pure: the warnings to print, or the refusal. */
export function decide(v: { app: string | null; core: string | null }, c: Compat = COMPAT): { refuse: string | null; warn: string[] } {
  const warn: string[] = [];
  if (v.app === null) warn.push(`can't tell Herdr's version (herdr-app --version said nothing usable): tested with ${c.tested.app}. ${UNINSTALL}`);
  else if (compare(v.app, c.minimum.app) < 0) return { refuse: `Herdr ${v.app} is older than ${c.minimum.app}, the oldest the chat works with (${c.minimum.why}). Update Herdr, then run ${INSTALL} again.`, warn };
  else if (compare(v.app, c.tested.app) > 0) warn.push(`Herdr ${v.app} is newer than the tested ${c.tested.app}. ${UNINSTALL}`);
  if (v.core === null) warn.push(`can't tell herdr-core's version (hc --version said nothing usable): tested with ${c.tested.core}. ${UNINSTALL}`);
  else if (compare(v.core, c.tested.core) > 0) warn.push(`herdr-core ${v.core} is newer than the tested ${c.tested.core}. ${UNINSTALL}`);
  return { refuse: null, warn };
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  const value = (f: string) => { const i = rest.indexOf(f); return i >= 0 ? rest[i + 1] ?? null : null; };
  if (cmd === "app-version" && rest[0]) {
    process.stdout.write((versionOf(rest[0]) ?? "unknown") + "\n");
  } else if (cmd === "check" && value("--app") && value("--hc")) {
    const r = decide({ app: versionOf(value("--app")!), core: versionOf(value("--hc")!) });
    for (const w of r.warn) process.stdout.write(`pi-chat: ${w}\n`);
    if (r.refuse) { process.stderr.write(`pi-chat: ${r.refuse}\n`); process.exit(1); }
  } else {
    process.stderr.write("usage: node install/compat.ts check --app <herdr-app> --hc <hc> | app-version <herdr-app>\n");
    process.exit(2);
  }
}
