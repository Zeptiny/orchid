"""Tests for TodoStore state machine (P0-7)."""

import time

import pytest

from stupidex.domain import todo as todo_mod
from stupidex.domain.todo import (
    TERMINAL_STATUSES,
    TodoStatus,
    TodoStore,
    _current_store,
    get_todo_store,
    set_todo_store,
)


@pytest.fixture
def fresh_store():
    """Return a fresh TodoStore and install it on the ContextVar."""
    prior = _current_store.get()
    store = TodoStore()
    set_todo_store(store)
    yield store
    _current_store.set(prior)


def test_from_str_valid_statuses():
    """Every enum value lower-cased round-trips; case-insensitive via .lower()."""
    for status in TodoStatus:
        assert TodoStatus.from_str(status.value) is status
        # Case-insensitivity: uppercase input works too.
        assert TodoStatus.from_str(status.value.upper()) is status


def test_from_str_invalid_raises_valueerror():
    """Invalid string raises ValueError listing all valid statuses."""
    with pytest.raises(ValueError) as exc_info:
        TodoStatus.from_str("not-a-status")
    message = str(exc_info.value)
    assert "Invalid status: 'not-a-status'" in message
    # Every valid status is named in the message.
    for status in TodoStatus:
        assert status.value in message


def test_create_assigns_id_title_open_status_timestamps(fresh_store):
    """create() returns a TodoTask with 8-hex id, OPEN status, positive timestamps."""
    task = fresh_store.create("My task")
    assert task.title == "My task"
    assert len(task.id) == 8
    assert all(c in "0123456789abcdef" for c in task.id)
    assert task.status is TodoStatus.OPEN
    assert task.created_at > 0
    assert task.updated_at > 0
    assert task.created_at == pytest.approx(task.updated_at, rel=1e-6)


def test_create_with_description_and_subagent(fresh_store):
    """Optional description and subagent_id are persisted on the created task."""
    task = fresh_store.create(
        "T", description="desc", subagent_id="agent-1"
    )
    assert task.description == "desc"
    assert task.subagent_id == "agent-1"
    assert fresh_store.get(task.id) is task


def test_get_existing_and_missing(fresh_store):
    """get() returns the task by id; missing id returns None."""
    task = fresh_store.create("x")
    assert fresh_store.get(task.id) is task
    assert fresh_store.get("nope") is None


def test_list_unfiltered_returns_all(fresh_store):
    """list() with no filters returns every task in the store."""
    a = fresh_store.create("a")
    b = fresh_store.create("b")
    c = fresh_store.create("c")
    result = fresh_store.list()
    assert len(result) == 3
    ids = {t.id for t in result}
    assert ids == {a.id, b.id, c.id}


def test_list_filter_by_status(fresh_store):
    """list(status=OPEN) returns only OPEN tasks."""
    open_task = fresh_store.create("open")
    in_progress = fresh_store.create("ip")
    fresh_store.update(in_progress.id, status=TodoStatus.IN_PROGRESS)
    result = fresh_store.list(status=TodoStatus.OPEN)
    assert result == [open_task]


def test_list_filter_by_subagent_id(fresh_store):
    """list(subagent_id=...) returns only matching tasks."""
    a = fresh_store.create("a", subagent_id="alpha")
    b = fresh_store.create("b", subagent_id="beta")
    c = fresh_store.create("c", subagent_id="beta")
    result_alpha = fresh_store.list(subagent_id="alpha")
    assert result_alpha == [a]
    result_beta = fresh_store.list(subagent_id="beta")
    assert {t.id for t in result_beta} == {b.id, c.id}


def test_update_title_description_subagent(fresh_store):
    """Non-status fields update and updated_at strictly increases."""
    task = fresh_store.create("orig")
    old_updated = task.updated_at
    time.sleep(0.01)
    updated_task, err = fresh_store.update(
        task.id, title="new", description="d", subagent_id="sa"
    )
    assert err is None
    assert updated_task is task
    assert task.title == "new"
    assert task.description == "d"
    assert task.subagent_id == "sa"
    assert task.updated_at > old_updated


