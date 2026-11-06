// Claude Code: every tool kind becomes the card a user expects, including a
// subagent's steps nested under its card and a todo list as a plan item.
import { test } from "node:test";
import assert from "node:assert/strict";
import { idle } from "./harness.ts";
import { startClaude } from "../fake-claude/host.ts";

const editResult = {
  filePath: "/w/src/app.ts", oldString: "one", newString: "two", originalFile: "one\n",
  structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-one", "+two"] }],
};

test("claude: bash (exit codes, live output), read, edit, write, web, MCP, subagent and todos as a user sees them", async () => {
  const h = await startClaude({
    name: "claude-tools", speed: 4,
    scenario: {
      turns: [{
        match: "everything",
        steps: [
          { thinking: "Use every tool once." },
          { tool: "Bash", ask: false, input: { command: "ls src", description: "List src" }, result: { content: "app.ts\nutil.ts" } },
          { tool: "Bash", ask: false, input: { command: "make test", description: "Run tests" }, result: { content: "Exit code 2\nFAIL util.test.ts", is_error: true, tool_use_result: "Error: Exit code 2\nFAIL util.test.ts" } },
          { tool: "Bash", ask: false, input: { command: "for i in 1 2 3; do echo tick$i; sleep 1; done", description: "Tick" }, task: { lines: ["tick1", "tick2", "tick3"], everyMs: 600 } },
          { tool: "Read", ask: false, input: { file_path: "{cwd}/src/app.ts", offset: 1, limit: 2 }, result: { content: "1\texport const one = 1;\n2\t", tool_use_result: { type: "text", file: { filePath: "/w/src/app.ts", content: "export const one = 1;\n", numLines: 2, startLine: 1, totalLines: 2 } } } },
          { tool: "Edit", ask: false, input: { file_path: "/w/src/app.ts", old_string: "one", new_string: "two" }, result: { content: "The file /w/src/app.ts has been updated successfully.", tool_use_result: editResult } },
          { tool: "Write", ask: false, input: { file_path: "/w/NOTES.md", content: "# Notes\n" }, result: { content: "File created successfully at: /w/NOTES.md", tool_use_result: { type: "create", filePath: "/w/NOTES.md", content: "# Notes\n", structuredPatch: [], originalFile: null } } },
          { tool: "WebSearch", ask: false, input: { query: "pelican pouch volume" }, result: { content: "Web search results for query: \"pelican pouch volume\"\n\nLinks: [{\"title\":\"Pelican\",\"url\":\"https://en.wikipedia.org/wiki/Pelican\"}]" } },
          { tool: "WebFetch", ask: false, input: { url: "https://en.wikipedia.org/wiki/Pelican", prompt: "pouch size" }, result: { content: "About 11 litres." } },
          { tool: "mcp__figma__get_file", ask: false, input: { file_key: "abc" }, result: { content: [{ type: "text", text: "{\"name\":\"Design\"}" }] } },
          { subagent: { description: "Find the config", type: "Explore", prompt: "Find where the config is loaded.", steps: [{ tool: "Bash", input: { command: "grep -rn config src" }, result: { content: "src/app.ts:3:config" } }], report: "The config is loaded in src/app.ts." } },
          { todos: [{ content: "Fix util test", status: "in_progress", activeForm: "Fixing" }, { content: "Update notes", status: "pending", activeForm: "Updating" }] },
          { text: "All done." },
        ],
      }],
    },
  });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "Use everything" });
    // Live output of the long command, while it runs.
    await c.waitFor((x) => x.items.some((i) => i.kind === "tool" && i.status === "running" && /tick1/.test(i.output)), 8000, "live bash output");
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.kind === "assistant" && i.text === "All done."), 15_000, "done");
    const tools = c.items.filter((i) => i.kind === "tool" && !i.parent);
    const by = (title: RegExp) => tools.find((t) => title.test(t.title));
    assert.deepEqual(tools.map((t) => [t.title, t.status]), [
      ["$ ls src", "done"],
      ["$ make test", "error"],
      ["$ for i in 1 2 3; do echo tick$i; sleep 1; done", "done"],
      [`Read ${h.cwd}/src/app.ts:1-2`.replace(`${h.cwd}/`, ""), "done"],
      ["Edit /w/src/app.ts", "done"],
      ["Write /w/NOTES.md", "done"],
      ["Search the web for pelican pouch volume", "done"],
      ["Fetch https://en.wikipedia.org/wiki/Pelican", "done"],
      ["mcp figma · get_file", "done"],
      ["Agent Find the config", "done"],
      ["TodoWrite", "done"],
    ]);
    assert.equal(by(/ls src/).detail.exitCode, 0);
    assert.equal(by(/make test/).detail.exitCode, 2, "the exit code parsed from 'Exit code 2'");
    assert.match(by(/make test/).output, /FAIL util\.test\.ts/);
    assert.equal(by(/tick/).output.trim(), "tick1\ntick2\ntick3");
    const read = by(/^Read/);
    assert.deepEqual(read.detail, { type: "read", path: `${h.cwd}/src/app.ts`, offset: 1, limit: 2 });
    assert.equal(read.output, "export const one = 1;\n", "the file content, not the numbered lines");
    const edit = by(/^Edit/);
    assert.equal(edit.detail.type, "edit");
    assert.match(edit.detail.diff, /^@@ -1,1 \+1,1 @@$/m, "the real hunk from structuredPatch");
    assert.ok(edit.detail.diffLines.some((l: any) => l.kind === "del") && edit.detail.diffLines.some((l: any) => l.kind === "add"), "a rendered diff");
    assert.deepEqual(by(/^Write/).detail, { type: "write", path: "/w/NOTES.md", bytes: 8 });
    assert.deepEqual(by(/Search the web/).detail, { type: "web", tool: "search", query: "pelican pouch volume" });
    assert.deepEqual(by(/^Fetch/).detail, { type: "web", tool: "fetch", url: "https://en.wikipedia.org/wiki/Pelican" });
    assert.deepEqual(by(/^mcp/).detail, { type: "generic", server: "figma", tool: "get_file" });
    const agent = by(/^Agent/);
    assert.deepEqual(agent.detail, { type: "agent", description: "Find the config", agentType: "Explore" });
    assert.equal(agent.output, "The config is loaded in src/app.ts.", "the subagent's report, not the harness note");
    const nested = c.items.filter((i) => i.parent === agent.id);
    assert.deepEqual(nested.map((i) => [i.kind, i.title ?? i.text, i.status]), [["tool", "$ grep -rn config src", "done"]], "the subagent's step, nested under its card");
    const plan = c.items.find((i) => i.kind === "plan");
    assert.deepEqual(plan.steps, [{ text: "Fix util test", status: "in_progress" }, { text: "Update notes", status: "pending" }]);
    assert.ok(h.controls("get_task_output").length >= 1, "live output came from get_task_output");
    await h.waitTranscript(/· \$ make test ✗/);
    h.artifact("claude-tools");
  } finally {
    await h.stop();
  }
});
