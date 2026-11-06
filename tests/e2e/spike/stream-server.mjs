// Spike (a): a TCP server that streams JSONL to every client, for minutes.
//   node stream-server.mjs <port-file> [port]
// Each record: {conn, seq, ts, kind, pad}. 50 records/s (every 20 ms), every
// 100th one is big (~200 KiB), every 7th carries U+2028/U+2029 and multibyte
// text. `seq` counts per connection from 0, so the client can spot drops;
// `ts` is the send time (ms) for latency. It prints "listening <port>".
import net from "node:net";
import fs from "node:fs";

const [portFile, fixed] = process.argv.slice(2);
let conns = 0;
const big = "x".repeat(200 * 1024);
const server = net.createServer((sock) => {
  const conn = `${process.pid}-${++conns}`;
  let seq = 0;
  sock.setNoDelay(true);
  const timer = setInterval(() => {
    const rec = { conn, seq, ts: Date.now(), kind: "tick" };
    if (seq % 100 === 99) { rec.kind = "big"; rec.pad = big; }
    else if (seq % 7 === 3) { rec.kind = "unicode"; rec.pad = "line\u2028sep\u2029para — ünïcødé 🚀 中文"; }
    seq++;
    if (!sock.write(JSON.stringify(rec) + "\n")) {
      // Back-pressure: count it, keep going (the kernel buffers).
    }
  }, 20);
  sock.on("data", () => {});
  sock.on("close", () => clearInterval(timer));
  sock.on("error", () => clearInterval(timer));
});
server.listen(fixed ? Number(fixed) : 0, "127.0.0.1", () => {
  const port = server.address().port;
  fs.writeFileSync(portFile, String(port));
  console.log(`listening ${port}`);
});
