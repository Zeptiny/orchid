from __future__ import annotations

import time
import uuid
from collections.abc import Callable, Coroutine
from contextvars import ContextVar
from dataclasses import dataclass
from enum import Enum
from typing import Any


class TodoStatus(Enum):
    OPEN = "open"
    IN_PROGRESS = "in_progress"
    BLOCKED = "blocked"
    DONE = "done"
    ABANDONED = "abandoned"
    NEEDS_REVIEW = "needs_review"
    UNDER_REVIEW = "under_review"

    @classmethod
    def from_str(cls, value: str) -> TodoStatus:
        _map = {s.value: s for s in cls}
        result = _map.get(value.lower())
        if result is None:
            valid = ", ".join(s.value for s in cls)
            raise ValueError(f"Invalid status: '{value}'. Valid statuses: {valid}")
        return result


TERMINAL_STATUSES: set[TodoStatus] = {TodoStatus.DONE, TodoStatus.ABANDONED}

# Retry budget for ID-collision avoidance in TodoStore.create. Each attempt
# has per-attempt collision probability ~k/4.3e9 with k existing tasks; 8
# independent retries multiply failure probability by (k/4.3e9)^8,which is
# effectively zero for any realistic k (<10^6). Bounds worst-case latency
# while making the silent-overwrite failure mode impossible-by-construction.
_MAX_ID_RETRIES = 8

VALID_TRANSITIONS: dict[TodoStatus, set[TodoStatus]] = {
    TodoStatus.OPEN: {TodoStatus.IN_PROGRESS, TodoStatus.ABANDONED},
    TodoStatus.IN_PROGRESS: {TodoStatus.BLOCKED, TodoStatus.DONE, TodoStatus.NEEDS_REVIEW, TodoStatus.ABANDONED},
    TodoStatus.BLOCKED: {TodoStatus.IN_PROGRESS, TodoStatus.ABANDONED},
    TodoStatus.NEEDS_REVIEW: {TodoStatus.UNDER_REVIEW, TodoStatus.IN_PROGRESS},
    TodoStatus.UNDER_REVIEW: {TodoStatus.DONE, TodoStatus.IN_PROGRESS},
}


@dataclass
class TodoTask:
    id: str
    title: str
    description: str = ""
    status: TodoStatus = TodoStatus.OPEN
    subagent_id: str = ""
    created_at: float = 0.0
    updated_at: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "description": self.description,
            "status": self.status.value,
            "subagent_id": self.subagent_id,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


class TodoStore:
    def __init__(self) -> None:
        self._tasks: dict[str, TodoTask] = {}

    def create(
        self,
        title: str,
        description: str = "",
        subagent_id: str = "",
    ) -> TodoTask:
        now = time.time()
        # 8-hex IDs give 32 bits of entropy (4.3e9 space). Collisions are
        # astronomically unlikely per-session but would silently overwrite the
        # prior task via dict assignment. Retry a handful of times and raise
        # loudly if we can't get a fresh ID, rather than corrupting state.
        for _ in range(_MAX_ID_RETRIES):
            candidate = uuid.uuid4().hex[:8]
            if candidate not in self._tasks:
                task = TodoTask(
                    id=candidate,
                    title=title,
                    description=description,
                    status=TodoStatus.OPEN,
                    subagent_id=subagent_id,
                    created_at=now,
                    updated_at=now,
                )
                self._tasks[task.id] = task
                return task
        raise RuntimeError(
            "Failed to generate a unique todo ID after "
            f"{_MAX_ID_RETRIES} attempts (store has {len(self._tasks)} tasks)"
        )

    def get(self, task_id: str) -> TodoTask | None:
        return self._tasks.get(task_id)

    def list(
        self,
        status: TodoStatus | None = None,
        subagent_id: str | None = None,
    ) -> list[TodoTask]:
        tasks = list(self._tasks.values())
        if status is not None:
            tasks = [t for t in tasks if t.status == status]
        if subagent_id is not None:
            tasks = [t for t in tasks if t.subagent_id == subagent_id]
        return tasks

    def update(
        self,
        task_id: str,
        *,
        title: str | None = None,
        description: str | None = None,
        status: TodoStatus | None = None,
        subagent_id: str | None = None,
    ) -> tuple[TodoTask | None, str | None]:
        """Update a task. Returns (task, error). On success error is None."""
        task = self._tasks.get(task_id)
        if task is None:
            return None, f"No task found with ID '{task_id}'."

        if task.status in TERMINAL_STATUSES:
            return None, f"Task '{task_id}' is in terminal status '{task.status.value}' and cannot be updated."

        if status is not None:
            allowed = VALID_TRANSITIONS.get(task.status, set())
            if status not in allowed:
                targets = ", ".join(s.value for s in sorted(allowed, key=lambda s: s.value))
                return None, f"Cannot transition from '{task.status.value}' to '{status.value}'. Allowed: {targets or 'none'}"
            task.status = status

        if title is not None:
            task.title = title
        if description is not None:
            task.description = description
        if subagent_id is not None:
            task.subagent_id = subagent_id

        task.updated_at = time.time()
        return task, None

    def delete(self, task_id: str) -> TodoTask | None:
        return self._tasks.pop(task_id, None)

    def to_storage_dict(self) -> dict[str, Any]:
        return {"tasks": [t.to_dict() for t in self._tasks.values()]}

    @classmethod
    def from_storage_dict(cls, data: dict[str, Any]) -> TodoStore:
        store = cls()
        for td in data.get("tasks", []):
            task = TodoTask(
                id=td["id"],
                title=td["title"],
                description=td.get("description", ""),
                status=TodoStatus.from_str(td.get("status", "open")),
                subagent_id=td.get("subagent_id", ""),
                created_at=td.get("created_at", 0.0),
                updated_at=td.get("updated_at", 0.0),
            )
            store._tasks[task.id] = task
        return store


_current_store: ContextVar[TodoStore | None] = ContextVar("current_store", default=None)


def get_todo_store() -> TodoStore:
    store = _current_store.get()
    if store is None:
        store = TodoStore()
        _current_store.set(store)
    return store


def set_todo_store(store: TodoStore) -> None:
    _current_store.set(store)


_todo_refresh_callback: Callable[[], Coroutine[Any, Any, None]] | None = None


def set_todo_refresh_callback(cb: Callable[[], Coroutine[Any, Any, None]]) -> None:
    global _todo_refresh_callback
    _todo_refresh_callback = cb


async def notify_todo_changed() -> None:
    if _todo_refresh_callback:
        await _todo_refresh_callback()
