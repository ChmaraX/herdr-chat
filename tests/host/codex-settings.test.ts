// Codex settings through the real host: models, reasoning effort, permission presets, plan mode.
import { test } from "node:test";
import assert from "node:assert/strict";
import { idle } from "./harness.ts";
import { codexHost } from "../fake-codex/host.ts";

test("codex: switch model, effort and permission mode; the chips follow and Codex gets the settings", async () => {
  const h = await codexHost({ name: "cx-settings", scenario: { approvalPolicy: "on-request", sandbox: "workspace-write" } });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    const { models } = await c.req("models");
    assert.deepEqual(models.map((m: any) => m.id), ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-text-only"], "hidden models are left out");
    assert.ok(models.every((m: any) => m.provider === "openai" && m.enabled));

    await c.req("set_model", { provider: "openai", modelId: "gpt-5.6-sol" });
    await c.waitFor((x) => x.state.model?.id === "gpt-5.6-sol", 3000);
    assert.equal(c.state.model.name, "GPT-5.6-Sol");
    assert.deepEqual(c.state.capabilities.thinkingLevels, ["low", "medium", "high", "xhigh", "max", "ultra"]);
    assert.equal(c.state.thinking, "low", "the effort carries over when the new model supports it");
    await c.req("set_thinking", { level: "ultra" });
    await c.waitFor((x) => x.state.thinking === "ultra", 3000);

    // A model without "ultra" falls back to its default effort; a text-only model takes no images.
    await c.req("set_model", { model: "openai/gpt-text-only" });
    await c.waitFor((x) => x.state.model?.id === "gpt-text-only", 3000);
    assert.equal(c.state.thinking, "low");
    assert.deepEqual(c.state.capabilities.thinkingLevels, ["low", "high"]);
    assert.equal(c.state.capabilities.images, false);
    await assert.rejects(c.req("set_thinking", { level: "max" }), /supports low, high/);
    await assert.rejects(c.req("set_model", { provider: "openai", modelId: "nope" }), /no model "nope"/);

    assert.equal(c.state.permissionMode, "auto");
    await c.req("set_permission_mode", { mode: "read-only" });
    await c.waitFor((x) => x.state.permissionMode === "read-only", 3000);
    await c.req("set_permission_mode", { mode: "full" });
    await c.waitFor((x) => x.state.permissionMode === "full", 3000);

    const updates = h.requests("thread/settings/update").map((r) => r.params);
    assert.deepEqual(updates.map((u) => [u.model, u.effort, u.approvalPolicy, u.sandboxPolicy?.type, u.collaborationMode?.mode]), [
      ["gpt-5.6-sol", "low", undefined, undefined, undefined],
      [undefined, "ultra", undefined, undefined, undefined],
      ["gpt-text-only", "low", undefined, undefined, undefined],
      [undefined, undefined, "on-request", "readOnly", "default"],
      [undefined, undefined, "never", "dangerFullAccess", "default"],
    ]);

    // The settings stick for the next turn.
    await c.req("send", { text: "hello" });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.kind === "assistant" && !i.streaming), 5000);
    assert.equal(c.items.find((i) => i.kind === "assistant").model, "openai/gpt-text-only");
    assert.equal(h.requests("turn/start")[0].params.summary, "auto", "thinking summaries are asked for");
    h.artifact("codex-settings");
  } finally {
    await h.stop();
  }
});

test("codex: plan mode is a permission mode; the user's own config shows as a custom mode; older Codex gets settings on the next turn", async () => {
  const h = await codexHost({ name: "cx-plan-mode", scenario: { approvalPolicy: "never", sandbox: "workspace-write", settingsUpdateUnsupported: true, default: [{ text: "ok" }] } });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    // never + workspace-write is no preset: shown as it is, not silently changed.
    assert.equal(c.state.permissionMode, "custom");
    const custom = c.state.capabilities.permissionModes.find((m: any) => m.id === "custom");
    assert.equal(custom.label, "never · workspace write");

    await c.req("set_permission_mode", { mode: "plan" });
    await c.waitFor((x) => x.state.permissionMode === "plan", 3000);
    await c.req("set_thinking", { level: "high" });
    await c.req("send", { text: "plan something" });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.kind === "assistant" && !i.streaming), 5000);
    // thread/settings/update is missing (-32601): the overrides ride on turn/start.
    const start = h.requests("turn/start")[0].params;
    assert.equal(start.collaborationMode.mode, "plan");
    assert.equal(start.collaborationMode.settings.reasoning_effort, "high");
    assert.equal(start.effort, "high");
    assert.equal(start.approvalPolicy, "on-request");
    assert.equal(start.sandboxPolicy.type, "readOnly");
    // After the turn, Codex's own settings report keeps the chip.
    await c.waitFor((x) => x.state.permissionMode === "plan" && x.state.thinking === "high", 3000);
    await c.req("send", { text: "again" });
    await c.waitFor((x) => idle(x) && x.items.filter((i) => i.kind === "assistant").length === 2, 5000);
    assert.equal(h.requests("turn/start")[1].params.collaborationMode, undefined, "overrides are sent once; they stick in Codex");
    h.artifact("codex-plan-mode-custom");
  } finally {
    await h.stop();
  }
});
