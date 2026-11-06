// Starts the real host on the codex provider with fake-codex (scripted or replaying a fixture).
import { join } from "node:path";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { Host, ROOT } from "../host/harness.ts";

export const FAKE_CODEX = join(ROOT, "tests", "fake-codex", "fake-codex.mjs");
export const CODEX_SCENARIOS = join(ROOT, "tests", "fake-codex", "scenarios");
export const CODEX_FIXTURES = join(ROOT, "tests", "fixtures", "codex");

export type CodexHostOptions = {
  name: string;
  /** A file in tests/fake-codex/scenarios/, or an inline scenario. */
  scenario?: string | object;
  /** A fixture in tests/fixtures/codex/. */
  replay?: string;
  speed?: number;
  session?: string;
  /** Reuse a temp dir (restart on the same Codex home and state). */
  dir?: string;
  /** The stall watchdog's threshold (PI_CHAT_CODEX_STALL_MS). */
  stallMs?: number;
  agent?: string;
  env?: Record<string, string>;
};

export class CodexHost extends Host {
  get codexHome(): string {
    return join(this.dir, "codex-home");
  }
  get codexLog(): string {
    return join(this.dir, "codex-rpc.jsonl");
  }
  /** What the host sent to fake-codex: requests, notifications and answers. */
  codexMessages(): any[] {
    if (!existsSync(this.codexLog)) return [];
    return readFileSync(this.codexLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }
  requests(method?: string): any[] {
    return this.codexMessages().filter((m) => m.method && m.id !== undefined && (!method || m.method === method));
  }
  /** The host's answers to server requests (approvals, questions). */
  answers(): any[] {
    return this.codexMessages().filter((m) => !m.method && m.id !== undefined);
  }
}

export async function codexHost(o: CodexHostOptions): Promise<CodexHost> {
  const h = new CodexHost({ name: o.name, provider: "codex", agent: o.agent ?? FAKE_CODEX, ...(o.dir ? { dir: o.dir } : {}), ...(o.session ? { session: o.session } : {}) });
  const fake = !o.agent || o.agent === FAKE_CODEX;
  const env: Record<string, string> = {
    // The fake's own home (CODEX_HOME also points the adapter's ~/.codex/prompts there); a real Codex keeps the user's.
    ...(fake ? { FAKE_CODEX_HOME: h.codexHome, FAKE_CODEX_LOG: h.codexLog, FAKE_CODEX_SPEED: String(o.speed ?? 4), CODEX_HOME: h.codexHome } : {}),
    ...(o.stallMs ? { PI_CHAT_CODEX_STALL_MS: String(o.stallMs) } : {}),
  };
  if (o.scenario) {
    let path: string;
    if (typeof o.scenario === "string") path = join(CODEX_SCENARIOS, o.scenario);
    else {
      path = join(h.dir, "codex-scenario.json");
      writeFileSync(path, JSON.stringify(o.scenario));
    }
    env.FAKE_CODEX_SCENARIO = path;
  }
  if (o.replay) env.FAKE_CODEX_REPLAY = join(CODEX_FIXTURES, o.replay);
  h.opts.env = { ...env, ...(o.env ?? {}) };
  await h.start();
  return h;
}
