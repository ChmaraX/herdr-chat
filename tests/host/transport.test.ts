import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { startHost, idle, sleep } from "./harness.ts";
import type { Host } from "./harness.ts";

type Rec = Record<string, any>;

class WsClient {
  ws: WebSocket;
  records: Rec[] = [];
  nonJson: string[] = [];
  messages = 0;
  holding = false;
  private unacked = 0;
  closed = false;
  upgraded = false;
  private nextId = 0;
  private replies = new Map<string, (r: Rec) => void>();

  constructor(port: number, headers: Record<string, string> = {}) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers });
    this.ws.on("upgrade", () => (this.upgraded = true));
    this.ws.on("message", (data) => {
      this.messages++;
      if (this.holding) this.unacked++;
      else this.ack();
      for (const text of String(data).split("\n")) {
        let rec: Rec;
        try {
          rec = JSON.parse(text);
        } catch {
          this.nonJson.push(text.slice(0, 200));
          continue;
        }
        this.records.push(rec);
        if (rec.t === "res") this.replies.get(rec.id)?.(rec);
      }
    });
    this.ws.on("error", () => {});
    this.ws.on("close", () => (this.closed = true));
  }

  opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("close", () => reject(new Error("closed before open")));
    });
  }

  send(rec: Rec): void {
    this.ws.send(JSON.stringify(rec));
  }

  private ack(): void {
    this.send({ t: "ack" });
  }

  resume(): void {
    this.holding = false;
    for (; this.unacked > 0; this.unacked--) this.ack();
  }

  req(op: string, args: Rec = {}): Promise<Rec> {
    const id = `w${++this.nextId}`;
    return new Promise((resolve) => {
      this.replies.set(id, resolve);
      this.send({ t: "req", id, op, ...args });
    });
  }

  async until(pred: () => boolean, ms: number, what: string): Promise<void> {
    const t0 = Date.now();
    while (!pred()) {
      if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`);
      await sleep(20);
    }
  }
}

const withoutPings = (recs: Rec[]) => recs.filter((r) => r.t !== "ping");
const withoutSeq = ({ seq, ...r }: Rec) => r;

async function joinWs(h: Host): Promise<WsClient> {
  const ws = new WsClient(h.registry!.wsPort!);
  await ws.opened();
  ws.send({ t: "hello", v: 1, token: h.registry!.token, client: "mod" });
  await ws.until(() => ws.records.some((r) => r.t === "snapshot"), 5000, "welcome and snapshot");
  assert.deepEqual(ws.records.slice(0, 2).map((r) => r.t), ["welcome", "snapshot"]);
  return ws;
}

test("same records: the WebSocket client gets what the JSONL client gets, and its requests are answered on it", async () => {
  const h = await startHost({ name: "ws-same", scenario: "tools.json", speed: 5 });
  let ws: WsClient | null = null;
  try {
    const tcp = h.client;
    await tcp.waitFor(idle, 10_000, "idle at start");
    const wsPort = h.registry!.wsPort!;
    assert.ok(wsPort > 0 && wsPort !== h.registry!.port, `wsPort ${wsPort} beside port ${h.registry!.port}`);

    ws = await joinWs(h);
    const wsFrom = ws.records.length;
    const tcpFrom = tcp.records.length;

    const res = await ws.req("send", { text: "Look around the repo" });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.data.disposition, "started");
    await tcp.waitFor((x) => idle(x) && x.items.some((i) => i.kind === "tool"), 15_000, "the turn ends");
    const wsTurnOf = () => withoutPings(ws!.records.slice(wsFrom)).filter((r) => r.t !== "res");
    const tcpTurn = withoutPings(tcp.records.slice(tcpFrom));
    await ws.until(() => wsTurnOf().length >= tcpTurn.length, 5000, "the WebSocket client catches up");
    const wsTurn = wsTurnOf();
    const kinds = wsTurn.flatMap((r) => (r.upsert ?? []).map((i: Rec) => i.kind));
    assert.ok(kinds.includes("tool") && kinds.at(-1) === "assistant", `the turn's items came over the WebSocket: ${kinds}`);
    assert.deepEqual(wsTurn.map(withoutSeq), tcpTurn.map(withoutSeq));
    assert.deepEqual(ws.nonJson, [], "every line of every message is one JSON record");
    assert.equal(tcp.records.filter((r) => r.t === "res" && String(r.id).startsWith("w")).length, 0);
    const models = await ws.req("models");
    assert.equal(models.ok, true, JSON.stringify(models));

    h.artifact("transport-ws", { wsRecords: ws.records.length, tcpRecords: tcp.records.length, turnRecords: wsTurn.map((r) => r.t) });
    ws.ws.close();
    await h.stop();
    assert.equal(h.registry!.port, null);
    assert.equal(h.registry!.wsPort, null, "a clean exit clears wsPort");
  } finally {
    ws?.ws.terminate();
    await h.stop();
  }
});

