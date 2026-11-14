// The composer's images (protocol.md "Attachments"): a pasted or dropped image
// is a file of the chat's own, so the chat can show it before it's sent (the
// app shows only files under its home). They live with the chat, not one host:
// a restart keeps them for the composer, closing the chat removes them.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { clipboardImage, readImage } from "./clipboard.ts";

export class Attachments {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = resolve(dir);
  }

  /** The clipboard's image; null when it holds none. */
  fromClipboard(): Promise<string | null> {
    return clipboardImage(this.dir);
  }

  /** A copy of an image file. Throws with a user-facing message. */
  fromFile(path: string): string {
    const { bytes } = readImage(path);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const out = join(this.dir, `${Date.now()}-${randomBytes(3).toString("hex")}-${basename(path)}`);
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
