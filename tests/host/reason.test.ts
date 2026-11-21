// A permission card's reason field says what the text goes with (herdr-app/mods/chat/reason.js).
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error a plain JS module of the mod's
import { reasonPlaceholder } from "../../herdr-app/mods/chat/reason.js";

test("a plan's change row asks what should change; a tool's No asks why; Codex's No asks what instead", () => {
  assert.equal(reasonPlaceholder([{ kind: "allow", label: "Yes, and auto-accept edits" }, { kind: "deny", label: "Tell Claude what to change" }]), "What should change? (sent with Tell Claude what to change)");
  assert.equal(reasonPlaceholder([{ kind: "allow", label: "Yes" }, { kind: "deny", label: "No" }]), "Why not? (optional, sent with No)");
  assert.equal(reasonPlaceholder([{ kind: "allow", label: "Yes, proceed" }, { kind: "deny", label: "No, and tell Codex what to do differently" }]), "What to do instead? (optional, sent with No)");
  assert.equal(reasonPlaceholder([{ kind: "deny", label: "Deny" }]), "Why not? (optional, sent with Deny)");
  assert.equal(reasonPlaceholder([{ kind: "deny" }]), "Why not? (optional, sent with Deny)");
  assert.equal(reasonPlaceholder(undefined), "Why not? (optional, sent with Deny)");
});
