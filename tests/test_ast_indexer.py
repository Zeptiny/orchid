"""Tests for AST indexer (U4)."""

from pathlib import Path

import pytest

import stupidex.ast.indexer as indexer_mod
from stupidex.ast.indexer import (
    AST_INCLUDE_EXTS,
    _discover_files,
    _extract_symbols,
    _read_and_hash,
    _should_include,
    index_project,
    update_file,
)
from stupidex.ast.store import ASTStore


@pytest.fixture(autouse=True)
def _reset_session_flag():
    """Reset session flag before each test for isolation."""
    indexer_mod._session_initialized = False
    yield
    indexer_mod._session_initialized = False


# ---------------------------------------------------------------------------
# _should_include
# ---------------------------------------------------------------------------


def test_should_include_py():
    assert _should_include(Path("test.py")) is True


def test_should_include_ts():
    assert _should_include(Path("test.ts")) is True


def test_should_include_jsx():
    assert _should_include(Path("App.jsx")) is True


def test_should_include_tsx():
    assert _should_include(Path("App.tsx")) is True


def test_should_include_js():
    assert _should_include(Path("main.js")) is True


def test_should_exclude_txt():
    assert _should_include(Path("README.txt")) is False


def test_should_exclude_json():
    assert _should_include(Path("config.json")) is False


def test_should_exclude_makefile():
    assert _should_include(Path("Makefile")) is False


def test_ast_include_exts_is_frozen():
    assert isinstance(AST_INCLUDE_EXTS, frozenset)
    assert len(AST_INCLUDE_EXTS) == 5


# ---------------------------------------------------------------------------
# _discover_files
# ---------------------------------------------------------------------------


def test_discover_files_skips_git_and_node_modules(tmp_path):
    (tmp_path / "good.py").write_text("x = 1")
    (tmp_path / ".git").mkdir()
    (tmp_path / ".git" / "config").write_text("git stuff")
    (tmp_path / "node_modules").mkdir()
    (tmp_path / "node_modules" / "pkg.js").write_text("var x")

    files = _discover_files(tmp_path, [".git", "node_modules"])
    names = [f.name for f in files]
    assert "good.py" in names
    assert "config" not in names
    assert "pkg.js" not in names


def test_discover_files_skips_stupidex_dir(tmp_path):
    (tmp_path / "real.py").write_text("x = 1")
    stupidex = tmp_path / ".stupidex"
    stupidex.mkdir()
    (stupidex / "old.py").write_text("stale")

    files = _discover_files(tmp_path, [])
    names = [f.name for f in files]
    assert "real.py" in names
    assert "old.py" not in names


def test_discover_files_skips_pycache(tmp_path):
    (tmp_path / "mod.py").write_text("x = 1")
    cache = tmp_path / "__pycache__"
    cache.mkdir()
    (cache / "mod.cpython-311.pyc").write_bytes(b"\x00")

    files = _discover_files(tmp_path, [])
    names = [f.name for f in files]
    assert "mod.py" in names
    assert "mod.cpython-311.pyc" not in names


def test_discover_files_only_ast_extensions(tmp_path):
    (tmp_path / "code.py").write_text("x = 1")
    (tmp_path / "data.json").write_text("{}")
    (tmp_path / "notes.txt").write_text("hello")
    (tmp_path / "style.css").write_text("body{}")

    files = _discover_files(tmp_path, [])
    names = [f.name for f in files]
    assert "code.py" in names
    assert "data.json" not in names
    assert "notes.txt" not in names
    assert "style.css" not in names


def test_discover_files_empty_project(tmp_path):
    files = _discover_files(tmp_path, [])
    assert files == []


# ---------------------------------------------------------------------------
# _read_and_hash
# ---------------------------------------------------------------------------


def test_read_and_hash_normal_file(tmp_path):
    f = tmp_path / "test.py"
    f.write_text("print('hello')")
    content, h = _read_and_hash(f)
    assert content == "print('hello')"
    assert h is not None
    assert len(h) == 32  # MD5 hex digest


