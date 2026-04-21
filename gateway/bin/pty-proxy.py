#!/usr/bin/env python3
"""
PTY proxy for the admin console.

Why this exists: node-pty (both upstream and @homebridge/node-pty-prebuilt-multiarch)
is broken under Bun on Linux ARM64 — every spawned child dies immediately with
SIGHUP regardless of the command. Bypassing node-pty and letting Python manage
the pty via its stdlib `pty` module sidesteps the bug entirely.

Wire protocol (over stdin/stdout with Bun):
  stdout = raw bytes from the pty (terminal output)
  stdin  = framed:
    - `D<4-byte BE length><payload>` = input bytes for the pty
    - `R<2-byte BE cols><2-byte BE rows>` = resize
    - `X` = kill child
  exit = proxy exits when child exits; Bun sees the pipe close.
"""
import os
import pty
import select
import signal
import struct
import sys
import termios
import fcntl
import errno


def set_winsize(fd, rows, cols):
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    except OSError:
        pass


def main():
    shell = os.environ.get("PTY_SHELL", "/bin/bash")
    # Default to interactive login so profile files run (bashrc etc.)
    args = ["-il"]

    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)

    pid, fd = pty.fork()
    if pid == 0:
        # Child
        signal.signal(signal.SIGHUP, signal.SIG_DFL)  # let bash's own handler take over
        try:
            os.execvp(shell, [shell, *args])
        except Exception as e:
            sys.stderr.write(f"pty-proxy: exec failed: {e}\n")
            os._exit(127)

    # Parent: set initial window size
    set_winsize(fd, 24, 80)

    stdin_fd = sys.stdin.fileno()
    stdout_fd = sys.stdout.fileno()

    # Make stdin non-blocking so we can framed-read without stalling pty output
    fl = fcntl.fcntl(stdin_fd, fcntl.F_GETFL)
    fcntl.fcntl(stdin_fd, fcntl.F_SETFL, fl | os.O_NONBLOCK)

    recv_buf = b""

    def drain_frames():
        nonlocal recv_buf
        while True:
            if not recv_buf:
                return
            tag = recv_buf[:1]
            if tag == b"D":
                if len(recv_buf) < 5:
                    return
                n = struct.unpack(">I", recv_buf[1:5])[0]
                if len(recv_buf) < 5 + n:
                    return
                payload = recv_buf[5 : 5 + n]
                recv_buf = recv_buf[5 + n :]
                try:
                    os.write(fd, payload)
                except OSError:
                    pass
            elif tag == b"R":
                if len(recv_buf) < 5:
                    return
                cols, rows = struct.unpack(">HH", recv_buf[1:5])
                recv_buf = recv_buf[5:]
                set_winsize(fd, max(1, rows), max(1, cols))
            elif tag == b"X":
                recv_buf = recv_buf[1:]
                try:
                    os.kill(pid, signal.SIGTERM)
                except OSError:
                    pass
            else:
                # Unknown frame — drop one byte and resync.
                recv_buf = recv_buf[1:]

    try:
        while True:
            try:
                rlist, _, _ = select.select([fd, stdin_fd], [], [], None)
            except InterruptedError:
                continue

            if fd in rlist:
                try:
                    data = os.read(fd, 4096)
                except OSError as e:
                    if e.errno == errno.EIO:
                        break  # child closed the pty
                    raise
                if not data:
                    break
                try:
                    os.write(stdout_fd, data)
                except BrokenPipeError:
                    break

            if stdin_fd in rlist:
                try:
                    data = os.read(stdin_fd, 4096)
                except BlockingIOError:
                    data = b""
                except OSError:
                    data = b""
                if data == b"":
                    # EOF on stdin means the gateway hung up; kill the child.
                    try:
                        os.kill(pid, signal.SIGTERM)
                    except OSError:
                        pass
                    break
                recv_buf += data
                drain_frames()
    finally:
        try:
            _, status = os.waitpid(pid, 0)
            code = os.WEXITSTATUS(status) if os.WIFEXITED(status) else 1
        except ChildProcessError:
            code = 0
        sys.exit(code)


if __name__ == "__main__":
    main()
