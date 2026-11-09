#!/usr/bin/env node
// Builds the release: what the one-line install downloads, unpacks and runs,
// with no clone, no TypeScript and no npm install.
//
//   node scripts/build.mjs [--version X.Y.Z] [--out DIR]     (npm run build)
//
// Writes, in DIR (default dist/):
//   herdr-chat-<version>/          the tree, laid out like the repo:
//     host/main.js                 host/main.ts and its dependencies (highlight.js,
//                                  beautiful-mermaid) in one file, for Node >= NODE_MIN
//     install/*.js                 install/*.ts, each one file; install/app.sh
//     bin/ herdr-app/mods/ extension/ install.sh LICENSE README.md CHANGELOG.md
//     package.json                 name, version, engines (node >= NODE_MIN), herdr
//   herdr-chat-<version>.tar.gz    that tree
//   SHA256SUMS                     its SHA-256, as `shasum -a 256` writes it
// --version: another version than package.json's (the install's update test).
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

/** The oldest Node a release runs on: the host suite passes on the built host there (CI: test-built). */
const NODE_MIN = 20;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (f) => { const i = process.argv.indexOf(f); return i > 0 ? process.argv[i + 1] : undefined; };
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const version = arg("--version") ?? pkg.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`not a version: ${version}`);
const out = resolve(arg("--out") ?? join(ROOT, "dist"));
const name = `herdr-chat-${version}`;
const tree = join(out, name);
rmSync(tree, { recursive: true, force: true });
mkdirSync(tree, { recursive: true });

// Bundled CommonJS (highlight.js) calls require; an ES module has none of its own.
const banner = { js: "import { createRequire as __herdrChatRequire } from 'node:module'; const require = __herdrChatRequire(import.meta.url);" };
const common = { bundle: true, platform: "node", format: "esm", target: `node${NODE_MIN}`, banner, logLevel: "warning", legalComments: "none" };
await build({ ...common, entryPoints: [join(ROOT, "host", "main.ts")], outfile: join(tree, "host", "main.js") });
// Each install script runs on its own (`node install/keys.js install …`): its
// `if (import.meta.main)` is true there, and Node < 24 has no import.meta.main.
for (const f of readdirSync(join(ROOT, "install")).filter((f) => f.endsWith(".ts"))) {
  await build({ ...common, entryPoints: [join(ROOT, "install", f)], outfile: join(tree, "install", f.replace(/\.ts$/, ".js")), define: { "import.meta.main": "true" } });
}

// What the Herdr app writes into a mod folder in a clone (and hidden files) isn't shipped.
const shipped = (src) => !/(^|\/)(\.[^/]*|gpui-kit\.d\.ts|herdr\.d\.ts|jsconfig\.json)$/.test(src);
for (const p of ["bin", "herdr-app/mods", "extension"]) cpSync(join(ROOT, p), join(tree, p), { recursive: true, filter: shipped });
for (const f of ["install.sh", "LICENSE", "README.md", "CHANGELOG.md"]) if (existsSync(join(ROOT, f))) cpSync(join(ROOT, f), join(tree, f));
cpSync(join(ROOT, "install", "app.sh"), join(tree, "install", "app.sh"));
const release = {
  name: pkg.name, version, private: true, type: "module", description: pkg.description, license: pkg.license,
  repository: pkg.repository, homepage: pkg.homepage, engines: { node: `>=${NODE_MIN}` }, herdr: pkg.herdr,
};
writeFileSync(join(tree, "package.json"), JSON.stringify(release, null, 2) + "\n");

// The archive: the one folder (COPYFILE_DISABLE: no macOS ._ files in it).
const tgz = `${name}.tar.gz`;
rmSync(join(out, tgz), { force: true });
execFileSync("tar", ["-czf", tgz, name], { cwd: out, env: { ...process.env, COPYFILE_DISABLE: "1" } });
const sum = createHash("sha256").update(readFileSync(join(out, tgz))).digest("hex");
// One line per archive in DIR: this one's replaced, others' kept (a test builds two versions).
const sums = join(out, "SHA256SUMS");
const others = existsSync(sums) ? readFileSync(sums, "utf8").split("\n").filter((l) => l && !l.endsWith(`  ${tgz}`)) : [];
writeFileSync(sums, [...others, `${sum}  ${tgz}`].sort((a, b) => a.slice(66).localeCompare(b.slice(66))).join("\n") + "\n");
process.stdout.write(`${join(out, tgz)}\n`);
