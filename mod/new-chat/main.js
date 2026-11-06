// new-chat: the "New chat with…" launcher, and the commands that open chats.
//
// As an overlay (`mod.open:new-chat`, the "open" key: cmd-i): Pi, Claude
// Code or Codex, then a new tab with the chat (mod chat, props {chat, cwd,
// provider}) for the focused terminal's folder (else the space's). Keys:
// p / c / x pick (only an agent that is installed; the launcher has no text
// field, so letters are always picks), 1/2/3 too, ↑↓ move, Enter opens the
// selected one (the last choice, kept in <appHome>/data/pi-chat/launcher.json),
// Esc closes. Its commands: `new-chat.pick:<provider>`, `new-chat.enter`.
//
// As the layout's empty floating block (props {role: "commands"},
// install/layout.ts): always on screen at no size, so it takes the commands a
// key or another mod runs while no launcher is open:
// - `new-chat.open`: the launcher (as mod.open:new-chat; again: closes it);
// - `new-chat.pi`, `new-chat.claude`, `new-chat.codex`: that agent's chat, in a new tab;
// - `new-chat.continue:<terminal>`: chat-menu's Continue as chat (a Pi TUI
//   handed over to a chat on its session, see continueAsChat);
//   `new-chat.continue`: the same on the focused terminal (the "continue" key).

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { appHome, closeOverlay, exec, focused, hc, knownAgents, nextCommand, notify, openOverlay, panes, props, readTextFile, run, spaces, terminals, theme } from "herdr";
import * as fs from "fs/promises";
import { randomBytes } from "crypto";

const CHOICES = [
  { id: "pi", label: "Pi", icon: "pi", tint: true, letter: "p" },
  { id: "claude", label: "Claude Code", icon: "claude", letter: "c" },
  { id: "codex", label: "Codex", icon: "codex", letter: "x" },
];
const PREFS = () => `${appHome()}/data/pi-chat/launcher.json`;

/** A chat with `provider` in a new tab, in the focused terminal's folder (else the space's). */
async function openChat(provider) {
  const f = focused();
  const space = spaces().find((s) => s.id === f?.space);
  const cwd = f?.cwd || space?.folder || null;
  const chat = `c-${randomBytes(4).toString("hex")}`;
  run("tab.new", { name: provider, mod: "chat", props: { chat, provider, ...(cwd ? { cwd } : {}) } });
  await fs.mkdir(`${appHome()}/data/pi-chat`, { recursive: true });
  await fs.writeFile(PREFS(), JSON.stringify({ last: provider }));
}

const term = (addr) => terminals().find((t) => t.address === addr);
const word = (s) => (typeof s === "string" ? s : s?.state ?? null);
const isPi = (t) => [t.program?.key, t.app, t.status?.app, t.report?.app, t.agent].includes("pi");
const base = (p) => String(p ?? "").split("/").pop();

/**
 * Why a terminal can't continue as a chat (null: it can): a live Pi TUI whose
 * session the herdr-chat-lock extension labelled (pi-chat.session), idle or
 * done. `working: true`: it can once its run ends (chat-menu shows the item
 * disabled). Shared with chat-menu (a copy there: mods can't import each other).
 */
export function cantContinue(t) {
  if (!t || t.state !== "live") return { why: "not live" };
  if (t.labels?.["pi-chat.chat"]) return { why: "already a chat" };
  if (!t.labels?.["pi-chat.session"]) return { why: "no pi-chat.session label (the herdr-chat-lock extension labels it)" };
  if (!isPi(t)) return { why: "not Pi" };
  const st = word(t.status);
  if (st === "working" || st === "blocked") return { why: "Wait for the run to end", working: true };
  if (!["idle", "done"].includes(st)) return { why: `status ${st}` };
  return null;
}

/**
 * The session's model ("provider/id") and thinking level: its last
 * model_change and thinking_level_change entries (Pi records the TUI's choices
 * there; a model given with `pi --session f --model m` isn't, so the host also
 * gets them as --model/--thinking).
 */