def test_update_status_valid_transition(fresh_store):
    """OPEN -> IN_PROGRESS is allowed; returns (task, None)."""
    task = fresh_store.create("t")
    updated, err = fresh_store.update(task.id, status=TodoStatus.IN_PROGRESS)
    assert err is None
    assert updated is task
    assert task.status is TodoStatus.IN_PROGRESS


def test_update_status_invalid_transition_returns_error(fresh_store):
    """OPEN -> DONE is invalid; returns (None, error) and leaves state unchanged."""
    task = fresh_store.create("t")
    updated, err = fresh_store.update(task.id, status=TodoStatus.DONE)
    assert updated is None
    assert err is not None
    assert err.startswith("Cannot transition from 'open' to 'done'")
    assert "Allowed:" in err
    # State is unchanged.
    assert task.status is TodoStatus.OPEN


@pytest.mark.parametrize("terminal", sorted(TERMINAL_STATUSES, key=lambda s: s.value))
def test_update_terminal_status_rejected(fresh_store, terminal):
    """Any update to a terminal-status task is rejected with the proper error."""
    # Build a task already in the terminal status via storage round-trip.
    store = TodoStore()
    seeded = TodoStore.from_storage_dict(
        {"tasks": [{"id": "t1", "title": "x", "status": terminal.value}]}
    )
    store._tasks.update(seeded._tasks)
    task = store.get("t1")
    assert task is not None
    assert task.status is terminal

    updated, err = store.update(task.id, title="new")
    assert updated is None
    assert err is not None
    assert err.startswith(f"Task 't1' is in terminal status '{terminal.value}'")
    assert "cannot be updated" in err
    # State unchanged.
    assert task.title == "x"
    assert task.status is terminal


def test_update_missing_task_returns_notfound_error(fresh_store):
    """update() on an unknown id returns the not-found error tuple."""
    updated, err = fresh_store.update("z", title="x")
    assert updated is None
    assert err == "No task found with ID 'z'."


def test_delete_existing_and_missing(fresh_store):
    """delete() removes and returns the task; missing id returns None."""
    task = fresh_store.create("t")
    deleted = fresh_store.delete(task.id)
    assert deleted is task
    assert fresh_store.get(task.id) is None
    assert fresh_store.delete(task.id) is None


def test_storage_roundtrip_preserves_all_fields():
    """to_storage_dict -> from_storage_dict preserves all task fields."""
    store = TodoStore()
    a = store.create("alpha", description="d1", subagent_id="sa")
    store.update(a.id, status=TodoStatus.IN_PROGRESS)
    b = store.create("beta")
    store.update(b.id, status=TodoStatus.ABANDONED)
    c = store.create("gamma", description="d3", subagent_id="sb")
    store.update(c.id, status=TodoStatus.NEEDS_REVIEW)
    store.update(c.id, status=TodoStatus.UNDER_REVIEW)
    store.update(c.id, status=TodoStatus.DONE)

    data = store.to_storage_dict()
    restored = TodoStore.from_storage_dict(data)

    assert len(restored.list()) == 3
    for original in store.list():
        got = restored.get(original.id)
        assert got is not None
        assert got.id == original.id
        assert got.title == original.title
        assert got.description == original.description
        assert got.status is original.status
        assert got.subagent_id == original.subagent_id
        assert got.created_at == original.created_at
        assert got.updated_at == original.updated_at


def test_from_storage_dict_empty_and_missing_tasks_key():
    """Both empty dict and explicit empty tasks list yield an empty store."""
    assert len(TodoStore.from_storage_dict({}).list()) == 0
    assert len(TodoStore.from_storage_dict({"tasks": []}).list()) == 0


def test_from_storage_dict_status_fallback_default_open():
    """A task dict without 'status' defaults to OPEN."""
    store = TodoStore.from_storage_dict(
        {"tasks": [{"id": "x1", "title": "t"}]}
    )
    task = store.get("x1")
    assert task is not None
    assert task.status is TodoStatus.OPEN
    # Other optional fields default appropriately.
    assert task.description == ""
    assert task.subagent_id == ""
    assert task.created_at == 0.0
    assert task.updated_at == 0.0


