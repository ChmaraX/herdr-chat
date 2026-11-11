// Updates (protocol.md "v3.5: updates"): two questions, each asked once, and
// nothing changes until the person answers.
//
// 1. "herdr-chat X is available" (a release install only): GitHub's latest
//    release, looked up once a day. Update runs the install's own update
//    command in a herdr-core terminal (it outlives this mod, which the install
//    reloads). The update is done when that terminal ends: the floating block
//    watches it and says how it went; on success the dialog closes, then
//    question 2.
// 2. "Restart N chats on X?": after an install, chats whose host started
//    before it and runs other code (its registry's build and start, against
//    config.json's build and installedAt). Restart sets the shared RESTART_ALL
//    key; each chat (mods/chat/update.js) restarts its host on the same
//    session as soon as it is quiet. Later leaves a bar in each of them.
//
// The floating block (main.js Commands) checks; the dialog is an overlay of
// this mod with props {role: "update", …}.

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { appHome, closeOverlay, hc, home, notify, openOverlay, props, readTextFile, run, setShared, shared, terminals, theme } from "herdr";

const REPO = "ChmaraX/herdr-chat";
const RESTART_ALL = "herdr-chat.update.restart"; // a build every chat restarts on (mods/chat/update.js has the same key)
const LATER = "herdr-chat.update.later"; // a build the person said Later to: no question, the chats' bars stay
const CHECKED = "herdr-chat.update.checked"; // ms of the last release lookup (or Later)
const RUNNING = "herdr-chat.update.running"; // {terminal, version}: an update started from the dialog, until its terminal ends
const RESULT = "herdr-chat.update.result"; // {version, exit, terminal}: how the last one ended (the dialog shows it)
const DAY = 24 * 3600 * 1000;
const VERSION = /^\d+\.\d+\.\d+$/; // the only release tags offered (it goes on a command line)

async function readJson(path) {
  try { return JSON.parse((await readTextFile(path)) ?? "{}") ?? {}; } catch { return {}; }
}
const config = () => readJson(`${appHome()}/mods/chat/config.json`);
const stateDir = () => `${appHome()}/data/herdr-chat`;
/** The person's update settings: data/herdr-chat/settings.json "updates". {check: false} turns the lookup off; feed: another URL (a mirror, the tests). */
async function prefs() {
  const u = (await readJson(`${stateDir()}/settings.json`)).updates;
  return u && typeof u === "object" ? u : {};
}

