// /fork, the same for every agent: `fork_points` lists the person's messages
// (newest first, as typed), and `fork {point}` moves the chat to a new session
// holding what came before that message, with the message back for the
// composer. Each agent forks its own way (Pi's `fork`, Claude Code's
// `--fork-session --resume-session-at`, Codex's `thread/fork`).
//
// What could go wrong: the fork keeps the chosen message or drops the one
// before it; the original session changes; the chat stays on the old session
// (its file, lock or timeline); a skill comes back as Pi's expanded text; the
// next prompt goes to the old session; Claude Code's fork is lost before its
// first prompt (nothing on disk yet); Codex's fork takes another effort.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { idle, startHost } from "./harness.ts";
import { startClaude } from "../fake-claude/host.ts";
import { codexHost } from "../fake-codex/host.ts";

const users = (c: any) => c.items.filter((i: any) => i.kind === "user").map((i: any) => i.text);
const answers = (c: any) => c.items.filter((i: any) => i.kind === "assistant" && !i.streaming).length;

async function chat(c: any, prompts: string[]): Promise<void> {
  for (const text of prompts) {
    const n = answers(c);
    await c.req("send", { text });
    await c.waitFor((x: any) => idle(x) && answers(x) > n, 15_000, `the answer to "${text}"`);
  }
}

test("pi: fork before the second message: a new session with the first; the message (a skill, as typed) back; the old session kept", async () => {
  const skill = '<skill name="diagnose" location="/skills/diagnose/SKILL.md">\nReproduce first.\n</skill>\n\n$1';
  const h = await startHost({ name: "fork-pi", speed: 4, scenario: { expandPrompts: { "^/skill:diagnose (.*)$": skill }, default: [{ assistant: { text: "ok" } }] } });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000, "started");
    await chat(c, ["first", "/skill:diagnose the crash", "third"]);
    const before = c.state.sessionFile;
    const original = readFileSync(before, "utf8");
    const { points } = await c.req("fork_points", {});
    assert.deepEqual(points.map((p: any) => p.text), ["third", "/skill:diagnose the crash", "first"], "newest first, the skill as typed");

    const r = await c.req("fork", { point: points[1].id });
    assert.equal(r.text, "/skill:diagnose the crash");
    assert.notEqual(c.state.sessionFile, before, "on a new session");
    await c.waitFor((x) => users(x).length === 1, 5000, "the timeline rebuilt");
    assert.deepEqual(users(c), ["first"]);
    assert.equal(readFileSync(before, "utf8"), original, "the original session is untouched");

    await chat(c, ["second, again"]);
    assert.deepEqual(users(c), ["first", "second, again"]);
    assert.match(readFileSync(c.state.sessionFile, "utf8"), /second, again/);
    assert.doesNotMatch(readFileSync(before, "utf8"), /second, again/, "the next prompt went to the fork");
    assert.ok(c.state.commands.some((x: any) => x.name === "fork" && x.handler === "client" && !x.input), "/fork is the chat's own (no terminal)");
    h.artifact("fork-pi");
  } finally {
    await h.stop();
  }
});

test("pi: an extension that cancels the fork leaves the chat where it was", async () => {
  const h = await startHost({ name: "fork-pi-cancel", speed: 4, scenario: { cancelFork: true, default: [{ assistant: { text: "ok" } }] } });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000, "started");
    await chat(c, ["first", "second"]);
    const before = c.state.sessionFile;
    const { points } = await c.req("fork_points", {});
    await assert.rejects(c.req("fork", { point: points[0].id }), /cancelled the fork/);
    assert.equal(c.state.sessionFile, before);
    assert.deepEqual(users(c), ["first", "second"]);
  } finally {
    await h.stop();
  }
});

