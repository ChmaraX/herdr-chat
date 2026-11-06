// The `claude -p` stream-json child: its own process group, LF framing with
// the 8 MiB cap, outbound control requests correlated by request_id, a 4 KiB
// stderr tail (always drained), and a checked teardown of the whole tree.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { LineFramer } from "../../framing.ts";
import type { Oversized } from "../../framing.ts";
import { AgentError } from "../types.ts";

export type ClaudeRecord = Record<string, any> & { type?: string };
export type ExitInfo = { code: number | null; signal: NodeJS.Signals | null; stderr: string; spawnError?: string };

type Pending = { resolve: (data: any) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout; subtype: string };

export class ClaudeProcess {
  child: ChildProcess;
  pid: number | undefined;
  exited = false;
  exitInfo: ExitInfo | null = null;
  private nextId = 0;
  private pending = new Map<string, Pending>();
  private stderrTail = "";
  private exitWaiters: ((e: ExitInfo) => void)[] = [];
  onRecord: (rec: ClaudeRecord) => void = () => {};
  onOversized: (o: Oversized) => void = () => {};
  onExit: (e: ExitInfo) => void = () => {};
  onBadLine: (line: string) => void = () => {};

  constructor(opts: { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }) {
    this.child = spawn(opts.command, opts.args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
    this.pid = this.child.pid;
    const framer = new LineFramer();
    framer.onLine = (line) => this.route(line);
    framer.onOversized = (o) => this.onOversized(o);
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
      this.stderrTail = (this.stderrTail + d.toString("utf8")).slice(-4096);
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

  private finishExit(code: number | null, signal: NodeJS.Signals | null, spawnError?: string): void {
    if (this.exited) return;
    this.exited = true;
    const info: ExitInfo = { code, signal, stderr: this.stderrTail, ...(spawnError ? { spawnError } : {}) };
    this.exitInfo = info;
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      if (p.timer) clearTimeout(p.timer);
      p.reject(new AgentError("Claude Code exited", true));
    }
    this.onExit(info);
    for (const w of this.exitWaiters.splice(0)) w(info);
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
    const r = rec as ClaudeRecord;
    if (r.type === "control_response") {
      const resp = r.response ?? {};
      const p = typeof resp.request_id === "string" ? this.pending.get(resp.request_id) : undefined;
      if (p) {
        this.pending.delete(resp.request_id);
        if (p.timer) clearTimeout(p.timer);
        if (resp.subtype === "success") p.resolve(resp.response ?? {});
        else p.reject(new AgentError(typeof resp.error === "string" ? resp.error : `${p.subtype} failed`));
      }
      // Our own answers to can_use_tool come back as echoes: nothing to do. Still counts as activity.
    }
    this.onRecord(r);
  }

  write(rec: Record<string, unknown>): boolean {
    if (this.exited || !this.child.stdin || this.child.stdin.destroyed) return false;
    this.child.stdin.write(JSON.stringify(rec) + "\n");
    return true;
  }

  /** An outbound control request. `timeoutMs: 0` waits until the process exits. */
  control(request: Record<string, unknown> & { subtype: string }, timeoutMs = 30_000): Promise<any> {
    const id = `r${++this.nextId}`;
    return new Promise((resolve, reject) => {
      if (this.exited) {
        reject(new AgentError("Claude Code is not running", true));
        return;
      }
      const p: Pending = { resolve, reject, subtype: request.subtype };
      if (timeoutMs > 0) {
        p.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new AgentError(`Claude Code did not answer ${request.subtype} within ${Math.round(timeoutMs / 1000)} s`));
        }, timeoutMs);
      }
      this.pending.set(id, p);
      if (!this.write({ type: "control_request", request_id: id, request })) {
        this.pending.delete(id);
        if (p.timer) clearTimeout(p.timer);
        reject(new AgentError("Claude Code is not running", true));
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
