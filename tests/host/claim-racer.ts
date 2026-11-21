// One contender in claim.test.ts: waits until the shared instant (argv[4], ms), claims the chat,
// prints {pid, ok, holder} and stays alive (a live claim) until its stdin closes.
import { claimChat } from "../../host/claim.ts";

const [stateDir, chat, at] = [process.argv[2]!, process.argv[3]!, Number(process.argv[4])];
while (Date.now() < at) {} // a busy wait: the contenders claim within a millisecond or so of each other
const r = claimChat(stateDir, chat, `t-${process.pid}`);
process.stdout.write(JSON.stringify({ pid: process.pid, ok: r.ok, holder: r.ok ? null : r.holder.pid, tookOver: r.ok ? r.tookOver?.pid ?? null : null }) + "\n");
process.stdin.resume();
process.stdin.on("end", () => {
  if (r.ok) r.release();
  process.exit(0);
});