test("claude: fork resumes at the answer before that prompt (--fork-session); a /reload before the first prompt keeps the fork", async () => {
  const h = await startClaude({ name: "fork-claude", speed: 4, scenario: { default: [{ text: "ok: {prompt}" }] } });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000, "started");
    await chat(c, ["first", "second"]);
    const before = c.state.sessionFile;
    const oldId = before.replace(/^.*\//, "").replace(/\.jsonl$/, "");
    const original = readFileSync(before, "utf8");
    const firstAnswer = original.split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((r) => r.type === "assistant").uuid;
    const { points } = await c.req("fork_points", {});
    assert.deepEqual(points.map((p: any) => p.text), ["second", "first"]);

    const r = await c.req("fork", { point: points[0].id });
    assert.equal(r.text, "second");
    const start = h.inputs().filter((x) => x.type === "_start").at(-1);
    const arg = (f: string) => start.argv[start.argv.indexOf(f) + 1];
    assert.ok(start.argv.includes("--fork-session"));
    assert.equal(arg("--resume"), oldId);
    assert.equal(arg("--resume-session-at"), firstAnswer, "at the answer to the first prompt");
    assert.notEqual(c.state.sessionFile, before);
    await c.waitFor((x) => idle(x) && users(x).length === 1, 5000, "the history up to the fork (its transcript isn't written yet)");
    assert.deepEqual(users(c), ["first"]);

    const starts = h.inputs().filter((x) => x.type === "_start").length;
    await c.req("send", { text: "/reload" });
    await c.waitFor((x) => idle(x) && users(x).length === 1 && h.inputs().filter((y) => y.type === "_start").length > starts, 10_000, "reloaded");
    const again = h.inputs().filter((x) => x.type === "_start").at(-1);
    assert.ok(again.argv.includes("--fork-session") && again.argv[again.argv.indexOf("--resume-session-at") + 1] === firstAnswer, "the reload starts the same fork");

    await chat(c, ["second, again"]);
    assert.deepEqual(users(c), ["first", "second, again"]);
    const forked = readFileSync(c.state.sessionFile, "utf8");
    assert.match(forked, /"first"/);
    assert.match(forked, /second, again/);
    assert.doesNotMatch(forked, /"second"/, "the fork dropped the chosen prompt");
    assert.equal(readFileSync(before, "utf8"), original, "the original session is untouched");

    // Before the first prompt there is nothing to keep: a new, empty session.
    const first = (await c.req("fork_points", {})).points.at(-1);
    assert.equal((await c.req("fork", { point: first.id })).text, "first");
    await c.waitFor((x) => idle(x) && users(x).length === 0, 5000, "an empty session");
    h.artifact("fork-claude");
  } finally {
    await h.stop();
  }
});

test("codex: fork through the turn before (thread/fork lastTurnId) on the same model and effort", async () => {
  const h = await codexHost({ name: "fork-codex", speed: 4, scenario: { forkEffort: "high", default: [{ text: "ok" }] } });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000, "started");
    await chat(c, ["first", "second", "third"]);
    const before = c.state.sessionFile;
    const effort = c.state.thinking;
    const { points } = await c.req("fork_points", {});
    assert.deepEqual(points.map((p: any) => p.text), ["third", "second", "first"]);

    assert.equal((await c.req("fork", { point: points[0].id })).text, "third");
    const req = h.requests("thread/fork").at(-1);
    assert.equal(req.params.lastTurnId, points[1].id, "through the turn of the message before");
    assert.ok(req.params.model, "with the model");
    assert.notEqual(c.state.sessionFile, before);
    await c.waitFor((x) => idle(x) && users(x).length === 2, 5000, "the forked thread's history");
    assert.deepEqual(users(c), ["first", "second"]);
    assert.equal(c.state.thinking, effort, `the effort kept (${effort}), not the fork's default`);

    await chat(c, ["third, again"]);
    assert.deepEqual(users(c), ["first", "second", "third, again"]);
    h.artifact("fork-codex");
  } finally {
    await h.stop();
  }
});
