#!/usr/bin/env node
// pi-chat-host: serve | inspect | send | op
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { Chat } from "./chat.ts";
import { ChatServer } from "./server.ts";
import { Terminal } from "./terminal.ts";
import { writeRegistry, readRegistry, pidAlive } from "./registry.ts";
import type { RegistryEntry } from "./registry.ts";
import { ChatClient, parseWait } from "./client.ts";
import { createAdapter, providerNames } from "./providers/index.ts";
import { parseArgs } from "./args.ts";
import type { Args } from "./args.ts";
import { appHomeOf, labelSelf, newChatId, planSubagent, readChatConfig } from "./subagent.ts";
import { PaneWatch } from "./panewatch.ts";

const USAGE = `pi-chat-host serve   --chat <id> --cwd <dir> --state-dir <dir> [--provider pi] [--session <file>] [--after-pid <pid> [--model <provider/id>] [--thinking <level>]] [--app-home <dir>] [--<provider> <cmd>] [-- <agent args>]
  (--app-home: the Herdr app's home, whose app it asks to close its hidden pane once its chat's pane is gone; default $HERDR_APP_HOME, else ~/.config/herdr-app)
  (--provider defaults to the chat's registered provider, else pi; --pi <cmd> or PI_CHAT_PI picks the pi binary)
pi-chat-host run     [--provider pi|claude|codex] [--session <file>] [--cwd <dir>] [-- <agent args>]
  (a sub-agent chat, for \`hc run\`: a fresh chat id, the app's state dir and the chat mod's config.json, labels its own terminal)
pi-chat-host inspect --chat <id> --state-dir <dir> [--wait 'phase=idle,items>=3'] [--timeout <s>]
  (inspect/send/op wait up to --timeout seconds, default 10 s for connecting and 30 s for --wait, for a starting host)
pi-chat-host send    --chat <id> --state-dir <dir> [--mode auto|steer|followUp] [--image <path>]... <text>
pi-chat-host op      --chat <id> --state-dir <dir> <op> ['<json args>']`;

function die(msg: string): never {
  process.stderr.write(`pi-chat-host: ${msg}\n`);
  process.exit(2);
}

function defaultStateDir(): string {
  return join(homedir(), ".local", "state", "pi-chat");
}

