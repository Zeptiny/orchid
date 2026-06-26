"""Tests for build_dynamic_system_prompt (U6, P1-34)."""
from unittest.mock import MagicMock, patch

import pytest

from stupidex.domain.todo import TodoStatus, TodoTask
from stupidex.llm import dynamic_system_prompt as dsp


@pytest.fixture(autouse=True)
def _reset_tree_cache():
    dsp._TREE_CACHE = None
    yield
    dsp._TREE_CACHE = None


def _patch_deps(states=None, todos=None, tree="TREE"):
    cfg = MagicMock()
    cfg.directory_tree_depth = 2
    sub_mgr = MagicMock()
    sub_mgr.get_states.return_value = states if states is not None else []
    store = MagicMock()
    store.list.return_value = todos if todos is not None else []
    return {
        "get_config": patch("stupidex.llm.dynamic_system_prompt.get_config", return_value=cfg),
        "directory_tree": patch("stupidex.llm.dynamic_system_prompt.directory_tree", return_value=tree),
        "get_subagent_manager": patch("stupidex.llm.dynamic_system_prompt.get_subagent_manager", return_value=sub_mgr),
        "get_todo_store": patch("stupidex.llm.dynamic_system_prompt.get_todo_store", return_value=store),
    }


@pytest.mark.asyncio
async def test_no_subagents_no_todos_omits_blocks():
    patches = _patch_deps()
    with patches["get_config"], patches["directory_tree"], patches["get_subagent_manager"], patches["get_todo_store"]:
        msg = await dsp.build_dynamic_system_prompt()
    c = msg.content
    assert "<current_time>" in c
    assert "<working_directory>" in c
    assert "<directory_structure>" in c
    assert "<subagents>" not in c
    assert "<todos>" not in c


@pytest.mark.asyncio
async def test_subagents_with_task_includes_task_block():
    states = [{"id": "s1", "name": "n", "type": "t", "state": "RUNNING", "elapsed": 1.5, "task": "do thing"}]
    patches = _patch_deps(states=states)
    with patches["get_config"], patches["directory_tree"], patches["get_subagent_manager"], patches["get_todo_store"]:
        msg = await dsp.build_dynamic_system_prompt()
    c = msg.content
    assert "<subagents>" in c
    assert "<subagent " in c
    assert "<task>\ndo thing\n</task>" in c


@pytest.mark.asyncio
async def test_subagents_without_task_omits_task_block():
    states = [{"id": "s1", "name": "n", "type": "t", "state": "RUNNING", "elapsed": 1.5, "task": None}]
    patches = _patch_deps(states=states)
    with patches["get_config"], patches["directory_tree"], patches["get_subagent_manager"], patches["get_todo_store"]:
        msg = await dsp.build_dynamic_system_prompt()
    c = msg.content
    assert "<subagent " in c
    assert "<task>" not in c


@pytest.mark.asyncio
async def test_todos_with_description_includes_description():
    todo = TodoTask(id="t1", title="x", status=TodoStatus.IN_PROGRESS, description="desc")
    patches = _patch_deps(todos=[todo])
    with patches["get_config"], patches["directory_tree"], patches["get_subagent_manager"], patches["get_todo_store"]:
        msg = await dsp.build_dynamic_system_prompt()
    c = msg.content
    assert "<description>desc</description>" in c


@pytest.mark.asyncio
async def test_todos_without_description_omits_description():
    todo = TodoTask(id="t1", title="x", status=TodoStatus.IN_PROGRESS, description="")
    patches = _patch_deps(todos=[todo])
    with patches["get_config"], patches["directory_tree"], patches["get_subagent_manager"], patches["get_todo_store"]:
        msg = await dsp.build_dynamic_system_prompt()
    c = msg.content
    assert "<description>" not in c


@pytest.mark.asyncio
async def test_todos_with_subagent_id_includes_subagent_id():
    todo = TodoTask(id="t1", title="x", status=TodoStatus.IN_PROGRESS, subagent_id="s1")
    patches = _patch_deps(todos=[todo])
    with patches["get_config"], patches["directory_tree"], patches["get_subagent_manager"], patches["get_todo_store"]:
        msg = await dsp.build_dynamic_system_prompt()
    c = msg.content
    assert "<subagent_id>s1</subagent_id>" in c


