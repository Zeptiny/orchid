"""RAG Pipeline: file discovery -> chunking -> embedding -> vector store."""

import asyncio
import hashlib
import logging
import os
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from stupidex.config import get_config

from .chunker import chunk_file
from .embedder import Embedder
from .store import RAGStore, StoreStatus

logger = logging.getLogger(__name__)

INCLUDE_EXTS = frozenset({
    ".py", ".ts", ".tsx", ".js", ".jsx", ".md", ".txt",
    ".yaml", ".yml", ".toml", ".json", ".sql", ".sh",
    ".rs", ".go", ".java", ".c", ".cpp", ".h", ".hpp",
    ".css", ".html", ".rb", ".php", ".swift", ".kt",
})

SKIP_EXTS = frozenset({".pyc", ".pyo", ".pyd", ".so", ".dll", ".exe"})

_indexing: bool = False


def is_indexing() -> bool:
    return _indexing


@dataclass
class IndexResult:
    files_scanned: int = 0
    files_indexed: int = 0
    files_skipped: int = 0
    files_deleted: int = 0
    chunks_created: int = 0
    errors: list[str] = field(default_factory=list)
    duration_seconds: float = 0.0


async def update_file(file_path: str, project_path: str | None = None) -> None:
    """Re-index a single file in the RAG store (used by post-write callbacks).

    Uses the batch vector-state API so a single-file re-index performs one
    sqlite write + one vectors.npy flush instead of N reads + N writes.
    """
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

    store = RAGStore(project_path)
    store.init_db()

    if not _should_include(filepath):
        await loop.run_in_executor(None, store.delete_by_file, rel)
        return

    content, file_hash = await loop.run_in_executor(None, _read_and_hash, filepath)
    if content is None:
        await loop.run_in_executor(None, store.delete_by_file, rel)
        return

    cfg = get_config()
    chunks = chunk_file(rel, content, cfg.rag.chunk_size, cfg.rag.chunk_overlap)
    if not chunks:
        await loop.run_in_executor(None, store.delete_by_file, rel)
        return

    try:
        embedder = Embedder(model=cfg.rag.embedding_model or None)
        texts = [c.content for c in chunks]
        embeddings = await embedder.embed(texts)
    except Exception as e:
        logger.warning("RAG update_file embedding failed for %s: %s", rel, e)
        return

    # Batch path: load vector state once, upsert, flush — 1 vectors.npy write.
    def _upsert_and_flush() -> None:
        state = store.load_vector_state()
        store.upsert_file_batch(state, rel, chunks, embeddings)
        store.flush_vector_state(state)
        if file_hash:
            store.update_file_hash(rel, file_hash)

    await loop.run_in_executor(None, _upsert_and_flush)


async def index_project(
    project_path: str | None = None,
    paths: list[str] | None = None,
    force: bool = False,
    embedder: Embedder | None = None,
    progress_callback: Callable | None = None,
) -> IndexResult:
    """Run the full RAG indexing pipeline.

    Args:
        project_path: Root directory of the project. Uses cwd if None.
        paths: Specific files/dirs to index. None = entire project.
        force: If True, re-index everything regardless of hash.
        embedder: Embedder instance. Creates one with defaults if None.
        progress_callback: Optional ``(file_path, done, total) -> None``.

    Returns:
        IndexResult with stats about the run.
    """
    global _indexing
    if _indexing:
        logger.warning("RAG indexing already in progress, skipping")
        return IndexResult()
    _indexing = True
    try:
        return await _index_project_impl(
            project_path=project_path,
            paths=paths,
            force=force,
            embedder=embedder,
            progress_callback=progress_callback,
        )
    finally:
        _indexing = False


