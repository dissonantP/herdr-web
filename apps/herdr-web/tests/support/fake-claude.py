"""A stand-in for Claude Code in the e2e tests: it reports itself as Claude Code (OSC 7501), draws a
screen from a fixture file, and appends every byte it is sent to a log. Each input chunk draws the
next fixture, so a test can script a menu's reaction (a focused field, the prompt closing); on the
last one, printable input is echoed, as Claude's input box would show it (terminal.send waits to see
its paste land before pressing Enter).

    python3 fake-claude.py <state> <log> <fixture> [<fixture> ...]
"""

import os
import sys
import termios
import tty

state, log, screens = sys.argv[1], sys.argv[2], sys.argv[3:]


def draw(path: str) -> None:
    with open(path, encoding="utf-8") as f:
        rows = f.read().rstrip("\n").split("\n")
    out = "\x1b[2J\x1b[3J\x1b[H" + "\r\n".join(rows)
    os.write(1, out.encode("utf-8"))


os.write(1, f"\x1b]7501;state={state}:app=claude-code\x07".encode())
attrs = termios.tcgetattr(0)
tty.setraw(0)
try:
    draw(screens[0])
    shown = 0
    with open(log, "ab") as out:
        while True:
            data = os.read(0, 4096)
            if not data:
                break
            out.write(data)
            out.flush()
            if shown + 1 < len(screens):
                shown += 1
                draw(screens[shown])
            else:
                os.write(1, bytes(b for b in data if 32 <= b < 127 or b >= 128))
            if b"\r" in data:
                # Enter starts a turn, as Claude's would; the next report ends it.
                os.write(1, b"\x1b]7501;state=working:app=claude-code\x07")
                os.write(1, f"\x1b]7501;state={state}:app=claude-code\x07".encode())
finally:
    termios.tcsetattr(0, termios.TCSADRAIN, attrs)
