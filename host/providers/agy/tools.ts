// Antigravity (`agy acp`) tools → shared ToolMap presentation.
// Antigravity uses PascalCase args (CommandLine, Path, Target, Replacement, Content,
// Query, SearchPath, Url, ServerName, ToolName) alongside camelCase/snake_case.
import { diffFromEdits, firstLine, num, str, type Presented, type Rel, type ToolMap } from "../../tools.ts";

type Rec = Record<string, any>;

function agyPath(a: Rec): string {
  return (
    str(a.Path) ??
    str(a.TargetFile) ??
    str(a.AbsolutePath) ??
    str(a.DirectoryPath) ??
    str(a.SearchPath) ??
    str(a.SearchDirectory) ??
    str(a.path) ??
    str(a.file_path) ??
    str(a.filePath) ??
    ""
  );
}

function editDiff(path: string, a: Rec): string | null {
  if (typeof a.Target === "string" || typeof a.Replacement === "string") {
    return diffFromEdits(path, { oldText: a.Target ?? "", newText: a.Replacement ?? "" });
  }
  if (typeof a.TargetContent === "string" || typeof a.ReplacementContent === "string") {
    return diffFromEdits(path, { oldText: a.TargetContent ?? "", newText: a.ReplacementContent ?? "" });
  }
  if (Array.isArray(a.ReplacementChunks)) {
    const edits = a.ReplacementChunks.map((c: Rec) => ({
      oldText: str(c?.TargetContent) ?? "",
      newText: str(c?.ReplacementContent) ?? "",
    }));
    return diffFromEdits(path, { edits });
  }
  return diffFromEdits(path, a);
}

export const AGY_TOOLS: ToolMap = {
  names: {
    run_command: "bash",
    read_file: "read",
    view_file: "read",
    edit_file: "edit",
    replace_file_content: "edit",
    multi_replace_file_content: "edit",
    write_file: "write",
    write_to_file: "write",
    grep_search: "search",
    find_by_name: "search",
    list_dir: "search",
    search_web: "web_search",
    read_url_content: "web_fetch",
    invoke_subagent: "agent",
    call_mcp_tool: "mcp",
  },
  present(name: string, a: Rec, rel: Rel): Presented | null {
    const lower = name.toLowerCase();
    if (lower === "run_command") {
      const command = str(a.CommandLine) ?? str(a.command) ?? "";
      return { title: `$ ${firstLine(command)}`, detail: { type: "bash", command } };
    }
    if (lower === "read_file" || lower === "view_file") {
      const path = agyPath(a);
      const start = num(a.StartLine) ?? num(a.offset);
      const end = num(a.EndLine);
      const limit = start !== undefined && end !== undefined && end >= start ? end - start + 1 : num(a.limit);
      let range = "";
      if (start !== undefined && end !== undefined) range = `:${start}-${end}`;
      else if (start !== undefined) range = `:${start}`;
      return {
        title: `Read ${rel(path)}${range}`,
        detail: { type: "read", path, ...(start !== undefined ? { offset: start } : {}), ...(limit !== undefined ? { limit } : {}) },
      };
    }
    if (lower === "edit_file" || lower === "replace_file_content" || lower === "multi_replace_file_content") {
      const path = agyPath(a);
      return { title: `Edit ${rel(path)}`, detail: { type: "edit", path, diff: editDiff(rel(path), a) } };
    }
    if (lower === "write_file" || lower === "write_to_file") {
      const path = agyPath(a);
      const content = str(a.Content) ?? str(a.CodeContent) ?? str(a.content);
      return {
        title: `Write ${rel(path)}`,
        detail: { type: "write", path, ...(content !== undefined ? { bytes: Buffer.byteLength(content) } : {}) },
      };
    }
    if (lower === "grep_search" || lower === "find_by_name" || lower === "list_dir") {
      const path = agyPath(a);
      const query = str(a.Query) ?? str(a.Pattern) ?? str(a.pattern) ?? str(a.query);
      if (lower === "list_dir") {
        return { title: `List ${rel(path || ".")}`, detail: { type: "search", tool: "ls", ...(path ? { path } : {}) } };
      }
      const verb = lower === "grep_search" ? "Grep" : "Find";
      const tool = lower === "grep_search" ? "grep" : "find";
      return {
        title: `${verb} ${query ?? ""}${path ? ` in ${rel(path)}` : ""}`.trim(),
        detail: { type: "search", tool, ...(query ? { query } : {}), ...(path ? { path } : {}) },
      };
    }
    if (lower === "read_url_content") {
      const url = str(a.Url) ?? str(a.url);
      return { title: `Fetch ${url ?? ""}`.trim(), detail: { type: "web", tool: "fetch", ...(url ? { url } : {}) } };
    }
    if (lower === "search_web") {
      const query = str(a.query) ?? str(a.Query);
      return {
        title: `Search the web${query ? ` for ${firstLine(query, 80)}` : ""}`,
        detail: { type: "web", tool: "search", ...(query ? { query } : {}) },
      };
    }
    if (lower === "invoke_subagent") {
      const description = str(a.Role) ?? str(a.Prompt) ?? str(a.description) ?? "";
      const agentType = str(a.TypeName);
      return {
        title: `Agent ${firstLine(description, 80)}`.trim(),
        detail: { type: "agent", description, ...(agentType ? { agentType } : {}) },
      };
    }
    if (lower === "call_mcp_tool") {
      const server = str(a.ServerName) ?? str(a.server);
      const tool = str(a.ToolName) ?? str(a.tool) ?? name;
      return {
        title: `mcp ${server ? `${server} · ` : ""}${tool}`.trim(),
        detail: { type: "generic", ...(server ? { server } : {}), tool },
      };
    }
    return null;
  },
  exitCode(r, isError) {
    if ("exit_code" in r) return num(r.exit_code) ?? null;
    if ("exitCode" in r) return num(r.exitCode) ?? null;
    return isError ? null : 0;
  },
};
