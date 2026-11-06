// LF-only JSONL framing with a size cap, shared by the agent transports and the TCP server.

export const MAX_RECORD_BYTES = 8 * 1024 * 1024;
const HEAD_BYTES = 4096;

export type Oversized = { size: number; head: string };

/**
 * Splits a byte stream on LF only (never U+2028/U+2029). A record larger than
 * `max` bytes is dropped; its first HEAD_BYTES are kept so the caller can
 * recover what kind of record it was.
 */
export class LineFramer {
  private parts: Buffer[] = [];
  private size = 0;
  private dropping = false;
  private head: Buffer | null = null;
  private max: number;
  onLine: (line: string) => void = () => {};
  onOversized: (o: Oversized) => void = () => {};

  constructor(max = MAX_RECORD_BYTES) {
    this.max = max;
  }

  push(chunk: Buffer): void {
    let start = 0;
    while (start < chunk.length) {
      const nl = chunk.indexOf(10, start);
      const end = nl < 0 ? chunk.length : nl;
      const piece = chunk.subarray(start, end);
      if (this.dropping) {
        this.size += piece.length;
      } else if (this.size + piece.length > this.max) {
        const all = Buffer.concat([...this.parts, piece]);
        this.head = all.subarray(0, HEAD_BYTES);
        this.size += piece.length;
        this.parts = [];
        this.dropping = true;
      } else {
        this.parts.push(Buffer.from(piece));
        this.size += piece.length;
      }
      if (nl < 0) break;
      this.end();
      start = nl + 1;
    }
  }

  private end(): void {
    if (this.dropping) {
      this.onOversized({ size: this.size, head: (this.head ?? Buffer.alloc(0)).toString("utf8") });
    } else if (this.size > 0) {
      let line = Buffer.concat(this.parts).toString("utf8");
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length) this.onLine(line);
    }
    this.parts = [];
    this.size = 0;
    this.dropping = false;
    this.head = null;
  }

  /** Flushes an unterminated last record (stream end). */
  finish(): void {
    if (this.size > 0 || this.dropping) this.end();
  }
}
