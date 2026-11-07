// Pi's tools (lowercase names; extensions add their own, which become generic
// cards unless they use one of these names).
import type { ToolMap } from "../../tools.ts";

export const PI_TOOLS: ToolMap = {
  names: {
    bash: "bash", shell: "bash", powershell: "bash",
    read: "read",
    edit: "edit", multiedit: "edit", str_replace: "edit",
    write: "write",
    grep: "search", find: "search", ls: "search", glob: "search",
  },
};
