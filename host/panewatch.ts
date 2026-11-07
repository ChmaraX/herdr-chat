// The host ends with its chat's pane. Closing the chat's pane leaves the
// host's hidden pane in the tab: nothing drawn, a black tab until the host's
// terminal ends. So the host watches the layout document ("herdr-app") on the
// core's event stream (`events.subscribe`, a `doc` event per change; one
// `doc.get` each). Once it has seen its chat's pane, a document without it
// means the chat closed: the host has the app close its own hidden pane (the
// tab with it, when it's the tab's last), so the tab goes at once, then
// exits. An app quit doesn't change the document: no event, the host lives
// on, and the chat reattaches when the app starts again.
//
// Never armed: a sub-agent's host (a parent, or not role=host: it has no pane
// by design) and a host that never saw its chat's pane (the mod's
// sweepOrphans covers that one).

import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createConnection } from "node:net";
import { join } from "node:path";

type Node = { id?: string; content?: { mod?: string; terminal?: string; props?: { chat?: string } }; children?: Node[] };
type Doc = { spaces?: { id: string; tabs?: { id: string; root?: Node }[] }[] } | null;

export type Where = { chat: boolean; host: { pane: string; tab: string; alone: boolean } | null };

// The chat's pane (any mod pane whose props name the chat) and the host's own (its terminal's node).
export function where(doc: Doc, chat: string, terminal: string): Where {
  let seen = false;
  let host: Where["host"] = null;
  for (const s of doc?.spaces ?? []) for (const t of s.tabs ?? []) {
    let panes = 0;
    let mine: string | null = null;
    const walk = (n: Node | undefined) => {
      if (!n) return;
      const c = n.content;
      if (c) panes++;
      if (c?.mod && c.props?.chat === chat) seen = true;
      if (c?.terminal === terminal && n.id && !mine) mine = n.id;
      for (const ch of n.children ?? []) walk(ch);
    };
    walk(t.root);
    if (mine && !host) host = { pane: mine, tab: t.id, alone: panes === 1 };
  }
  return { chat: seen, host };
}

// One command to the app (`herdr-app do`, over its socket): its reply, or throws.
export function appDo(appHome: string, command: string, args: object, timeoutMs = 3000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(join(appHome, "herdr-app.sock"));
    let buf = "";
    const done = (e: Error | null, v?: Record<string, unknown>) => {
      clearTimeout(timer);
      sock.destroy();
      if (e) reject(e);
      else resolve(v!);
    };
    const timer = setTimeout(() => done(new Error(`${command}: no answer`)), timeoutMs);
    sock.on("connect", () => sock.write(JSON.stringify({ do: command, args }) + "\n"));
    sock.on("data", (d) => {
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      let r: Record<string, unknown>;
      try {
        r = JSON.parse(buf.slice(0, nl));
      } catch {
        return done(new Error(`${command}: a bad answer`));
      }
      if (r?.error) done(new Error(`${command}: ${String(r.error)}`));
      else done(null, r ?? {});
    });
    sock.on("error", (e) => done(e));
  });
}

type Opts = {
  chat: string;
  terminal: string;
  appHome: string;
  hc: string;
  log: (msg: string) => void;
  /** The chat's pane is gone (its hidden pane already closed, when it had one): exit. */
  onGone: () => void;
};

const HELLO = { jsonrpc: "2.0", id: 1, method: "hello", params: { generation: 1 } };

export class PaneWatch {
  private events: ChildProcessWithoutNullStreams | null = null;
  private calls: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, (r: { result?: unknown; error?: { message?: string } }) => void>();
  private nextId = 10;
  private armed = false;
  private off = false;
  private reading = false;
  private again = false;
  private retry: NodeJS.Timeout | null = null;

  private o: Opts;

  constructor(o: Opts) {
    this.o = o;
  }

