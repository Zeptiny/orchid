import copy
from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class MessageRole(Enum):
    USER = "user"
    ASSISTANT = "assistant"
    SYSTEM = "system"
    TOOL = "tool"


class MessageType(Enum):
    TEXT = "text"
    THINKING = "thinking"
    TOOL_CALL = "tool_call"
    TOOL_RESULT = "tool_result"
    ERROR = "error"


@dataclass
class Usage:
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
    cached_tokens: int = 0


@dataclass
class Message:
    role: MessageRole
    content: str
    type: MessageType = MessageType.TEXT
    display: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
    usage: Usage | None = None
    tool_call_id: str | None = None
    tool_calls: list[dict[str, Any]] | None = None

    def to_dict(self) -> dict[str, Any]:
        # OpenAI convention: assistant messages carrying only tool_calls
        # should use `content: null` rather than an empty string; strict
        # validators reject empty-string content on tool-call-only turns.
        # Tool result messages (role "tool") must keep their string content
        # (even when empty) to satisfy the chat-message contract.
        if self.role == MessageRole.ASSISTANT and self.tool_calls:
            content = self.content if self.content else None
        else:
            content = self.content
        d: dict[str, Any] = {"role": self.role.value, "content": content}
        if self.tool_call_id:
            d["tool_call_id"] = self.tool_call_id
        if self.tool_calls:
            d["tool_calls"] = [copy.deepcopy(tc) for tc in self.tool_calls]
        return d

    def to_storage_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "role": self.role.value,
            "content": self.content,
            "type": self.type.value,
        }
        if self.display:
            d["display"] = self.display
        if self.metadata:
            d["metadata"] = self.metadata
        if self.usage:
            d["usage"] = {
                "prompt_tokens": self.usage.prompt_tokens,
                "completion_tokens": self.usage.completion_tokens,
                "total_tokens": self.usage.total_tokens,
                "cached_tokens": self.usage.cached_tokens,
            }
        if self.tool_call_id:
            d["tool_call_id"] = self.tool_call_id
        if self.tool_calls:
            d["tool_calls"] = [copy.deepcopy(tc) for tc in self.tool_calls]
        return d

    @classmethod
    def from_storage_dict(cls, data: dict[str, Any]) -> "Message":
        usage = None
        if "usage" in data and data["usage"] is not None:
            # Forward-compat: persisted usage may carry extra keys (e.g.
            # reasoning_tokens, prompt_tokens_details) from a newer writer
            # or a different provider, or be missing keys after partial
            # corruption. Explicitly extract the known fields with .get()
            # defaults so a drifted usage dict never raises TypeError and
            # aborts the whole session load (session.py:56/130).
            src = data["usage"]
            if not isinstance(src, dict):
                usage = Usage(prompt_tokens=0, completion_tokens=0, total_tokens=0)
            else:
                usage = Usage(
                    prompt_tokens=src.get("prompt_tokens", 0),
                    completion_tokens=src.get("completion_tokens", 0),
                    total_tokens=src.get("total_tokens", 0),
                    cached_tokens=src.get("cached_tokens", 0),
                )
        metadata = dict(data.get("metadata", {}))
        warnings: list[str] = []
        raw_role = data.get("role", "system")
        try:
            role = MessageRole(raw_role)
        except ValueError:
            role = MessageRole.SYSTEM
            warnings.append(f"unknown role '{raw_role}', falling back to system")
        raw_type = data.get("type", "text")
        try:
            msg_type = MessageType(raw_type)
        except ValueError:
            msg_type = MessageType.TEXT
            warnings.append(f"unknown type '{raw_type}', falling back to text")
        if warnings:
            metadata["_deserialize_warning"] = "; ".join(warnings)
        return cls(
            role=role,
            content=data.get("content", ""),
            type=msg_type,
            display=data.get("display"),
            metadata=metadata,
            usage=usage,
            tool_call_id=data.get("tool_call_id"),
            tool_calls=data.get("tool_calls"),
        )


@dataclass
class StreamHistoryState:
    """Tracks persisted messages while cumulative stream snapshots arrive."""
    thinking: Message | None = None
    content: Message | None = None


def record_streamed_message(history: list[Message], msg: Message, state: StreamHistoryState) -> bool:
    """Record a streamed message without persisting duplicate cumulative snapshots."""
    if msg.type == MessageType.THINKING:
        if state.thinking is None:
            history.append(msg)
            state.thinking = msg
            return True
        state.thinking.content = msg.content
        if msg.usage:
            state.thinking.usage = msg.usage
        return False

    if msg.type == MessageType.TOOL_CALL:
        return False

    if msg.type == MessageType.TOOL_RESULT:
        history.append(msg)
        state.thinking = None
        state.content = None
        return True

    if msg.role == MessageRole.USER:
        history.append(msg)
        state.thinking = None
        state.content = None
        return True

    if msg.role == MessageRole.SYSTEM:
        history.append(msg)
        state.thinking = None
        state.content = None
        return True

    if msg.type == MessageType.TEXT:
        appended = False
        if msg.content:
            if state.content is None:
                history.append(msg)
                state.content = msg
                appended = True
            else:
                state.content.content = msg.content
        # tool_calls can appear WITHOUT prior content (model calls a tool
        # immediately). In that case anchor a new empty assistant message
        # so the tool_calls block is persisted instead of silently dropped,
        # which would otherwise orphan the matching TOOL_RESULT on replay.
        if msg.tool_calls:
            if state.content is None:
                history.append(msg)
                state.content = msg
                appended = True
            state.content.tool_calls = msg.tool_calls
        if msg.usage and state.content:
            state.content.usage = msg.usage
        return appended

    history.append(msg)
    state.thinking = None
    state.content = None
    return True
