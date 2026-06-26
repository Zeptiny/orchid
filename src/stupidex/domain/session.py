import logging
import uuid
from contextvars import ContextVar
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from stupidex.agents.manager import SubagentManager, SubagentRecord
from stupidex.config import get_config
from stupidex.domain.chain import Chain
from stupidex.domain.message import Message
from stupidex.domain.todo import TodoStore, set_todo_store

log = logging.getLogger(__name__)

_current_session_id: ContextVar[str | None] = ContextVar("current_session_id", default=None)


def get_current_session_id() -> str | None:
    return _current_session_id.get()


def set_current_session_id(session_id: str | None) -> None:
    _current_session_id.set(session_id)


@dataclass
class Session:
    name: str
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    chains: list[Chain] = field(default_factory=list)
    model: str | None = None
    subagent_manager: SubagentManager = field(default_factory=SubagentManager)
    todo_store: TodoStore = field(default_factory=TodoStore)

    @property
    def messages(self) -> list[Message]:
        return [msg for chain in self.chains for msg in chain.messages]

    def to_storage_dict(self) -> dict[str, Any]:
        subagent_records = []
        for record in self.subagent_manager.all_records():
            subagent_records.append(record.to_storage_dict())
        return {
            "version": 1,
            "id": self.id,
            "name": self.name,
            "model": self.model,
            "chains": [c.to_storage_dict() for c in self.chains],
            "subagent_chains": subagent_records,
            "todo_store": self.todo_store.to_storage_dict(),
        }

    @classmethod
    def from_storage_dict(cls, data: dict[str, Any]) -> "Session":
        chains: list[Chain] = []
        for i, c in enumerate(data.get("chains", [])):
            try:
                chains.append(Chain.from_storage_dict(c))
            except Exception:
                log.warning("Failed to restore chain at index %d", i, exc_info=True)
        todo_store = TodoStore.from_storage_dict(data.get("todo_store", {}))
        session = cls(
            id=data["id"],
            name=data["name"],
            model=data.get("model"),
            chains=chains,
            todo_store=todo_store,
        )
        for sd in data.get("subagent_chains", []):
            try:
                record = SubagentRecord.from_storage_dict(sd)
                session.subagent_manager._subagents[record.id] = record
            except Exception:
                log.warning("Failed to restore subagent record %s", sd, exc_info=True)
        return session


class SessionManager:
    def __init__(self) -> None:
        self.sessions: dict[str, Session] = {}
        self.active: Session | None = None

    @staticmethod
    def _bind_context(session: Session) -> None:
        """Rebind the session-scoped ContextVars to `session`.

        Centralizes the invariant (previously duplicated across app.on_mount,
        /new, /sessions, /delete) so future transition sites cannot forget to
        rebind. Both vars are paired in every existing caller — binding them
        together here keeps them coherent.
        """
        set_todo_store(session.todo_store)
        set_current_session_id(session.id)

    def create(self) -> Session:
        cfg = get_config()
        session = Session(
            name=datetime.now().strftime("Session %Y-%m-%d %H:%M:%S"),
            model=cfg.default_model,
        )
        self.sessions[session.id] = session
        self.active = session
        self._bind_context(session)
        return session

    def switch(self, id: str) -> Session | None:
        if id in self.sessions:
            self.active = self.sessions[id]
            self._bind_context(self.active)
            return self.active
        return None

    def delete(self, id: str) -> bool:
        if id not in self.sessions:
            return False
        session = self.sessions[id]
        session.subagent_manager.cancel_all()
        from stupidex.storage import delete_session
        try:
            delete_session(id)
        except Exception:
            log.warning("Failed to delete session %s from disk", id, exc_info=True)
            return False
        del self.sessions[id]
        if self.active is not None and self.active.id == id:
            self.active = None
        return True

    def change_model(self, model_id: str) -> None:
        if self.active:
            self.active.model = model_id

    def save(self, session: Session) -> None:
        """Persist a specific session to disk."""
        from stupidex.storage import save_session
        save_session(session.to_storage_dict())

    def save_active(self) -> None:
        """Persist the active session to disk."""
        if not self.active:
            return
        self.save(self.active)

    def load(self, session_id: str) -> Session | None:
        """Load a session from disk into memory and set it active."""
        from stupidex.storage import load_session
        data = load_session(session_id)
        if data is None:
            return None
        try:
            session = Session.from_storage_dict(data)
        except Exception:
            log.warning("Failed to deserialize session %s", session_id, exc_info=True)
            return None
        self.sessions[session.id] = session
        self.active = session
        self._bind_context(session)
        return session

    def list_saved(self) -> list[dict]:
        """List all saved sessions from disk."""
        from stupidex.storage import list_saved_sessions
        return list_saved_sessions()
