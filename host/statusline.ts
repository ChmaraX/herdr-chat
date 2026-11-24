import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatState } from "./chat.ts";
import type { ModelInfo } from "./providers/types.ts";

const SUPPORTED_AGENTS = new Set(["claude", "agy"]);

export function safeTerminalId(id: string | null | undefined): string | null {
  const s = (id ?? "").trim();
  if (!s || s === "." || s === ".." || s.includes("/") || s.includes("\\")) return null;
  return s;
}

export type StatuslineCacheOptions = {
  dir: string;
  terminal: string | null;
  provider: string;
  now?: () => number;
};

/** Best-effort atomic writer for `~/.cache/herdr-statusline/<term>.json` so Herdr's status bar sees model & context %. */
export class StatuslineCache {
  private dir: string;
  private terminal: string | null;
  private provider: string;
  private now: () => number;
  private lastSig: string | null = null;

  constructor(opts: StatuslineCacheOptions) {
    this.dir = opts.dir.trim() ? opts.dir : "";
    this.terminal = safeTerminalId(opts.terminal);
    this.provider = opts.provider;
    this.now = opts.now ?? Date.now;
  }

  sync(model: ModelInfo | null, usage: ChatState["usage"]): void {
    if (!this.dir || !this.terminal || !SUPPORTED_AGENTS.has(this.provider)) return;

    const modelName = model?.name || model?.id || null;
    const ctxPct = typeof usage?.percent === "number" && Number.isFinite(usage.percent) ? Math.round(usage.percent) : null;
    const ctxTokens = typeof usage?.contextTokens === "number" && Number.isFinite(usage.contextTokens) ? usage.contextTokens : null;
    const ctxSize = typeof usage?.contextWindow === "number" && Number.isFinite(usage.contextWindow) ? usage.contextWindow : null;
    const costUsd = typeof usage?.cost === "number" && Number.isFinite(usage.cost) ? usage.cost : null;

    if (modelName === null && ctxPct === null && this.lastSig === null) return;

    const sig = JSON.stringify([this.provider, modelName, ctxPct, ctxTokens, ctxSize, costUsd]);
    if (sig === this.lastSig) return;

    const dest = join(this.dir, `${this.terminal}.json`);
    const tmp = `${dest}.${process.pid}.tmp`;
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(
        tmp,
        JSON.stringify({
          terminal: this.terminal,
          agent: this.provider,
          model: modelName,
          ctx_pct: ctxPct,
          ctx_tokens: ctxTokens,
          ctx_size: ctxSize,
          cost_usd: costUsd,
          updated_at: this.now() / 1000,
        }),
      );
      renameSync(tmp, dest);
      this.lastSig = sig;
    } catch {
      // Best-effort cache write: never disrupt the host session.
    }
  }
}
