// The `agy acp` child: JSON-RPC 2.0 over LF-framed JSONL on stdio.
// Spawned in its own process group; correlates our requests, routes the
// server's requests (e.g. session/request_permission) and notifications
// (session/update), keeps a stderr tail, and tears down the whole group cleanly.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { LineFramer } from "../../framing.ts";
import type { Oversized } from "../../framing.ts";
import { AgentError } from "../types.ts";

/** ACP session/load replays or tool outputs can be large; cap lines at 64 MiB. */
export const AGY_MAX_LINE = 64 * 1024 * 1024;

type Rec = Record<string, any>;

export type RequestId = number | string;

export class AgyRpcError extends AgentError {
  method: string;
  code: number | null;
  constructor(method: string, message: string, code: number | null = null, exited = false) {
    super(message, exited);
    this.method = method;
    this.code = code;
  }
}

export type ExitInfo = { code: number | null; signal: NodeJS.Signals | null; stderr: string; spawnError?: string };

type Pending = { resolve: (data: any) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout; method: string };

export type SpawnOptions = { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv };

export class AgyProcess {
  child: ChildProcess;
  pid: number | undefined;
  exited = false;
  exitInfo: ExitInfo | null = null;
  private nextId = 1;
  private pending = new Map<RequestId, Pending>();
  private stderrTail = "";
  private stderrLine = "";
  private exitWaiters: ((e: ExitInfo) => void)[] = [];
  onNotification: (method: string, params: Rec) => void = () => {};
  onServerRequest: (id: RequestId, method: string, params: Rec) => void = () => {};
  onStderrLine: (line: string) => void = () => {};
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
    const framer = new LineFramer(AGY_MAX_LINE);
    framer.onLine = (line) => this.route(line);
    framer.onOversized = (o) => this.oversized(o);
    this.child.stdout!.on("data", (d: Buffer) => framer.push(d));
    let stdoutEnded = false;
    let exitArgs: [number | null, NodeJS.Signals | null] | null = null;
    let spawnError: string | undefined;
    this.child.stdout!.on("end", () => {
      framer.finish();
      stdoutEnded = true;
      if (exitArgs) this.finishExit(exitArgs[0], exitArgs[1], spawnError);
    });
    this.child.stderr!.on("data", (d: Buffer) => {
      const s = d.toString("utf8");
      this.stderrTail = (this.stderrTail + s).slice(-8192);
      this.stderrLine += s;
      let i: number;
      while ((i = this.stderrLine.indexOf("\n")) >= 0) {
        const line = this.stderrLine.slice(0, i);
        this.stderrLine = this.stderrLine.slice(i + 1);
        if (line.trim()) this.onStderrLine(line);
      }
      if (this.stderrLine.length > 65536) this.stderrLine = this.stderrLine.slice(-65536);
    });
    this.child.stdin!.on("error", () => {});
    this.child.on("error", (e) => {
      spawnError = e.message;
      if (this.pid === undefined) this.finishExit(null, null, spawnError);
    });
    this.child.on("exit", (code, signal) => {
      exitArgs = [code, signal];
      if (stdoutEnded) this.finishExit(code, signal, spawnError);
      else setTimeout(() => this.finishExit(code, signal, spawnError), 250);
    });
  }

  get stderr(): string {
    return this.stderrTail;
  }

  private finishExit(code: number | null, signal: NodeJS.Signals | null, spawnError?: string): void {
    if (this.exited) return;
    this.exited = true;
    const info: ExitInfo = { code, signal, stderr: this.stderrTail, ...(spawnError ? { spawnError } : {}) };
    this.exitInfo = info;
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      if (p.timer) clearTimeout(p.timer);
      p.reject(new AgyRpcError(p.method, "Antigravity exited", null, true));
    }
    this.onExit(info);
    for (const w of this.exitWaiters.splice(0)) w(info);
  }

  private route(line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      this.onBadLine(line);
      return;
    }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
      this.onBadLine(line);
      return;
    }
    const m = msg as Rec;
    if (typeof m.method === "string") {
      if (m.id !== undefined && m.id !== null) this.onServerRequest(m.id, m.method, m.params ?? {});
      else this.onNotification(m.method, m.params ?? {});
      return;
    }
    if (m.id !== undefined && this.pending.has(m.id)) {
      const p = this.pending.get(m.id)!;
      this.pending.delete(m.id);
      if (p.timer) clearTimeout(p.timer);
      if (m.error) p.reject(new AgyRpcError(p.method, String(m.error.message ?? `${p.method} failed`), typeof m.error.code === "number" ? m.error.code : null));
      else p.resolve(m.result);
      return;
    }
    this.onBadLine(line);
  }

  private oversized(o: Oversized): void {
    const m = /"id"\s*:\s*(\d+)/.exec(o.head);
    const id = m ? Number(m[1]) : NaN;
    if (this.pending.has(id)) {
      const p = this.pending.get(id)!;
      this.pending.delete(id);
      if (p.timer) clearTimeout(p.timer);
      p.reject(new AgyRpcError(p.method, `Antigravity's reply to ${p.method} was too large (${o.size} bytes)`));
      return;
    }
    this.onOversized(o);
  }

  write(msg: Rec): boolean {
    if (this.exited || !this.child.stdin || this.child.stdin.destroyed) return false;
    this.child.stdin.write(JSON.stringify(msg) + "\n");
    return true;
  }

  /** JSON-RPC 2.0 request. `timeoutMs: 0` waits until the process exits (e.g. session/prompt). */
  request<T = any>(method: string, params?: Rec, timeoutMs = 30_000): Promise<T> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (this.exited) {
        reject(new AgyRpcError(method, "Antigravity is not running", null, true));
        return;
      }
      const p: Pending = { resolve, reject, method };
      if (timeoutMs > 0) {
        p.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new AgyRpcError(method, `Antigravity did not answer ${method} within ${Math.round(timeoutMs / 1000)} s`));
        }, timeoutMs);
      }
      this.pending.set(id, p);
      if (!this.write({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) })) {
        this.pending.delete(id);
        if (p.timer) clearTimeout(p.timer);
        reject(new AgyRpcError(method, "Antigravity is not running", null, true));
      }
    });
  }

  notify(method: string, params?: Rec): boolean {
    return this.write({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) });
  }

  respond(id: RequestId, result: unknown): boolean {
    return this.write({ jsonrpc: "2.0", id, result });
  }

  respondError(id: RequestId, code: number, message: string): boolean {
    return this.write({ jsonrpc: "2.0", id, error: { code, message } });
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

  /** Close stdin, then SIGTERM the group, then SIGKILL; liveness is checked before each signal. */
  async stop(graceMs = 1500): Promise<void> {
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

  killNow(): void {
    if (this.groupAlive()) this.signal("SIGKILL");
  }
}
