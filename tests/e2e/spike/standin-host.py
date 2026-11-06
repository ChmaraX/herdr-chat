# Spike (c): a stand-in for pi-chat-host's terminal. Reports OSC 7501 with
# app=pi like the real host, and changes state on what `hc send` pastes:
# "working", "blocked <msg>", "done", "idle", "error". Prints a plain
# transcript line per change (what `hc read` would show).
import base64, os, sys, tty

tty.setraw(0)
out = sys.stdout


def report(state, msg=None):
    extra = f":msg={base64.b64encode(msg.encode()).decode()}" if msg else ""
    out.write(f"\x1b]7501;state={state}:app=pi{extra}\x1b\\")
    out.write(f"· state {state}{' — ' + msg if msg else ''}\r\n")
    out.flush()


out.write("\x1b[?2004h")
out.write("pi-chat stand-in host\r\n")
report("idle")
raw, pending = b"", ""
while True:
    chunk = os.read(0, 65536)
    if not chunk:
        break
    raw += chunk
    while raw:
        if raw.startswith(b"\x1b[200~"):
            end = raw.find(b"\x1b[201~")
            if end < 0:
                break
            pending += raw[6:end].decode("utf-8", "replace")
            raw = raw[end + 6:]
        elif raw[:1] == b"\r":
            word, _, rest = pending.strip().partition(" ")
            if word in ("working", "blocked", "done", "idle", "error"):
                report(word, rest or None)
            else:
                out.write(f"> {pending}\r\n")
                out.flush()
            pending, raw = "", raw[1:]
        elif raw[:1] == b"\x03":
            sys.exit(0)
        else:
            pending += raw[:1].decode("latin-1")
            raw = raw[1:]
