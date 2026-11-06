// Drives `pi --mode rpc` with LF-only framing and records every stdout record.
import { spawn } from "node:child_process";
import { writeFileSync, appendFileSync } from "node:fs";
const out = new URL("./events.jsonl", import.meta.url).pathname;
writeFileSync(out, "");
const child = spawn("pi", ["--mode", "rpc", "--no-session", "--model", "anthropic/claude-haiku-4-5", "--thinking", "low"],
  { cwd: process.env.PROBE_CWD ?? process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
let buf = Buffer.alloc(0), stderr = "";
const waiters = new Map();
const t0 = Date.now();
child.stderr.on("data", (d) => (stderr += d));
child.stdout.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
  let i;
  while ((i = buf.indexOf(10)) >= 0) {
    let line = buf.subarray(0, i).toString("utf8"); buf = buf.subarray(i + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (!line) continue;
    const rec = JSON.parse(line);
    appendFileSync(out, JSON.stringify({ t: Date.now() - t0, ...rec }) + "\n");
    if (rec.type === "response" && waiters.has(rec.id)) { waiters.get(rec.id)(rec); waiters.delete(rec.id); }
    if (rec.type === "agent_settled") waiters.get("settled")?.(rec);
  }
});
let n = 0;
const send = (cmd) => new Promise((res) => { const id = `p${++n}`; waiters.set(id, res); child.stdin.write(JSON.stringify({ id, ...cmd }) + "\n"); });
const settled = () => new Promise((res) => waiters.set("settled", res));
const state = await send({ type: "get_state" });
const cmds = await send({ type: "get_commands" });
console.log("state:", JSON.stringify({ model: state.data?.model?.id, thinking: state.data?.thinkingLevel, isStreaming: state.data?.isStreaming }));
console.log("commands:", cmds.data.commands.length, "by source:", JSON.stringify(cmds.data.commands.reduce((a, c) => ((a[c.source] = (a[c.source] || 0) + 1), a), {})));
console.log("extension cmds:", cmds.data.commands.filter((c) => c.source === "extension").map((c) => c.name).join(" "));
const s = settled();
const p = await send({ type: "prompt", message: "Use the bash tool to run `echo hello-from-rpc`, then reply with just the word done." });
console.log("prompt response:", JSON.stringify(p.data));
await Promise.race([s, new Promise((r) => setTimeout(r, 90000))]);
child.stdin.end();
await new Promise((r) => child.on("exit", r));
writeFileSync(new URL("./stderr.txt", import.meta.url).pathname, stderr);
console.log("done; stderr bytes:", stderr.length);
