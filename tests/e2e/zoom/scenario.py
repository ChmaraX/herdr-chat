"""The `zoom` flow's fake-pi scenario (#28): a seeded history longer than the
host's 200-item snapshot, so scrolling up pages older history in. Short user
questions, tall answers of 3 to 16 lines (every line a different length, so
shift.py can match frames), and every other turn four bash calls that fold
into one tool group. A prompt then streams a long answer.

  python3 scenario.py OUT.json"""
import json
import sys

WORDS = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa".split()
hist, t = [], 1_700_000_000_000


def ts():
    global t
    t += 1000
    return t


def lines(n, count):
    return "\n".join(f"{k}. A{n}.{k} " + " ".join(WORDS[(n + k + j) % 16] for j in range(2 + (n * 5 + k * 3) % 11)) for k in range(1, count + 1))


for n in range(1, 81):
    hist.append({"role": "user", "content": [{"type": "text", "text": f"Question {n}: what about part {n}?"}], "timestamp": ts()})
    if n % 2 == 0:
        calls = [{"type": "toolCall", "id": f"call_{n}_{k}", "name": "bash", "arguments": {"command": f"ls part{n}/{k}"}} for k in range(4)]
        hist.append({"role": "assistant", "content": [{"type": "text", "text": f"Checking part {n}."}, *calls],
                     "api": "fake", "provider": "fake", "model": "fake", "stopReason": "toolUse", "timestamp": ts()})
        for k in range(4):
            hist.append({"role": "toolResult", "toolCallId": f"call_{n}_{k}", "toolName": "bash",
                         "content": [{"type": "text", "text": f"part{n}/{k}.ts"}], "isError": False, "timestamp": ts()})
    hist.append({"role": "assistant", "content": [{"type": "text", "text": f"Answer {n}.\n\n{lines(n, 3 + (n * 7) % 14)}"}],
                 "api": "fake", "provider": "fake", "model": "fake", "stopReason": "stop", "timestamp": ts()})

stream = "Streamed answer.\n\n" + "\n".join(lines(200 + i, 4) for i in range(12))
json.dump({"description": "E2E zoom (#28): a long seeded history (tall answers, short questions, tool groups); any prompt streams a long answer.",
           "historyAlways": True, "history": hist,
           "prompts": [{"match": ".", "steps": [{"assistant": {"text": stream, "chunk": 12, "every": 10}}]}]}, open(sys.argv[1], "w"), indent=1)
