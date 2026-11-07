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
  /** Terminal utilities (/login, /settings…): the command to run in a terminal, cwd = the chat's. */
  argv?: string[];
  /** A command that opens the agent's terminal: what to type there once it is idle ("/login"). */
  input?: string;
};

/** What the built-ins depend on. */
export type BuiltinContext = {
  /** "Pi", "Claude Code", "Codex". */
  name: string;
  capabilities: Capabilities;
  /** The adapter's terminal utility for /login, /settings, /scoped-models, or null. */
  utility: (name: string) => string[] | null;
  /** The agent's commands that work only in its own TUI (adapter `tuiCommands`). */
  tuiCommands: { name: string; description: string }[];
  /** What to type into the agent's terminal for a command that opens one, or null. */
  tuiInput?: (name: string) => string | null;
};

const B = (name: string, description: string, handler: "host" | "client", args?: string): Command => ({ name, description, source: "builtin", handler, ...(args ? { args } : {}) });

/** The built-ins this provider supports, in menu order. */
export function builtins(ctx: BuiltinContext): Command[] {
  const n = ctx.name;
  const caps = ctx.capabilities;
  const out: Command[] = [];
  const typed = (name: string) => {
    const input = ctx.tuiInput?.(name);
    return input ? { input } : {};
  };
  const utility = (name: string, description: string) => {
    const argv = ctx.utility(name);
    if (argv) out.push({ ...B(name, description, "client"), argv, ...typed(name) });
  };
  out.push(B("model", "Choose the model", "client", "[provider/id]"));
  if (caps.thinkingLevels.length) out.push(B("thinking", "Choose the thinking level (effort)", "client", "[level]"));
  if (caps.compact) out.push(B("compact", "Compact the conversation", "host", caps.compactInstructions ? "[instructions]" : undefined));
  out.push(B("new", "Start a new session", "host"));
  out.push(B("clear", "Start a new session (alias of /new)", "host"));
  if (caps.rename) out.push(B("name", "Name this session", "host", "<name>"));
  out.push(B("resume", "Resume another session", "client"));
  out.push(B("reload", `Restart ${n} on this session (re-reads its login, settings and extensions)`, "host"));
  out.push(B("copy", "Copy the last answer", "client"));
  out.push(B("transcript", "Show the plain transcript", "client"));
  if (caps.tui) out.push(B("tui", `Continue this session in ${n}'s terminal UI`, "client"));
  utility("login", "Sign in (in a terminal)");
  utility("settings", `Open ${n}'s settings (in a terminal)`);
  utility("scoped-models", "Choose the models for cycling (in a terminal)");
  if (caps.fork) out.push(B("fork", "Fork from an earlier message: a new session up to it", "client"));
  if (caps.tui) {
    for (const c of ctx.tuiCommands) {
      if (out.some((o) => o.name === c.name)) continue;
      const description = c.description ? `${c.description} (in ${n}'s terminal UI)` : `In ${n}'s terminal UI`;
      out.push({ ...B(c.name, description, "client"), input: ctx.tuiInput?.(c.name) ?? `/${c.name}` });
    }
  }
  return out;
}

/** Every core built-in name, offered or not: an agent command with one of these names is never listed. */
const ALL_BUILTIN_NAMES = new Set(["model", "thinking", "compact", "new", "clear", "name", "resume", "reload", "copy", "transcript", "tui", "login", "settings", "scoped-models", "fork"]);

export function mergeCommands(builtin: Command[], agentCommands: unknown): Command[] {
  const out = [...builtin];
  if (!Array.isArray(agentCommands)) return out;
  for (const c of agentCommands) {
    if (!c || typeof c !== "object" || typeof c.name !== "string") continue;
    if (ALL_BUILTIN_NAMES.has(c.name) || builtin.some((b) => b.name === c.name)) continue;
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
