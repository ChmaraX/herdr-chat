"""Read a `herdr-app shot` PNG on macOS and in the Linux test box alike.
rgba(path) -> (bytes, width, height, row_bytes), 4 bytes a pixel; grey(path, w, h)
-> one byte a point, the frame scaled to w×h.

Decoding is native where it can be: Quartz on macOS (what the checks used
before), ImageMagick in the test box (installed there). A pure-Python decoder
is the fallback (8-bit RGB/RGBA, non-interlaced, what the app writes); it is
seconds a frame, so a check over a burst of frames should not depend on it."""
import shutil
import struct
import subprocess
import zlib

try:
    import Quartz
    from Foundation import NSURL
except ImportError:
    Quartz = None
MAGICK = shutil.which("magick") or shutil.which("convert")


def size(path):
    with open(path, "rb") as f:
        head = f.read(24)
    if head[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"{path}: not a PNG")
    return struct.unpack(">II", head[16:24])


def _quartz_image(path):
    src = Quartz.CGImageSourceCreateWithURL(NSURL.fileURLWithPath_(path), None)
    return Quartz.CGImageSourceCreateImageAtIndex(src, 0, None)


def rgba(path):
    if Quartz:
        img = _quartz_image(path)
        w, h = Quartz.CGImageGetWidth(img), Quartz.CGImageGetHeight(img)
        ctx = Quartz.CGBitmapContextCreate(None, w, h, 8, w * 4, Quartz.CGColorSpaceCreateDeviceRGB(),
                                           Quartz.kCGImageAlphaPremultipliedLast)
        Quartz.CGContextDrawImage(ctx, Quartz.CGRectMake(0, 0, w, h), img)
        return bytes(Quartz.CGBitmapContextGetData(ctx).as_buffer(w * h * 4)), w, h, w * 4
    if MAGICK:
        w, h = size(path)
        out = subprocess.run([MAGICK, path, "-depth", "8", "rgba:-"], capture_output=True, check=True).stdout
        return out, w, h, w * 4
    return _rgba_python(path)


def grey(path, W, H):
    """The frame in grey at W×H pt: scaled down by its whole-number scale (2 for a 2× shot),
    never stretched, so rows stay rows (a hidden window's shot can be a row taller than
    the window; scaling 821 rows into 820 would blur every row), then cropped or padded
    at the top left to W×H."""
    w, h = size(path)
    k = max(1, round(w / W))
    sw, sh = w // k, h // k
    if Quartz:
        ctx = Quartz.CGBitmapContextCreate(None, W, H, 8, W, Quartz.CGColorSpaceCreateDeviceGray(), Quartz.kCGImageAlphaNone)
        Quartz.CGContextDrawImage(ctx, Quartz.CGRectMake(0, H - sh, sw, sh), _quartz_image(path))  # (origin bottom left)
        return bytes(Quartz.CGBitmapContextGetData(ctx).as_buffer(W * H))
    if MAGICK:
        return subprocess.run([MAGICK, path, "-resize", f"{sw}x{sh}!", "-colorspace", "Gray", "-background", "black",
                               "-gravity", "NorthWest", "-extent", f"{W}x{H}", "-depth", "8", "gray:-"],
                              capture_output=True, check=True).stdout
    data, w, h, row = _rgba_python(path)
    out = bytearray(W * H)
    for y in range(min(H, sh)):
        base = y * k * row
        for x in range(min(W, sw)):
            i = base + 4 * x * k
            out[y * W + x] = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) // 1000
    return bytes(out)


def _paeth(a, b, c):
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    return a if pa <= pb and pa <= pc else (b if pb <= pc else c)


def _rgba_python(path):
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