def test_get_todo_store_lazy_init_and_set_todo_store():
    """get_todo_store() lazily creates and caches; set_todo_store() overrides."""
    # Capture prior state and reset to None to exercise the lazy-init path.
    prior = _current_store.get()
    token = _current_store.set(None)
    try:
        first = get_todo_store()  # lazy init: store was None -> creates new
        second = get_todo_store()
        assert first is second  # cached.

        replacement = TodoStore()
        set_todo_store(replacement)
        assert get_todo_store() is replacement
    finally:
        _current_store.reset(token)
        assert _current_store.get() is prior


# ---------------------------------------------------------------------------
# P1-25: ID-collision avoidance in TodoStore.create
# ---------------------------------------------------------------------------


class _FakeUUID:
    """Stand-in for uuid.UUID exposing only the .hex attribute the code reads."""

    def __init__(self, hex_value: str) -> None:
        self.hex = hex_value


def test_create_does_not_silently_overwrite_on_id_collision(monkeypatch, fresh_store):
    """On a single ID collision, create() retries and must not destroy the prior task."""
    first = fresh_store.create("keep-me")

    # Force uuid4 to return the same id once, then a fresh different one.
    fresh_hex = "deadbeef"
    if fresh_hex == first.id:
        fresh_hex = "cafef00d"
    seq = iter([first.id, fresh_hex])
    monkeypatch.setattr(
        todo_mod.uuid,
        "uuid4",
        lambda: _FakeUUID(next(seq)),
    )

    second = fresh_store.create("new-task")

    assert second.id == fresh_hex
    # The original task is untouched.
    assert fresh_store.get(first.id) is first
    assert first.title == "keep-me"
    assert len(fresh_store.list()) == 2


def test_create_retries_across_multiple_collisions(monkeypatch, fresh_store):
    """create() keeps retrying across multiple consecutive collisions."""
    # Seed the store with a few tasks to collide against.
    existing_ids = {t.id for t in (fresh_store.create(f"seed-{i}") for i in range(3))}
    # Cycle through existing ids, then finally yield a fresh one.
    fresh_hex = "fffffffe"
    while fresh_hex in existing_ids:
        fresh_hex = "fffffffd"
    seq = iter(list(existing_ids) + [fresh_hex])
    monkeypatch.setattr(
        todo_mod.uuid,
        "uuid4",
        lambda: _FakeUUID(next(seq)),
    )

    task = fresh_store.create("after-collisions")
    assert task.id == fresh_hex
    assert task.title == "after-collisions"
    assert len(fresh_store.list()) == 4


def test_create_raises_when_all_retries_collide(monkeypatch, fresh_store):
    """If every retry collides, create() raises RuntimeError instead of overwriting."""
    existing = fresh_store.create("first")
    # Always return the same id → guaranteed to exhaust the retry budget.
    monkeypatch.setattr(
        todo_mod.uuid,
        "uuid4",
        lambda: _FakeUUID(existing.id),
    )

    with pytest.raises(RuntimeError, match="unique todo ID"):
        fresh_store.create("doomed")

    # State untouched — no silent overwrite, no partial task added.
    assert len(fresh_store.list()) == 1
    assert fresh_store.get(existing.id) is existing
    assert existing.title == "first"


def test_create_id_still_8_hex_after_retry(monkeypatch, fresh_store):
    """The retry path preserves the 8-hex length contract from the happy path."""
    colliding = fresh_store.create("seed").id
    fresh_hex = "abcdef12"
    seq = iter([colliding, fresh_hex])
    monkeypatch.setattr(
        todo_mod.uuid,
        "uuid4",
        lambda: _FakeUUID(next(seq)),
    )
    task = fresh_store.create("retry-survivor")
    assert len(task.id) == 8
    assert all(c in "0123456789abcdef" for c in task.id)
    assert task.id == fresh_hex
