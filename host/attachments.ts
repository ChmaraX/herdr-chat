// The composer's images (protocol.md "Attachments"): a pasted or dropped image
// is a file of the chat's own, so the chat can show it before it's sent (the
// app shows only files under its home). They live with the chat, not one host.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { clipboardImage, readImage } from "./clipboard.ts";

// A copy's name is `<ms>-<hex>-<name>`: room for the prefix under the usual 255-byte limit.
const MAX_NAME_BYTES = 200;

function shortened(name: string): string {
  const ext = extname(name);
  let stem = [...name.slice(0, name.length - ext.length)];
  while (stem.length && Buffer.byteLength(stem.join("") + ext) > MAX_NAME_BYTES) stem.pop();
  return stem.join("") + ext;
}

export class Attachments {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = resolve(dir);
  }

  private newPath(name: string): string {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    return join(this.dir, `${Date.now()}-${randomBytes(3).toString("hex")}-${shortened(name)}`);
  }

  /** The clipboard's image; null when it holds none. */
  fromClipboard(): Promise<string | null> {
    return clipboardImage(this.newPath("paste.png"));
  }

  /** A copy of an image file. Throws with a user-facing message. */
  fromFile(path: string): string {
    const { bytes } = readImage(path);
    const out = this.newPath(basename(path));
    writeFileSync(out, bytes, { mode: 0o600 });
    return out;
  }

  /** Removes one. Any other path (the person's own file) is left alone. */
  remove(path: string): void {
    if (dirname(resolve(path)) === this.dir) rmSync(path, { force: true });
  }

  clear(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}
