"""Tests for AST symbol store."""


from stupidex.ast.store import ASTStore
from stupidex.ast.symbols import Symbol


def _make_symbol(
    name="foo",
    type_="definition",
    kind="function",
    start_line=1,
    start_column=0,
    end_line=3,
    end_column=0,
    char_start=0,
    char_end=30,
) -> Symbol:
    return Symbol(
        name=name,
        type=type_,
        kind=kind,
        start_line=start_line,
        start_column=start_column,
        end_line=end_line,
        end_column=end_column,
        char_start=char_start,
        char_end=char_end,
    )


def test_init_db_creates_tables(tmp_path):
    """init_db should create files, symbols, and meta tables."""
    store = ASTStore(str(tmp_path))
    store.init_db()

    conn = store._get_conn()
    try:
        tables = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()
        table_names = {t[0] for t in tables}
        assert "files" in table_names
        assert "symbols" in table_names
        assert "meta" in table_names
    finally:
        conn.close()


def test_init_db_creates_indexes(tmp_path):
    """init_db should create indexes on symbols(name) and symbols(file_path)."""
    store = ASTStore(str(tmp_path))
    store.init_db()

    conn = store._get_conn()
    try:
        indexes = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='index'"
        ).fetchall()
        index_names = {i[0] for i in indexes}
        assert "idx_symbols_name" in index_names
        assert "idx_symbols_file" in index_names
    finally:
        conn.close()


def test_init_db_creates_directory(tmp_path):
    """init_db should create the ast directory."""
    store = ASTStore(str(tmp_path))
    store.init_db()
    assert (tmp_path / ".stupidex" / "ast").exists()


def test_upsert_file_stores_symbols_and_hash(tmp_path):
    """upsert_file should store symbols and update the file hash."""
    store = ASTStore(str(tmp_path))
    store.init_db()

    symbols = [
        _make_symbol(name="foo", type_="definition"),
        _make_symbol(name="bar", type_="reference"),
    ]
    store.upsert_file("a.py", "abc123", symbols)

    assert store.get_file_hash("a.py") == "abc123"

    results = store.get_symbols_by_name("foo", "both")
    assert len(results) == 1
    assert results[0]["name"] == "foo"
    assert results[0]["type"] == "definition"


def test_get_symbols_by_name_definition_filter(tmp_path):
    """get_symbols_by_name with 'definition' filter returns only definitions."""
    store = ASTStore(str(tmp_path))
    store.init_db()

    symbols = [
        _make_symbol(name="foo", type_="definition"),
        _make_symbol(name="foo", type_="reference"),
    ]
    store.upsert_file("a.py", "h1", symbols)

    results = store.get_symbols_by_name("foo", "definition")
    assert len(results) == 1
    assert results[0]["type"] == "definition"


def test_get_symbols_by_name_both_filter(tmp_path):
    """get_symbols_by_name with 'both' returns definitions and references."""
    store = ASTStore(str(tmp_path))
    store.init_db()

    symbols = [
        _make_symbol(name="foo", type_="definition"),
        _make_symbol(name="foo", type_="reference"),
    ]
    store.upsert_file("a.py", "h1", symbols)

    results = store.get_symbols_by_name("foo", "both")
    assert len(results) == 2
    types = {r["type"] for r in results}
    assert types == {"definition", "reference"}


def test_upsert_file_replaces_old_symbols(tmp_path):
    """Upserting the same file twice should replace old symbols, not duplicate."""
    store = ASTStore(str(tmp_path))
    store.init_db()

    symbols1 = [
        _make_symbol(name="foo", type_="definition"),
        _make_symbol(name="bar", type_="definition"),
    ]
    store.upsert_file("a.py", "h1", symbols1)
    assert len(store.get_symbols_by_name("foo", "both")) == 1
    assert len(store.get_symbols_by_name("bar", "both")) == 1

    symbols2 = [
        _make_symbol(name="baz", type_="definition"),
    ]
    store.upsert_file("a.py", "h2", symbols2)
    assert len(store.get_symbols_by_name("foo", "both")) == 0
    assert len(store.get_symbols_by_name("bar", "both")) == 0
    assert len(store.get_symbols_by_name("baz", "both")) == 1
    assert store.get_file_hash("a.py") == "h2"


def test_upsert_file_empty_symbols_clears_existing(tmp_path):
    """Upserting with an empty symbols list should clear existing symbols."""
    store = ASTStore(str(tmp_path))
    store.init_db()

    symbols = [_make_symbol(name="foo", type_="definition")]
    store.upsert_file("a.py", "h1", symbols)
    assert len(store.get_symbols_by_name("foo", "both")) == 1

    store.upsert_file("a.py", "h2", [])
    assert len(store.get_symbols_by_name("foo", "both")) == 0
    assert store.get_file_hash("a.py") == "h2"


