import { appHome, hc, readTextFile, terminals } from "herdr";
import { openLink } from "./transport.js";
import { DEFAULT_PROVIDER, MOD, message } from "./util.js";

export const stateDir = () => `${appHome()}/data/herdr-chat`;
export const registryPath = (chat) => `${stateDir()}/chats/${chat}.json`;

async function readJson(path) {
  try {
    return JSON.parse((await readTextFile(path)) ?? "{}") ?? {};
  } catch {
    return {};
  }
}

/** Where the person's settings live (README "Configuration"); install never writes it. */
export const settingsPath = () => `${stateDir()}/settings.json`;

/**
 * What install wrote (mods/chat/config.json: the host, node, hc and each agent
 * it found) with the person's settings over it. One agent's:
 * {command, args, env, tui}, `tui` an argv or null.
 */
export async function readConfig() {
  const cfg = await readJson(`${appHome()}/mods/${MOD}/config.json`);
  const mine = await readJson(settingsPath());
  const list = (v) => (Array.isArray(v) ? v.map(String) : typeof v === "string" && v ? [v] : null);
  const agent = (id) => {
    const a = mine[id] && typeof mine[id] === "object" ? mine[id] : {};
    return {
      command: typeof a.command === "string" && a.command ? a.command : typeof cfg[id] === "string" ? cfg[id] : null,
      args: list(a.args) ?? [],
      env: { ...(mine.env ?? {}), ...(a.env ?? {}) },
      tui: list(a.tui),
    };
  };
  return { host: cfg.host ?? null, node: cfg.node ?? null, hc: cfg.hc ?? null, version: cfg.version ?? null, build: cfg.build ?? null, installedAt: cfg.installedAt ?? null, agent };
}

