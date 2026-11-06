import { test } from "node:test";
import assert from "node:assert/strict";
import { startHost, idle } from "./harness.ts";

test("multi-tool turn: every tool kind, in order, with the details a user sees", async () => {
  const h = await startHost({ name: "multi-tool", scenario: "tools.json", speed: 5 });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000, "idle at start");
    // Startup decoration: ANSI statuses as spans, a widget, a title, a notify notice.
    await c.waitFor((x) => x.state.statuses.length === 2 && x.state.widgets.length === 1, 5000, "statuses");
    assert.deepEqual(c.state.statuses[0], { key: "mcp", spans: [{ text: "🔌 MCP: 6 servers enabled", fg: "#ca9ee6" }] });
    assert.equal(c.state.widgets[0].placement, "belowEditor");
    assert.equal(c.state.title, "pi - fake project");

    const res = await c.req("send", { text: "Look around the repo" });
    assert.equal(res.disposition, "started");
    await c.waitFor((x) => x.state.phase === "working", 2000, "working");
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.kind === "assistant" && i.text.startsWith("Done.")), 15_000, "final answer");

    const kinds = c.items.map((i) => (i.kind === "tool" ? `tool:${i.name}` : i.kind));
    assert.deepEqual(kinds, [
      "notice", "user", "thinking", "assistant", "tool:bash", "tool:read",
      "assistant", "tool:edit", "tool:write", "tool:grep", "tool:find", "tool:ls", "tool:mcp__figma__get_file", "tool:bash",
      "assistant",
    ]);
    const tools = c.items.filter((i) => i.kind === "tool");
    assert.equal(new Set(tools.map((t) => t.toolCallId)).size, tools.length, "one item per tool call");
    const byId = Object.fromEntries(tools.map((t) => [t.toolCallId, t]));
    assert.equal(byId.call_bash.title, "$ ls -la && echo done");
    assert.equal(byId.call_bash.status, "done");
    assert.equal(byId.call_bash.detail.exitCode, 0);
    assert.ok(!byId.call_bash.output.includes("\u001b"), "ANSI stripped from output");
    assert.match(byId.call_bash.output, /README\.md\ndone/);
    assert.equal(byId.call_read.title, "Read README.md:10-40");
    assert.deepEqual(byId.call_read.detail, { type: "read", path: "README.md", offset: 10, limit: 31 });
    assert.equal(byId.call_edit.title, "Edit README.md");
    assert.match(byId.call_edit.detail.diff, /^-Line eleven\n\+Line 11$/m);
    assert.deepEqual(byId.call_write.detail, { type: "write", path: "NOTES.md", bytes: 17 });
    assert.equal(byId.call_grep.title, "Grep TODO in src");
    assert.equal(byId.call_mcp.title, "mcp figma · get_file");
    assert.deepEqual(byId.call_mcp.detail, { type: "generic", server: "figma", tool: "get_file" });
    assert.equal(byId.call_bad.status, "error");
    assert.equal(byId.call_bad.detail.exitCode, 1);
    for (const t of tools) assert.ok(t.args.length > 0 && t.durationMs !== undefined, `${t.title} has args and a duration`);

    const thinking = c.items.find((i) => i.kind === "thinking");
    assert.equal(thinking.streaming, false);
    assert.ok(typeof thinking.durationMs === "number");
    const answers = c.items.filter((i) => i.kind === "assistant");
    assert.deepEqual(answers.map((a) => a.stopReason), ["toolUse", "toolUse", "stop"]);
    assert.ok(answers.every((a) => !a.streaming && !a.autonomous));

    // Header data.
    assert.equal(c.state.model.id, "claude-haiku-4-5");
    assert.equal(c.state.usage.contextWindow, 200000);
    assert.ok(c.state.usage.percent > 0);
    assert.ok(c.state.commands.some((x: any) => x.name === "model" && x.source === "builtin"));
    assert.ok(c.state.commands.some((x: any) => x.name === "skill:diagnose" && x.source === "skill" && x.handler === "host"));

    // The transcript for `hc read`.
    await h.waitTranscript(/^Done\. I listed the files/m);
    const tr = h.transcript;
    assert.match(tr, /^> Look around the repo$/m);
    assert.match(tr, /^· \$ ls -la && echo done ✓$/m);
    assert.match(tr, /^· \$ false ✗$/m);
    assert.match(tr, /^Done\. I listed the files/m);
    await h.waitStatus(/^done$/);
    assert.deepEqual(h.statuses.filter((s, i, a) => s !== a[i - 1]), ["idle", "working", "done"]);
    h.artifact("multi-tool-turn");
  } finally {
    await h.stop();
  }
});

test("coalescing and U+2028: a long streamed answer arrives in ~50 ms batches, separators intact", async () => {
  const h = await startHost({ name: "coalesce", scenario: "long-markdown.json", speed: 1 });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    const before = c.records.length;
    const t0 = Date.now();
    await c.req("send", { text: "Write the long report" });
    const sizes: number[] = [];
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.kind === "assistant" && !i.streaming), 30_000, "answer done");
    const patches = c.records.slice(before).filter((r) => r.t === "patch");
    for (const p of patches) sizes.push(JSON.stringify(p).length);
    const elapsed = Date.now() - t0;
    const answer = c.items.find((i) => i.kind === "assistant");
    assert.ok(answer.text.includes("line separator here:\u2028and a paragraph separator here:\u2029done."), "U+2028/U+2029 kept inside the text");
    assert.ok(answer.text.endsWith("That's all."));
    assert.ok(answer.text.length > 4000);
    // ~280 text deltas + ~11 thinking deltas → batches at most every 50 ms.
    const deltas = Math.ceil(answer.text.length / 24);
    assert.ok(patches.length < deltas / 2, `${patches.length} patches for ${deltas} deltas`);
    assert.ok(patches.length <= elapsed / 40 + 10, `${patches.length} patches in ${elapsed} ms`);
    // A streaming item is sent whole, so it's always consistent.
    const streamingSeen = patches.some((p) => p.upsert?.some((i: any) => i.kind === "assistant" && i.streaming));
    assert.ok(streamingSeen, "clients saw the answer while it streamed");
    h.artifact("coalescing-u2028", { patches: patches.length, deltas, elapsedMs: elapsed, maxPatchBytes: Math.max(...sizes) });
  } finally {
    await h.stop();
  }
});
