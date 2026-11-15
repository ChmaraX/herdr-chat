// An image's pixel size as drawn, read from its header, for the formats the
// host saves (PNG, JPEG, GIF, WebP). Null for anything else or a header it
// can't read.

export type ImageSize = { w: number; h: number };
/** A saved image: its file, and its pixel size as drawn (null when its header can't be read). */
export type ImageFile = { path: string; size: ImageSize | null };

export function imageSize(b: Buffer): ImageSize | null {
  const size = header(b);
  return size && size.w > 0 && size.h > 0 ? size : null;
}

function header(b: Buffer): ImageSize | null {
  const tag = (at: number, s: string) => b.length >= at + s.length && b.toString("latin1", at, at + s.length) === s;
  if (tag(1, "PNG")) return tag(12, "IHDR") && b.length >= 24 ? { w: b.readUInt32BE(16), h: b.readUInt32BE(20) } : null;
  if (tag(0, "GIF") && b.length >= 10) return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
  if (b[0] === 0xff && b[1] === 0xd8) return jpeg(b);
  if (tag(0, "RIFF") && tag(8, "WEBP") && b.length >= 30) {
    if (tag(12, "VP8 ")) return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
    if (tag(12, "VP8L")) {
      const bits = b.readUInt32LE(21);
      return { w: (bits & 0x3fff) + 1, h: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (tag(12, "VP8X")) return { w: b.readUIntLE(24, 3) + 1, h: b.readUIntLE(27, 3) + 1 };
  }
  return null;
}

const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const NO_LENGTH = new Set([0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8]); // TEM, RST0–7, SOI

// The first start-of-frame segment's size. EXIF orientations 5–8 turn the
// image a quarter, and image() draws it turned, so those swap w and h.
function jpeg(b: Buffer): ImageSize | null {
  let orientation = 1;
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) return null;
    while (b[i] === 0xff) i++;
    const m = b[i++];
    if (m === undefined || m === 0xd9 || m === 0xda) return null;
    if (NO_LENGTH.has(m)) continue;
    if (i + 2 > b.length) return null;
    const len = b.readUInt16BE(i);
    if (len < 2 || i + len > b.length) return null;
    if (SOF.has(m)) {
      if (len < 7) return null;
      const h = b.readUInt16BE(i + 3);
      const w = b.readUInt16BE(i + 5);
      return orientation >= 5 && orientation <= 8 ? { w: h, h: w } : { w, h };
    }
    if (m === 0xe1) orientation = exifOrientation(b.subarray(i + 2, i + len)) ?? orientation;
    i += len;
  }
  return null;
}

// Tag 0x0112 of an APP1 "Exif" segment's first IFD.
function exifOrientation(app1: Buffer): number | null {
  if (app1.length < 14 || app1.toString("latin1", 0, 6) !== "Exif\0\0") return null;
  const t = app1.subarray(6);
  const order = t.toString("latin1", 0, 2);
  if (order !== "II" && order !== "MM") return null;
  const le = order === "II";
  const u16 = (at: number) => (le ? t.readUInt16LE(at) : t.readUInt16BE(at));
  const ifd = le ? t.readUInt32LE(4) : t.readUInt32BE(4);
  if (ifd + 2 > t.length) return null;
  for (let e = ifd + 2, n = u16(ifd); n > 0 && e + 12 <= t.length; n--, e += 12) {
    if (u16(e) === 0x0112) return u16(e + 8);
  }
  return null;
}
