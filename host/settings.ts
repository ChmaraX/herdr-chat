// What a chat runs an agent with: what install found (mods/chat/config.json:
// the host, node, hc and each agent's command) with the person's settings over
// it (<app home>/data/herdr-chat/settings.json, which install never writes).
// The chat mod reads the same two files the same way (mod/chat/connection.js
// readConfig); README "Settings" documents the person's file.
//
//   {
//     "env": {"KEY": "value"},                  every agent's environment
//     "<agent>": {                              pi, claude, codex
//       "command": "/path/to/agent",            instead of what install found
//       "args": ["--model", "…"],               after the agent's own arguments
//       "env": {"KEY": "value"},                this agent's environment
//       "tui": ["wrapper", "agent"]             the program /tui runs (its arguments kept)
//     }
//   }
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type AgentSettings = { command: string | null; args: string[]; env: Record<string, string>; tui: string[] | null };
export type ChatConfig = { host: string | null; node: string | null; hc: string | null; agent(id: string): AgentSettings };

type Rec = Record<string, any>;

function readJson(path: string): Rec {
  try {
    const v = JSON.parse(readFileSync(path, "utf8"));
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

export const installConfigPath = (appHome: string) => join(appHome, "mods", "chat", "config.json");
export const settingsPath = (appHome: string) => join(appHome, "data", "herdr-chat", "settings.json");

const list = (v: unknown): string[] | null => (Array.isArray(v) ? v.map(String) : typeof v === "string" && v ? [v] : null);
const strings = (v: unknown): Record<string, string> =>
  v && typeof v === "object" ? Object.fromEntries(Object.entries(v as Rec).map(([k, x]) => [k, String(x)])) : {};

/** Pure: the two files merged. */
export function chatConfig(install: Rec, mine: Rec): ChatConfig {
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  return {
    host: str(install.host), node: str(install.node), hc: str(install.hc),
    agent(id) {
      const a: Rec = mine[id] && typeof mine[id] === "object" ? mine[id] : {};
      return { command: str(a.command) ?? str(install[id]), args: list(a.args) ?? [], env: { ...strings(mine.env), ...strings(a.env) }, tui: list(a.tui) };
    },
  };
}

export function readChatConfig(appHome: string): ChatConfig {
  return chatConfig(readJson(installConfigPath(appHome)), readJson(settingsPath(appHome)));
}