async function serve(a: Args, extra: { hint?: string; warning?: string | null } = {}): Promise<void> {
  const chatId = a.flags.get("chat")?.[0] ?? die("serve needs --chat");
  if (!/^[\w.-]+$/.test(chatId)) die("--chat must be [A-Za-z0-9_.-]");
  const cwd = resolve(a.flags.get("cwd")?.[0] ?? process.cwd());
  const stateDir = resolve(a.flags.get("state-dir")?.[0] ?? defaultStateDir());
  const sessionArg = a.flags.get("session")?.[0];
  const session = sessionArg ? resolve(sessionArg) : null;
  const previous = readRegistry(stateDir, chatId);
  const provider = a.flags.get("provider")?.[0] ?? previous?.provider ?? "pi";
  if (!providerNames().includes(provider)) die(`unknown --provider ${provider} (known: ${providerNames().join(", ")})`);
  const agentCommand = a.flags.get(provider)?.[0];
  // --after-pid: the Pi TUI this chat takes over (chat-menu's Continue as
  // chat), waited for while it lives; --model provider/id and --thinking: the
  // TUI's, applied once the agent is up. Only on the hand-over (this chat's
  // first start, or that pid still alive): a restart of the chat later (its
  // tab keeps the props) keeps the chat's own choices.
  const afterPid = Number(a.flags.get("after-pid")?.[0]) || null;
  const handOver = Boolean(afterPid && session && (!previous || pidAlive(afterPid)));
  const handModel = handOver ? a.flags.get("model")?.[0] ?? null : null;
  const handThinking = handOver ? a.flags.get("thinking")?.[0] ?? null : null;
  const terminalId = process.env.HC_TERMINAL_ID ?? null;
  const token = randomBytes(32).toString("hex");
  const logDir = join(stateDir, "logs");
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const logFile = join(logDir, `${chatId}.log`);
  const log = (msg: string) => {
    try {
      appendFileSync(logFile, `${new Date().toISOString()} ${msg}\n`);
    } catch {}
  };
  const adapter = createAdapter(provider, { cwd, args: a.after, log, ...(agentCommand ? { command: agentCommand } : {}) });
  log(`serve chat=${chatId} cwd=${cwd} session=${session ?? "-"} provider=${provider} cmd=${agentCommand ?? "(default)"} pid=${process.pid}`);

  // Images saved by an earlier run of this chat belong to items that no longer exist.
  rmSync(join(stateDir, "images", chatId), { recursive: true, force: true });
  const startedAt = Date.now();
  let entry: RegistryEntry = {
    v: 1, chat: chatId, pid: process.pid, port: null, token, cwd,
    provider,
    // A session of another provider can't be resumed by this one.
    sessionFile: session ?? ((previous?.provider ?? "pi") === provider ? previous?.sessionFile ?? null : null),
    terminal: terminalId, startedAt, piVersion: null,
  };
  const save = (patch: Partial<RegistryEntry>) => {
    entry = { ...entry, ...patch };
    try {
      writeRegistry(stateDir, entry);
    } catch (e) {
      log(`registry write failed: ${e}`);
    }
  };

  let shuttingDown = false;
  const term = new Terminal(process.stdout, process.stdin, provider);
  const chat = new Chat({
    chat: chatId, cwd, session, adapter, terminal: terminalId, log,
    afterPid: handOver ? afterPid : null,
    imageDir: join(stateDir, "images", chatId),
    stateDir,
    hcCommand: process.env.PI_CHAT_HC || "hc",
    ...(Number(process.env.PI_CHAT_HANDOFF_POLL_MS) > 0 ? { handoffPollMs: Number(process.env.PI_CHAT_HANDOFF_POLL_MS) } : {}),
    ...(Number(process.env.PI_CHAT_HANDOFF_GRACE_MS) >= 0 && process.env.PI_CHAT_HANDOFF_GRACE_MS ? { handoffGraceMs: Number(process.env.PI_CHAT_HANDOFF_GRACE_MS) } : {}),
    onSessionFile: (f) => {
      if (f && f !== entry.sessionFile) save({ sessionFile: f });
    },
    onVersion: (v) => save({ piVersion: v }),
    onShutdown: () => void exit(0),
  });
  const server = new ChatServer(chat, token, log);
  chat.onTerminalState = (s, m) => term.status(s, m);
  chat.sinks.push({
    patch: (p) => {
      term.observe(p.upsert);
      term.title(chat.chatTitle());
    },
    snapshot: () => {
      term.reset();
      term.observe(chat.timeline.items);
      term.title(chat.chatTitle());
    },
    toast: (level, text) => term.line(`${level === "info" ? "·" : "!"} ${text}`),
    bye: () => {},
  });
  term.onSubmit = (text, from) => {
    chat.send({ text, source: "external", ...(from ? { from } : {}) }).catch((e) => term.line(`! ${e instanceof Error ? e.message : e}`));
  };
  term.onAbort = () => void chat.abort();

  // Its chat's pane closed: its own hidden pane (and the tab) closes, then it exits (panewatch.ts).
  const watch = terminalId
    ? new PaneWatch({ chat: chatId, terminal: terminalId, appHome: resolve(a.flags.get("app-home")?.[0] ?? appHomeOf(process.env, homedir())),
        hc: process.env.PI_CHAT_HC || "hc", log, onGone: () => void exit(0) })
    : null;
  const exit = async (code: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("shutting down");
    watch?.stop();
    try {
      await chat.stopAgent();
    } catch {}
    chat.releaseLock();
    save({ pid: null, port: null });
    term.status("idle");
    term.close();
    await server.close().catch(() => {});
    process.exit(code);
  };
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, () => void exit(0));
  process.on("exit", () => chat.killAgent());
  process.on("uncaughtException", (e) => {
    log(`uncaught: ${e?.stack ?? e}`);
  });
  process.on("unhandledRejection", (e) => {
    log(`unhandled rejection: ${(e as Error)?.stack ?? e}`);
  });

  const port = await server.listen();
  save({ port });
  term.line(`pi-chat-host · chat ${chatId} · ${cwd}`);
  if (extra.hint) term.line(extra.hint);
  if (extra.warning) term.line(`! ${extra.warning}`);
  term.status("idle");
  term.title(chat.chatTitle());
  term.start();
  watch?.start();
  if (handOver && pidAlive(afterPid!)) {
    // Pi flushes and runs its session_shutdown handlers on SIGTERM; then a
    // live pid is a writer (a conflict, until resume).
    const waitMs = Number(process.env.PI_CHAT_AFTER_PID_WAIT_MS) || 10_000;
    log(`waiting up to ${waitMs} ms for pid ${afterPid} to exit`);
    for (const t0 = Date.now(); pidAlive(afterPid!) && Date.now() - t0 < waitMs; ) await new Promise((r) => setTimeout(r, 100));
  }
  chat.start(entry.sessionFile);
  if (handModel || handThinking) {
    void chat.whenReady().then(async () => {
      if (chat.state.phase === "conflict") return;
      const slash = handModel?.indexOf("/") ?? -1;
      if (handModel && slash > 0) await chat.setModel(handModel.slice(0, slash), handModel.slice(slash + 1)).catch((e) => log(`--model ${handModel}: ${e}`));
      if (handThinking) await chat.setThinking(handThinking).catch((e) => log(`--thinking ${handThinking}: ${e}`));
    });
  }
}

