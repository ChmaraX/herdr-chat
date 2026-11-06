// The shared tool classifier: (provider, tool name, args, result) → card title
// and ToolDetail. Driven by per-provider name tables; unknown names become a
// generic card, never an error.
import { relative, isAbsolute } from "node:path";
import type { ToolDetail } from "./timeline.ts";

export const ARGS_LIMIT = 4 * 1024;

type Rec = Record<string, any>;

type Kind = "bash" | "read" | "edit" | "write" | "search" | "web_fetch" | "web_search" | "agent" | "mcp" | "file_change";

/**
 * Tool name → kind, per provider. Looked up by exact name, then lowercased.
 * Pi's names are lowercase; Claude's and Codex's are their own spelling.
 */
const TABLES: Record<string, Record<string, Kind>> = {
  pi: {
    bash: "bash", shell: "bash", powershell: "bash",
    read: "read",
    edit: "edit", multiedit: "edit", str_replace: "edit",
    write: "write",
    grep: "search", find: "search", ls: "search", glob: "search",
  },
  claude: {
    Bash: "bash",
    Read: "read",
    Edit: "edit", MultiEdit: "edit", NotebookEdit: "edit",
    Write: "write",
    Glob: "search", Grep: "search",
    WebFetch: "web_fetch",
    WebSearch: "web_search",
    Agent: "agent", Task: "agent",
  },
  codex: {
    commandExecution: "bash",
    fileChange: "file_change",
    imageView: "read",
    webSearch: "web_search",
    mcpToolCall: "mcp",
    collabAgentToolCall: "agent",
  },
};

