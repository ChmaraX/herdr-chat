// Continue as chat asks the host which session a running agent TUI has open
// (`herdr-chat-host tui-session`), each agent its own way: Pi's lock-extension
// label, Claude Code's live-process registry, Codex's newest rollout in the
// TUI's folder since it started (one in another folder, or older, isn't it).
// The TUI is a real process (sleep), so its pid and start time are real.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HOST_ENTRY, HOST_NODE } from "./harness.ts";

const jsonl = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

function ask(provider: string, pid: number, cwd: string, env: Record<string, string>, label?: string) {
  const r = spawnSync(HOST_NODE, [HOST_ENTRY, "tui-session", "--provider", provider, "--pid", String(pid), "--cwd", cwd, ...(label ? ["--label", label] : [])],
    { encoding: "utf8", env: { ...process.env, ...env } });
  return r.status === 0 ? { ok: JSON.parse(r.stdout) } : { error: r.stderr.trim() };
}

test("tui-session: Pi by its label (with the session's model and thinking), Claude Code by its registry, Codex by its newest rollout in the folder", async () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "herdr-chat-tui-")));
  const cwd = join(d, "repo");
  mkdirSync(cwd);
  const tui = spawn("sleep", ["30"], { stdio: "ignore" });
  const pid = tui.pid!;
  await new Promise((r) => setTimeout(r, 1200)); // its start time before the Codex rollouts' writes
  try {
    // Pi: the label is the session; no label, a reason.
    const pi = join(d, "pi.jsonl");
    writeFileSync(pi, jsonl([{ type: "session", id: "s" }, { type: "model_change", provider: "anthropic", modelId: "claude-haiku-4-5" }, { type: "thinking_level_change", thinkingLevel: "low" }]));
    assert.deepEqual(ask("pi", pid, cwd, {}, pi).ok, { session: pi, model: "anthropic/claude-haiku-4-5", thinking: "low", args: ["--model", "anthropic/claude-haiku-4-5", "--thinking", "low"] });
    assert.match(ask("pi", pid, cwd, {}).error!, /restart it to load the herdr-chat-lock extension/);

    // Claude Code: <config>/sessions/<pid>.json → its transcript; none written yet, a reason.
    const claude = join(d, "claude");
    mkdirSync(join(claude, "sessions"), { recursive: true });
    writeFileSync(join(claude, "sessions", `${pid}.json`), JSON.stringify({ pid, sessionId: "abc-123", cwd }));
    assert.match(ask("claude", pid, cwd, { CLAUDE_CONFIG_DIR: claude }).error!, /no messages yet/);
    const project = join(claude, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "abc-123.jsonl"), jsonl([{ type: "user", message: { role: "user", content: "hi" } }]));
    assert.equal(ask("claude", pid, cwd, { CLAUDE_CONFIG_DIR: claude }).ok?.session, join(project, "abc-123.jsonl"));
    const other = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      assert.match(ask("claude", other.pid!, cwd, { CLAUDE_CONFIG_DIR: claude }).error!, /didn't register this process/);
    } finally {
      other.kill();
    }

    // Codex: the newest rollout in this folder written since the TUI started.
    const codex = join(d, "codex");
    const now = new Date(); // Codex files rollouts by the day they started, and looks back only so far
    const ymd = [now.getFullYear(), now.getMonth() + 1, now.getDate()].map((n) => String(n).padStart(2, "0"));
    const day = join(codex, "sessions", ...ymd);
    mkdirSync(day, { recursive: true });
    const rollout = (id: string, folder: string, model: string, ageS: number) => {
      const f = join(day, `rollout-${ymd.join("-")}T10-00-00-${id}.jsonl`);
      writeFileSync(f, jsonl([{ type: "session_meta", payload: { id, cwd: folder } }, { type: "turn_context", payload: { model, effort: "high" } }]));
      const t = new Date(Date.now() - ageS * 1000);
      utimesSync(f, t, t);
      return f;
    };
    rollout("old", cwd, "gpt-old", 3600); // before the TUI started
    rollout("other", join(d, "elsewhere"), "gpt-other", 0); // another folder
    const mine = rollout("mine", cwd, "gpt-5.6-luna", 0);
    assert.deepEqual(ask("codex", pid, cwd, { CODEX_HOME: codex }).ok, {
      session: mine, model: "openai/gpt-5.6-luna", thinking: "high", args: ["-c", 'model="gpt-5.6-luna"', "-c", 'model_reasoning_effort="high"'],
    });
  } finally {
    tui.kill();
  }
});
