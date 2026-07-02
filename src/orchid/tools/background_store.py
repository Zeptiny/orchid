"""Background process store: lifecycle, ring buffer, LRU cap, termination.

Provides a process-singleton ``BackgroundProcessStore`` that holds all
background commands, their ring buffers, ownership state, and metadata.
Reached via ``get_background_store()`` (mirrors ``get_todo_store()``).
"""

from __future__ import annotations

import asyncio
import os
import signal
import time
from contextvars import ContextVar
from dataclasses import dataclass

from orchid.tools.exec import ENV_SUPPRESSION

# ---------------------------------------------------------------------------
# Head / tail ring-buffer (capped at ~1 MiB)
# ---------------------------------------------------------------------------

_HEAD_CAP = 512 * 1024  # 512 KiB
_TAIL_CAP = 512 * 1024  # 512 KiB
_TOTAL_CAP = _HEAD_CAP + _TAIL_CAP  # ~1 MiB hard cap


class HeadTailBuffer:
    """Ring buffer that keeps the first and last ~512 KiB, dropping the middle.

    Total storage never exceeds ``_TOTAL_CAP`` (~1 MiB).  ``append()`` is
    O(1) amortised for the common case (under cap); when the cap is hit the
    head is trimmed to exactly ``_HEAD_CAP`` bytes and the remainder of the
    incoming data lands in the tail.
    """

    __slots__ = ("head", "tail", "_total_written")

    def __init__(self) -> None:
        self.head: bytearray = bytearray()
        self.tail: bytearray = bytearray()
        self._total_written: int = 0

    # -- public API ----------------------------------------------------------

    def append(self, data: bytes) -> None:
        """Append *data* to the buffer, respecting the hard cap."""
        if not data:
            return
        self._total_written += len(data)

        if len(self.head) + len(self.tail) + len(data) <= _TOTAL_CAP:
            # Still under the cap – just append to the tail.
            self.tail.extend(data)
            return

        # Over cap – merge everything into a single working buffer, trim the
        # head to exactly ``_HEAD_CAP``, keep everything after that in tail.
        combined = self.head + self.tail
        combined.extend(data)
        if len(combined) <= _TOTAL_CAP:
            # Edge case: merging freed enough room.
            self.head = combined[:_HEAD_CAP]
            self.tail = combined[_HEAD_CAP:]
        else:
            # Still over cap – keep first _HEAD_CAP, drop middle, keep last
            # _TAIL_CAP.
            self.head = bytearray(combined[:_HEAD_CAP])
            self.tail = bytearray(combined[-_TAIL_CAP:])
        # If the combined buffer is smaller than _HEAD_CAP + _TAIL_CAP, the
        # tail slice will be shorter (which is fine).

    def get_tail(self, last_n: int | None = None) -> str:
        """Return the tail portion as a UTF-8 string.

        If *last_n* is given, return only the last *last_n* newline-delimited
        lines from the tail buffer (for compact output).
        """
        raw = self.tail
        if last_n is not None and last_n >= 0:
            raw = self._tail_last_n_lines(last_n)
        return raw.decode("utf-8", errors="replace")

    def total_bytes(self) -> int:
        """Return total bytes stored in head + tail."""
        return len(self.head) + len(self.tail)

    # -- internal ------------------------------------------------------------

    def _tail_last_n_lines(self, n: int) -> bytearray:
        """Return the last *n* lines from the tail buffer."""
        if n == 0:
            return bytearray()
        lines = self.tail.splitlines(keepends=True)
        return bytearray(b"".join(lines[-n:]))


# ---------------------------------------------------------------------------
# ProcessEntry dataclass
# ---------------------------------------------------------------------------


@dataclass
class ProcessEntry:
    """Holds the state for a single background process."""

    id: int
    command: str
    process: asyncio.subprocess.Process
    buffer: HeadTailBuffer
    owner: str = "AGENT"
    last_output_at: float = 0.0
    last_user_input_at: float = 0.0  # monotonic time of last user input / ownership take
    exit_code: int | None = None
    created_at: float = 0.0
    interactive: bool = False
    master_fd: int | None = None  # stub for PTY (U2)
    session_id: str | None = None  # owning session for scoped cleanup

    def __post_init__(self) -> None:
        if self.created_at == 0.0:
            self.created_at = time.monotonic()
        if self.last_output_at == 0.0:
            self.last_output_at = self.created_at


# ---------------------------------------------------------------------------
# BackgroundProcessStore
# ---------------------------------------------------------------------------

_MAX_ENTRIES = 64
_PROTECT_COUNT = 8  # most-recent entries protected from LRU eviction