export async function sessionSettings(file, ex = exec) {
  const r = await ex("grep", ["-E", '"type": ?"(model_change|thinking_level_change)"', file]);
  let model = null, thinking = null;
  for (const line of (r.code === 0 ? r.stdout : "").split("\n")) {
    try {
      const e = JSON.parse(line);
      if (e.type === "model_change" && e.provider && e.modelId) model = `${e.provider}/${e.modelId}`;
      if (e.type === "thinking_level_change" && e.thinkingLevel) thinking = e.thinkingLevel;
    } catch {}
  }
  return { model, thinking };
}

/** The Pi process in a terminal (`hc get --json`): its foreground program when that's pi (Pi started from a shell), else the terminal's own program when that's pi. */
export function piPid(info) {
  const fg = info?.foreground;
  if (fg?.pid && base(fg.argv?.[0]) === "pi") return fg.pid;
  if (info?.pid && base(info.argv?.[0]) === "pi") return info.pid;
  return null;
}

const alive = async (pid) => (await exec("kill", ["-0", String(pid)])).code === 0;

/**
 * Continue as chat (research subagent-chat.md §F): a Pi TUI becomes a chat
 * host on the same session, model and thinking.
 * - A sub-agent (a parent): a core terminal runs one program, so the TUI ends
 *   (`hc kill`), and a host starts in its place with the same parent, name and
 *   folder (`hc run --parent <p> --name <n>`, bin/pi-chat-subagent --session
 *   <file>): the parent sees one exit note, then its `hc send/wait <name>`
 *   reach the host. Then the chat dialog.
 * - A top-level TUI (continueInPlace): the chat takes its pane's place.
 * The session file is the herdr-chat-lock extension's label `pi-chat.session`.
 * `addr` empty: the focused terminal (the "continue" key).
 */
export async function continueAsChat(addr, cx) {
  const t = term(addr || focused()?.terminal);
  const no = cantContinue(t);
  if (no) throw new Error(no.working ? "Wait for the run to end, then Continue as chat." : `Not a Pi TUI that can continue as a chat: ${no.why}.`);
  const session = t.labels["pi-chat.session"];
  const { model, thinking } = await sessionSettings(session);
  if (!t.parent) return continueInPlace(t, session, { model, thinking }, cx);
  let cfg = {};
  try { cfg = JSON.parse((await readTextFile(`${appHome()}/mods/chat/config.json`)) ?? "{}"); } catch {}
  if (!cfg.host) throw new Error("mods/chat/config.json names no host (install again)");
  const launcher = cfg.host.replace(/pi-chat-host$/, "pi-chat-subagent");
  const kill = await hc(["kill", t.address]);
  if (kill.code !== 0) throw new Error(`hc kill ${t.address}: ${kill.stderr.trim()}`);
  // Its name is free once the old terminal has ended.
  for (let i = 0; i < 50 && term(t.address)?.state === "live"; i++) await cx.sleep(100);
  // The model and thinking as Pi's own flags: a sub-agent's host isn't restarted by a chat later.
  const piArgs = [...(model ? ["--model", model] : []), ...(thinking ? ["--thinking", thinking] : [])];
  const args = ["run", "--bg", "--json", "--parent", t.parent, ...(t.name ? ["--name", t.name] : []), ...(t.cwd ? ["--cwd", t.cwd] : []),
    "--", launcher, "--provider", "pi", "--session", session, ...(piArgs.length ? ["--", ...piArgs] : [])];
  const r = await hc(args);
  if (r.code !== 0) throw new Error(`hc run: ${r.stderr.trim() || r.stdout.trim()}`);
  const next = JSON.parse(r.stdout).address;
  // The launcher labels its terminal with the chat id once it starts.
  let chat = null;
  for (let i = 0; i < 100 && !chat; i++) { chat = term(next)?.labels?.["pi-chat.chat"] ?? null; if (!chat) await cx.sleep(100); }
  if (!chat) throw new Error(`the chat host ${next} didn't label itself (pi-chat.chat)`);
  run("overlay.close", { id: "terminal-peek" });
  openOverlay({ mod: "chat", kind: "dialog", width: 0.8, height: 0.8, props: { chat, peek: next, provider: "pi" } });
  return next;
}

