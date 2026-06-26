"""Tests for incremental RAG re-index (P0-4 regression).

Regression guards for the destructive ``store.upsert`` batched path that
previously wiped all chunks/vectors whenever only a subset of files changed.
"""
import hashlib as _hl

import pytest

from stupidex.rag.embedder import Embedder
from stupidex.rag.indexer import index_project
from stupidex.rag.store import RAGStore


class FakeEmbedder(Embedder):
    """Deterministic fake embedder — no network.

    Maps text -> fixed-dim vector via md5 hash so identical content yields
    identical vectors and changed content yields different vectors.
    """

    def __init__(self, dim: int = 8):
        super().__init__(model="fake-model")
        self.dim = dim

    async def embed(self, texts: list[str]) -> list[list[float]]:
        results: list[list[float]] = []
        for t in texts:
            h = _hl.md5(t.encode()).hexdigest()
            vec = [int(h[i : i + 2], 16) / 255.0 for i in range(0, self.dim * 2, 2)]
            while len(vec) < self.dim:
                vec.append(0.0)
            results.append(vec[: self.dim])
        return results


def _write(path, text: str) -> None:
    path.write_text(text, encoding="utf-8")


def _file_paths(store: RAGStore) -> set[str]:
    hashes = store.get_file_hashes()
    return set(hashes.keys())


def _vector_count(store: RAGStore) -> int:
    vectors = store._load_vectors()
    return len(vectors) if vectors else 0


@pytest.mark.asyncio
async def test_incremental_preserves_unchanged(tmp_path):
    """Re-index after editing 1 of 3 files: unchanged files' data survives."""
    _write(tmp_path / "a.py", "alpha = 1\n")
    _write(tmp_path / "b.py", "beta = 2\n")
    _write(tmp_path / "c.py", "gamma = 3\n")

    embedder = FakeEmbedder()
    await index_project(project_path=str(tmp_path), embedder=embedder)

    store = RAGStore(str(tmp_path))
    chunks_before = store.status().total_chunks
    assert _file_paths(store) == {"a.py", "b.py", "c.py"}

    # edit only a.py
    _write(tmp_path / "a.py", "alpha = 999\n")

    r = await index_project(project_path=str(tmp_path), embedder=embedder)
    assert r.files_indexed == 1
    assert r.files_skipped == 2

    # all 3 files still present
    assert _file_paths(store) == {"a.py", "b.py", "c.py"}
    # chunks still cover all 3 files
    assert store.status().total_files == 3
    # invariant: vectors == chunks
    assert _vector_count(store) == store.status().total_chunks
    # chunks count must not have collapsed to only the changed file
    assert store.status().total_chunks >= chunks_before
    assert _vector_count(store) >= 3

    # search using an embedding that matches unchanged b.py content
    b_vec = (await embedder.embed(["beta = 2\n"]))[0]
    results = store.search(b_vec, top_k=10)
    assert any(r.file_path == "b.py" for r in results), \
        "unchanged file b.py must still be searchable after incremental index"


@pytest.mark.asyncio
async def test_incremental_updates_changed_file(tmp_path):
    """After edit, changed file's chunks reflect new content; old gone."""
    _write(tmp_path / "a.py", "ORIGINAL_MARKER_TEXT = 1\n")
    _write(tmp_path / "b.py", "b = 2\n")

    embedder = FakeEmbedder()
    await index_project(project_path=str(tmp_path), embedder=embedder)

    store = RAGStore(str(tmp_path))

    # search original content -> hit
    orig_vec = (await embedder.embed(["ORIGINAL_MARKER_TEXT = 1\n"]))[0]
    orig_hits = [r for r in store.search(orig_vec, top_k=10) if r.file_path == "a.py"]
    assert orig_hits, "original content should be searchable before edit"

    # edit
    _write(tmp_path / "a.py", "REPLACEMENT_MARKER_TEXT = 1\n")
    await index_project(project_path=str(tmp_path), embedder=embedder)

    # old content no longer matches well — verify exact content of new chunk
    a_chunks = [
        c["content"]
        for c in store._get_all_chunks()
        if c["file_path"] == "a.py"
    ]
    assert any("REPLACEMENT_MARKER_TEXT" in c for c in a_chunks), \
        "new content should be indexed"
    assert not any("ORIGINAL_MARKER_TEXT" in c for c in a_chunks), \
        "old content should be gone after re-index"
    assert _vector_count(store) == store.status().total_chunks


