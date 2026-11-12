// Which herdr-chat a host runs: package.json's version, and `build`, a hash of
// the host's own code (host/, the TypeScript in a clone, the built JS in a
// release). The install writes the same into mods/chat/config.json
// (`herdr-chat-host build`), so the chat can tell a host started before the
// install from one started after it. Only the host's code counts: the mods
// reload by themselves.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export type Build = { version: string; build: string };

const HOST_DIR = dirname(fileURLToPath(import.meta.url));

function files(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...files(p));
    else if (e.isFile() && /\.(ts|js|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

let cached: Build | null = null;

/** Read once, at start: what this process loaded. */
export function hostBuild(): Build {
  if (cached) return cached;
  let version = "0.0.0"; // no package.json beside host/ (never in a clone or a release)
  try {
    const pkg: unknown = JSON.parse(readFileSync(join(HOST_DIR, "..", "package.json"), "utf8"));
    if (pkg && typeof pkg === "object" && "version" in pkg && typeof pkg.version === "string") version = pkg.version;
  } catch {}
  const h = createHash("sha256");
  for (const f of files(HOST_DIR).sort()) {
    h.update(relative(HOST_DIR, f)).update("\0").update(readFileSync(f)).update("\0");
  }
  cached = { version, build: h.digest("hex").slice(0, 12) };
  return cached;
}