async def _index_project_impl(
    project_path: str | None = None,
    paths: list[str] | None = None,
    force: bool = False,
    embedder: Embedder | None = None,
    progress_callback: Callable | None = None,
) -> IndexResult:
    cfg = get_config()
    if project_path is None:
        project_path = str(Path.cwd())

    t0 = asyncio.get_event_loop().time()
    loop = asyncio.get_event_loop()

    # --- discovery (I/O-heavy -> thread) ---
    files = await loop.run_in_executor(
        None, _discover_files, Path(project_path), paths, cfg.ignored_dirs
    )
    stats = IndexResult(files_scanned=len(files))

    if not files:
        store = RAGStore(project_path)
        store.init_db()
        await loop.run_in_executor(None, store.touch_last_indexed)
        stats.duration_seconds = asyncio.get_event_loop().time() - t0
        return stats

    store = RAGStore(project_path)
    store.init_db()

    if embedder is None:
        embedder = Embedder(model=cfg.rag.embedding_model or None)

    existing_hashes: dict[str, str] = await loop.run_in_executor(
        None, store.get_file_hashes
    )
    if force:
        existing_hashes = {path: "" for path in existing_hashes}

    indexed_files: set[str] = set()
    file_hashes: dict[str, str] = {}

    # P2-139/P2-182: dropped the embed(["test"]) probe — it burned a paid API
    # call (or ONNX inference) on every index run. Embedding failures are
    # already handled per-file in the loop below and surface in stats.errors.

    # Load vector state once; batch ops mutate it in place and flush at end.
    state = await loop.run_in_executor(None, store.load_vector_state)

    for i, filepath in enumerate(files):
        try:
            rel = str(filepath.relative_to(project_path))
        except ValueError:
            logger.warning("Skipping path outside project: %s", filepath)
            continue

        if progress_callback:
            try:
                progress_callback(rel, i, len(files))
            except Exception as e:
                logger.debug("progress_callback error: %s", e)

        try:
            # read + hash in executor
            content, file_hash = await loop.run_in_executor(
                None, _read_and_hash, filepath
            )

            if content is None:
                logger.debug("Skipping %s (binary, empty, or too large)", rel)
                if rel in existing_hashes:
                    await loop.run_in_executor(
                        None, store.delete_by_file_batch, state, rel
                    )
                continue

            # skip unchanged
            if not force and existing_hashes.get(rel) == file_hash:
                stats.files_skipped += 1
                indexed_files.add(rel)
                continue

            # chunk
            chunks = chunk_file(rel, content, cfg.rag.chunk_size, cfg.rag.chunk_overlap)
            if not chunks:
                if rel in existing_hashes:
                    await loop.run_in_executor(
                        None, store.delete_by_file_batch, state, rel
                    )
                indexed_files.add(rel)
                continue

            # embed
            texts = [c.content for c in chunks]
            embeddings = await embedder.embed(texts)

            await loop.run_in_executor(
                None, store.upsert_file_batch, state, rel, chunks, embeddings
            )
            stats.files_indexed += 1
            stats.chunks_created += len(chunks)
            indexed_files.add(rel)
            if file_hash:
                file_hashes[rel] = file_hash

        except Exception as e:
            msg = f"{rel}: {e}"
            logger.warning("Indexing error: %s", msg)
            stats.errors.append(msg)

    # P2-158: batch all file-hash updates into a single sqlite transaction
    # instead of one connection-per-file in a loop.
    hashes_to_update = {
        rel: h for rel, h in file_hashes.items() if rel in indexed_files
    }
    if hashes_to_update:
        try:
            await loop.run_in_executor(
                None, store.update_file_hashes_batch, hashes_to_update
            )
        except Exception as e:
            logger.warning("Batch hash update failed: %s", e)

    # remove files deleted since last index
    if existing_hashes:
        current_rels: set[str] = set()
        for f in files:
            try:
                current_rels.add(str(f.relative_to(project_path)))
            except ValueError:
                pass
        for stored_path in existing_hashes:
            if stored_path not in current_rels:
                await loop.run_in_executor(
                    None, store.delete_by_file_batch, state, stored_path
                )
                stats.files_deleted += 1

    await loop.run_in_executor(None, store.flush_vector_state, state)

    stats.duration_seconds = asyncio.get_event_loop().time() - t0

    await loop.run_in_executor(None, store.record_index_duration, stats.duration_seconds)

    logger.info(
        "Index complete: %d indexed, %d skipped, %d deleted, %d chunks in %.1fs",
        stats.files_indexed,
        stats.files_skipped,
        stats.files_deleted,
        stats.chunks_created,
        stats.duration_seconds,
    )
    return stats


def get_status(project_path: str | None = None) -> StoreStatus:
    """Return current index status without running a new index."""
    if project_path is None:
        project_path = str(Path.cwd())
    store = RAGStore(project_path)
    return store.status()


def clear_index(project_path: str | None = None) -> None:
    """Delete the RAG index for a project."""
    if project_path is None:
        project_path = str(Path.cwd())
    store = RAGStore(project_path)
    store.clear()


# ---------------------------------------------------------------------------
# internal helpers
# ---------------------------------------------------------------------------

def _discover_files(
    root: Path,
    paths: list[str] | None,
    ignored_dirs: list[str],
) -> list[Path]:
    skip = set(ignored_dirs) | {
        "node_modules", ".git", "__pycache__",
        ".venv", "venv", "env",
        ".stupidex", "dist", "build",
        ".next", ".cache", "target",
    }

    if paths:
        result: list[Path] = []
        for p_str in paths:
            p = Path(p_str)
            if not p.is_absolute():
                p = root / p
            if p.is_file() and _should_include(p):
                result.append(p)
            elif p.is_dir():
                result.extend(_walk(p, skip))
        return sorted(set(result))

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
    ext = filepath.suffix.lower()
    if ext in SKIP_EXTS:
        return False
    return ext in INCLUDE_EXTS


def _read_and_hash(filepath: Path) -> tuple[str | None, str | None]:
    """Read file content and compute MD5 hash. Returns (content, hash)."""
    cfg = get_config()
    try:
        size = filepath.stat().st_size
        if size > cfg.rag.max_file_size:
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
