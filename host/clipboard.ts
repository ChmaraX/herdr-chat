// The clipboard image → a PNG file, and image files → ImageContent (base64 + MIME type).
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, statSync, existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join, extname } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { imageSize } from "./imagesize.ts";
import { IS_MAC, OS } from "./platform.ts";

/**
 * Saves the clipboard's image as `path` (its folder must exist): `path`, or null when it holds none.
 * Throws with a user-facing message when the clipboard can't be read at all (Linux: no display, no tool).
 */
export function clipboardImage(path: string): Promise<string | null> {
  if (OS === "linux") return linuxClipboardImage(path);
  if (!IS_MAC) return Promise.resolve(null);
  const script = [
    "set png to (the clipboard as «class PNGf»)",
    `set f to open for access (POSIX file ${JSON.stringify(path)}) with write permission`,
    "set eof f to 0",
    "write png to f",
    "close access f",
  ];
  return new Promise((resolve) => {
    execFile("osascript", script.flatMap((l) => ["-e", l]), { timeout: 10_000 }, (err) => {
      if (err || !existsSync(path) || statSync(path).size === 0) {
        try {
          unlinkSync(path);
        } catch {}
        resolve(null);
      } else resolve(path);
    });
  });
}

type Output = { bytes: Buffer } | { missing: true } | { failed: true };

/** A program's whole stdout as bytes; `missing` when it isn't installed. */
function output(cmd: string, args: string[]): Promise<Output> {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: "buffer", timeout: 10_000, maxBuffer: MAX_SOURCE_BYTES }, (err, stdout) =>
      resolve(!err ? { bytes: stdout } : (err as NodeJS.ErrnoException).code === "ENOENT" ? { missing: true } : { failed: true }));
  });
}

/** A clipboard tool: how it lists the clipboard's types, and how it reads the PNG. */
type ClipboardTool = { cmd: string; pkg: string; listTypes: string[]; readPng: string[] };
const WL_PASTE: ClipboardTool = { cmd: "wl-paste", pkg: "wl-clipboard", listTypes: ["--list-types"], readPng: ["--no-newline", "--type", "image/png"] };
const XCLIP: ClipboardTool = { cmd: "xclip", pkg: "xclip", listTypes: ["-selection", "clipboard", "-t", "TARGETS", "-o"], readPng: ["-selection", "clipboard", "-t", "image/png", "-o"] };

/**
 * Linux: the clipboard's PNG through wl-clipboard on Wayland, else xclip on X11
 * (whichever the session has). Other image types the clipboard offers are
 * left: the chat attaches PNGs from a paste.
 */
async function linuxClipboardImage(path: string): Promise<string | null> {
  const tools = [process.env.WAYLAND_DISPLAY && WL_PASTE, process.env.DISPLAY && XCLIP].filter((t): t is ClipboardTool => Boolean(t));
  if (!tools.length) throw new Error("Image paste needs a Wayland or X11 session, and the chat's host has neither (no WAYLAND_DISPLAY or DISPLAY)");
  let installed = false;
  for (const tool of tools) {
    const types = await output(tool.cmd, tool.listTypes);
    if ("missing" in types) continue;
    installed = true;
    if ("failed" in types) continue;
    if (!types.bytes.toString("utf8").split(/\s+/).includes("image/png")) return null;
    const png = await output(tool.cmd, tool.readPng);
    if (!("bytes" in png) || sniff(png.bytes) !== "image/png") return null;
    writeFileSync(path, png.bytes);
    return path;
  }
  if (!installed) throw new Error(`Image paste needs ${tools.map((t) => `${t.cmd} (${t.pkg})`).join(" or ")}`);
  return null;
}

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
export const IMAGE_LIMITS = { bytes: 5 * 1024 * 1024, count: 20, total: 20 * 1024 * 1024 };

function sniff(b: Buffer): string | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (b.length >= 12 && b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

export type ImageContent = { type: "image"; data: string; mimeType: string };

export const MAX_EDGE = 2000;

function run(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 20_000 }, (err, stdout) => resolve(err ? null : stdout));
  });
}

/** How to shrink `file` in place to a MAX_EDGE longest edge, in the order to try: `sips` on macOS; ImageMagick elsewhere, when installed. */
function shrinkCommands(file: string): { cmd: string; args: string[] }[] {
  if (IS_MAC) return [{ cmd: "sips", args: ["-Z", String(MAX_EDGE), file] }];
  const args = [file, "-resize", `${MAX_EDGE}x${MAX_EDGE}>`, file];
  return [{ cmd: "magick", args }, { cmd: "convert", args }];
}

/**
 * Downscales to a MAX_EDGE longest edge (`sips -Z` on macOS, ImageMagick's
 * `magick` or `convert` elsewhere). Returns the original bytes when smaller,
 * or when no tool can do it.
 */
export async function downscale(path: string, bytes: Buffer, mime: string): Promise<Buffer> {
  if (OS === "win32") return bytes;
  const dim = imageSize(bytes);
  if (!dim || Math.max(dim.w, dim.h) <= MAX_EDGE) return bytes;
  const dir = join(tmpdir(), "herdr-chat-images");
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `scaled-${Date.now()}-${randomBytes(3).toString("hex")}${extname(path) || ".png"}`);
  try {
    writeFileSync(tmp, bytes);
    let shrunk = false;
    for (const { cmd, args } of shrinkCommands(tmp)) if ((shrunk = (await run(cmd, args)) !== null)) break;
    if (!shrunk) return bytes;
    const out = readFileSync(tmp);
    return out.length && sniff(out) === mime ? out : bytes;
  } catch {
    return bytes;
  } finally {
    try {
      unlinkSync(tmp);
    } catch {}
  }
}

const MAX_SOURCE_BYTES = 64 * 1024 * 1024;

/** An image file's bytes and MIME type, checked (Orca's checks). Throws with a user-facing message. */
export function readImage(p: string): { bytes: Buffer; mime: string } {
  if (/^[a-z]+:\/\//i.test(p)) throw new Error("Image URLs aren't supported: save the image and attach the file");
  const mime = MIME[extname(p).toLowerCase()];
  if (!mime) throw new Error(`Unsupported image type: ${p}`);
  let bytes: Buffer;
  try {
    if (statSync(p).size > MAX_SOURCE_BYTES) throw new Error("too big");
    bytes = readFileSync(p);
  } catch {
    throw new Error(`Could not read image (or larger than 64 MiB): ${p}`);
  }
  if (!bytes.length) throw new Error(`Image is empty: ${p}`);
  if (sniff(bytes) !== mime) throw new Error(`Not a valid ${mime.slice(6).toUpperCase()} file: ${p}`);
  return { bytes, mime };
}

/** Reads and checks image files, downscaling large ones first. The caps apply to what is sent. */
export async function loadImages(paths: string[]): Promise<ImageContent[]> {
  if (paths.length > IMAGE_LIMITS.count) throw new Error(`Too many images (at most ${IMAGE_LIMITS.count})`);
  let total = 0;
  const out: ImageContent[] = [];
  for (const p of paths) {
    const { mime, bytes: raw } = readImage(p);
    const bytes = await downscale(p, raw, mime);
    if (bytes.length > IMAGE_LIMITS.bytes) throw new Error(`Image is larger than 5 MiB: ${p}`);
    total += bytes.length;
    if (total > IMAGE_LIMITS.total) throw new Error("Images are larger than 20 MiB in total");
    out.push({ type: "image", data: bytes.toString("base64"), mimeType: mime });
  }
  return out;
}
