import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { startHost, idle, Host } from "./harness.ts";
import { lockPath } from "../../host/registry.ts";

/** What a user sees of an item, without ids, timestamps and live-only timing. */
function seen(items: any[]): any[] {
  return items
    .filter((i) => i.kind !== "notice")
    .map((i) => {
      const { id, ts, durationMs, source, ...rest } = i;
      void id, ts, source;
      if (i.kind === "tool") return { ...rest, ran: durationMs !== undefined };
      return rest;
    });
}

test("resume from history: a restarted host on the same session shows the same timeline as live", async () => {
  const live = await startHost({ name: "resume-live", scenario: "tools.json", speed: 5 });
  let liveItems: any[];
  let file: string;
  try {
    const c = live.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "Look around the repo" });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.kind === "assistant" && i.text.startsWith("Done.")), 15_000);
    await c.req("send", { text: "And a second prompt" });
    await c.waitFor((x) => idle(x) && x.items.filter((i) => i.kind === "user").length === 2 && x.items.at(-1).kind === "assistant" && !x.items.at(-1).streaming, 5000);
    liveItems = structuredClone(c.items);
    file = c.state.sessionFile;
    live.artifact("resume-live");
  } finally {
    await live.stop();
  }
  // A clean exit keeps the session in the registry, clears pid/port, releases the lock.
  const reg = live.registry!;
  assert.equal(reg.pid, null);
  assert.equal(reg.port, null);
  assert.equal(reg.sessionFile, file);
  assert.ok(!existsSync(lockPath(file)));

  // Same state dir and chat, no --session: the host reopens the registry's session.
  const again = await new Host({ name: "resume-again", scenario: "tools.json", speed: 5, dir: live.dir }).start();
  try {
    const c = again.client;
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.kind === "tool"), 10_000, "history loaded");
    assert.equal(c.state.sessionFile, file);
    assert.ok(existsSync(lockPath(file)), "lock retaken");
    assert.deepEqual(seen(c.items), seen(liveItems));
    // Thinking timing is live-only; everything else matches, including tool durations.
    assert.ok(c.items.filter((i) => i.kind === "tool").every((t) => typeof t.durationMs === "number"));
    again.artifact("resume-from-history", { liveItems: seen(liveItems) });
  } finally {
    await again.stop();
  }
});
