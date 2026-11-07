import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { startHost, idle } from "./harness.ts";
import { lockPath } from "../../host/registry.ts";

test("Pi crashes mid-run: the run closes, the error shows, the next send restarts Pi on the same session", async () => {
  const h = await startHost({ name: "crash", scenario: "crash.json", speed: 2 });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    const file = c.state.sessionFile;
    assert.ok(file && existsSync(lockPath(file)), "lock held while Pi runs");
    await c.req("send", { text: "Run the tests" });
    await c.waitFor((x) => x.state.phase === "exited", 8000, "exited");
    assert.match(c.state.error, /Pi exited \(code 1\): fake-pi: crashing with code 1/);
    const tool = c.items.find((i) => i.kind === "tool");
    assert.equal(tool.status, "error");
    assert.match(tool.output, /running 12 tests[\s\S]*Pi exited before this tool finished/);
    assert.ok(c.items.every((i) => !i.streaming), "nothing left streaming");
    const notice = c.items.at(-1);
    assert.equal(notice.kind, "notice");
    assert.equal(notice.level, "error");
    await h.waitStatus(/^error\(Pi exited \(code 1\)\)$/);
    assert.ok(!existsSync(lockPath(file)), "lock released when Pi is gone");

    // Sending again restarts Pi with --session and resumes from its history.
    const r = await c.req("send", { text: "idle-crash please" });
    assert.ok(["started", "pending"].includes(r.disposition));
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.kind === "assistant" && i.text.startsWith("ok:")), 10_000, "answered after restart");
    assert.equal(c.state.sessionFile, file, "same session");
    assert.equal(c.state.error, null);
    const users = c.items.filter((i) => i.kind === "user").map((i) => i.text);
    assert.deepEqual(users, ["Run the tests", "idle-crash please"], "history kept across the restart");
    h.artifact("crash-mid-run");
  } finally {
    await h.stop();
  }
});

test("Pi exits between turns: surfaced at once, not only on the next send", async () => {
  const h = await startHost({ name: "crash-idle", scenario: "crash.json", speed: 1 });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "/die" });
    await c.waitFor((x) => x.state.phase === "exited", 5000, "exited while idle");
    assert.match(c.state.error, /code 3/);
    assert.ok(c.items.some((i) => i.kind === "notice" && i.level === "error" && /\/reload/.test(i.text)));
    // /reload restarts it.
    await c.req("send", { text: "/reload" });
    await c.waitFor(idle, 10_000, "idle after reload");
    assert.equal(c.state.error, null);
    h.artifact("crash-between-turns");
  } finally {
    await h.stop();
  }
});

test("an autonomous run: adopted, labelled by its cause, retry and compaction inside it", async () => {
  const h = await startHost({ name: "autonomous", scenario: "autonomous.json", speed: 1 });
  try {
    const c = h.client;
    await c.waitFor((x) => x.state.phase === "working", 5000, "run started on its own");
    await c.waitFor((x) => x.items.some((i) => i.kind === "notice" && i.source === "retry"), 3000, "retry notice");
    await c.waitFor((x) => x.state.phase === "compacting", 3000, "compacting inside the run");
    await c.waitFor(idle, 5000, "settled");
    const kinds = c.items.map((i) => `${i.kind}:${i.source ?? i.customType ?? ""}`);
    assert.deepEqual(kinds, ["notice:host", "custom:subagent-notify", "notice:retry", "assistant:", "notice:compaction"]);
    const [cause, custom, retry, answer, compaction] = c.items;
    assert.equal(cause.text, "Started by subagent-notify.");
    assert.match(custom.text, /Subagent t7 review finished/);
    assert.match(retry.text, /^Retry succeeded/);
    assert.equal(answer.autonomous, true);
    assert.match(compaction.text, /^Compacted the conversation: 150k → 32k tokens\.$/);
    await h.waitStatus(/^done$/);
    assert.deepEqual(h.statuses.filter((s, i, a) => s !== a[i - 1]), ["idle", "working", "done"]);
    h.artifact("autonomous-run");
  } finally {
    await h.stop();
  }
});

