// The chat registry (<stateDir>/chats/<chat>.json) and the session lock
// (<sessionFile>.herdr-chat.lock).
import { mkdirSync, writeFileSync, renameSync, readFileSync, unlinkSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";

export type RegistryEntry = {
  v: 1;
  chat: string;
  /** The provider (pi, claude, codex); reopening the chat uses the same one. Absent in entries written before v3 (= pi). */
  provider?: string;
  pid: number | null;
  port: number | null;
  token: string;
  cwd: string;
  sessionFile: string | null;
  terminal: string | null;
  startedAt: number;
  agentVersion: string | null;
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

export type LockInfo = { pid: number; chat: string; terminal: string | null; startedAt: number };

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
  const other = prev && prev.pid !== info.pid && pidAlive(prev.pid) ? prev : null;
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
