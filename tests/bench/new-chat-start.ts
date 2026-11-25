// Benchmark: how long a new chat's host takes to start, per provider, on the fake agents.
//   node tests/bench/new-chat-start.ts [runs=15]
// Prints, per provider, the median [min-max] of the time from spawning the host to (a) it being registered (the
// chat mod can connect from then on) and (b) the chat being ready (a client connected, phase "idle"). The fake agents start instantly, so this is the host's own
// cost; a real agent's startup (MCP servers, login) comes on top. Run it on two checkouts to compare;
// HERDR_CHAT_TEST_HOST=<release>/host/main.js runs a built host (see tests/host/harness.ts).
import { Host, startHost, idle } from "../host/harness.ts";
import { startClaude } from "../fake-claude/host.ts";
import { codexHost } from "../fake-codex/host.ts";

// When the host registered: Host.start() waits for it, then connects.
let registeredAt = 0;
const registered = Host.prototype.registered;
Host.prototype.registered = async function (this: Host, ...a: Parameters<Host["registered"]>) {
  await registered.apply(this, a);
  registeredAt = performance.now();
};

const RUNS = Number(process.argv[2] ?? 15);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

type Starter = (name: string) => Promise<{ client: any; stop(): Promise<void> }>;
const CASES: [string, Starter][] = [
  ["pi", (name) => startHost({ name }) as any],
  ["claude", (name) => startClaude({ name }) as any],
  ["codex", (name) => codexHost({ name }) as any],
  ["codex, model/list takes 1 s", (name) => codexHost({ name, scenario: { modelListDelayMs: 1000, prompts: [] } }) as any],
];

console.log(`node ${process.version}, ${RUNS} runs each (ms: median [min-max])`);
for (const [label, start] of CASES) {
  const reg: number[] = [];
  const ready: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    const h = await start(`bench-${i}`);
    reg.push(registeredAt - t0);
    try {
      await h.client.waitFor(idle, 15_000);
      ready.push(performance.now() - t0);
    } finally {
      await h.stop();
    }
  }
  const f = (xs: number[]) => `${Math.round(median(xs))} [${Math.round(Math.min(...xs))}-${Math.round(Math.max(...xs))}]`;
  console.log(`${label.padEnd(30)} registered ${f(reg).padEnd(14)} ready ${f(ready)}`);
}
