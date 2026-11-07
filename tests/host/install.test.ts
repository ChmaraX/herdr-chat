// The install on scratch homes: install/layout.ts (the layout edits that route
// a chat sub-agent's click to the chat, new-chat's floating copy, their exact
// undo), install/mods.ts (the guards on the install-time copies of Herdr's
// shipped mods), install/keys.ts (the person's global chat keys into Herdr's
// keys.json and back), install/instructions.ts (the sub-agents note in the
// agents' instruction files and back), and install.sh end to end.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ROOT } from "./harness.ts";
import { agentsBase, writeBases } from "../../install/mods.ts";

const LAYOUT = join(ROOT, "install", "layout.ts");

// A personal layout shaped like a clone of Herdr's `main` (the agents list in the sidebar, no terminal_menu).
const personal = () => ({
  type: "row", id: "root", cloned_from: { name: "main", version: "0.1.11" }, divider: { color: "border", width: 1 },
  children: [
    { type: "column", id: "sidebar", size: { px: 268 }, children: [
      { type: "block", id: "brand", size: { px: 46 }, content: { mod: "workspace-chrome" } },
      { type: "column", id: "sidebar-lists", children: [
        { type: "block", id: "spaces", min: 90, size: { weight: 1 }, content: { mod: "spaces" } },
        { type: "block", id: "agents", min: 90, size: { weight: 1 }, content: { mod: "agents" } },
      ] },
    ] },
    { type: "block", id: "main", content: { pane: { gap: 8 }, tab: "active" } },
  ],
  floating: [{ id: "x-sync", edge: "bottom", align: "end", content: { mod: "other", props: { role: "sync" } } }],
});

function home(shown: string, layouts: Record<string, object>) {
  const h = mkdtempSync(join(tmpdir(), "herdr-chat-install-"));
  mkdirSync(join(h, "layouts"));
  mkdirSync(join(h, "data", "herdr-chat"), { recursive: true });
  writeFileSync(join(h, "installed.json"), JSON.stringify({ "layout:main": { json: "x" }, "layout:terminals": { json: "y" }, agents: {} }));
  writeFileSync(join(h, "shared.json"), JSON.stringify({ layout: shown }));
  writeFileSync(join(h, "layouts", "main.json"), JSON.stringify({ type: "row", id: "root", children: [{ type: "block", id: "agents", content: { mod: "agents" } }] }, null, 2) + "\n");
  for (const [n, l] of Object.entries(layouts)) writeFileSync(join(h, "layouts", `${n}.json`), JSON.stringify(l, null, 2) + "\n");
  return h;
}
const run = (cmd: string, h: string, ...a: string[]) => execFileSync(process.execPath, [LAYOUT, cmd, h, ...a], { encoding: "utf8" });
const read = (h: string, n: string) => readFileSync(join(h, "layouts", `${n}.json`), "utf8");
const find = (n: any, id: string): any => (n?.id === id ? n : (n?.children ?? []).map((c: any) => find(c, id)).find(Boolean));

