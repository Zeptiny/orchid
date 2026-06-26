"""Tests for execute_command bounded output (P1-13)."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from stupidex.tools.exec import MAX_OUTPUT_BYTES, execute_command


@pytest.mark.asyncio
async def test_happy_path_echo():
    result = await execute_command("echo hello", description="echo", shell=True)
    assert "hello" in result.content
    assert "<command_result" in result.content
    assert 'command="echo hello"' in result.content
    assert 'exit_code="0"' in result.content
    assert "exit code: 0" in result.display


@pytest.mark.asyncio
async def test_truncation_mocked():
    big = b"x" * (MAX_OUTPUT_BYTES * 2)

    def make_stream(data: bytes):
        stream = MagicMock()
        offset = {"i": 0}

        async def read(n):
            if offset["i"] >= len(data):
                return b""
            chunk = data[offset["i"] : offset["i"] + n]
            offset["i"] += len(chunk)
            return chunk

        stream.read = read
        return stream

    process = MagicMock()
    process.stdout = make_stream(big)
    process.stderr = make_stream(b"")
    process.pid = 999999
    process.returncode = None

    async def fake_wait():
        process.returncode = -9
        return -9

    process.wait = fake_wait
    process.kill = MagicMock()

    with (
        patch(
            "stupidex.tools.exec.asyncio.create_subprocess_shell",
            new=AsyncMock(return_value=process),
        ),
        patch("stupidex.tools.exec.os.killpg", side_effect=OSError),
    ):
        result = await execute_command("yes", description="yes", timeout=5)

    assert "<truncated>true</truncated>" in result.content
    assert "exit code: -9" in result.display
    process.kill.assert_called()


@pytest.mark.asyncio
async def test_timeout_kills_process():
    result = await execute_command("sleep 10", description="sleep", timeout=1)
    assert "timed out" in result.display.lower()
    assert "<command_result" in result.content
    assert 'timed_out="true"' in result.content
    assert "timed out after 1 seconds" in result.content


@pytest.mark.asyncio
async def test_stderr_only():
    result = await execute_command("sh -c 'echo oops 1>&2'", description="stderr", timeout=5)
    assert "oops" in result.content
    assert "<stderr>" in result.content
    assert "exit code: 0" in result.display


@pytest.mark.asyncio
async def test_nonzero_exit_after_truncation(mocked_process_factory):
    big = b"y" * (MAX_OUTPUT_BYTES + 4096)
    process = mocked_process_factory(stdout_data=big, returncode=3)
    with patch(
        "stupidex.tools.exec.asyncio.create_subprocess_shell",
        new=AsyncMock(return_value=process),
    ):
        result = await execute_command("sh -c 'big; exit 3'", description="big", timeout=5)
    assert "<truncated>true</truncated>" in result.content
    assert 'exit_code="3"' in result.content
    assert "exit code: 3" in result.display


@pytest.mark.asyncio
async def test_binary_urandom_does_not_oom():
    big = bytes(range(256)) * ((MAX_OUTPUT_BYTES // 256) + 8)
    process = MagicMock()
    process.stdout = _make_stream(big)
    process.stderr = _make_stream(b"")
    process.pid = 999999
    process.returncode = None

    async def fake_wait():
        process.returncode = 0
        return 0

    process.wait = fake_wait
    process.kill = MagicMock()

    with (
        patch(
            "stupidex.tools.exec.asyncio.create_subprocess_shell",
            new=AsyncMock(return_value=process),
        ),
        patch("stupidex.tools.exec.os.killpg", side_effect=OSError),
    ):
        result = await execute_command("cat /dev/urandom", description="urandom", timeout=5)

    assert "<truncated>true</truncated>" in result.content
    assert len(result.content) < MAX_OUTPUT_BYTES + 1024


def _make_stream(data: bytes):
    stream = MagicMock()
    offset = {"i": 0}

    async def read(n):
        if offset["i"] >= len(data):
            return b""
        chunk = data[offset["i"] : offset["i"] + n]
        offset["i"] += len(chunk)
        return chunk

    stream.read = read
    return stream


@pytest.fixture
def mocked_process_factory():
    def _factory(stdout_data: bytes, returncode: int, stderr_data: bytes = b""):
        def make_stream(data: bytes):
            stream = MagicMock()
            offset = {"i": 0}

            async def read(n):
                if offset["i"] >= len(data):
                    return b""
                chunk = data[offset["i"] : offset["i"] + n]
                offset["i"] += len(chunk)
                return chunk

            stream.read = read
            return stream

        process = MagicMock()
        process.stdout = make_stream(stdout_data)
        process.stderr = make_stream(stderr_data)
        process.pid = 999999
        process.returncode = returncode
        process.kill = MagicMock()
        process.wait = AsyncMock(return_value=returncode)
        return process

    return _factory
