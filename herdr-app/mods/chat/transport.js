// Why a WebSocket: a mod reload (an install) leaves the old build's objects to
// QuickJS's cycle collector, which can take hours, and a view's objects are full
// of cycles. A `net` socket lives until its object is collected (3 descriptors
// each); after about 80 the app can't open a file or connect, and every chat
// sticks at "Starting…". A WebSocket belongs to a runtime thread that `close()`
// ends at once, whatever becomes of its object. So a new build closes the links
// the builds before it left open (`retireOlderBuilds`), and a closed chat its own.

import net from "net";
import { WebSocket } from "websocket";
import { Buffer } from "buffer";
import { message } from "./util.js";

const LINKS = Symbol.for("herdr-chat.links");
const BUILDS = Symbol.for("herdr-chat.builds");
const BUILD = (globalThis[BUILDS] = (globalThis[BUILDS] ?? 0) + 1);

function retireOlderBuilds(links) {
  for (const link of links) if (link.build < BUILD) link.close();
}

const closedByEitherSide = (e) => /closed/i.test(message(e));

// The host sends at most 4 messages before an ACK (protocol.md "Transport"). ACK on
// read, before the records are applied, so the next ones are already on their way.
const ACK = JSON.stringify({ t: "ack" });

export async function openLink(entry) {
  return entry.wsPort ? wsLink(entry.wsPort) : legacyTcpLink(entry.port);
}

async function wsLink(port) {
  const links = (globalThis[LINKS] ??= new Set());
  retireOlderBuilds(links);
  const ws = await WebSocket.connect(`ws://127.0.0.1:${port}/`);
  let closed = false;
  const link = {
    kind: "websocket",
    build: BUILD,
    send: (rec) => ws.write(JSON.stringify(rec)),
    async next() {
      if (closed) return null;
      try {
        const m = await ws.read();
        // A lost ACK is a slot the host never gets back: start over on a new link instead.
        ws.write(ACK).catch(() => link.close());
        return (typeof m === "string" ? m : Buffer.from(m).toString("utf8")).split("\n");
      } catch (e) {
        if (closed || closedByEitherSide(e)) return null;
        throw e;
      }
    },
    close() {
      if (closed) return;
      closed = true;
      links.delete(link);
      ws.close().catch(() => {});
    },
  };
  links.add(link);
  return link;
}

async function legacyTcpLink(port) {
  const sock = await net.connect("127.0.0.1", port);
  let closed = false;
  let buf = new Uint8Array(0);
  return {
    kind: "tcp",
    send: (rec) => sock.write(JSON.stringify(rec) + "\n"),
    async next() {
      for (;;) {
        let chunk;
        try {
          chunk = await sock.read(1 << 20);
        } catch (e) {
          // The runtime's read gives up after ~30 s without data (EAGAIN,
          // os error 35) though the socket is fine: keep reading.
          if (!closed && /temporarily unavailable|os error 35|WouldBlock|timed out/i.test(message(e))) continue;
          throw e;
        }
        if (chunk === null) return null;
        const merged = new Uint8Array(buf.length + chunk.length);
        merged.set(buf);
        merged.set(chunk, buf.length);
        let start = 0;
        const lines = [];
        for (let i = 0; i < merged.length; i++) {
          if (merged[i] !== 10) continue;
          const line = Buffer.from(merged.subarray(start, i)).toString("utf8");
          start = i + 1;
          if (line.trim()) lines.push(line);
        }
        buf = merged.slice(start);
        if (lines.length) return lines;
      }
    },
    close() {
      closed = true;
      try {
        sock.close();
      } catch {}
    },
  };
}
