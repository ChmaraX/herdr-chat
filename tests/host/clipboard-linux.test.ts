// Linux's clipboard image: wl-paste on Wayland, xclip on X11. Stand-ins on PATH
// play the clipboard, so the person's own clipboard is never read or changed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { clipboardImage } from "../../host/clipboard.ts";

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108000000003a7e9b550000000a49444154789c63600000000200015dcc4a5c0000000049454e44ae426082",
  "hex",
);

/** A folder with a stand-in `name` that answers its type listing with `types` and its read with `file`. */
function standIn(name: "wl-paste" | "xclip", types: string, file: string): string {
  const dir = mkdtempSync(join(tmpdir(), "herdr-chat-clip-"));
  writeFileSync(join(dir, "types"), types + "\n");
  const list = name === "wl-paste" ? '[ "$1" = --list-types ]' : 'case " $* " in *" TARGETS "*) true ;; *) false ;; esac';
  writeFileSync(join(dir, name), `#!/bin/sh\nif ${list}; then cat '${join(dir, "types")}'; else cat '${file}'; fi\n`, { mode: 0o755 });
  return dir;
}

async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const before = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(before)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

const linux = process.platform === "linux" ? false : "Linux only";

test("Linux clipboard: a PNG on Wayland is saved; text only, or no tool, is no image", { skip: linux }, async () => {
  const src = join(mkdtempSync(join(tmpdir(), "herdr-chat-png-")), "in.png");
  writeFileSync(src, PNG);
  const out = join(mkdtempSync(join(tmpdir(), "herdr-chat-out-")), "paste.png");

  const wl = standIn("wl-paste", "text/plain\nimage/png", src);
  const got = await withEnv({ PATH: `${wl}:/usr/bin:/bin`, WAYLAND_DISPLAY: "wayland-test", DISPLAY: undefined }, () => clipboardImage(out));
  assert.equal(got, out);
  assert.deepEqual(readFileSync(out), PNG);

  const textOnly = standIn("wl-paste", "text/plain\nUTF8_STRING", src);
  const out2 = out.replace("paste.png", "paste2.png");
  assert.equal(await withEnv({ PATH: `${textOnly}:/usr/bin:/bin`, WAYLAND_DISPLAY: "wayland-test", DISPLAY: undefined }, () => clipboardImage(out2)), null);
  assert.ok(!existsSync(out2), "nothing written");

  const empty = mkdtempSync(join(tmpdir(), "herdr-chat-none-"));
  assert.equal(await withEnv({ PATH: empty, WAYLAND_DISPLAY: "wayland-test", DISPLAY: ":9" }, () => clipboardImage(out2)), null, "neither tool installed");
});

test("Linux clipboard: X11 takes the PNG through xclip; a file that isn't a PNG is no image", { skip: linux }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-chat-x11-"));
  const src = join(dir, "in.png");
  writeFileSync(src, PNG);
  const out = join(dir, "paste.png");
  const x = standIn("xclip", "TARGETS\nimage/png", src);
  assert.equal(await withEnv({ PATH: `${x}:/usr/bin:/bin`, WAYLAND_DISPLAY: undefined, DISPLAY: ":9" }, () => clipboardImage(out)), out);
  assert.deepEqual(readFileSync(out), PNG);

  const bad = join(dir, "bad.png");
  writeFileSync(bad, "not a png");
  const liar = standIn("xclip", "image/png", bad);
  const out2 = join(dir, "paste2.png");
  assert.equal(await withEnv({ PATH: `${liar}:/usr/bin:/bin`, WAYLAND_DISPLAY: undefined, DISPLAY: ":9" }, () => clipboardImage(out2)), null);
  assert.ok(!existsSync(out2), "nothing written");
});
