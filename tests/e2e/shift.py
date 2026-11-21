"""How far the transcript moved on screen between frames (#28).

  shift.py steps FRAMES WANT OUT.json   each frame vs the one before: every step moved WANT pt
  shift.py grow FRAMES OUT.json         each frame vs frame 0: how far the rows below an
                                        opening group moved; none further than the last

FRAMES holds `herdr-app shot` frames 000.png, 001.png, … The shift between two
frames is the vertical offset at which their pixel rows match (the transcript
only: no sidebar, composer or scrollbar). Rows without ink don't vote.
FRAMES/steps.jsonl, when there, has the mod's state after each frame, joined to
the result.

steps: a step that moved more than TOL pt off WANT is UNEVEN; one whose best
match has fewer than MIN_VOTES rows can't be measured (a blank frame or a crop
that misses the transcript) and says so. Exit 1 on either.
grow: frame 0 is before the group opens. Rows above the group stay (shift 0);
the rows below it move down by the group's height so far, the largest shift
with MIN_VOTES rows. Exit 1 when a frame moved them further than the last frame
did (an overshoot), or when the last frame can't be measured.

The window's size comes from lib.sh (E2E_WIN_W, E2E_WIN_H). Needs pyobjc (Quartz)."""
import json
import os
import sys
from collections import Counter

import Quartz
from Foundation import NSURL

W, H = int(os.environ.get("E2E_WIN_W", 1280)), int(os.environ.get("E2E_WIN_H", 820))  # the e2e window, in pt
X0, X1, Y0, Y1 = 420, W - 100, 110, H - 260  # the transcript at any zoom the flow uses
BLOCK = 8  # columns averaged per sample
LEVELS = 24  # a sample's grey level, quantized: equal rows match exactly
INK = 3  # a row votes when this many of its samples differ from its first
TOL = 2
MIN_VOTES = 20
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


def votes(prev, cur):
    """For each shift s (content down by s pt), how many rows agree: cur[y + s] == prev[y]."""
    at = {}
    for y, k in enumerate(cur):
        if k is not None:
            at.setdefault(k, []).append(y)
    out = Counter()
    for y, k in enumerate(prev):
        for y2 in at.get(k, ()) if k is not None else ():
            if -60 <= y2 - y <= MAX_SHIFT:
                out[y2 - y] += 1
    return out


def frames(d):
    names = sorted(f for f in os.listdir(d) if f.endswith(".png") and f[:-4].isdigit())
    st_path = os.path.join(d, "steps.jsonl")
    states = [json.loads(l) for l in open(st_path) if l.strip()] if os.path.exists(st_path) else []
    return [os.path.join(d, n) for n in names], states


def steps(d, want, out):
    paths, states = frames(d)
    prev = rows(paths[0])
    res_steps = []
    for i in range(1, len(paths)):
        cur = rows(paths[i])
        v = votes(prev, cur)
        s, n = v.most_common(1)[0] if v else (None, 0)
        st = states[i] if i < len(states) else {}
        st0 = states[i - 1] if i - 1 < len(states) else {}
        res_steps.append({"step": i, "moved": s, "votes": n, "measured": n >= MIN_VOTES,
                          "err": round(s - want, 1) if n >= MIN_VOTES else None,
                          "top": st.get("top"), "items": st.get("items"), "first": st.get("first"),
                          "historyLoaded": bool(st0) and st.get("items") != st0.get("items")})
        prev = cur
    blind = [s for s in res_steps if not s["measured"]]
    uneven = [s for s in res_steps if s["measured"] and abs(s["err"]) > TOL]
    res = {"want": want, "tolerance": TOL, "minVotes": MIN_VOTES, "steps": len(res_steps), "uneven": len(uneven),
           "unmeasured": len(blind), "largestErr": max([abs(s["err"]) for s in res_steps if s["measured"]] or [0]),
           "perStep": res_steps}
    json.dump(res, open(out, "w"), indent=1)
    for s in res_steps:
        mark = "  <-- UNEVEN" if s in uneven else f"  <-- TOO FEW VOTES (< {MIN_VOTES}: blank frame or wrong crop)" if s in blind else ""
        print(f"step {s['step']:2}: moved {s['moved']} pt (want {want:g}, votes {s['votes']}){' · history loaded' if s['historyLoaded'] else ''}{mark}")
    if blind:
        print(f"{len(blind)} of {len(res_steps)} steps couldn't be measured (too few matching rows); {len(uneven)} uneven")
    else:
        print(f"{len(uneven)} of {len(res_steps)} steps moved a different amount than {want:g} pt; largest error {res['largestErr']} pt")
    return 1 if uneven or blind else 0


def grow(d, out):
    paths, states = frames(d)
    base = rows(paths[0])
    per = []
    for i in range(1, len(paths)):
        v = votes(base, rows(paths[i]))
        below = max([s for s, n in v.items() if s > 0 and n >= MIN_VOTES] or [0])
        per.append({"frame": i, "below": below, "still": v.get(0, 0), "votes": dict(v.most_common(4))})
    final = per[-1]["below"] if per else 0
    peak = max(per, key=lambda p: p["below"]) if per else {"below": 0, "frame": 0}
    over = peak["below"] - final
    res = {"final": final, "peak": peak["below"], "peakFrame": peak["frame"], "overshoot": over, "tolerance": TOL, "frames": per}
    json.dump(res, open(out, "w"), indent=1)
    for p in per:
        print(f"frame {p['frame']:2}: rows below moved {p['below']} pt (still rows {p['still']})")
    if final <= 0:
        print("the rows below the group never moved: the group didn't open, or the crop misses it")
        return 1
    print(f"grew to {final} pt; largest {peak['below']} pt (frame {peak['frame']}): overshoot {over} pt")
    return 1 if over > TOL else 0


if __name__ == "__main__":
    mode = sys.argv[1]
    sys.exit(steps(sys.argv[2], float(sys.argv[3]), sys.argv[4]) if mode == "steps" else grow(sys.argv[2], sys.argv[3]))
