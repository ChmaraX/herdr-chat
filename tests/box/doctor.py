"""Is box <item> fit to test on? `doctor.py <item> <container> <proof root>`: JSON on
stdout, exit 1 when there are problems (each says how to fix it). Read-only."""
import json
import os
import shutil
import subprocess
import sys

item, name, proof_root = sys.argv[1:]


def sh(*cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    return r.returncode, r.stdout.strip()


def box(*cmd):
    return sh("docker", "exec", name, "sh", "-c", '. /tmp/display.env; exec "$@"', "_", *cmd)


problems, out = [], {"box": item}
rc, state = sh("docker", "inspect", "-f", "{{.State.Running}}", name)
if state != "true":
    problems.append(f"the box isn't running (box up {item} <worktree>)")
else:
    out["display"] = box("xdpyinfo")[0] == 0
    if not out["display"]:
        problems.append(f"no X display (box down {item}, box up again)")
    out["app"] = box("herdr-app", "--version")[1]
    out["core"] = box("hc", "--version")[1]
    out["node"] = box("node", "--version")[1]
    rc, rev = box("cat", "/home/box/src/.box-rev")
    out["snapshot"] = rev if rc == 0 else None
    if rc != 0:
        problems.append(f"no snapshot (box sync {item})")
    if box("test", "-d", "/home/box/src/node_modules")[0] != 0:
        problems.append("no node_modules in the worktree (npm ci --ignore-scripts there, then box sync)")
    online = "offline" not in box("sh", "-c", "getent hosts example.com || echo offline")[1]
    out["network"] = "ONLINE" if online else "offline"
    if online:
        problems.append("the box has network")
    rc, mount = sh("docker", "inspect", "-f", '{{range .Mounts}}{{if eq .Destination "/work"}}{{.Source}} {{.RW}}{{end}}{{end}}', name)
    src, rw = (mount.split() + ["", ""])[:2]
    out["worktree"] = src
    if rw != "false":
        problems.append("the worktree is mounted writable")
    rc, head = sh("git", "-C", src, "rev-parse", "--short", "HEAD")
    if out["snapshot"] and rc == 0 and not out["snapshot"].startswith(head):
        problems.append(f"the snapshot ({out['snapshot']}) isn't the worktree's HEAD ({head}): box sync {item}")
    rc, held = box("sh", "-c", "for l in display src; do /opt/box/exclusive.sh --free $l 2>&1 >/dev/null; done")
    out["busy"] = held or None
free = shutil.disk_usage(proof_root if os.path.isdir(proof_root) else "/").free // 2**30
out["disk_free_gb"] = free
if free < 3:
    problems.append(f"only {free} GB free on disk")
out["ok"] = not problems
out["problems"] = problems
print(json.dumps(out, indent=1))
sys.exit(0 if out["ok"] else 1)
