"""Tests for search tool (P1-15): glob translation, ReDoS guard, timeouts."""

import asyncio
import time

import pytest

from stupidex.tools.search import execute_grep_tool


@pytest.fixture
def search_tree(tmp_path):
    (tmp_path / "foo.py").write_text("def hello():\n    pass\n")
    (tmp_path / "foo.txt").write_text("def world():\n    pass\n")
    (tmp_path / "a_test.py").write_text("x = 1\n")
    (tmp_path / "a.py").write_text("y = 2\n")
    (tmp_path / "d.py").write_text("z = 3\n")
    (tmp_path / "many.py").write_text("\n".join(f"match_line_{i}" for i in range(200)) + "\n")
    return tmp_path


async def test_happy_path_returns_matches(search_tree):
    result = await execute_grep_tool("def ", str(search_tree))
    assert "foo.py" in result.content
    assert "def hello" in result.content
    assert "def world" in result.content


async def test_redos_does_not_freeze(tmp_path):
    # A string of a's long enough to trigger catastrophic backtracking on (a+)+b.
    (tmp_path / "evil.txt").write_text("a" * 22 + "\n")
    start = time.monotonic()
    result = await execute_grep_tool(r"(a+)+b", str(tmp_path))
    elapsed = time.monotonic() - start
    assert elapsed < 15, f"ReDoS search took {elapsed:.1f}s"
    assert "No matches" in result.content


async def test_invalid_regex_returns_error_result(tmp_path):
    (tmp_path / "x.py").write_text("hello\n")
    result = await execute_grep_tool("(unclosed", str(tmp_path))
    assert "Invalid regex" in result.display or "Error" in result.content


async def test_glob_star_matches_py_only(search_tree):
    result = await execute_grep_tool("def", str(search_tree), include_pattern="*.py")
    assert "foo.py" in result.content
    assert "foo.txt" not in result.content


async def test_glob_question_mark(search_tree):
    result = await execute_grep_tool("x = 1", str(search_tree), include_pattern="?_test.py")
    assert "a_test.py" in result.content


async def test_glob_char_class(search_tree):
    result = await execute_grep_tool("= 2", str(search_tree), include_pattern="[abc].py")
    assert "a.py" in result.content
    assert "d.py" not in result.content


async def test_max_results_truncates(search_tree):
    result = await execute_grep_tool("match_line_", str(search_tree), max_results=5)
    assert "truncated to 5 results" in result.content
    match_lines = [ln for ln in result.content.splitlines() if ".py:" in ln and "match_line_" in ln]
    assert len(match_lines) == 5


async def test_max_results_does_not_leak_tasks(search_tree):
    tasks_before = len(asyncio.all_tasks())
    await execute_grep_tool("match_line_", str(search_tree), max_results=2)
    await asyncio.sleep(0.05)
    tasks_after = len(asyncio.all_tasks())
    assert tasks_after <= tasks_before + 1


async def test_per_file_timeout_huge_file_does_not_dominate(tmp_path):
    (tmp_path / "big.txt").write_text("nomatch_line\n" * 50000)
    (tmp_path / "match.py").write_text("target_here\n")
    start = time.monotonic()
    result = await execute_grep_tool("target_here", str(tmp_path))
    elapsed = time.monotonic() - start
    assert "match.py" in result.content
    assert "Found" in result.content
    assert elapsed < 30, f"search took {elapsed:.1f}s"
