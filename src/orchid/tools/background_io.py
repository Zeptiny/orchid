"""Tool executors for ``read_output``, ``send_input``, and ``terminate_command`` background commands."""

from __future__ import annotations

import time

from orchid.domain.tool import ExecutorResult, Tool, ToolParameter, ToolParameterProperties
from orchid.tools._xml_utils import cdata_text, xml_attr
from orchid.tools.background_store import get_background_store


def _truncate_preview(text: str, max_len: int = 60) -> str:
    """Return a short preview of *text*, truncating with … if needed."""
    text = text.replace("\n", "\\n").replace("\r", "")
    if len(text) <= max_len:
        return text
    return text[: max_len - 1] + "…"

# ---------------------------------------------------------------------------
# Tool definitions
# ---------------------------------------------------------------------------

read_output_tool = Tool(
    name="read_output",
    description=(
        "Read output from a background command. Returns a snapshot of recent "
        "output and exit code. Use wait_ms for long-polling: blocks until new "
        "output, exit, or deadline."
    ),
    parameters=ToolParameter(
        properties={
            "id": ToolParameterProperties(
                type="integer",
                description="The background command id",
            ),
            "last_n": ToolParameterProperties(
                type="integer",
                description="Number of recent output lines to include (default: all available)",
            ),
            "wait_ms": ToolParameterProperties(
                type="integer",
                description=(
                    "Long-poll: wait up to this many milliseconds for new output "
                    "or exit (default: no wait)"
                ),
            ),
        },
        required=["id"],
    ),
    action_label="Reading output...",
)

send_input_tool = Tool(
    name="send_input",
    description=(
        "Send input to an interactive background command's stdin. Rejected "
        "when the command is not interactive or when a user owns the input "
        "(control: USER)."
    ),
    parameters=ToolParameter(
        properties={
            "id": ToolParameterProperties(
                type="integer",
                description="The background command id",
            ),
            "text": ToolParameterProperties(
                type="string",
                description="Text to write to stdin (include \\n for newline)",
            ),
        },
        required=["id", "text"],
    ),
    action_label="Sending input...",
)

# ---------------------------------------------------------------------------
# Executors
# ---------------------------------------------------------------------------


_MAX_LONG_POLL_MS = 60_000


async def execute_read_output(
    id: int,  # noqa: A002 – matches tool param name
    last_n: int | None = None,
    wait_ms: int | None = None,
) -> ExecutorResult:
    """Read / long-poll output from a background command."""
    store = get_background_store()
    entry = store.get(id)
    if entry is None:
        return ExecutorResult(
            display=f"Background command {id} not found",
            content=(
                f'<error id="{id}">'
                f"<![CDATA[No background command with id {id}.]]>"
                f"</error>"
            ),
        )

    # Long-poll: wait for new output or exit before snapshotting.
    if wait_ms is not None and wait_ms > 0 and entry.exit_code is None:
        bounded = min(wait_ms, _MAX_LONG_POLL_MS)
        await store.wait_for_progress(id, bounded)

    result = store.snapshot(id, last_n)
    if result is None:
        return ExecutorResult(
            display=f"Background command {id} not found",
            content=(
                f'<error id="{id}">'
                f"<![CDATA[No background command with id {id}.]]>"
                f"</error>"
            ),
        )

    tail_text, exit_code = result

    exit_attr = str(exit_code) if exit_code is not None else "running"
    exit_tag = (
        f' exit_code="{xml_attr(exit_attr)}"'
        if exit_code is not None
        else ""
    )

    status = "exited" if exit_code is not None else "running"

    cmd_preview = _truncate_preview(entry.command, max_len=80)
    return ExecutorResult(
        display=f"$ {cmd_preview} ({status})",
        content=(
            f'<command_output id="{id}"{exit_tag}>\n'
            f"<stdout><![CDATA[{cdata_text(tail_text)}]]></stdout>\n"
            f"</command_output>"
        ),
    )


async def execute_send_input(
    id: int,  # noqa: A002 – matches tool param name
    text: str,
) -> ExecutorResult:
    """Send stdin input to an interactive background command."""
    store = get_background_store()
    entry = store.get(id)
    if entry is None:
        return ExecutorResult(
            display=f"Background command {id} not found",
            content=(
                f'<error id="{id}">'
                f"<![CDATA[No background command with id {id}.]]>"
                f"</error>"
            ),
        )

    # R5: not interactive
    if not entry.interactive:
        return ExecutorResult(
            display=f"Command {id} is not interactive",
            content=(
                f'<error id="{id}">'
                f"<![CDATA[Command was not started with interactive=true. "
                f"Respawn with interactive=true to send input.]]>"
                f"</error>"
            ),
        )

    # Already exited
    if entry.exit_code is not None:
        return ExecutorResult(
            display=f"Command {id} has exited",
            content=(
                f'<error id="{id}">'
                f"<![CDATA[Command has already exited.]]>"
                f"</error>"
            ),
        )

    # R7: user owns input
    if entry.owner == "USER":
        return ExecutorResult(
            display=f"Command {id} owned by user",
            content=(
                f'<error id="{id}">'
                f"<![CDATA[A user currently owns the input for this command "
                f"(control: USER). Wait for them to release.]]>"
                f"</error>"
            ),
        )

    ok = await store.send(id, text)
    if not ok:
        return ExecutorResult(
            display=f"Failed to send input to command {id}",
            content=(
                f'<error id="{id}">'
                f"<![CDATA[Failed to write to stdin (pipe broken or closed).]]>"
                f"</error>"
            ),
        )

    # Record user input time for idle auto-release.
    entry.last_user_input_at = time.monotonic()

    return ExecutorResult(
        display=f"Sent input to command {id}: {_truncate_preview(text)}",
        content=(
            f'<input_sent id="{id}"><text><![CDATA[{cdata_text(text)}]]></text></input_sent>'
        ),
    )


# ---------------------------------------------------------------------------
# terminate_command
# ---------------------------------------------------------------------------

terminate_command_tool = Tool(
    name="terminate_command",
    description=(
        "Terminate a running background command. Sends SIGTERM followed by "
        "SIGKILL to the process group. Use when a background command is no "
        "longer needed or is stuck."
    ),
    parameters=ToolParameter(
        properties={
            "id": ToolParameterProperties(
                type="integer",
                description="The background command id to terminate",
            ),
        },
        required=["id"],
    ),
    action_label="Terminating...",
)


async def execute_terminate_command(
    id: int,  # noqa: A002 – matches tool param name
) -> ExecutorResult:
    """Terminate a running background command."""
    store = get_background_store()
    entry = store.get(id)
    if entry is None:
        return ExecutorResult(
            display=f"Background command {id} not found",
            content=(
                f'<error id="{id}">'
                f"<![CDATA[No background command with id {id}.]]>"
                f"</error>"
            ),
        )

    if entry.exit_code is not None:
        return ExecutorResult(
            display=f"Command {id} already exited (code {entry.exit_code})",
            content=(
                f'<command_terminated id="{id}" already_exited="true" '
                f'exit_code="{entry.exit_code}" />'
            ),
        )

    store.terminate(id)

    return ExecutorResult(
        display=f"Terminated command {id}: $ {_truncate_preview(entry.command)}",
        content=(
            f'<command_terminated id="{id}" command="{xml_attr(entry.command)}" />'
        ),
    )
