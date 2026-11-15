#!/usr/bin/env python3
"""Writes the image fixtures for tests/host/images.test.ts (needs Pillow).
Each is a real file of its format, at an odd size that says which bytes
the host's header reader must get right (sizes over 255 need the high byte)."""
import struct
import zlib
from pathlib import Path
from PIL import Image

here = Path(__file__).parent

def img(w, h, mode="RGB"):
    im = Image.new(mode, (w, h))
    im.putdata([((x * 7) % 256, (y * 5) % 256, 120, 200)[: len(mode)] for y in range(h) for x in range(w)])
    return im

def exif(orientation):
    e = Image.Exif()
    e[0x0112] = orientation
    e[0x010F] = "fixture"
    return e

img(270, 11).save(here / "exif.jpg", exif=exif(1))
img(300, 12).save(here / "rot6.jpg", exif=exif(6))
img(48, 260).save(here / "progressive.jpg", progressive=True)
img(21, 300).convert("P").save(here / "anim.gif")
img(260, 10).save(here / "lossy.webp", lossless=False)
img(300, 7).save(here / "lossless.webp", lossless=True)
img(513, 9, "RGBA").save(here / "alpha.webp", lossless=False)

# A baseline JPEG with fill bytes (0xFF runs, allowed before any marker) before each marker after SOI.
img(33, 17).save(here / "fill.jpg")
b = (here / "fill.jpg").read_bytes()
out, i = bytearray(b[:2]), 2
while i < len(b) - 1 and b[i] == 0xFF and b[i + 1] != 0xDA:
    n = struct.unpack(">H", b[i + 2 : i + 4])[0]
    out += b"\xff\xff\xff" + b[i : i + 2 + n]
    i += 2 + n
(here / "fill.jpg").write_bytes(bytes(out + b[i:]))

# Apple's CgBI PNG: a CgBI chunk before IHDR. The bytes where IHDR's size would be are something else.
p = here / "cgbi.png"
img(40, 20).save(p)
raw = p.read_bytes()
cgbi = struct.pack(">I", 4) + b"CgBI" + b"\x50\x00\x20\x06" + struct.pack(">I", zlib.crc32(b"CgBI\x50\x00\x20\x06"))
p.write_bytes(raw[:8] + cgbi + raw[8:])

(here / "truncated.jpg").write_bytes((here / "exif.jpg").read_bytes()[:40])
