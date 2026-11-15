// Smoke tests against the real `codex app-server` (the user's login and config). Run only with LIVE=1.
// gpt-5.6-luna at effort low, a temp cwd, the "Ask first" preset so the command needs approval.
// Run it under `hc exec` if Codex's code-mode host can't start from the calling shell.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { idle } from "./harness.ts";
import { codexHost } from "../fake-codex/host.ts";

const LIVE = process.env.LIVE === "1";

test("live: real Codex — a shell command answered through a permission ask, then the answer", { skip: !LIVE, timeout: 240_000 }, async () => {
  const h = await codexHost({ name: "codex-live", agent: process.env.CODEX_BIN ?? "codex" });
  try {
    const c = h.client;
    writeFileSync(join(h.cwd, "README.md"), "# live smoke\n");
    await c.waitFor(idle, 60_000, "Codex started");
    assert.ok(c.state.agentVersion, "app-server version read");
    await c.req("set_model", { provider: "openai", modelId: "gpt-5.6-luna" });
    await c.req("set_thinking", { level: "low" });
    await c.req("set_permission_mode", { mode: "untrusted" });
    await c.waitFor((x) => x.state.permissionMode === "untrusted" && x.state.model?.id === "gpt-5.6-luna" && x.state.thinking === "low", 10_000, "settings");

    await c.req("send", { text: "Use the shell to run exactly `touch live-ok.txt && echo live-ok`, then reply with just the word done." });
    await c.waitFor((x) => x.state.dialog?.method === "permission", 120_000, "permission ask");
    const d = c.state.dialog;
    assert.equal(d.title, "Run this command?");
    assert.match(d.tool.title, /^\$ touch live-ok\.txt && echo live-ok$/);
    assert.ok(d.choices.some((x: any) => x.kind === "allow") && d.choices.some((x: any) => x.kind === "deny"));
    await c.req("dialog_answer", { dialog: d.id, choice: d.choices.find((x: any) => x.kind === "allow").id });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.kind === "assistant" && /done/i.test(i.text) && !i.streaming), 120_000, "answer");
    const tool = c.items.find((i) => i.kind === "tool" && /live-ok/.test(i.title));
    assert.equal(tool.status, "done");
    assert.equal(tool.detail.exitCode, 0);
    assert.match(tool.output, /live-ok/);
    assert.ok(existsSync(join(h.cwd, "live-ok.txt")), "the command ran in the chat's cwd");
    await c.waitFor((x) => x.state.usage?.contextTokens > 0, 10_000, "usage");
    assert.match(c.state.sessionFile, /rollout-.*\.jsonl$/);
    await h.waitStatus(/^done/);
    h.artifact("codex-live");
  } finally {
    await h.stop();
  }
});

test("live: real Codex — update_plan feeds the chat's plan, and the rollout brings it back after a restart", { skip: !LIVE, timeout: 300_000 }, async () => {
  const h = await codexHost({ name: "codex-live-plan", agent: process.env.CODEX_BIN ?? "codex" });
  let live: { plan: unknown; markers: string[]; file: string };
  try {
    const c = h.client;
    await c.waitFor(idle, 60_000, "Codex started");
    await c.req("set_model", { provider: "openai", modelId: "gpt-5.6-luna" });
    await c.req("set_thinking", { level: "low" });
    await c.waitFor((x) => x.state.model?.id === "gpt-5.6-luna" && x.state.thinking === "low", 10_000, "settings");
    await c.req("send", {
      text: "Use your plan tool (update_plan) three times: first a 3-step plan for a haiku about rain with step 1 in_progress, then with step 1 completed and step 2 in_progress, then with every step completed. Then reply with the haiku. Don't use the shell.",
    });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.kind === "assistant" && !i.streaming && i.text), 180_000, "answer");
    const markers = c.items.filter((i) => i.kind === "notice" && i.source === "plan").map((i) => i.text);
    assert.equal(c.state.plan?.steps.length, 3, `turn/plan/updated fed the plan: ${JSON.stringify(c.state.plan)}`);
    assert.ok(c.state.plan.steps.every((s: { status: string }) => s.status === "completed"), "the last update finished every step");
    assert.deepEqual(markers, ["Plan created · 3 steps"]);
    live = { plan: structuredClone(c.state.plan), markers, file: c.state.sessionFile };
    h.artifact("codex-live-plan", { rollout: live.file });
  } finally {
    await h.stop();
  }

  const again = await codexHost({ name: "codex-live-plan-resumed", agent: process.env.CODEX_BIN ?? "codex", dir: h.dir });
  try {
    const c = again.client;
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.kind === "assistant"), 60_000, "history");
    assert.equal(c.state.sessionFile, live.file);
    assert.deepEqual(c.state.plan, live.plan, "the rollout's records rebuild the plan under thread/turns/list's turn id");
    assert.deepEqual(c.items.filter((i) => i.kind === "notice" && i.source === "plan").map((i) => i.text), live.markers);
    again.artifact("codex-live-plan-resumed", { rollout: live.file });
  } finally {
    await again.stop();
  }
});