/**
 * A top-level Pi TUI (its own pane in a tab): the chat opens beside it
 * (pane.split with the chat mod, focused), then Pi gets SIGTERM (it flushes and
 * runs session_shutdown; the host waits for that pid: --after-pid). Pi may be
 * a shell's foreground program (`pi` typed in zsh): only that pid is signalled,
 * never the terminal. Once Pi is gone the TUI's pane closes, so the chat takes
 * its place, unless its shell runs something else then (it stays, and says so).
 */
export async function continueInPlace(t, session, { model, thinking }, cx) {
  const g = await hc(["get", t.address, "--json"]);
  if (g.code !== 0) throw new Error(`hc get ${t.address}: ${g.stderr.trim()}`);
  const info = JSON.parse(g.stdout);
  const pid = piPid(info);
  if (!pid) throw new Error(`no pi process in ${t.address} (its foreground is ${info.foreground?.argv?.[0] ?? "unknown"})`);
  const pane = panes().find((p) => p.terminal === t.address);
  if (!pane) throw new Error(`${t.address} has no pane in a tab`);
  const before = new Set(panes().map((p) => p.pane));
  const chat = `c-${randomBytes(4).toString("hex")}`;
  const cwd = info.foreground?.cwd || t.cwd || null;
  run("pane.split", { direction: "right", pane: pane.pane, mod: "chat",
    props: { chat, provider: "pi", session, afterPid: pid, ...(cwd ? { cwd } : {}), ...(model ? { model } : {}), ...(thinking ? { thinking } : {}) } });
  let mine = null;
  for (let i = 0; i < 50 && !mine; i++) { mine = panes().find((p) => !before.has(p.pane) && p.mod === "chat" && p.tab === pane.tab); if (!mine) await cx.sleep(100); }
  if (!mine) throw new Error("the chat's pane didn't appear beside the TUI");
  run("pane.focus", { pane: mine.pane });
  const k = await exec("kill", ["-TERM", String(pid)]);
  if (k.code !== 0) throw new Error(`kill -TERM ${pid}: ${k.stderr.trim()}`);
  for (let i = 0; i < 100 && (await alive(pid)); i++) await cx.sleep(100);
  if (await alive(pid)) {
    notify({ title: "Continue as chat", body: `Pi (pid ${pid}) didn't quit in 10 s: the chat waits for it (resume there once it's gone).`, level: "warning" });
    return mine.pane;
  }
  // A shell left with its prompt: nothing else runs in it, so it goes. A program
  // that ended with Pi: the pane shows its exit, so it goes too. A prompt's own
  // commands (git status, an rc file) come and go: up to 3 s for the shell to
  // be alone in its terminal.
  let a = null, idleShell = false;
  for (let i = 0; i < 15 && !idleShell; i++) {
    await cx.sleep(200);
    const after = await hc(["get", t.address, "--json"]);
    a = after.code === 0 ? JSON.parse(after.stdout) : null;
    idleShell = !a || a.state !== "live" || !a.foreground?.pid || a.foreground.pid === a.pid;
  }
  if (!idleShell) {
    notify({ title: "Continue as chat", body: `The TUI's terminal now runs ${a.foreground?.argv?.[0] ?? "something"}: its pane stays.`, level: "info" });
    return mine.pane;
  }
  if (panes().some((p) => p.pane === pane.pane)) run("pane.close", { pane: pane.pane });
  run("pane.focus", { pane: mine.pane });
  return mine.pane;
}

// The floating block: commands only, nothing drawn.
class Commands {
  constructor(cx) {
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        try {
          if (c === "open") run("mod.open", { name: "new-chat" });
          else if (CHOICES.some((x) => x.id === c)) await openChat(c);
          else if (c === "continue" || c.startsWith("continue:")) await continueAsChat(c.slice(9), cx);
        } catch (e) {
          notify({ title: c.startsWith("continue") ? "Continue as chat" : "New chat", body: String(e?.message ?? e), level: "error" });
        }
      }
    });
  }
}

