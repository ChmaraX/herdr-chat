// Open a file a tool touched (visual-v2.md §6, "clickable file paths"):
// 1. herdr-nvim installed (mods/herdr-nvim/bin/herdr-nvim, as gitview's
//    nvim.js finds it): `herdr-nvim open --tab <tab> --space <space> <file>:<line>`;
// 2. else $EDITOR (the login shell's; vi without one) in a terminal pane
//    of the chat's tab (beside it, like the TUI hand-off), in the chat's folder.

import { appHome, exec, hc, readTextFile } from "herdr";
import { PLATFORM } from "./platform.js";

let editorCache = null;

async function herdrNvim() {
  const bin = `${appHome()}/mods/herdr-nvim/bin/herdr-nvim`;
  try {
    return (await readTextFile(bin)) !== null ? bin : null;
  } catch {
    return null;
  }
}

async function editorArgv() {
  if (editorCache) return editorCache;
  let ed = "";
  // Windows: no login shell to ask; cmd's `set` reads VISUAL/EDITOR from the environment, else Notepad.
  if (PLATFORM.win) {
    try {
      const out = (await exec("cmd.exe", ["/d", "/c", "set", "VISUAL", "&", "set", "EDITOR"])).stdout;
      ed = /^VISUAL=(.+)$/im.exec(out)?.[1]?.trim() || /^EDITOR=(.+)$/im.exec(out)?.[1]?.trim() || "";
    } catch {}
    // A program's path has spaces there as a rule (C:\Program Files\…): up to its .exe/.cmd/.bat, then its arguments.
    const m = /^\s*"?(.+?\.(?:exe|cmd|bat))"?(?:\s+(.*))?$/i.exec(ed);
    const argv = m ? [m[1], ...(m[2] ?? "").split(/\s+/).filter(Boolean)] : (ed || "notepad.exe").split(/\s+/).filter(Boolean);
    // A bare name (code, nvim): where.exe follows PATHEXT (code is code.cmd); hc's CreateProcess finds only .exe.
    if (!/[\\/]/.test(argv[0])) {
      try {
        const w = await exec("where.exe", [argv[0]]);
        // Its first match Windows can start (VS Code also puts a `code` sh script beside code.cmd).
        const first = w.code === 0 ? w.stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => /\.(exe|cmd|bat|com)$/i.test(l)) : "";
        if (first) argv[0] = first;
      } catch {}
    }
    editorCache = argv;
    return editorCache;
  }
  try {
    ed = (await exec("/bin/sh", ["-lc", 'printf %s "${VISUAL:-$EDITOR}"'])).stdout.trim();
  } catch {}
  editorCache = (ed || "vi").split(/\s+/).filter(Boolean);
  return editorCache;
}

// {path (absolute), line, cwd, tab, space} → {how: "herdr-nvim" | "editor", terminal?}
export async function openFile(o) {
  // Windows: a network path (\\server\share, //server, \\?\UNC) makes Windows sign in to that server with the
  // person's credentials (NTLM), and a tool's output names it: never opened.
  if (PLATFORM.win && /^[\\/]{2}/.test(o.path ?? "")) throw new Error(`not opening a network path: ${o.path}`);
  const nvim = await herdrNvim();
  if (nvim && o.tab) {
    const args = ["open", "--tab", String(o.tab)];
    if (o.space) args.push("--space", String(o.space));
    args.push(`${o.path}:${o.line || 1}`);
    const r = await exec(nvim, args, { cwd: o.cwd });
    if (r.code === 0) return { how: "herdr-nvim" };
  }
  let ed = await editorArgv();
  // Windows runs a .cmd/.bat through cmd.exe, which re-reads its arguments: a file name with cmd's metacharacters
  // (it comes from a tool's output) goes to Notepad instead.
  if (PLATFORM.win && /\.(cmd|bat)$/i.test(ed[0] ?? "") && /[&|^%<>!"]/.test(o.path ?? "")) ed = ["notepad.exe"];
  const argv = /(^|[\\/])(n?vim?|vi|hx|helix|kak|micro|nano|emacs)(\.exe)?$/i.test(ed[0]) ? [...ed, `+${o.line || 1}`, o.path] : [...ed, o.path];
  if (!o.space || !o.tab) throw new Error("no tab to open the editor in");
  const r = await hc(["run", "--bg", "--json", "--no-parent", "--cwd", o.cwd ?? "/", "--label", `herdr.space=${o.space}`,
    "--label", `herdr.tab=${o.tab}`, "--label", "herdr-chat.editor=1", "--", ...argv]);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || "hc run failed");
  return { how: "editor", terminal: JSON.parse(r.stdout).address, argv };
}
