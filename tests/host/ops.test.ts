import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startHost, idle, sleep } from "./harness.ts";
import { lockPath, pidAlive } from "../../host/registry.ts";

const lastAssistant = (x: any) => x.items.filter((i: any) => i.kind === "assistant").at(-1);

test("models, model and thinking pickers, built-ins: /model, /thinking, /name, /compact, /new", async () => {
  const agentDir = join(process.env.TMPDIR ?? "/tmp", `pich-agent-${process.pid}-${Date.now()}`);
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ enabledModels: ["anthropic/claude-haiku-4-5", "claude-sonnet-5", "openai-codex/*:high"] }));
  const h = await startHost({ name: "builtins", speed: 4, env: { PI_CODING_AGENT_DIR: agentDir } });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    const { models } = await c.req("models");
    assert.deepEqual(models.map((m: any) => [`${m.provider}/${m.id}`, m.enabled]), [
      ["anthropic/claude-haiku-4-5", true], ["anthropic/claude-sonnet-5", true], ["openai-codex/gpt-5.6-luna", true], ["local/tiny", false],
    ]);
    await c.req("set_model", { provider: "anthropic", modelId: "claude-sonnet-5" });
    assert.equal(c.state.model.id, "claude-sonnet-5");
    assert.equal(c.state.model.contextWindow, 1000000);
    await assert.rejects(c.req("set_model", { model: "nope/x" }), /Model not found/);
    await c.req("set_thinking", { level: "high" });
    await c.waitFor((x) => x.state.thinking === "high", 2000);

    // Built-ins typed in the composer (or sent by hc send).
    assert.equal((await c.req("send", { text: "/model local/tiny" })).disposition, "handled");
    await c.waitFor((x) => x.state.model.id === "tiny", 2000, "/model");
    assert.equal((await c.req("send", { text: "/thinking low" })).disposition, "handled");
    await c.waitFor((x) => x.state.thinking === "off", 2000, "/thinking on a model without reasoning stays off");
    await c.req("send", { text: "/name Refactor auth" });
    await c.waitFor((x) => x.state.sessionName === "Refactor auth", 2000, "/name");
    await c.req("send", { text: "/model" });
    await c.waitFor((x) => x.toasts.some((t) => /\/model is available in the chat window/.test(t.text)), 2000, "client-only built-in toast");

    await c.req("send", { text: "hello there" });
    await c.waitFor((x) => idle(x) && lastAssistant(x)?.text === "ok: hello there", 5000);
    await c.req("send", { text: "/compact keep the auth notes" });
    await c.waitFor((x) => x.items.some((i) => i.kind === "notice" && i.source === "compaction" && /^Compacted/.test(i.text)), 5000, "compacted");
    await c.waitFor(idle, 2000);
    const compact = h.piCommands().find((x) => x.type === "compact");
    assert.equal(compact.customInstructions, "keep the auth notes");

    const oldFile = c.state.sessionFile;
    const snapshots = c.records.filter((r) => r.t === "snapshot").length;
    await c.req("send", { text: "/new" });
    await c.waitFor((x) => x.records.filter((r) => r.t === "snapshot").length === snapshots + 1, 3000, "new snapshot");
    assert.deepEqual(c.items, []);
    assert.notEqual(c.state.sessionFile, oldFile);
    assert.equal(c.state.sessionName, null);
    assert.ok(!existsSync(lockPath(oldFile)), "old lock released");
    assert.ok(existsSync(lockPath(c.state.sessionFile)), "new lock taken");
    h.artifact("builtins-and-pickers");
  } finally {
    await h.stop();
  }
});

test("sessions picker and switch_session: newest first, names and first messages, then the switched timeline", async () => {
  const h = await startHost({ name: "sessions", speed: 4 });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "first session question" });
    await c.waitFor((x) => idle(x) && x.items.length === 2, 5000);
    const first = c.state.sessionFile;
    await c.req("new_session");
    await c.req("send", { text: "second session question" });
    await c.waitFor((x) => idle(x) && x.items.length === 2, 5000);
    await c.req("set_name", { name: "Second" });
    const { sessions } = await c.req("sessions");
    assert.equal(sessions.length, 2);
    assert.deepEqual(sessions.map((s: any) => [s.firstMessage, s.name, s.messageCount]), [
      ["second session question", "Second", 2],
      ["first session question", null, 2],
    ]);
    assert.ok(sessions[0].modified >= sessions[1].modified);
    assert.equal(sessions[1].path, first);
    await c.req("switch_session", { path: first });
    await c.waitFor((x) => x.items.some((i) => i.text === "first session question"), 3000, "switched");
    assert.equal(c.state.sessionFile, first);
    assert.deepEqual(c.items.map((i) => i.kind), ["user", "assistant"]);
    assert.ok(existsSync(lockPath(first)));
    await assert.rejects(c.req("switch_session", { path: "/nope.jsonl" }), /Session not found/);
    h.artifact("sessions-and-switch");
  } finally {
    await h.stop();
  }
});