@pytest.mark.asyncio
async def test_incremental_deleted_file(tmp_path):
    """Remove a file; its chunks/vectors gone, others remain."""
    _write(tmp_path / "keep.py", "keep = 1\n")
    _write(tmp_path / "drop.py", "drop = 2\n")

    embedder = FakeEmbedder()
    await index_project(project_path=str(tmp_path), embedder=embedder)

    store = RAGStore(str(tmp_path))
    assert _file_paths(store) == {"keep.py", "drop.py"}

    (tmp_path / "drop.py").unlink()

    r = await index_project(project_path=str(tmp_path), embedder=embedder)
    assert r.files_deleted == 1

    assert _file_paths(store) == {"keep.py"}
    assert store.status().total_files == 1
    # vectors still aligned with surviving chunks
    assert _vector_count(store) == store.status().total_chunks
    assert _vector_count(store) >= 1


@pytest.mark.asyncio
async def test_index_after_all_files_removed(tmp_path):
    """P2-145: emptying the project (no indexable files) preserves the index.

    Previously, empty discovery called ``store.clear()`` which wiped the
    entire index. Now it just touches ``last_indexed`` and returns — the
    index is preserved. Stale chunks for deleted files are cleaned up by
    the normal deletion-cleanup path when discovery finds at least one
    file (see ``test_index_project_empty_discovery_preserves_existing_index``
    in test_rag_indexer.py for the misconfigured-paths variant).
    """
    _write(tmp_path / "a.py", "a = 1\n")
    _write(tmp_path / "b.py", "b = 2\n")

    embedder = FakeEmbedder()
    await index_project(project_path=str(tmp_path), embedder=embedder)

    store = RAGStore(str(tmp_path))
    assert store.status().total_chunks >= 2

    # remove both
    (tmp_path / "a.py").unlink()
    (tmp_path / "b.py").unlink()

    r = await index_project(project_path=str(tmp_path), embedder=embedder)
    assert r.files_scanned == 0
    assert r.errors == []

    # P2-145: empty discovery no longer wipes the index.
    status = store.status()
    assert status.total_chunks >= 2
    assert status.total_files >= 2
    assert _vector_count(store) >= 2


@pytest.mark.asyncio
async def test_upsert_file_preserves_vector_chunk_invariant(tmp_path):
    """len(vectors) == len(chunks) must hold after each upsert_file call."""
    store = RAGStore(str(tmp_path))
    store.init_db()

    embedder = FakeEmbedder()
    from stupidex.rag.chunker import chunk_file

    for rel, content in [
        ("a.py", "x = 1\ny = 2\n"),
        ("b.py", "z = 3\n"),
        ("c.py", "w = 4\nv = 5\nu = 6\n"),
    ]:
        chunks = chunk_file(rel, content, chunk_size=64, chunk_overlap=8)
        embeddings = await embedder.embed([c.content for c in chunks])
        store.upsert_file(rel, chunks, embeddings)
        assert _vector_count(store) == store.status().total_chunks

    # mutate b.py and re-upsert
    chunks = chunk_file("b.py", "z = 3\nNEW = 9\n", chunk_size=64, chunk_overlap=8)
    embeddings = await embedder.embed([c.content for c in chunks])
    store.upsert_file("b.py", chunks, embeddings)
    assert _vector_count(store) == store.status().total_chunks
    assert store.status().total_files == 3
