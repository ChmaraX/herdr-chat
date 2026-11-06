// Continue as chat (mod new-chat's continueAsChat, from chat-menu's right-click
// item or the "continue" key) on a Pi TUI with a pi-chat.session label, run
// against a stand-in for Herdr's mod API (the `herdr` module): what it asks
// the app and herdr-core to do, in order.
// - A top-level TUI where Pi is a shell's foreground program: the chat opens
//   beside it (pane.split, chat mod, the session, Pi's pid, the session's model
//   and thinking), focused; only Pi's pid gets SIGTERM; once Pi is gone the
//   idle shell's pane closes. A shell that then runs something else stays.
// - A sub-agent: hc kill, then hc run --parent/--name of the launcher on the
//   session with Pi's --model/--thinking, then the chat dialog.
// - Working: refused, nothing done.
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ROOT } from "./harness.ts";

const STUB = "data:text/javascript," + encodeURIComponent(`
const w = () => globalThis.__herdr;
export const terminals = () => w().terminals;
export const panes = () => w().panes;
export const focused = () => w().focused ?? null;
export const appHome = () => w().appHome;
export const readTextFile = async (p) => w().files?.[p] ?? null;
export const run = (name, args) => { w().calls.push(["run", name, args ?? null]); w().onRun?.(name, args); return null; };
export const hc = async (args) => { w().calls.push(["hc", ...args]); return w().hc(args); };
export const exec = async (cmd, args) => { if (cmd !== "grep") w().calls.push(["exec", cmd, ...args]); return w().exec(cmd, args); };
export const openOverlay = (o) => { w().calls.push(["openOverlay", o]); };
export const notify = (n) => { w().calls.push(["notify", n]); };
export const closeOverlay = () => {}, nextCommand = () => new Promise(() => {}), props = () => ({}), spaces = () => [], theme = () => ({}), knownAgents = async () => [];
`);
const GPUI = "data:text/javascript," + encodeURIComponent("export class View {}; export const div = () => ({}), image = div, svg = div, v_flex = div, h_flex = div;");
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "herdr") return { url: STUB, shortCircuit: true };
    if (spec === "gpui-kit" || spec === "gpui-base") return { url: GPUI, shortCircuit: true };
    return next(spec, ctx);
  },
});
const { continueAsChat } = await import(join(ROOT, "mod", "new-chat", "main.js"));
const cx = { sleep: (ms: number) => new Promise((r) => setTimeout(r, Math.min(ms, 5))) };

function sessionFile(): string {
  const f = join(mkdtempSync(join(tmpdir(), "cont-")), "s.jsonl");
  writeFileSync(f, [
    { type: "session", id: "s1" },
    { type: "model_change", provider: "anthropic", modelId: "claude-haiku-4-5" },
    { type: "thinking_level_change", thinkingLevel: "low" },
    { type: "message", message: { role: "user", content: "the model_change of a quoted \"type\":\"model_change\" is not one" } },
    { type: "model_change", provider: "openai-codex", modelId: "gpt-5.6-luna" },
    { type: "thinking_level_change", thinkingLevel: "xhigh" },
  ].map((e) => JSON.stringify(e)).join("\n") + "\n");
  return f;
}

