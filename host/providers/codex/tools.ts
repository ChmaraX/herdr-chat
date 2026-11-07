// Codex's tools: its item types as tools (map.ts), the shell command without its
// login-shell wrapper, a command that is one read or search as that card (like
// Codex's own UI), its agent and dynamic tools, and the patch from a file change.
import { diffFromChanges, firstLine, num, relPath, str, type Presented, type Rel, type ToolMap } from "../../tools.ts";

type Rec = Record<string, any>;

/** `/bin/zsh -lc 'ls -la'` → `ls -la` (Codex wraps every command in a login shell). */
function unwrapShell(command: string): string {
  const m = /^(?:\/\S*\/)?(?:ba|z|fi)?sh\s+-l?c\s+(['"])([\s\S]*)\1\s*$/.exec(command);
  return m ? m[2]! : command;
}

/** Codex parses each command into actions: one read, listing or search gets that card; anything else stays a shell card. */
function commandAction(actions: unknown, rel: Rel): Presented | null {
  if (!Array.isArray(actions) || actions.length !== 1) return null;
  const x = actions[0] as Rec;
  if (x?.type === "read" && str(x.path)) return { title: `Read ${rel(x.path)}`, detail: { type: "read", path: x.path } };
  if (x?.type === "listFiles") {
    const p = str(x.path);
    return { title: `List ${rel(p ?? ".")}`, detail: { type: "search", tool: "ls", ...(p ? { path: p } : {}) } };
  }
  if (x?.type === "search") {
    const q = str(x.query);
    const p = str(x.path);
    return { title: `Grep ${q ?? ""}${p ? ` in ${rel(p)}` : ""}`.trim(), detail: { type: "search", tool: "grep", ...(q ? { query: q } : {}), ...(p ? { path: p } : {}) } };
  }
  return null;
}

const AGENT_VERBS: Record<string, string> = {
  wait: "Wait for agent", sendInput: "Message agent", sendMessage: "Message agent", followupTask: "Follow-up for agent",
  resumeAgent: "Resume agent", closeAgent: "Close agent", interruptAgent: "Interrupt agent", listAgents: "List agents",
};

export const CODEX_TOOLS: ToolMap = {
  names: {
    commandExecution: "bash",
    fileChange: "file_change",
    imageView: "read",
    webSearch: "web_search",
    mcpToolCall: "mcp",
    collabAgentToolCall: "agent",
  },
  present(name, a, rel) {
    if (name === "commandExecution") return commandAction(a.commandActions, rel);
    if (name === "collabAgentToolCall" && str(a.tool) && a.tool !== "spawnAgent") {
      const description = str(a.prompt) ?? "";
      return { title: `${AGENT_VERBS[a.tool] ?? a.tool}${description ? ` ${firstLine(description, 80)}` : ""}`, detail: { type: "agent", description, agentType: a.tool } };
    }
    if (name === "dynamicToolCall" && str(a.tool)) {
      const ns = str(a.namespace);
      return { title: `${ns ? `${ns} · ` : ""}${a.tool}`, detail: { type: "generic", ...(ns ? { server: ns } : {}), tool: a.tool } };
    }
    if (name === "imageGeneration") {
      return { title: `Generate an image${str(a.prompt) ? `: ${firstLine(a.prompt, 80)}` : ""}`, detail: { type: "generic", tool: "imageGeneration" } };
    }
    return null;
  },
  command: unwrapShell,
  exitCode(r, isError) {
    if ("exitCode" in r) return num(r.exitCode) ?? null;
    return isError ? null : 0;
  },
  applyResult(detail, r, cwd) {
    if (detail.type !== "edit" || !Array.isArray(r.changes)) return undefined;
    return { ...detail, diff: diffFromChanges(r.changes, (p) => relPath(p, cwd)) ?? detail.diff };
  },
};
