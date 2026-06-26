"""Tests for the four todo executors (P1-48 / U11)."""

from unittest.mock import AsyncMock

import pytest

from stupidex.domain.todo import TodoStatus, TodoStore, set_todo_store
from stupidex.domain.tool import ExecutorResult
from stupidex.tools.todo import (
    execute_todo_create,
    execute_todo_delete,
    execute_todo_list,
    execute_todo_update,
)


@pytest.fixture
def fresh_store():
    store = TodoStore()
    set_todo_store(store)
    return store


@pytest.fixture
def notify_mock(monkeypatch):
    mock = AsyncMock()
    monkeypatch.setattr("stupidex.tools.todo.notify_todo_changed", mock)
    return mock


@pytest.mark.asyncio
async def test_create_title_only(fresh_store, notify_mock):
    result = await execute_todo_create(title="Buy milk")

    assert isinstance(result, ExecutorResult)
    assert "Buy milk" in result.display
    assert "ID:" in result.content
    assert "Title: Buy milk" in result.content
    assert "Status: open" in result.content
    assert len(fresh_store.list()) == 1
    task = fresh_store.list()[0]
    assert task.title == "Buy milk"
    assert task.description == ""
    assert task.subagent_id == ""
    assert task.status is TodoStatus.OPEN
    notify_mock.assert_awaited_once()


@pytest.mark.asyncio
async def test_create_with_all_fields(fresh_store, notify_mock):
    result = await execute_todo_create(
        title="Ship feature",
        description="Cut a release",
        subagent_id="agent-7",
    )

    assert "Ship feature" in result.display
    task = fresh_store.list()[0]
    assert task.title == "Ship feature"
    assert task.description == "Cut a release"
    assert task.subagent_id == "agent-7"
    notify_mock.assert_awaited_once()


@pytest.mark.asyncio
async def test_create_description_none_coerced_to_empty(fresh_store, notify_mock):
    result = await execute_todo_create(title="T", description=None)

    assert result.content.startswith("Task created successfully.")
    task = fresh_store.list()[0]
    assert task.description == ""
    notify_mock.assert_awaited_once()


@pytest.mark.asyncio
async def test_update_invalid_status_returns_error(fresh_store, notify_mock):
    result = await execute_todo_update(task_id="whatever", status="invalid")

    assert result.display == "Invalid status"
    assert result.content.startswith("Error:")
    assert "invalid" in result.content
    assert "Valid statuses:" in result.content
    notify_mock.assert_not_awaited()


@pytest.mark.asyncio
async def test_update_title_only(fresh_store, notify_mock):
    task = fresh_store.create("orig")

    result = await execute_todo_update(task_id=task.id, title="new")

    assert result.display == f"Updated task {task.id}"
    assert "Title: new" in result.content
    assert "Status:" not in result.content
    assert task.title == "new"
    notify_mock.assert_awaited_once()


@pytest.mark.asyncio
async def test_update_status_only(fresh_store, notify_mock):
    task = fresh_store.create("t")
    assert task.status is TodoStatus.OPEN

    result = await execute_todo_update(task_id=task.id, status="in_progress")

    assert result.display == f"Updated task {task.id}"
    assert "Status: in_progress" in result.content
    assert task.status is TodoStatus.IN_PROGRESS
    notify_mock.assert_awaited_once()


@pytest.mark.asyncio
async def test_update_store_returns_error_propagates(fresh_store, notify_mock):
    result = await execute_todo_update(task_id="nonexistent", title="x")

    assert result.display == "Update failed"
    assert result.content == "Error: No task found with ID 'nonexistent'."
    notify_mock.assert_not_awaited()


@pytest.mark.asyncio
async def test_update_on_terminal_task_returns_error(notify_mock):
    store = TodoStore.from_storage_dict(
        {"tasks": [{"id": "t1", "title": "x", "status": "done"}]}
    )
    set_todo_store(store)

    result = await execute_todo_update(task_id="t1", title="new")

    assert result.display == "Update failed"
    assert "terminal status 'done'" in result.content
    assert "cannot be updated" in result.content
    notify_mock.assert_not_awaited()


@pytest.mark.asyncio
async def test_list_no_filter_returns_all(fresh_store, notify_mock):
    fresh_store.create("a")
    fresh_store.create("b")

    result = await execute_todo_list()

    assert result.display == "Found 2 task(s)"
    assert "Found 2 task(s)" in result.content
    assert result.content.count("Status: open") == 2
    notify_mock.assert_not_awaited()


@pytest.mark.asyncio
async def test_list_filter_by_status(fresh_store, notify_mock):
    a = fresh_store.create("a")
    b = fresh_store.create("b")
    fresh_store.update(b.id, status=TodoStatus.IN_PROGRESS)

    result = await execute_todo_list(status="open")

    assert result.display == "Found 1 task(s)"
    assert a.id in result.content
    assert b.id not in result.content
    notify_mock.assert_not_awaited()


@pytest.mark.asyncio
async def test_list_empty_result(fresh_store, notify_mock):
    result = await execute_todo_list(status="done")

    assert result.display == "No tasks found"
    assert result.content == "No tasks match the given filters."
    notify_mock.assert_not_awaited()


@pytest.mark.asyncio
async def test_list_invalid_status_returns_error(fresh_store, notify_mock):
    result = await execute_todo_list(status="bogus")

    assert result.display == "Invalid status"
    assert result.content.startswith("Error:")
    assert "bogus" in result.content
    notify_mock.assert_not_awaited()


@pytest.mark.asyncio
async def test_list_description_truncated_to_100_chars(fresh_store, notify_mock):
    long_desc = "x" * 200
    fresh_store.create("t", description=long_desc)

    result = await execute_todo_list()

    assert long_desc not in result.content
    assert ("Description: " + "x" * 100) in result.content
    notify_mock.assert_not_awaited()


@pytest.mark.asyncio
async def test_delete_existing_task(fresh_store, notify_mock):
    task = fresh_store.create("doomed")

    result = await execute_todo_delete(task_id=task.id)

    assert result.display == f"Deleted task: {task.title}"
    assert f"Task '{task.id}' ({task.title}) deleted successfully." == result.content
    assert fresh_store.get(task.id) is None
    notify_mock.assert_awaited_once()


@pytest.mark.asyncio
async def test_delete_nonexistent_returns_not_found(fresh_store, notify_mock):
    result = await execute_todo_delete(task_id="ghost")

    assert result.display == "Task not found"
    assert result.content == "Error: No task found with ID 'ghost'."
    notify_mock.assert_not_awaited()
