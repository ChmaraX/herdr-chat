// herdr-chat-host for Windows, where there's no sh for bin/herdr-chat-host: run with node,
// `node herdr-chat-host.mjs [NAME=value]... <host args>`. The leading NAME=value arguments go
// into the environment, as /usr/bin/env does on macOS and Linux; then host/main.js (a release)
// or host/main.ts (a clone) runs with the rest.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
while (args.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[0])) {
  const a = args.shift();
  const i = a.indexOf("=");
  process.env[a.slice(0, i)] = a.slice(i + 1);
}
// herdr-chat-subagent.mjs sets this: the host's `run`.
if (process.env.HERDR_CHAT_ENTRY_RUN === "1") {
  delete process.env.HERDR_CHAT_ENTRY_RUN;
  args.unshift("run");
}

if (args[0] === "core-rpc") await coreRpc(args.slice(1));
else {
  process.argv.splice(2, process.argv.length - 2, ...args);
  const js = new URL("../host/main.js", import.meta.url);
  await import(existsSync(fileURLToPath(js)) ? js.href : new URL("../host/main.ts", import.meta.url).href);
}

/**
 * `core-rpc --lines-file <file> [--at <epoch ms>]`, for the chat mod's hostpane.js where macOS and
 * Linux pipe printf into `hc connect`: the file's first line goes to `hc connect`, the rest at --at;
 * hc's output as is, its exit code; the file is deleted. Here, before the host loads: the mod waits
 * on it while it edits the layout document. Any failure (no file, no lines, hc that won't start or
 * closes early) is one line on stderr and exit 1, never a stack trace.
 */
async function coreRpc(rest) {
  const flag = (name) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const file = flag("--lines-file");
  if (!file) {
    process.stderr.write("herdr-chat-host: core-rpc needs --lines-file <file>\n");
    process.exit(2);
  }
  const at = Number(flag("--at")) || 0;
  const die = (why) => {
    process.stderr.write(`herdr-chat-host: core-rpc: ${why}\n`);
    process.exit(1);
  };
  let lines = [];
  try {
    lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  } catch (e) {
    die(`can't read ${file}: ${e.message}`);
  } finally {
    rmSync(file, { force: true });
  }
  if (!lines.length) die(`${file} has no lines to send`);
  const { spawn } = await import("node:child_process");
  const p = spawn(process.env.HERDR_CHAT_HC || "hc", ["connect"], { stdio: ["pipe", "inherit", "inherit"], windowsHide: true });
  p.on("error", (e) => die(`hc connect: ${e.message}`));
  p.stdin.on("error", () => {}); // hc closed early: its exit code says why
  p.on("close", (c) => process.exit(c ?? 1));
  p.stdin.write(lines[0] + "\n");
  const wait = at - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  for (const l of lines.slice(1)) p.stdin.write(l + "\n");
  p.stdin.end();
}