  start(): void {
    if (this.off || this.events) return;
    const p = spawn(this.o.hc, ["connect"], { stdio: ["pipe", "pipe", "pipe"] });
    this.events = p;
    let buf = "";
    p.stdout.on("data", (d) => {
      buf += d;
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        this.onEvent(line);
      }
    });
    p.on("error", (e) => this.o.log(`pane watch: ${this.o.hc} connect: ${e.message}`));
    p.on("close", () => {
      if (this.events !== p) return;
      this.events = null;
      // The core restarted (or hc went): subscribe again, then read the document again.
      if (!this.off) this.retry = setTimeout(() => this.start(), 1000).unref() as NodeJS.Timeout;
    });
    p.stdin.on("error", () => {});
    p.stdin.write(JSON.stringify(HELLO) + "\n" + JSON.stringify({ jsonrpc: "2.0", id: 2, method: "events.subscribe", params: {} }) + "\n");
  }

  stop(): void {
    this.off = true;
    if (this.retry) clearTimeout(this.retry);
    for (const p of [this.events, this.calls]) p?.kill();
    this.events = this.calls = null;
  }

  private onEvent(line: string): void {
    let m: { id?: number; method?: string; result?: { terminals?: { address: string; parent?: string | null; labels?: Record<string, string> }[] }; error?: unknown; params?: { type?: string; machine?: string; data?: { name?: string } } };
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.id === 2) {
      if (m.error) return this.o.log(`pane watch: events.subscribe failed: ${JSON.stringify(m.error)}`);
      const me = m.result?.terminals?.find((t) => t.address === this.o.terminal);
      if (!me || me.parent || me.labels?.["herdr-chat.role"] !== "host") {
        this.o.log(`pane watch: ${me ? "a sub-agent's host (no pane of its own)" : `no terminal ${this.o.terminal} in the core`}: off`);
        return this.stop();
      }
      // The mod's close() leaves the host to this.
      return this.check(); // subscribed first, then read (changes meanwhile come as events)
    }
    const p = m.params;
    if (m.method === "missed" || (m.method === "event" && p?.type === "doc" && !p.machine && p.data?.name === "herdr-app")) this.check();
  }

  // One request on a second connection (a subscribed one carries only notifications).
  private call(method: string, params: object): Promise<unknown> {
    if (!this.calls) {
      const p = spawn(this.o.hc, ["connect"], { stdio: ["pipe", "pipe", "pipe"] });
      this.calls = p;
      let buf = "";
      p.stdout.on("data", (d) => {
        buf += d;
        for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          try {
            const r = JSON.parse(line);
            this.pending.get(r.id)?.(r);
            this.pending.delete(r.id);
          } catch {}
        }
      });
      const fail = () => {
        if (this.calls === p) this.calls = null;
        for (const [, f] of this.pending) f({ error: { message: "hc connect ended" } });
        this.pending.clear();
      };
      p.on("error", fail);
      p.on("close", fail);
      p.stdin.on("error", () => {});
      p.stdin.write(JSON.stringify(HELLO) + "\n");
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (r) => (r.error ? reject(new Error(r.error.message ?? `${method} failed`)) : resolve(r.result)));
      this.calls!.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  // Read the document (one read at a time; a change during a read reads again once).
  private check(): void {
    if (this.off) return;
    if (this.reading) {
      this.again = true;
      return;
    }
    this.reading = true;
    this.call("doc.get", { name: "herdr-app" })
      .then((r) => this.decide((r as { value?: Doc })?.value ?? null))
      .catch((e) => this.off || this.o.log(`pane watch: doc.get: ${e instanceof Error ? e.message : e}`))
      .finally(() => {
        this.reading = false;
        if (this.again) {
          this.again = false;
          this.check();
        }
      });
  }

  private async decide(doc: Doc): Promise<void> {
    if (this.off || !doc?.spaces) return;
    const w = where(doc, this.o.chat, this.o.terminal);
    if (w.chat) {
      if (!this.armed) this.o.log("pane watch: the chat's pane is in the layout document: armed");
      this.armed = true;
      return;
    }
    if (!this.armed) return;
    this.stop();
    // Its last pane: the tab goes (`pane.close` would ask to close the space when it's the space's last tab).
    const [cmd, args] = w.host?.alone
      ? ["tab.close", { id: w.host.tab, confirmed: true }]
      : ["pane.close", { pane: w.host?.pane }];
    if (w.host) {
      try {
        await appDo(this.o.appHome, cmd, args);
        this.o.log(`pane watch: the chat's pane closed: ${cmd} ${JSON.stringify(args)}`);
      } catch (e) {
        this.o.log(`pane watch: the chat's pane closed; ${e instanceof Error ? e.message : e} (exiting: the pane goes with the terminal)`);
      }
    } else this.o.log("pane watch: the chat's pane closed (no pane of the host's): exiting");
    this.o.onGone();
  }
}