def test_corrupted_db_triggers_rebuild(tmp_path):
    """Writing garbage to the .db file should trigger auto-rebuild on next _get_conn."""
    store = ASTStore(str(tmp_path))
    store.init_db()

    symbols = [_make_symbol(name="foo", type_="definition")]
    store.upsert_file("a.py", "h1", symbols)

    store.db_path.write_bytes(b"not a valid sqlite database")

    conn = store._get_conn()
    try:
        tables = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()
        table_names = {t[0] for t in tables}
        assert "files" in table_names
        assert "symbols" in table_names
    finally:
        conn.close()


def test_get_file_hash_unindexed_returns_empty(tmp_path):
    """get_file_hash for a file never indexed should return empty string."""
    store = ASTStore(str(tmp_path))
    store.init_db()
    assert store.get_file_hash("nonexistent.py") == ""


def test_get_file_hash_no_db_returns_empty(tmp_path):
    """get_file_hash when DB doesn't exist should return empty string."""
    store = ASTStore(str(tmp_path))
    assert store.get_file_hash("nonexistent.py") == ""


def test_get_all_file_hashes(tmp_path):
    """get_all_file_hashes returns a dict usable by the indexer."""
    store = ASTStore(str(tmp_path))
    store.init_db()

    store.upsert_file("a.py", "h1", [_make_symbol(name="foo")])
    store.upsert_file("b.py", "h2", [_make_symbol(name="bar")])

    hashes = store.get_all_file_hashes()
    assert isinstance(hashes, dict)
    assert hashes["a.py"] == "h1"
    assert hashes["b.py"] == "h2"


def test_get_all_file_hashes_empty(tmp_path):
    """get_all_file_hashes on empty store returns empty dict."""
    store = ASTStore(str(tmp_path))
    store.init_db()
    assert store.get_all_file_hashes() == {}


def test_get_all_file_hashes_no_db(tmp_path):
    """get_all_file_hashes when DB doesn't exist returns empty dict."""
    store = ASTStore(str(tmp_path))
    assert store.get_all_file_hashes() == {}


def test_clear_removes_db(tmp_path):
    """clear should remove the database file."""
    store = ASTStore(str(tmp_path))
    store.init_db()
    store.upsert_file("a.py", "h1", [_make_symbol(name="foo")])

    store.clear()
    assert not store.db_path.exists()


def test_symbols_preserve_all_fields(tmp_path):
    """Upserted symbols should preserve all fields correctly."""
    store = ASTStore(str(tmp_path))
    store.init_db()

    symbol = Symbol(
        name="my_func",
        type="definition",
        kind="method",
        start_line=10,
        start_column=4,
        end_line=20,
        end_column=1,
        char_start=100,
        char_end=200,
    )
    store.upsert_file("cls.py", "hash1", [symbol])

    results = store.get_symbols_by_name("my_func", "definition")
    assert len(results) == 1
    r = results[0]
    assert r["file_path"] == "cls.py"
    assert r["kind"] == "method"
    assert r["start_line"] == 10
    assert r["start_column"] == 4
    assert r["end_line"] == 20
    assert r["end_column"] == 1
    assert r["char_start"] == 100
    assert r["char_end"] == 200


def test_multiple_files_independent(tmp_path):
    """Symbols from different files don't interfere."""
    store = ASTStore(str(tmp_path))
    store.init_db()

    store.upsert_file("a.py", "h1", [_make_symbol(name="foo", type_="definition")])
    store.upsert_file("b.py", "h2", [_make_symbol(name="foo", type_="reference")])

    all_foo = store.get_symbols_by_name("foo", "both")
    assert len(all_foo) == 2

    defs = store.get_symbols_by_name("foo", "definition")
    assert len(defs) == 1
    assert defs[0]["file_path"] == "a.py"

    refs = store.get_symbols_by_name("foo", "reference")
    assert len(refs) == 1
    assert refs[0]["file_path"] == "b.py"


def test_symbol_count_in_files_table(tmp_path):
    """Files table should track the symbol count."""
    store = ASTStore(str(tmp_path))
    store.init_db()

    store.upsert_file("a.py", "h1", [_make_symbol(), _make_symbol(name="bar")])

    conn = store._get_conn()
    try:
        row = conn.execute(
            "SELECT symbol_count FROM files WHERE file_path = 'a.py'"
        ).fetchone()
        assert row[0] == 2
    finally:
        conn.close()