@pytest.mark.asyncio
async def test_ttl_cache_hit_avoids_directory_tree_call():
    patches = _patch_deps()
    with (
        patches["get_config"],
        patches["directory_tree"] as dt_patch,
        patches["get_subagent_manager"],
        patches["get_todo_store"],
    ):
        await dsp.build_dynamic_system_prompt()
        await dsp.build_dynamic_system_prompt()
    assert dt_patch.call_count == 1


@pytest.mark.asyncio
async def test_ttl_cache_miss_after_expiry_calls_directory_tree_again():
    import asyncio

    patches = _patch_deps()
    with (
        patches["get_config"],
        patches["directory_tree"] as dt_patch,
        patches["get_subagent_manager"],
        patches["get_todo_store"],
        patch("stupidex.llm.dynamic_system_prompt._TREE_TTL", 0.01),
    ):
        await dsp.build_dynamic_system_prompt()
        await asyncio.sleep(0.05)
        await dsp.build_dynamic_system_prompt()
    assert dt_patch.call_count == 2


@pytest.mark.asyncio
async def test_todo_title_with_xml_chars_escaped():
    todo = TodoTask(id="t1", title="<script>alert('x')</script>", status=TodoStatus.IN_PROGRESS)
    patches = _patch_deps(todos=[todo])
    with patches["get_config"], patches["directory_tree"], patches["get_subagent_manager"], patches["get_todo_store"]:
        msg = await dsp.build_dynamic_system_prompt()
    c = msg.content
    assert "&lt;script&gt;" in c
    assert "<script>alert" not in c


@pytest.mark.asyncio
async def test_subagent_task_text_with_xml_chars_escaped():
    states = [{"id": "s1", "name": "n", "type": "t", "state": "RUNNING", "elapsed": 1.5, "task": "<b>bold</b>"}]
    patches = _patch_deps(states=states)
    with patches["get_config"], patches["directory_tree"], patches["get_subagent_manager"], patches["get_todo_store"]:
        msg = await dsp.build_dynamic_system_prompt()
    c = msg.content
    assert "&lt;b&gt;bold&lt;/b&gt;" in c


@pytest.mark.asyncio
async def test_subagent_name_with_xml_chars_escaped():
    states = [{"id": "s1", "name": "a&b", "type": "t", "state": "RUNNING", "elapsed": 1.5, "task": None}]
    patches = _patch_deps(states=states)
    with patches["get_config"], patches["directory_tree"], patches["get_subagent_manager"], patches["get_todo_store"]:
        msg = await dsp.build_dynamic_system_prompt()
    c = msg.content
    assert 'name="a&amp;b"' in c
    assert "a&b\"" not in c


@pytest.mark.asyncio
async def test_cache_miss_after_chdir_within_ttl_regenerates_tree():
    patches = _patch_deps()
    with (
        patches["get_config"],
        patches["directory_tree"] as dt_patch,
        patches["get_subagent_manager"],
        patches["get_todo_store"],
        patch("stupidex.llm.dynamic_system_prompt.os.getcwd", side_effect=["/a", "/b"]),
    ):
        await dsp.build_dynamic_system_prompt()
        await dsp.build_dynamic_system_prompt()
    assert dt_patch.call_count == 2


@pytest.mark.asyncio
async def test_cwd_with_lt_escaped():
    patches = _patch_deps()
    with (
        patches["get_config"],
        patches["directory_tree"],
        patches["get_subagent_manager"],
        patches["get_todo_store"],
        patch("stupidex.llm.dynamic_system_prompt.os.getcwd", return_value="/tmp/a<b>c"),
    ):
        msg = await dsp.build_dynamic_system_prompt()
    c = msg.content
    assert "/tmp/a&lt;b&gt;c" in c
    assert "a<b>c" not in c


@pytest.mark.asyncio
async def test_tree_with_amp_escaped():
    patches = _patch_deps(tree="a&b.py")
    with patches["get_config"], patches["directory_tree"], patches["get_subagent_manager"], patches["get_todo_store"]:
        msg = await dsp.build_dynamic_system_prompt()
    c = msg.content
    assert "a&amp;b.py" in c
    assert "a&b.py" not in c
