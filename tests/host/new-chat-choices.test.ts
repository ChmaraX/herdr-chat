import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSelection, visibleChoices } from "../../herdr-app/mods/new-chat/choices.js";

const CHOICES = [
  { id: "terminal", label: "Terminal (zsh)", isTerminal: true },
  { id: "agy", label: "Antigravity" },
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
];

test("visibleChoices hides uninstalled agents and keeps Terminal", () => {
  const installed = { terminal: true, agy: true, claude: true, codex: false };
  assert.deepEqual(
    visibleChoices(CHOICES, installed).map((c) => c.id),
    ["terminal", "agy", "claude"],
  );
});

test("visibleChoices keeps all choices when installed is null or keys are missing", () => {
  assert.deepEqual(visibleChoices(CHOICES, null).map((c) => c.id), ["terminal", "agy", "claude", "codex"]);
  assert.deepEqual(visibleChoices(CHOICES, { codex: false }).map((c) => c.id), ["terminal", "agy", "claude"]);
  assert.deepEqual(visibleChoices(CHOICES, { terminal: false, agy: false, claude: false, codex: false }).map((c) => c.id), ["terminal"]);
});

test("resolveSelection preserves preferredId, falls back to fallbackId, or clamps to 0", () => {
  const visible = visibleChoices(CHOICES, { terminal: true, agy: true, claude: true, codex: false });
  assert.equal(resolveSelection(visible, "claude", "agy"), 2);
  assert.equal(resolveSelection(visible, "codex", "agy"), 1);
  assert.equal(resolveSelection(visible, "codex", "codex"), 0);
  assert.equal(resolveSelection([], "claude", "agy"), 0);
});
