"""AST indexing: project walk -> parse -> symbol extraction -> hash store."""

import asyncio
import hashlib
import logging
import os
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from stupidex.ast.parser import lang_for_extension, load_query_file, parse_file, run_query
from stupidex.ast.store import ASTStore
from stupidex.ast.symbols import Symbol
from stupidex.config import get_config

logger = logging.getLogger(__name__)

AST_INCLUDE_EXTS = frozenset({".py", ".js", ".jsx", ".ts", ".tsx"})

_SKIP_DIRS = frozenset({
    "node_modules", ".git", "__pycache__",
    ".venv", "venv", "env",
    ".stupidex", "dist", "build",
    ".next", ".cache", "target",
})

_session_initialized: bool = False
_indexing: bool = False


def is_indexing() -> bool:
    return _indexing


@dataclass
class IndexResult:
    files_scanned: int = 0
    files_indexed: int = 0
    files_skipped: int = 0
    files_deleted: int = 0
    symbols_extracted: int = 0
    errors: list[str] = field(default_factory=list)
    duration_seconds: float = 0.0


async def ensure_indexed(project_path: str | None = None) -> None:
    """Trigger a full project scan if the session hasn't been initialized.

    Index-dependent tools (find_symbol_references, rename_symbol) call this
    before querying the store. Index-independent tools (get_file_skeleton,
    get_function) parse files directly and do not call this.
    """
    global _session_initialized
    if _session_initialized:
        return
    if _indexing:
        while _indexing and not _session_initialized:
            await asyncio.sleep(0.1)
        return
    await index_project(project_path=project_path)


async def update_file(file_path: str, project_path: str | None = None) -> None:
    """Re-index a single file (used by post-write callbacks)."""
    if project_path is None:
        project_path = str(Path.cwd())
    loop = asyncio.get_running_loop()

    filepath = Path(file_path)
    if not filepath.is_absolute():
        filepath = Path(project_path) / file_path

    try:
        rel = str(filepath.relative_to(project_path))
    except ValueError:
        return

    store = ASTStore(project_path)
    store.init_db()

    content, file_hash = await loop.run_in_executor(None, _read_and_hash, filepath)
    if content is None or file_hash is None:
        await loop.run_in_executor(None, store.delete_by_file, rel)
        return

    symbols = _extract_symbols(rel, content)
    assert file_hash is not None
    await loop.run_in_executor(None, store.upsert_file, rel, file_hash, symbols)


async def index_project(
    project_path: str | None = None,
    force: bool = False,
    progress_callback: Callable | None = None,
) -> IndexResult:
    """Run a full AST indexing scan of the project.

    Args:
        project_path: Root directory of the project. Uses cwd if None.
        force: If True, re-parse all files regardless of hash. Used by
            ``/index-ast`` command.
        progress_callback: Optional ``(file_path, done, total) -> None``.

    Returns:
        IndexResult with stats about the run.
    """
    global _session_initialized, _indexing

    if _indexing:
        logger.warning("AST indexing already in progress, skipping")
        return IndexResult()
    _indexing = True
    try:
        return await _index_project_impl(
            project_path=project_path,
            force=force,
            progress_callback=progress_callback,
        )
    finally:
        _indexing = False


async def _index_project_impl(
    project_path: str | None = None,
    force: bool = False,
    progress_callback: Callable | None = None,
) -> IndexResult:
    global _session_initialized

    cfg = get_config()
    if project_path is None:
        project_path = str(Path.cwd())

    loop = asyncio.get_running_loop()
    t0 = loop.time()

    files = await loop.run_in_executor(
        None, _discover_files, Path(project_path), cfg.ignored_dirs
    )
    result = IndexResult(files_scanned=len(files))

    store = ASTStore(project_path)
    store.init_db()

    existing_hashes: dict[str, str] = await loop.run_in_executor(
        None, store.get_all_file_hashes
    )

    indexed_files: set[str] = set()

    for i, filepath in enumerate(files):
        try:
            rel = str(filepath.relative_to(project_path))
        except ValueError:
            logger.warning("Skipping path outside project: %s", filepath)
            continue

        if progress_callback:
            try:
                progress_callback(rel, i, len(files))
            except Exception:
                pass

        try:
            content, file_hash = await loop.run_in_executor(
                None, _read_and_hash, filepath
            )

            if content is None or file_hash is None:
                logger.debug("Skipping %s (binary, empty, or too large)", rel)
                if existing_hashes.get(rel):
                    await loop.run_in_executor(None, store.delete_by_file, rel)
                continue

            if not force and existing_hashes.get(rel) == file_hash:
                result.files_skipped += 1
                indexed_files.add(rel)
                continue

            symbols = _extract_symbols(rel, content)
            assert file_hash is not None
            await loop.run_in_executor(
                None, store.upsert_file, rel, file_hash, symbols
            )
            result.files_indexed += 1
            result.symbols_extracted += len(symbols)
            indexed_files.add(rel)

        except Exception as e:
            msg = f"{rel}: {e}"
            logger.warning("AST indexing error: %s", msg)
            result.errors.append(msg)

    for stored_path in existing_hashes:
        if stored_path not in indexed_files:
            await loop.run_in_executor(None, store.delete_by_file, stored_path)
            result.files_deleted += 1

    result.duration_seconds = loop.time() - t0
    _session_initialized = True

    await loop.run_in_executor(None, store.record_index, result.duration_seconds)

    logger.info(
        "AST index complete: %d indexed, %d skipped, %d deleted, %d symbols in %.1fs",
        result.files_indexed,
        result.files_skipped,
        result.files_deleted,
        result.symbols_extracted,
        result.duration_seconds,
    )
    return result


