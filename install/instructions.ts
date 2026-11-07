// The sub-agents note in each agent's own instruction file: Pi's AGENTS.md,
// Claude Code's CLAUDE.md, Codex's AGENTS.md. It tells an agent that runs in
// Herdr to start its Pi, Claude Code or Codex sub-agents with the hc
// templates install.sh writes (pi-chat, claude-chat, codex-chat), so the
// person can open them as chats.
//
// The note is one block between marker lines. A file is written only for an
// agent whose config folder exists (created when missing). Install again
// replaces the block where it is; uninstall takes out the block and the
// separator it added, so the file is byte for byte what it was, and a file
// the install created goes when nothing else is left in it. What it added is
// recorded in data/herdr-chat/install-instructions.json.
//
//   node install/instructions.ts install|uninstall <app home>
//   (Pi: $PI_CODING_AGENT_DIR else ~/.pi/agent; Claude Code: $CLAUDE_CONFIG_DIR
//   else ~/.claude; Codex: $CODEX_HOME else ~/.codex)
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const BEGIN = "<!-- herdr-chat:subagents begin -->";
export const END = "<!-- herdr-chat:subagents end -->";
export const BLOCK = [
  BEGIN,
  "## Sub-agents in Herdr",
  'To start a Pi, Claude Code or Codex sub-agent, run `hc run --bg --name <name> pi-chat "<task>"` (or `claude-chat`, `codex-chat`), so the person can open it as a chat.',
  "Use `hc run --bg --name <name> -- pi` (or `-- claude`, `-- codex`) only when you need its terminal UI.",
  "Everything else is the same: `hc send`, `hc wait`, `hc read` and `hc kill` by name.",
  END,
].join("\n") + "\n";

export type Agent = { id: "pi" | "claude" | "codex"; name: string; dir: string; file: string };

export function agents(env: NodeJS.ProcessEnv, home = env.HOME || homedir()): Agent[] {
  const pi = env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent");
  const claude = env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  const codex = env.CODEX_HOME || join(home, ".codex");
  return [
    { id: "pi", name: "Pi", dir: pi, file: join(pi, "AGENTS.md") },
    { id: "claude", name: "Claude Code", dir: claude, file: join(claude, "CLAUDE.md") },
    { id: "codex", name: "Codex", dir: codex, file: join(codex, "AGENTS.md") },
  ];
}

/** Where the block is: [start of the BEGIN line, end of the END line and its newline). */
function region(text: string): [number, number] | null {
  const b = text.startsWith(BEGIN + "\n") ? 0 : text.indexOf("\n" + BEGIN + "\n") + 1;
  if (b <= 0 && !text.startsWith(BEGIN + "\n")) return null;
  const e = text.indexOf("\n" + END, b);
  if (e < 0) return null;
  let end = e + 1 + END.length;
  if (text[end] === "\n") end++;
  return [b, end];
}

/** Pure: the text with the block (in place of an old one, else at the end), and the separator it put before it. */
export function addBlock(text: string): { text: string; sep: string | null } {
  const r = region(text);
  if (r) return { text: text.slice(0, r[0]) + BLOCK + text.slice(r[1]), sep: null };
  const sep = text === "" || text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
  return { text: text + sep + BLOCK, sep };
}

/** Pure: the text without the block and the separator the install put before it (unknown: one blank line). */
export function removeBlock(text: string, sep: string | null | undefined): string {
  const r = region(text);
  if (!r) return text;
  let [b, e] = r;
  const before = sep ?? (text.slice(0, b).endsWith("\n\n") ? "\n" : "");
  if (before && text.slice(b - before.length, b) === before) b -= before.length;
  return text.slice(0, b) + text.slice(e);
}

type Rec = { files: { [path: string]: { sep: string | null; created: boolean } } };
const readRec = (f: string): Rec => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return { files: {} }; } };
const isDir = (d: string) => { try { return statSync(d).isDirectory(); } catch { return false; } };

// In place, not by rename: a file that is a symlink (into dotfiles) stays one.
const writeWhole = (path: string, text: string) => writeFileSync(path, text);

export function install(recFile: string, list: Agent[]): string[] {
  const rec = readRec(recFile);
  const say: string[] = [];
  for (const a of list) {
    if (!isDir(a.dir)) { say.push(`${a.name}: no ${a.dir} (not installed): no sub-agents note`); continue; }
    const had = existsSync(a.file);
    const before = had ? readFileSync(a.file, "utf8") : "";
    const { text, sep } = addBlock(before);
    const prev = rec.files[a.file];
    // A block already there keeps the separator (and created) of the install that put it there.
    rec.files[a.file] = sep === null && prev ? prev : { sep, created: !had };
    if (text !== before || !had) writeWhole(a.file, text);
    say.push(`${a.name}: ${text === before ? "the sub-agents note is up to date in" : sep === null ? "updated the sub-agents note in" : "added the sub-agents note to"} ${a.file}`);
  }
  writeFileSync(recFile, JSON.stringify(rec, null, 2) + "\n");
  return say;
}

export function uninstall(recFile: string, list: Agent[]): string[] {
  const rec = readRec(recFile);
  const say: string[] = [];
  // Only this home's agent files: a record copied from elsewhere names paths that aren't ours to change.
  for (const f of new Set(list.map((a) => a.file))) {
    if (!existsSync(f)) continue;
    const before = readFileSync(f, "utf8");
    const r = rec.files[f];
    const after = removeBlock(before, r?.sep);
    if (after === before) continue;
    if (after === "" && r?.created) { rmSync(f); say.push(`removed ${f} (the install made it)`); }
    else { writeWhole(f, after); say.push(`took the sub-agents note out of ${f}`); }
  }
  rmSync(recFile, { force: true });
  return say;
}

if (import.meta.main) {
  const [cmd, home] = process.argv.slice(2);
  if (!home || (cmd !== "install" && cmd !== "uninstall")) {
    process.stderr.write("usage: node install/instructions.ts install|uninstall <app home>\n");
    process.exit(2);
  }
  const recFile = join(home, "data", "herdr-chat", "install-instructions.json");
  try {
    const lines = cmd === "install" ? install(recFile, agents(process.env)) : uninstall(recFile, agents(process.env));
    for (const l of lines) process.stdout.write(`herdr-chat: ${l}\n`);
  } catch (e) {
    process.stderr.write(`herdr-chat: instructions: ${e instanceof Error ? e.message : e}\n`);
    process.exit(1);
  }
}
