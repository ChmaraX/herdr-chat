// The slash menu per provider: built-ins named after the provider, offered only
// when it supports them, terminal utilities with the adapter's argv, the
// agent's TUI-only commands, and what the chat types into a terminal it opens
// so the person lands on that screen.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startHost, idle, FAKE_PI } from "./harness.ts";
import { startClaude, FAKE_CLAUDE } from "../fake-claude/host.ts";
import { codexHost, FAKE_CODEX } from "../fake-codex/host.ts";

// The protocol's contract is the name and handler table (protocol.md "Built-in slash commands"), in menu order.
const builtins = (state: any) => state.commands.filter((c: any) => c.source === "builtin")
  .map((c: any) => [c.name, c.handler, ...(c.argv ? [c.argv] : []), ...(c.input ? [{ input: c.input }] : [])]);

/** Built-ins name the provider they run, never Pi for another agent. */
function namedFor(state: any, agent: string): void {
  const desc = (name: string) => state.commands.find((c: any) => c.source === "builtin" && c.name === name).description;
  assert.match(desc("reload"), new RegExp(`^Restart ${agent} on this session`));
  assert.match(desc("tui"), new RegExp(`in ${agent}'s terminal UI$`));
  if (agent !== "Pi") assert.deepEqual(state.commands.filter((c: any) => c.source === "builtin" && /\bPi\b/.test(c.description)).map((c: any) => c.name), [], `no Pi in ${agent}'s menu`);
}

test("menus: Pi keeps its built-ins; Claude Code and Codex get theirs, named for them, with their own terminal utilities", async () => {
  const pi = await startHost({ name: "menu-pi", speed: 4 });
  try {
    await pi.client.waitFor(idle, 10_000);
    const utility = [FAKE_PI, "--no-session"];
    assert.deepEqual(builtins(pi.client.state), [
      ["model", "client"], ["thinking", "client"], ["compact", "host"], ["new", "host"], ["clear", "host"], ["name", "host"],
      ["resume", "client"], ["reload", "host"], ["copy", "client"], ["transcript", "client"], ["tui", "client"],
      ["login", "client", utility, { input: "/login" }], ["settings", "client", utility, { input: "/settings" }],
      ["scoped-models", "client", utility, { input: "/scoped-models" }],
      ["fork", "client"],
      ["tree", "client", { input: "/tree" }], ["export", "client", { input: "/export" }], ["hotkeys", "client", { input: "/hotkeys" }],
    ]);
    namedFor(pi.client.state, "Pi");
    assert.deepEqual(await pi.client.req("utility", { name: "scoped-models" }), { argv: utility });
  } finally {
    await pi.stop();
  }

  const claude = await startClaude({ name: "menu-claude", speed: 4 });
  try {
    const c = claude.client;
    await c.waitFor((x) => idle(x) && x.state.commands.some((y: any) => y.name === "review"), 10_000);
    assert.deepEqual(builtins(c.state), [
      ["model", "client"], ["thinking", "client"], ["compact", "host"], ["new", "host"], ["clear", "host"], ["name", "host"],
      ["resume", "client"], ["reload", "host"], ["copy", "client"], ["transcript", "client"], ["tui", "client"],
      ["login", "client", [FAKE_CLAUDE, "auth", "login"]], ["settings", "client", [FAKE_CLAUDE], { input: "/config" }], ["fork", "client"],
      // Its terminal-only commands, through its TUI (those the chat has its own way for left out).
      ...["doctor", "color", "focus", "reload-plugins", "theme", "logout", "terminal-setup", "statusline", "vim", "ide", "install-github-app", "keybindings"]
        .map((n) => [n, "client", { input: `/${n}` }]),
    ]);
    namedFor(c.state, "Claude Code");
    assert.deepEqual(await c.req("utility", { name: "login" }), { argv: [FAKE_CLAUDE, "auth", "login"] });
    await assert.rejects(c.req("utility", { name: "scoped-models" }), /Claude Code has no \/scoped-models/);
    // Not a built-in here: it goes to Claude Code as text, like any other slash command.
    await c.req("send", { text: "/scoped-models" });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.kind === "assistant"), 5000);
    assert.equal(claude.inputs().filter((r) => r.type === "user").at(-1).message.content, "/scoped-models");
  } finally {
    await claude.stop();
  }

  const codex = await codexHost({ name: "menu-codex", speed: 4 });
  try {
    const c = codex.client;
    await c.waitFor(idle, 10_000);
    const names = builtins(c.state).map((b: any[]) => b[0]);
    assert.deepEqual(builtins(c.state), [
      ["model", "client"], ["thinking", "client"], ["compact", "host"], ["new", "host"], ["clear", "host"], ["name", "host"],
      ["resume", "client"], ["reload", "host"], ["copy", "client"], ["transcript", "client"], ["tui", "client"],
      ["login", "client", [FAKE_CODEX, "login"]], ["fork", "client"],
    ], "no Pi-only built-ins");
    namedFor(c.state, "Codex");
    assert.equal(names.includes("compact"), c.state.capabilities.compact);
    assert.equal(names.includes("name"), c.state.capabilities.rename);
    assert.equal(names.includes("fork"), c.state.capabilities.fork);
  } finally {
    await codex.stop();
  }
});
