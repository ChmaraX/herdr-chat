// Records real `codex app-server` sessions as fixtures (the research samples' format).
//   node tests/fixtures/codex/record.mjs [name ...]     (default: all)
// Real Codex, the cheapest model (gpt-5.6-luna, effort low), a temp cwd, the user's login.
// Run it under `hc exec` (Codex's code-mode host may not start from an agent's shell).
// Output: tests/fixtures/codex/<name>.jsonl, lines {"t", "dir": "out"|"in"|"stderr"|"mark", "msg"}, scrubbed.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, realpathSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir, homedir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CODEX = process.env.CODEX_BIN ?? "codex";
const MODEL = "gpt-5.6-luna";

/** A one-tool MCP server (stdio, newline JSON-RPC): `echo {text}` → the text back. */
const MCP_SERVER = `
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
    if (m.method === "initialize") reply({ protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "echo", version: "1.0.0" } });
    else if (m.method === "tools/list") reply({ tools: [{ name: "echo", description: "Echo the text back", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, annotations: { readOnlyHint: true } }] });
    else if (m.method === "tools/call") reply({ content: [{ type: "text", text: "echo: " + (m.params.arguments?.text ?? "") }], isError: false });
    else if (m.id !== undefined) reply({});
  }
});
`;

class Rec {
  constructor(cwd, extraArgs = []) {
    this.lines = [];
    this.t0 = Date.now();
    this.n = 0;
    this.pending = new Map();
    this.listeners = new Set();
    this.cwd = cwd;
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith("HERDR_")) delete env[k];
    this.child = spawn(CODEX, ["-c", "notify=[]", ...extraArgs, "app-server"], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let buf = Buffer.alloc(0);
    this.child.stdout.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      let i;
      while ((i = buf.indexOf(10)) >= 0) {
        const line = buf.subarray(0, i).toString("utf8");
        buf = buf.subarray(i + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        this.push("in", msg);
        if (msg.id !== undefined && msg.method === undefined && this.pending.has(msg.id)) {
          this.pending.get(msg.id)(msg);
          this.pending.delete(msg.id);
        }
        for (const l of [...this.listeners]) l(msg);
      }
    });
    this.child.stderr.on("data", (d) => this.push("stderr", d.toString("utf8")));
  }
  push(dir, msg) {
    this.lines.push({ t: Date.now(), dir, msg });
  }
  mark(m) {
    this.push("mark", m);
  }
  write(msg) {
    this.push("out", msg);
    this.child.stdin.write(JSON.stringify(msg) + "\n");
  }
  request(method, params) {
    const id = this.n++;
    return new Promise((res) => {
      this.pending.set(id, res);
      this.write({ method, id, params });
    });
  }
  notify(method, params) {
    this.write(params === undefined ? { method } : { method, params });
  }
  respond(id, result) {
    this.write({ id, result });
  }
  /** Resolves with the first message matching `pred`. */
  until(pred, ms = 180_000) {
    return new Promise((res, rej) => {
      const t = setTimeout(() => {
        this.listeners.delete(l);
        rej(new Error("timeout"));
      }, ms);
      const l = (m) => {
        if (pred(m)) {
          clearTimeout(t);
          this.listeners.delete(l);
          res(m);
        }
      };
      this.listeners.add(l);
    });
  }
  /** Answers every server request with `answer(msg)` (undefined = leave it). */
  autoAnswer(answer) {
    this.listeners.add((m) => {
      if (m.method && m.id !== undefined) {
        const r = answer(m);
        if (r !== undefined) setTimeout(() => this.respond(m.id, r), 300);
      }
    });
  }
  async init() {
    this.mark("initialize");
    await this.request("initialize", { clientInfo: { name: "herdr_chat", title: "herdr-chat recorder", version: "0.1.0" }, capabilities: { experimentalApi: true } });
    this.notify("initialized");
  }
  async thread(params = {}) {
    this.mark("thread/start");
    const r = await this.request("thread/start", { cwd: this.cwd, model: MODEL, approvalPolicy: "never", sandbox: "workspace-write", ephemeral: true, ...params });
    this.threadId = r.result.thread.id;
    return r.result;
  }
  async turn(text, params = {}) {
    this.mark(`turn: ${text.slice(0, 60)}`);
    const done = this.until((m) => m.method === "turn/completed" && m.params.threadId === this.threadId);
    await this.request("turn/start", { threadId: this.threadId, input: [{ type: "text", text, text_elements: [] }], effort: "low", summary: "auto", ...params });
    return done;
  }
  async close() {
    this.child.stdin.end();
    await new Promise((r) => {
      const t = setTimeout(() => {
        this.child.kill("SIGKILL");
        r();
      }, 5000);
      this.child.on("exit", () => {
        clearTimeout(t);
        r();
      });
    });
  }
}

