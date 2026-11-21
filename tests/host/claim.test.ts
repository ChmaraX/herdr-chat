// The chat claim under contention (host/claim.ts), with real processes and no host around it:
// one-host.test.ts starts whole hosts, whose start-up spreads them over ~100 ms. Here the
// contenders claim within about a millisecond of each other, many rounds over, through:
//   1. a fresh chat (no claim yet);
//   2. a claim its host released (a clean exit, then a restart);
//   3. a dead host's claim (SIGKILL): two takers must not both win;
//   4. a claim whose pid went to another process (a different start time);
// and a live claim is never taken, whoever asks. The artifact has every round.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { ARTIFACTS, sleep } from "./harness.ts";
import { chatHolder, claimDir } from "../../host/claim.ts";

const RACER = join(dirname(fileURLToPath(import.meta.url)), "claim-racer.ts");
const CONTENDERS = 8;
const ROUNDS = 12;

type Result = { pid: number; ok: boolean; holder: number | null; tookOver: number | null };
type Racer = { proc: ChildProcess; result: Promise<Result> };

function racer(stateDir: string, chat: string, at: number): Racer {
  const proc = spawn(process.execPath, [RACER, stateDir, chat, String(at)], { stdio: ["pipe", "pipe", "inherit"] });
  let out = "";
  const result = new Promise<Result>((resolve, reject) => {
    proc.stdout!.on("data", (d) => {
      out += d;
      if (out.includes("\n")) resolve(JSON.parse(out));
    });
    proc.on("exit", (code) => reject(new Error(`racer exited ${code} before claiming`)));
  });
  return { proc, result };
}

/** CONTENDERS processes claim `chat` at one instant (after their start-up). */
async function round(stateDir: string, chat: string): Promise<{ racers: Racer[]; results: Result[] }> {
  const at = Date.now() + 900;
  const racers = Array.from({ length: CONTENDERS }, () => racer(stateDir, chat, at));
  return { racers, results: await Promise.all(racers.map((r) => r.result)) };
}

async function end(racers: Racer[], how: "release" | "kill"): Promise<void> {
  await Promise.all(racers.map((r) => new Promise<void>((resolve) => {
    if (r.proc.exitCode !== null || r.proc.signalCode !== null) return resolve();
    r.proc.on("exit", () => resolve());
    if (how === "kill") r.proc.kill("SIGKILL");
    else r.proc.stdin!.end();
  })));
}

test("claim: contenders at the same instant, many rounds: exactly one holds the chat, through fresh, released, dead and pid-reused claims", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pich-claim-")));
  const stateDir = join(dir, "state");
  const chat = "c-claim";
  const log: unknown[] = [];
  let previous: Racer[] = [];
  try {
    for (let i = 0; i < ROUNDS; i++) {
      // How the last round's holder went: released (a clean exit), SIGKILL (dead), or its claim faked onto a live, unrelated pid.
      const how = i === 0 ? "fresh" : (["released", "killed", "pid reused"] as const)[i % 3]!;
      if (how === "released") await end(previous, "release");
      else if (how === "killed") await end(previous, "kill");
      else if (how === "pid reused") {
        await end(previous, "kill");
        const folder = claimDir(stateDir, chat);
        const top = Math.max(...readdirSync(folder).filter((n) => /^\d+\.json$/.test(n)).map((n) => parseInt(n, 10)));
        writeFileSync(join(folder, `${top + 1}.json`), JSON.stringify({ pid: process.pid, started: "Thu Jan  1 00:00:00 1970", terminal: null, at: 0 }) + "\n");
      }
      const { racers, results } = await round(stateDir, chat);
      previous = racers;
      const winners = results.filter((r) => r.ok);
      log.push({ round: i, before: how, results });
      assert.equal(winners.length, 1, `round ${i} (${how}): exactly one contender holds the chat: ${JSON.stringify(results)}`);
      const w = winners[0]!;
      for (const r of results.filter((r) => !r.ok)) assert.equal(r.holder, w.pid, `round ${i}: a refused contender names the holder`);
      assert.equal(chatHolder(stateDir, chat)?.pid, w.pid, `round ${i}: the claim on disk is the holder's`);
      // A live claim is never taken: a late contender is refused too.
      const late = racer(stateDir, chat, Date.now());
      const lr = await late.result;
      await end([late], "release");
      assert.equal(lr.ok, false, `round ${i}: a late contender is refused while the holder lives`);
      // The holder of a dead or pid-reused claim says whose it took over.
      if (how === "killed" || how === "pid reused") assert.ok(w.tookOver !== null, `round ${i} (${how}): the winner took a dead claim over`);
      if (how === "released" || how === "fresh") assert.equal(w.tookOver, null, `round ${i} (${how}): nothing to take over`);
    }
  } finally {
    mkdirSync(ARTIFACTS, { recursive: true });
    writeFileSync(join(ARTIFACTS, "claim-race.json"), JSON.stringify({ test: "claim-race", contenders: CONTENDERS, rounds: log }, null, 2) + "\n");
    await end(previous, "kill");
    await sleep(50);
  }
});
