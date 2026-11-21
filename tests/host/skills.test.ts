// A message that runs skills shows each skill as a pill and only what the
// person wrote after them, never the skills' whole text (Pi echoes the
// expanded SKILL.md). Each agent gets skills its own way; the item is the
// same: `skills: [{name, command, path?, body?}]` and `text` = the rest.
//
// What could go wrong: the echo puts the expanded text back; a resumed session
// shows the raw `<skill …>` blocks; Codex's `$name`s stay in the text; a
// command that is not a skill (or a message that only mentions one) becomes a
// pill; the transcript, the session list or Edit-and-resend lose a `/command`.
// With several skills: the agent runs only the first (Pi and `claude -p` each
// expand one), the rest reach it as the first skill's arguments; a skill whose
// file can't be read is dropped silently; the pills come back out of order.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { idle, startHost, Host } from "./harness.ts";
import { startClaude } from "../fake-claude/host.ts";
import { codexHost } from "../fake-codex/host.ts";

const users = (c: any) => c.items.filter((i: any) => i.kind === "user");
/** A user item's skill commands, space-separated; null for none. */
const cmds = (u: any) => (u.skills?.length ? u.skills.map((s: any) => s.command).join(" ") : null);

test("pi: /skill:name shows a pill at once, Pi's expanded echo keeps it, and a resumed session shows the same", async () => {
  const body = "# Diagnose\n\nReproduce first.\nThen bisect.";
  // Pi's real expansion (agent-session.js `_expandSkillCommand`).
  const expanded = `<skill name="diagnose" location="/skills/diagnose/SKILL.md">\nReferences are relative to /skills/diagnose.\n\n${body}\n</skill>\n\n$1`;
  const scenario = { expandPrompts: { "^/skill:diagnose ([\\s\\S]*)$": expanded }, default: [{ assistant: { text: "done" } }] };
  const live = await startHost({ name: "skill-pi", speed: 1, scenario });
  let liveUser: any;
  try {
    const c = live.client;
    // The pill comes from Pi's skill list, which loads just after the agent starts.
    await c.waitFor((x) => idle(x) && x.state.commands.some((m: any) => m.source === "skill" && m.name === "skill:diagnose"), 10_000, "started, its skills listed");
    const sent = c.req("send", { text: "/skill:diagnose the crash\non save" });
    await c.waitFor((x) => users(x).length === 1, 150, "shown at once");
    assert.deepEqual([users(c)[0].text, users(c)[0].skills], ["the crash\non save", [{ name: "diagnose", command: "skill:diagnose" }]], "a pill before the echo");
    await sent;
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.kind === "assistant" && i.text === "done"), 10_000, "answered");
    assert.equal(users(c).length, 1, "the echo confirmed the shown item");
    liveUser = users(c)[0];
    assert.equal(liveUser.text, "the crash\non save");
    assert.deepEqual(liveUser.skills, [{ name: "diagnose", command: "skill:diagnose", path: "/skills/diagnose/SKILL.md", body }]);
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
    assert.deepEqual([u.text, u.skills], [liveUser.text, liveUser.skills], "history shows the same pill");
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
    assert.deepEqual(users(c).map((u: any) => [u.text, cmds(u)]), [
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
    await c.waitFor((x) => idle(x) && users(x).length === 3 && users(x)[0].skills, 10_000, "history with its pill");
    assert.deepEqual(users(c).map((u: any) => [u.text, cmds(u)]), [
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
    assert.equal(cmds(u), "greet");
    assert.match(u.skills[0].path, /skills\/greet\/SKILL\.md$/);
    h.artifact("skill-codex");
  } finally {
    await h.stop();
  }
});

// ---------------------------------------------------------------- several skills in one message

/** A skills folder of real SKILL.md files (frontmatter and all), as an agent lists them. */
function skillFiles(names: string[]): Record<string, string> {
  const root = join(tmpdir(), `herdr-chat-skills-${process.pid}-${Date.now()}`);
  const out: Record<string, string> = {};
  for (const n of names) {
    mkdirSync(join(root, n), { recursive: true });
    out[n] = join(root, n, "SKILL.md");
    writeFileSync(out[n]!, `---\nname: ${n}\ndescription: The ${n} skill\ndisable-model-invocation: true\n---\n\n# ${n}\n\nDo the ${n} steps.\n`);
  }
  return out;
}

const REST = "The parser drops trailing commas in arrays.\nFind why, fix it, then add a test.";

test("pi: three skills in one message reach the model as Pi's own blocks, in order, with their pills live and resumed", async () => {
  const files = skillFiles(["tdd", "diagnose", "review"]);
  const commands = Object.entries(files).map(([n, path]) => ({ name: `skill:${n}`, description: `The ${n} skill`, source: "skill", sourceInfo: { path, source: "local", scope: "user", origin: "top-level" } }));
  // Pi expands only the leading /skill:name, written out here as real Pi 0.80's `_expandSkillCommand` does
  // (its args follow its block); the host must write the others the same way, so they read back alike.
  const block = (n: string) => `<skill name="${n}" location="${files[n]}">\nReferences are relative to ${files[n]!.replace(/\/SKILL\.md$/, "")}.\n\n# ${n}\n\nDo the ${n} steps.\n</skill>`;
  const scenario = { commands, expandPrompts: { "^/skill:tdd ([\\s\\S]*)$": `${block("tdd")}\n\n$1` }, default: [{ assistant: { text: "on it" } }] };
  const h = await startHost({ name: "skills-pi-three", speed: 1, scenario });
  const want = [["tdd", files.tdd], ["diagnose", files.diagnose], ["review", files.review]];
  const pills = (u: any) => u.skills?.map((s: any) => [s.name, s.path ?? null]);
  let live: any;
  try {
    const c = h.client;
    await c.waitFor((x) => idle(x) && x.state.commands.some((m: any) => m.name === "skill:review"), 10_000, "skills listed");
    await c.req("send", { text: `/skill:tdd /skill:diagnose /skill:review ${REST}` });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.kind === "assistant" && i.text === "on it"), 10_000, "answered");

    // What the model got: one run of blocks in Pi's format (the first from Pi, the others from the host), then the message.
    const turn = h.piCommands().filter((r) => r.type === "prompt").at(-1).message.replace(/^\/skill:tdd ([\s\S]*)$/, `${block("tdd")}\n\n$1`);
    assert.equal(turn, [block("tdd"), block("diagnose"), block("review"), REST].join("\n\n"));

    assert.equal(users(c).length, 1, "one message, its echo confirmed");
    live = users(c)[0];
    assert.equal(live.text, REST, "the message without any skill text");
    assert.deepEqual(pills(live), want, "three pills, in the order typed, each with its file");
    assert.ok(live.skills.every((s: any) => /^# \w+\n\nDo the \w+ steps\.$/.test(s.body)), "each pill opens its own skill's body");
    await h.waitTranscript(/^> \/skill:tdd \/skill:diagnose \/skill:review The parser drops trailing commas in arrays\.$/m);
    const listed = await c.req("sessions", {});
    assert.equal(listed?.sessions?.find((s: any) => s.path === c.state.sessionFile)?.firstMessage, `/skill:tdd /skill:diagnose /skill:review ${REST}`, "the session list shows it as typed");
    // A skill named twice (hc send, an extension) runs once: Pi gets it once, with nothing left of the repeat.
    await c.req("send", { text: "/skill:tdd /skill:tdd once" });
    await c.waitFor((x) => idle(x) && users(x).length === 2 && x.items.at(-1)?.kind === "assistant", 10_000, "repeat answered");
    assert.equal(h.piCommands().filter((r) => r.type === "prompt").at(-1).message, "/skill:tdd once");
    assert.deepEqual([users(c)[1].text, users(c)[1].skills.map((s: any) => s.name)], ["once", ["tdd"]]);
    h.artifact("skills-pi-three");
  } finally {
    await h.stop();
  }
  const again = await new Host({ name: "skills-pi-three-resumed", speed: 1, scenario, dir: h.dir }).start();
  try {
    const c = again.client;
    await c.waitFor((x) => idle(x) && users(x).length === 2, 10_000, "history loaded");
    assert.deepEqual([users(c)[0].text, users(c)[0].skills], [live.text, live.skills], "resumed: the same three pills and text");
  } finally {
    await again.stop();
  }
});

test("pi: a later skill Pi gives no file for, or whose file is gone, refuses the send: nothing reaches Pi without it", async () => {
  const files = skillFiles(["tdd"]);
  const commands = [
    { name: "skill:tdd", description: "tdd", source: "skill", sourceInfo: { path: files.tdd } },
    { name: "skill:gone", description: "gone", source: "skill", sourceInfo: { path: join(tmpdir(), "no-such-skill", "SKILL.md") } },
    { name: "skill:nowhere", description: "from an extension, no file", source: "skill" },
  ];
  const h = await startHost({ name: "skills-pi-missing", speed: 1, scenario: { commands, default: [{ assistant: { text: "ran" } }] } });
  try {
    const c = h.client;
    await c.waitFor((x) => idle(x) && x.state.commands.some((m: any) => m.name === "skill:nowhere"), 10_000, "skills listed");
    const refused = (re: RegExp) => c.waitFor((x) => x.items.some((i) => i.kind === "notice" && re.test(i.text)), 5000, String(re));
    await c.req("send", { text: "/skill:tdd /skill:gone fix it" }).catch(() => {});
    await refused(/rejected the message: Can't read the skill gone \(/);
    await c.req("send", { text: "/skill:tdd /skill:nowhere fix it" }).catch(() => {});
    await refused(/rejected the message: Pi didn't say where the skill nowhere is/);
    await c.waitFor(idle, 5000, "idle again");
    assert.equal(h.piCommands().filter((r) => r.type === "prompt").length, 0, "nothing sent");
    assert.equal(users(c).length, 0, "the messages aren't left on the timeline");
    h.artifact("skills-pi-missing");
  } finally {
    await h.stop();
  }
});

test("claude: several skills go as one request naming each for the Skill tool; the pills and the typed text come back, live and resumed", async () => {
  const commands = [
    { name: "tdd", description: "Test-driven development loop (user)", argumentHint: "" },
    { name: "diagnose", description: "Diagnose a bug (project)", argumentHint: "" },
    { name: "pstack:review", description: "Review the diff (plugin:pstack@cursor-plugins)", argumentHint: "" },
    { name: "review", description: "Review a pull request", argumentHint: "" },
  ];
  const scenario = { commands, default: [{ text: "ok" }] };
  const h = await startClaude({ name: "skills-claude-three", speed: 1, scenario });
  const typed = `/tdd /diagnose /pstack:review ${REST}`;
  try {
    const c = h.client;
    await c.waitFor((x) => idle(x) && x.state.commands.some((k: any) => k.name === "pstack:review" && k.source === "skill"), 10_000, "commands");
    await c.req("send", { text: typed });
    await c.waitFor((x) => idle(x) && x.items.at(-1)?.kind === "assistant" && !x.items.at(-1).streaming, 10_000, "answered");
    // `claude -p` runs only a leading /name: the skills go as a request the model acts on, each named as a separate
    // `/name` word (the person's permission), in order, with nothing slash-led in front (that would run alone).
    const sent: string = h.inputs().filter((r) => r.type === "user").at(-1).message.content;
    assert.ok(!sent.startsWith("/"), "no leading command");
    assert.ok(/\bSkill tool\b/.test(sent), "asks for the Skill tool");
    assert.deepEqual(sent.match(/(?<=^|\s)\/[\w:-]+(?=\s|$)/g), ["/tdd", "/diagnose", "/pstack:review"], "each skill a /name word, in order");
    assert.ok(sent.endsWith(`\n\n${REST}`), "the message after it");
    assert.deepEqual(users(c).map((u: any) => [u.text, cmds(u)]), [[REST, "tdd diagnose pstack:review"]], "three pills, the message after them");
    // One skill stays a real slash command (Claude Code runs it itself); a non-skill command is never stacked.
    // A skill named twice (from outside the composer: hc send, an extension) runs once, and is shown once.
    await c.req("send", { text: "/tdd /tdd once" });
    await c.waitFor((x) => idle(x) && users(x).length === 2 && x.items.at(-1)?.kind === "assistant" && !x.items.at(-1).streaming, 10_000, "repeat");
    assert.equal(h.inputs().filter((r) => r.type === "user").at(-1).message.content, "/tdd once");
    assert.deepEqual([users(c)[1].text, cmds(users(c)[1])], ["once", "tdd"]);
    await c.req("send", { text: "/tdd /review 12" });
    await c.waitFor((x) => idle(x) && users(x).length === 3 && x.items.at(-1)?.kind === "assistant" && !x.items.at(-1).streaming, 10_000, "second");
    assert.equal(h.inputs().filter((r) => r.type === "user").at(-1).message.content, "/tdd /review 12");
    assert.deepEqual(cmds(users(c)[2]), "tdd");
    await h.waitTranscript(/^> \/tdd \/diagnose \/pstack:review The parser drops trailing commas in arrays\.$/m);
    const points = await c.req("fork_points", {});
    assert.equal(points.points.at(-1).text, typed, "fork / Edit-and-resend get it as typed");
    h.artifact("skills-claude-three");
  } finally {
    await h.stop();
  }
  const again = await startClaude({ name: "skills-claude-three-resumed", speed: 1, scenario, dir: h.dir });
  try {
    const c = again.client;
    await c.waitFor((x) => idle(x) && users(x).length === 3, 10_000, "history");
    assert.deepEqual(users(c).map((u: any) => [u.text, cmds(u)]), [[REST, "tdd diagnose pstack:review"], ["once", "tdd"], ["/review 12", "tdd"]], "resumed: the same pills");
  } finally {
    await again.stop();
  }
});

test("codex: several skills go as $mentions, each with its skill input; the pills carry their files", async () => {
  const home = join(tmpdir(), "fake-codex-home");
  const skills = ["greet", "tdd", "audit"].map((name) => ({ name, description: `The ${name} skill`, path: join(home, `skills/${name}/SKILL.md`), scope: "user", enabled: true, pluginId: null }));
  const h = await codexHost({ name: "skills-codex-three", speed: 1, scenario: { skills, default: [{ text: "done" }] } });
  try {
    const c = h.client;
    await c.waitFor((x) => idle(x) && x.state.commands.some((k: any) => k.name === "audit" && k.source === "skill"), 10_000, "skills");
    await c.req("send", { text: `/greet /tdd /audit ${REST}` });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.kind === "assistant" && i.text === "done"), 10_000, "answered");
    const input = h.requests("turn/start").at(-1).params.input;
    assert.equal(input[0].text, `$greet $tdd $audit ${REST}`);
    assert.deepEqual(input.slice(1).map((i: any) => [i.type, i.name]), [["skill", "greet"], ["skill", "tdd"], ["skill", "audit"]]);
    const u = users(c)[0];
    assert.equal(u.text, REST, "no $mentions left in the text");
    assert.equal(cmds(u), "greet tdd audit");
    assert.ok(u.skills.every((s: any) => s.path?.endsWith(`skills/${s.name}/SKILL.md`)), "each pill has its file");
    const points = await c.req("fork_points", {});
    assert.equal(points.points[0].text, `/greet /tdd /audit ${REST}`, "as typed");
    h.artifact("skills-codex-three");
  } finally {
    await h.stop();
  }
});