# ---------------------------------------------------------------------------
# internal helpers
# ---------------------------------------------------------------------------


def _discover_files(
    root: Path,
    ignored_dirs: list[str],
) -> list[Path]:
    skip = set(ignored_dirs) | _SKIP_DIRS
    return sorted(_walk(root, skip))


def _walk(directory: Path, skip: set[str]) -> list[Path]:
    files: list[Path] = []
    try:
        entries = list(os.scandir(directory))
    except PermissionError:
        return files

    for entry in entries:
        if entry.is_dir(follow_symlinks=False):
            if entry.name not in skip:
                files.extend(_walk(Path(entry.path), skip))
        elif entry.is_file(follow_symlinks=False):
            p = Path(entry.path)
            if _should_include(p):
                files.append(p)
    return files


def _should_include(filepath: Path) -> bool:
    return filepath.suffix.lower() in AST_INCLUDE_EXTS


def _read_and_hash(filepath: Path) -> tuple[str | None, str | None]:
    """Read file content and compute MD5 hash. Returns (content, hash).

    Returns (None, None) for files that should be skipped: too large,
    empty, or binary (containing NUL bytes).
    """
    cfg = get_config()
    try:
        size = filepath.stat().st_size
        if size > cfg.ast_max_file_size:
            logger.debug("Skipping %s (%d bytes > limit)", filepath, size)
            return None, None
        if size == 0:
            return None, None

        content = filepath.read_text(encoding="utf-8", errors="replace")
        if "\0" in content:
            return None, None

        h = hashlib.md5(content.encode("utf-8")).hexdigest()
        return content, h
    except Exception:
        return None, None


def _extract_symbols(file_path: str, content: str) -> list[Symbol]:
    """Parse file and extract symbols from tree-sitter captures."""
    try:
        lang_name = lang_for_extension(file_path)
    except ValueError:
        return []

    query_text = load_query_file(lang_name)
    tree = parse_file(file_path, content)
    captures = run_query(tree, lang_name, query_text, content)

    symbols: list[Symbol] = []
    seen: set[tuple[str, str, str, int, int, int, int]] = set()

    for cap_name, results in captures.items():
        if cap_name.startswith("name.definition."):
            kind = cap_name[len("name.definition."):]
            for r in results:
                key = (r.text, "definition", kind, r.start_line, r.start_column,
                       r.end_line, r.end_column)
                if key not in seen:
                    seen.add(key)
                    symbols.append(Symbol(
                        name=r.text,
                        type="definition",
                        kind=kind,
                        start_line=r.start_line,
                        start_column=r.start_column,
                        end_line=r.end_line,
                        end_column=r.end_column,
                        char_start=r.start_byte,
                        char_end=r.end_byte,
                    ))
        elif cap_name == "name.reference":
            for r in results:
                key = (r.text, "reference", "", r.start_line, r.start_column,
                       r.end_line, r.end_column)
                if key not in seen:
                    seen.add(key)
                    symbols.append(Symbol(
                        name=r.text,
                        type="reference",
                        kind="",
                        start_line=r.start_line,
                        start_column=r.start_column,
                        end_line=r.end_line,
                        end_column=r.end_column,
                        char_start=r.start_byte,
                        char_end=r.end_byte,
                    ))

    return symbols
