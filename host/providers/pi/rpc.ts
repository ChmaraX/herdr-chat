// The Pi child process: spawn in its own process group, LF framing with a size
// cap, request correlation, stderr tail, checked teardown.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { LineFramer } from "../../framing.ts";
import type { Oversized } from "../../framing.ts";
import { AgentError } from "../types.ts";

export type { Oversized };

export type PiRecord = Record<string, unknown> & { type?: string };

export type SpawnOptions = {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
};

type Pending = { resolve: (data: unknown) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout; command: string };

export class PiRpcError extends AgentError {
  command: string;
  constructor(command: string, message: string, exited = false) {
    super(message, exited);
    this.command = command;
  }
}

export type ExitInfo = { code: number | null; signal: NodeJS.Signals | null; stderr: string; spawnError?: string };

export class PiProcess {
  child: ChildProcess;
  pid: number | undefined;
  exited = false;
  exitInfo: ExitInfo | null = null;
  private nextId = 0;
  private pending = new Map<string, Pending>();
  private stderrTail = "";
  private exitWaiters: ((e: ExitInfo) => void)[] = [];
  onEvent: (rec: PiRecord) => void = () => {};
  onOversized: (o: Oversized) => void = () => {};
  onExit: (e: ExitInfo) => void = () => {};
  onBadLine: (line: string) => void = () => {};

  constructor(opts: SpawnOptions) {
    this.child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    this.pid = this.child.pid;
    const framer = new LineFramer();
    framer.onLine = (line) => this.route(line);
    framer.onOversized = (o) => this.oversized(o);
    this.child.stdout!.on("data", (d: Buffer) => framer.push(d));
    let stdoutEnded = false;
    let exitArgs: [number | null, NodeJS.Signals | null] | null = null;
    this.child.stdout!.on("end", () => {
      framer.finish();
      stdoutEnded = true;
      if (exitArgs) this.finishExit(exitArgs[0], exitArgs[1], spawnError);
    });
    this.child.stderr!.on("data", (d: Buffer) => {
      this.stderrTail = (this.stderrTail + d.toString("utf8")).slice(-8192);
    });
    this.child.stdin!.on("error", () => {});
    let spawnError: string | undefined;
    this.child.on("error", (e) => {
      spawnError = e.message;
      if (this.pid === undefined) this.finishExit(null, null, spawnError);
    });
    this.child.on("exit", (code, signal) => {
      // Let stdout drain before reporting the exit; a grandchild may hold it open.
      exitArgs = [code, signal];
      if (stdoutEnded) this.finishExit(code, signal, spawnError);
      else setTimeout(() => this.finishExit(code, signal, spawnError), 250);
    });
  }

  private finishExit(code: number | null, signal: NodeJS.Signals | null, spawnError?: string): void {
    if (this.exited) return;
    this.exited = true;
    const info: ExitInfo = { code, signal, stderr: this.stderrTail, ...(spawnError ? { spawnError } : {}) };
    this.exitInfo = info;
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      if (p.timer) clearTimeout(p.timer);
      p.reject(new PiRpcError(p.command, "Pi exited", true));
    }
    this.onExit(info);
    for (const w of this.exitWaiters.splice(0)) w(info);
  }

  get stderr(): string {
    return this.stderrTail;
  }

  private route(line: string): void {
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      this.onBadLine(line);
      return;
    }
    if (!rec || typeof rec !== "object" || Array.isArray(rec)) {
      this.onBadLine(line);
      return;
    }
    const r = rec as PiRecord;
    if (r.type === "response" && typeof r.id === "string" && this.pending.has(r.id)) {
      const p = this.pending.get(r.id)!;
      this.pending.delete(r.id);
      if (p.timer) clearTimeout(p.timer);
      if (r.success === true) p.resolve(r.data);
      else p.reject(new PiRpcError(String(r.command ?? p.command), typeof r.error === "string" ? r.error : `${p.command} failed`));
      return;
    }
    this.onEvent(r);
  }

  private oversized(o: Oversized): void {
    // A response leads with its id: fail only that request.
    const m = /^\{"id":"(h\d+)","type":"response"/.exec(o.head);
    if (m && this.pending.has(m[1]!)) {
      const p = this.pending.get(m[1]!)!;
      this.pending.delete(m[1]!);
      if (p.timer) clearTimeout(p.timer);
      p.reject(new PiRpcError(p.command, `Pi's reply to ${p.command} was too large (${o.size} bytes)`));
      return;
    }
    this.onOversized(o);
  }

  write(rec: Record<string, unknown>): boolean {
    if (this.exited || !this.child.stdin || this.child.stdin.destroyed) return false;
    this.child.stdin.write(JSON.stringify(rec) + "\n");
    return true;
  }

  /** A command with a correlated reply. `timeoutMs: 0` waits forever (prompt, abort, compact). */
  request(type: string, args: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<unknown> {
    const id = `h${++this.nextId}`;
    return new Promise((resolve, reject) => {
      if (this.exited) {
        reject(new PiRpcError(type, "Pi is not running"));
        return;
      }
      const p: Pending = { resolve, reject, command: type };
      if (timeoutMs > 0) {
        p.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new PiRpcError(type, `Pi did not answer ${type} within ${Math.round(timeoutMs / 1000)} s`));
        }, timeoutMs);
      }
      this.pending.set(id, p);
      if (!this.write({ id, type, ...args })) {
        this.pending.delete(id);
        if (p.timer) clearTimeout(p.timer);
        reject(new PiRpcError(type, "Pi is not running"));
      }
    });
  }

  waitExit(): Promise<ExitInfo> {
    if (this.exitInfo) return Promise.resolve(this.exitInfo);
    return new Promise((r) => this.exitWaiters.push(r));
  }

  private groupAlive(): boolean {
    if (this.pid === undefined) return false;
    try {
      process.kill(process.platform === "win32" ? this.pid : -this.pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private signal(sig: NodeJS.Signals): void {
    if (this.pid === undefined) return;
    try {
      process.kill(process.platform === "win32" ? this.pid : -this.pid, sig);
    } catch {}
  }

  /**
   * Orderly stop: close stdin (Pi disposes and exits), then SIGTERM the group,
   * then SIGKILL. Liveness is checked before each signal, since a pid/pgid can
   * be reused once the group is gone.
   */
  async stop(graceMs = 1000): Promise<void> {
    try {
      this.child.stdin?.end();
    } catch {}
    const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const deadline = async (ms: number) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (this.exited && !this.groupAlive()) return true;
        await wait(25);
      }
      return this.exited && !this.groupAlive();
    };
    if (await deadline(graceMs)) return;
    if (this.groupAlive()) this.signal("SIGTERM");
    if (await deadline(1000)) return;
    if (this.groupAlive()) this.signal("SIGKILL");
    await deadline(500);
  }

  /** Synchronous last-resort kill (process exit handlers). */
  killNow(): void {
    if (this.groupAlive()) this.signal("SIGKILL");
  }
}
