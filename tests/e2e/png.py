"""Read a `herdr-app shot` PNG with the standard library only, on macOS and in
the Linux test box alike (no pyobjc): 8-bit RGBA or RGB, non-interlaced, which
is what the app writes. rgba(path) -> (bytes, width, height, row_bytes) with 4
bytes a pixel; grey(path, w, h) -> one byte a point, the frame scaled to w×h
(nearest pixel: shots are at 1× or 2× of the window's points)."""
import struct
import zlib


def _paeth(a, b, c):
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    return a if pa <= pb and pa <= pc else (b if pb <= pc else c)


def rgba(path):
    data = open(path, "rb").read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"{path}: not a PNG")
    pos, idat, w = 8, [], None
    while pos < len(data):
        n, kind = struct.unpack(">I4s", data[pos:pos + 8])
        body = data[pos + 8:pos + 8 + n]
        if kind == b"IHDR":
            w, h, depth, ctype, _, _, interlace = struct.unpack(">IIBBBBB", body)
            if depth != 8 or ctype not in (2, 6) or interlace:
                raise ValueError(f"{path}: not an 8-bit RGB(A) non-interlaced PNG")
            bpp = 4 if ctype == 6 else 3
        elif kind == b"IDAT":
            idat.append(body)
        elif kind == b"IEND":
            break
        pos += 12 + n
    raw = zlib.decompress(b"".join(idat))
    stride = w * bpp
    out = bytearray(w * h * 4)
    prev = bytearray(stride)
    i = 0
    for y in range(h):
        f = raw[i]
        line = bytearray(raw[i + 1:i + 1 + stride])
        i += 1 + stride
        if f == 1:
            for x in range(bpp, stride):
                line[x] = (line[x] + line[x - bpp]) & 255
        elif f == 2:
            for x in range(stride):
                line[x] = (line[x] + prev[x]) & 255
        elif f == 3:
            for x in range(stride):
                left = line[x - bpp] if x >= bpp else 0
                line[x] = (line[x] + ((left + prev[x]) >> 1)) & 255
        elif f == 4:
            for x in range(stride):
                left = line[x - bpp] if x >= bpp else 0
                up_left = prev[x - bpp] if x >= bpp else 0
                line[x] = (line[x] + _paeth(left, prev[x], up_left)) & 255
        if bpp == 4:
            out[y * w * 4:(y + 1) * w * 4] = line
        else:
            o = y * w * 4
            for x in range(w):
                out[o + 4 * x:o + 4 * x + 3] = line[3 * x:3 * x + 3]
                out[o + 4 * x + 3] = 255
        prev = line
    return bytes(out), w, h, w * 4


def grey(path, W, H):
    data, w, h, row = rgba(path)
    out = bytearray(W * H)
    for y in range(H):
        sy = min(h - 1, y * h // H)
        base = sy * row
        for x in range(W):
            i = base + 4 * min(w - 1, x * w // W)
            out[y * W + x] = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) // 1000
    return bytes(out)
