"""Tests for AST tools (U5): get_file_skeleton, get_function, find_symbol_references,
replace_symbol, rename_symbol."""

import os
import stat
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from stupidex.ast.store import ASTStore
from stupidex.ast.symbols import Symbol
from stupidex.domain.tool import ExecutorResult
from stupidex.tools.ast import (
    _fnv1a,
    _get_function_sent_hashes,
    execute_find_symbol_references,
    execute_get_file_skeleton,
    execute_get_function,
    execute_rename_symbol,
    execute_replace_symbol,
    post_write_callbacks,
)

# ---------------------------------------------------------------------------
# fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _reset_ast_state():
    """Reset module-level state between tests."""
    import stupidex.ast.indexer as indexer_mod

    _get_function_sent_hashes.clear()
    post_write_callbacks.clear()
    old_flag = indexer_mod._session_initialized
    indexer_mod._session_initialized = False
    yield
    indexer_mod._session_initialized = old_flag


@pytest.fixture()
def py_project(tmp_path, monkeypatch):
    """Create a temp Python project with 3 functions and chdir into it."""
    monkeypatch.chdir(tmp_path)
    (tmp_path / "sample.py").write_text(
        "import os\n"
        "from pathlib import Path\n"
        "\n"
        "def foo():\n"
        "    return 1\n"
        "\n"
        "def bar(x):\n"
        "    return x + 1\n"
        "\n"
        "def baz(a, b):\n"
        "    return a + b\n"
    )
    return tmp_path


@pytest.fixture()
def class_project(tmp_path, monkeypatch):
    """Create a temp Python project with a class containing methods."""
    monkeypatch.chdir(tmp_path)
    (tmp_path / "model.py").write_text(
        "class User:\n"
        "    def __init__(self, name):\n"
        "        self.name = name\n"
        "\n"
        "    def greet(self):\n"
        "        return f'Hello {self.name}'\n"
    )
    return tmp_path


@pytest.fixture()
def calls_project(tmp_path, monkeypatch):
    """Create a temp Python project with functions that call other functions."""
    monkeypatch.chdir(tmp_path)
    (tmp_path / "pipeline.py").write_text(
        "import os\n"
        "from pathlib import Path\n"
        "\n"
        "def setup():\n"
        "    os.makedirs('out')\n"
        "    return Path('.')\n"
        "\n"
        "def run(data):\n"
        "    result = process(data)\n"
        "    return save(result)\n"
        "\n"
        "def process(data):\n"
        "    return data.strip()\n"
        "\n"
        "def save(obj):\n"
        "    return str(obj)\n"
    )
    return tmp_path


def _populate_store(project_path: str, file_symbols: dict[str, list[Symbol]]) -> None:
    """Pre-populate the AST store with test data."""
    store = ASTStore(project_path)
    store.init_db()
    for rel_path, syms in file_symbols.items():
        store.upsert_file(rel_path, "testhash", syms)


# ---------------------------------------------------------------------------
# get_file_skeleton
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_file_skeleton_happy(py_project):
    result = await execute_get_file_skeleton("sample.py")
    assert isinstance(result, ExecutorResult)
    assert "3 definitions" in result.display
    assert "foo" in result.content
    assert "bar" in result.content
    assert "baz" in result.content
    assert "<file_skeleton" in result.content
    assert "│" in result.content
    assert "return" not in result.content


@pytest.mark.asyncio
async def test_get_file_skeleton_with_separators(py_project):
    result = await execute_get_file_skeleton("sample.py")
    assert "|----" in result.content


@pytest.mark.asyncio
async def test_get_file_skeleton_no_definitions(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "empty.py").write_text("# just a comment\nx = 1\n")
    result = await execute_get_file_skeleton("empty.py")
    assert isinstance(result, ExecutorResult)
    assert "No definitions" in result.display
    assert 'definitions="0"' in result.content


@pytest.mark.asyncio
async def test_get_file_skeleton_unsupported_type(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "data.txt").write_text("hello\n")
    result = await execute_get_file_skeleton("data.txt")
    assert isinstance(result, ExecutorResult)
    assert "<ast_error" in result.content
    assert "Unsupported" in result.display or "error" in result.content.lower()


