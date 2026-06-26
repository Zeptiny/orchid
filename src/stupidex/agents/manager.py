from __future__ import annotations

import asyncio
import logging
import time
import uuid
from collections.abc import Callable, Coroutine
from contextvars import ContextVar
from dataclasses import dataclass, field
from enum import Enum
from typing import TYPE_CHECKING, Any
from xml.sax.saxutils import escape

from stupidex.domain.agent import Agent
from stupidex.domain.chain import Chain, ChainStatus

if TYPE_CHECKING:
    from stupidex.domain.message import Message

log = logging.getLogger(__name__)

_current_manager: ContextVar[SubagentManager] = ContextVar('current_manager')

_current_chain_index: ContextVar[int | None] = ContextVar(
    'current_chain_index', default=None
)


def get_current_chain_index() -> int | None:
    return _current_chain_index.get()


def set_current_chain_index(index: int | None) -> None:
    _current_chain_index.set(index)


def _log_task_exception(task: asyncio.Task) -> None:
    if task.cancelled():
        return
    exc = task.exception()
    if exc is not None:
        log.error("Unhandled exception in background task: %s", exc, exc_info=exc)


def _fire_and_forget(coro: Coroutine) -> asyncio.Task:
    task = asyncio.create_task(coro)
    task.add_done_callback(_log_task_exception)
    return task


def get_subagent_manager() -> SubagentManager:
    return _current_manager.get()


def set_subagent_manager(manager: SubagentManager) -> None:
    _current_manager.set(manager)


class SubagentState(Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    INTERRUPTED = "interrupted"


SUBAGENT_INDICATORS: dict[SubagentState, str] = {
    SubagentState.PENDING: "◌",
    SubagentState.RUNNING: "●",
    SubagentState.COMPLETED: "✓",
    SubagentState.FAILED: "✗",
    SubagentState.INTERRUPTED: "⊘",
}


_TERMINAL_STATE_TO_CHAIN_STATUS: dict[SubagentState, ChainStatus] = {
    SubagentState.COMPLETED: ChainStatus.COMPLETED,
    SubagentState.FAILED: ChainStatus.FAILED,
    SubagentState.INTERRUPTED: ChainStatus.INTERRUPTED,
}


TERMINAL: set[SubagentState] = {
    SubagentState.COMPLETED,
    SubagentState.FAILED,
    SubagentState.INTERRUPTED,
}


def _attr_escape(s: str) -> str:
    return escape(s, entities={'"': '&quot;'})


def format_subagent_attrs(
    id: str, name: str, type: str, state: str, elapsed: float | None = None
) -> str:
    """Build XML attribute string for subagent elements."""
    e = _attr_escape
    attrs = f'id="{e(id)}" name="{e(name)}" type="{e(type)}" state="{e(state)}"'
    if elapsed is not None:
        attrs += f' elapsed="{elapsed}s"'
    return attrs


@dataclass
class SubagentRecord:
    id: str
    agent: Agent
    state: SubagentState
    label: str = ""
    task: str = ""
    async_task: asyncio.Task | None = None
    result: str | None = None
    error: str | None = None
    start_time: float = 0.0
    end_time: float | None = None
    chain: Chain = field(default_factory=Chain)
    model: str | None = None
    parent_chain_index: int | None = None
    messages_mounted: int = 0
    on_message: Callable[[Message], Coroutine[Any, Any, None]] | None = None
    on_state_change: Callable[[SubagentState],
                              Coroutine[Any, Any, None]] | None = None

    @property
    def messages(self) -> list[Message]:
        """Back-compat accessor delegating to ``chain.messages``.

        Callers that read or append via ``record.messages`` continue to work
        because this returns the underlying list reference.
        """
        return self.chain.messages

    def finalize_chain_on_restore(self) -> None:
        """Reconcile the composed chain's status with this record's terminal
        state after loading from storage.

        Live chains are finished inside ``SubagentManager._run``'s ``finally``,
        but restored records never re-run, so a chain persisted while still
        ``RUNNING`` (legacy flat-``messages`` fallback, or a crash mid-run)
        reaches restore still running while the record's state is terminal.

        A restored chain's ``start_time`` belongs to the prior process, so
        ``finish()`` — which sets ``end_time`` to the *current* process's
        ``time.monotonic()`` — would make ``elapsed`` nonsensical. When the
        chain already carries a persisted ``end_time``, set ``status`` directly
        instead, preserving the recorded duration.
        """
        if self.chain.status != ChainStatus.RUNNING:
            return
        target = _TERMINAL_STATE_TO_CHAIN_STATUS.get(self.state)
        if target is None:
            return
        if self.chain.end_time is not None:
            self.chain.status = target
        else:
            self.chain.finish(target)

    @property
    def name(self) -> str:
        return self.agent.name

    @property
    def type(self) -> str:
        return self.agent.type.value

    @property
    def elapsed_seconds(self) -> float | None:
        if self.end_time:
            return round(self.end_time - self.start_time, 1)
        elif self.start_time:
            return round(time.time() - self.start_time, 1)
        return None

    def to_storage_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "agent_name": self.name,
            "agent_type": self.type,
            "state": self.state.value,
            "label": self.label,
            "task": self.task,
            "result": self.result,
            "error": self.error,
            "start_time": self.start_time,
            "end_time": self.end_time,
            "chain": self.chain.to_storage_dict(),
            "model": self.model,
            "parent_chain_index": self.parent_chain_index,
            "messages_mounted": self.messages_mounted,
        }

    @classmethod
    def from_storage_dict(cls, data: dict[str, Any]) -> SubagentRecord:
        agent_name = data.get("agent_name", "")
        agent_type = data.get("agent_type", "Subagent")
        agent = _restore_agent(agent_name, agent_type)

        state = SubagentState(data.get("state", "completed"))
        migrated_to_interrupted = state in (SubagentState.PENDING, SubagentState.RUNNING)
        if migrated_to_interrupted:
            state = SubagentState.INTERRUPTED

        now = time.time()
        start_time = data.get("start_time", 0.0)
        end_time = data.get("end_time")
        if (migrated_to_interrupted or state == SubagentState.INTERRUPTED) and end_time is None:
            end_time = now
            if not start_time:
                start_time = end_time

        # Build the chain via Chain.from_storage_dict, which performs the
        # orphan-tool-result reconciliation once (R9). Old records persisted
        # a flat `messages` list rather than a nested `chain` dict; fall back
        # to that shape so legacy sessions keep loading.
        chain_data = data.get("chain")
        if isinstance(chain_data, dict):
            chain = Chain.from_storage_dict(chain_data)
        else:
            chain = Chain.from_storage_dict(
                {"messages": data.get("messages", [])}
            )

        # The persisted model may live on the record or inside the chain
        # dict; prefer the top-level field, then sync onto the chain.
        model = data.get("model") or chain.model
        if chain.model is None:
            chain.model = model

        record = cls(
            id=data["id"],
            agent=agent,
            state=state,
            label=data.get("label", ""),
            task=data.get("task", ""),
            result=data.get("result"),
            error=data.get("error"),
            start_time=start_time,
            end_time=end_time,
            chain=chain,
            model=model,
            parent_chain_index=data.get("parent_chain_index"),
            messages_mounted=data.get("messages_mounted", 0),
        )
        record.finalize_chain_on_restore()
        return record


