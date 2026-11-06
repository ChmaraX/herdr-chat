// One notice for the MCP servers that failed to start with an agent, whatever the provider.

export type McpFailure = { name: string; detail?: string | null; auth?: boolean };

/**
 * `3 MCP servers didn't start: a, b, c (OAuth sign-in needed: codex mcp login <name>)`,
 * then one `name: detail` line per server. `login` is the sign-in hint for servers that need one.
 */
export function mcpFailureNotice(failures: McpFailure[], login: string): string {
  const names = failures.map((f) => f.name);
  const auth = failures.filter((f) => f.auth).map((f) => f.name);
  const hint = !auth.length ? "" : auth.length === failures.length ? ` (OAuth sign-in needed: ${login})` : ` (${auth.length} need OAuth sign-in: ${login})`;
  const head = failures.length === 1 ? `MCP server ${names[0]} didn't start${hint}` : `${failures.length} MCP servers didn't start: ${names.join(", ")}${hint}`;
  const lines = failures.filter((f) => f.detail).map((f) => `${f.name}: ${String(f.detail).trim()}`);
  return [head, ...lines].join("\n");
}