def test_read_and_hash_empty_file(tmp_path):
    f = tmp_path / "empty.py"
    f.write_text("")
    content, h = _read_and_hash(f)
    assert content is None
    assert h is None


def test_read_and_hash_binary_nul_bytes(tmp_path):
    f = tmp_path / "binary.py"
    f.write_bytes(b"print('hi')\x00end")
    content, h = _read_and_hash(f)
    assert content is None
    assert h is None


def test_read_and_hash_large_file(tmp_path, monkeypatch):
    f = tmp_path / "huge.py"
    f.write_text("x = 1\n" * 100)

    class SmallConfig:
        ast_max_file_size = 10

    monkeypatch.setattr(
        "stupidex.ast.indexer.get_config", lambda: SmallConfig()
    )
    content, h = _read_and_hash(f)
    assert content is None
    assert h is None


# ---------------------------------------------------------------------------
# _extract_symbols
# ---------------------------------------------------------------------------


def test_extract_symbols_python_functions():
    source = "def foo(): pass\ndef bar(): pass"
    symbols = _extract_symbols("test.py", source)
    defs = [s for s in symbols if s.type == "definition" and s.kind == "function"]
    names = [s.name for s in defs]
    assert "foo" in names
    assert "bar" in names


def test_extract_symbols_python_class():
    source = "class Foo:\n    def bar(self): pass"
    symbols = _extract_symbols("test.py", source)
    class_defs = [s for s in symbols if s.type == "definition" and s.kind == "class"]
    assert len(class_defs) == 1
    assert class_defs[0].name == "Foo"

    func_defs = [s for s in symbols if s.type == "definition" and s.kind == "function"]
    assert any(s.name == "bar" for s in func_defs)


def test_extract_symbols_references():
    source = "def foo(): pass\nfoo()"
    symbols = _extract_symbols("test.py", source)
    refs = [s for s in symbols if s.type == "reference"]
    assert any(s.name == "foo" for s in refs)


def test_extract_symbols_unsupported_extension():
    symbols = _extract_symbols("test.txt", "hello")
    assert symbols == []


def test_extract_symbols_python_ranges():
    source = "def foo(): pass"
    symbols = _extract_symbols("test.py", source)
    defs = [s for s in symbols if s.type == "definition" and s.kind == "function"]
    assert len(defs) == 1
    foo = defs[0]
    assert foo.start_line == 0
    assert foo.start_column == 4
    assert foo.end_line == 0
    assert foo.end_column == 7
    assert foo.char_start == 4
    assert foo.char_end == 7


def test_extract_symbols_typescript():
    source = "function bar(): void {}"
    symbols = _extract_symbols("test.ts", source)
    defs = [s for s in symbols if s.type == "definition" and s.kind == "function"]
    assert len(defs) == 1
    assert defs[0].name == "bar"


def test_extract_symbols_javascript():
    source = "function baz() { return 1; }"
    symbols = _extract_symbols("test.js", source)
    defs = [s for s in symbols if s.type == "definition" and s.kind == "function"]
    assert len(defs) == 1
    assert defs[0].name == "baz"


# ---------------------------------------------------------------------------
# index_project — core pipeline
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_index_project_populates_symbols(tmp_path):
    (tmp_path / "main.py").write_text("def hello():\n    return 'hi'")
    (tmp_path / "utils.py").write_text("def add(a, b):\n    return a + b")

    result = await index_project(project_path=str(tmp_path))

    assert result.files_scanned == 2
    assert result.files_indexed == 2
    assert result.files_skipped == 0
    assert result.errors == []
    assert result.symbols_extracted >= 2
    assert result.duration_seconds >= 0

    store = ASTStore(str(tmp_path))
    store.init_db()
    hashes = store.get_all_file_hashes()
    assert "main.py" in hashes
    assert "utils.py" in hashes


