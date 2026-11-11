// Updates (protocol.md "v3.5: updates"): two questions, each asked once, and
// nothing changes until the person answers.
//
// 1. "herdr-chat X is available" (a release install only): GitHub's latest
//    release, looked up once a day. Update runs the install's own update
//    command in a herdr-core terminal (it outlives this mod, which the install
//    reloads), then the next question follows.
// 2. "Restart N chats on X?": after an install, chats whose host runs older
//    code (its registry's build, against config.json's). Restart sets the
//    shared RESTART_ALL key; each chat (mods/chat/update.js) restarts its host
//    on the same session as soon as it is quiet. Later leaves a bar in each
//    of those chats instead.
//
// The floating block (main.js Commands) checks; the dialog is an overlay of
// this mod with props {role: "update", …}.

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { appHome, closeOverlay, hc, home, notify, openOverlay, props, readTextFile, run, setShared, shared, terminals, theme } from "herdr";

const REPO = "ChmaraX/herdr-chat";
const RESTART_ALL = "herdr-chat.update.restart"; // a build every chat restarts on (mods/chat/update.js)
const LATER = "herdr-chat.update.later"; // a build the person said Later to: no popup, the chats' bars stay
const CHECKED = "herdr-chat.update.checked"; // ms of the last release lookup (or Later)
const RUNNING = "herdr-chat.update.running"; // {terminal, version}: an update started from the popup
const DAY = 24 * 3600 * 1000;

async function readJson(path) {
  try { return JSON.parse((await readTextFile(path)) ?? "{}") ?? {}; } catch { return {}; }
}
const config = () => readJson(`${appHome()}/mods/chat/config.json`);
const stateDir = () => `${appHome()}/data/herdr-chat`;

