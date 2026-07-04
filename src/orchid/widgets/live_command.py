"""Live-updating inline widget for background command output.

A ``LiveCommandOutputWidget`` is mounted in the chat thread when a background
command is spawned.  The app-level tick feeds deltas via ``update_content()``
and the widget renders them in-place, throttled to avoid excessive redraws.

Renders inside a ``Collapsible`` matching the standard ``ToolResultMessageWidget``
style for visual consistency with other tool results.
"""

from __future__ import annotations

import time
from typing import Any

from rich.markup import escape as escape_markup
from textual.app import ComposeResult
from textual.message import Message
from textual.widgets import Collapsible, Static

_THROTTLE_INTERVAL = 0.2  # seconds – matches ThinkingMessageWidget
_MAX_BUFFER_LINES = 50  # hard cap on lines kept in the widget
_MAX_PARTIAL_LINE_CHARS = 4096  # cap CR-only / no-newline interactive output


class LiveCommandOutputWidget(Static):
    """Live-updating output widget for a background command.

    Renders inside a Collapsible matching ToolResultMessageWidget style.
    The ``app.py`` tick calls ``update_content`` whenever new data arrives.

    When the process exits, ``finish()`` marks the widget as done and
    stops accepting further updates.
    """

    can_focus = True

    class ContentUpdate(Message):
        """Posted when new content should be flushed to the widget."""

        def __init__(self, delta: str) -> None:
            super().__init__()
            self.delta = delta

    class Finished(Message):
        """Posted when the process has exited."""

        def __init__(self, exit_code: int | None) -> None:
            super().__init__()
            self.exit_code = exit_code

    def __init__(
        self,
        command_id: int,
        command_text: str = "",
        *,
        description: str = "",
        max_lines: int = _MAX_BUFFER_LINES,
        **kwargs: Any,
    ) -> None:
        super().__init__(**kwargs)
        self.command_id = command_id
        self.command_text = command_text
        self.description = description
        self._max_lines = max_lines
        self._lines: list[str] = []
        self._finished: bool = False
        self._exit_code: int | None = None
        self._last_render_time: float = 0.0
        self._flush_scheduled: bool = False
        self._content_widget: Static | None = None
        self._collapsible: Collapsible | None = None

    @property
    def is_finished(self) -> bool:
        return self._finished

    # -- composition ----------------------------------------------------------

    def compose(self) -> ComposeResult:
        self._content_widget = Static("", markup=False, classes="tool-result-content")
        self._collapsible = Collapsible(
            self._content_widget,
            title=self._build_title(),
            collapsed=True,
            classes="tool-result-collapse",
        )
        yield self._collapsible

    # -- public API -----------------------------------------------------------

    def update_content(self, delta: str) -> None:
        """Append *delta* to the buffer and schedule a throttled re-render."""
        if self._finished:
            return
        if delta:
            self._append_delta(delta)
        self._schedule_flush()

    def finish(self, exit_code: int | None = None) -> None:
        """Mark the widget as finished.  Flushes any pending content."""
        self._finished = True
        self._exit_code = exit_code
        self.flush()
        self._update_title()

    def get_buffered_text(self) -> str:
        """Return the accumulated output currently retained by the widget."""
        return "".join(self._lines)

    def reset_buffer(self) -> None:
        """Clear buffered output retained by the widget."""
        self._lines.clear()

    # -- Textual message handling ---------------------------------------------

    def on_live_command_output_widget_content_update(self, msg: ContentUpdate) -> None:
        self.update_content(msg.delta)

    def on_live_command_output_widget_finished(self, msg: Finished) -> None:
        self.finish(msg.exit_code)

    # -- title management -----------------------------------------------------

    def _build_title(self) -> str:
        """Build the collapsible title showing command and status."""
        cmd_display = f"$ {self.command_text}" if self.command_text else (self.description or f"Command #{self.command_id}")
        cmd_display = escape_markup(cmd_display)
        if self._finished:
            status = (
                f"exit {self._exit_code}"
                if self._exit_code is not None
                else "exited"
            )
            return f"{cmd_display} ({status})"
        return f"{cmd_display} (running)"

    def _update_title(self) -> None:
        """Update the collapsible title to reflect current status."""
        if self._collapsible is not None:
            self._collapsible.title = self._build_title()

    # -- content management ---------------------------------------------------

    def _append_delta(self, delta: str) -> None:
        """Append *delta* to the line buffer, enforcing the line cap.

        Lines are stored with their trailing ``\\n`` where present.  A line
        *without* a trailing ``\\n`` is a partial line being accumulated and
        will be merged with subsequent content.
        """
        new_text = delta.replace("\r", "")
        if not new_text:
            return

        # If we have a partial last line (no trailing \n), merge with the
        # beginning of the new input.
        if self._lines and not self._lines[-1].endswith("\n"):
            # Find where the first complete line ends in the new input.
            first_nl = new_text.find("\n")
            if first_nl == -1:
                # No newline in new input — extend the partial line.
                self._lines[-1] = self._cap_line(self._lines[-1] + new_text)
                return
            # Merge up to and including the first newline.
            self._lines[-1] = self._cap_line(self._lines[-1] + new_text[: first_nl + 1])
            new_text = new_text[first_nl + 1 :]

        if not new_text:
            return

        # Remaining text starts on a new line.  Split into complete lines and
        # a possible trailing partial line.
        parts = new_text.split("\n")
        # parts[-1] is "" when input ends with "\n" (the trailing newline
        # sentinel from str.split).  We convert each non-empty segment into
        # a line with trailing \n, and keep a trailing partial if present.
        trailing_partial = parts[-1]  # may be ""
        complete_parts = parts[:-1]

        for part in complete_parts:
            self._lines.append(self._cap_line(part + "\n"))

        if trailing_partial:
            self._lines.append(self._cap_line(trailing_partial))

        # Enforce line cap by trimming from the head.
        if len(self._lines) > self._max_lines:
            self._lines = self._lines[-self._max_lines :]

    def _cap_line(self, line: str) -> str:
        has_newline = line.endswith("\n")
        body = line[:-1] if has_newline else line
        if len(body) <= _MAX_PARTIAL_LINE_CHARS:
            return line
        body = body[-_MAX_PARTIAL_LINE_CHARS:]
        return body + ("\n" if has_newline else "")

    # -- throttled rendering --------------------------------------------------

    def _schedule_flush(self) -> None:
        now = time.monotonic()
        if now - self._last_render_time >= _THROTTLE_INTERVAL:
            self._last_render_time = now
            self._do_render()
        elif not self._flush_scheduled:
            self._flush_scheduled = True
            remaining = _THROTTLE_INTERVAL - (now - self._last_render_time)
            self.set_timer(remaining, self._flush_update)

    def _flush_update(self) -> None:
        self._flush_scheduled = False
        self._last_render_time = time.monotonic()
        self._do_render()

    def _do_render(self) -> None:
        if self._content_widget is None:
            return
        body = "".join(self._lines)
        self._content_widget.update(body)

    def flush(self) -> None:
        """Force immediate re-render, bypassing throttle."""
        self._flush_scheduled = False
        self._do_render()
