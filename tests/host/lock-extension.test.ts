// The herdr-chat-lock extension in a Pi TUI that runs in a herdr-core
// terminal: it labels its terminal with the session it opens
// (herdr-chat.session=<file>), on start and after a switch, so Herdr's right-click
// menu can offer Continue as chat (mod new-chat's continueAsChat). The
// extension runs with a stand-in for Pi's ExtensionAPI and fake-hc for `hc`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ROOT, sleep } from "./harness.ts";

// A variable path: tsc doesn't resolve the extension's Pi type imports (Pi isn't a dependency here).
const EXT = join(ROOT, "extension", "herdr-chat-lock.ts");

async function load(env: Record<string, string | undefined>) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
  const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
  const mod = await import(EXT);
  mod.default({ on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => (handlers[name] = fn) });
  const start = (file: string) => handlers.session_start?.({ reason: "startup" }, { hasUI: false, sessionManager: { getSessionFile: () => file } });
  return { handlers, start, restore: () => { process.env = saved; } };
}

async function labels(dir: string, n: number): Promise<{ terminal: string; labels: string[] }[]> {
  const f = join(dir, "label.log");
  for (const t0 = Date.now(); Date.now() - t0 < 5000; await sleep(20)) {
    const lines = existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean) : [];
    if (lines.length >= n) return lines.map((l) => JSON.parse(l));
  }
  return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}

test("lock extension: in a core terminal, each session Pi opens (start, then a switch) labels the terminal herdr-chat.session=<file>", async () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-chat-ext-"));
  const x = await load({ HC_TERMINAL_ID: "t7", HERDR_CHAT_HC: join(ROOT, "tests", "fake-hc", "hc.mjs"), FAKE_HC_DIR: dir, HERDR_CHAT_HOST: undefined, HERDR_CHAT_HANDOFF: undefined });
  try {
    x.start("/s/first.jsonl");
    x.start("/s/after-resume.jsonl"); // Pi emits session_start again after /resume, /new, /fork
    assert.deepEqual(await labels(dir, 2), [
      { terminal: "t7", labels: ["herdr-chat.session=/s/first.jsonl"] },
      { terminal: "t7", labels: ["herdr-chat.session=/s/after-resume.jsonl"] },
    ]);
  } finally {
    x.restore();
  }
});

test("lock extension: no label outside a core terminal, nor in a chat host's own Pi (HERDR_CHAT_HOST=1)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-chat-ext-"));
  const hc = join(ROOT, "tests", "fake-hc", "hc.mjs");
  const outside = await load({ HC_TERMINAL_ID: undefined, HERDR_CHAT_HC: hc, FAKE_HC_DIR: dir, HERDR_CHAT_HOST: undefined });
  try { outside.start("/s/a.jsonl"); } finally { outside.restore(); }
  const host = await load({ HC_TERMINAL_ID: "t8", HERDR_CHAT_HC: hc, FAKE_HC_DIR: dir, HERDR_CHAT_HOST: "1" });
  try {
    assert.equal(host.handlers.session_start, undefined, "the extension stays out of the host's Pi");
  } finally {
    host.restore();
  }
  await sleep(300);
  assert.equal(existsSync(join(dir, "label.log")), false);
});
