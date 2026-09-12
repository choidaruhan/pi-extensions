#!/usr/bin/env python3
"""Drive pi's real TUI over a pty and capture what it renders.

Some behaviour cannot be verified headlessly: key interception in particular
depends on pi's input dispatch order, and the only honest test is to press the
key in a real terminal. This harness does that without tmux:

    tools/pty-keys.py <hex-keys> <wait-before> <wait-after> -- <command...>

`hex-keys` is written to the pty after `wait-before` seconds ("" sends nothing),
the screen is drained for a further `wait-after` seconds, then the child is
killed. The last screen lines are printed with ANSI/control sequences stripped.

Example — prove that Ctrl+T reaches the thinking-preview extension and not pi's
built-in toggle (which would persist hideThinkingBlock=true in settings.json):

    # before: note settings.json hideThinkingBlock and thinking-preview.json
    tools/pty-keys.py 14 6 2 -- pi --no-approve --no-extensions \\
        -e ./extensions/thinking-preview.ts
    # after: the footer must read "thinking:hidden", settings.json must be
    # unchanged, and thinking-preview.json must hold the new level

Pass PI_OFFLINE=1 to keep pi's startup network calls out of the run.
"""

import contextlib
import fcntl
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time


def parse_seconds(raw, fallback, name):
    if raw is None:
        return fallback
    try:
        return float(raw)
    except ValueError:
        sys.exit(f"{name} must be seconds as a number, got {raw!r}")


def parse_args(argv):
    if "--" not in argv:
        sys.exit(__doc__)
    split = argv.index("--")
    head, cmd = argv[:split], argv[split + 1 :]
    keys = bytes.fromhex(head[0]) if head and head[0] else b""
    wait_before = parse_seconds(head[1] if len(head) > 1 else None, 5.0, "wait-before")
    wait_after = parse_seconds(head[2] if len(head) > 2 else None, 2.0, "wait-after")
    if not cmd:
        sys.exit("no command given after --")
    return keys, wait_before, wait_after, cmd


def drain(fd, seconds, collected):
    end = time.time() + seconds
    while time.time() < end:
        ready, _, _ = select.select([fd], [], [], 0.2)
        if not ready:
            continue
        try:
            data = os.read(fd, 65536)
        except OSError:
            return
        if not data:
            return
        collected.append(data)


def strip_ansi(text):
    text = re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]", "", text)
    text = re.sub(r"\x1b\][^\x07\x1b]*(\x07|\x1b\\)", "", text)
    text = re.sub(r"\x1b[()][A-Z]", "", text)
    return text.replace("\r", "").replace("\x07", "")


def main():
    keys, wait_before, wait_after, cmd = parse_args(sys.argv[1:])

    pid, fd = pty.fork()
    if pid == 0:  # child: the pty becomes pi's terminal
        os.environ["TERM"] = "xterm-256color"
        # The whole point of this harness is to exec a caller-supplied argv
        # (typically pi) directly, with no shell in between. noqa: S606
        try:
            os.execvp(cmd[0], cmd)  # noqa: S606
        except OSError as error:
            sys.exit(f"could not run {cmd[0]}: {error}")

    # Give the child a known geometry before it paints anything.
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 200, 0, 0))

    collected = []
    drain(fd, wait_before, collected)
    if keys:
        os.write(fd, keys)
    drain(fd, wait_after, collected)

    for sig in (signal.SIGTERM, signal.SIGKILL):
        with contextlib.suppress(ProcessLookupError):
            os.kill(pid, sig)
        time.sleep(0.3)

    lines = [
        line.rstrip()
        for line in strip_ansi(b"".join(collected).decode("utf8", "replace")).split("\n")
        if line.strip()
    ]
    print("=== last 25 screen lines ===")
    print("\n".join(lines[-25:]))


if __name__ == "__main__":
    main()
