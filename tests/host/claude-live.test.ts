// LIVE=1: the real `claude` CLI with the user's own login, the cheapest model, a temp dir.
// A bash call goes through a permission card; the answer comes back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { startHost, idle } from "./harness.ts";

test("claude live: a bash call answered through a permission ask, then the answer", { skip: process.env.LIVE !== "1" }, async () => {
  const h = await startHost({ name: "claude-live", provider: "claude", agent: process.env.PI_CHAT_CLAUDE ?? "claude", piArgs: ["--model", "haiku"] });
  try {
    const c = h.client;
    await c.waitFor(idle, 60_000, "claude started");
    assert.equal(c.state.provider, "claude");
    assert.match(c.state.piVersion ?? "", /^\d+\.\d+\.\d+/);
    await c.req("send", { text: "Use the Bash tool to run exactly: touch live-ok.txt && ls. Then reply with the single word DONE." });
    await c.waitFor((x) => x.state.dialog?.method === "permission", 90_000, "permission card");
    const d = c.state.dialog;
    assert.equal(d.tool.name, "Bash");
    assert.match(d.tool.title, /touch live-ok\.txt/);
    assert.ok(d.choices.some((x: any) => x.kind === "allow") && d.choices.some((x: any) => x.kind === "deny"));
    await h.waitStatus(/^blocked/, 5000);
    await c.req("dialog_answer", { dialog: d.id, choice: "allow" });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.kind === "assistant" && /DONE/.test(i.text)), 120_000, "the answer");
    const tool = c.items.find((i) => i.kind === "tool" && i.name === "Bash");
    assert.equal(tool.status, "done");
    assert.match(tool.output, /live-ok\.txt/);
    assert.equal(tool.detail.exitCode, 0);
    assert.ok(existsSync(`${h.cwd}/live-ok.txt`), "the command really ran");
    await c.waitFor((x) => x.state.usage?.contextTokens > 0, 15_000, "context usage");
    await h.waitStatus(/^done/, 5000);
    h.artifact("claude-live");
  } finally {
    const file = h.client?.state?.sessionFile;
    await h.stop();
    // The transcript lives in the user's ~/.claude; remove this throwaway session.
    if (file && /\.jsonl$/.test(file)) rmSync(file, { force: true });
  }
});
