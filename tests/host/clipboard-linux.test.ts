// Linux's clipboard image and image shrinking, through the real host on any OS:
// HERDR_CHAT_PLATFORM=linux, and stand-ins for wl-paste, xclip and ImageMagick on a
// PATH that holds only them and node, so the person's own clipboard and tools are
// never used. Each stand-in answers from files in its folder, which a test rewrites
// between requests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deflateSync, crc32 } from "node:zlib";
import { spawnSync } from "node:child_process";
import { startHost, idle } from "./harness.ts";

/** A w×h grayscale PNG, no dependencies. */
function makePng(w: number, h: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  const rows = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rows[y * (w + 1) + 1 + x] = (x * 7 + y * 3) & 0xff;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}
const pngSize = (b: Buffer) => ({ w: b.readUInt32BE(16), h: b.readUInt32BE(20) });

/** A folder for PATH with `node` in it (fake-pi starts with `#!/usr/bin/env node`) and nothing else yet. */
function binDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "herdr-chat-bin-"));
  symlinkSync(process.execPath, join(dir, "node"));
  return dir;
}

/**
 * A stand-in clipboard tool in `dir`: its type listing prints `dir/<name>.types`, its read
 * prints `dir/<name>.data`; with `dir/<name>.fail` present it fails as a tool with no session does.
 */
function clipboardTool(dir: string, name: "wl-paste" | "xclip"): { offer: (types: string, data: Buffer | string) => void; fail: () => void } {
  const listing = name === "wl-paste" ? '[ "$1" = --list-types ]' : 'case " $* " in *" TARGETS "*) true ;; *) false ;; esac';
  const f = (ext: string) => join(dir, `${name}.${ext}`);
  writeFileSync(join(dir, name), `#!/bin/sh\n[ -e '${f("fail")}' ] && { echo 'no session' >&2; exit 1; }\nif ${listing}; then /bin/cat '${f("types")}'; else /bin/cat '${f("data")}'; fi\n`, { mode: 0o755 });
  return {
    offer: (types, data) => { rmSync(f("fail"), { force: true }); writeFileSync(f("types"), types + "\n"); writeFileSync(f("data"), data); },
    fail: () => writeFileSync(f("fail"), ""),
  };
}

const linuxHost = (name: string, env: Record<string, string>) => startHost({ name, env: { HERDR_CHAT_PLATFORM: "linux", ...env } });
const attachments = (stateDir: string) => readdirSync(join(stateDir, "attachments", "c-test"));

test("Linux clipboard on Wayland: a PNG becomes an attachment; text only, a fake PNG or a failing wl-paste is no image", async () => {
  const bin = binDir();
  const wl = clipboardTool(bin, "wl-paste");
  // xclip is there too, and DISPLAY is not: Wayland's tool is the one asked.
  clipboardTool(bin, "xclip").offer("image/png", makePng(9, 9));
  const h = await linuxHost("clipboard-wayland", { PATH: bin, WAYLAND_DISPLAY: "wayland-test", DISPLAY: "" });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    const png = makePng(4, 3);
    wl.offer("text/plain\nimage/png\nUTF8_STRING", png);
    const got = await c.req("clipboard_image");
    assert.match(got.path, new RegExp(`^${join(h.stateDir, "attachments", "c-test")}/.*-paste\\.png$`), "saved among the chat's attachments");
    assert.deepEqual(readFileSync(got.path), png);
    assert.deepEqual(got.size, { w: 4, h: 3 });

    const before = attachments(h.stateDir);
    wl.offer("text/plain\nUTF8_STRING", png);
    assert.deepEqual(await c.req("clipboard_image"), { path: null }, "text only: no image");
    wl.offer("image/png", "not a png");
    assert.deepEqual(await c.req("clipboard_image"), { path: null }, "a listed PNG that isn't one: no image");
    wl.fail();
    assert.deepEqual(await c.req("clipboard_image"), { path: null }, "wl-paste failing: no image");
    assert.deepEqual(attachments(h.stateDir), before, "nothing written for any of them");
    h.artifact("clipboard-wayland");
  } finally {
    await h.stop();
  }
});

