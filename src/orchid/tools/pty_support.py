"""PTY support for interactive background processes (U2).

Provides :func:`open_pty` and :func:`spawn_with_pty` for allocating a real
PTY and wiring it to a child process, plus :class:`PTYHandle` — a duck-type
compatible replacement for :class:`asyncio.subprocess.Process` when a PTY is
used instead of pipes.
"""

from __future__ import annotations

import asyncio
import os

from orchid.tools.exec import ENV_SUPPRESSION

# ---------------------------------------------------------------------------
# PTY stdin writer (duck-types asyncio.StreamWriter for send() compat)
# ---------------------------------------------------------------------------


class _PTYStdinWriter:
    """Minimal write-only wrapper around a PTY master fd.

    Provides ``write(data)`` and ``drain()`` matching the interface that
    :meth:`BackgroundProcessStore.send` expects from ``process.stdin``.
    """

    __slots__ = ("_master_fd",)

    def __init__(self, master_fd: int) -> None:
        self._master_fd = master_fd

    def write(self, data: bytes) -> None:
        """Write *data* to the PTY master fd."""
        mv = memoryview(data)
        while mv:
            try:
                written = os.write(self._master_fd, mv)
            except BlockingIOError:
                continue
            mv = mv[written:]

    async def drain(self) -> None:
        """No-op — PTY writes are kernel-buffered."""


# ---------------------------------------------------------------------------
# PTYHandle — duck-type for asyncio.subprocess.Process
# ---------------------------------------------------------------------------


class PTYHandle:
    """Process handle backed by a PTY instead of pipes.

    Exposes the same interface that :class:`asyncio.subprocess.Process`
    does — ``pid``, ``returncode``, ``stdin``, ``stdout``, ``stderr``,
    ``wait()`` and ``kill()`` — so it plugs straight into
    :class:`BackgroundProcessStore` without type changes.

    Since a PTY merges stdout and stderr into one stream, ``stderr`` is
    always ``None`` and ``stdout`` carries everything.
    """

    def __init__(
        self,
        process: asyncio.subprocess.Process,
        master_fd: int,
        reader: asyncio.StreamReader,
    ) -> None:
        self.pid: int = process.pid
        self.returncode: int | None = None
        self._process = process
        self._master_fd = master_fd
        self._closed = False

        # Duck-type attributes expected by BackgroundProcessStore._drain /
        # send / terminate.
        self.stdout: asyncio.StreamReader = reader
        self.stderr = None  # PTY merges stdout+stderr
        self.stdin: _PTYStdinWriter = _PTYStdinWriter(master_fd)

    # -- public API ----------------------------------------------------------

    async def wait(self) -> int:
        """Wait for the child process to exit and clean up the master fd."""
        self.returncode = await self._process.wait()
        self._cleanup()
        return self.returncode  # type: ignore[return-value]

    def kill(self) -> None:
        """Kill the child process."""
        try:
            self._process.kill()
        except (OSError, ProcessLookupError):
            pass

    # -- cleanup -------------------------------------------------------------

    def _cleanup(self) -> None:
        """Remove the master fd from the event loop and close it."""
        if self._closed:
            return
        self._closed = True
        loop = asyncio.get_event_loop()
        try:
            loop.remove_reader(self._master_fd)
        except (OSError, ValueError, RuntimeError):
            pass
        try:
            os.close(self._master_fd)
        except OSError:
            pass


# ---------------------------------------------------------------------------
# open_pty / spawn_with_pty
# ---------------------------------------------------------------------------


def open_pty() -> tuple[int, int]:
    """Allocate a PTY pair, returning ``(master_fd, slave_fd)``."""
    return os.openpty()


async def _setup_pty_reader(master_fd: int) -> asyncio.StreamReader:
    """Wire *master_fd* into an :class:`asyncio.StreamReader` via ``add_reader``."""
    reader = asyncio.StreamReader()
    loop = asyncio.get_event_loop()

    def _on_readable() -> None:
        try:
            data = os.read(master_fd, 65536)
            if data:
                reader.feed_data(data)
            else:
                reader.feed_eof()
                loop.remove_reader(master_fd)
        except OSError:
            # Master fd closed (process exit or explicit cleanup).
            reader.feed_eof()
            try:
                loop.remove_reader(master_fd)
            except (OSError, ValueError):
                pass

    loop.add_reader(master_fd, _on_readable)
    return reader


async def spawn_with_pty(
    command: str,
    cwd: str = ".",
    env: dict[str, str] | None = None,
) -> PTYHandle:
    """Spawn *command* with a real PTY for stdin/stdout/stderr.

    Returns a :class:`PTYHandle` whose ``stdout`` is an
    :class:`asyncio.StreamReader` fed from the PTY master fd.  ``stdin``
    writes go to the master fd.  Since the PTY merges stdout and stderr,
    ``stderr`` is ``None``.

    Parameters
    ----------
    command:
        Shell command string.
    cwd:
        Working directory for the child process.
    env:
        Environment dict.  Falls back to ``os.environ`` merged with
        :data:`ENV_SUPPRESSION`.
    """
    if env is None:
        env = {**os.environ, **ENV_SUPPRESSION}

    master_fd, slave_fd = open_pty()

    # Mark slave non-inheritable so the parent does not keep an extra copy
    # after fork.  The child still gets it via the explicit dup2 that
    # ``subprocess`` performs.
    os.set_inheritable(slave_fd, False)

    try:
        process = await asyncio.create_subprocess_shell(
            command,
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            cwd=cwd,
            start_new_session=True,
            env=env,
        )
    except Exception:
        # Close master_fd on failure — PTYHandle was never created so
        # nobody else will clean it up.
        try:
            os.close(master_fd)
        except OSError:
            pass
        raise
    finally:
        # Close slave in parent — child has its own copy via dup2.
        try:
            os.close(slave_fd)
        except OSError:
            pass

    # Wire the master fd into an asyncio StreamReader.
    reader = await _setup_pty_reader(master_fd)

    return PTYHandle(process, master_fd, reader)
