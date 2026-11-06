// The host's command line: `<cmd> [--flag value]… [rest]… [-- after…]`.
export type Args = { cmd: string; flags: Map<string, string[]>; rest: string[]; after: string[] };

export function parseArgs(argv: string[]): Args {
  const [cmd = "help", ...tail] = argv;
  const flags = new Map<string, string[]>();
  const rest: string[] = [];
  let after: string[] = [];
  for (let i = 0; i < tail.length; i++) {
    const a = tail[i]!;
    if (a === "--") {
      after = tail.slice(i + 1);
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
      const val = eq > 0 ? a.slice(eq + 1) : tail[i + 1] !== undefined && !tail[i + 1]!.startsWith("--") ? tail[++i]! : "true";
      flags.set(key, [...(flags.get(key) ?? []), val]);
    } else rest.push(a);
  }
  return { cmd, flags, rest, after };
}
