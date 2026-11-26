// An agent's stdio server child (`codex app-server`, `agy acp`): JSON-RPC over LF-framed
// JSONL. Spawned in its own process group; correlates our requests, routes the server's
// requests and notifications, keeps a stderr tail, tears down checked.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { LineFramer } from "../framing.ts";
import type { Oversized } from "../framing.ts";
import { AgentError } from "./types.ts";

/**
 * Replies can be large (a long thread's pages, a session's replay); the framer drops lines
 * over this and fails only the request they answered.
 */
export const RPC_MAX_LINE = 64 * 1024 * 1024;

type Rec = Record<string, any>;

export type RequestId = number | string;

export class RpcError extends AgentError {
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

/**
 * `label`: the agent's name in errors ("Codex exited"). `jsonrpc`: every message carries
 * `"jsonrpc": "2.0"` (ACP wants it; Codex's app-server leaves it out).
 */
export type SpawnOptions = { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; label: string; jsonrpc: boolean };

export class JsonRpcProcess {
  child: ChildProcess;
  pid: number | undefined;
  exited = false;
  exitInfo: ExitInfo | null = null;
  private label: string;
  private envelope: Rec;
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
    this.label = opts.label;
    this.envelope = opts.jsonrpc ? { jsonrpc: "2.0" } : {};
    this.child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    this.pid = this.child.pid;
    const framer = new LineFramer(RPC_MAX_LINE);
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
      p.reject(new RpcError(p.method, `${this.label} exited`, null, true));
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
      if (m.error) p.reject(new RpcError(p.method, String(m.error.message ?? `${p.method} failed`), typeof m.error.code === "number" ? m.error.code : null));
      else p.resolve(m.result);
      return;
    }
    this.onBadLine(line);
  }

  private oversized(o: Oversized): void {
    // A response carries its id at the start (`{"id":7,"result":…`, after `"jsonrpc":"2.0",` for ACP): fail only
    // that request. Anchored, so an "id" deep in a notification's params never fails a pending one.
    const m = /^\{(?:"jsonrpc":"2\.0",)?"id":(\d+),"result"/.exec(o.head);
    const id = m ? Number(m[1]) : NaN;
    if (this.pending.has(id)) {
      const p = this.pending.get(id)!;
      this.pending.delete(id);
      if (p.timer) clearTimeout(p.timer);
      p.reject(new RpcError(p.method, `${this.label}'s reply to ${p.method} was too large (${o.size} bytes)`));
      return;
    }
    this.onOversized(o);
  }

  write(msg: Rec): boolean {
    if (this.exited || !this.child.stdin || this.child.stdin.destroyed) return false;
    this.child.stdin.write(JSON.stringify({ ...this.envelope, ...msg }) + "\n");
    return true;
  }

  /** A request with a correlated reply. `timeoutMs: 0` waits forever. */
  request(method: string, params: Rec = {}, timeoutMs = 30_000): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (this.exited) {
        reject(new RpcError(method, `${this.label} is not running`));
        return;
      }
      const p: Pending = { resolve, reject, method };
      if (timeoutMs > 0) {
        p.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new RpcError(method, `${this.label} did not answer ${method} within ${Math.round(timeoutMs / 1000)} s`));
        }, timeoutMs);
      }
      this.pending.set(id, p);
      if (!this.write({ method, id, params })) {
        this.pending.delete(id);
        if (p.timer) clearTimeout(p.timer);
        reject(new RpcError(method, `${this.label} is not running`));
      }
    });
  }

  notify(method: string, params?: Rec): void {
    this.write(params === undefined ? { method } : { method, params });
  }

  /** Answers a server request. */
  respond(id: RequestId, result: unknown): void {
    this.write({ id, result });
  }

  respondError(id: RequestId, code: number, message: string): void {
    this.write({ id, error: { code, message } });
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

  /** Close stdin (the server exits on EOF), then SIGTERM, then SIGKILL the group. */
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
