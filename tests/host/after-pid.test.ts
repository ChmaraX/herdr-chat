// A Pi TUI's /chat (extension herdr-chat-lock) opens a chat on its session and
// quits: the chat's host starts with --after-pid <the TUI's pid>, and opens the
// session only once that pid is gone (up to 10 s), so the two never write it
// at once. A pid that stays is a writer: the chat shows a conflict, and
// resume opens the session once it's gone. --model/--thinking: the TUI's,
// applied once the agent is up (a TUI started with `pi --session f --model m`
// never recorded m in the session).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { startHost, idle, sleep, Host } from "./harness.ts";
import { readLock } from "../../host/registry.ts";

const answered = (text: string) => (x: any) => idle(x) && x.items.some((i: any) => i.kind === "assistant" && i.text === `ok: ${text}`);

/** A stand-in TUI: a process that lives `ms` (0: until killed). */
function holder(ms: number) {
  const p = spawn(process.execPath, ["-e", ms ? `setTimeout(() => {}, ${ms})` : "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const exited = new Promise<number>((r) => p.on("exit", () => r(Date.now())));
  return { pid: p.pid!, exited, kill: () => p.kill() };
}

async function session(name: string): Promise<{ dir: string; file: string }> {
  const a = await startHost({ name, chat: "c-tui" });
  try {
    await a.client.waitFor(idle, 10_000);
    await a.client.req("send", { text: "said in the TUI" });
    await a.client.waitFor(answered("said in the TUI"), 5000);
    return { dir: a.dir, file: a.client.state.sessionFile! };
  } finally {
    await a.stop();
  }
}

test("after-pid: the chat waits for the TUI to exit, then opens its session (no conflict) on the TUI's model and thinking", async () => {
  const { dir, file } = await session("ap-wait");
  const tui = holder(1200);
  let b: Host | null = null;
  try {
    const before = existsSync(`${dir}/pi-commands.jsonl`) ? readFileSync(`${dir}/pi-commands.jsonl`, "utf8").split("\n").filter(Boolean).length : 0;
    b = await new Host({ name: "ap-wait-b", dir, chat: "c-b", session: file, hostArgs: ["--after-pid", String(tui.pid), "--model", "openai-codex/gpt-5.6-luna", "--thinking", "high"] }).start();
    await sleep(700);
    assert.notEqual(b.client.state.phase, "conflict");
    assert.equal(readLock(file), null, "nothing holds the session while the TUI lives");
    assert.equal(b.piCommands().length, before, "the agent hasn't started");
    await tui.exited;
    await b.client.waitFor((x) => idle(x) && x.items.some((i) => i.text === "ok: said in the TUI"), 10_000, "the session's history");
    assert.equal(b.client.state.conflict, null);
    assert.equal(readLock(file)!.chat, "c-b");
    await b.client.waitFor((x) => x.state.model?.id === "gpt-5.6-luna" && x.state.thinking === "high", 5000, "the TUI's model and thinking");
    b.artifact("after-pid-wait");
  } finally {
    tui.kill();
    await b?.stop();
  }
});

test("after-pid: a TUI that doesn't exit is a writer: conflict, then resume once it's gone", async () => {
  const { dir, file } = await session("ap-stay");
  const tui = holder(0);
  let b: Host | null = null;
  try {
    b = await new Host({ name: "ap-stay-b", dir, chat: "c-b", session: file, env: { HERDR_CHAT_AFTER_PID_WAIT_MS: "800" }, hostArgs: ["--after-pid", String(tui.pid)] }).start();
    await b.client.waitFor((x) => x.state.phase === "conflict", 10_000, "conflict");
    assert.equal(b.client.state.conflict?.pid, tui.pid);
    assert.equal(readLock(file), null);
    tui.kill();
    await tui.exited;
    await b.client.req("resume");
    await b.client.waitFor((x) => idle(x) && x.items.some((i) => i.text === "ok: said in the TUI"), 10_000, "opened after resume");
    b.artifact("after-pid-stay");
  } finally {
    tui.kill();
    await b?.stop();
  }
});

test("after-pid: a TUI already gone when the host starts: the first start still takes its model and thinking; a restart of that chat keeps the chat's own", async () => {
  const { dir, file } = await session("ap-gone");
  const tui = holder(1);
  await tui.exited;
  const flags = ["--after-pid", String(tui.pid), "--model", "openai-codex/gpt-5.6-luna", "--thinking", "high"];
  let b: Host | null = null;
  try {
    b = await new Host({ name: "ap-gone-b", dir, chat: "c-b", session: file, hostArgs: flags }).start();
    await b.client.waitFor((x) => idle(x) && x.state.model?.id === "gpt-5.6-luna" && x.state.thinking === "high", 10_000, "the TUI's model and thinking");
    await b.client.req("set_model", { provider: "anthropic", modelId: "claude-sonnet-5" });
    await b.client.waitFor((x) => x.state.model?.id === "claude-sonnet-5", 5000, "the chat's own model");
    await b.stop();
    b = await new Host({ name: "ap-gone-b2", dir, chat: "c-b", session: file, hostArgs: flags }).start();
    await b.client.waitFor(idle, 10_000);
    await sleep(500);
    // (fake-pi doesn't restore a session's model on resume, so: what the hosts asked it.)
    const asked = b.piCommands().filter((c) => c.type === "set_model" || c.type === "set_thinking_level").map((c) => c.modelId ?? c.level);
    assert.deepEqual(asked, ["gpt-5.6-luna", "high", "claude-sonnet-5"], "the restart doesn't put the TUI's model back");
  } finally {
    await b?.stop();
  }
});
