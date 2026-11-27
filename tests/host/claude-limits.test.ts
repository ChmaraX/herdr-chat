// Claude Code's plan limits (rate_limit_event's unifiedWindows) saved for other programs: <state dir>/limits/claude.json,
// in the shape Claude Code hands a status line. The fake's records are shaped like Claude Code 2.1.328's, numbers made up.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { idle } from "./harness.ts";
import { startClaude } from "../fake-claude/host.ts";
import { planLimits } from "../../host/providers/claude/mapper.ts";

const limitEvent = (status: string, windows: Record<string, unknown>) =>
  ({ emit: { type: "rate_limit_event", rate_limit_info: { status, resetsAt: 1795000000, rateLimitType: "seven_day", overageStatus: "rejected", isUsingOverage: false, unifiedWindows: windows } } });

test("planLimits: a fraction becomes a % with one decimal, capped at 100; a window without a number is left out", () => {
  assert.deepEqual(planLimits({ five_hour: { utilization: 0.1234, resetsAt: 1795000000 }, seven_day: { utilization: 0.53, resetsAt: 1795500000 } }),
    { five_hour: { used_percentage: 12.3, resets_at: 1795000000 }, seven_day: { used_percentage: 53, resets_at: 1795500000 } });
  assert.deepEqual(planLimits({ seven_day: { utilization: 1.4 } }), { seven_day: { used_percentage: 100, resets_at: null } });
  assert.deepEqual(planLimits({ five_hour: { utilization: "0.5" }, seven_day_overage_included: { utilization: 0.2, resetsAt: 1 } }), null);
  assert.equal(planLimits(undefined), null);
});

test("claude: the limits a turn reports are saved for other programs; nothing else of the event is, and a rejection still warns", async () => {
  const h = await startClaude({
    name: "claude-limits",
    scenario: { turns: [
      { match: "first", steps: [limitEvent("allowed", { five_hour: { utilization: 0.25, resetsAt: 1795000000 }, seven_day: { utilization: 0.531, resetsAt: 1795500000 } }), { text: "ok" }] },
      { match: "second", steps: [limitEvent("rejected", { seven_day: { utilization: 1, resetsAt: 1795500000 } }), { text: "ok" }] },
      { match: "third", steps: [{ emit: { type: "rate_limit_event", rate_limit_info: { status: "allowed" } } }, { text: "ok" }] },
    ] },
  });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000, "started");
    const file = join(h.stateDir, "limits", "claude.json");
    assert.ok(!existsSync(file), "nothing before a report");

    const before = Math.floor(Date.now() / 1000);
    await c.req("send", { text: "first" });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.kind === "assistant" && !i.streaming), 10_000, "first answered");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    assert.ok(saved.at >= before && saved.at <= Math.floor(Date.now() / 1000) + 1, "when it was seen, in seconds");
    assert.deepEqual({ ...saved, at: 0 }, { at: 0, five_hour: { used_percentage: 25, resets_at: 1795000000 }, seven_day: { used_percentage: 53.1, resets_at: 1795500000 } });
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(join(h.stateDir, "limits")).mode & 0o777, 0o700);
    assert.ok(!c.items.some((i) => i.kind === "notice"), "an allowed report is no notice");

    await c.req("send", { text: "second" });
    await c.waitFor((x) => idle(x) && x.items.filter((i) => i.kind === "assistant" && !i.streaming).length === 2, 10_000, "second answered");
    const next = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(next.seven_day, { used_percentage: 100, resets_at: 1795500000 });
    assert.deepEqual(next.five_hour, { used_percentage: 25, resets_at: 1795000000 }, "a window the report doesn't name keeps its last number");
    assert.ok(c.items.some((i) => i.kind === "notice" && /rate limited \(seven_day\)/.test(i.text)), "a rejection still warns");

    await c.req("send", { text: "third" });
    await c.waitFor((x) => idle(x) && x.items.filter((i) => i.kind === "assistant" && !i.streaming).length === 3, 10_000, "third answered");
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), next, "an event without windows leaves the file as it was");
  } finally {
    await h.stop();
  }
});
