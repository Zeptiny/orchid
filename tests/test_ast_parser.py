"""Tests for AST parser layer (U3)."""

import pytest
import tree_sitter

from stupidex.ast.parser import (
    QueryResult,
    _compiled_queries,
    _grammars,
    _parsers,
    _query_texts,
    get_parser,
    lang_for_extension,
    load_query_file,
    parse_file,
    run_query,
)


@pytest.fixture(autouse=True)
def _clear_caches():
    """Clear module-level caches before each test for isolation."""
    _grammars.clear()
    _parsers.clear()
    _compiled_queries.clear()
    _query_texts.clear()
    yield
    _grammars.clear()
    _parsers.clear()
    _compiled_queries.clear()
    _query_texts.clear()


def test_get_parser_caches_instance():
    p1 = get_parser("python")
    p2 = get_parser("python")
    assert p1 is p2
    assert isinstance(p1, tree_sitter.Parser)


def test_get_parser_different_languages():
    py = get_parser("python")
    js = get_parser("javascript")
    assert py is not js


def test_parse_file_python_function():
    source = "def foo(): pass"
    tree = parse_file("test.py", source)
    root = tree.root_node
    assert root.type == "module"
    func = root.children[0]
    assert func.type == "function_definition"
    name = func.child_by_field_name("name")
    assert name is not None
    assert name.text == b"foo"


def test_parse_file_javascript():
    source = "function bar() { return 1; }"
    tree = parse_file("test.js", source)
    root = tree.root_node
    assert root.type == "program"
    func = root.children[0]
    assert func.type == "function_declaration"


def test_parse_file_typescript():
    source = "function bar(): void {}"
    tree = parse_file("test.ts", source)
    root = tree.root_node
    assert root.type == "program"
    func = root.children[0]
    assert func.type == "function_declaration"


def test_parse_file_tsx():
    source = "function App() { return <div/>; }"
    tree = parse_file("test.tsx", source)
    root = tree.root_node
    assert root.type == "program"


def test_parse_file_unsupported_extension():
    with pytest.raises(ValueError, match="Unsupported file extension"):
        parse_file("test.txt", "hello")


def test_parse_file_syntax_error_recovery():
    source = "def foo(:\n  pass"
    tree = parse_file("test.py", source)
    assert tree.root_node is not None
    assert tree.root_node.has_error


def test_parse_file_bytes_content():
    source = b"def foo(): pass"
    tree = parse_file("test.py", source)
    assert tree.root_node.type == "module"


def test_run_query_python_captures_function():
    source = "def foo(): pass"
    tree = parse_file("test.py", source)
    query_text = load_query_file("python")
    results = run_query(tree, "python", query_text, source)

    assert "name.definition.function" in results
    names = results["name.definition.function"]
    assert len(names) == 1
    assert names[0].text == "foo"
    assert names[0].start_line == 0
    assert names[0].start_column == 4
    assert names[0].end_line == 0
    assert names[0].end_column == 7

    assert "definition.function" in results
    defs = results["definition.function"]
    assert len(defs) == 1


def test_run_query_python_captures_class():
    source = "class Foo:\n    def bar(self): pass"
    tree = parse_file("test.py", source)
    query_text = load_query_file("python")
    results = run_query(tree, "python", query_text, source)

    assert "name.definition.class" in results
    assert len(results["name.definition.class"]) == 1
    assert results["name.definition.class"][0].text == "Foo"

    assert "name.definition.function" in results
    func_names = results["name.definition.function"]
    assert len(func_names) == 1
    assert func_names[0].text == "bar"


def test_run_query_python_captures_references():
    source = "x = foo"
    tree = parse_file("test.py", source)
    query_text = load_query_file("python")
    results = run_query(tree, "python", query_text, source)

    assert "name.reference" in results
    refs = results["name.reference"]
    assert any(r.text == "foo" for r in refs)


def test_run_query_typescript_captures_function():
    source = "function bar(): void {}"
    tree = parse_file("test.ts", source)
    query_text = load_query_file("typescript")
    results = run_query(tree, "typescript", query_text, source)

    assert "name.definition.function" in results
    names = results["name.definition.function"]
    assert len(names) == 1
    assert names[0].text == "bar"


