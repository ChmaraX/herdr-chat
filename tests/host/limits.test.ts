// The account's usage limits (state.limits) through the real host: Claude Code's
// rate_limit_event windows and Codex's account/rateLimits/updated, as the chat's
// footer chip shows them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { idle } from "./harness.ts";
import { startClaude } from "../fake-claude/host.ts";
import { codexHost } from "../fake-codex/host.ts";

const RESET_5H = 1796040000; // epoch seconds, as both CLIs send them
const RESET_WEEK = 1796061600;

const answered = (text: string) => (x: any) => idle(x) && x.items.some((i: any) => i.kind === "assistant" && i.text === text && !i.streaming);

// A rate_limit_event as Claude Code 2.1 sends it: the limiting window on top, every window it tracks in unifiedWindows.
const rateLimit = (windows: object | undefined, status = "allowed") => ({
  emit: {
    type: "rate_limit_event",
    rate_limit_info: { status, resetsAt: RESET_WEEK, rateLimitType: "seven_day", overageStatus: "rejected", isUsingOverage: false, ...(windows ? { unifiedWindows: windows } : {}) },
  },
});

test("claude: rate_limit_event windows become state.limits; each report replaces the last, one without windows keeps it, a rejected one still warns", async () => {
  const h = await startClaude({
    name: "claude-limits",
    speed: 4,
    scenario: {
      turns: [
        {
          match: "first",
          steps: [
            rateLimit({ five_hour: { utilization: 0.12, resetsAt: RESET_5H, status: "allowed" }, seven_day: { utilization: 0.57, resetsAt: RESET_WEEK, status: "allowed" } }),
            { text: "one" },
          ],
        },
        // The 5-hour window is gone from the account state: gone from the chat too.
        { match: "second", steps: [rateLimit({ seven_day: { utilization: 0.6, resetsAt: RESET_WEEK, status: "allowed_warning", surpassedThreshold: 0.5 } }), { text: "two" }] },
        // An older Claude Code (or an API key): no windows, nothing to replace the last report with.
        { match: "third", steps: [rateLimit(undefined), { text: "three" }] },
        { match: "fourth", steps: [rateLimit({ seven_day: { utilization: 1.02, resetsAt: RESET_WEEK, status: "rejected", surpassedThreshold: 1 } }, "rejected"), { text: "four" }] },
      ],
    },
  });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    assert.equal(c.state.limits, null, "nothing reported before the first response");

    await c.req("send", { text: "first" });
    await c.waitFor(answered("one"), 10_000);
    assert.deepEqual(c.state.limits, [
      { id: "five_hour", label: "5h", usedPercent: 12, resetsAt: RESET_5H * 1000 },
      { id: "seven_day", label: "week", usedPercent: 57, resetsAt: RESET_WEEK * 1000 },
    ]);

    await c.req("send", { text: "second" });
    await c.waitFor(answered("two"), 10_000);
    assert.deepEqual(c.state.limits, [{ id: "seven_day", label: "week", usedPercent: 60, resetsAt: RESET_WEEK * 1000 }]);

    const before = c.state.sessionFile;
    await c.req("new_session");
    await c.waitFor((x) => idle(x) && x.state.sessionFile !== before, 10_000, "a new session");
    assert.deepEqual(c.state.limits, [{ id: "seven_day", label: "week", usedPercent: 60, resetsAt: RESET_WEEK * 1000 }], "a new session keeps them: they're the account's");

    await c.req("send", { text: "third" });
    await c.waitFor(answered("three"), 10_000);
    assert.deepEqual(c.state.limits, [{ id: "seven_day", label: "week", usedPercent: 60, resetsAt: RESET_WEEK * 1000 }]);
    assert.ok(!c.items.some((i) => i.kind === "notice" && /rate limited/.test(i.text)), "allowed and allowed_warning don't warn");

    await c.req("send", { text: "fourth" });
    await c.waitFor(answered("four"), 10_000);
    assert.deepEqual(c.state.limits, [{ id: "seven_day", label: "week", usedPercent: 102, resetsAt: RESET_WEEK * 1000 }], "past the cap reads over 100");
    assert.ok(c.items.some((i) => i.kind === "notice" && /^Claude Code is rate limited \(seven_day\) until /.test(i.text)));
    h.artifact("claude-limits");
  } finally {
    await h.stop();
  }
});

test("codex: account/rateLimits/updated becomes state.limits, its windows named by their length; another bucket's leaves them", async () => {
  const h = await codexHost({
    name: "cx-limits",
    scenario: {
      prompts: [{
        match: "limits",
        steps: [
          {
            emit: {
              method: "account/rateLimits/updated",
              params: {
                rateLimits: {
                  limitId: "codex", limitName: null, planType: "plus", credits: { hasCredits: false, unlimited: false, balance: "0" },
                  primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: RESET_5H },
                  secondary: { usedPercent: 57, windowDurationMins: 10080, resetsAt: RESET_WEEK },
                },
              },
            },
          },
          { text: "ok" },
        ],
      }, {
        match: "other bucket",
        steps: [
          { emit: { method: "account/rateLimits/updated", params: { rateLimits: { limitId: "codex_other", limitName: "Other model", primary: { usedPercent: 99, windowDurationMins: 300, resetsAt: RESET_5H } } } } },
          { text: "still ok" },
        ],
      }],
    },
  });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "limits please" });
    await c.waitFor(answered("ok"), 10_000);
    assert.deepEqual(c.state.limits, [
      { id: "primary", label: "5h", usedPercent: 12, resetsAt: RESET_5H * 1000 },
      { id: "secondary", label: "week", usedPercent: 57, resetsAt: RESET_WEEK * 1000 },
    ]);
    assert.ok(!c.state.statuses.some((s: any) => s.key === "codex-limits"), "no longer a status nobody sees");
    const limits = c.state.limits;

    await c.req("send", { text: "the other bucket" });
    await c.waitFor(answered("still ok"), 10_000);
    assert.deepEqual(c.state.limits, limits, "a per-model bucket doesn't replace the account's numbers");
  } finally {
    await h.stop();
  }
});
