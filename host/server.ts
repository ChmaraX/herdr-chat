import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { createHash, timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { LineFramer, MAX_RECORD_BYTES } from "./framing.ts";
import type { Chat, Patch, Sink } from "./chat.ts";
import { hostBuild } from "./build.ts";

export const PROTOCOL_VERSION = 1;
const HELLO_TIMEOUT_MS = 5000;
const MAX_CLIENT_BUFFER = 64 * 1024 * 1024;
/** Keepalive: a read on Herdr's `net` module fails after ~30 s idle (a mod on the legacy TCP link). */
const PING_MS = Number(process.env.HERDR_CHAT_PING_MS ?? "15000") || 15000;

function tokenMatches(given: unknown, expected: string): boolean {
  if (typeof given !== "string") return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

interface Peer {
  send(json: string): void;
  buffered(): number;
  end(): void;
  destroy(): void;
  readonly open: boolean;
  readonly keepalive: boolean;
}

function tcpPeer(socket: Socket): Peer {
  return {
    send: (json) => void socket.write(json + "\n"),
    buffered: () => socket.writableLength,
    end: () => void socket.end(),
    destroy: () => void socket.destroy(),
    get open() { return !socket.destroyed; },
    keepalive: true,
  };
}

/**
 * Herdr's runtime closes a WebSocket when 8 messages wait unread, as they do while any mod keeps
 * the app's JS thread busy. So the mod ACKs each message as it reads it, and at most WS_WINDOW
 * go unacknowledged; records wait here meanwhile and go out together when a slot frees, in
 * messages of at most MAX_RECORD_BYTES (the runtime's message limit too).
 */
const WS_WINDOW = 4;
const WS_ACK = '{"t":"ack"}';

function wsPeer(ws: WebSocket): Peer & { acked(): void } {
  const waiting: { json: string; bytes: number }[] = [];
  let waitingBytes = 0;
  let unacked = 0;
  let ending = false;
  const pump = (): void => {
    if (ws.readyState !== WebSocket.OPEN) return;
    while (unacked < WS_WINDOW && waiting.length) {
      let n = 0;
      let size = 0;
      for (const r of waiting) {
        const joined = n === 0 ? r.bytes : size + 1 + r.bytes;
        if (n > 0 && joined > MAX_RECORD_BYTES) break;
        size = joined;
        n++;
      }
      const batch = waiting.splice(0, n);
      for (const r of batch) waitingBytes -= r.bytes;
      ws.send(batch.map((r) => r.json).join("\n"));
      unacked++;
    }
    if (ending && !waiting.length) ws.close(1000);
  };
  return {
    send: (json) => {
      const bytes = Buffer.byteLength(json);
      waiting.push({ json, bytes });
      waitingBytes += bytes;
      pump();
    },
    acked: () => {
      if (unacked > 0) unacked--;
      pump();
    },
    buffered: () => waitingBytes + ws.bufferedAmount,
    end: () => {
      ending = true;
      pump();
    },
    destroy: () => ws.terminate(),
    get open() { return ws.readyState === WebSocket.OPEN; },
    keepalive: false,
  };
}

class Client {
  peer: Peer;
  seq = 0;
  ready = false;
  kind = "unknown";
  constructor(peer: Peer) {
    this.peer = peer;
  }
  send(rec: Record<string, unknown>): void {
    if (!this.peer.open) return;
    const json = JSON.stringify(rec);
    if (Buffer.byteLength(json) > MAX_RECORD_BYTES) {
      this.peer.send(JSON.stringify({ t: "toast", level: "error", text: "A host record exceeded 8 MiB and was dropped" }));
      return;
    }
    // A client that stops reading is cut off rather than buffered without bound.
    if (this.peer.buffered() > MAX_CLIENT_BUFFER) {
      this.peer.destroy();
      return;
    }
    this.peer.send(json);
  }
}

export class ChatServer implements Sink {
  chat: Chat;
  token: string;
  server: Server;
  wss: WebSocketServer | null = null;
  clients = new Set<Client>();
  log: (msg: string) => void;
  port = 0;
  wsPort = 0;
  private pinger: NodeJS.Timeout;

  constructor(chat: Chat, token: string, log: (msg: string) => void) {
    this.chat = chat;
    this.token = token;
    this.log = log;
    this.server = createServer((s) => this.acceptTcp(s));
    chat.sinks.push(this);
    this.pinger = setInterval(() => {
      for (const c of this.clients) if (c.peer.keepalive) c.send({ t: "ping" });
    }, PING_MS);
    this.pinger.unref();
  }

  async listen(): Promise<{ port: number; wsPort: number }> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = this.server.address();
    this.port = typeof addr === "object" && addr ? addr.port : 0;
    const wss = new WebSocketServer({
      host: "127.0.0.1", port: 0, maxPayload: MAX_RECORD_BYTES, perMessageDeflate: false,
      // A browser sends an Origin; Herdr's runtime and other local clients don't. A web
      // page may open a WebSocket to 127.0.0.1, so it never gets as far as the token.
      verifyClient: (info: { origin?: string }) => !info.origin,
    });
    this.wss = wss;
    await new Promise<void>((resolve, reject) => {
      wss.once("error", reject);
      wss.once("listening", () => resolve());
    });
    wss.on("connection", (ws) => this.acceptWs(ws));
    const waddr = wss.address();
    this.wsPort = typeof waddr === "object" && waddr ? waddr.port : 0;
    return { port: this.port, wsPort: this.wsPort };
  }

  /** Stops listening and ends every client; one that doesn't close its side in 500 ms is cut, so a shutdown never waits on a client. */
  close(): Promise<void> {
    clearInterval(this.pinger);
    for (const c of this.clients) c.peer.end();
    const cut = setTimeout(() => { for (const c of this.clients) c.peer.destroy(); }, 500);
    const closing = [
      new Promise<void>((r) => this.server.close(() => r())),
      new Promise<void>((r) => (this.wss ? this.wss.close(() => r()) : r())),
    ];
    return Promise.all(closing).then(() => clearTimeout(cut));
  }

  private acceptTcp(socket: Socket): void {
    socket.setNoDelay(true);
    const conn = this.attach(tcpPeer(socket));
    const framer = new LineFramer();
    framer.onOversized = (o) => this.log(`dropped an oversized client record (${o.size} bytes)`);
    framer.onLine = conn.receive;
    socket.on("data", (d) => framer.push(d));
    socket.on("error", () => {});
    socket.on("close", conn.closed);
  }

  private acceptWs(ws: WebSocket): void {
    const peer = wsPeer(ws);
    const conn = this.attach(peer);
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      const text = String(data);
      if (text === WS_ACK) peer.acked();
      else conn.receive(text);
    });
    ws.on("error", () => {});
    ws.on("close", conn.closed);
  }

  private attach(peer: Peer): { receive: (json: string) => void; closed: () => void } {
    const client = new Client(peer);
    const timer = setTimeout(() => {
      if (!client.ready) peer.destroy();
    }, HELLO_TIMEOUT_MS);
    const receive = (json: string): void => {
      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(json);
      } catch {
        if (!client.ready) peer.destroy();
        return;
      }
      if (!client.ready) {
        if (rec.t !== "hello" || !tokenMatches(rec.token, this.token)) {
          peer.destroy();
          return;
        }
        clearTimeout(timer);
        client.ready = true;
        client.kind = String(rec.client ?? "unknown");
        // Flush pending changes to the others first: this client starts from the snapshot.
        this.chat.flush();
        this.clients.add(client);
        client.send({ t: "welcome", v: PROTOCOL_VERSION, chat: this.chat.opts.chat, host: { pid: process.pid, ...hostBuild(), startedAt: Math.round(performance.timeOrigin) } });
        this.sendSnapshot(client);
        return;
      }
      if (rec.t === "req") void this.request(client, rec);
    };
    const closed = (): void => {
      clearTimeout(timer);
      this.clients.delete(client);
    };
    return { receive, closed };
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
      c.peer.end();
    }
  }
}