def test_run_query_typescript_captures_class():
    source = "class Foo { bar(): void {} }"
    tree = parse_file("test.ts", source)
    query_text = load_query_file("typescript")
    results = run_query(tree, "typescript", query_text, source)

    assert "name.definition.class" in results
    assert results["name.definition.class"][0].text == "Foo"

    assert "name.definition.method" in results
    assert results["name.definition.method"][0].text == "bar"


def test_tsx_uses_typescript_query():
    source = "function App(): JSX.Element { return <div/>; }"
    tree = parse_file("test.tsx", source)
    query_text = load_query_file("typescript")
    results = run_query(tree, "tsx", query_text, source)

    assert "name.definition.function" in results
    names = results["name.definition.function"]
    assert len(names) == 1
    assert names[0].text == "App"


def test_run_query_typescript_captures_named_arrow_function():
    source = "const myFunction = () => {}"
    tree = parse_file("test.ts", source)
    query_text = load_query_file("typescript")
    results = run_query(tree, "typescript", query_text, source)

    assert "name.definition.function" in results
    names = results["name.definition.function"]
    assert any(r.text == "myFunction" for r in names)

    assert "definition.function" in results


def test_query_cache_separate_by_lang():
    query_text = load_query_file("typescript")
    # Load grammars first
    get_parser("typescript")
    get_parser("tsx")

    tree_ts = parse_file("test.ts", "function bar(): void {}")
    tree_tsx = parse_file("test.tsx", "function App() { return <div/>; }")

    run_query(tree_ts, "typescript", query_text, "function bar(): void {}")
    run_query(tree_tsx, "tsx", query_text, "function App() { return <div/>; }")

    assert ("typescript", query_text) in _compiled_queries
    assert ("tsx", query_text) in _compiled_queries
    assert _compiled_queries[("typescript", query_text)] is not _compiled_queries[
        ("tsx", query_text)
    ]


def test_query_result_dataclass_fields():
    source = "def foo(): pass"
    tree = parse_file("test.py", source)
    query_text = load_query_file("python")
    results = run_query(tree, "python", query_text, source)

    result = results["name.definition.function"][0]
    assert isinstance(result, QueryResult)
    assert result.text == "foo"
    assert result.start_line == 0
    assert result.start_column == 4
    assert result.end_line == 0
    assert result.end_column == 7
    assert result.start_byte == 4
    assert result.end_byte == 7
    assert isinstance(result.node, tree_sitter.Node)


def test_lang_for_extension():
    assert lang_for_extension("foo.py") == "python"
    assert lang_for_extension("foo.js") == "javascript"
    assert lang_for_extension("foo.jsx") == "javascript"
    assert lang_for_extension("foo.ts") == "typescript"
    assert lang_for_extension("foo.tsx") == "tsx"


def test_lang_for_extension_unsupported():
    with pytest.raises(ValueError, match="Unsupported"):
        lang_for_extension("foo.txt")


def test_load_query_file_python():
    text = load_query_file("python")
    assert "function_definition" in text
    assert "class_definition" in text
    assert "name.definition.function" in text
    assert "name.definition.class" in text
    assert "name.reference" in text


def test_load_query_file_javascript():
    text = load_query_file("javascript")
    assert "function_declaration" in text
    assert "class_declaration" in text
    assert "arrow_function" in text
    assert "method_definition" in text


def test_load_query_file_typescript():
    text = load_query_file("typescript")
    assert "function_declaration" in text
    assert "class_declaration" in text
    assert "arrow_function" in text
    assert "method_definition" in text


def test_load_query_file_tsx_uses_typescript():
    text = load_query_file("tsx")
    ts_text = load_query_file("typescript")
    assert text is ts_text


def test_load_query_file_unsupported():
    with pytest.raises(ValueError, match="No query file"):
        load_query_file("rust")


def test_all_query_files_compile():
    for lang in ("python", "javascript", "typescript"):
        query_text = load_query_file(lang)
        get_parser(lang)
        # Verify query compiles against the grammar
        query = _compiled_queries.get((lang, query_text))
        if query is None:
            from stupidex.ast.parser import _compile_query

            query = _compile_query(lang, query_text)
        assert isinstance(query, tree_sitter.Query)


def test_run_query_with_string_source():
    source = "def foo(): pass"
    tree = parse_file("test.py", source)
    query_text = load_query_file("python")
    # run_query accepts str source
    results = run_query(tree, "python", query_text, source)
    assert results["name.definition.function"][0].text == "foo"