test("Linux clipboard on X11, or Wayland without wl-paste: xclip reads it; with neither tool, or no display, the answer says why", async () => {
  const bin = binDir();
  const x = clipboardTool(bin, "xclip");
  const h = await linuxHost("clipboard-x11", { PATH: bin, WAYLAND_DISPLAY: "wayland-test", DISPLAY: ":9" });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    const png = makePng(2, 5);
    x.offer("TARGETS\nimage/png", png);
    const got = await c.req("clipboard_image");
    assert.deepEqual(readFileSync(got.path), png, "wl-paste isn't installed: xclip's PNG");

    rmSync(join(bin, "xclip"));
    await assert.rejects(c.req("clipboard_image"), /^Error: Image paste needs wl-paste \(wl-clipboard\) or xclip \(xclip\)$/);
    h.artifact("clipboard-x11");
  } finally {
    await h.stop();
  }

  const none = await linuxHost("clipboard-no-display", { PATH: binDir(), WAYLAND_DISPLAY: "", DISPLAY: "" });
  try {
    await none.client.waitFor(idle, 10_000);
    await assert.rejects(none.client.req("clipboard_image"), /Image paste needs a Wayland or X11 session.*no WAYLAND_DISPLAY or DISPLAY/);
  } finally {
    await none.stop();
  }
});

const sentImage = async (h: Awaited<ReturnType<typeof startHost>>, file: string): Promise<Buffer> => {
  const c = h.client;
  const n = h.piCommands().filter((x) => x.type === "prompt").length;
  await c.req("send", { text: "look", images: [file] });
  await c.waitFor(() => h.piCommands().filter((x) => x.type === "prompt").length > n, 10_000, "the prompt");
  await c.waitFor(idle, 10_000);
  return Buffer.from(h.piCommands().filter((x) => x.type === "prompt").at(-1).images[0].data, "base64");
};

test("Linux shrink: ImageMagick's magick, else convert; when both fail or write a bad file, the original is sent", async () => {
  const bin = binDir();
  const h = await linuxHost("shrink-linux", { PATH: bin });
  try {
    await h.client.waitFor(idle, 10_000);
    const wide = join(h.dir, "wide.png");
    writeFileSync(wide, makePng(3000, 40));
    // A stand-in that writes `out` over its last argument (the file to shrink), or exits 1.
    const tool = (name: string, out: Buffer | string | null) => {
      if (out !== null) writeFileSync(join(bin, `${name}.out`), out);
      writeFileSync(join(bin, name), out === null ? "#!/bin/sh\nexit 1\n" : `#!/bin/sh\nfor f; do :; done\n/bin/cat '${join(bin, `${name}.out`)}' > "$f"\n`, { mode: 0o755 });
    };

    assert.deepEqual(pngSize(await sentImage(h, wide)), { w: 3000, h: 40 }, "no ImageMagick: the original");
    tool("magick", null);
    tool("convert", makePng(2000, 27));
    assert.deepEqual(pngSize(await sentImage(h, wide)), { w: 2000, h: 27 }, "magick fails: convert's");
    tool("convert", null);
    assert.deepEqual(pngSize(await sentImage(h, wide)), { w: 3000, h: 40 }, "both fail: the original");
    tool("magick", "garbage");
    assert.deepEqual(pngSize(await sentImage(h, wide)), { w: 3000, h: 40 }, "magick writes something that isn't a PNG: the original");
    tool("magick", "");
    assert.deepEqual(pngSize(await sentImage(h, wide)), { w: 3000, h: 40 }, "magick writes an empty file: the original");
    h.artifact("shrink-linux");
  } finally {
    await h.stop();
  }
});

const magick = spawnSync("sh", ["-c", "command -v magick"], { encoding: "utf8" }).stdout.trim();

test("Linux shrink with the real ImageMagick: 2000 px on the long edge, aspect kept", { skip: magick ? false : "magick isn't installed here" }, async () => {
  const bin = binDir();
  symlinkSync(magick, join(bin, "magick"));
  const h = await linuxHost("shrink-imagemagick", { PATH: bin });
  try {
    await h.client.waitFor(idle, 10_000);
    const wide = join(h.dir, "wide.png");
    writeFileSync(wide, makePng(3000, 40));
    const { w, h: ht } = pngSize(await sentImage(h, wide));
    assert.ok(w === 2000 && (ht === 26 || ht === 27), `${w}×${ht}`);
  } finally {
    await h.stop();
  }
});