@pytest.mark.asyncio
async def test_index_project_with_ts_files(tmp_path):
    (tmp_path / "app.ts").write_text("function bar(): void {}")
    (tmp_path / "comp.tsx").write_text("function App() { return 1; }")

    result = await index_project(project_path=str(tmp_path))

    assert result.files_scanned == 2
    assert result.files_indexed == 2
    assert result.symbols_extracted >= 2

    store = ASTStore(str(tmp_path))
    store.init_db()
    hashes = store.get_all_file_hashes()
    assert "app.ts" in hashes
    assert "comp.tsx" in hashes


@pytest.mark.asyncio
async def test_index_project_skips_unsupported_extensions(tmp_path):
    (tmp_path / "code.py").write_text("x = 1")
    (tmp_path / "data.json").write_text("{}")
    (tmp_path / "notes.txt").write_text("hello")

    result = await index_project(project_path=str(tmp_path))

    assert result.files_scanned == 1
    assert result.files_indexed == 1


@pytest.mark.asyncio
async def test_index_project_skips_unchanged_files(tmp_path):
    (tmp_path / "app.py").write_text("x = 1")

    r1 = await index_project(project_path=str(tmp_path))
    assert r1.files_indexed == 1

    r2 = await index_project(project_path=str(tmp_path))
    assert r2.files_skipped == 1
    assert r2.files_indexed == 0


@pytest.mark.asyncio
async def test_index_project_detects_modified_files(tmp_path):
    (tmp_path / "app.py").write_text("x = 1")

    await index_project(project_path=str(tmp_path))

    (tmp_path / "app.py").write_text("x = 2\ny = 3")

    r = await index_project(project_path=str(tmp_path))
    assert r.files_indexed == 1
    assert r.files_skipped == 0


@pytest.mark.asyncio
async def test_index_project_force_reindexes_everything(tmp_path):
    (tmp_path / "a.py").write_text("x = 1")

    await index_project(project_path=str(tmp_path))

    r = await index_project(project_path=str(tmp_path), force=True)
    assert r.files_indexed == 1
    assert r.files_skipped == 0


@pytest.mark.asyncio
async def test_index_project_skips_node_modules(tmp_path):
    (tmp_path / "real.py").write_text("x = 1")
    nm = tmp_path / "node_modules"
    nm.mkdir()
    (nm / "pkg.js").write_text("var x")

    result = await index_project(project_path=str(tmp_path))

    assert result.files_scanned == 1
    assert result.files_indexed == 1


@pytest.mark.asyncio
async def test_index_project_skips_git_dir(tmp_path):
    (tmp_path / "real.py").write_text("x = 1")
    git = tmp_path / ".git"
    git.mkdir()
    (git / "config").write_text("git stuff")

    result = await index_project(project_path=str(tmp_path))

    assert result.files_scanned == 1
    assert result.files_indexed == 1


@pytest.mark.asyncio
async def test_index_project_skips_stupidex_dir(tmp_path):
    (tmp_path / "real.py").write_text("x = 1")
    stupidex = tmp_path / ".stupidex"
    stupidex.mkdir()
    (stupidex / "old.py").write_text("stale")

    result = await index_project(project_path=str(tmp_path))

    assert result.files_scanned == 1
    assert result.files_indexed == 1


@pytest.mark.asyncio
async def test_index_project_skips_binary_files(tmp_path):
    (tmp_path / "binary.py").write_bytes(b"\x00\x01\x02")
    (tmp_path / "normal.py").write_text("print('hello')")

    result = await index_project(project_path=str(tmp_path))

    assert result.files_scanned == 2
    assert result.files_indexed == 1


@pytest.mark.asyncio
async def test_index_project_skips_empty_files(tmp_path):
    (tmp_path / "empty.py").write_text("")
    (tmp_path / "normal.py").write_text("x = 1")

    result = await index_project(project_path=str(tmp_path))

    assert result.files_scanned == 2
    assert result.files_indexed == 1


@pytest.mark.asyncio
async def test_index_project_skips_large_files(tmp_path, monkeypatch):
    (tmp_path / "huge.py").write_text("x = 1\n" * 1000)
    (tmp_path / "normal.py").write_text("x = 1")

    class SmallConfig:
        ast_max_file_size = 10
        ignored_dirs: list[str] = []

    monkeypatch.setattr(
        "stupidex.ast.indexer.get_config", lambda: SmallConfig()
    )

    result = await index_project(project_path=str(tmp_path))

    assert result.files_scanned == 2
    assert result.files_indexed == 1


