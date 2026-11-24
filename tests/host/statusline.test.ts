import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StatuslineCache, safeTerminalId } from "../../host/statusline.ts";
import type { ModelInfo } from "../../host/providers/types.ts";

const makeDir = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

const modelOf = (provider: string, id: string, name: string, contextWindow: number | null = 1_000_000): ModelInfo => ({
  provider,
  id,
  name,
  reasoning: true,
  contextWindow,
  input: ["text", "image"],
});

test("StatuslineCache writes atomic JSON with expected schema for claude and agy", () => {
  const dir = makeDir("sl-schema-");
  try {
    const claude = new StatuslineCache({ dir, terminal: "t70", provider: "claude", now: () => 1_795_556_600_500 });
    claude.sync(modelOf("anthropic", "claude-sonnet-4-6", "Claude Sonnet 4.6"), {
      contextTokens: 12345,
      contextWindow: 200_000,
      percent: 6.4,
      cost: 0.04,
    });
    const claudeFile = join(dir, "t70.json");
    assert.deepEqual(JSON.parse(readFileSync(claudeFile, "utf8")), {
      terminal: "t70",
      agent: "claude",
      model: "Claude Sonnet 4.6",
      ctx_pct: 6,
      ctx_tokens: 12345,
      ctx_size: 200_000,
      cost_usd: 0.04,
      updated_at: 1_795_556_600.5,
    });

    const agy = new StatuslineCache({ dir, terminal: "t73", provider: "agy", now: () => 1_795_556_700_000 });
    agy.sync(modelOf("google", "gemini-4", "Orchestrator (Neon)", 1_048_576), {
      contextTokens: 524_288,
      contextWindow: 1_048_576,
      percent: 50.6,
      cost: null,
    });
    const agyFile = join(dir, "t73.json");
    assert.deepEqual(JSON.parse(readFileSync(agyFile, "utf8")), {
      terminal: "t73",
      agent: "agy",
      model: "Orchestrator (Neon)",
      ctx_pct: 51,
      ctx_tokens: 524_288,
      ctx_size: 1_048_576,
      cost_usd: null,
      updated_at: 1_795_556_700,
    });

    const files = readdirSync(dir).sort();
    assert.deepEqual(files, ["t70.json", "t73.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("StatuslineCache deduplicates identical sync calls and updates on changes", () => {
  const dir = makeDir("sl-dedup-");
  try {
    let t = 1_000_000;
    const cache = new StatuslineCache({ dir, terminal: "t80", provider: "agy", now: () => t });
    const m = modelOf("google", "gemini-4", "Gemini 4");
    const u = { contextTokens: 1000, contextWindow: 100_000, percent: 1, cost: null };

    cache.sync(m, u);
    const first = JSON.parse(readFileSync(join(dir, "t80.json"), "utf8"));
    assert.equal(first.updated_at, 1000);

    t = 2_000_000;
    cache.sync(m, { ...u });
    const second = JSON.parse(readFileSync(join(dir, "t80.json"), "utf8"));
    assert.equal(second.updated_at, 1000);

    t = 3_000_000;
    cache.sync(modelOf("anthropic", "claude-opus-4-6", "Claude Opus 4.6"), u);
    const third = JSON.parse(readFileSync(join(dir, "t80.json"), "utf8"));
    assert.equal(third.model, "Claude Opus 4.6");
    assert.equal(third.updated_at, 3000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("StatuslineCache writes model with null ctx_pct before turn 1 and clears stale ctx_pct on reset", () => {
  const dir = makeDir("sl-reset-");
  try {
    const cache = new StatuslineCache({ dir, terminal: "t81", provider: "claude", now: () => 5_000 });
    cache.sync(null, null);
    assert.equal(existsSync(join(dir, "t81.json")), false);

    const m = modelOf("anthropic", "claude-sonnet-4-6", "");
    cache.sync(m, null);
    const preTurn = JSON.parse(readFileSync(join(dir, "t81.json"), "utf8"));
    assert.equal(preTurn.model, "claude-sonnet-4-6");
    assert.equal(preTurn.ctx_pct, null);
    assert.equal(preTurn.ctx_tokens, null);

    cache.sync(m, { contextTokens: 40_000, contextWindow: 200_000, percent: 20, cost: 0.12 });
    const active = JSON.parse(readFileSync(join(dir, "t81.json"), "utf8"));
    assert.equal(active.ctx_pct, 20);
    assert.equal(active.cost_usd, 0.12);

    cache.sync(m, null);
    const afterReset = JSON.parse(readFileSync(join(dir, "t81.json"), "utf8"));
    assert.equal(afterReset.model, "claude-sonnet-4-6");
    assert.equal(afterReset.ctx_pct, null);
    assert.equal(afterReset.ctx_tokens, null);
    assert.equal(afterReset.cost_usd, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("StatuslineCache skips unsupported providers, empty dir, and unsafe terminal IDs", () => {
  const dir = makeDir("sl-skip-");
  try {
    assert.equal(safeTerminalId(null), null);
    assert.equal(safeTerminalId(""), null);
    assert.equal(safeTerminalId("."), null);
    assert.equal(safeTerminalId(".."), null);
    assert.equal(safeTerminalId("../x"), null);
    assert.equal(safeTerminalId("remote/t1"), null);
    assert.equal(safeTerminalId("a\\b"), null);
    assert.equal(safeTerminalId(" t72 "), "t72");

    const m = modelOf("openai", "gpt-5", "GPT-5");
    const u = { contextTokens: 100, contextWindow: 1000, percent: 10, cost: 0.01 };

    for (const opts of [
      { dir, terminal: "t1", provider: "pi" },
      { dir, terminal: "t2", provider: "codex" },
      { dir, terminal: null, provider: "claude" },
      { dir, terminal: "../x", provider: "agy" },
      { dir, terminal: "remote/t1", provider: "claude" },
      { dir, terminal: ".", provider: "agy" },
      { dir: "", terminal: "t3", provider: "claude" },
      { dir: "   ", terminal: "t4", provider: "agy" },
    ]) {
      new StatuslineCache(opts).sync(m, u);
    }

    assert.deepEqual(readdirSync(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
