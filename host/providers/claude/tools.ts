// Claude Code's tools: its names, its shell's exit code, and the real patch
// from an edit's or write's result.
import { diffFromHunks, relPath, str, type ToolMap } from "../../tools.ts";

export const CLAUDE_TOOLS: ToolMap = {
  names: {
    Bash: "bash",
    Read: "read",
    Edit: "edit", MultiEdit: "edit", NotebookEdit: "edit",
    Write: "write",
    Glob: "search", Grep: "search",
    WebFetch: "web_fetch",
    WebSearch: "web_search",
    Agent: "agent", Task: "agent",
  },
  exitCode(_result, isError, output) {
    const m = /^Exit code (\d+)/.exec(output);
    if (m) return Number(m[1]);
    return isError ? null : 0;
  },
  // A Write of an existing file is an update: it becomes an edit with its patch.
  applyResult(detail, r, cwd) {
    if (detail.type !== "edit" && detail.type !== "write") return undefined;
    const patch = str(r.gitDiff?.patch) ?? diffFromHunks(relPath(detail.path, cwd), r.structuredPatch);
    return patch && (detail.type === "edit" || r.type === "update") ? { type: "edit", path: detail.path, diff: patch } : detail;
  },
};