@pytest.mark.asyncio
async def test_get_file_skeleton_file_not_found(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    result = await execute_get_file_skeleton("nope.py")
    assert isinstance(result, ExecutorResult)
    assert "not found" in result.display.lower()


@pytest.mark.asyncio
async def test_get_file_skeleton_line_counts(py_project):
    result = await execute_get_file_skeleton("sample.py")
    assert "# Lines:" in result.content


@pytest.mark.asyncio
async def test_get_file_skeleton_calls_metadata(calls_project):
    result = await execute_get_file_skeleton("pipeline.py")
    assert "# Calls:" in result.content
    assert "run" in result.content
    assert "setup" in result.content


@pytest.mark.asyncio
async def test_get_file_skeleton_no_self_recursion_in_calls(calls_project):
    """Self-recursive calls (a calling a) should not appear in the Calls list."""
    monkeypatch_dir = calls_project
    (monkeypatch_dir / "recurse.py").write_text(
        "def foo():\n"
        "    if True:\n"
        "        foo()\n"
    )
    result = await execute_get_file_skeleton("recurse.py")
    # The definition line for 'foo' should NOT have "Calls: [foo]"
    for line in result.content.splitlines():
        if "│ foo" in line:
            assert "Calls: [foo]" not in line


# ---------------------------------------------------------------------------
# get_function
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_function_happy(py_project):
    result = await execute_get_function("sample.py", "foo")
    assert isinstance(result, ExecutorResult)
    assert "foo" in result.content
    assert "return 1" in result.content
    assert "<function" in result.content
    assert "<body>" in result.content


@pytest.mark.asyncio
async def test_get_function_with_imports(py_project):
    result = await execute_get_function("sample.py", "foo")
    assert isinstance(result, ExecutorResult)
    assert "<imports>" in result.content
    assert "import os" in result.content


@pytest.mark.asyncio
async def test_get_function_hash_match_no_changes(py_project):
    _get_function_sent_hashes["sample.py:foo:"] = _fnv1a("def foo():\n    return 1")
    result = await execute_get_function("sample.py", "foo")
    assert isinstance(result, ExecutorResult)
    assert "No changes" in result.content


@pytest.mark.asyncio
async def test_get_function_first_call_always_returns(py_project):
    result = await execute_get_function("sample.py", "foo")
    assert isinstance(result, ExecutorResult)
    assert "No changes" not in result.content
    assert "return 1" in result.content


@pytest.mark.asyncio
async def test_get_function_not_found(py_project):
    result = await execute_get_function("sample.py", "nonexistent")
    assert isinstance(result, ExecutorResult)
    assert "not found" in result.content.lower()
    assert "<ast_error" not in result.content
    assert 'status="not_found"' in result.content


@pytest.mark.asyncio
async def test_get_function_file_not_found(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    result = await execute_get_function("nope.py", "foo")
    assert isinstance(result, ExecutorResult)
    assert "not found" in result.display.lower()


@pytest.mark.asyncio
async def test_get_function_unsupported_type(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "data.txt").write_text("hello\n")
    result = await execute_get_function("data.txt", "foo")
    assert isinstance(result, ExecutorResult)
    assert "<ast_error" in result.content


@pytest.mark.asyncio
async def test_get_function_class_context(class_project):
    result = await execute_get_function("model.py", "greet")
    assert isinstance(result, ExecutorResult)
    assert "greet" in result.content
    assert "Hello" in result.content


@pytest.mark.asyncio
async def test_get_function_has_line_numbers(py_project):
    result = await execute_get_function("sample.py", "foo")
    assert isinstance(result, ExecutorResult)
    assert 'start_line=' in result.content
    assert 'end_line=' in result.content


@pytest.mark.asyncio
async def test_get_function_line_numbers_values(py_project):
    result = await execute_get_function("sample.py", "foo")
    assert 'start_line="4"' in result.content  # 1-indexed: line 4 is `def foo():`
    assert 'end_line="5"' in result.content    # 1-indexed: line 5 is `    return 1`


@pytest.mark.asyncio
async def test_get_function_line_numbers_not_found(py_project):
    result = await execute_get_function("sample.py", "nonexistent")
    assert isinstance(result, ExecutorResult)
    # not_found functions should not have line numbers
    assert 'start_line=' not in result.content


@pytest.mark.asyncio
async def test_get_function_line_numbers_no_changes(py_project):
    _get_function_sent_hashes["sample.py:foo:"] = _fnv1a("def foo():\n    return 1")
    result = await execute_get_function("sample.py", "foo")
    assert isinstance(result, ExecutorResult)
    assert 'start_line=' in result.content
    assert 'end_line=' in result.content


@pytest.mark.asyncio
async def test_get_function_multiple_functions_line_numbers(calls_project):
    result = await execute_get_function("pipeline.py", "run, process")
    assert isinstance(result, ExecutorResult)
    assert 'start_line=' in result.content
    assert 'end_line=' in result.content
    # Both functions should have line numbers
    assert result.content.count('start_line=') == 2


# ---------------------------------------------------------------------------
# find_symbol_references (uses pre-populated store)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_find_symbol_references_happy(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    _populate_store(str(tmp_path), {
        "defs.py": [
            Symbol("process", "definition", "function", 0, 4, 0, 15, 0, 15),
        ],
        "use1.py": [
            Symbol("process", "reference", "", 0, 0, 0, 7, 0, 7),
        ],
        "use2.py": [
            Symbol("process", "reference", "", 0, 0, 0, 7, 0, 7),
            Symbol("process", "reference", "", 1, 0, 1, 7, 8, 15),
        ],
    })
    import stupidex.ast.indexer as indexer_mod
    indexer_mod._session_initialized = True

    result = await execute_find_symbol_references("process")
    assert isinstance(result, ExecutorResult)
    assert "<symbol_references" in result.content
    assert "defs.py" in result.content
    assert "use1.py" in result.content
    assert "use2.py" in result.content


