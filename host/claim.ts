// One host process per chat: the chat's claim (<stateDir>/chats/<chat>.lock/).
//
// A host claims its chat before it does anything else (main.ts serve): before
// it writes the registry, clears the chat's images or starts the agent. A host
// that finds another live host's claim refuses to serve; one that finds a dead
// host's claim takes it over.
//
// The claim is a folder of numbered generations, `<n>.json`, each
// {pid, started, terminal, at}. The newest is the chat's claim. Claiming reads
// the newest, n, and when it is dead creates n + 1 with an exclusive link of an
// already written file, so a generation is never seen half written and never
// changes. Of hosts racing for the chat (two starts at once, two takers of one
// dead claim), exactly one creates n + 1; the others then read n + 1, live,
// and refuse. A single lock file can't be taken over this way: replacing a
// dead one is a delete then a create, and a second taker that saw the dead one
// deletes the first taker's new lock.
//
// The generations are 1, 2, 3… with no gaps (n + 1 only after n), so a host
// that read the folder a while ago finds its n + 1 taken. Older generations are
// pruned, keeping the last KEEP; a host that got so far behind that its n + 1
// was pruned sees a newer one after its link, and drops its own.
//
// Released: a host marks its generation `<n>.released` as it exits. One that
// died (SIGKILL, a crash) leaves it unmarked: its pid is dead, or reused by a
// process with another start time (registry.ts processStamp).
import { linkSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { processRuns, processStamp } from "./registry.ts";

export type Claim = {
  pid: number;
  /** The process's processStamp (its start time): a pid reused by another process has another. Null when `ps` couldn't say. */
  started: string | null;
  terminal: string | null;
  /** ms, when it claimed the chat. */
  at: number;
};

const KEEP = 8;

export function claimDir(stateDir: string, chat: string): string {
  return join(stateDir, "chats", `${chat}.lock`);
}

function generations(dir: string): number[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.map((n) => /^(\d+)\.json$/.exec(n)).filter((m) => m !== null).map((m) => Number(m[1])).sort((a, b) => b - a);
}

const genPath = (dir: string, gen: number) => join(dir, `${gen}.json`);
const releasedPath = (dir: string, gen: number) => join(dir, `${gen}.released`);

function read(dir: string, gen: number): Claim | null {
  try {
    return JSON.parse(readFileSync(genPath(dir, gen), "utf8"));
  } catch {
    return null;
  }
}

/** Generation `gen`'s claim while its host runs and hasn't released it; else null. */
function live(dir: string, gen: number): Claim | null {
  const c = read(dir, gen);
  return c && !existsSync(releasedPath(dir, gen)) && processRuns(c.pid, c.started) ? c : null;
}

/** The chat's live host claim, if any. */
export function chatHolder(stateDir: string, chat: string): Claim | null {
  const dir = claimDir(stateDir, chat);
  const top = generations(dir)[0];
  return top === undefined ? null : live(dir, top);
}

export type ClaimResult =
  | { ok: true; claim: Claim; tookOver: Claim | null; release: () => void }
  | { ok: false; holder: Claim };

/**
 * Claims `chat` for this process. Fails with the holder when another live
 * host has it; takes over a dead host's claim. Atomic between processes.
 */
export function claimChat(stateDir: string, chat: string, terminal: string | null): ClaimResult {
  const dir = claimDir(stateDir, chat);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = processStamp(process.pid);
  const claim: Claim = { pid: process.pid, started: stamp === "gone" ? null : stamp, terminal, at: Date.now() };
  const tmp = join(dir, `.${process.pid}.${Date.now().toString(36)}.tmp`);
  writeFileSync(tmp, JSON.stringify(claim) + "\n", { mode: 0o600 });
  try {
    for (;;) {
      const top = generations(dir)[0] ?? 0;
      const holder = top ? live(dir, top) : null;
      if (holder) return { ok: false, holder };
      const gen = top + 1;
      try {
        linkSync(tmp, genPath(dir, gen));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") continue; // another host made it first: read that one
        throw e;
      }
      if ((generations(dir)[0] ?? 0) > gen) {
        try { unlinkSync(genPath(dir, gen)); } catch {}
        continue;
      }
      for (const g of generations(dir)) {
        if (g > gen - KEEP) continue;
        try { unlinkSync(genPath(dir, g)); } catch {}
        try { unlinkSync(releasedPath(dir, g)); } catch {}
      }
      const tookOver = top ? read(dir, top) : null;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        try { writeFileSync(releasedPath(dir, gen), "", { flag: "wx" }); } catch {}
      };
      return { ok: true, claim, tookOver: tookOver && !existsSync(releasedPath(dir, top)) ? tookOver : null, release };
    }
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
}
