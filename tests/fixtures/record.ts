// Records real `pi --mode rpc` sessions as fixtures for fake-pi's replay mode.
//   node tests/fixtures/record.ts [name ...]     (default: all)
// Real Pi, anthropic/claude-haiku-4-5, a temp cwd and --session-dir, short prompts.
// Output: tests/fixtures/<name>.jsonl, lines {"t": ms, "dir": "in"|"out", "rec": {...}}, scrubbed.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir, homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { LineFramer } from "../../host/framing.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PI = process.env.PI_BIN ?? "pi";
const PI_PKG = process.env.PI_PKG ?? join(homedir(), ".local/lib/node_modules/@earendil-works/pi-coding-agent");
const DEMO_EXT = join(PI_PKG, "examples/extensions/rpc-demo.ts");
const MODEL = "anthropic/claude-haiku-4-5";

type Rec = Record<string, any>;
type Line = { t: number; dir: "in" | "out"; rec: Rec };

class Recording {
  lines: Line[] = [];
  t0 = Date.now();
  child;
  private n = 0;
  private listeners = new Set<(r: Rec) => void>();
  stderr = "";
  exited = false;
  cwd: string;
  sessionDir: string;

  constructor(cwd: string, sessionDir: string, extra: string[]) {
    this.cwd = cwd;
    this.sessionDir = sessionDir;
    const args = ["--mode", "rpc", "--model", MODEL, "--thinking", "low", "--session-dir", sessionDir,
      "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-mcp", "--no-themes", "--offline", ...extra];
    this.child = spawn(PI, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PI_CHAT_HOST: "1" } });
    const f = new LineFramer();
    f.onLine = (line) => {
      const rec = JSON.parse(line);
      this.lines.push({ t: Date.now() - this.t0, dir: "out", rec });
      for (const l of [...this.listeners]) l(rec);
    };
    this.child.stdout.on("data", (d: Buffer) => f.push(d));
    this.child.stderr.on("data", (d: Buffer) => (this.stderr += d));
    this.child.on("exit", () => (this.exited = true));
  }

  send(cmd: Rec): string {
    const id = cmd.type === "extension_ui_response" ? cmd.id : `rec-${++this.n}`;
    const rec = cmd.type === "extension_ui_response" ? cmd : { id, ...cmd };
    this.lines.push({ t: Date.now() - this.t0, dir: "in", rec });
    this.child.stdin.write(JSON.stringify(rec) + "\n");
    return id;
  }

  next(pred: (r: Rec) => boolean, timeoutMs = 60_000, what = "record"): Promise<Rec> {
    // Look back first: it may already have arrived.
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(l);
        reject(new Error(`timeout waiting for ${what}; stderr: ${this.stderr.slice(-500)}`));
      }, timeoutMs);
      const l = (r: Rec) => {
        if (pred(r)) {
          clearTimeout(timer);
          this.listeners.delete(l);
          resolve(r);
        }
      };
      this.listeners.add(l);
    });
  }

  async request(cmd: Rec, timeoutMs = 60_000): Promise<Rec> {
    const p = new Promise<Rec>((resolve, reject) => {
      const id = `rec-${this.n + 1}`;
      this.next((r) => r.type === "response" && r.id === id, timeoutMs, `${cmd.type} response`).then(resolve, reject);
    });
    this.send(cmd);
    return p;
  }

  settled(timeoutMs = 90_000): Promise<Rec> {
    return this.next((r) => r.type === "agent_settled", timeoutMs, "agent_settled");
  }

  async startup(): Promise<Rec> {
    const st = await this.request({ type: "get_state" });
    await this.request({ type: "get_commands" });
    await this.request({ type: "get_session_stats" });
    await this.request({ type: "get_available_models" });
    await this.request({ type: "get_messages" });
    return st.data;
  }

  async close(): Promise<void> {
    this.child.stdin.end();
    for (let i = 0; i < 100 && !this.exited; i++) await new Promise((r) => setTimeout(r, 50));
    if (!this.exited) this.child.kill("SIGKILL");
  }
}

function makeCwd(): { root: string; cwd: string; sessions: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-fixture-")));
  const cwd = join(root, "cwd");
  const sessions = join(root, "sessions");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(cwd, "src"), { recursive: true });
  writeFileSync(join(cwd, "README.md"), "# Fixture project\n\nA tiny project for recording Pi.\n");
  writeFileSync(join(cwd, "notes.txt"), "I like apple pie.\n");
  writeFileSync(join(cwd, "src", "a.ts"), "export const a = 1; // TODO\n");
  return { root, cwd, sessions };
}

function scrub(lines: Line[], root: string): Line[] {
  const home = homedir();
  const s = (v: string) => v.split(root).join("/tmp/pi-fixture").split(home).join("/home/user");
  const walk = (v: any, key?: string): any => {
    if (typeof v === "string") {
      if (key && /Signature$/.test(key)) return "sig";
      return s(v);
    }
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === "object") {
      if (v.role === "system") {
        // Keep the shape, drop the prompt bulk.
        return { role: "system", content: "", sections: { preamble: "(system prompt omitted)" }, toolsAdded: (v.toolsAdded ?? []).map((t: any) => ({ name: t.name })), timestamp: v.timestamp };
      }
      const out: any = {};
      for (const [k, x] of Object.entries(v)) out[k] = walk(x, k);
      return out;
    }
    return v;
  };
  return lines.map((l) => {
    let rec = walk(l.rec);
    if (rec.type === "response" && rec.command === "get_available_models" && Array.isArray(rec.data?.models)) {
      rec = { ...rec, data: { models: rec.data.models.filter((m: any) => m.provider === "anthropic").slice(0, 4) } };
    }
    return { t: l.t, dir: l.dir, rec };
  });
}

