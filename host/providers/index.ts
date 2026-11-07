// The adapters this host knows. The only module that imports a provider's code.
import { PiAdapter } from "./pi/adapter.ts";
import { ClaudeAdapter } from "./claude/adapter.ts";
import { CodexAdapter } from "./codex/adapter.ts";
import { piTuiSession } from "./pi/tui.ts";
import { claudeTuiSession } from "./claude/tui.ts";
import { codexTuiSession } from "./codex/tui.ts";
import type { ProviderAdapter, AdapterOptions } from "./types.ts";
import type { TuiQuery, TuiSession } from "./tui.ts";

type Factory = {
  command: string;
  create: (opts: AdapterOptions) => ProviderAdapter;
  /** Continue as chat: the session a running TUI of this agent has open (throws why not). */
  tuiSession: (q: TuiQuery) => TuiSession;
};

export const PROVIDERS: Record<string, Factory> = {
  pi: { command: "pi", create: (o) => new PiAdapter(o), tuiSession: piTuiSession },
  claude: { command: "claude", create: (o) => new ClaudeAdapter(o), tuiSession: claudeTuiSession },
  codex: { command: "codex", create: (o) => new CodexAdapter(o), tuiSession: codexTuiSession },
};

export function tuiSession(provider: string, q: TuiQuery): TuiSession {
  const f = PROVIDERS[provider];
  if (!f) throw new Error(`Unknown provider "${provider}" (known: ${providerNames().join(", ")})`);
  return f.tuiSession(q);
}

/** The agent a chat runs when none is named (a new chat with no --provider and no registry entry). */
export const DEFAULT_PROVIDER = "pi";

export function providerNames(): string[] {
  return Object.keys(PROVIDERS);
}

/** The agent command: `--<provider> <cmd>`, else `HERDR_CHAT_<PROVIDER>`, else the provider's own CLI. */
export function createAdapter(provider: string, opts: Omit<AdapterOptions, "command"> & { command?: string }): ProviderAdapter {
  const f = PROVIDERS[provider];
  if (!f) throw new Error(`Unknown provider "${provider}" (known: ${providerNames().join(", ")})`);
  return f.create({ ...opts, command: opts.command ?? process.env[`HERDR_CHAT_${provider.toUpperCase()}`] ?? f.command });
}
