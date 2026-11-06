// Claude Code sessions: resume rebuilds the live timeline from the transcript,
// local commands and /compact, images, sessions/switch/new, the TUI hand-off.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { idle } from "./harness.ts";
import { startClaude } from "../fake-claude/host.ts";
import { lockPath } from "../../host/registry.ts";

/** What a user sees of an item: no ids, times, live-only streaming details or usage. */
function seen(items: any[]): any[] {
  const ids = new Map(items.map((i) => [i.id, i]));
  return items
    .filter((i) => i.kind !== "notice")
    .map((i) => {
      const { id, ts, durationMs, usage, source, parent, images, imagePaths, ...rest } = i;
      void id, ts, durationMs, usage, source;
      return { ...rest, ...(parent ? { parent: ids.get(parent)?.title } : {}), ...(images || imagePaths ? { images: (images ?? imagePaths).length } : {}) };
    });
}

const SCENARIO = {
  turns: [
    {
      match: "Look around",
      steps: [
        { thinking: "Start with the files." },
        { text: "Let me look." },
        { tool: "Bash", ask: false, input: { command: "ls" }, result: { content: "app.ts\nREADME.md" } },
        { tool: "Edit", ask: false, input: { file_path: "/w/app.ts", old_string: "a", new_string: "b" }, result: { content: "updated", tool_use_result: { structuredPatch: [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, lines: ["-a", "+b"] }] } } },
        { tool: "Bash", input: { command: "rm README.md" } },
        { subagent: { description: "Check tests", type: "Explore", steps: [{ tool: "Bash", input: { command: "ls test" }, result: { content: "app.test.ts" } }], report: "One test file." } },
        { todos: [{ content: "Write docs", status: "pending", activeForm: "Writing" }] },
        { text: "Done looking." },
      ],
    },
    { match: "second", steps: [{ text: "Second answer with `code`." }] },
  ],
};

test("claude: resume from the transcript shows the same timeline as live (tools, diffs, declines, nested steps, plan, /context)", async () => {
  const live = await startClaude({ name: "claude-resume-live", speed: 4, scenario: SCENARIO });
  let liveItems: any[];
  let file: string;
  try {
    const c = live.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "Look around" });
    await c.waitFor((x) => x.state.dialog?.method === "permission", 5000);
    await c.req("dialog_answer", { dialog: c.state.dialog.id, choice: "deny", message: "keep the readme" });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.text === "Done looking."), 10_000);
    await c.req("send", { text: "And a second prompt" });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.text === "Second answer with `code`."), 5000);
    await c.req("send", { text: "/context" });
    await c.waitFor((x) => idle(x) && x.items.some((i) => /^## Context Usage/.test(i.text ?? "")), 5000, "local command answer");
    assert.equal(c.items.filter((i) => i.kind === "user").at(-1).text, "/context", "the command shows as the user's message");
    assert.equal(c.items.filter((i) => /^## Context Usage/.test(i.text ?? "")).length, 1, "the local command's answer shows once");
    liveItems = structuredClone(c.items);
    file = c.state.sessionFile;
    assert.ok(existsSync(file), "the CLI wrote its transcript");
    live.artifact("claude-resume-live");
  } finally {
    await live.stop();
  }
  assert.ok(!existsSync(lockPath(file)), "lock released");
  assert.equal(live.registry!.provider, "claude");

  // Same state dir and chat, no --provider: the registry's provider and session come back.
  const again = await startClaude({ name: "claude-resume-again", speed: 4, scenario: SCENARIO, dir: live.dir });
  try {
    const c = again.client;
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.kind === "tool"), 10_000, "history loaded");
    assert.equal(c.state.sessionFile, file);
    assert.equal(c.state.provider, "claude");
    const start = again.inputs().filter((r) => r.type === "_start").at(-1);
    assert.equal(start.argv[start.argv.indexOf("--resume") + 1], file.replace(/^.*\//, "").replace(/\.jsonl$/, ""));
    assert.deepEqual(seen(c.items), seen(liveItems));
    again.artifact("claude-resume-history", { liveItems: seen(liveItems) });
  } finally {
    await again.stop();
  }
});

test("claude: /compact, an image prompt, sessions + switch + new, and the TUI hand-off argv", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC", "base64");
  const h = await startClaude({ name: "claude-session-ops", speed: 4, scenario: { turns: [{ match: "colour", steps: [{ text: "Red." }] }], default: [{ text: "ok: {prompt}" }] } });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    const img = join(h.dir, "red.png");
    writeFileSync(img, png);
    await c.req("send", { text: "What colour is this?", images: [img] });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.text === "Red."), 5000);
    const user = c.items.find((i) => i.kind === "user");
    assert.equal(user.images, 1);
    assert.deepEqual(readFileSync(user.imagePaths[0]), png, "the user item shows what Claude got");
    const sent = h.inputs().find((r) => r.type === "user").message.content;
    assert.deepEqual(sent.map((b: any) => b.type), ["image", "text"]);
    assert.equal(sent[0].source.media_type, "image/png");

    await c.req("send", { text: "/compact keep the colours" });
    await c.waitFor((x) => x.items.some((i) => i.kind === "notice" && /^Compacted the conversation: \d+k → 3k tokens\.$/.test(i.text)), 5000, "compaction notice");
    await c.waitFor(idle, 3000);
    assert.ok(!c.items.some((i) => i.kind === "notice" && /on its own/.test(i.text)), "our /compact is not an autonomous run");
    assert.equal(h.inputs().filter((r) => r.type === "user").at(-1).message.content, "/compact keep the colours");
    const first = c.state.sessionFile;

    const { argv, sessionFile } = await c.req("handoff");
    assert.equal(sessionFile, first);
    const id = first.replace(/^.*\//, "").replace(/\.jsonl$/, "");
    assert.deepEqual(argv.slice(1), ["--resume", id]);
    assert.match(argv[0], /fake-claude\.mjs$/);
    assert.equal(c.state.phase, "handoff");
    await c.req("resume");
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.text === "Red."), 5000, "back from the TUI");

    await c.req("new_session");
    await c.waitFor((x) => idle(x) && x.state.sessionFile !== first, 5000);
    assert.deepEqual(c.items, []);
    await c.req("send", { text: "fresh start" });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.text === "ok: fresh start"), 5000);
    const { sessions } = await c.req("sessions");
    assert.deepEqual(sessions.map((s: any) => [s.firstMessage, s.path === first]).sort(), [["What colour is this?", true], ["fresh start", false]]);
    await c.req("switch_session", { path: first });
    await c.waitFor((x) => idle(x) && x.state.sessionFile === first && x.items.some((i) => i.text === "Red."), 5000);
    assert.ok((c.items as any[]).some((i) => i.kind === "notice" && /^Compacted the conversation \(\d+k tokens before\)\.$/.test(i.text)), "the compaction shows in history");
    h.artifact("claude-session-ops");
  } finally {
    await h.stop();
  }
});
