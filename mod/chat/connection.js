// The chat's link to its pi-chat-host: find it in the registry (or start it in
// a herdr-core terminal), connect over TCP, say hello, read JSONL records and
// correlate requests. Reconnects with backoff; a host counts as alive only
// after a successful hello/welcome (protocol.md "Chat registry").

import net from "net";
import { Buffer } from "buffer";
import { appHome, hc, readTextFile, terminals } from "herdr";
import { MOD, message } from "./util.js";

export const stateDir = () => `${appHome()}/data/pi-chat`;
export const registryPath = (chat) => `${stateDir()}/chats/${chat}.json`;

export async function readConfig() {
  try {
    return JSON.parse((await readTextFile(`${appHome()}/mods/${MOD}/config.json`)) ?? "{}");
  } catch {
    return {};
  }
}

export async function readRegistry(chat) {
  try {
    const text = await readTextFile(registryPath(chat));
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

// The live core terminal running this chat's host, if any.
export function hostTerminal(chat) {
  return terminals().find((t) => t.labels?.["pi-chat.chat"] === chat && t.state === "live") ?? null;
}

const BACKOFF = [250, 500, 1000, 2000, 2000];

export class Connection {
  // opts: {chat, cwd, attachOnly (never start a host), place: () => ({space, tab}) | null (a host starts only once the chat's tab is known), session, hostEnv, handOver ({pid, model, thinking} | null), onRecord(rec, cx), onChange(cx), log}
  constructor(opts) {
    this.o = opts;
    this.status = "connecting"; // connecting | starting | connected | reconnecting | stopped | failed
    this.error = null;
    this.sock = null;
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
    let sock;
    try {
      sock = await net.connect("127.0.0.1", entry.port);
    } catch (e) {
      await this.ensureHost(cx, entry);
      return;
    }
    this.sock = sock;
    try {
      await sock.write(JSON.stringify({ t: "hello", v: 1, token: entry.token, client: "mod" }) + "\n");
      let buf = new Uint8Array(0);
      let welcomed = false;
      for (;;) {
        let chunk;
        try {
          chunk = await sock.read(1 << 20);
        } catch (e) {
          // The runtime's read gives up after ~30 s without data (EAGAIN,
          // os error 35) though the socket is fine: keep reading.
          if (/temporarily unavailable|os error 35|WouldBlock|timed out/i.test(message(e)) && !this.closed) {
            this.idleReads = (this.idleReads ?? 0) + 1;
            continue;
          }
          throw e;
        }
        if (chunk === null) break;
        const merged = new Uint8Array(buf.length + chunk.length);
        merged.set(buf);
        merged.set(chunk, buf.length);
        buf = merged;
        let start = 0;
        const recs = [];
        for (let i = 0; i < buf.length; i++) {
          if (buf[i] !== 10) continue;
          const line = Buffer.from(buf.subarray(start, i)).toString("utf8");
          start = i + 1;
          if (!line.trim()) continue;
          try {
            recs.push(JSON.parse(line));
          } catch {
            this.o.log?.(`bad record: ${line.slice(0, 200)}`);
          }
        }
        buf = buf.slice(start);
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
      this.sock = null;
      try {
        sock.close();
      } catch {}
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
    const provider = this.o.provider ?? entry?.provider ?? "pi";
    this.provider = provider;
    const host = cfg.hosts?.[provider] ?? cfg.host; // `hosts`: a per-provider host (tests use a mock)
    if (!host) {
      this.set("failed", `mods/${MOD}/config.json has no "host"`, cx);
      return;
    }
    const env = { ...(cfg.env ?? {}), ...(this.o.hostEnv ?? {}) };
    if (cfg.node) env.PI_CHAT_NODE = cfg.node;
    const session = this.o.session ?? entry?.sessionFile ?? null;
    const args = [
      // No --name: the registry and the pi-chat.chat label identify it, and
      // Herdr's toasts then show the title the host sets (OSC 0). No herdr.*
      // labels yet: the app would adopt it as a visible pane. The chat adds
      // its pane, hidden, to the layout document, then labels it (main.js
      // keepHostHidden). --keep: the core keeps it, as adoption would.
      "run", "--bg", "--json", "--keep", "--no-parent", "--cwd", this.o.cwd,
      "--label", `pi-chat.chat=${this.o.chat}`, "--label", "pi-chat.role=host",
      "--", "/usr/bin/env", ...Object.entries(env).map(([k, v]) => `${k}=${v}`),
      host, "serve", "--chat", this.o.chat, "--cwd", this.o.cwd, "--state-dir", stateDir(), "--app-home", appHome(), "--provider", provider,
      ...(session ? ["--session", session] : []),
      // A Pi TUI this chat takes over: the host waits for its pid, then uses its model and
      // thinking (only while that pid lives: a later restart of the chat ignores them).
      ...(session && this.o.handOver?.pid ? ["--after-pid", String(this.o.handOver.pid),
        ...(this.o.handOver.model ? ["--model", this.o.handOver.model] : []),
        ...(this.o.handOver.thinking ? ["--thinking", this.o.handOver.thinking] : [])] : []),
      // The agent's command and arguments, per provider: `pi`/`piArgs`, `claude`/`claudeArgs`, `codex`/`codexArgs`.
      ...(typeof cfg[provider] === "string" ? [`--${provider}`, cfg[provider]] : []),
      ...(cfg[`${provider}Args`]?.length ? ["--", ...cfg[`${provider}Args`]] : []),
    ];
    const r = await hc(args);
    this.o.log?.(`hc run host: code ${r.code} ${r.stdout.trim()} ${r.stderr.trim()}`);
    if (r.code !== 0) this.set("failed", `couldn't start the host: ${(r.stderr || r.stdout).trim()}`, cx);
    else this.o.onHostStarted?.(r.stdout, cx);
  }

  req(op, args = {}, { timeout = 30000 } = {}) {
    const sock = this.sock;
    if (!sock || this.status !== "connected") return Promise.reject(new Error("not connected to the host"));
    const id = `m${this.nextId++}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, op, deadline: Date.now() + timeout });
      sock.write(JSON.stringify({ t: "req", id, op, ...args }) + "\n").catch((e) => {
        this.pending.delete(id);
        reject(e);
      });
    });
  }

  failPending(why) {
    for (const [, p] of this.pending) p.reject(new Error(why));
    this.pending.clear();
  }

  // Drop the socket: the loop reconnects and gets a fresh snapshot.
  resync() {
    try {
      this.sock?.close();
    } catch {}
  }

  close() {
    this.closed = true;
    this.resync();
  }
}
