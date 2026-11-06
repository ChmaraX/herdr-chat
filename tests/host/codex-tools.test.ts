// Codex tool items through the real host: each card's title, status and details.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { idle } from "./harness.ts";
import { codexHost } from "../fake-codex/host.ts";

const answered = (text: RegExp) => (x: any) => idle(x) && x.items.some((i: any) => i.kind === "assistant" && text.test(i.text) && !i.streaming);
// A 1×1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

test("codex: every tool kind in one turn, with the details a user sees", async () => {
  const h = await codexHost({ name: "cx-tools", scenario: "tools.json" });
  try {
    const c = h.client;
    writeFileSync(join(h.cwd, "pic.png"), PNG);
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "use every tool" });
    await c.waitFor(answered(/All tools ran/), 15_000);
    const top = c.items.filter((i) => !i.parent);
    const tools = top.filter((i) => i.kind === "tool");
    assert.deepEqual(tools.map((t) => [t.title, t.status]), [
      ["$ npm test", "error"],
      ["Read README.md", "done"],
      ["List .", "done"],
      ["Grep TODO in src", "done"],
      ["Write notes.txt", "done"],
      ["Edit notes.txt", "done"],
      ["mcp echo · echo", "done"],
      ["Search the web for node lts", "done"],
      ["Open https://nodejs.org/en/download", "done"],
      [`Read pic.png`, "done"],
      ["Agent Reply with the digit 4 only.", "done"],
      ["Wait for agent", "done"],
    ]);
    const [bash, read, list, grep, write, edit, mcp, web, open, image, spawn, wait] = tools;
    // Shell: the login-shell wrapper is gone, ANSI colours kept in outputLines, the exit code shown.
    assert.deepEqual(bash.detail, { type: "bash", command: "npm test", exitCode: 1 });
    assert.equal(bash.output, "✓ one\n✗ two\n");
    assert.ok(bash.outputLines.some((l: any[]) => l.some((s) => s.fg === "ansi1")), "red ✗ kept as a span");
    assert.match(bash.args, /"command": "\/bin\/zsh -lc 'npm test'"/);
    // Commands Codex parsed as a read, a listing and a search.
    assert.deepEqual(read.detail, { type: "read", path: "README.md" });
    assert.equal(read.output, "# Fixture project\n");
    assert.deepEqual(list.detail, { type: "search", tool: "ls" });
    assert.deepEqual(grep.detail, { type: "search", tool: "grep", query: "TODO", path: "src" });
    // A file add is a write; an update an edit with a synthesized unified diff.
    assert.equal(write.detail.type, "write");
    assert.equal(write.detail.path, join(h.cwd, "notes.txt"));
    assert.equal(edit.detail.type, "edit");
    assert.match(edit.detail.diff, /^--- notes\.txt\n\+\+\+ notes\.txt\n@@ -1,2 \+1,2 @@$/m);
    assert.match(edit.detail.diff, /^-two$/m);
    assert.match(edit.detail.diff, /^\+three$/m);
    assert.equal(edit.detail.added, 1);
    assert.equal(edit.detail.removed, 1);
    // MCP, web.
    assert.deepEqual(mcp.detail, { type: "generic", server: "echo", tool: "echo" });
    assert.equal(mcp.output, "echo: ping");
    assert.deepEqual(web.detail, { type: "web", tool: "search", query: "node lts" });
    assert.match(web.output, /^Node\.js — https:\/\/nodejs\.org\n {2}Download Node\.js$/);
    assert.deepEqual(open.detail, { type: "web", tool: "fetch", url: "https://nodejs.org/en/download" });
    // The viewed image is saved and listed.
    assert.equal(image.detail.type, "read");
    assert.equal(image.images.length, 1);
    assert.ok(existsSync(image.images[0]));
    // The subagent: its card, its own items nested under it, the wait card's answer.
    assert.deepEqual(spawn.detail, { type: "agent", description: "Reply with the digit 4 only." });
    const nested = c.items.filter((i) => i.parent === spawn.id);
    assert.deepEqual(nested.map((i) => i.kind), ["user", "thinking", "tool", "assistant"]);
    assert.equal(nested[0].text, "Reply with the digit 4 only.");
    assert.equal(nested[2].title, "$ echo 4");
    assert.equal(nested[3].text, "4");
    assert.equal(wait.output, "4");
    assert.deepEqual(wait.detail, { type: "agent", description: "", agentType: "wait" });
    // Nothing nested leaked to the top level, and the run settled once.
    assert.equal(top.filter((i) => i.kind === "user").length, 1);
    await h.waitStatus(/^done/);
    await h.waitTranscript(/^· \$ npm test ✗/m);
    await h.waitTranscript(/^  · \$ echo 4 ✓\n  4$/m);
    h.artifact("codex-every-tool");
  } finally {
    await h.stop();
  }
});

