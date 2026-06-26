import re
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from rich.syntax import Syntax
from rich.text import Text
from textual.app import ComposeResult
from textual.widgets import Collapsible, Static
from textual.widgets import Markdown as TextualMarkdown

from stupidex.domain.chain import Chain, ChainStatus
from stupidex.domain.message import Message, MessageRole, MessageType
from stupidex.tools import get_tool_registry

_THROTTLE_INTERVAL = 0.2
_TOOL_RESULT_FALLBACK_TITLE = "Tool result"
_TOOL_RESULT_TITLE_MAX_LENGTH = 120
_EDIT_DIFF_MARKER = "\n\nDiff:\n"
_EDIT_DIFF_CDATA_RE = re.compile(
    r'<diff\s+format="unified">\s*<!\[CDATA\[\n?(?P<diff>.*?)\n?\]\]>\s*</diff>',
    re.DOTALL,
)
_DIFF_HUNK_RE = re.compile(r"^@@ -(?P<old_start>\d+)(?:,\d+)? \+(?P<new_start>\d+)(?:,\d+)? @@")
_DIFF_LINE_NUMBER_WIDTH = 4
_DIFF_CONTEXT_STYLE = "#c9d1d9"
_DIFF_ADDED_STYLE = "#d7ffdf on #153b25"
_DIFF_REMOVED_STYLE = "#ffd7d7 on #3b1717"
_DIFF_META_STYLE = "#7d8590"
_DIFF_SYNTAX_THEME = "ansi_dark"
_DIFF_LEXER_BY_EXTENSION = {
    ".bash": "bash",
    ".css": "css",
    ".go": "go",
    ".html": "html",
    ".java": "java",
    ".js": "javascript",
    ".json": "json",
    ".jsx": "jsx",
    ".md": "markdown",
    ".py": "python",
    ".rb": "ruby",
    ".rs": "rust",
    ".sh": "bash",
    ".tcss": "css",
    ".toml": "toml",
    ".ts": "typescript",
    ".tsx": "tsx",
    ".yaml": "yaml",
    ".yml": "yaml",
}


def get_tool_action_label(tool_name: str) -> str:
    registry = get_tool_registry()
    entry = registry.get(tool_name)
    if entry and entry["tool"].action_label:
        return entry["tool"].action_label
    return f"Using {tool_name}..."


def get_tool_result_title(msg: Message) -> str:
    if msg.display is None:
        return _TOOL_RESULT_FALLBACK_TITLE

    title = " ".join(msg.display.split())
    if not title:
        return _TOOL_RESULT_FALLBACK_TITLE
    if len(title) <= _TOOL_RESULT_TITLE_MAX_LENGTH:
        return title
    return title[: _TOOL_RESULT_TITLE_MAX_LENGTH - 3].rstrip() + "..."


def get_tool_result_renderable(msg: Message) -> Text:
    edit_diff = _extract_edit_diff(msg)
    if edit_diff is not None:
        return _render_unified_diff(edit_diff)
    return Text(msg.content)


def _extract_edit_diff(msg: Message) -> str | None:
    if msg.display is None or not msg.display.startswith("Edited "):
        return None
    cdata_match = _EDIT_DIFF_CDATA_RE.search(msg.content)
    if cdata_match:
        diff_text = cdata_match.group("diff").replace("]]]]><![CDATA[>", "]]>").rstrip("\n")
        return diff_text or None

    if _EDIT_DIFF_MARKER not in msg.content:
        return None

    diff_text = msg.content.split(_EDIT_DIFF_MARKER, 1)[1].rstrip("\n")
    return diff_text or None


def _render_unified_diff(diff_text: str) -> Text:
    rendered = Text(no_wrap=True, overflow="crop")
    lexer = _guess_diff_lexer(diff_text)
    old_line = 0
    new_line = 0
    hunk_count = 0

    for raw_line in diff_text.splitlines():
        hunk_match = _DIFF_HUNK_RE.match(raw_line)
        if hunk_match:
            if hunk_count:
                rendered.append(f"{':':>{_DIFF_LINE_NUMBER_WIDTH}}\n", style=_DIFF_META_STYLE)
            hunk_count += 1
            old_line = int(hunk_match.group("old_start"))
            new_line = int(hunk_match.group("new_start"))
            continue

        if not raw_line or raw_line.startswith(("---", "+++")):
            continue

        if raw_line.startswith("+"):
            _append_diff_line(rendered, new_line, "+", raw_line[1:], _DIFF_ADDED_STYLE, lexer)
            new_line += 1
        elif raw_line.startswith("-"):
            _append_diff_line(rendered, old_line, "-", raw_line[1:], _DIFF_REMOVED_STYLE, lexer)
            old_line += 1
        elif raw_line.startswith(" "):
            _append_diff_line(rendered, new_line, " ", raw_line[1:], _DIFF_CONTEXT_STYLE, lexer)
            old_line += 1
            new_line += 1
        else:
            rendered.append(f"{'':>{_DIFF_LINE_NUMBER_WIDTH}}  {raw_line}\n", style=_DIFF_META_STYLE)

    if rendered.plain:
        return rendered
    return Text(diff_text, no_wrap=True, overflow="crop")