function kindOf(provider: string, name: string): Kind | undefined {
  const t = TABLES[provider] ?? TABLES.pi!;
  return t[name] ?? t[name.toLowerCase()];
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function firstLine(s: string, max = 200): string {
  const line = s.split("\n")[0] ?? "";
  const more = s.includes("\n") ? " …" : "";
  return (line.length > max ? line.slice(0, max) + "…" : line) + more;
}

export function prettyArgs(args: unknown): string {
  if (args === undefined || args === null) return "";
  let s: string;
  try {
    s = typeof args === "string" ? args : JSON.stringify(args, null, 2) ?? "";
  } catch {
    s = String(args);
  }
  return s.length > ARGS_LIMIT ? s.slice(0, ARGS_LIMIT) + "\n…" : s;
}

/** A unified diff from edit args (`edits[]`, or one old/new pair), for when the result has no patch yet. */
export function diffFromEdits(path: string, args: Rec): string | null {
  const one = (e: Rec) => ({ oldText: e.oldText ?? e.old_string, newText: e.newText ?? e.new_string });
  const edits: { oldText?: string; newText?: string }[] = Array.isArray(args.edits)
    ? args.edits.map(one)
    : typeof args.oldText === "string" || typeof args.old_string === "string"
      ? [one(args)]
      : [];
  if (!edits.length) return null;
  const out = [`--- ${path}`, `+++ ${path}`];
  for (const e of edits) {
    const a = String(e.oldText ?? "").replace(/\n$/, "").split("\n");
    const b = String(e.newText ?? "").replace(/\n$/, "").split("\n");
    out.push(`@@ -? +? @@`); // positions unknown until the result's patch arrives
    for (const l of a) out.push(`-${l}`);
    for (const l of b) out.push(`+${l}`);
  }
  return out.join("\n") + "\n";
}

/** Claude's `structuredPatch` hunks → a unified diff. */
function diffFromHunks(path: string, hunks: unknown): string | null {
  if (!Array.isArray(hunks) || !hunks.length) return null;
  const out = [`--- ${path}`, `+++ ${path}`];
  for (const h of hunks as Rec[]) {
    out.push(`@@ -${h.oldStart ?? 0},${h.oldLines ?? 0} +${h.newStart ?? 0},${h.newLines ?? 0} @@`);
    if (Array.isArray(h.lines)) for (const l of h.lines) out.push(String(l));
  }
  return out.join("\n") + "\n";
}

/** Codex `fileChange.changes[]` → a unified diff with synthesized headers. */
function diffFromChanges(changes: Rec[], rel: (p: string) => string = (p) => p): string | null {
  const out: string[] = [];
  for (const c of changes) {
    const p = rel(str(c.path) ?? "");
    const diff = str(c.diff) ?? "";
    if (c.kind?.type === "add") {
      out.push(`--- /dev/null`, `+++ ${p}`, `@@ -0,0 +1,${diff.replace(/\n$/, "").split("\n").length} @@`, ...diff.replace(/\n$/, "").split("\n").map((l) => `+${l}`));
    } else if (c.kind?.type === "delete" && !/^@@ /m.test(diff)) {
      out.push(`--- ${p}`, `+++ /dev/null`, `@@ -1,${diff.replace(/\n$/, "").split("\n").length} +0,0 @@`, ...diff.replace(/\n$/, "").split("\n").map((l) => `-${l}`));
    } else if (/^(---|diff )/m.test(diff)) out.push(diff.replace(/\n$/, ""));
    else out.push(`--- ${p}`, `+++ ${str(c.kind?.move_path) ? rel(c.kind.move_path) : p}`, diff.replace(/\n$/, ""));
  }
  return out.length ? out.join("\n") + "\n" : null;
}

/** `/bin/zsh -lc 'ls -la'` → `ls -la` (Codex wraps every command in a login shell). */
function unwrapShell(command: string): string {
  const m = /^(?:\/\S*\/)?(?:ba|z|fi)?sh\s+-l?c\s+(['"])([\s\S]*)\1\s*$/.exec(command);
  return m ? m[2]! : command;
}

/**
 * Codex parses each command into actions. One read, listing or search done
 * through the shell gets that card, like Codex's own UI; anything else stays a shell card.
 */
function codexCommandAction(actions: unknown, rel: (p: string) => string): { title: string; detail: ToolDetail } | null {
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

export function presentTool(provider: string, name: string, args: unknown, cwd: string): { title: string; detail: ToolDetail } {
  const a: Rec = args && typeof args === "object" ? (args as Rec) : {};
  const rel = (p: string) => {
    if (!p) return p;
    if (isAbsolute(p) && cwd) {
      const r = relative(cwd, p);
      if (!r.startsWith("..") && !isAbsolute(r)) return r || ".";
    }
    return p;
  };
  const path = str(a.path) ?? str(a.file_path) ?? str(a.filePath) ?? str(a.notebook_path) ?? "";
  const lower = name.toLowerCase();
  switch (kindOf(provider, name)) {
    case "bash": {
      const raw = str(a.command) ?? (Array.isArray(a.command) ? a.command.join(" ") : "");
      const command = provider === "codex" ? unwrapShell(raw) : raw;
      const viaShell = provider === "codex" ? codexCommandAction(a.commandActions, rel) : null;
      if (viaShell) return viaShell;
      return { title: `$ ${firstLine(command)}`, detail: { type: "bash", command } };
    }
    case "read": {
      const offset = num(a.offset);
      const limit = num(a.limit);
      let range = "";
      if (offset !== undefined && limit !== undefined) range = `:${offset}-${offset + limit - 1}`;
      else if (offset !== undefined) range = `:${offset}`;
      else if (limit !== undefined) range = `:1-${limit}`;
      const d: ToolDetail = { type: "read", path, ...(offset !== undefined ? { offset } : {}), ...(limit !== undefined ? { limit } : {}) };
      return { title: `Read ${rel(path)}${range}`, detail: d };
    }
    case "edit":
      return { title: `Edit ${rel(path)}`, detail: { type: "edit", path, diff: diffFromEdits(rel(path), a) } };
    case "write": {
      const content = str(a.content);
      return { title: `Write ${rel(path)}`, detail: { type: "write", path, ...(content !== undefined ? { bytes: Buffer.byteLength(content) } : {}) } };
    }
    case "file_change": {
      const changes: Rec[] = Array.isArray(a.changes) ? a.changes : [];
      const p = str(changes[0]?.path) ?? "";
      const more = changes.length > 1 ? ` (+${changes.length - 1})` : "";
      if (changes.length === 1 && changes[0]!.kind?.type === "add") {
        const diff = str(changes[0]!.diff);
        return { title: `Write ${rel(p)}`, detail: { type: "write", path: p, ...(diff !== undefined ? { bytes: Buffer.byteLength(diff) } : {}) } };
      }
      return { title: `Edit ${rel(p)}${more}`, detail: { type: "edit", path: p, diff: diffFromChanges(changes, rel) } };
    }
    case "search": {
      const query = str(a.pattern) ?? str(a.query);
      const p = str(a.path);
      const verb = lower === "grep" ? "Grep" : lower === "find" || lower === "glob" ? "Find" : "List";
      const title = lower === "ls" ? `List ${rel(p ?? ".")}` : `${verb} ${query ?? ""}${p ? ` in ${rel(p)}` : ""}`;
      return { title: title.trim(), detail: { type: "search", tool: lower, ...(query !== undefined ? { query } : {}), ...(p !== undefined ? { path: p } : {}) } };
    }
    case "web_fetch": {
      const url = str(a.url);
      return { title: `Fetch ${url ?? ""}`.trim(), detail: { type: "web", tool: "fetch", ...(url ? { url } : {}) } };
    }
    case "web_search": {
      const act = a.action && typeof a.action === "object" ? (a.action as Rec) : null;
      if (act && (act.type === "openPage" || act.type === "findInPage") && str(act.url)) {
        const pattern = str(act.pattern);
        return { title: `${act.type === "findInPage" ? `Find ${pattern ?? ""} in` : "Open"} ${act.url}`.replace(/\s+/g, " "), detail: { type: "web", tool: "fetch", url: act.url, ...(pattern ? { query: pattern } : {}) } };
      }
      const query = str(a.query) || str(act?.query);
      return { title: `Search the web${query ? ` for ${firstLine(query, 80)}` : ""}`, detail: { type: "web", tool: "search", ...(query ? { query } : {}) } };
    }
    case "agent": {
      if (provider === "codex" && str(a.tool) && a.tool !== "spawnAgent") {
        const verb: Record<string, string> = {
          wait: "Wait for agent", sendInput: "Message agent", sendMessage: "Message agent", followupTask: "Follow-up for agent",
          resumeAgent: "Resume agent", closeAgent: "Close agent", interruptAgent: "Interrupt agent", listAgents: "List agents",
        };
        const description = str(a.prompt) ?? "";
        return { title: `${verb[a.tool] ?? a.tool}${description ? ` ${firstLine(description, 80)}` : ""}`, detail: { type: "agent", description, agentType: a.tool } };
      }
      const description = str(a.description) ?? str(a.prompt) ?? "";
      const agentType = str(a.subagent_type) ?? str(a.agentType);
      return { title: `Agent ${firstLine(description, 80)}`.trim(), detail: { type: "agent", description, ...(agentType ? { agentType } : {}) } };
    }
    case "mcp":
      break;
  }
  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
  if (mcp) return { title: `mcp ${mcp[1]} · ${mcp[2]}`, detail: { type: "generic", server: mcp[1]!, tool: mcp[2]! } };
  if ((lower === "mcp" || kindOf(provider, name) === "mcp") && (str(a.tool) || str(a.server))) {
    const server = str(a.server);
    const tool = str(a.tool) ?? "";
    return { title: `mcp ${server ? server + " · " : ""}${tool}`.trim(), detail: { type: "generic", ...(server ? { server } : {}), tool: tool || name } };
  }
  if (provider === "codex" && name === "dynamicToolCall" && str(a.tool)) {
    const ns = str(a.namespace);
    return { title: `${ns ? `${ns} · ` : ""}${a.tool}`, detail: { type: "generic", ...(ns ? { server: ns } : {}), tool: a.tool } };
  }
  if (provider === "codex" && name === "imageGeneration") {
    return { title: `Generate an image${str(a.prompt) ? `: ${firstLine(a.prompt, 80)}` : ""}`, detail: { type: "generic", tool: "imageGeneration" } };
  }
  const summary = Object.values(a).find((v) => typeof v === "string" && v.length > 0) as string | undefined;
  return { title: summary ? `${name} ${firstLine(summary, 80)}` : name, detail: { type: "generic", tool: name } };
}

function exitCode(provider: string, name: string, result: unknown, isError: boolean, output: string): number | null | undefined {
  if (kindOf(provider, name) !== "bash") return undefined;
  const r: Rec = result && typeof result === "object" ? (result as Rec) : {};
  if (provider === "claude") {
    const m = /^Exit code (\d+)/.exec(output);
    if (m) return Number(m[1]);
    return isError ? null : 0;
  }
  if (provider === "codex") {
    if ("exitCode" in r) return num(r.exitCode) ?? null;
    return isError ? null : 0;
  }
  const sc = r.structuredContent;
  if (sc && typeof sc === "object") {
    if ("exit_code" in sc) return num((sc as Rec).exit_code) ?? null;
    if ("exitCode" in sc) return num((sc as Rec).exitCode) ?? null;
  }
  const d = r.details;
  if (d && typeof d === "object" && "exitCode" in d) return num((d as Rec).exitCode) ?? null;
  const m = /Command exited with code (\d+)\s*$/.exec(output);
  if (m) return Number(m[1]);
  if (/Command aborted\s*$/.test(output)) return null;
  return isError ? null : 0;
}

/**
 * Updates a tool card's detail from the tool's native result: the exit code
 * for shells, the real patch for edits (Claude's Write of an existing file
 * becomes an edit).
 */
export function applyResult(provider: string, name: string, detail: ToolDetail, result: unknown, isError: boolean, output: string, cwd: string): ToolDetail {
  const r: Rec | null = result && typeof result === "object" ? (result as Rec) : null;
  if (provider === "claude" && r && (detail.type === "edit" || detail.type === "write")) {
    const patch = str(r.gitDiff?.patch) ?? diffFromHunks(relPath(detail.path, cwd), r.structuredPatch);
    if (patch && (detail.type === "edit" || r.type === "update")) detail = { type: "edit", path: detail.path, diff: patch };
  } else if (provider === "codex" && r && detail.type === "edit" && Array.isArray(r.changes)) {
    detail.diff = diffFromChanges(r.changes, (p) => relPath(p, cwd)) ?? detail.diff;
  } else if (detail.type === "edit" && r) {
    const patch = str(r.details?.patch);
    if (patch) detail.diff = patch;
  }
  if (detail.type === "bash") {
    const code = exitCode(provider, name, result, isError, output);
    if (code !== undefined) detail.exitCode = code;
  }
  return detail;
}

function relPath(p: string, cwd: string): string {
  if (isAbsolute(p) && cwd) {
    const r = relative(cwd, p);
    if (!r.startsWith("..") && !isAbsolute(r)) return r || ".";
  }
  return p;
}
