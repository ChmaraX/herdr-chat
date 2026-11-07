// Starting the real host on fake-claude, for tests/host/claude-*.test.ts.
import { join } from "node:path";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { Host, ROOT, FIXTURES } from "../host/harness.ts";

export const FAKE_CLAUDE = join(ROOT, "tests", "fake-claude", "fake-claude.mjs");

export type ClaudeHostOptions = {
  name: string;
  /** A scenario object (README.md), written next to the host's state. */
  scenario?: object;
  /** A recorded session in tests/fixtures/claude/ to replay, turn by turn, by prompt. */
  replay?: string;
  speed?: number;
  dir?: string;
  session?: string;
  /** Arguments after `--` (passed to claude). */
  args?: string[];
  env?: Record<string, string>;
};

export class ClaudeHost extends Host {
  get configDir(): string {
    return join(this.dir, "claude-config");
  }
  /** Every record the host wrote to fake-claude's stdin (after a `_start` line with argv and env). */
  inputs(): any[] {
    const f = join(this.dir, "claude-in.jsonl");
    if (!existsSync(f)) return [];
    return readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }
  controls(subtype?: string): any[] {
    return this.inputs().filter((r) => r.type === "control_request" && (!subtype || r.request?.subtype === subtype));
  }
}

export async function startClaude(o: ClaudeHostOptions): Promise<ClaudeHost> {
  const h = new ClaudeHost({ name: o.name, provider: "claude", agent: FAKE_CLAUDE, ...(o.dir ? { dir: o.dir } : {}), ...(o.session ? { session: o.session } : {}), piArgs: o.args ?? [] });
  const env: Record<string, string> = {
    CLAUDE_CONFIG_DIR: h.configDir,
    FAKE_CLAUDE_LOG: join(h.dir, "claude-in.jsonl"),
    FAKE_CLAUDE_SPEED: String(o.speed ?? 4),
    HERDR_CHAT_CLAUDE_POLL_MS: "150",
    ...o.env,
  };
  if (o.scenario) {
    const p = join(h.dir, `claude-scenario-${o.name}.json`);
    writeFileSync(p, JSON.stringify(o.scenario));
    env.FAKE_CLAUDE_SCENARIO = p;
  }
  if (o.replay) env.FAKE_CLAUDE_REPLAY = join(FIXTURES, "claude", o.replay);
  h.opts.env = env;
  await h.start();
  return h;
}
