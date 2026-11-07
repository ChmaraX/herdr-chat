// One smoke test against the real `pi` (the user's normal setup: extensions, auth, settings).
// Runs only with LIVE=1. anthropic/claude-haiku-4-5, a temp --session-dir, short prompts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { startHost, idle, Host } from "./harness.ts";

const LIVE = process.env.LIVE === "1";

test("live: real Pi — a bash turn, an abort mid-tool, then resume on the same session", { skip: !LIVE, timeout: 240_000 }, async () => {
  const h = new Host({ name: "live", pi: process.env.PI_BIN ?? "pi", piArgs: [] });
  h.opts.piArgs = ["--model", "anthropic/claude-haiku-4-5", "--thinking", "low", "--session-dir", join(h.dir, "sessions")];
  writeFileSync(join(h.cwd, "README.md"), "# live smoke\n");
  await h.start();
  let file: string;
  try {
    const c = h.client;
    await c.waitFor(idle, 60_000, "Pi started");
    assert.equal(c.state.model.id, "claude-haiku-4-5");
    assert.ok(c.state.agentVersion, "pi --version read");
    await c.req("send", { text: "Use the bash tool to run `echo live-ok`, then reply with just the word done." });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.kind === "assistant" && /done/i.test(i.text) && !i.streaming), 90_000, "answer");
    const tool = c.items.find((i) => i.kind === "tool");
    assert.equal(tool.title, "$ echo live-ok");
    assert.equal(tool.status, "done");
    assert.equal(tool.detail.exitCode, 0);
    assert.match(tool.output, /live-ok/);
    await c.waitFor((x) => x.state.usage?.contextTokens > 0, 10_000, "usage");
    await h.waitStatus(/^done/);

    await c.req("send", { text: "Use the bash tool to run `sleep 20`." });
    await c.waitFor((x) => x.items.some((i) => i.kind === "tool" && i.title === "$ sleep 20" && i.status === "running"), 90_000, "sleep running");
    await c.req("abort");
    await c.waitFor(idle, 30_000, "aborted");
    const sleepTool = c.items.find((i) => i.kind === "tool" && i.title === "$ sleep 20");
    assert.equal(sleepTool.status, "error");
    assert.match(sleepTool.output, /aborted/i);
    file = c.state.sessionFile;
    h.artifact("live-real-pi");
  } finally {
    await h.stop();
  }

  const again = await new Host({ name: "live-again", pi: process.env.PI_BIN ?? "pi", dir: h.dir, piArgs: ["--model", "anthropic/claude-haiku-4-5", "--thinking", "low", "--session-dir", join(h.dir, "sessions")] }).start();
  try {
    const c = again.client;
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.kind === "tool"), 60_000, "history");
    assert.equal(c.state.sessionFile, file);
    assert.deepEqual(c.items.filter((i) => i.kind === "tool").map((t) => [t.title, t.status]), [["$ echo live-ok", "done"], ["$ sleep 20", "error"]]);
    again.artifact("live-real-pi-resumed");
  } finally {
    await again.stop();
  }
});
