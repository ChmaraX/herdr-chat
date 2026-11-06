// Recorded sessions of the real CLI (tests/fixtures/claude/), replayed turn by
// turn: what a user sees from real records.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { idle } from "./harness.ts";
import { startClaude, ClaudeHost } from "../fake-claude/host.ts";

async function turn(h: ClaudeHost, text: string, answer?: (d: any) => object, extra: object = {}): Promise<any[]> {
  const c = h.client;
  const before = c.items.length;
  await c.req("send", { text, ...extra });
  for (;;) {
    await c.waitFor((x) => idle(x) || x.state.dialog !== null, 15_000, `turn "${text.slice(0, 30)}"`);
    if (c.state.dialog === null) break;
    if (!answer) throw new Error(`unexpected dialog ${c.state.dialog.title}`);
    await c.req("dialog_answer", { dialog: c.state.dialog.id, ...answer(c.state.dialog) });
    await c.waitFor((x) => x.state.dialog === null || x.state.dialog.id !== c.state.dialog?.id, 2000);
  }
  return c.items.slice(before);
}

test("claude fixture main.jsonl (no session-state events): text, a bash ask, Write + Edit diffs, a deny", async () => {
  const h = await startClaude({ name: "claude-fx-main", speed: 4, replay: "main.jsonl" });
  try {
    await h.client.waitFor(idle, 10_000);
    let items = await turn(h, "Reply with exactly the word: hello");
    // The recording's init lists 8 plugin servers that failed or need sign-in: one notice for all.
    const mcp = items.filter((i) => i.kind === "notice");
    assert.equal(mcp.length, 1);
    assert.match(mcp[0].text, /^8 MCP servers didn't start: plugin:plugin-b:server-a, .* \(6 need OAuth sign-in: run \/mcp in \/tui\)\nplugin:plugin-b:server-a: needs OAuth sign-in\n/);
    items = items.filter((i) => i.kind !== "notice");
    assert.deepEqual(items.map((i) => [i.kind, i.text]), [["user", "Reply with exactly the word: hello"], ["assistant", "hello"]]);
    assert.equal(items[1].model, "claude-haiku-5-5");

    let card: any = null;
    items = await turn(h, "Use the Bash tool to run exactly: touch marker.txt && ls", (d) => ((card = d), { choice: "allow" }));
    assert.equal(card.tool.title, "$ touch marker.txt && ls");
    assert.deepEqual(card.choices.map((x: any) => x.id), ["allow", "always", "deny"]);
    const bash = items.find((i) => i.kind === "tool");
    assert.deepEqual([bash.title, bash.status, bash.output, bash.detail.exitCode], ["$ touch marker.txt && ls", "done", "marker.txt", 0]);
    assert.ok(items.some((i) => i.kind === "assistant" && /marker\.txt/.test(i.text)));

    items = await turn(h, "Use the Write tool to create notes.txt containing the single line 'one'. Then use the Edit tool to change 'one' to 'two'. No other tools.", () => ({ choice: "allow" }));
    const [write, edit] = items.filter((i) => i.kind === "tool");
    assert.deepEqual([write.title, write.detail.type, write.status], ["Write /tmp/ws/notes.txt", "write", "done"]);
    assert.equal(edit.detail.type, "edit");
    assert.match(edit.detail.diff, /@@ -1,1 \+1,1 @@\n-one\n\\ No newline at end of file\n\+two/);

    items = await turn(h, "Use the Bash tool to run exactly: rm marker.txt", () => ({ choice: "deny", message: "no" }));
    const rm = items.find((i) => i.kind === "tool");
    assert.deepEqual([rm.title, rm.status, rm.output], ["$ rm marker.txt", "declined", "User denied this in the probe"]);
    assert.ok(items.at(-1).kind === "assistant" && /denied/.test(items.at(-1).text));
    assert.ok(!h.client.items.some((i) => i.kind === "thinking"), "redacted thinking (no summarized display) shows nothing");
    // Every turn's init repeats the same failures: still the one notice, and the pending server isn't in it.
    const notices = h.client.items.filter((i) => i.kind === "notice" && /MCP server/.test(i.text));
    assert.equal(notices.length, 1, "one MCP notice across all turns");
    assert.match(notices[0].text, /\nplugin:plugin-b:server-h: failed to connect(\n|$)/);
    assert.doesNotMatch(notices[0].text, /Remote Docs/);
    h.artifact("claude-fixture-main");
  } finally {
    await h.stop();
  }
});

test("claude fixture extra.jsonl: image prompt + summarized thinking, deferred tools, a subagent, a question, web search, a missing tool", async () => {
  const h = await startClaude({ name: "claude-fx-extra", speed: 4, replay: "extra.jsonl" });
  try {
    await h.client.waitFor(idle, 10_000);
    const img = join(h.dir, "red.png");
    writeFileSync(img, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC", "base64"));
    let items = (await turn(h, "What colour is this image? One word.", undefined, { images: [img] })).filter((i) => i.kind !== "notice");
    assert.deepEqual(items.map((i) => i.kind), ["user", "thinking", "assistant"]);
    assert.equal(items[0].images, 1);
    assert.match(items[1].text, /small red square/);
    assert.equal(items[2].text, "Red");

    items = await turn(h, "Use the TodoWrite tool (load it with ToolSearch if needed) to record two todos: 'alpha' in_progress and 'beta' pending. Then stop.");
    const search = items.find((i) => i.kind === "tool");
    assert.deepEqual([search.name, search.detail.type, search.output], ["ToolSearch", "generic", "No matching deferred tools found"]);

    items = await turn(h, "Use the Task tool with subagent_type Explore to list the files in the current directory. Keep it short.");
    const agent = items.find((i) => i.kind === "tool" && i.name === "Agent");
    assert.deepEqual(agent.detail, { type: "agent", description: "List current directory files", agentType: "Explore" });
    assert.equal(agent.output, "- marker.txt\n- notes.txt");
    const nested = items.filter((i) => i.parent === agent.id);
    assert.deepEqual(nested.map((i) => [i.kind, i.title, i.status, i.output]), [["tool", "$ ls -1p /tmp/ws", "done", "marker.txt\nnotes.txt"]]);
    assert.ok(items.every((i) => i.parent === undefined || i.parent === agent.id));

    let q: any = null;
    items = await turn(h, "Use the AskUserQuestion tool to ask me whether I prefer tea or coffee (two options). Then tell me what I picked.", (d) => ((q = d), { answers: { q0: "Tea" } }));
    assert.equal(q.method, "questions");
    assert.deepEqual(q.questions[0].options.map((o: any) => o.label), ["Tea", "Coffee"]);
    assert.equal(items.at(-1).text, "You picked tea.");

    items = await turn(h, "Use the WebSearch tool to search for 'Anthropic Claude Code' and give me one result title.", () => ({ choice: "allow" }));
    const web = items.find((i) => i.kind === "tool" && i.name === "WebSearch");
    assert.deepEqual(web.detail, { type: "web", tool: "search", query: "Anthropic Claude Code" });
    assert.match(web.output, /^Web search results for query/);

    items = await turn(h, "Use the Read tool to read notes.txt, then the Grep tool to search for 'two' in the current directory.", () => ({ choice: "allow" }));
    const tools = items.filter((i) => i.kind === "tool");
    assert.deepEqual(tools.map((t) => [t.name, t.status]), [["Read", "done"], ["Grep", "error"], ["Bash", "done"]]);
    assert.equal(tools[0].output, "two\n", "the file, not the numbered lines");
    assert.equal(tools[0].title, "Read /tmp/ws/notes.txt");
    assert.match(tools[1].output, /No such tool available: Grep/);
    h.artifact("claude-fixture-extra");
  } finally {
    await h.stop();
  }
});

test("claude fixture v2.jsonl (session-state events, uuids): a steer folded mid-turn, plan-mode asks, /context", async () => {
  const h = await startClaude({ name: "claude-fx-v2", speed: 4, replay: "v2.jsonl" });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    let items = await turn(h, "Think briefly, then reply with exactly the word: hi");
    assert.equal(items.at(-1).text, "hi");
    items = await turn(h, "Use the Bash tool to run exactly: echo one");
    assert.ok(items.some((i) => i.kind === "thinking" && /echo command/.test(i.text)), "summarized thinking");
    assert.deepEqual(items.filter((i) => i.kind === "tool").map((t) => [t.title, t.status, t.detail.exitCode]), [["$ echo one", "done", 0]]);
    await turn(h, "Use the Bash tool to run exactly: echo one");

    // A steer while the sleep runs: it shows as queued, then folds into the same turn.
    await c.req("send", { text: "Use the Bash tool to run exactly: sleep 3; echo slept" });
    await c.waitFor((x) => x.items.some((i) => i.kind === "tool" && i.title === "$ sleep 3; echo slept"), 5000);
    await c.req("send", { text: "Also, after that, reply with the word BANANA." });
    await c.waitFor((x) => idle(x) && x.items.some((i) => /BANANA/.test(i.text ?? "") && i.kind === "assistant"), 10_000);
    const steer = c.items.filter((i) => i.kind === "user").at(-1);
    assert.deepEqual([steer.text, steer.source], ["Also, after that, reply with the word BANANA.", "queued"]);
    assert.deepEqual(c.state.queue, { steering: [], followUp: [] });

    await c.req("set_permission_mode", { mode: "plan" });
    await c.waitFor((x) => x.state.permissionMode === "plan", 2000);
    const cards: any[] = [];
    items = await turn(h, "Make a short plan (2 steps) for creating hello.txt with the text hi, then call ExitPlanMode with it.", (d) => {
      cards.push(d);
      return d.method === "questions" ? { answers: { q0: d.questions[0].options[0].label } } : { choice: "keep", message: "Keep planning: also add a README" };
    });
    assert.deepEqual(cards.map((d) => d.method + ":" + d.title), ["permission:Claude Code's plan is ready", "permission:Claude Code's plan is ready", "questions:Claude Code has a question"]);
    assert.match(cards[0].message, /^# Plan: create hello\.txt/);
    const exits = items.filter((i) => i.kind === "tool" && i.name === "ExitPlanMode");
    assert.deepEqual(exits.map((t) => t.status), ["declined", "declined"]);

    items = await turn(h, "/context");
    assert.deepEqual(items.map((i) => i.kind), ["user", "assistant"]);
    assert.equal(items[0].text, "/context");
    assert.match(items[1].text, /^## Context Usage/);
    h.artifact("claude-fixture-v2");
  } finally {
    await h.stop();
  }
});