function scrub(text, cwd) {
  const home = homedir();
  return text
    .split(cwd).join("/tmp/codex-fixture")
    .split(realpathSync(tmpdir())).join("/tmp")
    .split(home).join("~")
    .replace(/"email":"[^"]*"/g, '"email":"<email>"')
    .replace(/"chatgptAccountId":"[^"]*"/g, '"chatgptAccountId":"<account-id>"')
    .replace(/"installationId":"[^"]*"/g, '"installationId":"<installation-id>"')
    .replace(/"serverName":"[^"]*\.local"/g, '"serverName":"host.local"')
    .replace(/"metadata":"[^"]*"/g, '"metadata":"<trimmed>"');
}

/** Drops the noise (MCP startup, hooks, rate limits) beyond the first few, keeps everything else. */
function save(name, rec, note) {
  let mcp = 0;
  const keep = rec.lines.filter((l) => {
    const m = l.msg?.method;
    if (m === "mcpServer/startupStatus/updated" && ++mcp > 2) return false;
    return true;
  });
  const out = [JSON.stringify({ dir: "note", msg: note })];
  for (const l of keep) out.push(JSON.stringify({ t: l.t - rec.t0, dir: l.dir, msg: l.msg }));
  writeFileSync(join(HERE, `${name}.jsonl`), scrub(out.join("\n") + "\n", rec.cwd));
  console.log(`wrote ${name}.jsonl (${out.length} lines)`);
}

const RECORDINGS = {
  /** An MCP tool call through a one-tool MCP server. */
  async "mcp-tool"(cwd) {
    const server = join(cwd, "..", "echo-mcp.mjs");
    writeFileSync(server, MCP_SERVER);
    const r = new Rec(cwd, ["-c", `mcp_servers.echo.command="node"`, "-c", `mcp_servers.echo.args=["${server}"]`]);
    r.autoAnswer((m) => (m.method === "mcpServer/elicitation/request" ? { action: "accept", content: null, _meta: null } : m.method.endsWith("requestApproval") ? { decision: "accept" } : undefined));
    await r.init();
    await r.thread();
    await r.turn("Call the MCP tool `echo` (server `echo`) with text 'ping'. Then reply with exactly what it returned.");
    await r.close();
    return [r, "An MCP tool call (`echo` server, one tool) under approvalPolicy never: mcpToolCall item started/completed with result.content."];
  },
  /** A subagent: collabAgentToolCall spawn + wait. */
  async subagent(cwd) {
    const r = new Rec(cwd);
    await r.init();
    await r.thread();
    await r.turn("Use your spawn_agent tool to spawn exactly one subagent with the task: 'Reply with the digit 4 only.' Then wait for it and report its answer in one line. Do not read any skills or files first.");
    await r.close();
    return [r, "A subagent via the collab tools: collabAgentToolCall items (spawnAgent, wait), the child thread's events."];
  },
  /** Plan mode: a question (requestUserInput) and a plan item. */
  async "plan-mode"(cwd) {
    const r = new Rec(cwd);
    r.autoAnswer((m) => {
      if (m.method === "item/tool/requestUserInput") {
        const answers = {};
        for (const q of m.params.questions) answers[q.id] = { answers: [q.options?.[0]?.label ?? "yes"] };
        return { answers };
      }
      if (m.method.endsWith("requestApproval")) return { decision: "accept" };
      return undefined;
    });
    await r.init();
    const modes = await r.request("collaborationMode/list", {});
    void modes;
    await r.thread();
    await r.turn("I want a tiny shell script that greets someone. Before planning, ask me exactly one multiple-choice question (with your request_user_input tool) about which greeting word to use. Then propose a short plan.", {
      collaborationMode: { mode: "plan", settings: { model: MODEL, reasoning_effort: "low", developer_instructions: null } },
    });
    await r.close();
    return [r, "Plan collaboration mode: item/tool/requestUserInput (answered with the first option), then a plan item with item/plan/delta."];
  },
};

const names = process.argv.slice(2);
for (const name of names.length ? names : Object.keys(RECORDINGS)) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "codex-fixture-")));
  const cwd = join(base, "work");
  mkdirSync(cwd);
  writeFileSync(join(cwd, "README.md"), "# fixture\n");
  try {
    const [rec, note] = await RECORDINGS[name](cwd);
    save(name, rec, `codex ${CODEX} app-server, ${MODEL} effort low, temp cwd. ${note}`);
  } catch (e) {
    console.error(`${name}: ${e.stack ?? e}`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}