async function withClient<T>(a: Args, fn: (c: ChatClient) => Promise<T>): Promise<T> {
  const chatId = a.flags.get("chat")?.[0] ?? die("needs --chat");
  const stateDir = resolve(a.flags.get("state-dir")?.[0] ?? defaultStateDir());
  // The host may still be starting: wait for its registry entry and a welcome.
  const timeoutMs = Number(a.flags.get("timeout")?.[0] ?? "10") * 1000;
  const t0 = Date.now();
  let c: ChatClient;
  for (;;) {
    try {
      c = await ChatClient.fromRegistry(stateDir, chatId, "cli");
      break;
    } catch (e) {
      if (Date.now() - t0 > timeoutMs) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try {
    return await fn(c);
  } finally {
    c.close();
  }
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  switch (a.cmd) {
    case "serve":
      return serve(a);
    case "run": {
      // A sub-agent chat (bin/pi-chat-subagent): a fresh chat, the app's state dir, the mod's config, self-labels.
      let plan;
      try {
        const appHome = appHomeOf(process.env, homedir());
        plan = planSubagent({ args: a, env: process.env, cwd: process.cwd(), home: homedir(), config: readChatConfig(appHome), chat: newChatId() });
      } catch (e) {
        die(e instanceof Error ? e.message : String(e));
      }
      Object.assign(process.env, plan.env);
      const warning = labelSelf(plan);
      return serve(plan.serve, { hint: plan.hint, warning });
    }
    case "inspect": {
      const startedAt = Date.now();
      return withClient(a, async (c) => {
        const spec = a.flags.get("wait")?.[0];
        if (spec) {
          const timeout = Number(a.flags.get("timeout")?.[0] ?? "30") * 1000 - (Date.now() - startedAt);
          await c.waitFor(parseWait(spec), timeout, spec).catch((e) => {
            process.stdout.write(JSON.stringify({ state: c.state, items: c.items, hasOlder: c.hasOlder }, null, 2) + "\n");
            die(e.message);
          });
        }
        process.stdout.write(JSON.stringify({ state: c.state, items: c.items, hasOlder: c.hasOlder }, null, 2) + "\n");
      });
    }
    case "send":
      return withClient(a, async (c) => {
        const text = a.rest.join(" ");
        const data = await c.req("send", { text, mode: a.flags.get("mode")?.[0] ?? "auto", images: a.flags.get("image") ?? [] });
        process.stdout.write(JSON.stringify(data) + "\n");
      });
    case "op":
      return withClient(a, async (c) => {
        const [op, json] = a.rest;
        if (!op) die("op needs a name");
        const data = await c.req(op, json ? JSON.parse(json) : {}, 120_000);
        process.stdout.write(JSON.stringify(data, null, 2) + "\n");
      });
    default:
      process.stdout.write(USAGE + "\n");
      process.exit(a.cmd === "help" || a.cmd === "--help" ? 0 : 2);
  }
}

main().catch((e) => die(e instanceof Error ? e.message : String(e)));
