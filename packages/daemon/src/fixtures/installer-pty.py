"""Run an installer command on a real terminal, bounded and without sudo."""
import errno
import os
import select
import signal
import sys
import time

pid, terminal = os.forkpty()
if pid == 0:
    os.execvp("bash", ["bash", "-c", 'cat "$1" | bash', "bash", sys.argv[1]])

deadline = time.monotonic() + 4
try:
    while time.monotonic() < deadline:
        if not select.select([terminal], [], [], 0.1)[0]:
            continue
        try:
            chunk = os.read(terminal, 65536)
        except OSError as error:
            if error.errno == errno.EIO:
                break
            raise
        if not chunk:
            break
        sys.stdout.buffer.write(chunk)
        sys.stdout.buffer.flush()
    else:
        os.killpg(pid, signal.SIGKILL)
        raise TimeoutError("installer did not exit from the piped invocation")
finally:
    os.close(terminal)
    os.waitpid(pid, 0)
