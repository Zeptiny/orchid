import asyncio
import os
import shlex
import signal

from stupidex.config import get_config
from stupidex.domain.tool import ExecutorResult, Tool, ToolParameter, ToolParameterProperties
from stupidex.tools._xml_utils import _cdata_text, _xml_attr

MAX_OUTPUT_BYTES = 1 * 1024 * 1024


async def _read_bounded(
    process: asyncio.subprocess.Process,
    timeout: float,
    max_bytes: int,
) -> tuple[bytes, bytes, bool]:
    stdout_buf = bytearray()
    stderr_buf = bytearray()
    truncated = False

    async def _read_stream(stream: asyncio.StreamReader | None, buf: bytearray) -> None:
        if stream is None:
            return
        nonlocal truncated
        while not truncated:
            remaining = max_bytes - len(stdout_buf) - len(stderr_buf)
            if remaining <= 0:
                truncated = True
                return
            chunk = await stream.read(min(65536, remaining))
            if not chunk:
                return
            buf.extend(chunk)
            if len(stdout_buf) + len(stderr_buf) >= max_bytes:
                truncated = True
                return

    await asyncio.wait_for(
        asyncio.gather(
            _read_stream(process.stdout, stdout_buf),
            _read_stream(process.stderr, stderr_buf),
        ),
        timeout=timeout,
    )
    total = len(stdout_buf) + len(stderr_buf)
    if total > max_bytes:
        overflow = total - max_bytes
        if len(stderr_buf) >= overflow:
            del stderr_buf[len(stderr_buf) - overflow :]
        else:
            rem = overflow - len(stderr_buf)
            del stderr_buf[:]
            del stdout_buf[len(stdout_buf) - rem :]
    return bytes(stdout_buf), bytes(stderr_buf), truncated


execute_command_tool = Tool(
    name="execute_command",
    description="Execute a shell command and return its output. Use for running tests, git commands, build tools, linting, and other CLI operations. Prefer this over writing scripts — run commands directly.",
    parameters=ToolParameter(
        properties={
            "command": ToolParameterProperties(
                type="string", description="The command to execute (e.g., 'ls -la', 'python script.py', 'git status')"
            ),
            "description": ToolParameterProperties(
                type="string", description="A brief description of what the command does (for display purposes)"
            ),
            "working_directory": ToolParameterProperties(
                type="string", description="The working directory to run the command in (default: current directory)"
            ),
            "timeout": ToolParameterProperties(
                type="integer", description="Timeout in seconds for the command execution (default: 30)"
            ),
            "shell": ToolParameterProperties(
                type="boolean", description="Whether to run the command through the shell (default: true)"
            ),
        },
        required=["command", "description"],
    ),
    action_label="Running...",
)


async def execute_command(
    command: str,
    description: str | None = None,
    working_directory: str = ".",
    timeout: int | None = None,
    shell: bool = True,
) -> ExecutorResult:
    """Execute a system command using asyncio subprocess."""
    if timeout is None:
        timeout = get_config().command_timeout
    if description is None:
        description = command
    try:
        if shell:
            process = await asyncio.create_subprocess_shell(
                command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=working_directory,
                start_new_session=True,
            )
        else:
            args = shlex.split(command)
            process = await asyncio.create_subprocess_exec(
                *args,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=working_directory,
                start_new_session=True,
            )

        try:
            stdout_bytes, stderr_bytes, truncated = await _read_bounded(process, timeout, MAX_OUTPUT_BYTES)
        except TimeoutError:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except (OSError, AttributeError):
                process.kill()
            await process.wait()
            return ExecutorResult(
                display=f"{description} - Timed out after {timeout} seconds",
                content=(
                    f'<command_result command="{_xml_attr(command)}" exit_code="-1" '
                    f'timed_out="true">\n'
                    f"  <error><![CDATA[Command timed out after {timeout} seconds.]]></error>\n"
                    f"</command_result>"
                ),
            )

        if truncated and process.returncode is None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except (OSError, AttributeError):
                process.kill()
            await process.wait()

        await process.wait()

        stdout = stdout_bytes.decode("utf-8", errors="replace").strip() if stdout_bytes else ""
        stderr = stderr_bytes.decode("utf-8", errors="replace").strip() if stderr_bytes else ""

        stdout_section = (
            f"  <stdout><![CDATA[{_cdata_text(stdout)}]]></stdout>\n" if stdout else ""
        )
        stderr_section = (
            f"  <stderr><![CDATA[{_cdata_text(stderr)}]]></stderr>\n" if stderr else ""
        )
        truncation_section = (
            "  <truncated>true</truncated>\n" if truncated else ""
        )

        return ExecutorResult(
            display=f"{description} (exit code: {process.returncode})",
            content=(
                f'<command_result command="{_xml_attr(command)}" '
                f'exit_code="{process.returncode}">\n'
                f"{stdout_section}{stderr_section}{truncation_section}"
                f"</command_result>"
            ),
        )

    except Exception as e:
        return ExecutorResult(
            display=f"{description} - Execution error",
            content=(
                f'<command_result command="{_xml_attr(command)}" exit_code="-1" '
                f'error="true">\n'
                f"  <error><![CDATA[{_cdata_text(str(e))}]]></error>\n"
                f"</command_result>"
            ),
        )
