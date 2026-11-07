// A message that runs a skill shows the skill as a pill and only what the
// person wrote after it, never the skill's whole text (Pi echoes the expanded
// SKILL.md). Each agent sends a skill its own way; the item is the same:
// `skill: {name, command, path?, body?}` and `text` = the rest.
//
// What could go wrong: the echo puts the expanded text back; a resumed session
// shows the raw `<skill …>` block; Codex's `$name` stays in the text; a command
// that is not a skill (or a message that only mentions one) becomes a pill;
// the transcript, the session list or Edit-and-resend lose the `/command`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { idle, startHost, Host } from "./harness.ts";
import { startClaude } from "../fake-claude/host.ts";
import { codexHost } from "../fake-codex/host.ts";

const users = (c: any) => c.items.filter((i: any) => i.kind === "user");

test("pi: /skill:name shows a pill at once, Pi's expanded echo keeps it, and a resumed session shows the same", async () => {
  const body = "# Diagnose\n\nReproduce first.\nThen bisect.";
  // Pi's real expansion (agent-session.js `_expandSkillCommand`).
  const expanded = `<skill name="diagnose" location="/skills/diagnose/SKILL.md">\nReferences are relative to /skills/diagnose.\n\n${body}\n</skill>\n\n$1`;
  const scenario = { expandPrompts: { "^/skill:diagnose ([\\s\\S]*)$": expanded }, default: [{ assistant: { text: "done" } }] };
  const live = await startHost({ name: "skill-pi", speed: 1, scenario });
  let liveUser: any;
  try {
    const c = live.client;
    await c.waitFor(idle, 10_000, "started");
    const sent = c.req("send", { text: "/skill:diagnose the crash\non save" });
    await c.waitFor((x) => users(x).length === 1, 150, "shown at once");
    assert.deepEqual([users(c)[0].text, users(c)[0].skill], ["the crash\non save", { name: "diagnose", command: "skill:diagnose" }], "a pill before the echo");
    await sent;
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.kind === "assistant" && i.text === "done"), 10_000, "answered");
    assert.equal(users(c).length, 1, "the echo confirmed the shown item");
    liveUser = users(c)[0];
    assert.equal(liveUser.text, "the crash\non save");
    assert.deepEqual(liveUser.skill, { name: "diagnose", command: "skill:diagnose", path: "/skills/diagnose/SKILL.md", body });
    await live.waitTranscript(/^> \/skill:diagnose the crash$/m);
    assert.ok(!/<skill/.test(live.transcript), "the transcript has the command, not the skill's text");

    const listed = await c.req("sessions", {});
    const mine = listed?.sessions?.find((s: any) => s.path === c.state.sessionFile);
    assert.equal(mine?.firstMessage, "/skill:diagnose the crash\non save", "the session list shows the command");
    live.artifact("skill-pi");
  } finally {
    await live.stop();
  }

  const again = await new Host({ name: "skill-pi-resumed", speed: 1, scenario, dir: live.dir }).start();
  try {
    const c = again.client;
    await c.waitFor((x) => idle(x) && users(x).length === 1, 10_000, "history loaded");
    const u = users(c)[0];
    assert.deepEqual([u.text, u.skill], [liveUser.text, liveUser.skill], "history shows the same pill");
  } finally {
    await again.stop();
  }
});

test("claude: /name of a skill is a pill; another command and a mention stay text", async () => {
  // fake-claude's commands: "tdd" is a skill ("(user)"), "review" is not.
  const h = await startClaude({ name: "skill-claude", speed: 1, scenario: { default: [{ text: "ok" }] } });
  try {
    const c = h.client;
    await c.waitFor((x) => idle(x) && x.state.commands.some((k: any) => k.name === "tdd" && k.source === "skill"), 10_000, "commands");
    for (const text of ["/tdd write the parser test", "/review 12", "please run /tdd later"]) {
      const n = users(c).length;
      await c.req("send", { text });
      await c.waitFor((x) => idle(x) && users(x).length === n + 1 && x.items.at(-1).kind === "assistant" && !x.items.at(-1).streaming, 10_000, text);
    }
    assert.deepEqual(users(c).map((u: any) => [u.text, u.skill?.command ?? null]), [
      ["write the parser test", "tdd"],
      ["/review 12", null],
      ["please run /tdd later", null],
    ]);
    await h.waitTranscript(/^> \/tdd write the parser test$/m);
    h.artifact("skill-claude");
  } finally {
    await h.stop();
  }
  // Resumed: Claude Code's history has `/tdd …` as typed; it gets the same pill.
  const again = await startClaude({ name: "skill-claude-resumed", speed: 1, scenario: { default: [{ text: "ok" }] }, dir: h.dir });
  try {
    const c = again.client;
    await c.waitFor((x) => idle(x) && users(x).length === 3 && users(x)[0].skill, 10_000, "history with its pill");
    assert.deepEqual(users(c).map((u: any) => [u.text, u.skill?.command ?? null]), [
      ["write the parser test", "tdd"],
      ["/review 12", null],
      ["please run /tdd later", null],
    ]);
  } finally {
    await again.stop();
  }
});

test("codex: /name of a skill is sent as $name with the skill, and the echo's pill carries its file", async () => {
  const h = await codexHost({ name: "skill-codex", speed: 1, scenario: { default: [{ text: "hi Bob" }] } });
  try {
    const c = h.client;
    await c.waitFor((x) => idle(x) && x.state.commands.some((k: any) => k.name === "greet" && k.source === "skill"), 10_000, "skills");
    await c.req("send", { text: "/greet Bob" });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.kind === "assistant" && i.text === "hi Bob"), 10_000, "answered");
    const input = h.requests("turn/start").at(-1).params.input;
    assert.equal(input[0].text, "$greet Bob");
    assert.equal(input[1].type, "skill");
    assert.equal(users(c).length, 1);
    const u = users(c)[0];
    assert.equal(u.text, "Bob", "no $greet left in the text");
    assert.equal(u.skill.command, "greet");
    assert.match(u.skill.path, /skills\/greet\/SKILL\.md$/);
    h.artifact("skill-codex");
  } finally {
    await h.stop();
  }
});
