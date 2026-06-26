import ctypes
import logging
from dataclasses import dataclass
from pathlib import Path

import tree_sitter

logger = logging.getLogger(__name__)

_QUERIES_DIR = Path(__file__).parent / "queries"

_EXT_TO_LANG: dict[str, str] = {
    ".py": "python",
    ".js": "javascript",
    ".jsx": "javascript",
    ".ts": "typescript",
    ".tsx": "tsx",
}

_LANG_TO_QUERY_LANG: dict[str, str] = {
    "python": "python",
    "javascript": "javascript",
    "typescript": "typescript",
    "tsx": "typescript",
}

_grammars: dict[str, tree_sitter.Language] = {}
_parsers: dict[str, tree_sitter.Parser] = {}
_compiled_queries: dict[tuple[str, str], tree_sitter.Query] = {}
_query_texts: dict[str, str] = {}


@dataclass(frozen=True)
class QueryResult:
    node: tree_sitter.Node
    text: str
    start_line: int
    start_column: int
    end_line: int
    end_column: int
    start_byte: int
    end_byte: int


def _load_language(lang_name: str) -> tree_sitter.Language:
    from tree_sitter_language_pack import get_language

    if lang_name not in _grammars:
        logger.debug("Loading grammar for %s", lang_name)
        get_language(lang_name)
        so_name = lang_name
        so_path = Path("~/.cache/tree-sitter-language-pack").expanduser()
        for version_dir in sorted(so_path.iterdir(), reverse=True):
            candidate = version_dir / "libs" / f"libtree_sitter_{so_name}.so"
            if candidate.exists():
                lib = ctypes.cdll.LoadLibrary(str(candidate))
                func = getattr(lib, f"tree_sitter_{so_name}")
                func.restype = ctypes.c_void_p
                _grammars[lang_name] = tree_sitter.Language(func())
                break
        else:
            raise RuntimeError(
                f"Could not find compiled grammar for '{lang_name}'"
            )
    return _grammars[lang_name]


def _load_query_text(query_lang: str) -> str:
    if query_lang not in _query_texts:
        query_file = _QUERIES_DIR / f"{query_lang}.scm"
        if not query_file.exists():
            raise FileNotFoundError(f"Query file not found: {query_file}")
        _query_texts[query_lang] = query_file.read_text()
    return _query_texts[query_lang]


def get_parser(lang_name: str) -> tree_sitter.Parser:
    if lang_name not in _parsers:
        lang = _load_language(lang_name)
        _parsers[lang_name] = tree_sitter.Parser(lang)
    return _parsers[lang_name]


def lang_for_extension(file_path: str) -> str:
    ext = Path(file_path).suffix.lower()
    lang = _EXT_TO_LANG.get(ext)
    if lang is None:
        raise ValueError(
            f"Unsupported file extension '{ext}'. "
            f"Supported: {', '.join(sorted(_EXT_TO_LANG.keys()))}"
        )
    return lang


def parse_file(file_path: str, content: str | bytes) -> tree_sitter.Tree:
    lang_name = lang_for_extension(file_path)
    parser = get_parser(lang_name)
    if isinstance(content, str):
        content = content.encode("utf-8")
    return parser.parse(content)


def run_query(
    tree: tree_sitter.Tree,
    lang_name: str,
    query_text: str,
    source: str | bytes,
) -> dict[str, list[QueryResult]]:
    if isinstance(source, str):
        source = source.encode("utf-8")

    query = _compile_query(lang_name, query_text)
    cursor = tree_sitter.QueryCursor(query)
    captures = cursor.captures(tree.root_node)

    results: dict[str, list[QueryResult]] = {}
    for cap_name, nodes in captures.items():
        entries: list[QueryResult] = []
        for node in nodes:
            entries.append(
                QueryResult(
                    node=node,
                    text=source[node.start_byte : node.end_byte].decode(
                        "utf-8", errors="replace"
                    ),
                    start_line=node.start_point.row,
                    start_column=node.start_point.column,
                    end_line=node.end_point.row,
                    end_column=node.end_point.column,
                    start_byte=node.start_byte,
                    end_byte=node.end_byte,
                )
            )
        results[cap_name] = entries

    return results


def _compile_query(lang_name: str, query_text: str) -> tree_sitter.Query:
    key = (lang_name, query_text)
    if key not in _compiled_queries:
        lang = _load_language(lang_name)
        logger.debug("Compiling query for %s", lang_name)
        _compiled_queries[key] = tree_sitter.Query(lang, query_text)
    return _compiled_queries[key]


def load_query_file(lang_name: str) -> str:
    query_lang = _LANG_TO_QUERY_LANG.get(lang_name)
    if query_lang is None:
        raise ValueError(f"No query file for language '{lang_name}'")
    return _load_query_text(query_lang)