test("a stalled reader: a WebSocket client that stops ACKing mid-stream keeps its connection, gets at most 4 messages, then catches up in order", async () => {
  const h = await startHost({ name: "ws-stall", scenario: "long-markdown.json", speed: 1 });
  let ws: WsClient | null = null;
  try {
    const tcp = h.client;
    await tcp.waitFor(idle, 10_000, "idle at start");
    ws = await joinWs(h);
    const wsFrom = ws.records.length;
    const tcpFrom = tcp.records.length;

    ws.holding = true;
    const heldFrom = ws.messages;
    await tcp.req("send", { text: "Write the long report" });
    await tcp.waitFor(idle, 15_000, "the turn ends");
    const tcpTurn = withoutPings(tcp.records.slice(tcpFrom)).filter((r) => r.t !== "res");
    assert.ok(tcpTurn.length >= 20, `the turn streamed ${tcpTurn.length} records to the JSONL client`);
    assert.equal(ws.closed, false, "the stalled client keeps its connection");
    const whileHeld = ws.messages - heldFrom;
    assert.ok(whileHeld <= 4, `${whileHeld} messages went to a client that ACKed none`);

    ws.resume();
    const wsTurnOf = () => withoutPings(ws!.records.slice(wsFrom));
    await ws.until(() => wsTurnOf().length >= tcpTurn.length, 5000, "the WebSocket client catches up");
    assert.deepEqual(wsTurnOf().map(withoutSeq), tcpTurn.map(withoutSeq), "the same records, in order");
    const seqs = ws.records.flatMap((r) => (typeof r.seq === "number" ? [r.seq] : []));
    assert.deepEqual(seqs.slice(1), seqs.slice(0, -1).map((n) => n + 1), "no seq gaps");
    assert.deepEqual(ws.nonJson, []);
    const models = await ws.req("models");
    assert.equal(models.ok, true, "it is answered again after catching up");
    h.artifact("transport-ws-stall", { turnRecords: tcpTurn.length, messagesWhileHeld: whileHeld, messagesAfter: ws.messages - heldFrom - whileHeld });
  } finally {
    ws?.ws.terminate();
    await h.stop();
  }
});

test("refused: a wrong token, a silent client and a web page get nothing over the WebSocket", async () => {
  const h = await startHost({ name: "ws-refused", speed: 4 });
  try {
    const wsPort = h.registry!.wsPort!;

    const wrong = new WsClient(wsPort);
    await wrong.opened();
    wrong.send({ t: "hello", v: 1, token: "0".repeat(64), client: "mod" });
    await wrong.until(() => wrong.closed, 3000, "a wrong token is closed");
    assert.deepEqual(wrong.records, []);

    const silent = new WsClient(wsPort);
    await silent.opened();
    const t0 = Date.now();
    await silent.until(() => silent.closed, 8000, "no hello is closed");
    assert.ok(Date.now() - t0 >= 4500, `closed after ${Date.now() - t0} ms`);
    assert.deepEqual(silent.records, []);

    const page = new WsClient(wsPort, { Origin: "https://example.com" });
    await page.until(() => page.closed, 3000, "the page's handshake is refused");
    assert.equal(page.upgraded, false);

    assert.equal(h.client.closed, false);
    await h.client.req("models");
  } finally {
    await h.stop();
  }
});
