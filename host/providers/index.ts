// The adapters this host knows. The only module that imports a provider's code.
import { PiAdapter } from "./pi/adapter.ts";
import { ClaudeAdapter } from "./claude/adapter.ts";
import { CodexAdapter } from "./codex/adapter.ts";
import { AgyAdapter } from "./agy/adapter.ts";
import { piTuiSession } from "./pi/tui.ts";
import { claudeTuiSession } from "./claude/tui.ts";
import { codexTuiSession } from "./codex/tui.ts";
import { agyTuiSession } from "./agy/tui.ts";
import type { ProviderAdapter, AdapterOptions } from "./types.ts";
import { processTable, tuiProcess, type TerminalView, type TuiFound, type TuiQuery, type TuiSession } from "./tui.ts";

type Factory = {
  /** The agent's CLI, also its program's name (a TUI's process is found by it). */
  command: string;
  /** For the host's messages: "Pi", "Claude Code", "Codex". The new-chat mod has its own copy (CHOICES): it runs in
   *  the app, which can't import host code. */
  label: string;
  create: (opts: AdapterOptions) => ProviderAdapter;
  /** Continue as chat: the session a running TUI of this agent has open (throws why not). */
  tuiSession: (q: TuiQuery) => TuiSession;
};

export const PROVIDERS: Record<string, Factory> = {
  pi: { command: "pi", label: "Pi", create: (o) => new PiAdapter(o), tuiSession: piTuiSession },
  claude: { command: "claude", label: "Claude Code", create: (o) => new ClaudeAdapter(o), tuiSession: claudeTuiSession },
  codex: { command: "codex", label: "Codex", create: (o) => new CodexAdapter(o), tuiSession: codexTuiSession },
  agy: { command: "agy", label: "Antigravity", create: (o) => new AgyAdapter(o), tuiSession: agyTuiSession },
};

export function tuiSession(provider: string, q: TuiQuery): TuiSession {
  return factory(provider).tuiSession(q);
}

/** The agent's TUI process in a terminal, from what Herdr reports of it (tui.ts `tuiProcess`; throws why not). */
export function findTui(provider: string, terminal: TerminalView): TuiFound {
  const f = factory(provider);
  return tuiProcess({ terminal, command: f.command, label: f.label, processes: processTable });
}

function factory(provider: string): Factory {
  const f = PROVIDERS[provider];
  if (!f) throw new Error(`Unknown provider "${provider}" (known: ${providerNames().join(", ")})`);
  return f;
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
