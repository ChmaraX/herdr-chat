// Test harness: the real host process, a real TCP client, fake-pi or real Pi.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { ChatClient } from "../../host/client.ts";
import { readRegistry } from "../../host/registry.ts";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const FAKE_PI = join(ROOT, "tests", "fake-pi", "fake-pi.mjs");
export const SCENARIOS = join(ROOT, "tests", "fake-pi", "scenarios");
export const FIXTURES = join(ROOT, "tests", "fixtures");
export const ARTIFACTS = join(ROOT, "tests", "artifacts", "host");
/**
 * The host under test: host/main.ts on this Node, or a built one (npm run test:built:
 * HERDR_CHAT_TEST_HOST=<release>/host/main.js, HERDR_CHAT_TEST_NODE=<an older node>).
 */
export const HOST_ENTRY = process.env.HERDR_CHAT_TEST_HOST ? resolve(process.env.HERDR_CHAT_TEST_HOST) : join(ROOT, "host", "main.ts");
export const HOST_NODE = process.env.HERDR_CHAT_TEST_NODE || process.execPath;
/** Herdr's hook variables, as a host started from a Herdr pane has them (Host.start drops the runner's own). */
export const HERDR_HOOK_ENV = { HERDR_PANE_ID: "p-test", HERDR_SOCKET_PATH: "/tmp/herdr-test.sock", HERDR_ENV: "1" };

export type HostOptions = {
  name: string;
  scenario?: string | object; // file name in scenarios/ or an inline object
  replay?: string; // fixture file name
  speed?: number;
  session?: string;
  piArgs?: string[];
  pi?: string;
  env?: Record<string, string>;
  dir?: string; // reuse a temp dir (restart on the same state)
  cwd?: string;
  chat?: string;
  /** Another provider than pi: `--provider <p> --<p> <agent>`. */
  provider?: string;
  agent?: string;
  /** More serve flags, before `--` (e.g. --after-pid). */
  hostArgs?: string[];
};

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Strips OSC/CSI from the host's screen output. */
export function plain(screen: string): string {
  return screen.replace(/\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)/g, "").replace(/\u001b\[[0-9;?]*[A-Za-z~]/g, "").replace(/\r/g, "");
}

export class Host {
  opts: HostOptions;
  dir: string;
  cwd: string;
  stateDir: string;
  chat: string;
  proc!: ChildProcess;
  screen = "";
  piLog: string;
  clients: ChatClient[] = [];
  client!: ChatClient;
  exitCode: number | null = null;
  exited: Promise<number | null>;
  private exitResolve!: (c: number | null) => void;

  constructor(opts: HostOptions) {
    this.opts = opts;
    this.dir = opts.dir ?? realpathSync(mkdtempSync(join(tmpdir(), `pich-${opts.name}-`)));
    this.cwd = opts.cwd ?? join(this.dir, "cwd");
    this.stateDir = join(this.dir, "state");
    this.chat = opts.chat ?? "c-test";
    this.piLog = join(this.dir, "pi-commands.jsonl");
    mkdirSync(this.cwd, { recursive: true });
    this.exited = new Promise((r) => (this.exitResolve = r));
  }

