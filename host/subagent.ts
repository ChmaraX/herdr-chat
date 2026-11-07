// `herdr-chat-host run` (bin/herdr-chat-subagent): a chat host started by another
// agent with `hc run`, as it would start `pi`. The core records that agent as
// its parent; the host reports status, takes `hc send` and prints a transcript
// for `hc read` like any chat host. What the parent can't be expected to pass,
// the launcher works out (docs/dev/research/subagent-chat.md §A):
// - a fresh chat id, never a reused one (`serve` resumes a known id's session);
// - the app's state dir, where the mod looks for the chat's registry entry;
// - the agent's command, arguments and environment from install's config and
//   the person's settings (host/settings.ts; a core
//   terminal's environment lacks the login PATH for explicit commands);
// - its own labels, so the agents list and the menu can open it as a chat
//   (`herdr-chat.chat`) and no chat view takes it for an orphan
//   (`herdr-chat.role=subagent`, never `host`).
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import type { Args } from "./args.ts";
import { DEFAULT_PROVIDER, providerNames } from "./providers/index.ts";
import type { ChatConfig } from "./settings.ts";

export type SubagentPlan = {
  chat: string;
  appHome: string;
  stateDir: string;
  provider: string;
  terminal: string | null;
  hc: string;
  /** Labels for the launcher's own terminal (`hc label $HC_TERMINAL_ID …`). */
  labels: string[];
  /** Environment the config adds (the caller's own values win). */
  env: Record<string, string>;
  /** What `serve` gets. */
  serve: Args;
  /** The transcript's second line (`hc read`, the Rust peek). */
  hint: string;
};

export function appHomeOf(env: NodeJS.ProcessEnv, home: string): string {
  return env.HERDR_APP_HOME || join(home, ".config", "herdr-app");
}

export const newChatId = (): string => `c-${randomBytes(4).toString("hex")}`;


/** Pure: what the launcher does, from its arguments, environment and the chat mod's config. */
export function planSubagent(o: { args: Args; env: NodeJS.ProcessEnv; cwd: string; home: string; config: ChatConfig; chat: string }): SubagentPlan {
  const { args: a, env, config } = o;
  if (a.flags.has("chat")) throw new Error("run makes its own chat id (--chat is for serve)");
  const provider = a.flags.get("provider")?.[0] ?? DEFAULT_PROVIDER;
  if (!providerNames().includes(provider)) throw new Error(`unknown --provider ${provider} (known: ${providerNames().join(", ")})`);
  const appHome = appHomeOf(env, o.home);
  const stateDir = join(appHome, "data", "herdr-chat");
  const cwd = resolve(o.cwd, a.flags.get("cwd")?.[0] ?? ".");
  const flags = new Map<string, string[]>([["chat", [o.chat]], ["cwd", [cwd]], ["state-dir", [stateDir]], ["provider", [provider]]]);
  const session = a.flags.get("session")?.[0];
  if (session) flags.set("session", [resolve(o.cwd, session)]);
  // The agent's command: the caller's --<provider>, else the config's (host/settings.ts).
  const settings = config.agent(provider);
  const agent = a.flags.get(provider)?.[0] ?? settings.command;
  if (agent) flags.set(provider, [agent]);
  const cfgArgs = settings.args;
  const extra: Record<string, string> = {};
  for (const [k, v] of Object.entries(settings.env)) if (env[k] === undefined) extra[k] = v;
  if (config.node && env.HERDR_CHAT_NODE === undefined) extra.HERDR_CHAT_NODE = config.node;
  return {
    chat: o.chat, appHome, stateDir, provider,
    terminal: env.HC_TERMINAL_ID || null,
    hc: env.HERDR_CHAT_HC || config.hc || "hc",
    labels: [`herdr-chat.chat=${o.chat}`, "herdr-chat.role=subagent", `herdr-chat.provider=${provider}`],
    env: extra,
    serve: { cmd: "serve", flags, rest: [], after: [...cfgArgs, ...a.after] },
    hint: `sub-agent chat · in Herdr: right-click → Open as chat`,
  };
}

/** Label the launcher's own terminal. A failure is a warning: the host still serves its parent. */
export function labelSelf(plan: SubagentPlan): string | null {
  if (!plan.terminal) return "not in a herdr-core terminal (no HC_TERMINAL_ID): no labels, the agents list shows its TUI peek";
  try {
    execFileSync(plan.hc, ["label", plan.terminal, ...plan.labels], { timeout: 5000, stdio: ["ignore", "ignore", "pipe"] });
    return null;
  } catch (e) {
    const err = e as { stderr?: Buffer; message?: string };
    return `hc label ${plan.terminal}: ${(err.stderr?.toString() || err.message || String(e)).trim()}`;
  }
}
