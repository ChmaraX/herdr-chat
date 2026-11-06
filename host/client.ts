// A protocol client (protocol.md): used by `inspect`/`send` and by the tests.
import { connect } from "node:net";
import type { Socket } from "node:net";
import { LineFramer } from "./framing.ts";
import { readRegistry } from "./registry.ts";
import type { RegistryEntry } from "./registry.ts";

type Rec = Record<string, any>;

export class ChatClient {
  socket!: Socket;
  state: any = {};
  items: any[] = [];
  hasOlder = false;
  seq = 0;
  welcome: Rec | null = null;
  records: any[] = []; // every record received, for tests and artifacts
  toasts: Rec[] = [];
  closed = false;
  bye: Rec | null = null;
  private nextId = 0;
  private waiters = new Map<string, (r: Rec) => void>();
  private listeners = new Set<() => void>();
  seqErrors: string[] = [];

  static async connect(port: number, token: string, kind = "test", timeoutMs = 5000): Promise<ChatClient> {
    const c = new ChatClient();
    await c.open(port, token, kind, timeoutMs);
    return c;
  }

  static async fromRegistry(stateDir: string, chat: string, kind = "cli"): Promise<ChatClient> {
    const reg: RegistryEntry | null = readRegistry(stateDir, chat);
    if (!reg || !reg.port) throw new Error(`No running host for chat ${chat} in ${stateDir}`);
    return ChatClient.connect(reg.port, reg.token, kind);
  }

  private open(port: number, token: string, kind: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const s = connect(port, "127.0.0.1");
      this.socket = s;
      const timer = setTimeout(() => {
        s.destroy();
        reject(new Error("No welcome from the host"));
      }, timeoutMs);
      const framer = new LineFramer();
      framer.onLine = (line) => {
        const rec = JSON.parse(line) as Rec;
        this.records.push(rec);
        this.apply(rec);
        if (rec.t === "snapshot" && this.welcome) {
          clearTimeout(timer);
          resolve();
        }
      };
      s.on("data", (d) => framer.push(d));
      s.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      s.on("close", () => {
        this.closed = true;
        clearTimeout(timer);
        reject(new Error("Connection closed"));
        this.notify();
      });
      s.on("connect", () => s.write(JSON.stringify({ t: "hello", v: 1, token, client: kind }) + "\n"));
    });
  }

  private checkSeq(seq: number): void {
    if (this.seq && seq !== this.seq + 1) this.seqErrors.push(`seq ${seq} after ${this.seq}`);
    this.seq = seq;
  }

  private apply(rec: Rec): void {
    switch (rec.t) {
      case "welcome":
        this.welcome = rec;
        break;
      case "snapshot":
        this.checkSeq(rec.seq);
        this.state = rec.state;
        this.items = rec.items;
        this.hasOlder = rec.hasOlder;
        break;
      case "patch": {
        this.checkSeq(rec.seq);
        for (const [k, v] of Object.entries(rec.state ?? {})) {
          if (v === null) this.state[k] = null;
          else this.state[k] = v;
        }
        for (const it of rec.upsert ?? []) {
          const i = this.items.findIndex((x) => x.id === it.id);
          if (i >= 0) this.items[i] = it;
          else this.items.push(it);
        }
        const rm = new Set(rec.remove ?? []);
        if (rm.size) this.items = this.items.filter((x) => !rm.has(x.id));
        break;
      }
      case "res": {
        const w = this.waiters.get(rec.id);
        if (w) {
          this.waiters.delete(rec.id);
          w(rec);
        }
        break;
      }
      case "toast":
        this.toasts.push(rec);
        break;
      case "bye":
        this.bye = rec;
        break;
    }
    this.notify();
  }

  private notify(): void {
    for (const l of [...this.listeners]) l();
  }

  /** Sends an op; resolves with `data`, rejects with the host's error. */
  req(op: string, args: Rec = {}, timeoutMs = 30_000): Promise<any> {
    const id = `r${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(`${op}: no answer within ${timeoutMs} ms`));
      }, timeoutMs);
      this.waiters.set(id, (r) => {
        clearTimeout(timer);
        if (r.ok) resolve(r.data);
        else reject(new Error(r.error));
      });
      this.socket.write(JSON.stringify({ t: "req", id, op, ...args }) + "\n");
    });
  }

  /** Resolves once `pred` holds for the client's copy. */
  waitFor(pred: (c: ChatClient) => unknown, timeoutMs = 10_000, what = "condition"): Promise<void> {
    return new Promise((resolve, reject) => {
      const check = () => {
        let ok = false;
        try {
          ok = !!pred(this);
        } catch {}
        if (ok) {
          clearTimeout(timer);
          this.listeners.delete(check);
          resolve();
        }
      };
      const timer = setTimeout(() => {
        this.listeners.delete(check);
        reject(new Error(`timed out waiting for ${what}; phase=${this.state.phase} items=${this.items.map((i) => i.kind).join(",")}`));
      }, timeoutMs);
      this.listeners.add(check);
      check();
    });
  }

  close(): void {
    this.socket.end();
  }
}

/** `phase=idle,dialog!=null,items>=3,dialog.method=select` → predicate. */
export function parseWait(spec: string): (c: ChatClient) => boolean {
  const conds = spec.split(",").map((s) => s.trim()).filter(Boolean).map((cond) => {
    const m = /^([\w.]+)\s*(!=|>=|<=|=|>|<)\s*(.*)$/.exec(cond);
    if (!m) throw new Error(`Bad --wait condition: ${cond}`);
    const [, path, op, raw] = m;
    return (c: ChatClient) => {
      let v: unknown;
      if (path === "items") v = c.items.length;
      else v = path!.split(".").reduce<any>((o, k) => (o == null ? undefined : o[k]), c.state);
      const want = raw === "null" ? null : raw === "true" ? true : raw === "false" ? false : raw;
      const norm = v === undefined ? null : v;
      switch (op) {
        case "=":
          return String(norm) === String(want);
        case "!=":
          return String(norm) !== String(want);
        default: {
          const a = Number(norm);
          const b = Number(want);
          return op === ">=" ? a >= b : op === "<=" ? a <= b : op === ">" ? a > b : a < b;
        }
      }
    };
  });
  return (c) => conds.every((f) => f(c));
}