def _guess_diff_lexer(diff_text: str) -> str:
    path = _extract_diff_path(diff_text)
    code = "\n".join(
        line[1:]
        for line in diff_text.splitlines()
        if line.startswith((" ", "+", "-")) and not line.startswith(("+++", "---"))
    )
    if path is None:
        return "default"

    for suffix, lexer in _DIFF_LEXER_BY_EXTENSION.items():
        if path.endswith(suffix):
            return lexer

    try:
        return Syntax.guess_lexer(path, code=code)
    except Exception:
        return "default"


def _extract_diff_path(diff_text: str) -> str | None:
    for line in diff_text.splitlines():
        if line.startswith("+++ new/"):
            return line.removeprefix("+++ new/")
    return None


def _append_diff_line(
    rendered: Text,
    line_number: int,
    prefix: str,
    content: str,
    style: str,
    lexer: str,
) -> None:
    rendered.append(f"{line_number:>{_DIFF_LINE_NUMBER_WIDTH}} {prefix}", style=style)
    rendered.append_text(_highlight_diff_content(content, style, lexer))
    rendered.append("\n", style=style)


def _highlight_diff_content(content: str, style: str, lexer: str) -> Text:
    highlighted = Syntax(content, lexer, theme=_DIFF_SYNTAX_THEME).highlight(content)
    code = Text(content, style=style)
    for span in highlighted.spans:
        if span.start >= len(content):
            continue
        code.stylize(span.style, span.start, min(span.end, len(content)))
    return code


class UserMessageWidget(TextualMarkdown):
    def __init__(self, msg: Message, **kwargs):
        self.msg = msg
        super().__init__(msg.content, **kwargs)


class ThinkingMessageWidget(Static):
    """A collapsible widget that shows 'Thinking...' when collapsed and full thinking when expanded."""

    def __init__(self, msg: Message, *, loaded: bool = False, **kwargs):
        self.msg = msg
        self._last_render_time: float = 0
        self._flush_scheduled: bool = False
        self._start_time: float = time.monotonic()
        self._loaded = loaded
        self._stored_duration: float | None = msg.metadata.get("thinking_duration")
        self._content_widget: Static | None = None
        self._collapsible: Collapsible | None = None
        super().__init__(**kwargs)

    def compose(self) -> ComposeResult:
        if self._loaded:
            title = (
                f"Thought: {Chain.format_elapsed(self._stored_duration)}"
                if self._stored_duration is not None
                else "Thought"
            )
        else:
            title = "Thinking..."
        self._content_widget = Static(
            Text(self.msg.content) if self._loaded else Text(""),
            classes="thinking-content",
        )
        self._collapsible = Collapsible(
            self._content_widget,
            title=title,
            collapsed=True,
            classes="thinking-collapse",
        )
        yield self._collapsible

    def update_content(self, content: str) -> None:
        self.msg.content = content
        if self._collapsible is None:
            return
        if self._collapsible.collapsed:
            return
        now = time.monotonic()
        if now - self._last_render_time >= _THROTTLE_INTERVAL:
            self._last_render_time = now
            self._do_update()
        elif not self._flush_scheduled:
            self._flush_scheduled = True
            remaining = _THROTTLE_INTERVAL - (now - self._last_render_time)
            self.set_timer(remaining, self._flush_update)

    def _do_update(self) -> None:
        if self._content_widget is None:
            return
        self._content_widget.update(Text(self.msg.content))

    def _flush_update(self) -> None:
        self._flush_scheduled = False
        self._last_render_time = time.monotonic()
        self._do_update()

    def flush(self) -> None:
        """Force immediate update, bypassing throttle."""
        self._flush_scheduled = False
        self._do_update()

    def finish(self) -> None:
        """Flush final content and update the title with elapsed time."""
        self._flush_scheduled = False
        self._do_update()
        elapsed = time.monotonic() - self._start_time
        self.msg.metadata["thinking_duration"] = elapsed
        label = Chain.format_elapsed(elapsed)
        if self._collapsible is not None:
            self._collapsible.title = f"Thought: {label}"

    def on_collapsible_toggle(self, event) -> None:
        if not event.collapsed:
            self._do_update()


