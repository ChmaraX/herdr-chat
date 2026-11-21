// The chat registry (<stateDir>/chats/<chat>.json) and the session lock
// (<sessionFile>.herdr-chat.lock).
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, renameSync, readFileSync, unlinkSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";

export type RegistryEntry = {
  v: 1;
  chat: string;
  /** The provider (pi, claude, codex); reopening the chat uses the same one. Absent in entries written before v3 (= pi). */
  provider?: string;
  pid: number | null;
  /** JSONL over TCP (the CLI, tests, other hosts). */
  port: number | null;
  /** WebSocket, for the Herdr mod (protocol.md "Transport"). Absent before 0.4: such a host speaks only JSONL. */
  wsPort?: number | null;
  token: string;
  cwd: string;
  sessionFile: string | null;
  terminal: string | null;
  startedAt: number;
  agentVersion: string | null;
  /** The host's herdr-chat version and build (build.ts): the chat asks for a restart when the install's differs. Absent before 0.3. */
  version?: string;
  build?: string;
};

export function registryPath(stateDir: string, chat: string): string {
  return join(stateDir, "chats", `${chat}.json`);
}

export function atomicWrite(path: string, text: string, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
  writeFileSync(tmp, text, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

export function writeRegistry(stateDir: string, entry: RegistryEntry): void {
  atomicWrite(registryPath(stateDir, entry.chat), JSON.stringify(entry, null, 2) + "\n");
}

export function readRegistry(stateDir: string, chat: string): RegistryEntry | null {
  try {
    return JSON.parse(readFileSync(registryPath(stateDir, chat), "utf8"));
  } catch {
    return null;
  }
}

/** `stamp`: the holder's processStamp (absent in locks written before 0.6). */
export type LockInfo = { pid: number; chat: string; terminal: string | null; startedAt: number; stamp?: string | null };

export function lockPath(sessionFile: string): string {
  return `${sessionFile}.herdr-chat.lock`;
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Who `pid` is: its start time as `ps -o lstart` prints it (in UTC, so every caller prints the
 * same; to the second), which a pid reused by another process doesn't share. "gone": no such
 * process. null: `ps` couldn't say (it didn't run).
 */
export function processStamp(pid: number): string | "gone" | null {
  const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 5000, env: { ...process.env, LC_ALL: "C", TZ: "UTC" } });
  if (r.error || r.status === null) return null;
  const out = r.stdout.trim();
  return out || (r.status !== 0 ? "gone" : null);
}

/**
 * Whether the process `pid` that recorded `stamp` (its processStamp then) still runs: the pid is
 * alive and has that start time. No stamp recorded, or `ps` couldn't say: the pid alone decides.
 */
export function processRuns(pid: number, stamp: string | null | undefined): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || !pidAlive(pid)) return false;
  if (!stamp) return true;
  const now = processStamp(pid);
  return now === null || now === stamp;
}

/** Whether `pid` runs `herdr-chat-host serve` for `chat` (its command line); false when `ps` can't say. */
export function servesChat(pid: number, chat: string): boolean {
  const r = spawnSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8", timeout: 5000 });
  const args = r.status === 0 ? r.stdout : "";
  return / serve /.test(args) && ` ${args.trim()} `.includes(` --chat ${chat} `);
}

export function readLock(sessionFile: string): LockInfo | null {
  try {
    return JSON.parse(readFileSync(lockPath(sessionFile), "utf8"));
  } catch {
    return null;
  }
}

/** Takes the lock. Returns the other live holder if there is one (the lock is taken anyway). */
export function takeLock(sessionFile: string, info: LockInfo): LockInfo | null {
  const prev = readLock(sessionFile);
  const other = prev && prev.pid !== info.pid && processRuns(prev.pid, prev.stamp) ? prev : null;
  try {
    atomicWrite(lockPath(sessionFile), JSON.stringify(info) + "\n", 0o644);
  } catch {}
  return other;
}

/** Removes the lock only if this process holds it. */
export function releaseLock(sessionFile: string, pid = process.pid): void {
  const prev = readLock(sessionFile);
  if (prev && prev.pid !== pid) return;
  try {
    unlinkSync(lockPath(sessionFile));
  } catch {}
}
