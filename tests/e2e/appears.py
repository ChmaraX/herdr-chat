"""Whether a sent image's row appears whole in the frame that makes room for it (#16).

  appears.py FRAMES OUT.json R,G,B [R,G,B …]

FRAMES holds a `herdr-app shot` burst, one <ms>.png per frame, from before
the send until after it, with nothing else moving on screen; the colours are
the sent images' own (flat blocks the test drew). Before the send they show
only as the composer's chips, small thumbnails that go when it's sent.
- shown: the first frame with the images fully on screen, and their box then.
- changed: the first frame where that box's pixels differ from the burst's
  first frame (the rows above moved away, or the new row began to draw there).
- whole: the message's text, just above the images, at its shown pixels. Text
  draws with its row; image() may draw a new file a frame later.
Exit 1 when a frame from changed to shown doesn't have the row whole: a hole
where the row should be, or the row fading in. Exit 2 when the frames are too
far apart around the change to see that. Needs pyobjc (Quartz)."""
import json
import os
import sys

import Quartz
from Foundation import NSURL

STEP = 2  # sample every 2nd point: the colour blocks and the text are bigger
TOL = 22
# A hole lasts a frame, then the old fade took ~90 of its 120 ms to draw the text at 0.9:
# a frame at most this long after the last unchanged one lands inside that.
MAX_GAP_MS = 100
# The composer's chips (64x48 each) against the sent row's thumbnails (up to 320 pt): a few % of their points.
CHIPS = 0.1


def pixels(path):
    src = Quartz.CGImageSourceCreateWithURL(NSURL.fileURLWithPath_(path), None)
    img = Quartz.CGImageSourceCreateImageAtIndex(src, 0, None)
    if Quartz.CGImageGetBitsPerPixel(img) != 32 or Quartz.CGImageGetAlphaInfo(img) not in (1, 3, 5):
        sys.exit(f"{path}: not an RGBA shot")
    w, h, row = Quartz.CGImageGetWidth(img), Quartz.CGImageGetHeight(img), Quartz.CGImageGetBytesPerRow(img)
    return bytes(Quartz.CGDataProviderCopyData(Quartz.CGImageGetDataProvider(img))), w, h, row


def scan(path, colours):
    """The points in the images' colours, and the RGB at every sampled point."""
    data, w, h, row = pixels(path)
    hits, rgb = [], {}
    for y in range(0, h, STEP):
        base = y * row
        for x in range(int(w * 0.15), w, STEP):  # not the sidebar
            i = base + 4 * x
            p = data[i], data[i + 1], data[i + 2]
            rgb[x, y] = p
            if any(abs(p[0] - c[0]) <= TOL and abs(p[1] - c[1]) <= TOL and abs(p[2] - c[2]) <= TOL for c in colours):
                hits.append((x, y))
    return hits, rgb


def same(a, b, tol):
    return max(abs(u - v) for u, v in zip(a, b)) <= tol


def main():
    frames, out = sys.argv[1], sys.argv[2]
    colours = [tuple(int(v) for v in c.split(",")) for c in sys.argv[3:]]
    names = sorted((f for f in os.listdir(frames) if f.endswith(".png") and f[:-4].isdigit()), key=lambda f: int(f[:-4]))
    if len(names) < 3:
        sys.exit(f"only {len(names)} frames")
    scans = [(int(f[:-4]), *scan(os.path.join(frames, f), colours)) for f in names]
    t0, first_hits, first = scans[0]
    full = max(len(hits) for _, hits, _ in scans)
    shown = next(((t, hits, rgb) for t, hits, rgb in scans if full and len(hits) >= 0.9 * full), None)
    res = {"frames": len(scans), "msSpan": [0, scans[-1][0] - t0], "imagePointsWhenShown": full}

    def give_up(problem):
        json.dump(res | {"problem": problem}, open(out, "w"), indent=1)
        print(problem)
        return 1

    if len(first_hits) > CHIPS * full or not shown:
        return give_up("the images are on screen before the send" if shown else "the images never showed")
    t_shown, hits, shown_rgb = shown
    chips = set(first_hits)
    hits = [k for k in hits if k not in chips]
    x0, y0, x1, y1 = min(x for x, _ in hits), min(y for _, y in hits), max(x for x, _ in hits), max(y for _, y in hits)
    text = [k for k, p in shown_rgb.items() if x0 - 4 <= k[0] <= x1 and y0 - 40 <= k[1] <= y0 - 4 and min(p) > 150]
    if len(text) < 10:
        return give_up(f"no message text above the images ({len(text)} points)")
    inside = [k for k in first if x0 <= k[0] <= x1 and y0 <= k[1] <= y1]
    changed = next(t for t, _, rgb in scans if sum(not same(rgb[k], first[k], 30) for k in inside) > 0.02 * len(inside))
    gap = changed - max(t for t, _, _ in scans if t < changed)
    if gap > MAX_GAP_MS:
        res["inconclusive"] = f"{gap} ms between the last frame before the change and the first after it (at most {MAX_GAP_MS})"
        json.dump(res, open(out, "w"), indent=1)
        print(res["inconclusive"])
        return 2
    between = []
    for t, h, rgb in scans:
        if changed <= t < t_shown:
            whole = sum(same(rgb[k], shown_rgb[k], 24) for k in text) / len(text)
            between.append({"ms": t - t0, "textShown": round(whole, 2), "imagesShown": round(len(h) / full, 2)})
    holes = [b for b in between if b["textShown"] < 0.9]
    res |= {
        "box": {"x": x0, "y": y0, "w": x1 - x0 + 1, "h": y1 - y0 + 1}, "textPoints": len(text),
        "boxChangedMs": changed - t0, "gapBeforeChangeMs": gap, "imagesShownMs": t_shown - t0, "framesBetween": between,
        "keyFrames": [f"{changed}.png", f"{t_shown}.png"],
    }
    if holes:
        return give_up(f"the row wasn't whole in {len(holes)} frame(s) after its place on screen changed at {changed - t0} ms: a hole or a fade-in ({holes})")
    json.dump(res, open(out, "w"), indent=1)
    late = f"; the images {t_shown - changed} ms later (image() drew the new files a frame late)" if between else ""
    print(f"the row whole at {changed - t0} ms, the frame its place changed{late}")
    return 0


sys.exit(main())