def _restore_agent(name: str, type_str: str) -> Agent:
    from stupidex.agents import get_agent_registry
    from stupidex.domain.agent import Agent, AgentTypes, ModelTier

    try:
        registry = get_agent_registry()
        agent = registry.get(name)
        if agent is not None:
            return agent
    except Exception as exc:
        log.warning(
            "SubagentRecord restore: registry unavailable for %r: %s",
            name,
            exc,
        )

    try:
        agent_type = AgentTypes.from_str(type_str)
    except ValueError:
        log.warning(
            "SubagentRecord restore: unknown agent_type %r for %r; "
            "falling back to AgentTypes.SUBAGENT",
            type_str,
            name,
        )
        agent_type = AgentTypes.SUBAGENT

    return Agent(
        name=name,
        type=agent_type,
        tier=ModelTier.PAPUDO,
        description="Restored from storage",
        system_prompt="",
    )


class SubagentManager:
    def __init__(self) -> None:
        self._subagents: dict[str, SubagentRecord] = {}
        self.on_spawn: Callable[[SubagentRecord],
                                Coroutine[Any, Any, None]] | None = None
        self._pending_callback_tasks: set[asyncio.Task] = set()

    def _fire_and_forget(self, coro: Coroutine) -> asyncio.Task:
        task = asyncio.create_task(coro)
        self._pending_callback_tasks.add(task)
        task.add_done_callback(_log_task_exception)
        task.add_done_callback(self._pending_callback_tasks.discard)
        return task

    async def flush_state_callbacks(self) -> None:
        if not self._pending_callback_tasks:
            return
        pending = list(self._pending_callback_tasks)
        await asyncio.gather(*pending, return_exceptions=True)
        self._pending_callback_tasks.difference_update(pending)

    def _cancel_record(self, record: SubagentRecord) -> bool:
        if record.state in TERMINAL:
            return False
        record.state = SubagentState.INTERRUPTED
        record.error = record.error or "Interrupted by user"
        record.end_time = record.end_time or time.time()
        task = record.async_task
        if task is not None and not task.done():
            task.cancel()
        if record.on_state_change:
            self._fire_and_forget(record.on_state_change(record.state))
        return True

    def cancel_one(self, subagent_id: str) -> bool:
        """Cancel a single subagent by ID. Returns True if cancelled."""
        record = self._subagents.get(subagent_id)
        if record is None:
            return False
        return self._cancel_record(record)

    def cancel_all(self) -> list[str]:
        """Cancel all running subagents. Returns list of cancelled IDs."""
        cancelled = []
        for record in self._subagents.values():
            if self._cancel_record(record):
                cancelled.append(record.id)
        self.on_spawn = None
        return cancelled

    def cancel_running(self) -> list[str]:
        """Cancel all non-terminal subagents. Returns list of cancelled IDs."""
        cancelled = []
        for record in self._subagents.values():
            if record.state in TERMINAL:
                continue
            if self._cancel_record(record):
                cancelled.append(record.id)
        return cancelled

    async def spawn(self, name: str, task: str, agent_type: str, model: str | None = None, parent_chain_index: int | None = None) -> SubagentRecord:
        """Spawn a subagent as an asyncio task. Returns the record immediately."""
        # Lazy imports to avoid circular dependency
        from stupidex.agents import get_agent_registry
        from stupidex.domain.message import (
            Message,
            MessageRole,
            MessageType,
            StreamHistoryState,
            record_streamed_message,
        )
        from stupidex.llm.client import stream_response

        registry = get_agent_registry()
        if agent_type not in registry:
            raise ValueError(
                f"Unknown agent type: {agent_type}. Available: {', '.join(registry.keys())}"
            )

        agent = registry[agent_type]
        subagent_id = uuid.uuid4().hex[:12]

        record = SubagentRecord(
            id=subagent_id,
            agent=agent,
            state=SubagentState.PENDING,
            label=name,
            task=task,
            start_time=time.time(),
        )
        record.chain.model = model
        record.model = model
        record.parent_chain_index = (
            parent_chain_index
            if parent_chain_index is not None
            else _current_chain_index.get()
        )
        self._subagents[subagent_id] = record

        async def _run() -> None:
            record.state = SubagentState.RUNNING
            if record.on_state_change:
                self._fire_and_forget(record.on_state_change(record.state))
            try:
                user_msg = Message(role=MessageRole.USER, content=task)
                subagent_messages = [user_msg]
                history_state = StreamHistoryState()
                record.messages.append(user_msg)
                if record.on_message:
                    record.messages_mounted += 1
                    try:
                        await record.on_message(user_msg)
                    except Exception:
                        pass
                async for msg in stream_response(
                    subagent_messages,
                    model=model,
                    allowed_tools=agent.allowed_tools,
                    system_prompt=agent.system_prompt,
                    allowed_skills=agent.allowed_skills,
                ):
                    appended = record_streamed_message(record.messages, msg, history_state)
                    if record.on_message:
                        if appended:
                            record.messages_mounted += 1
                        try:
                            await record.on_message(msg)
                        except Exception:
                            pass
                    if msg.type == MessageType.TEXT and msg.content:
                        record.result = msg.content

                record.state = SubagentState.COMPLETED
            except asyncio.CancelledError:
                record.error = "Interrupted by user"
                record.state = SubagentState.INTERRUPTED
                raise
            except Exception as e:
                record.error = str(e)
                record.state = SubagentState.FAILED
            finally:
                record.end_time = time.time()
                chain_status = _TERMINAL_STATE_TO_CHAIN_STATUS.get(record.state)
                if chain_status is not None:
                    record.chain.finish(chain_status)
                if record.on_state_change:
                    self._fire_and_forget(record.on_state_change(record.state))

        record.async_task = None  # set below
        if self.on_spawn:
            self._fire_and_forget(self.on_spawn(record))
        record.async_task = asyncio.create_task(_run())
        return record

    async def wait(self, ids: list[str]) -> dict[str, SubagentRecord]:
        """Wait for all specified subagents to complete. Returns their records."""
        tasks = []
        for sid in ids:
            record = self._subagents.get(sid)
            if record and record.async_task and not record.async_task.done():
                tasks.append(record.async_task)

        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

        return {sid: self._subagents[sid] for sid in ids if sid in self._subagents}

    def get_states(self) -> list[dict]:
        """Return state info for all tracked subagents."""
        states = []
        for record in self._subagents.values():
            states.append({
                "id": record.id,
                "name": record.name,
                "type": record.type,
                "task": record.task,
                "state": record.state.value,
                "elapsed": record.elapsed_seconds,
            })
        return states

    def get_record(self, subagent_id: str) -> SubagentRecord | None:
        """Look up a single subagent record by ID."""
        return self._subagents.get(subagent_id)

    def all_records(self) -> list[SubagentRecord]:
        """Return all subagent records."""
        return list(self._subagents.values())