@pytest.mark.asyncio
async def test_index_project_removes_deleted_files(tmp_path):
    (tmp_path / "keep.py").write_text("a = 1")
    (tmp_path / "remove.py").write_text("b = 2")

    await index_project(project_path=str(tmp_path))

    (tmp_path / "remove.py").unlink()

    r = await index_project(project_path=str(tmp_path))
    assert r.files_deleted == 1

    store = ASTStore(str(tmp_path))
    store.init_db()
    hashes = store.get_all_file_hashes()
    assert "keep.py" in hashes
    assert "remove.py" not in hashes


@pytest.mark.asyncio
async def test_index_project_empty_project(tmp_path):
    result = await index_project(project_path=str(tmp_path))
    assert result.files_scanned == 0
    assert result.files_indexed == 0
    assert result.errors == []


@pytest.mark.asyncio
async def test_index_project_progress_callback(tmp_path):
    (tmp_path / "a.py").write_text("x = 1")
    (tmp_path / "b.py").write_text("y = 2")

    calls: list[tuple] = []

    def cb(path, done, total):
        calls.append((path, done, total))

    await index_project(project_path=str(tmp_path), progress_callback=cb)

    assert len(calls) == 2
    assert all(isinstance(c[0], str) for c in calls)
    assert calls[-1][2] == 2


# ---------------------------------------------------------------------------
# update_file
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_update_file_reindexes_changed_file(tmp_path):
    (tmp_path / "app.py").write_text("def foo(): pass")

    await index_project(project_path=str(tmp_path))

    (tmp_path / "app.py").write_text("def bar(): pass\ndef baz(): pass")

    await update_file("app.py", project_path=str(tmp_path))

    store = ASTStore(str(tmp_path))
    store.init_db()
    hashes = store.get_all_file_hashes()
    assert "app.py" in hashes

    syms = store.get_symbols_by_name("bar", "definition")
    assert len(syms) == 1
    assert syms[0]["file_path"] == "app.py"


@pytest.mark.asyncio
async def test_update_file_does_not_affect_other_files(tmp_path):
    (tmp_path / "a.py").write_text("def foo(): pass")
    (tmp_path / "b.py").write_text("def bar(): pass")

    await index_project(project_path=str(tmp_path))

    store = ASTStore(str(tmp_path))
    store.init_db()
    original_b_hash = store.get_file_hash("b.py")

    (tmp_path / "a.py").write_text("def foo_changed(): pass")
    await update_file("a.py", project_path=str(tmp_path))

    updated_b_hash = store.get_file_hash("b.py")
    assert updated_b_hash == original_b_hash

    syms = store.get_symbols_by_name("bar", "definition")
    assert len(syms) == 1


@pytest.mark.asyncio
async def test_update_file_removes_deleted_file(tmp_path):
    (tmp_path / "app.py").write_text("def foo(): pass")

    await index_project(project_path=str(tmp_path))

    (tmp_path / "app.py").unlink()

    await update_file("app.py", project_path=str(tmp_path))

    store = ASTStore(str(tmp_path))
    store.init_db()
    hashes = store.get_all_file_hashes()
    assert "app.py" not in hashes


# ---------------------------------------------------------------------------
# Session initialization flag
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_session_flag_set_after_index(tmp_path):
    (tmp_path / "x.py").write_text("x = 1")

    assert indexer_mod._session_initialized is False

    await index_project(project_path=str(tmp_path))

    assert indexer_mod._session_initialized is True


@pytest.mark.asyncio
async def test_second_index_skips_unchanged(tmp_path):
    (tmp_path / "x.py").write_text("x = 1")

    r1 = await index_project(project_path=str(tmp_path))
    assert r1.files_indexed == 1

    r2 = await index_project(project_path=str(tmp_path))
    assert r2.files_skipped == 1
    assert r2.files_indexed == 0