export default class NewChat extends View {
  init(_props, cx) {
    if (props()?.role === "commands") { this.commands = new Commands(cx); return; }
    this.sel = 0;
    this.done = false;
    this.installed = null; // provider id → installed (knownAgents), null until known
    this.handle = cx.focus_handle();
    cx.spawn(async (cx) => {
      try {
        const last = JSON.parse((await readTextFile(PREFS())) ?? "{}").last;
        const i = CHOICES.findIndex((c) => c.id === last);
        if (i >= 0) this.sel = i;
      } catch {}
      this.handle.focus();
      cx.notify();
    });
    cx.spawn(async (cx) => {
      try {
        const known = await knownAgents();
        this.installed = Object.fromEntries(CHOICES.map((c) => [c.id, known.find((a) => a.key === c.id)?.installed !== false]));
      } catch {}
      cx.notify();
    });
    cx.timer.after(120, () => this.handle.focus());
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "focus") this.handle.focus();
        else if (c.startsWith("pick:")) this.open(CHOICES.findIndex((x) => x.id === c.slice(5)), cx);
        else if (c === "enter") this.open(this.sel, cx);
        cx.notify();
      }
    });
  }

  // An agent knownAgents() says isn't installed (unknown yet: every one is offered).
  available(c) {
    return this.installed?.[c.id] !== false;
  }

  open(i, cx) {
    if (this.done || i < 0 || i >= CHOICES.length) return;
    this.done = true;
    const provider = CHOICES[i].id;
    const overlay = props()?.overlay;
    cx.spawn(async () => {
      try {
        await openChat(provider);
      } catch (e) {
        notify({ title: "New chat", body: String(e?.message ?? e), level: "error" });
      } finally {
        if (overlay) closeOverlay(overlay);
      }
    });
  }

  key(e, cx) {
    const k = e.keystroke;
    const letter = CHOICES.findIndex((c) => c.letter === k && this.available(c));
    if (letter >= 0) this.open(letter, cx);
    else if (/^[1-9]$/.test(k)) this.open(Number(k) - 1, cx);
    else if (k === "up") this.sel = (this.sel + CHOICES.length - 1) % CHOICES.length;
    else if (k === "down" || k === "tab") this.sel = (this.sel + 1) % CHOICES.length;
    else if (k === "enter") this.open(this.sel, cx);
    else if (k === "escape") { const o = props()?.overlay; if (o) closeOverlay(o); }
    cx.notify();
  }

  render() {
    if (this.commands) return div();
    const t = theme();
    const mark = (c) => {
      const path = `mods/chat/icons/providers/${c.icon}.svg`;
      return (c.tint ? svg(path).text_color(t.foreground) : image(path)).size(18).flex_none();
    };
    const letters = CHOICES.filter((c) => this.available(c)).map((c) => c.letter.toUpperCase()).join(" ");
    return v_flex().id("launcher").size_full().p(8).gap(2).bg(t.popover).text_color(t.foreground)
      .track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .child(div().px(8).pt(4).pb(6).text_size(11.5).text_color(t.dim).child("New chat"))
      .children(CHOICES.map((c, i) => h_flex().id(`choice-${c.id}`).h(36).px(10).gap(10).items_center().rounded(8).cursor_pointer()
        .when(i === this.sel, (e) => e.bg(t.selected))
        .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.open(i, cx))
        .child(mark(c))
        .child(div().flex_1().text_size(13).text_color(this.available(c) ? t.foreground : t.dim).child(this.available(c) ? c.label : `${c.label} (not installed)`))
        .when(this.available(c), (e) => e.child(div().px(5).rounded(4).border_1().border_color(t.border).bg(t.raised).text_size(11).text_color(t.dim).child(c.letter.toUpperCase())))))
      .child(div().px(8).pt(6).text_size(10.5).text_color(t.dim).child(`${letters} or ↑↓ Enter · Esc`));
  }
}
