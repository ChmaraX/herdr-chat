// The adapters this host knows. The only module that imports a provider's code.
import { PiAdapter } from "./pi/adapter.ts";
import { ClaudeAdapter } from "./claude/adapter.ts";
import { CodexAdapter } from "./codex/adapter.ts";
import type { ProviderAdapter, AdapterOptions } from "./types.ts";

type Factory = { command: string; create: (opts: AdapterOptions) => ProviderAdapter };

export const PROVIDERS: Record<string, Factory> = {
  pi: { command: "pi", create: (o) => new PiAdapter(o) },
  claude: { command: "claude", create: (o) => new ClaudeAdapter(o) },
  codex: { command: "codex", create: (o) => new CodexAdapter(o) },
};

export function providerNames(): string[] {
  return Object.keys(PROVIDERS);
}

/** The agent command: `--<provider> <cmd>`, else `PI_CHAT_<PROVIDER>`, else the provider's own CLI. */
export function createAdapter(provider: string, opts: Omit<AdapterOptions, "command"> & { command?: string }): ProviderAdapter {
  const f = PROVIDERS[provider];
  if (!f) throw new Error(`Unknown provider "${provider}" (known: ${providerNames().join(", ")})`);
  return f.create({ ...opts, command: opts.command ?? process.env[`PI_CHAT_${provider.toUpperCase()}`] ?? f.command });
}