export async function readRegistry(chat) {
  try {
    const text = await readTextFile(registryPath(chat));
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

// Whether a terminal runs a host (herdr-chat-host, or herdr-chat-subagent for a
// sub-agent; a template runs it as `sh -c '…/herdr-chat-subagent …'`). After
// herdr-core restarts, it brings a kept terminal back as a login shell with
// the same labels: that shell is no host.
const HOST_BIN = /herdr-chat-(host|subagent)\b/;
export function runsHost(t) {
  return !Array.isArray(t.argv) || t.argv.some((a) => HOST_BIN.test(a));
}

// The live core terminal running this chat's host, if any.
export function hostTerminal(chat) {
  return terminals().find((t) => t.labels?.["herdr-chat.chat"] === chat && t.state === "live" && runsHost(t)) ?? null;
}

// hc run's error, for the person. The host starts as /usr/bin/env, which is
// always there: "No such file" from the spawn is the folder (a space whose
// worktree was deleted).
export function startError(text, cwd) {
  if (/spawn_failed/.test(text) && /No such file or directory/.test(text)) {
    return `The chat's folder ${cwd} doesn't exist (a deleted worktree?). Open the chat in a space whose folder exists.`;
  }
  return `couldn't start the host: ${text}`;
}

const BACKOFF = [250, 500, 1000, 2000, 2000];

export class Connection {
  // opts: {chat, cwd, attachOnly (never start a host), place: () => ({space, tab}) | null (a host starts only once the chat's tab is known), session, hostEnv, handOver ({pid, model, thinking} | null), onRecord(rec, cx), onChange(cx), log}
  constructor(opts) {
    this.o = opts;
    this.status = "connecting"; // connecting | starting | connected | reconnecting | stopped | failed
    this.error = null;
    this.link = null;
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
    this.attempt = 0;
    this.startedHostAt = 0;
    this.welcome = null;
    this.connects = 0;
    // Start a host when none runs: on open, and after Restart. Once a host
    // answered, its going away shows "host stopped" instead (main.js).
    this.autoStart = true;
  }

  restart() {
    this.startFailed = false;
    this.autoStart = true;
    this.startedHostAt = 0;
    this.attempt = 0;
  }

  set(status, error, cx) {
    if (this.status === status && this.error === error) return;
    this.status = status;
    this.error = error ?? null;
    this.o.onChange?.(cx);
  }

  start(cx) {
    cx.spawn(async (cx) => {
      while (!this.closed) {
        try {
          await this.once(cx);
        } catch (e) {
          this.o.log?.(`connection: ${message(e)}`);
          if (!this.closed) this.set(this.connects ? "reconnecting" : "connecting", message(e), cx);
        }
        this.failPending("disconnected");
        if (this.closed) return;
        await cx.sleep(BACKOFF[Math.min(this.attempt++, BACKOFF.length - 1)]);
      }
    });
    // Requests nobody answered within their time: fail them, keep the loop.
    cx.timer.every(1000, () => {
      const now = Date.now();
      for (const [id, p] of this.pending) {
        if (now > p.deadline) {
          this.pending.delete(id);
          p.reject(new Error(`${p.op}: no reply from the host`));
        }
      }
    });
  }

  // One connection attempt and, when it works, its whole read loop.
  async once(cx) {
    const entry = await readRegistry(this.o.chat);
    if (!entry?.port || !entry?.pid) {
      await this.ensureHost(cx, entry);
      return;
    }
    let link;
    try {
      link = await openLink(entry);
    } catch (e) {
      await this.ensureHost(cx, entry);
      return;
    }
    this.link = link;
    try {
      await link.send({ t: "hello", v: 1, token: entry.token, client: "mod" });
      let welcomed = false;
      for (let texts; (texts = await link.next()) !== null; ) {
        const recs = [];
        for (const text of texts) {
          try {
            recs.push(JSON.parse(text));
          } catch {
            this.o.log?.(`bad record: ${text.slice(0, 200)}`);
          }
        }
        for (const rec of recs) {
          if (rec.t === "welcome") {
            welcomed = true;
            this.welcome = rec;
            this.connects++;
            this.attempt = 0;
            this.autoStart = false;
            this.set("connected", null, cx);
          } else if (rec.t === "res") {
            const p = this.pending.get(rec.id);
            if (p) {
              this.pending.delete(rec.id);
              if (rec.ok) p.resolve(rec.data ?? {});
              else p.reject(new Error(rec.error ?? "failed"));
            }
          }
          if (welcomed && rec.t !== "ping") this.o.onRecord(rec, cx); // ping: the host's keepalive
        }
        if (recs.length) this.o.onFlush?.(cx);
      }
      if (!welcomed) {
        // A wrong token (a newer host wrote the registry) closes without a reply.
        this.o.log?.("closed before welcome");
      }
    } finally {
      this.link = null;
      link.close();
      if (!this.closed) this.set("reconnecting", null, cx);
    }
  }

  // No host answered: start one, unless a live terminal already runs it
  // (it may still be starting) or we just did.
  async ensureHost(cx, entry) {
    const live = hostTerminal(this.o.chat);
    // A sub-agent's chat only attaches: its host is the parent's to start and end.
    if (this.o.attachOnly) {
      if (live) this.set(this.connects ? "reconnecting" : "starting", null, cx);
      else this.set("stopped", "The sub-agent ended", cx);
      return;
    }
    // A start that failed stays failed (its error shown) until Retry (restart).
    if (this.startFailed) return;
    if (live || Date.now() - this.startedHostAt < 8000) {
      this.set(this.connects ? "reconnecting" : "starting", null, cx);
      return;
    }
    if (!this.autoStart) {
      this.set("stopped", "The chat's host stopped", cx);
      return;
    }
    const place = this.o.place?.();
    if (!place) {
      this.set("connecting", "waiting for the chat's tab", cx);
      return;
    }
    this.startedHostAt = Date.now();
    this.set("starting", null, cx);
    const cfg = await readConfig();
    // The chat's agent: its props, else what the registry recorded (a reopened chat keeps it).
    const provider = this.o.provider ?? entry?.provider ?? DEFAULT_PROVIDER;
    this.provider = provider;
    const host = cfg.host;
    const agent = cfg.agent(provider);
    if (!host) {
      this.startFailed = true;
      this.set("failed", `mods/${MOD}/config.json has no "host"`, cx);
      return;
    }
    const env = { ...agent.env, ...(this.o.hostEnv ?? {}) };
    if (cfg.node) env.HERDR_CHAT_NODE = cfg.node;
    const session = this.o.session ?? entry?.sessionFile ?? null;
    const args = [
      // No --name: the registry and the herdr-chat.chat label identify it, and
      // Herdr's toasts then show the title the host sets (OSC 0). No herdr.*
      // labels yet: the app would adopt it as a visible pane. The chat adds
      // its pane, hidden, to the layout document, then labels it (main.js
      // keepHostHidden). --keep: the core keeps it, as adoption would.
      "run", "--bg", "--json", "--keep", "--no-parent", "--cwd", this.o.cwd,
      "--label", `herdr-chat.chat=${this.o.chat}`, "--label", "herdr-chat.role=host",
      "--", "/usr/bin/env", ...Object.entries(env).map(([k, v]) => `${k}=${v}`),
      host, "serve", "--chat", this.o.chat, "--cwd", this.o.cwd, "--state-dir", stateDir(), "--app-home", appHome(), "--provider", provider,
      ...(session ? ["--session", session] : []),
      // A Pi TUI this chat takes over: the host waits for its pid, then uses its model and
      // thinking (only while that pid lives: a later restart of the chat ignores them).
      ...(session && this.o.handOver?.pid ? ["--after-pid", String(this.o.handOver.pid),
        ...(this.o.handOver.model ? ["--model", this.o.handOver.model] : []),
        ...(this.o.handOver.thinking ? ["--thinking", this.o.handOver.thinking] : [])] : []),
      // The agent's command and arguments (readConfig).
      ...(agent.command ? [`--${provider}`, agent.command] : []),
      ...(agent.args.length ? ["--", ...agent.args] : []),
    ];
    const r = await hc(args);
    this.o.log?.(`hc run host: code ${r.code} ${r.stdout.trim()} ${r.stderr.trim()}`);
    if (r.code !== 0) {
      this.startFailed = true;
      this.set("failed", startError((r.stderr || r.stdout).trim(), this.o.cwd), cx);
    }
    else this.o.onHostStarted?.(r.stdout, cx);
  }

  req(op, args = {}, { timeout = 30000 } = {}) {
    const link = this.link;
    if (!link || this.status !== "connected") return Promise.reject(new Error("not connected to the host"));
    const id = `m${this.nextId++}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, op, deadline: Date.now() + timeout });
      link.send({ t: "req", id, op, ...args }).catch((e) => {
        this.pending.delete(id);
        reject(e);
      });
    });
  }

  failPending(why) {
    for (const [, p] of this.pending) p.reject(new Error(why));
    this.pending.clear();
  }

  resync() {
    this.link?.close();
  }

  close() {
    this.closed = true;
    this.resync();
  }
}