class AssistantMessageWidget(TextualMarkdown):
    """Assistant message using Textual's MarkdownStream for incremental streaming.

    Uses ``MarkdownStream.write()`` which handles buffering, coalescing,
    and back-pressure internally.
    """

    def __init__(self, msg: Message, *, loaded: bool = False, **kwargs):
        self.msg = msg
        super().__init__(msg.content, **kwargs)
        self._stream = TextualMarkdown.get_stream(self)
        self._last_appended_len: int = len(msg.content)

    async def update_content(self, content: str) -> None:
        self.msg.content = content
        delta = content[self._last_appended_len :]
        if not delta:
            return
        self._last_appended_len = len(content)
        await self._stream.write(delta)


class ChainFooterWidget(Static):
    """Footer showing model + elapsed time for a chain.

    Optionally renders a delegated-subagent subtotal "(sub: ...)" segment
    when ``subagent_subtotal`` returns a non-None tuple of
    ``(prompt, cached, completion, total)`` tokens attributed to this chain
    via ``parent_chain_index`` (R11).
    """

    def __init__(
        self,
        chain: Chain,
        subagent_subtotal: Callable[[], tuple[int, int, int, int] | None] | None = None,
        **kwargs,
    ):
        self._chain = chain
        self._subagent_subtotal = subagent_subtotal
        super().__init__(self._build_text(), **kwargs)

    def _build_text(self) -> str:
        model = self._chain.model or "Unknown"
        text = f"{model} · {Chain.format_elapsed(self._chain.elapsed)}"
        usage = self._chain_usage()
        if usage is not None:
            # Cached tokens are a subset of prompt tokens (R7) — render as
            # "of which" parenthetically, never summed into input. The usage
            # here is the chain's cumulative sum across all agentic-loop LLM
            # calls, so it grows monotonically rather than fluctuating with
            # each intermediate snapshot.
            prompt, cached, completion, _total = usage
            text += (
                f" · ↑{Chain.format_tokens(prompt)} (⟲{Chain.format_tokens(cached)}) ↓{Chain.format_tokens(completion)}"
            )
        # Delegated subagent subtotal (R11): the tokens of subagents whose
        # ``parent_chain_index`` is this chain's index. Rendered as a separate
        # parenthetical so it is visually attributed, not conflated with the
        # chain's own usage.
        sub = self._subagent_subtotal() if self._subagent_subtotal else None
        if sub is not None:
            prompt, cached, completion, _total = sub
            if prompt or cached or completion:
                text += (
                    f" · (sub: ↑{Chain.format_tokens(prompt)}"
                    f" (⟲{Chain.format_tokens(cached)})"
                    f" ↓{Chain.format_tokens(completion)})"
                )
        return text

    def _chain_usage(self) -> tuple[int, int, int, int] | None:
        """Sum usage across all messages carrying ``usage`` in the chain.

        Returns ``(prompt, cached, completion, total)`` or ``None`` when the
        chain has no usage.
        """
        prompt = cached = completion = total = 0
        found = False
        for msg in self._chain.messages:
            if msg.usage is None:
                continue
            found = True
            prompt += msg.usage.prompt_tokens
            cached += msg.usage.cached_tokens
            completion += msg.usage.completion_tokens
            total += msg.usage.total_tokens
        if not found:
            return None
        return (prompt, cached, completion, total)

    def tick(self) -> None:
        if self._chain.status == ChainStatus.RUNNING:
            self.update(self._build_text())

    def freeze(self) -> None:
        self.update(self._build_text())


class ChainContainer(Static):
    """Wraps a user message and all its responses into a chain with a footer."""

    DEFAULT_CSS = """
    ChainContainer {
        height: auto;
        margin: 0;
        padding: 0;
    }
    ChainContainer .chain-messages {
        height: auto;
    }
    ChainContainer .chain-footer {
        height: auto;
        color: $text-muted;
        text-style: dim;
        padding: 0 1 1 1;
        margin: 0 1 0 1;
    }
    """

    def __init__(
        self,
        chain: Chain,
        subagent_subtotal: Callable[[], tuple[int, int, int, int] | None] | None = None,
        **kwargs,
    ):
        self.chain = chain
        self._subagent_subtotal = subagent_subtotal
        self._footer: ChainFooterWidget | None = None
        self._messages: Static | None = None
        super().__init__(**kwargs)

    def compose(self) -> ComposeResult:
        self._messages = Static(classes="chain-messages")
        self._footer = ChainFooterWidget(
            self.chain,
            subagent_subtotal=self._subagent_subtotal,
            classes="chain-footer",
        )
        yield self._messages
        yield self._footer

    @property
    def footer(self) -> ChainFooterWidget | None:
        return self._footer

    @property
    def messages_area(self) -> Static | None:
        return self._messages

    def tick(self) -> None:
        if self._footer:
            self._footer.tick()

    def freeze(self) -> None:
        if self._footer:
            self._footer.freeze()