function save(name: string, r: Recording, root: string): void {
  const path = join(HERE, `${name}.jsonl`);
  writeFileSync(path, scrub(r.lines, root).map((l) => JSON.stringify(l)).join("\n") + "\n");
  console.log(`wrote ${path} (${r.lines.length} records)`);
}

const SCENARIOS: Record<string, () => Promise<void>> = {
  async "text-only"() {
    const { root, cwd, sessions } = makeCwd();
    const r = new Recording(cwd, sessions, []);
    await r.startup();
    r.send({ type: "prompt", message: "Reply with exactly: hello from pi" });
    await r.settled();
    await r.request({ type: "get_session_stats" });
    await r.close();
    save("text-only", r, root);
    rmSync(root, { recursive: true, force: true });
  },
  async "bash-read"() {
    const { root, cwd, sessions } = makeCwd();
    const r = new Recording(cwd, sessions, []);
    await r.startup();
    r.send({ type: "prompt", message: "Use the bash tool to run `ls`, then use the read tool on README.md, then reply with just the word done." });
    await r.settled();
    await r.request({ type: "get_session_stats" });
    await r.close();
    save("bash-read", r, root);
    rmSync(root, { recursive: true, force: true });
  },
  async edit() {
    const { root, cwd, sessions } = makeCwd();
    const r = new Recording(cwd, sessions, []);
    await r.startup();
    r.send({ type: "prompt", message: "Use the edit tool on notes.txt to replace the word apple with banana. Do not read it first. Then reply with just the word done." });
    await r.settled();
    await r.close();
    save("edit", r, root);
    rmSync(root, { recursive: true, force: true });
  },
  async steer() {
    const { root, cwd, sessions } = makeCwd();
    const r = new Recording(cwd, sessions, []);
    await r.startup();
    const started = r.next((x) => x.type === "tool_execution_start", 60_000, "tool start");
    r.send({ type: "prompt", message: "Use the bash tool to run `sleep 3 && echo slept`, then reply with its output." });
    await started;
    await new Promise((res) => setTimeout(res, 500));
    r.send({ type: "prompt", message: "Also end your reply with the word steered.", streamingBehavior: "steer" });
    await r.settled();
    await r.close();
    save("steer", r, root);
    rmSync(root, { recursive: true, force: true });
  },
  async abort() {
    const { root, cwd, sessions } = makeCwd();
    const r = new Recording(cwd, sessions, []);
    await r.startup();
    const started = r.next((x) => x.type === "tool_execution_start", 60_000, "tool start");
    r.send({ type: "prompt", message: "Use the bash tool to run `for i in 1 2 3 4 5 6 7 8 9 10; do echo tick $i; sleep 1; done`." });
    await started;
    await new Promise((res) => setTimeout(res, 1500));
    r.send({ type: "prompt", message: "Then say hi.", streamingBehavior: "followUp" });
    await new Promise((res) => setTimeout(res, 200));
    await r.request({ type: "clear_queue" });
    const settled = r.settled();
    await r.request({ type: "abort" });
    await settled;
    await r.request({ type: "get_state" });
    await r.close();
    save("abort", r, root);
    rmSync(root, { recursive: true, force: true });
  },
  async dialog() {
    const { root, cwd, sessions } = makeCwd();
    mkdirSync(join(cwd, "tmpdir"));
    const r = new Recording(cwd, sessions, ["--extension", DEMO_EXT]);
    await r.startup();
    // An extension command opening an input dialog outside a run.
    const input = r.next((x) => x.type === "extension_ui_request" && x.method === "input", 30_000, "input dialog");
    const reply = r.next((x) => x.type === "response" && x.command === "prompt", 30_000, "prompt reply");
    r.send({ type: "prompt", message: "/rpc-input" });
    const d = await input;
    await new Promise((res) => setTimeout(res, 300));
    r.send({ type: "extension_ui_response", id: d.id, value: "Ada" });
    await reply;
    // A select from a tool_call hook: the dangerous-command prompt.
    const sel = r.next((x) => x.type === "extension_ui_request" && x.method === "select", 60_000, "select dialog");
    r.send({ type: "prompt", message: "Use the bash tool to run exactly `rm -rf ./tmpdir`. If it is blocked, reply with just the word blocked." });
    const s = await sel;
    await new Promise((res) => setTimeout(res, 300));
    r.send({ type: "extension_ui_response", id: s.id, value: "Block" });
    await r.settled();
    await r.close();
    save("dialog", r, root);
    rmSync(root, { recursive: true, force: true });
  },
  async resume() {
    const { root, cwd, sessions } = makeCwd();
    const first = new Recording(cwd, sessions, []);
    const st = await first.startup();
    first.send({ type: "prompt", message: "Use the bash tool to run `echo kiwi`, then reply with just the word ok." });
    await first.settled();
    await first.close();
    const file = st.sessionFile;
    const r = new Recording(cwd, sessions, ["--session", file]);
    await r.startup();
    r.send({ type: "prompt", message: "What word did the command print? Reply with just that word." });
    await r.settled();
    await r.close();
    save("resume", r, root);
    rmSync(root, { recursive: true, force: true });
  },
};

const wanted = process.argv.slice(2);
for (const name of wanted.length ? wanted : Object.keys(SCENARIOS)) {
  const fn = SCENARIOS[name];
  if (!fn) throw new Error(`unknown fixture ${name}`);
  console.log(`recording ${name}…`);
  await fn();
}