/** A world with one Pi TUI terminal t9 (status `status`), Pi pid 500 in shell pid 400 (or as the program itself). */
function world(o: { status?: string; parent?: string | null; shellAfter?: "idle" | "busy"; inShell?: boolean; session: string }) {
  const piPid = 500, shellPid = 400;
  let piAlive = true;
  const inShell = o.inShell ?? true;
  const w: any = {
    calls: [], appHome: "/app", files: { "/app/mods/chat/config.json": JSON.stringify({ host: "/opt/hc/bin/pi-chat-host" }) },
    terminals: [{ address: "t9", state: "live", status: o.status ?? "idle", app: "pi", parent: o.parent ?? null, name: o.parent ? "review" : null, cwd: "/work",
      labels: { "pi-chat.session": o.session } }],
    panes: o.parent ? [] : [{ pane: "p1", terminal: "t9", tab: "tb1" }],
    hc: (args: string[]) => {
      if (args[0] === "get") {
        const fg = piAlive ? { pid: piPid, argv: ["pi", "-c"], cwd: "/work/sub" } : o.shellAfter === "busy" ? { pid: 777, argv: ["vim"] } : { pid: shellPid, argv: ["-zsh"] };
        return { code: 0, stdout: JSON.stringify(inShell ? { pid: shellPid, argv: ["/bin/zsh", "-l"], state: "live", foreground: fg } : { pid: piPid, argv: ["pi"], state: piAlive ? "live" : "finished", foreground: piAlive ? fg : null }), stderr: "" };
      }
      if (args[0] === "kill") { w.terminals[0].state = "finished"; return { code: 0, stdout: "", stderr: "" }; }
      if (args[0] === "run") {
        w.terminals.push({ address: "t10", state: "live", labels: { "pi-chat.chat": "c-sub" } });
        return { code: 0, stdout: JSON.stringify({ address: "t10" }), stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected" };
    },
    exec: (cmd: string, args: string[]) => {
      if (cmd === "grep") {
        try { return { code: 0, stdout: execFileSync("grep", args, { encoding: "utf8" }), stderr: "" }; } catch { return { code: 1, stdout: "", stderr: "" }; }
      }
      if (cmd === "kill" && args[0] === "-TERM" && args[1] === String(piPid)) { piAlive = false; return { code: 0, stdout: "", stderr: "" }; }
      if (cmd === "kill" && args[0] === "-0") return { code: args[1] === String(piPid) && piAlive ? 0 : 1, stdout: "", stderr: "" };
      return { code: 1, stdout: "", stderr: `no ${cmd}` };
    },
    onRun: (name: string, args: any) => {
      if (name === "pane.split") w.panes.push({ pane: "p2", mod: "chat", tab: "tb1", terminal: null });
      if (name === "pane.close") w.panes = w.panes.filter((p: any) => p.pane !== args.pane);
    },
  };
  (globalThis as any).__herdr = w;
  return w;
}

const shape = (calls: any[]) => calls.map((c) => (c[0] === "run" && c[1] === "pane.split" ? ["run", "pane.split", { ...c[2], props: { ...c[2].props, chat: c[2].props.chat.replace(/^c-[0-9a-f]{8}$/, "c-<id>") } }] : c));

test("continue as chat: a top-level Pi TUI in a shell: the chat opens beside it on the session, model and thinking, Pi alone is stopped, its idle shell's pane closes", async () => {
  const session = sessionFile();
  const w = world({ session });
  await continueAsChat("t9", cx);
  assert.deepEqual(shape(w.calls), [
    ["hc", "get", "t9", "--json"],
    ["run", "pane.split", { direction: "right", pane: "p1", mod: "chat",
      props: { chat: "c-<id>", provider: "pi", session, afterPid: 500, cwd: "/work/sub", model: "openai-codex/gpt-5.6-luna", thinking: "xhigh" } }],
    ["run", "pane.focus", { pane: "p2" }],
    ["exec", "kill", "-TERM", "500"],
    ["exec", "kill", "-0", "500"],
    ["exec", "kill", "-0", "500"],
    ["hc", "get", "t9", "--json"],
    ["run", "pane.close", { pane: "p1" }],
    ["run", "pane.focus", { pane: "p2" }],
  ]);
  assert.ok(!w.calls.some((c: any[]) => c[0] === "hc" && c[1] === "kill"), "the terminal (the shell) isn't killed");
  assert.deepEqual(w.panes.map((p: any) => p.pane), ["p2"], "the chat has the TUI's place");
});

test("continue as chat: the focused terminal (the continue key); a shell that runs something else after Pi keeps its pane", async () => {
  const w = world({ session: sessionFile(), shellAfter: "busy" });
  w.focused = { terminal: "t9" };
  await continueAsChat("", cx);
  assert.ok(w.calls.some((c: any[]) => c[1] === "pane.split"));
  assert.ok(!w.calls.some((c: any[]) => c[1] === "pane.close"), "its pane stays");
  assert.match(w.calls.find((c: any[]) => c[0] === "notify")[1].body, /now runs vim: its pane stays/);
});

test("continue as chat: a Pi TUI that is the terminal's own program: its pid, and its finished pane closes", async () => {
  const w = world({ session: sessionFile(), inShell: false });
  await continueAsChat("t9", cx);
  assert.equal(w.calls.find((c: any[]) => c[1] === "pane.split")[2].props.afterPid, 500);
  assert.ok(w.calls.some((c: any[]) => c[1] === "pane.close" && c[2].pane === "p1"));
});

test("continue as chat: a Pi sub-agent: hc kill, then the launcher with its parent, name, session, model and thinking, then the chat dialog", async () => {
  const session = sessionFile();
  const w = world({ session, parent: "t2" });
  await continueAsChat("t9", cx);
  assert.deepEqual(w.calls.filter((c: any[]) => c[0] !== "run"), [
    ["hc", "kill", "t9"],
    ["hc", "run", "--bg", "--json", "--parent", "t2", "--name", "review", "--cwd", "/work", "--", "/opt/hc/bin/pi-chat-subagent", "--provider", "pi", "--session", session,
      "--", "--model", "openai-codex/gpt-5.6-luna", "--thinking", "xhigh"],
    ["openOverlay", { mod: "chat", kind: "dialog", width: 0.8, height: 0.8, props: { chat: "c-sub", peek: "t10", provider: "pi" } }],
  ]);
});

test("continue as chat: refused while Pi works (and for a terminal without a session label), nothing done", async () => {
  const w = world({ session: sessionFile(), status: "working" });
  await assert.rejects(continueAsChat("t9", cx), /Wait for the run to end/);
  assert.deepEqual(w.calls, []);
  const w2 = world({ session: sessionFile() });
  delete w2.terminals[0].labels["pi-chat.session"];
  await assert.rejects(continueAsChat("t9", cx), /no pi-chat.session label/);
  assert.deepEqual(w2.calls, []);
});