test("an autonomous run an extension's user message started: labelled as such", async () => {
  const scenario = { timers: [{ after: 300, steps: [{ run: [{ user: "Check the deploy" }, { assistant: { text: "The deploy is green." } }] }] }] };
  const h = await startHost({ name: "autonomous-user", scenario, speed: 1 });
  try {
    const c = h.client;
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.kind === "assistant"), 5000, "the run nobody prompted");
    assert.deepEqual(c.items.map((i) => [i.kind, i.text]), [["notice", "Started by an extension message."], ["user", "Check the deploy"], ["assistant", "The deploy is green."]]);
    assert.equal(c.items[1].source, "extension");
    h.artifact("autonomous-user-message");
  } finally {
    await h.stop();
  }
});

test("an oversized record (9 MiB) mid-tool and a garbage line: dropped, the head recovered, the turn finishes", async () => {
  const h = await startHost({
    name: "oversized",
    scenario: "oversized.json",
    speed: 1,
  });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "cat it" });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.kind === "assistant" && i.text.includes("`end`")), 15_000, "finished");
    const tool = c.items.find((i) => i.kind === "tool");
    assert.equal(tool.title, "$ cat huge.log");
    assert.equal(tool.status, "done");
    assert.equal(tool.detail.exitCode, 0);
    assert.match(tool.output, /end\n$/);
    const warn = c.items.find((i) => i.kind === "notice" && i.level === "warning");
    assert.match(warn.text, /too large to show \(9\.0 MiB\)/);
    assert.equal(c.items.filter((i) => i.kind === "notice" && /too large/.test(i.text)).length, 1, "one warning per run");
    h.artifact("oversized-record");
  } finally {
    await h.stop();
  }
});

test("a lost agent_settled: the get_state probe settles the run", async () => {
  const h = await startHost({
    name: "no-settle",
    // The run's own records, but agent_settled never comes: emit everything by hand and hang (not streaming).
    scenario: {
      extensionCommands: {
        go: [
          { emit: [{ type: "agent_start" }, { type: "turn_start" }] },
          { assistant: { text: "Half a run." } },
          { emit: [{ type: "turn_end" }, { type: "agent_end", messages: [], willRetry: false }] },
        ],
      },
    },
    speed: 1,
  });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "/go" });
    await c.waitFor((x) => x.items.some((i) => i.kind === "assistant" && !i.streaming), 3000, "answer");
    await c.waitFor(idle, 8000, "settled by probe");
    assert.ok(h.piCommands().filter((x) => x.type === "get_state").length >= 2, "probed get_state");
    h.artifact("probe-settles");
  } finally {
    await h.stop();
  }
});

test("a command that never answers: a hint after 10 s, Esc still stops it; the child gets HERDR_CHAT_HOST and HC_TERMINAL_ID", async () => {
  const h = await startHost({ name: "hung-cmd", speed: 1, env: { HC_TERMINAL_ID: "t42" }, scenario: { extensionCommands: { panel: [{ hang: true }] } } });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    const start = h.piCommands()[0];
    assert.equal(start.type, "_start");
    assert.deepEqual(start.env, { HERDR_CHAT_HOST: "1", HC_TERMINAL_ID: "t42" });
    assert.deepEqual(start.argv.slice(0, 2), ["--mode", "rpc"]);
    assert.equal(h.registry!.terminal, "t42");
    assert.equal((await c.req("send", { text: "/panel" })).disposition, "pending");
    assert.equal(c.state.phase, "working");
    await c.waitFor((x) => x.items.some((i) => i.kind === "notice" && /\/panel hasn't answered.*\/tui/.test(i.text)), 12_000, "hint");
    await c.req("abort");
    await c.waitFor(idle, 3000, "Esc stops waiting");
    h.artifact("hung-command");
  } finally {
    await h.stop();
  }
});