/** "0.10.1" > "0.9.3". */
export function newer(a, b) {
  const p = (v) => String(v ?? "").split(".").map((x) => parseInt(x, 10) || 0);
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

/**
 * A host older than the install: other code, started before the install. (A host
 * started after it runs whatever is there: in a clone, edited code is not an
 * update until ./install.sh.) Hosts before 0.3 record no build. The chat has the
 * same rule (mods/chat/update.js).
 */
const older = (reg, cfg) => Boolean(cfg.build) && reg.build !== cfg.build && !(reg.startedAt > Number(cfg.installedAt ?? 0));

/** Chats on older hosts: live hosts of chats (sub-agents are their parents': not counted). */
async function olderChats(cfg) {
  const hosts = terminals().filter((t) => t.state === "live" && t.labels?.["herdr-chat.role"] === "host" && t.labels?.["herdr-chat.chat"]);
  const out = [];
  for (const t of hosts) {
    const reg = await readJson(`${stateDir()}/chats/${t.labels["herdr-chat.chat"]}.json`);
    if (reg.pid && older(reg, cfg)) out.push(reg.chat ?? t.labels["herdr-chat.chat"]);
  }
  return out;
}

const dialog = (p) => openOverlay({ mod: "new-chat", kind: "dialog", modal: true, width: 460, props: { role: "update", ...p } });

/** Question 2, after an install (or at start): asked once per build; not while an update runs (its end asks). */
export async function checkHosts() {
  const cfg = await config();
  if (!cfg.build || shared(RUNNING) || shared(RESTART_ALL) === cfg.build || shared(LATER) === cfg.build) return null;
  const chats = await olderChats(cfg);
  if (!chats.length) return null;
  dialog({ step: "restart", version: cfg.version ?? null, build: cfg.build, count: chats.length });
  return chats;
}

/**
 * The update the dialog started, once its terminal has ended (the floating block
 * calls this every few seconds while one runs): the outcome for the dialog and a
 * notification (the dialog may be hidden). True when it worked: the caller asks
 * question 2 once the dialog has closed.
 */
export async function checkRunning() {
  const r = shared(RUNNING);
  if (!r?.terminal) return false;
  const g = await hc(["get", r.terminal, "--json"]);
  const info = g.code === 0 ? JSON.parse(g.stdout) : null;
  if (info?.state === "live") return false;
  // Gone from the core (reaped): it worked if the install it ran is in.
  const exit = info ? info.exit_code : (await config()).version === r.version ? 0 : null;
  setShared(RESULT, { version: r.version, exit, terminal: r.terminal });
  setShared(RUNNING, null);
  if (exit !== 0) {
    notify({ title: "herdr-chat", body: `The update to ${r.version} failed${exit == null ? "" : ` (exit ${exit})`}. Click to see its output.`, level: "error", timeout: 0,
      action: { name: "terminal.peek", args: { terminal: r.terminal } } });
    return false;
  }
  notify({ title: "herdr-chat", body: `Updated to ${r.version}.`, level: "success" });
  return true;
}

/** Question 1, once a day (`now`: a check the person asked for, whenever): a newer release than the installed one. */
export async function checkRelease({ now = false } = {}) {
  const cfg = await config();
  const s = await prefs();
  if (cfg.channel !== "release" || !cfg.update || s.check === false || shared(RUNNING)) return null;
  if (!now && Date.now() - Number(shared(CHECKED) ?? 0) < DAY) return null;
  setShared(CHECKED, Date.now());
  let rel;
  try {
    const r = await fetch(s.feed || `https://api.github.com/repos/${REPO}/releases/latest`, { headers: { accept: "application/vnd.github+json" } });
    if (!r.ok) return null;
    rel = await r.json();
  } catch {
    return null; // offline: tomorrow
  }
  const latest = String(rel.tag_name ?? "").replace(/^v/, "");
  if (!VERSION.test(latest) || !newer(latest, cfg.version)) return null;
  dialog({ step: "release", version: latest, current: cfg.version ?? null, url: rel.html_url ?? `https://github.com/${REPO}/releases/tag/v${latest}` });
  return latest;
}

/**
 * What the update terminal runs: config.json's update command for `version`, with a
 * PATH that has the node, hc and agents the install found (a core terminal lacks the
 * login PATH, and the install looks them up again). The version is an argument, never
 * part of the command text.
 */
function updateArgv(cfg, version) {
  const dirs = [cfg.node, cfg.hc, cfg.pi, cfg.claude, cfg.codex].filter((p) => typeof p === "string" && p.includes("/")).map((p) => p.slice(0, p.lastIndexOf("/")));
  const path = [...new Set([...dirs, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(":");
  return ["/usr/bin/env", `PATH=${path}`, `HERDR_APP_HOME=${appHome()}`, "sh", "-c", `${cfg.update} --version "$1"`, "sh", version];
}

/** The dialog (an overlay of this mod). */
export class UpdateDialog {
  constructor(p, cx) {
    this.p = p;
    this.state = "ask"; // ask | running | failed
    this.result = null; // {exit, terminal} once failed
    if (p.step === "release" && shared(RUNNING)?.version === p.version) this.state = "running"; // reloaded by the install it started
    cx.timer.every(1000, (cx) => this.poll(cx));
  }

  close() {
    const o = props()?.overlay;
    if (o) closeOverlay(o);
  }

  // While running: the floating block decides the end (checkRunning); this follows RESULT.
  poll(cx) {
    if (this.state !== "running" || shared(RUNNING)) return;
    const r = shared(RESULT);
    if (r?.version === this.p.version && r.exit === 0) return this.close();
    this.state = "failed";
    this.result = r ?? null;
    cx.notify();
  }

  async update(cx) {
    const cfg = await config();
    this.state = "running";
    cx.notify();
    const r = await hc(["run", "--bg", "--json", "--no-parent", "--name", "herdr-chat-update", "--cwd", home(), "--", ...updateArgv(cfg, this.p.version)]);
    if (r.code !== 0) {
      this.state = "failed";
      this.result = { exit: null, terminal: null, error: (r.stderr || r.stdout).trim() };
      return cx.notify();
    }
    setShared(RESULT, null);
    setShared(RUNNING, { terminal: JSON.parse(r.stdout).address, version: this.p.version });
    cx.notify();
  }

  answer(what, cx) {
    const p = this.p;
    if (what === "restart" && p.step === "restart") { setShared(RESTART_ALL, p.build); return this.close(); }
    if (what === "later") {
      if (p.step === "restart") setShared(LATER, p.build);
      else if (this.state === "ask") setShared(CHECKED, Date.now()); // ask again tomorrow
      return this.close(); // Hide, Close: the floating block still follows a running update
    }
    // A click's or key's cx ends at its first await: the work gets its own.
    if (what === "update" && this.state === "ask") return cx.spawn(async (cx) => {
      try { await this.update(cx); } catch (e) { this.state = "failed"; this.result = { error: String(e?.message ?? e) }; cx.notify(); }
    });
    if (what === "notes") return cx.open_url(p.url);
    if (what === "output" && this.result?.terminal) { run("terminal.peek", { terminal: this.result.terminal }); return this.close(); }
  }

  key(e, cx) {
    const k = e.keystroke;
    if (k === "escape") this.answer("later", cx);
    else if (k === "enter" && this.state === "ask") this.answer(this.p.step === "restart" ? "restart" : "update", cx);
  }

  render(handle) {
    const t = theme();
    const p = this.p;
    const btn = (id, label, primary, what) => h_flex().id(id).h(28).px(12).items_center().rounded(7).cursor_pointer().text_size(12.5)
      .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground).border_1().border_color(primary ? t.solid : t.input)
      .hover((s) => s.opacity(0.85)).on_click((_e, cx) => this.answer(what, cx)).child(label);
    let title, body, buttons;
    if (p.step === "restart") {
      title = `herdr-chat ${p.version ?? ""} is installed`.trim();
      body = [`${p.count} ${p.count === 1 ? "chat still runs" : "chats still run"} the version from before. Restart ${p.count === 1 ? "it" : "them"} to update?`,
        "Each conversation stays where it is. A chat that's working, or waiting on sub-agents, restarts when it's done."];
      buttons = [btn("update-later", "Later", false, "later"), btn("update-restart", p.count === 1 ? "Restart chat" : "Restart chats", true, "restart")];
    } else if (this.state === "running") {
      title = `Updating herdr-chat to ${p.version}…`;
      body = ["Your chats keep running. You'll be asked to restart them on the new version."];
      buttons = [btn("update-hide", "Hide", false, "later")];
    } else if (this.state === "failed") {
      const r = this.result ?? {};
      title = "The update failed";
      body = [r.error ?? (r.exit == null ? "The install ended without an exit code." : `The install exited with code ${r.exit}.`)];
      buttons = [btn("update-close", "Close", false, "later"), ...(r.terminal ? [btn("update-output", "Show output", true, "output")] : [])];
    } else {
      title = `herdr-chat ${p.version} is available`;
      body = [p.current ? `You have ${p.current}.` : "A new version is out."];
      buttons = [btn("update-notes", "What's new", false, "notes"), btn("update-later", "Later", false, "later"), btn("update-go", "Update", true, "update")];
    }
    return v_flex().id("update").size_full().p(18).gap(10).bg(t.popover).text_color(t.foreground)
      .track_focus(handle).on_key_down((e, cx) => { this.key(e, cx); cx.notify(); })
      .child(div().text_size(15).font_semibold().child(title))
      .children(body.map((b) => div().text_size(12.5).text_color(t.muted).child(b)))
      .child(h_flex().pt(6).gap(8).justify_end().children(buttons));
  }
}
