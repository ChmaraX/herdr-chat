// A chat whose host is older than the install (protocol.md "v3.5: updates").
// A host keeps the code it started with; the mods reload at once. So after an
// install the chat compares its host (the welcome) with the install
// (config.json) and, once the person asks (this chat's bar, /reload, or
// new-chat's question for every chat), restarts its host on the same session
// as soon as the chat is quiet. A sub-agent's host is its parent's: never.
// One try per install build: a host that comes back on another build is left.
//
// The view (main.js) owns one Updater and calls it from its tick, its welcome,
// /reload, the bar's button, its banner and its debug dump; replaceHost does
// the restart.

import { shared, terminals } from "herdr";
import { readConfig } from "./connection.js";

/** The build the person asked every chat to restart on (new-chat's question sets it; the same key there). */
const RESTART_ALL = "herdr-chat.update.restart";

/**
 * Older than the install: other code, and started before the install (a host
 * started after it runs what is there; in a clone, edited code isn't an update
 * until ./install.sh). A host before 0.3 sends no build. new-chat has the same rule.
 */
export function older(host, cfg) {
  return Boolean(cfg?.build && host) && host.build !== cfg.build && !(host.startedAt > Number(cfg.installedAt ?? 0));
}

/**
 * Nothing a restart would lose: no run, no open question, nothing queued (the host
 * holds the follow-ups in memory), and no live sub-agent of its own (their reports go
 * to this host's terminal, which a restart replaces). An agent that exited or failed
 * is quiet: the restart starts it again.
 */
export function quiet(s, hostAddress) {
  if (!["idle", "exited", "error"].includes(s.phase)) return false;
  if (s.dialog || s.dialogsPending) return false;
  if (s.queue?.steering?.length || s.queue?.followUp?.length) return false;
  return !hostAddress || !terminals().some((t) => t.state === "live" && t.parent === hostAddress);
}

export class Updater {
  /** sub: a sub-agent's chat (never restarted); log: the view's log. */
  constructor({ sub, log }) {
    this.sub = sub;
    this.log = log;
    this.cfg = null; // config.json as of the last welcome
    this.wanted = false; // the person asked (bar, /reload, the question for every chat)
    this.triedFor = null; // the install build a restart was tried for
    this.updatingTo = null; // the version a restart is under way to (the note once the new host answers)
  }

  async load() {
    this.cfg = await readConfig();
  }

  /** The one rule: this chat can restart onto the install. */
  canRestart(welcome) {
    return !this.sub && older(welcome?.host, this.cfg) && this.triedFor !== this.cfg.build;
  }

  want() {
    this.wanted = true;
  }

  /** "herdr-chat 0.3.0", or a plain name when config.json has no version. */
  label() {
    return this.cfg?.version ? `herdr-chat ${this.cfg.version}` : "the new herdr-chat";
  }

  /** Whether to restart now (the view then calls replaceHost). `host`: its terminal; `replacing`: a replacement already under way. */
  due({ welcome, state, host, replacing }) {
    if (!this.canRestart(welcome) || replacing || !host) return false;
    if (!this.wanted && shared(RESTART_ALL) === this.cfg.build) {
      this.wanted = true;
      this.log(`restart on ${this.cfg.build}: asked for every chat`);
    }
    if (!this.wanted || !quiet(state, host.address)) return false;
    this.log(`host ${host.address} runs ${welcome.host?.build ?? "an older build"}, the install ${this.cfg.build}: restarting it`);
    this.triedFor = this.cfg.build;
    this.updatingTo = this.label();
    return true;
  }

  /** A welcome: config.json again (a new install may have come); the note when it's the new host. Returns a flash text or null. */
  async onWelcome(rec, oldPid) {
    await this.load();
    if (!this.updatingTo || rec.host?.pid === oldPid) return null;
    const to = this.updatingTo;
    this.updatingTo = null;
    this.wanted = false;
    if (older(rec.host, this.cfg)) {
      this.log(`restarted, but the host says ${rec.host?.build ?? "no build"}, the install ${this.cfg?.build}`);
      return null;
    }
    return `Restarted on ${to}`;
  }

  /** The bar: {text, button} or null. `busy`: the agent is working or has sub-agents out. */
  bar(welcome, agent) {
    if (!this.canRestart(welcome)) return null;
    if (this.wanted) return { text: `${this.label()}: this chat restarts when ${agent} is done. The conversation stays.`, button: false };
    return { text: `${this.label()} is installed. This chat still runs the version from before. Restart it to update; the conversation stays.`, button: true };
  }

  dump(welcome) {
    return { outdated: older(welcome?.host, this.cfg), canRestart: this.canRestart(welcome), wanted: this.wanted, triedFor: this.triedFor,
      hostBuild: welcome?.host?.build ?? null, build: this.cfg?.build ?? null };
  }
}