@pytest.mark.asyncio
async def test_find_symbol_references_type_filter_definition(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    _populate_store(str(tmp_path), {
        "defs.py": [
            Symbol("foo", "definition", "function", 0, 4, 0, 15, 0, 15),
        ],
        "use.py": [
            Symbol("foo", "reference", "", 0, 0, 0, 3, 0, 3),
        ],
    })
    import stupidex.ast.indexer as indexer_mod
    indexer_mod._session_initialized = True

    result = await execute_find_symbol_references("foo", type_filter="definition")
    assert isinstance(result, ExecutorResult)
    assert 'type="definition"' in result.content
    assert 'type="reference"' not in result.content


@pytest.mark.asyncio
async def test_find_symbol_references_type_filter_invalid(py_project):
    result = await execute_find_symbol_references("foo", type_filter="invalid")
    assert isinstance(result, ExecutorResult)
    assert "<ast_error" in result.content


@pytest.mark.asyncio
async def test_find_symbol_references_no_results(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    _populate_store(str(tmp_path), {})
    result = await execute_find_symbol_references("nonexistent_symbol_xyz")
    assert isinstance(result, ExecutorResult)
    assert 'count="0"' in result.content


@pytest.mark.asyncio
async def test_find_symbol_references_empty_name(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    result = await execute_find_symbol_references("")
    assert isinstance(result, ExecutorResult)
    assert "<ast_error" in result.content


@pytest.mark.asyncio
async def test_find_symbol_references_line_numbers_are_1_indexed(py_project):
    """P1-18: find_symbol_references must report 1-indexed line numbers."""
    _populate_store(str(py_project), {
        "sample.py": [
            # 0-indexed: foo def is on line 3 (1-indexed line 4)
            Symbol("foo", "definition", "function", 3, 0, 4, 4, 9, 31),
        ],
    })
    import stupidex.ast.indexer as indexer_mod
    indexer_mod._session_initialized = True

    result = await execute_find_symbol_references("foo")
    assert 'start_line="4"' in result.content
    assert 'end_line="5"' in result.content


@pytest.mark.asyncio
async def test_find_symbol_references_line_numbers_match_skeleton(py_project):
    """P1-18: find_symbol_references lines must match get_file_skeleton for same symbol."""
    _populate_store(str(py_project), {
        "sample.py": [
            # 0-indexed: bar def is on line 6 (1-indexed line 7)
            Symbol("bar", "definition", "function", 6, 0, 7, 4, 38, 59),
        ],
    })
    import stupidex.ast.indexer as indexer_mod
    indexer_mod._session_initialized = True

    refs_result = await execute_find_symbol_references("bar")
    skel_result = await execute_get_file_skeleton("sample.py")

    assert 'start_line="7"' in refs_result.content
    skel_bar_line = None
    for line in skel_result.content.splitlines():
        if "│ bar" in line:
            skel_bar_line = line
            break
    assert skel_bar_line is not None
    assert "7 │ bar" in skel_bar_line


# ---------------------------------------------------------------------------
# replace_symbol
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_replace_symbol_happy(py_project):
    result = await execute_replace_symbol(
        "sample.py", "foo", "def foo():\n    return 42\n"
    )
    assert isinstance(result, ExecutorResult)
    assert 'success="true"' in result.content
    assert "<diff" in result.content
    assert "return 42" in Path("sample.py").read_text()


@pytest.mark.asyncio
async def test_replace_symbol_two_functions_reverse_order(py_project):
    new_foo = "def foo():\n    return 100\n"
    new_baz = "def baz(a, b):\n    return a * b\n"

    result_foo = await execute_replace_symbol("sample.py", "foo", new_foo)
    assert 'success="true"' in result_foo.content

    result_baz = await execute_replace_symbol("sample.py", "baz", new_baz)
    assert 'success="true"' in result_baz.content

    content = Path("sample.py").read_text()
    assert "return 100" in content
    assert "return a * b" in content
    assert "def bar" in content


@pytest.mark.asyncio
async def test_replace_symbol_not_found(py_project):
    original = Path("sample.py").read_text()
    result = await execute_replace_symbol(
        "sample.py", "nonexistent", "def nonexistent(): pass\n"
    )
    assert isinstance(result, ExecutorResult)
    assert 'success="false"' in result.content
    assert 'error="symbol_not_found"' in result.content
    assert Path("sample.py").read_text() == original


@pytest.mark.asyncio
async def test_replace_symbol_file_not_found(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    result = await execute_replace_symbol("nope.py", "foo", "def foo(): pass\n")
    assert isinstance(result, ExecutorResult)
    assert 'success="false"' in result.content
    assert 'error="file_not_found"' in result.content


@pytest.mark.asyncio
async def test_replace_symbol_read_only_file(py_project):
    os.chmod("sample.py", stat.S_IRUSR)
    try:
        result = await execute_replace_symbol(
            "sample.py", "foo", "def foo():\n    return 99\n"
        )
        assert isinstance(result, ExecutorResult)
        assert result.content
    finally:
        os.chmod("sample.py", stat.S_IRUSR | stat.S_IWUSR)


@pytest.mark.asyncio
async def test_replace_symbol_unsupported_type(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "data.txt").write_text("hello\n")
    result = await execute_replace_symbol("data.txt", "foo", "bar")
    assert isinstance(result, ExecutorResult)
    assert 'success="false"' in result.content


@pytest.mark.asyncio
async def test_replace_symbol_with_docstring(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "mod.py").write_text(
        'def documented():\n    """A docstring."""\n    return 1\n'
    )
    result = await execute_replace_symbol(
        "mod.py", "documented", 'def documented():\n    """New docstring."""\n    return 2\n'
    )
    assert isinstance(result, ExecutorResult)
    assert 'success="true"' in result.content
    content = Path("mod.py").read_text()
    assert "New docstring" in content
    assert "return 2" in content


# ---------------------------------------------------------------------------
# rename_symbol (uses pre-populated store)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_rename_symbol_across_files(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "core.py").write_text("def process():\n    pass\n")
    (tmp_path / "app.py").write_text("process()\nresult = process()\n")
    _populate_store(str(tmp_path), {
        "core.py": [
            Symbol("process", "definition", "function", 0, 4, 0, 15, 0, 15),
        ],
        "app.py": [
            Symbol("process", "reference", "", 0, 0, 0, 7, 0, 7),
            Symbol("process", "reference", "", 1, 9, 1, 16, 18, 25),
        ],
    })

    result = await execute_rename_symbol("process", "handle")
    assert isinstance(result, ExecutorResult)
    assert "Renamed" in result.display
    assert 'success="true"' in result.content
    assert "handle" in Path("core.py").read_text()
    assert "handle" in Path("app.py").read_text()
    assert "process" not in Path("core.py").read_text()
    assert "process" not in Path("app.py").read_text()


@pytest.mark.asyncio
async def test_rename_symbol_no_references(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    _populate_store(str(tmp_path), {})
    result = await execute_rename_symbol("nonexistent_xyz", "new_name")
    assert isinstance(result, ExecutorResult)
    assert "<ast_error" in result.content
    assert "No references" in result.content


@pytest.mark.asyncio
async def test_rename_symbol_empty_name(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    result = await execute_rename_symbol("", "new_name")
    assert isinstance(result, ExecutorResult)
    assert "<ast_error" in result.content


@pytest.mark.asyncio
async def test_rename_symbol_empty_new_name(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    _populate_store(str(tmp_path), {
        "mod.py": [
            Symbol("foo", "definition", "function", 0, 4, 0, 7, 0, 7),
        ],
    })
    result = await execute_rename_symbol("foo", "")
    assert isinstance(result, ExecutorResult)
    assert "<ast_error" in result.content
    assert "New name" in result.content or "new" in result.content.lower()


@pytest.mark.asyncio
async def test_rename_symbol_whitespace_new_name(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    _populate_store(str(tmp_path), {
        "mod.py": [
            Symbol("foo", "definition", "function", 0, 4, 0, 7, 0, 7),
        ],
    })
    result = await execute_rename_symbol("foo", "   ")
    assert isinstance(result, ExecutorResult)
    assert "<ast_error" in result.content


@pytest.mark.asyncio
async def test_rename_symbol_preserves_other_code(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "mod.py").write_text(
        "import os\n\ndef process():\n    return os.getcwd()\n\nx = 42\n"
    )
    _populate_store(str(tmp_path), {
        "mod.py": [
            Symbol("process", "definition", "function", 2, 4, 2, 11, 15, 22),
        ],
    })

    result = await execute_rename_symbol("process", "handle")
    assert isinstance(result, ExecutorResult)
    content = Path("mod.py").read_text()
    assert "import os" in content
    assert "x = 42" in content
    assert "handle" in content
    assert "process" not in content


@pytest.mark.asyncio
async def test_rename_symbol_word_boundary_dollar(tmp_path, monkeypatch):
    """Symbols prefixed with $ should not be renamed when $ is adjacent."""
    monkeypatch.chdir(tmp_path)
    (tmp_path / "mod.js").write_text("const $foo = 1;\nconst bar = $foo;\n")
    _populate_store(str(tmp_path), {
        "mod.js": [
            Symbol("$foo", "definition", "function", 0, 6, 0, 10, 0, 10),
            Symbol("$foo", "reference", "", 1, 12, 1, 16, 0, 0),
        ],
    })
    result = await execute_rename_symbol("$foo", "$bar")
    assert isinstance(result, ExecutorResult)
    content = Path("mod.js").read_text()
    assert "$bar" in content
    assert "$foo" not in content


# ---------------------------------------------------------------------------
# post_write_callbacks
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_post_write_callbacks_triggered(py_project):
    cb = AsyncMock()
    post_write_callbacks.append(cb)
    await execute_replace_symbol("sample.py", "foo", "def foo():\n    return 42\n")
    cb.assert_called_once_with("sample.py")


@pytest.mark.asyncio
async def test_post_write_callbacks_not_triggered_on_failure(py_project):
    cb = AsyncMock()
    post_write_callbacks.append(cb)
    await execute_replace_symbol("sample.py", "nonexistent_xyz", "def x(): pass\n")
    cb.assert_not_called()


@pytest.mark.asyncio
async def test_rename_post_write_callbacks_triggered(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "core.py").write_text("def process():\n    pass\n")
    _populate_store(str(tmp_path), {
        "core.py": [
            Symbol("process", "definition", "function", 0, 4, 0, 15, 0, 15),
        ],
    })

    cb = AsyncMock()
    post_write_callbacks.append(cb)
    await execute_rename_symbol("process", "handle")
    cb.assert_called_once_with("core.py")


# ---------------------------------------------------------------------------
# tool registration
# ---------------------------------------------------------------------------


def test_all_ast_tools_in_registry():
    from stupidex.tools import get_tool_registry

    registry = get_tool_registry()
    assert "get_file_skeleton" in registry
    assert "get_function" in registry
    assert "find_symbol_references" in registry
    assert "replace_symbol" in registry
    assert "rename_symbol" in registry
    assert registry["get_file_skeleton"]["executor"] is execute_get_file_skeleton
    assert registry["get_function"]["executor"] is execute_get_function
    assert registry["find_symbol_references"]["executor"] is execute_find_symbol_references
    assert registry["replace_symbol"]["executor"] is execute_replace_symbol
    assert registry["rename_symbol"]["executor"] is execute_rename_symbol


def test_ast_tools_in_timeout_exemption():
    from stupidex.llm.client import _TOOLS_WITHOUT_TIMEOUT

    assert "get_file_skeleton" in _TOOLS_WITHOUT_TIMEOUT
    assert "get_function" in _TOOLS_WITHOUT_TIMEOUT
    assert "find_symbol_references" in _TOOLS_WITHOUT_TIMEOUT
    assert "replace_symbol" in _TOOLS_WITHOUT_TIMEOUT
    assert "rename_symbol" in _TOOLS_WITHOUT_TIMEOUT


# ---------------------------------------------------------------------------
# integration: index lifecycle
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_first_find_refs_triggers_scan(tmp_path, monkeypatch):
    """AE1: First find_symbol_references call triggers full project scan."""
    monkeypatch.chdir(tmp_path)
    (tmp_path / "mod.py").write_text("def helper():\n    pass\nhelper()\n")

    result = await execute_find_symbol_references("helper")

    assert isinstance(result, ExecutorResult)
    assert "helper" in result.content
    store = ASTStore(str(tmp_path))
    syms = store.get_symbols_by_name("helper", "both")
    assert len(syms) >= 2


@pytest.mark.asyncio
async def test_second_find_refs_no_rescan(tmp_path, monkeypatch):
    """Second find_symbol_references on unchanged project does not re-scan."""
    monkeypatch.chdir(tmp_path)
    (tmp_path / "mod.py").write_text("def helper():\n    pass\nhelper()\n")

    import stupidex.ast.indexer as indexer_mod
    from stupidex.ast.indexer import index_project

    await index_project(project_path=str(tmp_path))
    indexer_mod._session_initialized = True

    with patch.object(indexer_mod, "index_project", wraps=indexer_mod.index_project) as spy:
        _populate_store(str(tmp_path), {
            "mod.py": [
                Symbol("helper", "definition", "function", 0, 4, 0, 15, 0, 15),
                Symbol("helper", "reference", "", 2, 0, 2, 6, 22, 28),
            ],
        })
        result = await execute_find_symbol_references("helper")
        spy.assert_not_called()

    assert "helper" in result.content


# ---------------------------------------------------------------------------
# FNV-1a hash
# ---------------------------------------------------------------------------


def test_fnv1a_deterministic():
    h1 = _fnv1a("hello world")
    h2 = _fnv1a("hello world")
    assert h1 == h2
    assert len(h1) == 16


def test_fnv1a_different_inputs():
    h1 = _fnv1a("foo")
    h2 = _fnv1a("bar")
    assert h1 != h2
