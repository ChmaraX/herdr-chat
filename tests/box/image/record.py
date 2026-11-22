"""Record a scene in the box's live app: `record.py SCENE OUT_DIR [seconds]`.

Adapted from herdr-app's scripts/notes-media.ts clip recorder (Apache-2.0,
https://github.com/herdrdev/herdr-app). A scene is a bash script with three
parts, run as `SCENE setup`, `SCENE play` and `SCENE crop` (the same form as
Herdr's scripts/notes-clips/*.sh):
- setup: builds the state to film (box verbs: do, hc, click…); not recorded;
- play: the actions to film; recorded from its start until it ends;
- crop (optional): prints width:height:x:y in window px, else the whole window.

Frames are `herdr-app shot` (the app's own rendering) at a steady 12 fps; the
pointer each frame comes from input.py's pointer file. After the capture (so
image work never disturbs the cadence) the cursor is drawn on each frame
(arrow, pointer or grab, at their hotspots), then ffmpeg writes clip.mp4 (for
people and PRs) and clip.webp (lossless, looping, as Herdr's release notes).
Exit 1 when the capture fell behind 12 fps or the scene failed.
Writes OUT_DIR: frames/NNN.png, pointer.jsonl, clip.mp4, clip.webp, scene.sh."""
import json
import os
import shutil
import subprocess
import sys
import time

FPS = 12
HOT = {"arrow": (2, 2), "pointer": (12, 2), "grab": (13, 16)}
CURSORS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cursors")

scene, out = sys.argv[1], sys.argv[2]
limit = float(sys.argv[3]) if len(sys.argv) > 3 else 30.0
app = os.environ.get("APP", "herdr-app")
frames = os.path.join(out, "frames")
os.makedirs(frames, exist_ok=True)
shutil.copy(scene, os.path.join(out, "scene.sh"))
pointer_file = os.path.join(out, "pointer.json")
env = dict(os.environ, BOX_POINTER_FILE=pointer_file)


def part(name, **kw):
    return subprocess.run(["bash", scene, name], env=env, **kw)


if part("setup").returncode != 0:
    sys.exit("the scene's setup failed")
crop = part("crop", capture_output=True, text=True).stdout.strip()
play = subprocess.Popen(["bash", scene, "play"], env=env)
pointers, start, i = [], time.monotonic(), 0
late = 0
tail = None  # frames still to take once play ended (its last action's result)
while tail != 0:
    due = start + i / FPS
    now = time.monotonic()
    if now < due:
        time.sleep(due - now)
    elif now - due > 0.5 / FPS:
        late += 1  # this frame is more than half a frame behind its time
    f = os.path.join(frames, f"{i:03d}.png")
    subprocess.run([app, "shot", f], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        pointers.append(json.load(open(pointer_file)))
    except (OSError, ValueError):
        pointers.append({"x": -100, "y": -100, "cursor": "arrow"})
    i += 1
    if tail is not None:
        tail -= 1
    elif play.poll() is not None:
        tail = 6  # half a second more
    if time.monotonic() - start > limit:
        play.kill()
        sys.exit(f"the scene ran over {limit:g} s")
capture_end = time.monotonic()
ok = play.wait() == 0
with open(os.path.join(out, "pointer.jsonl"), "w") as pf:
    for p in pointers:
        pf.write(json.dumps(p) + "\n")
# The cursor, drawn after the capture.
for n, p in enumerate(pointers):
    cur = p.get("cursor") if p.get("cursor") in HOT else "arrow"
    hx, hy = HOT[cur]
    x, y = int(p.get("x", -100)) - hx, int(p.get("y", -100)) - hy
    if x < -40 or y < -40:
        continue
    f = os.path.join(frames, f"{n:03d}.png")
    subprocess.run(["convert", f, "-background", "none", os.path.join(CURSORS, cur + ".svg"),
                    "-geometry", f"{x:+d}{y:+d}", "-composite", f], check=True)
vf = f"crop={crop}," if crop else ""
subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-framerate", str(FPS), "-i", os.path.join(frames, "%03d.png"),
                "-vf", vf + "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p", "-c:v", "libx264", os.path.join(out, "clip.mp4")], check=True)
subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-framerate", str(FPS), "-i", os.path.join(frames, "%03d.png"),
                "-vf", vf.rstrip(","), "-c:v", "libwebp_anim", "-lossless", "1", "-compression_level", "4", "-loop", "0",
                os.path.join(out, "clip.webp")] if vf else
               ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-framerate", str(FPS), "-i", os.path.join(frames, "%03d.png"),
                "-c:v", "libwebp_anim", "-lossless", "1", "-compression_level", "4", "-loop", "0", os.path.join(out, "clip.webp")], check=True)
took = capture_end - start
print(f"recorded {len(pointers)} frames in {took:.1f} s ({len(pointers) / took:.1f} fps, {late} late): {out}/clip.mp4")
if late > len(pointers) // 10:
    sys.exit("capture fell behind 12 fps (more than 1 frame in 10 late)")
if not ok:
    sys.exit("the scene's play failed")