class BackgroundProcessStore:
    """Singleton store for background processes.

    Use ``get_background_store()`` to obtain the per-process instance.
    """

    def __init__(self) -> None:
        self._entries: dict[int, ProcessEntry] = {}
        self._next_id: int = 1
        self._drain_tasks: dict[int, asyncio.Task[None]] = {}

    # -- spawn ---------------------------------------------------------------

    async def spawn(
        self,
        command: str,
        cwd: str = ".",
        interactive: bool = False,
        session_id: str | None = None,
    ) -> tuple[int, None]:
        """Spawn a background process, returning ``(id, None)``.

        The process is started with ``start_new_session=True`` and its
        stdout/stderr are drained into a ``HeadTailBuffer``.  When
        *interactive* is ``False`` (the default) stdin is ``/dev/null``.

        When *interactive* is ``True`` a real PTY is allocated so that
        ``isatty()`` returns ``True`` inside the child and ``send()``
        writes to the master fd.
        """
        proc_id = self._next_id
        self._next_id += 1

        buf = HeadTailBuffer()
        now = time.monotonic()

        env = {**os.environ, **ENV_SUPPRESSION}

        if interactive:
            from orchid.tools.pty_support import spawn_with_pty

            handle = await spawn_with_pty(command, cwd=cwd, env=env)
            entry = ProcessEntry(
                id=proc_id,
                command=command,
                process=handle,
                buffer=buf,
                last_output_at=now,
                created_at=now,
                interactive=True,
                master_fd=handle._master_fd,
                session_id=session_id,
            )
        else:
            process = await asyncio.create_subprocess_shell(
                command,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=cwd,
                start_new_session=True,
                env=env,
            )
            entry = ProcessEntry(
                id=proc_id,
                command=command,
                process=process,
                buffer=buf,
                last_output_at=now,
                created_at=now,
                interactive=False,
                session_id=session_id,
            )
        self._entries[proc_id] = entry

        # Start background drain task.
        task = asyncio.create_task(self._drain(proc_id))
        self._drain_tasks[proc_id] = task

        self.prune_if_needed()

        return proc_id, None  # type: ignore[return-value]

    # -- drain ---------------------------------------------------------------

    async def _drain(self, proc_id: int) -> None:
        """Read stdout + stderr concurrently into the entry's buffer."""
        entry = self._entries.get(proc_id)
        if entry is None:
            return

        proc = entry.process

        async def _read_stream(
            stream: asyncio.StreamReader | None,
        ) -> None:
            if stream is None:
                return
            while True:
                chunk = await stream.read(65536)
                if not chunk:
                    break
                entry.buffer.append(chunk)
                entry.last_output_at = time.monotonic()

        try:
            await asyncio.gather(
                _read_stream(proc.stdout),
                _read_stream(proc.stderr),
            )
        except Exception:  # pragma: no cover – drain should never raise
            pass
        finally:
            # Record exit code once the process finishes.
            try:
                exit_code = await proc.wait()
            except ProcessLookupError:
                exit_code = -1
            entry.exit_code = exit_code

    # -- query ---------------------------------------------------------------

    def get(self, proc_id: int) -> ProcessEntry | None:
        """Return the entry for *proc_id*, or ``None``."""
        return self._entries.get(proc_id)

    def list(self) -> list[ProcessEntry]:
        """Return all entries (insertion order)."""
        return list(self._entries.values())

    def snapshot(
        self, proc_id: int, last_n: int | None = None
    ) -> tuple[str, int | None] | None:
        """Return ``(tail_text, exit_code)`` for *proc_id*, or ``None``."""
        entry = self._entries.get(proc_id)
        if entry is None:
            return None
        return entry.buffer.get_tail(last_n), entry.exit_code

    # -- input ---------------------------------------------------------------

    async def send(self, proc_id: int, text: str) -> bool:
        """Write *text* to the process stdin.

        Returns ``False`` if the process is not interactive, has already
        exited, or has no stdin pipe.
        """
        entry = self._entries.get(proc_id)
        if entry is None or not entry.interactive:
            return False
        if entry.exit_code is not None:
            return False
        if entry.process.stdin is None:
            return False
        try:
            entry.process.stdin.write(text.encode("utf-8"))
            await entry.process.stdin.drain()
            return True
        except (BrokenPipeError, OSError):
            return False

    # -- ownership -----------------------------------------------------------

    def take_ownership(self, proc_id: int) -> bool:
        """Set *owner* to ``USER``.  Returns ``True`` on success."""
        entry = self._entries.get(proc_id)
        if entry is None:
            return False
        entry.owner = "USER"
        entry.last_user_input_at = time.monotonic()
        return True

    def release_ownership(self, proc_id: int) -> bool:
        """Set *owner* back to ``AGENT``.  Returns ``True`` on success."""
        entry = self._entries.get(proc_id)
        if entry is None:
            return False
        entry.owner = "AGENT"
        return True

    def check_idle_ownership(self, idle_timeout: float) -> None:
        """Revert ``USER``-owned entries idle beyond *idle_timeout* seconds.

        Called periodically (wired in U7).  Iterates all entries whose owner
        is ``USER`` and whose ``last_user_input_at`` is older than *idle_timeout*
        relative to ``time.monotonic()``.
        """
        now = time.monotonic()
        for entry in list(self._entries.values()):
            if entry.owner == "USER" and (now - entry.last_user_input_at) > idle_timeout:
                entry.owner = "AGENT"

    # -- progress waiting ----------------------------------------------------

    async def wait_for_progress(self, proc_id: int, wait_ms: int) -> None:
        """Wait up to *wait_ms* for new output or process exit.

        Resolves as soon as either condition is met or the timeout elapses.
        """
        entry = self._entries.get(proc_id)
        if entry is None:
            return

        deadline = time.monotonic() + wait_ms / 1000.0
        last_seen = entry.last_output_at
        poll_interval = 0.05  # 50 ms

        while time.monotonic() < deadline:
            # Entry evicted by LRU?
            if proc_id not in self._entries:
                return
            # Process exited?
            if entry.exit_code is not None:
                return
            # New output arrived?
            if entry.last_output_at > last_seen:
                # Give the drain task a moment to set exit_code if the
                # process is about to exit (output EOF → wait() race).
                for _ in range(6):  # up to ~300ms
                    if entry.exit_code is not None:
                        return
                    await asyncio.sleep(0.05)
                return
            await asyncio.sleep(poll_interval)

    # -- termination ---------------------------------------------------------

    def terminate(self, proc_id: int) -> None:
        """SIGTERM then SIGKILL the process group (matching exec.py pattern)."""
        entry = self._entries.get(proc_id)
        if entry is None:
            return
        proc = entry.process
        if proc.returncode is not None:
            return  # already exited
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except (OSError, ProcessLookupError):
            pass
        # Send SIGKILL directly — call_later is unreliable during shutdown.
        self._force_kill(proc_id)

    def _force_kill(self, proc_id: int) -> None:
        entry = self._entries.get(proc_id)
        if entry is None:
            return
        proc = entry.process
        if proc.returncode is not None:
            return
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except (OSError, ProcessLookupError):
            try:
                proc.kill()
            except (OSError, ProcessLookupError):
                pass

    # -- master fd cleanup (U2) ----------------------------------------------

    @staticmethod
    def _close_master_fd(master_fd: int) -> None:
        """Remove *master_fd* from the event loop and close it."""
        loop = asyncio.get_event_loop()
        try:
            loop.remove_reader(master_fd)
        except (OSError, ValueError, RuntimeError):
            pass
        try:
            os.close(master_fd)
        except OSError:
            pass

    def terminate_all(self) -> None:
        """Terminate every live background process."""
        for proc_id in list(self._entries):
            self.terminate(proc_id)

    def terminate_session(self, session_id: str) -> None:
        """Terminate background processes belonging to *session_id*."""
        for proc_id, entry in list(self._entries.items()):
            if entry.session_id == session_id:
                self.terminate(proc_id)

    # -- LRU eviction --------------------------------------------------------

    def prune_if_needed(self) -> None:
        """Evict oldest entries when count exceeds ``_MAX_ENTRIES``.

        The ``_PROTECT_COUNT`` most recently created entries are never
        evicted.
        """
        if len(self._entries) <= _MAX_ENTRIES:
            return
        # Sort by created_at (oldest first), protect the newest N.
        sorted_ids = sorted(
            self._entries,
            key=lambda k: self._entries[k].created_at,
        )
        evictable = sorted_ids[:-_PROTECT_COUNT] if len(sorted_ids) > _PROTECT_COUNT else []
        while len(self._entries) > _MAX_ENTRIES and evictable:
            victim_id = evictable.pop(0)
            self._terminate_and_remove(victim_id)

    def _terminate_and_remove(self, proc_id: int) -> None:
        """Force-kill and remove an entry."""
        entry = self._entries.pop(proc_id, None)
        if entry is None:
            return
        # Cancel drain task.
        task = self._drain_tasks.pop(proc_id, None)
        if task is not None:
            task.cancel()
        # Force-kill the process.
        proc = entry.process
        if proc.returncode is None:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except (OSError, ProcessLookupError):
                try:
                    proc.kill()
                except (OSError, ProcessLookupError):
                    pass
        # Close master fd if this was a PTY process.
        if entry.master_fd is not None:
            self._close_master_fd(entry.master_fd)
            entry.master_fd = None  # prevent double-close by PTYHandle._cleanup

    # -- cleanup helpers (U8) ------------------------------------------------

    def clear(self) -> None:
        """Terminate all entries and remove them from the store."""
        self.terminate_all()
        # Cancel all drain tasks.
        for task in self._drain_tasks.values():
            task.cancel()
        self._drain_tasks.clear()
        self._entries.clear()


# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------

_current_store: ContextVar[BackgroundProcessStore | None] = ContextVar(
    "current_bg_store", default=None
)


def get_background_store() -> BackgroundProcessStore:
    """Return the per-process singleton ``BackgroundProcessStore``."""
    store = _current_store.get()
    if store is None:
        store = BackgroundProcessStore()
        _current_store.set(store)
    return store


def set_background_store(store: BackgroundProcessStore) -> None:
    """Override the current singleton (useful in tests)."""
    _current_store.set(store)