test("layout: the personal layout on screen gets the chat agents list and menu; a second install changes nothing; uninstall gives back the same bytes", () => {
  const h = home("main-mods", { "main-mods": personal() });
  const before = read(h, "main-mods");
  const shippedBefore = read(h, "main");
  const out = run("install", h);
  assert.match(out, /layout main-mods: the agents list opens a chat sub-agent as the chat; right-click offers Open as chat .*; new-chat's keys work/);
  const l = JSON.parse(read(h, "main-mods"));
  assert.deepEqual(find(l, "agents").content, { mod: "chat-agents", props: { replaces: { mod: "agents" } } });
  assert.equal(l.terminal_menu, "chat-menu");
  // new-chat's always-shown copy (the new-chat.* commands) after the person's own floating blocks.
  assert.deepEqual(l.floating, [...personal().floating, { id: "new-chat-commands", edge: "bottom", align: "start", content: { mod: "new-chat", props: { role: "commands" } } }]);
  assert.equal(read(h, "main"), shippedBefore, "Herdr's own layout is never edited");
  const once = read(h, "main-mods");
  assert.match(run("install", h), /already opens chat sub-agents as chats; right-click already offers Open as chat; new-chat's keys already work/);
  assert.equal(read(h, "main-mods"), once);

  assert.match(run("uninstall", h), /layout main-mods: the agents list and right-click menu are Herdr's again/);
  assert.equal(read(h, "main-mods"), before);
  assert.ok(!existsSync(join(h, "data", "herdr-chat", "install-layout.json")), "the record goes with the uninstall");
});

test("layout: a layout with no floating list gets one for new-chat's copy, and loses it again on uninstall", () => {
  const bare = personal();
  delete (bare as any).floating;
  const h = home("main-mods", { "main-mods": bare });
  const before = read(h, "main-mods");
  run("install", h);
  assert.equal(JSON.parse(read(h, "main-mods")).floating.length, 1);
  run("uninstall", h);
  assert.equal(read(h, "main-mods"), before);
});

test("layout: another mod in the agents block (found by its id) and another terminal_menu stay theirs, through install and uninstall", () => {
  const mine = personal();
  (mine as any).terminal_menu = "my-menu";
  find(mine, "agents").content = { mod: "gitview-agents" }; // not the agents list any more
  const h = home("main-mods", { "main-mods": mine });
  const before = read(h, "main-mods");
  const out = run("install", h);
  assert.match(out, /the agents block shows gitview-agents \(another plugin's\): left to it/);
  assert.match(out, /terminal_menu is my-menu \(another plugin's\): left to it/);
  const l = JSON.parse(read(h, "main-mods"));
  l.floating = l.floating.filter((f: any) => f.content.mod !== "new-chat"); // the one change: new-chat's copy
  assert.equal(JSON.stringify(l, null, 2) + "\n", before);
  run("uninstall", h);
  assert.equal(read(h, "main-mods"), before);
});

test("layout: Herdr's own layout on screen: the person's one copy is edited, never the shipped one; no copy and no app: nothing changes", () => {
  const h = home("main", { "work": personal() });
  const out = run("install", h);
  assert.match(out, /main is Herdr's own: editing your copy work/);
  assert.equal(JSON.parse(read(h, "work")).terminal_menu, "chat-menu");
  assert.equal(JSON.parse(read(h, "main")).terminal_menu, undefined);
  run("uninstall", h);
  assert.equal(JSON.parse(read(h, "work")).terminal_menu, undefined);

  const bare = home("main", {});
  const r = spawnSync(process.execPath, [LAYOUT, "install", bare], { encoding: "utf8" });
  assert.match(r.stdout, /main is Herdr's own and herdr-app isn't found to clone it/);
  assert.equal(JSON.parse(read(bare, "main")).terminal_menu, undefined);
});

test("mods: the agents copy is installed only while a sub-agent row's click goes through peek()", () => {
  const shipped = (rowClick: string) => `import { View } from "gpui-kit";
export default class Agents extends View {
  peek(addr) {
    run("terminal.peek", { terminal: addr });
  }

  subRow(t, s) {
    const k = s.t;
    return h_flex().id("x")${rowClick}.child("y");
  }

  render(cx) {
    return div();
  }
}
`;
  assert.equal(agentsBase(shipped(".on_click(() => this.peek(k.address))")).ok, true);
  const inline = agentsBase(shipped(`.on_click(() => run("terminal.peek", { terminal: k.address }))`));
  assert.equal(inline.ok, false);
  assert.match((inline as { why: string }).why, /no longer calls this\.peek/);

  // writeBases: the failing mod gets no base (install.sh then leaves it and its layout edit out).
  const dir = mkdtempSync(join(tmpdir(), "herdr-chat-bases-"));
  for (const m of ["agents", "menu"]) mkdirSync(join(dir, "shipped", m), { recursive: true });
  for (const m of ["chat-agents", "chat-menu"]) mkdirSync(join(dir, "stage", m), { recursive: true });
  writeFileSync(join(dir, "shipped", "agents", "main.js"), shipped(`.on_click(() => run("terminal.peek", { terminal: k.address }))`));
  writeFileSync(join(dir, "shipped", "menu", "main.js"), shipped(""));
  const r = writeBases(join(dir, "shipped"), join(dir, "stage"));
  assert.notEqual(r["chat-agents"], "ok");
  assert.equal(r["chat-menu"], "ok");
  assert.ok(!existsSync(join(dir, "stage", "chat-agents", "agents-base.js")));
  assert.ok(existsSync(join(dir, "stage", "chat-menu", "menu-base.js")));
});

// --- keys: install/keys.ts ------------------------------------------------------------
const KEYS = join(ROOT, "install", "keys.ts");
// A keys.json shaped like the person's: Herdr's keys, an older install's launcher key, Pi's TUI key.
const herdrKeys = () => ({
  global: { "cmd-b": "layout.toggle:sidebar", "cmd-j p": "mod.open:open-pi", "cmd-k": "mod.open:picker", "cmd-j shift-p": "mod.open:new-chat" },
  terminal: { "cmd-c": "terminal.copy" },
});
function keysHome(o: { keys?: object; mine?: object; record?: object } = {}) {
  const h = mkdtempSync(join(tmpdir(), "herdr-chat-keys-"));
  mkdirSync(join(h, "data", "herdr-chat"), { recursive: true });
  writeFileSync(join(h, "keys.json"), JSON.stringify(o.keys ?? herdrKeys(), null, 2) + "\n");
  if (o.mine) writeFileSync(join(h, "data", "herdr-chat", "keys.json"), JSON.stringify(o.mine));
  // What the older install recorded for its cmd-j shift-p.
  writeFileSync(join(h, "data", "herdr-chat", "install.json"), JSON.stringify(o.record ?? { version: 2, global: { "cmd-j shift-p": { action: "mod.open:new-chat", was: null } } }));
  return h;
}
const keys = (cmd: string, h: string, ...a: string[]) => execFileSync(process.execPath, [KEYS, cmd, h, "--platform", "darwin", ...a], { encoding: "utf8" });
const global = (h: string) => JSON.parse(readFileSync(join(h, "keys.json"), "utf8")).global;

test("keys: the default (⌘I opens the launcher), the older install's cmd-j shift-p taken out, a second install changes nothing", () => {
  const h = keysHome();
  const out = keys("install", h);
  assert.equal(out.trim().split("\n").at(-1), "New chat: ⌘I", "the last line: the real chord");
  const g = global(h);
  assert.equal(g["cmd-i"], "mod.open:new-chat");
  assert.equal(g["cmd-j shift-p"], undefined, "the older install's binding is gone");
  assert.equal(g["cmd-j p"], "mod.open:open-pi", "Pi's TUI key stays");
  assert.ok(!Object.values(g).some((v) => String(v).startsWith("new-chat.")), "pi, claude, codex unbound by default");
  const once = readFileSync(join(h, "keys.json"), "utf8");
  keys("install", h);
  assert.equal(readFileSync(join(h, "keys.json"), "utf8"), once);
});

test("keys: chords the person chose replace what had them; uninstall gives back exactly that keys.json (without the older install's key)", () => {
  const h = keysHome({ mine: { model: "ctrl-l", global: { open: "cmd-i", pi: "cmd-j p", claude: null } } });
  const want = herdrKeys();
  delete (want.global as any)["cmd-j shift-p"];
  const out = keys("install", h);
  assert.match(out, /Pi chat: ⌘J P replaces mod\.open:open-pi \(uninstall puts it back\)/);
  assert.match(out.trim().split("\n").at(-1)!, /^New chat: ⌘I · Pi chat: ⌘J P$/);
  assert.equal(global(h)["cmd-j p"], "new-chat.pi");
  // The person moves Pi's chat elsewhere: the next install gives cmd-j p back to Pi's TUI.
  writeFileSync(join(h, "data", "herdr-chat", "keys.json"), JSON.stringify({ global: { pi: "cmd-alt-p" } }));
  keys("install", h);
  assert.equal(global(h)["cmd-j p"], "mod.open:open-pi");
  assert.equal(global(h)["cmd-alt-p"], "new-chat.pi");
  assert.match(keys("uninstall", h), /back to what they were/);
  assert.equal(readFileSync(join(h, "keys.json"), "utf8"), JSON.stringify(want, null, 2) + "\n");
  assert.ok(!existsSync(join(h, "data", "herdr-chat", "install.json")));
});

test("keys: the default ⌘I taken by something else falls back to ⌘J A, and says so; uninstall leaves ⌘I to it", () => {
  const k = herdrKeys();
  (k.global as any)["cmd-i"] = "mod.open:files";
  const h = keysHome({ keys: k });
  const out = keys("install", h);
  assert.match(out, /⌘I is taken \(mod\.open:files\): New chat is ⌘J A instead/);
  assert.equal(out.trim().split("\n").at(-1), "New chat: ⌘J A");
  assert.equal(global(h)["cmd-i"], "mod.open:files");
  assert.equal(global(h)["cmd-j a"], "mod.open:new-chat");
  keys("uninstall", h);
  assert.equal(global(h)["cmd-i"], "mod.open:files");
  assert.equal(global(h)["cmd-j a"], undefined);
  // Chosen by the person, the same taken chord is theirs: replaced, given back on uninstall.
  const h2 = keysHome({ keys: k, mine: { global: { open: "cmd-i" } } });
  assert.match(keys("install", h2), /New chat: ⌘I replaces mod\.open:files/);
  keys("uninstall", h2);
  assert.equal(global(h2)["cmd-i"], "mod.open:files");
});

test("keys: without the layout's new-chat copy (--no-direct) only the launcher key is bound; the others say why", () => {
  const h = keysHome({ mine: { global: { pi: "cmd-j p" } } });
  const out = keys("install", h, "--no-direct");
  assert.match(out, /Pi chat: ⌘J P not bound: it needs the layout's new-chat copy/);
  assert.equal(global(h)["cmd-j p"], "mod.open:open-pi");
  assert.equal(global(h)["cmd-i"], "mod.open:new-chat");
});

// --- the sub-agents note: install/instructions.ts ---------------------------------------
const INSTR = join(ROOT, "install", "instructions.ts");
function agentHomes(o: { pi?: string | null; claude?: string | null; codex?: string | null }) {
  const d = mkdtempSync(join(tmpdir(), "herdr-chat-instr-"));
  const env = { ...process.env, HOME: join(d, "home"), PI_CODING_AGENT_DIR: join(d, "pi"), CLAUDE_CONFIG_DIR: "", CODEX_HOME: "" };
  mkdirSync(join(d, "app", "data", "herdr-chat"), { recursive: true });
  const files = { pi: join(d, "pi", "AGENTS.md"), claude: join(d, "home", ".claude", "CLAUDE.md"), codex: join(d, "home", ".codex", "AGENTS.md") };
  for (const [k, f] of Object.entries(files)) {
    const v = o[k as keyof typeof o];
    if (v === undefined) continue; // not installed: no folder
    mkdirSync(join(f, ".."), { recursive: true });
    if (v !== null) writeFileSync(f, v);
  }
  const run = (cmd: string) => execFileSync(process.execPath, [INSTR, cmd, join(d, "app")], { encoding: "utf8", env });
  return { d, files, run };
}
const NOTE = /<!-- herdr-chat:subagents begin -->\n## Sub-agents in Herdr\n[^]*pi-chat "<task>"[^]*-- pi[^]*<!-- herdr-chat:subagents end -->\n$/;

test("sub-agents note: added for each installed agent (a missing file made), the same on a second install, byte-identical after uninstall", () => {
  const mine = "# My rules\n\nBe brief.\n";
  const a = agentHomes({ pi: mine, claude: null, codex: "" });
  const out = a.run("install");
  assert.match(out, /Pi: added the sub-agents note/);
  const pi = readFileSync(a.files.pi, "utf8");
  assert.ok(pi.startsWith(mine + "\n<!-- herdr-chat:subagents begin -->"), "after the person's text, a blank line between");
  assert.match(pi, NOTE);
  assert.ok(pi.split("\n").length <= mine.split("\n").length + 8, "short: under ~8 lines");
  assert.match(readFileSync(a.files.claude, "utf8"), /^<!-- herdr-chat:subagents begin -->/, "CLAUDE.md made in ~/.claude");
  assert.match(readFileSync(a.files.codex, "utf8"), /^<!-- herdr-chat:subagents begin -->/);
  const once = Object.values(a.files).map((f) => readFileSync(f, "utf8"));
  assert.match(a.run("install"), /up to date/);
  assert.deepEqual(Object.values(a.files).map((f) => readFileSync(f, "utf8")), once);

  a.run("uninstall");
  assert.equal(readFileSync(a.files.pi, "utf8"), mine);
  assert.ok(!existsSync(a.files.claude), "the file the install made goes");
  assert.equal(readFileSync(a.files.codex, "utf8"), "", "an empty file the person had stays, empty");
});

test("sub-agents note: an old block is replaced where it is (the person's text after it kept); an agent that isn't installed gets nothing", () => {
  const old = "top\n\n<!-- herdr-chat:subagents begin -->\nold words\n<!-- herdr-chat:subagents end -->\n\nmine after\n";
  const a = agentHomes({ pi: old }); // no ~/.claude, no ~/.codex
  const out = a.run("install");
  assert.match(out, /Claude Code: no .*\.claude \(not installed\)/);
  assert.match(out, /Codex: no .*\.codex \(not installed\)/);
  assert.ok(!existsSync(join(a.files.claude, "..")) && !existsSync(join(a.files.codex, "..")), "no folder made for them");
  const t = readFileSync(a.files.pi, "utf8");
  assert.ok(t.startsWith("top\n\n<!-- herdr-chat:subagents begin -->\n## Sub-agents in Herdr") && t.endsWith("<!-- herdr-chat:subagents end -->\n\nmine after\n"), t);
  a.run("uninstall");
  assert.equal(readFileSync(a.files.pi, "utf8"), "top\n\nmine after\n");
});

test("sub-agents note: uninstall touches only the current agents' files, never a path a copied record names", () => {
  const other = agentHomes({ pi: null, claude: null, codex: "" });
  other.run("install"); // the other home: its files carry the note, its record names them
  const theirs = Object.values(other.files).map((f) => readFileSync(f, "utf8"));
  const a = agentHomes({ pi: "# mine\n" });
  copyFileSync(join(other.d, "app", "data", "herdr-chat", "install-instructions.json"), join(a.d, "app", "data", "herdr-chat", "install-instructions.json"));
  a.run("uninstall");
  assert.deepEqual(Object.values(other.files).map((f) => readFileSync(f, "utf8")), theirs, "the other home's files are untouched");
  assert.equal(readFileSync(a.files.pi, "utf8"), "# mine\n");
});

// --- install.sh on a scratch home --------------------------------------------------------
const has = (c: string) => spawnSync("sh", ["-c", `command -v ${c}`]).status === 0;
test("install.sh: --no-subagents writes no templates and no notes; a plain install adds both; --uninstall gives back every file as it was", { skip: !(has("hc") && has("herdr-app")) && "needs hc and herdr-app" }, () => {
  const d = mkdtempSync(join(tmpdir(), "herdr-chat-installsh-"));
  const app = join(d, "app");
  mkdirSync(join(app, "layouts"), { recursive: true });
  writeFileSync(join(app, "installed.json"), JSON.stringify({ "layout:main": {} }));
  writeFileSync(join(app, "shared.json"), JSON.stringify({ layout: "mine" }));
  writeFileSync(join(app, "layouts", "mine.json"), JSON.stringify(personal(), null, 2) + "\n");
  writeFileSync(join(app, "keys.json"), JSON.stringify(herdrKeys(), null, 2) + "\n");
  mkdirSync(join(d, "home", ".codex"), { recursive: true });
  writeFileSync(join(d, "home", ".codex", "AGENTS.md"), "codex rules\n");
  mkdirSync(join(d, "pi"));
  // herdr-app as a newer Herdr (its --version; everything else the real one); the three agents as stubs on PATH.
  const bin = join(d, "bin");
  mkdirSync(bin);
  const realApp = execFileSync("sh", ["-c", "command -v herdr-app"], { encoding: "utf8" }).trim();
  const appAs = (v: string) => { const f = join(bin, `herdr-app-${v}`); writeFileSync(f, `#!/bin/sh\n[ "$1" = --version ] && { echo 'herdr-app ${v}'; exit 0; }\nexec '${realApp}' "$@"\n`, { mode: 0o755 }); return f; };
  for (const a of ["pi", "claude", "codex"]) writeFileSync(join(bin, a), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HERDR_APP_BIN: appAs("9.0.0"), HOME: join(d, "home"), HERDR_APP_HOME: app, XDG_CONFIG_HOME: join(d, "config"), PI_CODING_AGENT_DIR: join(d, "pi"), CLAUDE_CONFIG_DIR: "", CODEX_HOME: "" };
  const sh = (...a: string[]) => {
    const r = spawnSync(join(ROOT, "install.sh"), a, { encoding: "utf8", env });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    return r.stdout;
  };

  // A Herdr older than the minimum: refused before anything is written.
  const old = spawnSync(join(ROOT, "install.sh"), [], { encoding: "utf8", env: { ...env, HERDR_APP_BIN: appAs("0.0.1") } });
  assert.equal(old.status, 1);
  assert.match(old.stderr, /Herdr 0\.0\.1 is older than/);
  assert.ok(!existsSync(join(app, "mods", "chat")) && !existsSync(join(app, "keys.json.bak")), "nothing installed");
  const tpl = join(d, "config", "herdr-core", "templates");
  const before = { layout: read(app, "mine"), keys: readFileSync(join(app, "keys.json"), "utf8") };

  const quiet = sh("--no-subagents");
  assert.equal(quiet.trim().split("\n").at(-1), "  keys       New chat: ⌘I", "the summary's last line: the real chord");
  assert.match(quiet, /^ {2}templates  none \(--no-subagents\)$/m);
  assert.match(quiet, /^herdr-chat: Herdr 9\.0\.0 is newer than the tested .*\n/, "the warning first, then the install");
  assert.ok(!existsSync(join(tpl, "pi-chat.md")), "no templates");
  assert.ok(!existsSync(join(d, "pi", "AGENTS.md")) && readFileSync(join(d, "home", ".codex", "AGENTS.md"), "utf8") === "codex rules\n", "no notes");

  const out = sh();
  for (const p of ["pi", "claude", "codex"]) assert.ok(existsSync(join(tpl, `${p}-chat.md`)), `${p}-chat template`);
  // Each agent install found, by path (a core terminal lacks the login PATH).
  const cfg = JSON.parse(readFileSync(join(app, "mods", "chat", "config.json"), "utf8"));
  for (const p of ["pi", "claude", "codex"]) assert.equal(cfg[p], join(bin, p));
  assert.match(readFileSync(join(d, "pi", "AGENTS.md"), "utf8"), NOTE);
  assert.match(readFileSync(join(d, "home", ".codex", "AGENTS.md"), "utf8"), /^codex rules\n\n<!-- herdr-chat:subagents begin -->/);
  assert.match(out, /Claude Code: no .* \(not installed\)/);
  // The summary names what changed: the notes (Pi's and Codex's, not Claude Code's), the templates, the extension.
  assert.match(out, /^ {2}notes {6}\S*\/pi\/AGENTS\.md, ~\/\.codex\/AGENTS\.md$/m);
  assert.match(out, /^ {2}templates  pi-chat claude-chat codex-chat in /m);
  assert.match(out, /^ {2}extension  \S*\/pi\/extensions\/herdr-chat-lock\.ts /m);
  assert.ok(!existsSync(join(d, "home", ".claude")));
  assert.ok(JSON.parse(read(app, "mine")).floating.some((f: any) => f.content?.mod === "new-chat"), "new-chat's copy in the layout");

  sh("--uninstall");
  assert.equal(read(app, "mine"), before.layout);
  // No older install's record here: its cmd-j shift-p isn't taken for ours.
  assert.equal(readFileSync(join(app, "keys.json"), "utf8"), before.keys, "keys.json as it was");
  assert.ok(!existsSync(join(d, "pi", "AGENTS.md")));
  assert.equal(readFileSync(join(d, "home", ".codex", "AGENTS.md"), "utf8"), "codex rules\n");
  assert.ok(!existsSync(join(tpl, "pi-chat.md")));
});

// --- slots another plugin holds: install/layout.ts ----------------------------------------
// A layout where another plugin (here gitview-agents, gitview's convention: what it replaced in
// props.replaces) holds the agents block, and another mod is the right-click menu.
const theirs = () => {
  const l: any = personal();
  l.terminal_menu = "other-menu";
  find(l, "agents").content = { mod: "other-agents", props: { replaces: { mod: "agents" }, sort: "name" } };
  return l;
};
const withoutCommands = (s: string) => {
  const l = JSON.parse(s);
  l.floating = l.floating.filter((f: any) => f.content?.mod !== "new-chat");
  return JSON.stringify(l, null, 2) + "\n";
};

test("layout: another plugin's agents block and terminal_menu are skipped and named, with what the person loses and the flag that takes them", () => {
  const h = home("main-mods", { "main-mods": theirs() });
  const before = read(h, "main-mods");
  const out = run("install", h);
  assert.match(out, /the agents block shows other-agents \(another plugin's\): left to it, so a chat sub-agent's row opens Herdr's peek, not the chat\. To take it: \.\/install\.sh --take-agents-slot \(uninstall gives it back\)/);
  assert.match(out, /terminal_menu is other-menu \(another plugin's\): left to it, so right-click has no Open as chat or Continue as chat\. To take it: \.\/install\.sh --take-menu \(uninstall gives it back\)/);
  assert.equal(withoutCommands(read(h, "main-mods")), before, "only new-chat's floating copy was added");
  run("uninstall", h);
  assert.equal(read(h, "main-mods"), before);
});

test("layout: --take-agents-slot and --take-menu take another plugin's slots; uninstall gives each back exactly", () => {
  const h = home("main-mods", { "main-mods": theirs() });
  const before = read(h, "main-mods");
  const out = run("install", h, "--take-agents-slot", "--take-menu");
  assert.match(out, /the agents list opens a chat sub-agent as the chat \(was other-agents's: uninstall gives it back\)/);
  assert.match(out, /right-click offers Open as chat \(terminal_menu: chat-menu; was other-menu's: uninstall gives it back\)/);
  const l = JSON.parse(read(h, "main-mods"));
  assert.equal(find(l, "agents").content.mod, "chat-agents");
  assert.deepEqual(find(l, "agents").content.props, { replaces: find(theirs(), "agents").content }, "the other plugin's props aren't passed to ours");
  assert.equal(l.terminal_menu, "chat-menu");
  assert.match(run("install", h, "--take-agents-slot", "--take-menu"), /already opens chat sub-agents as chats; right-click already offers Open as chat/);
  run("uninstall", h);
  assert.equal(read(h, "main-mods"), before, "the other plugin's block and menu, byte for byte");
});

test("layout: --take-menu alone takes only the menu", () => {
  const h = home("main-mods", { "main-mods": theirs() });
  const before = read(h, "main-mods");
  run("install", h, "--take-menu");
  const l = JSON.parse(read(h, "main-mods"));
  assert.equal(l.terminal_menu, "chat-menu");
  assert.equal(find(l, "agents").content.mod, "other-agents");
  run("uninstall", h);
  assert.equal(read(h, "main-mods"), before);
});

// --- the Herdr version check: install/compat.ts --------------------------------------------
const COMPAT = join(ROOT, "install", "compat.ts");
const TESTED = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).herdr;
function stubBin(dir: string, name: string, version: string | null) {
  const f = join(dir, name);
  writeFileSync(f, `#!/bin/sh\n${version === null ? "echo 'unknown option' >&2; exit 2" : `[ "$1" = --version ] && { echo '${name} ${version}'; exit 0; }\nexit 2`}\n`, { mode: 0o755 });
  return f;
}
function compat(app: string | null, core: string | null) {
  const d = mkdtempSync(join(tmpdir(), "herdr-chat-compat-"));
  const r = spawnSync(process.execPath, [COMPAT, "check", "--app", stubBin(d, "herdr-app", app), "--hc", stubBin(d, "hc", core)], { encoding: "utf8" });
  return { status: r.status, out: r.stdout + r.stderr };
}

test("version: the tested versions install quietly; a newer Herdr warns in one line and installs; an older one than the minimum is refused with the reason", () => {
  assert.deepEqual(compat(TESTED.tested.app, TESTED.tested.core), { status: 0, out: "" });
  const newer = compat("9.0.0", TESTED.tested.core);
  assert.equal(newer.status, 0);
  assert.equal(newer.out, `herdr-chat: Herdr 9.0.0 is newer than the tested ${TESTED.tested.app}. If something breaks, \`./install.sh --uninstall\`\n`);
  const old = compat("0.0.1", TESTED.tested.core);
  assert.equal(old.status, 1);
  assert.match(old.out, new RegExp(`^herdr-chat: Herdr 0\\.0\\.1 is older than ${TESTED.minimum.app.replace(/\./g, "\\.")}, the oldest the chat works with \\(.+\\)\\. Update Herdr, then run \\./install\\.sh again\\.\\n$`));
  // A version compares by number, not text: 0.1.9 is older than 0.1.12.
  assert.equal(compat("0.1.9", TESTED.tested.core).status, 1);
  const core = compat(TESTED.tested.app, "9.1.0");
  assert.equal(core.status, 0);
  assert.match(core.out, new RegExp(`herdr-core 9\\.1\\.0 is newer than the tested ${TESTED.tested.core.replace(/\./g, "\\.")}`));
});

test("version: a Herdr that won't say its version is a warning, not a refusal", () => {
  const r = compat(null, null);
  assert.equal(r.status, 0);
  assert.match(r.out, new RegExp(`herdr-chat: can't tell Herdr's version \\(.*--version.*\\): tested with ${TESTED.tested.app.replace(/\./g, "\\.")}\\. If something breaks, \`\\./install\\.sh --uninstall\``));
  assert.match(r.out, /can't tell herdr-core's version/);
});