  async start(): Promise<this> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("HC_") && !k.startsWith("HERDR_")) env[k] = v;
    env.FAKE_PI_LOG = this.piLog;
    env.FAKE_PI_SPEED = String(this.opts.speed ?? 4);
    if (this.opts.scenario) {
      let path: string;
      if (typeof this.opts.scenario === "string") path = join(SCENARIOS, this.opts.scenario);
      else {
        path = join(this.dir, "scenario.json");
        writeFileSync(path, JSON.stringify(this.opts.scenario));
      }
      env.FAKE_PI_SCENARIO = path;
    }
    if (this.opts.replay) env.FAKE_PI_REPLAY = join(FIXTURES, this.opts.replay);
    Object.assign(env, this.opts.env ?? {});
    const p = this.opts.provider;
    const agent = p ? ["--provider", p, `--${p}`, this.opts.agent ?? p] : ["--pi", this.opts.pi ?? FAKE_PI];
    const args = [HOST_ENTRY, "serve", "--chat", this.chat, "--cwd", this.cwd, "--state-dir", this.stateDir, ...agent];
    if (this.opts.session) args.push("--session", this.opts.session);
    if (this.opts.hostArgs) args.push(...this.opts.hostArgs);
    const piArgs = this.opts.piArgs ?? (p ? [] : ["--session-dir", join(this.dir, "sessions")]);
    if (piArgs.length) args.push("--", ...piArgs);
    this.proc = spawn(HOST_NODE, args, { cwd: this.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stdout!.on("data", (d) => (this.screen += d.toString("utf8")));
    this.proc.stderr!.on("data", (d) => (this.screen += d.toString("utf8")));
    this.proc.on("exit", (code) => {
      this.exitCode = code;
      this.exitResolve(code);
    });
    // Wait for the registry with a port.
    const t0 = Date.now();
    for (;;) {
      const reg = readRegistry(this.stateDir, this.chat);
      if (reg?.port && reg.pid === this.proc.pid) break;
      if (this.exitCode !== null) throw new Error(`host exited early: ${this.screen}`);
      if (Date.now() - t0 > 10_000) throw new Error(`host did not register: ${this.screen}`);
      await sleep(20);
    }
    this.client = await this.connect();
    return this;
  }

  async connect(kind = "test"): Promise<ChatClient> {
    const reg = readRegistry(this.stateDir, this.chat)!;
    const c = await ChatClient.connect(reg.port!, reg.token, kind);
    this.clients.push(c);
    return c;
  }

  get registry() {
    return readRegistry(this.stateDir, this.chat);
  }

  get transcript(): string {
    return plain(this.screen);
  }

  /** OSC 7501 states the host reported, in order. */
  get statuses(): string[] {
    return [...this.screen.matchAll(/\u001b\]7501;state=(\w+):app=\w+(?::msg=([A-Za-z0-9+/=]*))?\u001b\\/g)].map((m) => (m[2] ? `${m[1]}(${Buffer.from(m[2], "base64").toString("utf8")})` : m[1]!));
  }

  /** OSC 0 titles the host set, in order. */
  get titles(): string[] {
    return [...this.screen.matchAll(/\u001b\]0;([^\u0007]*)\u0007/g)].map((m) => m[1]!);
  }

  async waitTitle(want: string, timeoutMs = 5000): Promise<void> {
    const t0 = Date.now();
    while (this.titles.at(-1) !== want) {
      if (Date.now() - t0 > timeoutMs) throw new Error(`title ${JSON.stringify(this.titles.at(-1))} never became ${JSON.stringify(want)}`);
      await sleep(20);
    }
  }

  /** Commands the host sent to fake-pi. */
  piCommands(): any[] {
    if (!existsSync(this.piLog)) return [];
    return readFileSync(this.piLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }

  /** Waits until the transcript matches (stdout can trail the TCP stream). */
  async waitTranscript(re: RegExp, timeoutMs = 5000): Promise<void> {
    const t0 = Date.now();
    while (!re.test(this.transcript)) {
      if (Date.now() - t0 > timeoutMs) throw new Error(`transcript never matched ${re}:\n${this.transcript}`);
      await sleep(20);
    }
  }

  /** Waits until the last OSC 7501 state reported matches. */
  async waitStatus(re: RegExp, timeoutMs = 5000): Promise<void> {
    const t0 = Date.now();
    while (!re.test(this.statuses.at(-1) ?? "")) {
      if (Date.now() - t0 > timeoutMs) throw new Error(`status ${this.statuses.at(-1)} never matched ${re}`);
      await sleep(20);
    }
  }

  writeStdin(text: string): void {
    this.proc.stdin!.write(text);
  }

  items(kind?: string): any[] {
    return kind ? this.client.items.filter((i) => i.kind === kind) : this.client.items;
  }

  /** Writes the run's artifact (final snapshot, transcript, statuses, commands), then checks every client saw `seq` without gaps. */
  artifact(test: string, extra: Record<string, unknown> = {}): string {
    mkdirSync(ARTIFACTS, { recursive: true });
    const path = join(ARTIFACTS, `${test}.json`);
    writeFileSync(
      path,
      JSON.stringify(
        {
          test,
          state: this.client?.state,
          items: this.client?.items,
          hasOlder: this.client?.hasOlder,
          transcript: this.transcript.split("\n"),
          osc: this.statuses,
          piCommands: this.piCommands().map((c) => c.type),
          records: this.client?.records.length,
          seqErrors: this.client?.seqErrors,
          ...extra,
        },
        null,
        2,
      ),
    );
    for (const c of this.clients) assert.deepEqual(c.seqErrors, [], `${test}: seq continuity`);
    return path;
  }

  async stop(): Promise<void> {
    for (const c of this.clients) if (!c.closed) c.close();
    if (this.exitCode === null) {
      this.proc.kill("SIGTERM");
      await Promise.race([this.exited, sleep(5000)]);
      if (this.exitCode === null) this.proc.kill("SIGKILL");
    }
  }
}

export async function startHost(opts: HostOptions): Promise<Host> {
  return new Host(opts).start();
}

export const idle = (c: ChatClient) => c.state.phase === "idle";
