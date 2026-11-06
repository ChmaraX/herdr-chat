// TCP server: token auth, snapshot + patch stream per client, ops.
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { createHash, timingSafeEqual } from "node:crypto";
import { LineFramer, MAX_RECORD_BYTES } from "./framing.ts";
import type { Chat, Patch, Sink } from "./chat.ts";

export const PROTOCOL_VERSION = 1;
export const HOST_VERSION = "0.1.0";
const HELLO_TIMEOUT_MS = 5000;
const MAX_CLIENT_BUFFER = 64 * 1024 * 1024;
/** Keepalive: Herdr's mod runtime fails a socket read after ~30 s idle. */
const PING_MS = Number(process.env.PI_CHAT_PING_MS ?? "15000") || 15000;

function tokenMatches(given: unknown, expected: string): boolean {
  if (typeof given !== "string") return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

class Client {
  socket: Socket;
  seq = 0;
  ready = false;
  kind = "unknown";
  constructor(socket: Socket) {
    this.socket = socket;
  }
  send(rec: Record<string, unknown>): void {
    if (this.socket.destroyed) return;
    const line = JSON.stringify(rec) + "\n";
    if (Buffer.byteLength(line) > MAX_RECORD_BYTES) {
      this.socket.write(JSON.stringify({ t: "toast", level: "error", text: "A host record exceeded 8 MiB and was dropped" }) + "\n");
      return;
    }
    // A client that stops reading is cut off rather than buffered without bound.
    if (this.socket.writableLength > MAX_CLIENT_BUFFER) {
      this.socket.destroy();
      return;
    }
    this.socket.write(line);
  }
}

export class ChatServer implements Sink {
  chat: Chat;
  token: string;
  server: Server;
  clients = new Set<Client>();
  log: (msg: string) => void;
  port = 0;
  private pinger: NodeJS.Timeout;

  constructor(chat: Chat, token: string, log: (msg: string) => void) {
    this.chat = chat;
    this.token = token;
    this.log = log;
    this.server = createServer((s) => this.accept(s));
    chat.sinks.push(this);
    this.pinger = setInterval(() => {
      for (const c of this.clients) c.send({ t: "ping" });
    }, PING_MS);
    this.pinger.unref();
  }

  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        const addr = this.server.address();
        this.port = typeof addr === "object" && addr ? addr.port : 0;
        resolve(this.port);
      });
    });
  }

  close(): Promise<void> {
    clearInterval(this.pinger);
    for (const c of this.clients) c.socket.end();
    return new Promise((r) => this.server.close(() => r()));
  }

  private accept(socket: Socket): void {
    socket.setNoDelay(true);
    const client = new Client(socket);
    const framer = new LineFramer();
    const timer = setTimeout(() => {
      if (!client.ready) socket.destroy();
    }, HELLO_TIMEOUT_MS);
    framer.onOversized = (o) => this.log(`dropped an oversized client record (${o.size} bytes)`);
    framer.onLine = (line) => {
      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(line);
      } catch {
        if (!client.ready) socket.destroy();
        return;
      }
      if (!client.ready) {
        if (rec.t !== "hello" || !tokenMatches(rec.token, this.token)) {
          socket.destroy();
          return;
        }
        clearTimeout(timer);
        client.ready = true;
        client.kind = String(rec.client ?? "unknown");
        // Flush pending changes to the others first: this client starts from the snapshot.
        this.chat.flush();
        this.clients.add(client);
        client.send({ t: "welcome", v: PROTOCOL_VERSION, chat: this.chat.opts.chat, host: { pid: process.pid, version: HOST_VERSION } });
        this.sendSnapshot(client);
        return;
      }
      if (rec.t === "req") void this.request(client, rec);
    };
    socket.on("data", (d) => framer.push(d));
    socket.on("error", () => {});
    socket.on("close", () => {
      clearTimeout(timer);
      this.clients.delete(client);
    });
  }

  private async request(client: Client, rec: Record<string, unknown>): Promise<void> {
    const id = rec.id;
    const op = String(rec.op ?? "");
    try {
      const data = await this.chat.op(op, rec);
      // An op's effects reach every client before its result.
      this.chat.flush();
      client.send({ t: "res", id, ok: true, data: data ?? {} });
    } catch (e) {
      this.chat.flush();
      client.send({ t: "res", id, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  private sendSnapshot(client: Client): void {
    const snap = this.chat.snapshotData();
    client.send({ t: "snapshot", seq: ++client.seq, ...snap });
  }

  // Sink
  patch(p: Patch): void {
    for (const c of this.clients) c.send({ t: "patch", seq: ++c.seq, state: p.state, upsert: p.upsert, remove: p.remove });
  }
  snapshot(): void {
    const snap = this.chat.snapshotData();
    for (const c of this.clients) c.send({ t: "snapshot", seq: ++c.seq, ...snap });
  }
  toast(level: "info" | "warning" | "error", text: string): void {
    for (const c of this.clients) c.send({ t: "toast", level, text });
  }
  bye(reason: string): void {
    for (const c of this.clients) {
      c.send({ t: "bye", reason });
      c.socket.end();
    }
  }
}
