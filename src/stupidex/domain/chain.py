import logging
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from stupidex.domain.message import Message

log = logging.getLogger(__name__)


class ChainStatus(Enum):
    RUNNING = "running"
    COMPLETED = "completed"
    INTERRUPTED = "interrupted"
    FAILED = "failed"


@dataclass
class Chain:
    model: str | None = None
    messages: list[Message] = field(default_factory=list)
    start_time: float = field(default_factory=time.monotonic)
    end_time: float | None = None
    status: ChainStatus = ChainStatus.RUNNING

    @property
    def elapsed(self) -> float:
        end = self.end_time if self.end_time else time.monotonic()
        return end - self.start_time

    def finish(self, status: ChainStatus = ChainStatus.COMPLETED) -> None:
        if self.status != ChainStatus.RUNNING:
            return
        self.end_time = time.monotonic()
        self.status = status

    @staticmethod
    def format_elapsed(seconds: float) -> str:
        if seconds < 1:
            return f"{seconds * 1000:.0f}ms"
        if seconds < 60:
            return f"{seconds:.1f}s"
        minutes = int(seconds // 60)
        secs = seconds % 60
        return f"{minutes}m {secs:.0f}s"

    @staticmethod
    def format_tokens(n: int) -> str:
        """Compact token count: ``1.2k`` / ``12.3k`` / ``1.5M``.

        Below 1000 the raw integer is returned unchanged (e.g. ``999``).
        Cached tokens that sum to zero still surface as ``0`` rather than
        being filtered, so the caller decides whether to render a segment.
        """
        if n < 1000:
            return str(n)
        if n < 1_000_000:
            return f"{n / 1000:.1f}k"
        return f"{n / 1_000_000:.1f}M"

    def to_storage_dict(self) -> dict[str, Any]:
        return {
            "model": self.model,
            "messages": [m.to_storage_dict() for m in self.messages],
            "start_time": self.start_time,
            "end_time": self.end_time,
            "status": self.status.value,
        }

    @classmethod
    def from_storage_dict(cls, data: dict[str, Any]) -> "Chain":
        messages = [Message.from_storage_dict(m) for m in data.get("messages", [])]
        _reconcile_orphan_tool_results(messages)
        chain = cls(
            model=data.get("model"),
            messages=messages,
            start_time=data.get("start_time", 0.0),
            end_time=data.get("end_time"),
            status=ChainStatus(data.get("status", "completed")),
        )
        return chain


def _reconcile_orphan_tool_results(messages: list[Message]) -> None:
    """Prune TOOL_RESULT messages whose tool_call_id has no preceding
    assistant tool_calls partner in this list. Pre-fix sessions
    persisted TOOL_RESULT without the matching assistant tool_calls
    (the bug fixed in the persistence layer); these are dropped at
    replay by `_history_to_api_messages` but otherwise remain on disk,
    producing repeated orphan-drop log noise each turn.

    Mutates `messages` in place so the next save converges on a clean
    state. Displayed-only orphan TOOL_RESULTs (no preceding assistant
    with tool_calls) cannot be paired by replay, so their content is
    effectively dead context at the API layer; removing them avoids
    carrying the legacy corruption forward.
    """
    if not messages:
        return
    seen_tool_call_ids: set[str] = set()
    seen_result_ids: set[str] = set()
    keep: list[Message] = []
    for msg in messages:
        if msg.role.value == "tool" and msg.tool_call_id:
            if msg.tool_call_id in seen_result_ids:
                log.debug(
                    "Reconciling chain: dropping duplicate TOOL_RESULT "
                    "for tool_call_id=%s (already seen earlier in this chain)",
                    msg.tool_call_id,
                )
                continue
            if msg.tool_call_id not in seen_tool_call_ids:
                log.debug(
                    "Reconciling chain: dropping orphan TOOL_RESULT "
                    "for tool_call_id=%s (no preceding assistant tool_calls)",
                    msg.tool_call_id,
                )
                continue
            seen_result_ids.add(msg.tool_call_id)
        if msg.tool_calls:
            for tc in msg.tool_calls:
                tid = tc.get("id")
                if tid:
                    seen_tool_call_ids.add(tid)
        keep.append(msg)

    if len(keep) != len(messages):
        del messages[:]
        messages.extend(keep)