test("codex fixture shell-approval (03): the real command card with its exit code and output", async () => {
  const h = await codexHost({ name: "cx-fx-shell", replay: "shell-approval.jsonl", speed: 4 });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "Use the shell to run `ls -la` in the current directory and tell me how many entries it lists. Do nothing else." });
    await c.waitFor((x) => x.state.dialog?.method === "permission", 10_000, "approval");
    const d = c.state.dialog;
    assert.equal(d.title, "Run this command?");
    assert.equal(d.tool.title, "$ ls -la");
    assert.deepEqual(d.choices.map((x: any) => [x.id, x.kind]), [["accept", "allow"], ["amend1", "allow_always"], ["decline", "deny"], ["cancel", "deny"]]);
    assert.equal(d.choices[1].label, "Always allow `ls -la`");
    await c.req("dialog_answer", { dialog: d.id, choice: "accept" });
    await c.waitFor(answered(/^4$/), 10_000);
    const tool = c.items.find((i) => i.kind === "tool");
    assert.equal(tool.title, "List .");
    assert.equal(tool.status, "done");
    assert.match(tool.output, /README\.md/);
    assert.deepEqual(h.answers().map((a) => a.result.decision), ["accept"]);
    h.artifact("codex-fixture-shell-approval");
  } finally {
    await h.stop();
  }
});

test("codex fixture file-edit (04): add then update, each approved, with the diff on the card", async () => {
  const h = await codexHost({ name: "cx-fx-edit", replay: "file-edit.jsonl", speed: 4 });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "Create a file notes.txt containing two lines 'one' and 'two'. Then edit it so the second line is 'three'. Use your file editing tool, not the shell." });
    for (let n = 0; n < 2; n++) {
      await c.waitFor((x) => x.state.dialog?.method === "permission", 10_000, `approval ${n}`);
      const d = c.state.dialog;
      assert.equal(d.title, "Apply this change?");
      assert.equal(d.tool.title, n === 0 ? "Write notes.txt" : "Edit notes.txt");
      if (n === 1) assert.match(d.tool.detail.diff, /^\+three$/m);
      await c.req("dialog_answer", { dialog: d.id, choice: "accept" });
      await c.waitFor((x) => x.state.dialog?.id !== d.id, 5000);
    }
    await c.waitFor(answered(/Done\./), 10_000);
    const tools = c.items.filter((i) => i.kind === "tool");
    assert.deepEqual(tools.map((t) => [t.title, t.status]), [["Write notes.txt", "done"], ["Edit notes.txt", "done"]]);
    assert.match(tools[1].detail.diff, /^ one$/m);
    assert.match(tools[1].detail.diff, /^-two$/m);
    h.artifact("codex-fixture-file-edit");
  } finally {
    await h.stop();
  }
});

test("codex fixtures mcp-tool and subagent: a real MCP call, and a real subagent nested under its card", async () => {
  const h = await codexHost({ name: "cx-fx-mcp", replay: "mcp-tool.jsonl", speed: 4 });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "Call the MCP tool `echo` (server `echo`) with text 'ping'. Then reply with exactly what it returned." });
    await c.waitFor(answered(/echo: ping/), 10_000);
    const tool = c.items.find((i) => i.kind === "tool");
    assert.equal(tool.title, "mcp echo · echo");
    assert.equal(tool.output, "echo: ping");
    assert.equal(tool.durationMs, 2);
  } finally {
    await h.stop();
  }
  const s = await codexHost({ name: "cx-fx-sub", replay: "subagent.jsonl", speed: 4 });
  try {
    const c = s.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "Use your spawn_agent tool to spawn exactly one subagent with the task: 'Reply with the digit 4 only.' Then wait for it and report its answer in one line. Do not read any skills or files first." });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.kind === "assistant" && !i.parent && i.text === "4"), 10_000, "answer");
    const spawn = c.items.find((i) => i.kind === "tool" && i.detail.type === "agent" && !i.detail.agentType);
    assert.equal(spawn.title, "Agent Reply with the digit 4 only.");
    const nested = c.items.filter((i) => i.parent === spawn.id);
    assert.deepEqual(nested.map((i) => [i.kind, i.text]), [["user", "Reply with the digit 4 only."], ["assistant", "4"]]);
    const wait = c.items.find((i) => i.kind === "tool" && i.detail.agentType === "wait");
    assert.equal(wait.output, "4");
    s.artifact("codex-fixture-subagent");
  } finally {
    await s.stop();
  }
});
