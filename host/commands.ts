// Built-in slash commands (protocol.md "Built-in slash commands") and the merged menu.
// Provider-neutral: names come from the provider, and a built-in is offered
// only when the provider supports it (capabilities, terminal utilities, TUI-only commands).
import type { Capabilities } from "./providers/types.ts";

export type Command = {
  name: string;
  description: string;
  source: "builtin" | "extension" | "prompt" | "skill";
  handler: "host" | "client";
  args?: string;
  /** Terminal utilities (/login, /settings…): the command to run in a terminal pane, cwd = the chat's. */
  argv?: string[];
};

/** What the built-ins depend on. */
export type BuiltinContext = {
  /** "Pi", "Claude Code", "Codex". */
  name: string;
  capabilities: Capabilities;
  /** The adapter's terminal utility for /login, /settings, /scoped-models, or null. */
  utility: (name: string) => string[] | null;
  /** Commands that need the session in the agent's own TUI (Pi: tree, export, hotkeys). */
  tuiOnly: string[];
};

const B = (name: string, description: string, handler: "host" | "client", args?: string): Command => ({ name, description, source: "builtin", handler, ...(args ? { args } : {}) });

/** The built-ins this provider supports, in menu order. */
export function builtins(ctx: BuiltinContext): Command[] {
  const n = ctx.name;
  const caps = ctx.capabilities;
  const pi = n === "Pi";
  const out: Command[] = [];
  const utility = (name: string, description: string) => {
    const argv = ctx.utility(name);
    if (argv) out.push({ ...B(name, description, "client"), argv });
  };
  out.push(B("model", "Choose the model", "client", "[provider/id]"));
  if (caps.thinkingLevels.length) out.push(B("thinking", pi ? "Choose the thinking level" : "Choose the thinking effort", "client", "[level]"));
  if (caps.compact) out.push(B("compact", "Compact the conversation", "host", "[instructions]"));
  out.push(B("new", "Start a new session", "host"));
  out.push(B("clear", "Start a new session (alias of /new)", "host"));
  if (caps.rename) out.push(B("name", "Name this session", "host", "<name>"));
  out.push(B("resume", "Resume another session", "client"));
  out.push(B("reload", pi ? "Restart Pi on this session (re-reads auth, settings and extensions)" : `Restart ${n} on this session (re-reads auth and settings)`, "host"));
  out.push(B("copy", "Copy the last answer", "client"));
  out.push(B("transcript", "Show the plain transcript", "client"));
  if (caps.tui) out.push(B("tui", `Continue this session in ${n}'s terminal UI`, "client"));
  utility("login", pi ? "Sign in to a provider (in a terminal)" : `Sign in to ${n} (in a terminal)`);
  utility("settings", `Open ${n}'s settings (in a terminal)`);
  utility("scoped-models", "Choose the models for cycling (in a terminal)");
  const tuiOnly = (name: string, description: string) => {
    if (caps.tui && ctx.tuiOnly.includes(name)) out.push(B(name, description, "client"));
  };
  tuiOnly("tree", `Browse the session tree (in ${n}'s terminal UI)`);
  tuiOnly("export", `Export the session (in ${n}'s terminal UI)`);
  if (caps.fork && caps.tui) out.push(B("fork", `Fork from an earlier message (in ${n}'s terminal UI)`, "client"));
  tuiOnly("hotkeys", `Show ${n}'s hotkeys (in ${n}'s terminal UI)`);
  return out;
}

/** Every built-in name, offered or not: an agent command with one of these names is never listed. */
const ALL_BUILTIN_NAMES = new Set(["model", "thinking", "compact", "new", "clear", "name", "resume", "reload", "copy", "transcript", "tui", "login", "settings", "scoped-models", "tree", "export", "fork", "hotkeys"]);

export function mergeCommands(builtin: Command[], agentCommands: unknown): Command[] {
  const out = [...builtin];
  if (!Array.isArray(agentCommands)) return out;
  for (const c of agentCommands) {
    if (!c || typeof c !== "object" || typeof c.name !== "string") continue;
    if (ALL_BUILTIN_NAMES.has(c.name)) continue;
    const source = c.source === "prompt" || c.source === "skill" ? c.source : "extension";
    out.push({ name: c.name, description: typeof c.description === "string" ? c.description : "", source, handler: "host" });
  }
  return out;
}

/** "/name rest" → {name, rest} when the name is one of the offered built-ins, else null. */
export function parseBuiltin(text: string, builtin: Command[]): { name: string; rest: string; command: Command } | null {
  const m = /^\/([A-Za-z][\w:-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  const command = builtin.find((c) => c.name === m[1]);
  if (!command) return null;
  return { name: m[1]!, rest: (m[2] ?? "").trim(), command };
}
