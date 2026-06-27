"""Live-updating inline widget for background command output.

A ``LiveCommandOutputWidget`` is mounted in the chat thread when a background
command is spawned.  The app-level tick feeds deltas via ``update_content()``
and the widget renders them in-place, throttled to avoid excessive redraws.

Past a configurable line cap the widget collapses to a one-line stub.
"""

from __future__ import annotations

import time

from textual.app import ComposeResult
from textual.message import Message
from textual.widgets import Static

_THROTTLE_INTERVAL = 0.2  # seconds – matches ThinkingMessageWidget
_MAX_BUFFER_LINES = 50  # hard cap on lines kept in the widget
_HEIGHT_CAP = 20  # lines before the widget collapses


class LiveCommandOutputWidget(Static):
    """Live-updating output widget for a background command.

    The widget is self-contained: it holds its own line buffer and renders
    its content in place.  The ``app.py`` tick calls ``update_content``
    (or posts a ``ContentUpdate`` message) whenever new data arrives.

    When the process exits, ``finish()`` marks the widget as done and
    stops accepting further updates.
    """

    can_focus = True

    DEFAULT_CSS = """
    LiveCommandOutputWidget {
        height: auto;
        max-height: 20;
        overflow-y: auto;
        background: $surface;
        border: solid $primary;
        padding: 0 1;
        margin: 1 0;
    }
    LiveCommandOutputWidget.collapsed {
        height: 3;
        max-height: 3;
        overflow-y: hidden;
    }
    """

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
        max_lines: int = _MAX_BUFFER_LINES,
        height_cap: int = _HEIGHT_CAP,
        **kwargs,
    ) -> None:
        super().__init__(**kwargs)
        self.command_id = command_id
        self.command_text = command_text
        self._max_lines = max_lines
        self._height_cap = height_cap
        self._lines: list[str] = []
        self._finished: bool = False
        self._exit_code: int | None = None
        self._last_render_time: float = 0.0
        self._flush_scheduled: bool = False
        self._content_widget: Static | None = None

    # -- composition ----------------------------------------------------------

    def compose(self) -> ComposeResult:
        self._content_widget = Static(self._build_stub_text(), classes="live-cmd-content")
        yield self._content_widget

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
        self._flush_scheduled = False
        self._do_render()
        if self._content_widget is not None:
            self._content_widget.update(self._build_stub_text())

    # -- Textual message handling ---------------------------------------------

    def on_live_command_output_widget_content_update(self, msg: ContentUpdate) -> None:
        self.update_content(msg.delta)

    def on_live_command_output_widget_finished(self, msg: Finished) -> None:
        self.finish(msg.exit_code)

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
                self._lines[-1] += new_text
                return
            # Merge up to and including the first newline.
            self._lines[-1] += new_text[: first_nl + 1]
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
            self._lines.append(part + "\n")

        if trailing_partial:
            self._lines.append(trailing_partial)
        elif complete_parts and new_text.endswith("\n"):
            # Input ended with \n — nothing to do; complete lines already added.
            pass

        # Enforce line cap by trimming from the head.
        if len(self._lines) > self._max_lines:
            self._lines = self._lines[-self._max_lines :]

    def _render_text(self) -> str:
        """Build the full display text from the line buffer."""
        if self._finished:
            status = (
                f"exit {self._exit_code}"
                if self._exit_code is not None
                else "exited"
            )
            header = f"── Command #{self.command_id} ({status}) ──\n"
        else:
            header = f"── Command #{self.command_id} (running) ──\n"
        body = "".join(self._lines)
        return header + body

    def _build_stub_text(self) -> str:
        """Build the compact stub shown when collapsed or finished."""
        if self._finished:
            status = (
                f"exit {self._exit_code}"
                if self._exit_code is not None
                else "exited"
            )
            return f"Command #{self.command_id}: {status} (click to expand in sidebar)"
        return f"Command #{self.command_id}: running (click to expand in sidebar)"

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
        visible_lines = len(self._lines)
        if visible_lines > self._height_cap and not self._finished:
            # Collapse to stub when above the height cap while still running.
            self.add_class("collapsed")
            self._content_widget.update(self._build_stub_text())
        else:
            self.remove_class("collapsed")
            self._content_widget.update(self._render_text())

    def flush(self) -> None:
        """Force immediate re-render, bypassing throttle."""
        self._flush_scheduled = False
        self._do_render()