test("history paging, tool_output, files, the clipboard_image op answers, editor text", async () => {
  const history: any[] = [];
  for (let i = 0; i < 130; i++) {
    history.push({ role: "user", content: [{ type: "text", text: `q${i}` }], timestamp: 1000 + i });
    history.push({ role: "assistant", content: [{ type: "text", text: `a${i}` }], api: "x", provider: "anthropic", model: "claude-haiku-4-5", usage: {}, stopReason: "stop", timestamp: 1000 + i });
  }
  const big = Array.from({ length: 4000 }, (_, i) => `line ${i} ${"x".repeat(5)}`).join("\n");
  const h = await startHost({
    name: "paging",
    speed: 4,
    scenario: {
      history,
      historyAlways: true,
      prompts: [{ match: "big", steps: [
        { assistant: { text: "Big output.", tools: [{ id: "call_big", name: "bash", args: { command: "seq 4000" } }] } },
        { tool: { id: "call_big", output: big } },
        { assistant: { text: "Done." } },
      ] }],
      extensionCommands: { prefill: [{ ui: { method: "set_editor_text", text: "prefilled {args}" } }] },
    },
  });
  try {
    const c = h.client;
    await c.waitFor((x) => idle(x) && x.items.length === 200, 10_000, "history loaded");
    assert.equal(c.hasOlder, true);
    assert.equal(c.items[0].text, "q30");
    const older = await c.req("history", { before: c.items[0].id, limit: 50 });
    assert.equal(older.items.length, 50);
    assert.equal(older.hasOlder, true);
    assert.equal(older.items.at(-1).text, "a29");
    const oldest = await c.req("history", { before: older.items[0].id, limit: 50 });
    assert.equal(oldest.items.length, 10);
    assert.equal(oldest.hasOlder, false);
    const all = [...oldest.items, ...older.items, ...c.items].map((i: any) => i.text);
    assert.deepEqual(all, history.map((m) => m.content[0].text), "paging neither loses nor repeats items");

    await c.req("send", { text: "big one" });
    await c.waitFor((x) => idle(x) && lastAssistant(x)?.text === "Done.", 5000);
    const tool = c.items.find((i) => i.kind === "tool");
    assert.equal(tool.outputTruncated, true);
    assert.equal(tool.output.length, 16 * 1024);
    assert.ok(big.endsWith(tool.output), "the tail is kept");
    const { text } = await c.req("tool_output", { item: tool.id });
    assert.equal(text, big);
    await assert.rejects(c.req("tool_output", { item: "nope" }), /No such tool item/);

    // files: a bounded walk outside git, fuzzy-ranked.
    mkdirSync(join(h.cwd, "src", "deep"), { recursive: true });
    mkdirSync(join(h.cwd, "node_modules", "x"), { recursive: true });
    for (const f of ["src/app.ts", "src/deep/apple.ts", "README.md", "node_modules/x/app.ts", "src/map.tsx"]) writeFileSync(join(h.cwd, f), "x");
    const { files } = await c.req("files", { query: "app", limit: 10 });
    assert.deepEqual(files.slice(0, 2), ["src/app.ts", "src/deep/apple.ts"]);
    assert.ok(!files.some((f: string) => f.startsWith("node_modules")));

    // Wiring only: the op answers {path}. A real clipboard image is not covered (it'd overwrite the user's clipboard).
    const clip = await c.req("clipboard_image");
    assert.ok(clip.path === null || existsSync(clip.path));

    await c.req("send", { text: "/prefill draft" });
    await c.waitFor((x) => x.state.editorText === "prefilled draft", 3000, "editor text");
    await c.req("ack_editor_text");
    await c.waitFor((x) => x.state.editorText === null, 2000);
    h.artifact("paging-tool-output-files");
  } finally {
    await h.stop();
  }
});

test("images: a PNG becomes Pi ImageContent; a text-only model gets a path hint; a bad file is refused", async () => {
  const h = await startHost({ name: "images", speed: 4 });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    const png = join(h.dir, "shot.png");
    // A 1×1 PNG.
    writeFileSync(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));
    await c.req("send", { text: "what is this", images: [png] });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.kind === "assistant"), 5000);
    const user = c.items.find((i) => i.kind === "user");
    assert.equal(user.images, 1);
    const prompt = h.piCommands().find((x) => x.type === "prompt");
    assert.equal(prompt.images[0].mimeType, "image/png");
    assert.equal(prompt.images[0].data, readFileSync(png).toString("base64"));
    await c.req("set_model", { provider: "local", modelId: "tiny" });
    await c.req("send", { text: "and now", images: [png] });
    await c.waitFor((x) => idle(x) && x.items.filter((i) => i.kind === "assistant").length === 2, 5000);
    const second = h.piCommands().filter((x) => x.type === "prompt")[1];
    assert.equal(second.images, undefined);
    assert.match(second.message, new RegExp(`\\[Image available at: ${png.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]`));
    const fake = join(h.dir, "fake.png");
    writeFileSync(fake, "not a png");
    await assert.rejects(c.req("send", { text: "x", images: [fake] }), /Not a valid PNG/);
    h.artifact("images");
  } finally {
    await h.stop();
  }
});

test("shutdown: bye, registry cleared, the Pi process group gone, the host exits 0", async () => {
  const h = await startHost({ name: "shutdown", speed: 4 });
  const c = h.client;
  await c.waitFor(idle, 10_000);
  const { execSync } = await import("node:child_process");
  const children = execSync(`pgrep -P ${h.proc.pid}`).toString().trim().split("\n").map(Number);
  assert.ok(children.length >= 1);
  const file = c.state.sessionFile;
  await c.req("shutdown");
  await c.waitFor((x) => x.bye !== null, 3000, "bye");
  assert.equal(c.bye!.reason, "shutdown");
  const code = await Promise.race([h.exited, sleep(5000).then(() => "timeout")]);
  assert.equal(code, 0);
  const reg = h.registry!;
  assert.equal(reg.pid, null);
  assert.equal(reg.port, null);
  assert.equal(reg.sessionFile, file);
  for (const pid of children) assert.equal(pidAlive(pid), false, `child ${pid} gone`);
  assert.ok(!existsSync(lockPath(file)));
  h.artifact("shutdown");
});