/** "0.10.1" > "0.9.3". */
export function newer(a, b) {
  const p = (v) => String(v ?? "").replace(/^v/, "").split(".").map((x) => parseInt(x, 10) || 0);
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

/** Chats whose host runs older code than the install: live hosts of chats (not sub-agents) whose registry has another build. */
async function outdatedChats(build) {
  const hosts = terminals().filter((t) => t.state === "live" && t.labels?.["herdr-chat.role"] === "host" && t.labels?.["herdr-chat.chat"]);
  const out = [];
  for (const t of hosts) {
    const reg = await readJson(`${stateDir()}/chats/${t.labels["herdr-chat.chat"]}.json`);
    if (reg.pid && reg.build !== build) out.push(reg.chat ?? t.labels["herdr-chat.chat"]);
  }
  return out;
}

const dialog = (p) => openOverlay({ mod: "new-chat", kind: "dialog", modal: true, width: 460, props: { role: "update", ...p } });

/** Question 2, after an install (or at start): asked once per build. */
export async function checkHosts() {
  const cfg = await config();
  if (!cfg.build || shared(RESTART_ALL) === cfg.build || shared(LATER) === cfg.build) return null;
  const chats = await outdatedChats(cfg.build);
  if (!chats.length) return null;
  dialog({ step: "restart", version: cfg.version ?? null, build: cfg.build, count: chats.length });
  return chats;
}

/** An update the popup started: its outcome, once its terminal has ended (this mod reloads during it). */
export async function checkRunning() {
  const r = shared(RUNNING);
  if (!r?.terminal) return;
  const g = await hc(["get", r.terminal, "--json"]);
  const info = g.code === 0 ? JSON.parse(g.stdout) : null;
  if (info?.state === "live") return;
  setShared(RUNNING, null);
  const cfg = await config();
  if (info && info.exit_code !== 0) {
    notify({ title: "herdr-chat", body: `The update to ${r.version} failed (exit ${info.exit_code}). Click to see its output.`, level: "error", timeout: 0,
      action: { name: "terminal.peek", args: { terminal: r.terminal } } });
  } else if (cfg.version === r.version) {
    notify({ title: "herdr-chat", body: `Updated to ${r.version}.`, level: "success" });
  }
}

/** Question 1, once a day (`now`: a check the person asked for, whenever): a newer release than the installed one. */
export async function checkRelease({ now = false } = {}) {
  const cfg = await config();
  const s = await settings();
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
  if (!latest || !newer(latest, cfg.version)) return null;
  dialog({ step: "release", version: latest, current: cfg.version ?? null, url: rel.html_url ?? `https://github.com/${REPO}/releases/tag/v${latest}` });
  return latest;
}

/** The dialog (an overlay of this mod). */
export class UpdateDialog {
  constructor(p, cx) {
    this.p = p;
    this.state = "ask"; // ask | running | failed
    this.terminal = null;
    this.exit = null;
    const r = shared(RUNNING);
    if (p.step === "release" && r?.version === p.version) { this.state = "running"; this.terminal = r.terminal; }
    // Reloaded by the install it started: done once config.json has the version.
    cx.timer.every(1000, (cx) => this.poll(cx));
  }

  close() {
    const o = props()?.overlay;
    if (o) closeOverlay(o);
  }

  async poll(cx) {
    if (this.p.step !== "release" || this.state !== "running" || this.polling) return;
    this.polling = true;
    try {
      const cfg = await config();
      if (cfg.version === this.p.version) {
        // The new chat mod and host are in; question 2 comes from the reloaded floating block.
        await checkRunning();
        return this.close();
      }
      const g = await hc(["get", this.terminal, "--json"]);
      const info = g.code === 0 ? JSON.parse(g.stdout) : null;
      if (info && info.state !== "live") {
        setShared(RUNNING, null);
        this.state = info.exit_code === 0 ? "ask" : "failed";
        this.exit = info.exit_code;
        cx.notify();
      }
    } finally {
      this.polling = false;
    }
  }

  async update(cx) {
    const cfg = await config();
    this.state = "running";
    cx.notify();
    // The install's update command (the one-liner) for exactly this version, in a core terminal:
    // it outlives this mod, which the install replaces.
    const r = await hc(["run", "--bg", "--json", "--no-parent", "--name", "herdr-chat-update", "--cwd", home(),
      "--", "/usr/bin/env", `HERDR_APP_HOME=${appHome()}`, "sh", "-c", `${cfg.update} --version ${this.p.version}`]);
    if (r.code !== 0) {
      this.state = "failed";
      this.exit = null;
      this.error = (r.stderr || r.stdout).trim();
      return cx.notify();
    }
    this.terminal = JSON.parse(r.stdout).address;
    setShared(RUNNING, { terminal: this.terminal, version: this.p.version });
    cx.notify();
  }

  answer(what, cx) {
    const p = this.p;
    if (what === "restart") { setShared(RESTART_ALL, p.build); return this.close(); }
    if (what === "later") {
      if (p.step === "restart") setShared(LATER, p.build);
      else setShared(CHECKED, Date.now()); // ask again tomorrow
      return this.close();
    }
    if (what === "update") return void this.update(cx);
    if (what === "notes") return cx.open_url(p.url);
    if (what === "output" && this.terminal) { run("terminal.peek", { terminal: this.terminal }); return this.close(); }
  }

  key(e, cx) {
    const k = e.keystroke;
    if (k === "escape") this.state === "running" ? this.close() : this.answer("later", cx);
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
        "Each conversation stays where it is. A chat that's working restarts when its turn ends."];
      buttons = [btn("update-later", "Later", false, "later"), btn("update-restart", p.count === 1 ? "Restart chat" : "Restart chats", true, "restart")];
    } else if (this.state === "running") {
      title = `Updating herdr-chat to ${p.version}…`;
      body = ["Your chats keep running. You'll be asked to restart them on the new version."];
      buttons = [btn("update-hide", "Hide", false, "later")];
    } else if (this.state === "failed") {
      title = "The update failed";
      body = [this.error ?? `The install exited with code ${this.exit}.`];
      buttons = [btn("update-close", "Close", false, "later"), ...(this.terminal ? [btn("update-output", "Show output", true, "output")] : [])];
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
