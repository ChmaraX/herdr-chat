"""Record a scene in the box's live app: `record.py SCENE OUT_DIR [seconds]`.

Adapted from herdr-app's scripts/notes-media.ts clip recorder (Apache-2.0,
https://github.com/herdrdev/herdr-app). A scene is a bash script with three
parts, run as `SCENE setup`, `SCENE play` and `SCENE crop` (the same form as
Herdr's scripts/notes-clips/*.sh):
- setup: builds the state to film (box verbs: do, hc, click…); not filmed;
- play: the actions to film; filmed from its start until half a second after it ends;
- crop (optional): prints width:height:x:y in window px, else the whole window.

A frame is a `herdr-app shot` (the app's own rendering) on a 12 fps clock, with
the time it was taken and the pointer then (x11input.py's pointer file). The
clip is real time: each slot of the clock shows the newest frame taken by then,
so a slow shot repeats the frame before it and a lost one (a failed shot) is
never a gap. The cursor is drawn on each frame after the capture (so image work
never disturbs the clock), then ffmpeg writes clip.mp4 (for people and PRs) and
clip.webp (lossless, looping, as Herdr's release notes).
Exit 1 when the scene failed, ran over its time, or more than 1 slot in 10 had
no new frame.
Writes OUT_DIR: frames/NNN.png (one a slot), frames.jsonl (each shot: slot, ms,
ok), pointer.jsonl, clip.mp4, clip.webp, scene.sh."""
import json
import os
import shutil
import subprocess
import sys
import time

FPS = 12
TAIL = 0.5  # seconds filmed after play ends: its last action's result
HOT = {"arrow": (2, 2), "pointer": (12, 2), "grab": (13, 16)}
CURSORS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cursors")

scene, out = sys.argv[1], sys.argv[2]
limit = float(sys.argv[3]) if len(sys.argv) > 3 else 30.0
app = os.environ.get("APP", "herdr-app")
shots = os.path.join(out, "shots")
frames = os.path.join(out, "frames")
os.makedirs(shots, exist_ok=True)
os.makedirs(frames, exist_ok=True)
shutil.copy(scene, os.path.join(out, "scene.sh"))
pointer_file = os.path.join(out, "pointer.json")
env = dict(os.environ, BOX_POINTER_FILE=pointer_file)


def part(name, **kw):
    return subprocess.run(["bash", scene, name], env=env, **kw)


def pointer():
    try:
        return json.load(open(pointer_file))
    except (OSError, ValueError):
        return {"x": -100, "y": -100, "cursor": "arrow"}


if part("setup").returncode != 0:
    sys.exit("the scene's setup failed")
crop = part("crop", capture_output=True, text=True).stdout.strip()

# Capture: shot after shot until TAIL after play ends, each kept with its time.
taken = []  # (seconds from start, shot file, pointer)
log = open(os.path.join(out, "frames.jsonl"), "w")
play = subprocess.Popen(["bash", scene, "play"], env=env)
start, ended, n = time.monotonic(), None, 0
while True:
    slot = start + n / FPS
    now = time.monotonic()
    if now < slot:
        time.sleep(slot - now)
    t = time.monotonic() - start
    f = os.path.join(shots, f"{n:04d}.png")
    ok = subprocess.run([app, "shot", f], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
    log.write(json.dumps({"n": n, "ms": round(t * 1000), "ok": ok}) + "\n")
    if ok:
        taken.append((t, f, pointer()))
    n += 1
    if ended is None and play.poll() is not None:
        ended = time.monotonic() - start
    if ended is not None and time.monotonic() - start > ended + TAIL:
        break
    if time.monotonic() - start > limit:
        play.kill()
        sys.exit(f"the scene ran over {limit:g} s")
log.close()
played_ok = play.wait() == 0
if not taken:
    sys.exit("no shot succeeded")

# The clip in real time: slot k shows the newest frame taken by k / FPS.
duration = taken[-1][0]
slots = int(duration * FPS) + 1
pointers, stale, j = [], 0, 0
for k in range(slots):
    while j + 1 < len(taken) and taken[j + 1][0] <= k / FPS:
        j += 1
    if k and taken[j][0] <= (k - 1) / FPS:
        stale += 1  # no new frame since the slot before
    t, f, p = taken[j]
    dst = os.path.join(frames, f"{k:03d}.png")
    shutil.copy(f, dst)
    pointers.append(p)
    cur = p.get("cursor") if p.get("cursor") in HOT else "arrow"
    hx, hy = HOT[cur]
    x, y = int(p.get("x", -100)) - hx, int(p.get("y", -100)) - hy
    if x >= -40 and y >= -40:
        subprocess.run(["convert", dst, "-background", "none", os.path.join(CURSORS, cur + ".svg"),
                        "-geometry", f"{x:+d}{y:+d}", "-composite", dst], check=True)
shutil.rmtree(shots)
with open(os.path.join(out, "pointer.jsonl"), "w") as pf:
    for p in pointers:
        pf.write(json.dumps(p) + "\n")

source = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-framerate", str(FPS), "-i", os.path.join(frames, "%03d.png")]
cropped = [f"crop={crop}"] if crop else []
subprocess.run(source + ["-vf", ",".join(cropped + ["scale=trunc(iw/2)*2:trunc(ih/2)*2", "format=yuv420p"]),
                         "-c:v", "libx264", os.path.join(out, "clip.mp4")], check=True)
subprocess.run(source + (["-vf", cropped[0]] if cropped else []) +
               ["-c:v", "libwebp_anim", "-lossless", "1", "-compression_level", "4", "-loop", "0", os.path.join(out, "clip.webp")], check=True)
print(f"recorded {slots} slots ({slots / FPS:.1f} s) from {len(taken)} shots of {n}; {stale} slots had no new frame: {out}/clip.mp4")
if not played_ok:
    sys.exit("the scene's play failed")
if stale > slots // 10:
    sys.exit(f"capture fell behind {FPS} fps ({stale} of {slots} slots had no new frame)")