class ErrorMessageWidget(Static):
    """Widget for displaying error messages. Content is never sent to the LLM."""

    DEFAULT_CSS = """
    ErrorMessageWidget {
        background: #3a1010;
        border: wide #dc143c;
        margin: 0 1;
        padding: 0 1;
        height: auto;
    }

    ErrorMessageWidget .error-title {
        text-style: bold;
        color: #ff4444;
    }

    ErrorMessageWidget .error-detail {
        color: #cc8888;
    }
    """

    def __init__(self, msg: Message, **kwargs):
        self.msg = msg
        super().__init__(**kwargs)

    def compose(self) -> ComposeResult:
        title = self.msg.metadata.get("error_title", "Error")
        yield Static(title, classes="error-title")
        yield Static(self.msg.content, classes="error-detail")


class ToolResultMessageWidget(Static):
    """A collapsible widget that shows the display summary when collapsed and full content when expanded."""

    def __init__(self, msg: Message, **kwargs):
        self.msg = msg
        super().__init__(**kwargs)

    def compose(self) -> ComposeResult:
        yield Collapsible(
            Static(get_tool_result_renderable(self.msg), classes="tool-result-content"),
            title=get_tool_result_title(self.msg),
            collapsed=True,
            classes="tool-result-collapse",
        )


def create_message_widget(
    msg: Message, *, loaded: bool = False, classes: str | None = None
) -> Static | TextualMarkdown | None:
    """Factory function to create the appropriate widget for a message."""
    match msg.type:
        case MessageType.THINKING:
            return ThinkingMessageWidget(msg, loaded=loaded, classes=classes)
        case MessageType.TOOL_CALL:
            return None
        case MessageType.TOOL_RESULT:
            return ToolResultMessageWidget(msg, classes=classes)
        case MessageType.ERROR:
            return ErrorMessageWidget(msg, classes=classes)
        case _:
            if msg.role == MessageRole.USER:
                return UserMessageWidget(msg, classes=classes)
            return AssistantMessageWidget(msg, loaded=loaded, classes=classes)


@dataclass
class StreamWidgetState:
    """Tracks the current thinking/content/temp widgets for a message stream."""

    thinking: Any = None
    content: Any = None
    temp: list[Static] = field(default_factory=list)


async def mount_streamed_message(container, msg: Message, state: StreamWidgetState) -> None:
    """Mount or update widgets for a streamed message."""
    if msg.type == MessageType.ERROR:
        w = ErrorMessageWidget(msg)
        await container.mount(w)
        w.scroll_visible(animate=False)
        return
    if msg.type == MessageType.THINKING:
        if state.thinking is None:
            w = ThinkingMessageWidget(msg)
            await container.mount(w)
            state.thinking = w
            w.scroll_visible(animate=False)
        else:
            state.thinking.update_content(msg.content)
    elif msg.type == MessageType.TOOL_CALL:
        tool_name = msg.metadata.get("tool_name", "")
        temp = Static(get_tool_action_label(tool_name), classes="temp-tool-message")
        await container.mount(temp)
        temp.scroll_visible(animate=False)
        state.temp.append(temp)
        if state.thinking:
            state.thinking.finish()
    elif msg.type == MessageType.TOOL_RESULT:
        w = ToolResultMessageWidget(msg, classes="after-thinking" if state.thinking else None)
        if state.temp:
            temp = state.temp.pop(0)
            async with container.batch():
                await container.mount(w, before=temp)
                await temp.remove()
        else:
            await container.mount(w)
        w.scroll_visible(animate=False)
        if state.thinking:
            state.thinking.finish()
        state.thinking = None
        state.content = None
    elif msg.role == MessageRole.USER:
        w = UserMessageWidget(msg)
        await container.mount(w)
        w.scroll_visible(animate=False)
        state.thinking = None
        state.content = None
    else:
        if state.content is None:
            if msg.content:
                if state.thinking:
                    state.thinking.finish()
                w = AssistantMessageWidget(msg)
                await container.mount(w)
                state.content = w
                state.thinking = None
                w.scroll_visible(animate=False)
        else:
            if msg.content:
                await state.content.update_content(msg.content)
