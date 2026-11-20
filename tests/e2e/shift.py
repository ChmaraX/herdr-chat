"""How far the transcript moved on screen between consecutive frames (#28).

  shift.py FRAMES WANT OUT.json

FRAMES holds `herdr-app shot` frames 000.png, 001.png, … taken after equal
scroll steps (chat.scroll:by:<dy>, what one wheel event of dy does). Each step
should move the content down by WANT window pt (dy × the UI zoom). The shift
between two frames is the vertical offset at which most of their pixel rows
match (the transcript only: no sidebar, composer or scrollbar). Rows without
ink don't vote. FRAMES/steps.jsonl, when there, has the mod's state after each
step, joined to the result.
Exit 1 when a step moved more than TOL pt off WANT, or can't be matched.
Needs pyobjc (Quartz)."""
import json
import os
import sys
from collections import Counter

import Quartz
from Foundation import NSURL

W, H = 1280, 820  # the e2e window, in pt (lib.sh)
X0, X1, Y0, Y1 = 420, 1180, 110, 560  # the transcript at any zoom the flow uses
BLOCK = 8  # columns averaged per sample
LEVELS = 24  # a sample's grey level, quantized: equal rows match exactly
INK = 3  # a row votes when this many of its samples differ from its first
TOL = 2
MAX_SHIFT = 360


def grey(path):
    """The frame in grey at W×H pt, one byte a point."""
    src = Quartz.CGImageSourceCreateWithURL(NSURL.fileURLWithPath_(path), None)
    img = Quartz.CGImageSourceCreateImageAtIndex(src, 0, None)
    ctx = Quartz.CGBitmapContextCreate(None, W, H, 8, W, Quartz.CGColorSpaceCreateDeviceGray(), Quartz.kCGImageAlphaNone)
    Quartz.CGContextDrawImage(ctx, Quartz.CGRectMake(0, 0, W, H), img)
    return bytes(Quartz.CGBitmapContextGetData(ctx).as_buffer(W * H))


def rows(path):
    """Each transcript row as a key (its quantized column blocks), None without ink."""
    g = grey(path)
    out = []
    for y in range(Y0, Y1):
        base = y * W
        key = tuple(sum(g[base + x:base + x + BLOCK]) * LEVELS // (256 * BLOCK) for x in range(X0, X1, BLOCK))
        out.append(key if sum(1 for v in key if v != key[0]) >= INK else None)
    return out


def shift(prev, cur):
    """The shift s (content down by s pt) most rows agree on: cur[y + s] == prev[y]."""
    at = {}
    for y, k in enumerate(cur):
        if k is not None:
            at.setdefault(k, []).append(y)
    votes = Counter()
    for y, k in enumerate(prev):
        for y2 in at.get(k, ()) if k is not None else ():
            if -60 <= y2 - y <= MAX_SHIFT:
                votes[y2 - y] += 1
    if not votes:
        return None, 0
    s, n = votes.most_common(1)[0]
    return s, n


def main():
    frames, want, out = sys.argv[1], float(sys.argv[2]), sys.argv[3]
    names = sorted(f for f in os.listdir(frames) if f.endswith(".png") and f[:-4].isdigit())
    st_path = os.path.join(frames, "steps.jsonl")
    states = [json.loads(l) for l in open(st_path) if l.strip()] if os.path.exists(st_path) else []
    prev = rows(os.path.join(frames, names[0]))
    steps = []
    for i in range(1, len(names)):
        cur = rows(os.path.join(frames, names[i]))
        s, n = shift(prev, cur)
        st = states[i] if i < len(states) else {}
        st0 = states[i - 1] if i - 1 < len(states) else {}
        steps.append({"step": i, "moved": s, "votes": n, "err": None if s is None or n < 20 else round(s - want, 1),
                      "top": st.get("top"), "items": st.get("items"), "first": st.get("first"),
                      "historyLoaded": bool(st0) and st.get("items") != st0.get("items")})
        prev = cur
    bad = [s for s in steps if s["err"] is None or abs(s["err"]) > TOL]
    res = {"want": want, "tolerance": TOL, "steps": len(steps), "uneven": len(bad),
           "largestErr": max([abs(s["err"]) for s in steps if s["err"] is not None] or [0]), "perStep": steps}
    json.dump(res, open(out, "w"), indent=1)
    for s in steps:
        mark = "" if s not in bad else "  <-- UNEVEN"
        print(f"step {s['step']:2}: moved {s['moved']} pt (want {want:g}, votes {s['votes']}){' · history loaded' if s['historyLoaded'] else ''}{mark}")
    print(f"{len(bad)} of {len(steps)} steps moved a different amount than {want:g} pt; largest error {res['largestErr']} pt")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
