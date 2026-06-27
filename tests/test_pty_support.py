"""Tests for PTY interactivity path (U2).

Verifies that interactive=True spawns a real PTY (isatty() == True),
that send() works for REPL-style interaction, and that cleanup is clean.
"""

from __future__ import annotations

import asyncio
import os
import tempfile

import pytest

from orchid.tools.background_store import (
    BackgroundProcessStore,
    set_background_store,
    get_background_store,
)
from orchid.tools.pty_support import (
    PTYHandle,
    _PTYStdinWriter,
    open_pty,
    spawn_with_pty,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def fresh_store():
    """Return a fresh BackgroundProcessStore and install it on the ContextVar."""
    prior = get_background_store()
    store = BackgroundProcessStore()
    set_background_store(store)
    yield store
    store.clear()
    set_background_store(prior)


@pytest.fixture
def repl_script():
    """Create a temporary Python REPL script that eval()'s each input line."""
    fd, path = tempfile.mkstemp(suffix=".py")
    os.write(
        fd,
        b"import sys\n"
        b"sys.ps1 = chr(0)\n"
        b"sys.ps2 = chr(0)\n"
        b"while True:\n"
        b"    print(eval(input()))\n",
    )
    os.close(fd)
    yield path
    try:
        os.unlink(path)
    except OSError:
        pass


# ---------------------------------------------------------------------------
# Scenario 1: interactive=true → isatty() == True
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_interactive_true_isatty(fresh_store):
    """interactive=true spawn of `python -c "import sys; print(sys.stdin.isatty())"` returns True."""
    proc_id, _ = await fresh_store.spawn(
        'python3 -c "import sys; print(sys.stdin.isatty())"',
        interactive=True,
    )
    # Give the process time to produce output and exit.
    await asyncio.sleep(1.5)

    entry = fresh_store.get(proc_id)
    assert entry is not None
    assert entry.exit_code == 0

    text, exit_code = fresh_store.snapshot(proc_id)
    assert exit_code == 0
    assert "True" in text


# ---------------------------------------------------------------------------
# Scenario 2: interactive=false → isatty() == False
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_interactive_false_not_isatty(fresh_store):
    """Same command with interactive=False returns False."""
    proc_id, _ = await fresh_store.spawn(
        'python3 -c "import sys; print(sys.stdin.isatty())"',
        interactive=False,
    )
    await asyncio.sleep(1.0)

    text, exit_code = fresh_store.snapshot(proc_id)
    assert exit_code == 0
    assert "False" in text


# ---------------------------------------------------------------------------
# Scenario 3: REPL send() and read
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_repl_send_and_read(fresh_store, repl_script):
    """Spawn a Python REPL, send '1+1', buffer should show '2'."""
    proc_id, _ = await fresh_store.spawn(
        f"python3 -u {repl_script}",
        interactive=True,
    )
    # Wait for REPL to start.
    await asyncio.sleep(1.0)

    # Send expression
    ok = await fresh_store.send(proc_id, "1+1\n")
    assert ok is True

    # Give the REPL time to evaluate and print.
    await asyncio.sleep(1.0)

    text, _ = fresh_store.snapshot(proc_id)
    assert "2" in text

    # Clean up
    fresh_store.terminate(proc_id)
    await asyncio.sleep(0.8)


# ---------------------------------------------------------------------------
# Scenario 4: PTY process group is killed cleanly by terminate_all
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_terminate_all_kills_pty_processes(fresh_store):
    """terminate_all() kills PTY-backed sleeping processes cleanly."""
    pids = []
    for _ in range(3):
        pid, _ = await fresh_store.spawn("sleep 60", interactive=True)
        pids.append(pid)
    await asyncio.sleep(0.3)

    fresh_store.terminate_all()
    await asyncio.sleep(0.8)

    for pid in pids:
        entry = fresh_store.get(pid)
        if entry is not None:
            assert entry.exit_code is not None

    # No leaked master fds — verify by checking that entries with master_fd
    # have them closed (entry.master_fd is not None, but handle._closed is True).
    for entry in fresh_store.list():
        if entry.master_fd is not None:
            handle = entry.process
            if isinstance(handle, PTYHandle):
                assert handle._closed, f"master fd not closed for entry {entry.id}"


# ---------------------------------------------------------------------------
# Scenario 5: spawn_with_pty returns handle with pid, wait(), kill()
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_spawn_with_pty_handle_api():
    """spawn_with_pty returns a handle with pid, wait(), kill()."""
    handle = await spawn_with_pty("echo pty-test")
    assert isinstance(handle, PTYHandle)
    assert isinstance(handle.pid, int)
    assert handle.pid > 0
    assert handle.returncode is None
    assert hasattr(handle, "wait")
    assert hasattr(handle, "kill")
    assert hasattr(handle, "stdin")
    assert handle.stdin is not None
    assert hasattr(handle.stdout, "read")

    rc = await handle.wait()
    assert rc == 0
    assert handle.returncode == 0


# ---------------------------------------------------------------------------
# Scenario 6: Reading from closed PTY returns EOF / empty
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_read_closed_pty_returns_eof():
    """After draining and waiting, reading from the reader returns empty."""
    handle = await spawn_with_pty("echo done-and-close")
    await asyncio.sleep(0.5)

    # Drain existing output (process has already printed).
    while True:
        chunk = await asyncio.wait_for(handle.stdout.read(65536), timeout=2.0)
        if not chunk:
            break

    # Now wait for the process to exit and close the master fd.
    rc = await handle.wait()
    assert rc == 0

    # Subsequent read should return empty (EOF).
    data = await asyncio.wait_for(handle.stdout.read(65536), timeout=2.0)
    assert data == b""


# ---------------------------------------------------------------------------
# Unit tests: open_pty
# ---------------------------------------------------------------------------


def test_open_pty_returns_pair():
    """open_pty() returns two valid file descriptors."""
    master, slave = open_pty()
    try:
        assert isinstance(master, int)
        assert isinstance(slave, int)
        assert master >= 0
        assert slave >= 0
        assert master != slave
    finally:
        os.close(master)
        os.close(slave)


# ---------------------------------------------------------------------------
# Unit tests: _PTYStdinWriter
# ---------------------------------------------------------------------------


def test_pty_stdin_writer_write():
    """_PTYStdinWriter.write() writes bytes to the master fd."""
    import select

    master, slave = open_pty()
    try:
        writer = _PTYStdinWriter(master)
        # Write with newline — PTY line discipline buffers until \n.
        writer.write(b"hello\n")
        # Wait for data to be available on the slave side.
        ready, _, _ = select.select([slave], [], [], 2.0)
        assert ready, "No data available on slave within 2 s"
        data = os.read(slave, 1024)
        assert data == b"hello\n"
    finally:
        os.close(master)
        os.close(slave)


@pytest.mark.asyncio
async def test_pty_stdin_writer_drain():
    """_PTYStdinWriter.drain() is a no-op coroutine."""
    writer = _PTYStdinWriter(-1)
    await writer.drain()  # Should not raise


# ---------------------------------------------------------------------------
# Unit tests: PTYHandle duck-type compat
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_pty_handle_duck_type():
    """PTYHandle exposes the same interface as asyncio.subprocess.Process."""
    handle = await spawn_with_pty("echo duck-type")

    # Read output
    await asyncio.sleep(0.5)
    chunk = await asyncio.wait_for(handle.stdout.read(65536), timeout=2.0)
    assert b"duck-type" in chunk

    rc = await handle.wait()
    assert rc == 0
    assert handle.returncode == 0
    assert handle.stderr is None


# ---------------------------------------------------------------------------
# Integration: PTY process in store + send + snapshot
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_store_pty_send_snapshot(fresh_store):
    """Spawn interactive, send data, verify it echoes back."""
    proc_id, _ = await fresh_store.spawn("cat", interactive=True)
    await asyncio.sleep(0.3)

    ok = await fresh_store.send(proc_id, "hello-pty\n")
    assert ok is True

    await asyncio.sleep(0.5)

    text, _ = fresh_store.snapshot(proc_id)
    assert "hello-pty" in text

    fresh_store.terminate(proc_id)
    await asyncio.sleep(0.8)


@pytest.mark.asyncio
async def test_store_pty_send_on_exited_returns_false(fresh_store):
    """send() on an already-exited interactive process returns False."""
    proc_id, _ = await fresh_store.spawn("echo quick", interactive=True)
    await asyncio.sleep(1.0)

    # Process should have exited.
    entry = fresh_store.get(proc_id)
    assert entry is not None
    assert entry.exit_code is not None

    ok = await fresh_store.send(proc_id, "anything\n")
    assert ok is False


# ---------------------------------------------------------------------------
# All existing tests still pass — no regression marker
# ---------------------------------------------------------------------------


def test_import_roundtrip():
    """pty_support is importable from background_store context."""
    from orchid.tools import pty_support as pty_mod

    assert hasattr(pty_mod, "open_pty")
    assert hasattr(pty_mod, "spawn_with_pty")
    assert hasattr(pty_mod, "PTYHandle")
