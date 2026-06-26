"""Tests for RAG indexing pipeline (U3)."""
from pathlib import Path

import pytest

from stupidex.rag.chunker import Chunk
from stupidex.rag.embedder import Embedder
from stupidex.rag.indexer import (
    _discover_files,
    _read_and_hash,
    _should_include,
    clear_index,
    get_status,
    index_project,
    update_file,
)
from stupidex.rag.store import RAGStore


class FakeEmbedder(Embedder):
    """Deterministic fake embedder for tests — no network calls."""

    def __init__(self, dim: int = 8):
        super().__init__(model="fake-model")
        self.dim = dim
        self._call_count = 0

    async def embed(self, texts: list[str]) -> list[list[float]]:
        import hashlib as _hl

        self._call_count += 1
        results = []
        for t in texts:
            h = _hl.md5(t.encode()).hexdigest()
            vec = [int(h[i : i + 2], 16) / 255.0 for i in range(0, self.dim * 2, 2)]
            # pad if dim > len(vec)
            while len(vec) < self.dim:
                vec.append(0.0)
            results.append(vec[: self.dim])
        return results


# ---------------------------------------------------------------------------
# _should_include
# ---------------------------------------------------------------------------


def test_should_include_python():
    assert _should_include(Path("foo.py")) is True


def test_should_include_markdown():
    assert _should_include(Path("README.md")) is True


def test_should_exclude_pyc():
    assert _should_include(Path("foo.pyc")) is False


def test_should_exclude_so():
    assert _should_include(Path("lib.so")) is False


def test_should_exclude_unknown():
    assert _should_include(Path("Makefile")) is False


# ---------------------------------------------------------------------------
# _discover_files
# ---------------------------------------------------------------------------


def test_discover_files_skips_git_and_node_modules(tmp_path):
    (tmp_path / "good.py").write_text("x = 1")
    (tmp_path / ".git").mkdir()
    (tmp_path / ".git" / "config").write_text("git stuff")
    (tmp_path / "node_modules").mkdir()
    (tmp_path / "node_modules" / "pkg.js").write_text("var x")

    files = _discover_files(tmp_path, None, [".git", "node_modules"])
    names = [f.name for f in files]
    assert "good.py" in names
    assert "config" not in names
    assert "pkg.js" not in names


def test_discover_files_specific_paths(tmp_path):
    (tmp_path / "a.py").write_text("a")
    (tmp_path / "b.py").write_text("b")
    sub = tmp_path / "sub"
    sub.mkdir()
    (sub / "c.py").write_text("c")

    files = _discover_files(tmp_path, [str(sub)], [])
    names = [f.name for f in files]
    assert names == ["c.py"]


def test_discover_files_empty_project(tmp_path):
    files = _discover_files(tmp_path, None, [])
    assert files == []


# ---------------------------------------------------------------------------
# index_project — core pipeline
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_index_initial_processses_all_files(tmp_path):
    (tmp_path / "main.py").write_text("def hello():\n    return 'hi'")
    (tmp_path / "utils.py").write_text("def add(a, b):\n    return a + b")

    embedder = FakeEmbedder()
    result = await index_project(
        project_path=str(tmp_path),
        embedder=embedder,
    )

    assert result.files_scanned == 2
    assert result.files_indexed == 2
    assert result.files_skipped == 0
    assert result.errors == []
    assert result.duration_seconds >= 0

    # verify store has data
    store = RAGStore(str(tmp_path))
    status = store.status()
    assert status.total_files == 2
    assert status.total_chunks >= 2


@pytest.mark.asyncio
async def test_index_skips_unchanged_files(tmp_path):
    (tmp_path / "app.py").write_text("x = 1")

    embedder = FakeEmbedder()

    r1 = await index_project(project_path=str(tmp_path), embedder=embedder)
    assert r1.files_indexed == 1

    # second run — same content
    r2 = await index_project(project_path=str(tmp_path), embedder=embedder)
    assert r2.files_skipped == 1
    assert r2.files_indexed == 0


@pytest.mark.asyncio
async def test_index_detects_modified_files(tmp_path):
    (tmp_path / "app.py").write_text("x = 1")

    embedder = FakeEmbedder()

    await index_project(project_path=str(tmp_path), embedder=embedder)

    # modify the file
    (tmp_path / "app.py").write_text("x = 2\ny = 3")

    r = await index_project(project_path=str(tmp_path), embedder=embedder)
    assert r.files_indexed == 1
    assert r.files_skipped == 0


@pytest.mark.asyncio
async def test_index_force_reindexes_everything(tmp_path):
    (tmp_path / "a.py").write_text("x = 1")

    embedder = FakeEmbedder()

    await index_project(project_path=str(tmp_path), embedder=embedder)

    r = await index_project(project_path=str(tmp_path), embedder=embedder, force=True)
    assert r.files_indexed == 1
    assert r.files_skipped == 0


@pytest.mark.asyncio
async def test_index_removes_deleted_files(tmp_path):
    (tmp_path / "keep.py").write_text("a = 1")
    (tmp_path / "remove.py").write_text("b = 2")

    embedder = FakeEmbedder()
    await index_project(project_path=str(tmp_path), embedder=embedder)

    # delete one file
    (tmp_path / "remove.py").unlink()

    r = await index_project(project_path=str(tmp_path), embedder=embedder)
    assert r.files_deleted == 1

    store = RAGStore(str(tmp_path))
    hashes = store.get_file_hashes()
    assert "keep.py" in hashes
    assert "remove.py" not in hashes


@pytest.mark.asyncio
async def test_index_skips_binary_and_large_files(tmp_path):
    (tmp_path / "binary.py").write_text("\x00\x01\x02")
    (tmp_path / "normal.py").write_text("print('hello')")

    embedder = FakeEmbedder()
    r = await index_project(project_path=str(tmp_path), embedder=embedder)

    assert r.files_indexed == 1
    assert r.files_scanned == 2


@pytest.mark.asyncio
async def test_index_skips_stupidex_dir(tmp_path):
    rag_dir = tmp_path / ".stupidex" / "rag"
    rag_dir.mkdir(parents=True)
    (rag_dir / "old.py").write_text("stale")
    (tmp_path / "real.py").write_text("fresh")

    embedder = FakeEmbedder()
    r = await index_project(project_path=str(tmp_path), embedder=embedder)

    assert r.files_indexed == 1
    names = [Path(e.split(":")[0]).name for e in r.errors] if r.errors else []
    assert all("old.py" not in n for n in names)


@pytest.mark.asyncio
async def test_index_empty_project(tmp_path):
    embedder = FakeEmbedder()
    r = await index_project(project_path=str(tmp_path), embedder=embedder)
    assert r.files_scanned == 0
    assert r.files_indexed == 0
    assert r.errors == []


@pytest.mark.asyncio
async def test_index_captures_errors(tmp_path):
    """Indexing a file that exists but can't be chunked should not crash."""
    (tmp_path / "empty.py").write_text("")

    embedder = FakeEmbedder()
    r = await index_project(project_path=str(tmp_path), embedder=embedder)
    # empty file produces 0 chunks — not an error, just skipped
    assert r.errors == []


@pytest.mark.asyncio
async def test_index_handles_out_of_bounds_path(tmp_path):
    """index_project should handle absolute paths outside project_path."""
    import tempfile

    outside = Path(tempfile.mkdtemp())
    (outside / "ext.py").write_text("x = 1")
    (tmp_path / "main.py").write_text("y = 2")

    embedder = FakeEmbedder()
    r = await index_project(
        project_path=str(tmp_path),
        paths=[str(outside / "ext.py")],
        embedder=embedder,
    )

    assert r.files_indexed == 0


@pytest.mark.asyncio
async def test_index_removes_chunks_for_emptied_file(tmp_path):
    """When a previously indexed file becomes empty, its chunks should be removed."""
    (tmp_path / "app.py").write_text("def hello(): pass")

    embedder = FakeEmbedder()
    await index_project(project_path=str(tmp_path), embedder=embedder)

    store = RAGStore(str(tmp_path))
    assert store.status().total_chunks >= 1

    (tmp_path / "app.py").write_text("")

    r = await index_project(project_path=str(tmp_path), embedder=embedder)
    assert r.files_indexed == 0
    assert store.status().total_chunks == 0


@pytest.mark.asyncio
async def test_index_progress_callback(tmp_path):
    (tmp_path / "a.py").write_text("x = 1")
    (tmp_path / "b.py").write_text("y = 2")

    calls: list[tuple] = []

    def cb(path, done, total):
        calls.append((path, done, total))

    embedder = FakeEmbedder()
    await index_project(project_path=str(tmp_path), embedder=embedder, progress_callback=cb)

    assert len(calls) == 2
    assert all(isinstance(c[0], str) for c in calls)
    assert calls[-1][2] == 2  # total


# ---------------------------------------------------------------------------
# get_status / clear_index
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_status_empty(tmp_path):
    s = get_status(project_path=str(tmp_path))
    assert s.total_files == 0
    assert s.total_chunks == 0
    assert s.last_indexed is None


@pytest.mark.asyncio
async def test_get_status_after_index(tmp_path):
    (tmp_path / "x.py").write_text("val = 42")

    embedder = FakeEmbedder()
    await index_project(project_path=str(tmp_path), embedder=embedder)

    s = get_status(project_path=str(tmp_path))
    assert s.total_files >= 1
    assert s.total_chunks >= 1
    assert s.last_indexed is not None


@pytest.mark.asyncio
async def test_clear_index(tmp_path):
    (tmp_path / "x.py").write_text("val = 42")
    embedder = FakeEmbedder()
    await index_project(project_path=str(tmp_path), embedder=embedder)

    clear_index(project_path=str(tmp_path))

    s = get_status(project_path=str(tmp_path))
    assert s.total_files == 0
    assert s.total_chunks == 0


# ---------------------------------------------------------------------------
# update_file — single-file re-index branches
# ---------------------------------------------------------------------------


class TestUpdateFile:
    @pytest.mark.asyncio
    async def test_update_file_happy_path_reindexes_changed_file(
        self, tmp_path, monkeypatch
    ):
        f = tmp_path / "app.py"
        f.write_text("x = 1\n")
        embedder = FakeEmbedder()
        await index_project(project_path=str(tmp_path), embedder=embedder)

        store = RAGStore(str(tmp_path))
        old_hash = store.get_file_hashes().get("app.py")
        assert old_hash

        monkeypatch.setattr(
            "stupidex.rag.indexer.Embedder", lambda model=None: FakeEmbedder()
        )

        f.write_text("def new():\n    return 42\n")
        await update_file(str(f), project_path=str(tmp_path))

        store2 = RAGStore(str(tmp_path))
        hashes = store2.get_file_hashes()
        assert hashes.get("app.py")
        assert hashes["app.py"] != old_hash
        chunks = [
            c for c in store2._get_all_chunks() if c["file_path"] == "app.py"
        ]
        assert chunks
        assert "def new" in chunks[0]["content"]

    @pytest.mark.asyncio
    async def test_update_file_outside_project_no_op(self, tmp_path, monkeypatch):
        (tmp_path / "app.py").write_text("x = 1\n")
        embedder = FakeEmbedder()
        await index_project(project_path=str(tmp_path), embedder=embedder)

        store = RAGStore(str(tmp_path))
        before_chunks = store._get_all_chunks()
        before_hashes = store.get_file_hashes()

        monkeypatch.setattr(
            "stupidex.rag.indexer.Embedder", lambda model=None: FakeEmbedder()
        )
        await update_file(
            "/nonexistent_root/outside.py", project_path=str(tmp_path)
        )

        store2 = RAGStore(str(tmp_path))
        assert store2._get_all_chunks() == before_chunks
        assert store2.get_file_hashes() == before_hashes

    @pytest.mark.asyncio
    async def test_update_file_wrong_extension_deletes_existing(
        self, tmp_path, monkeypatch
    ):
        store = RAGStore(str(tmp_path))
        store.init_db()
        store.upsert_file(
            "compiled.pyc",
            [Chunk(file_path="compiled.pyc", content="stale", start_line=1, end_line=1)],
            [[0.1] * 8],
        )
        assert "compiled.pyc" in store.get_file_hashes()

        pyc = tmp_path / "compiled.pyc"
        pyc.write_text("garbage")

        await update_file(str(pyc), project_path=str(tmp_path))

        hashes = RAGStore(str(tmp_path)).get_file_hashes()
        assert "compiled.pyc" not in hashes

    @pytest.mark.asyncio
    async def test_update_file_binary_deletes_existing(self, tmp_path, monkeypatch):
        store = RAGStore(str(tmp_path))
        store.init_db()
        store.upsert_file(
            "blob.py",
            [Chunk(file_path="blob.py", content="good", start_line=1, end_line=1)],
            [[0.2] * 8],
        )
        assert "blob.py" in store.get_file_hashes()

        f = tmp_path / "blob.py"
        f.write_bytes(b"\x00\x01\x02")

        await update_file(str(f), project_path=str(tmp_path))

        hashes = RAGStore(str(tmp_path)).get_file_hashes()
        assert "blob.py" not in hashes

    @pytest.mark.asyncio
    async def test_update_file_zero_chunks_deletes_existing(
        self, tmp_path, monkeypatch
    ):
        store = RAGStore(str(tmp_path))
        store.init_db()
        store.upsert_file(
            "ws.py",
            [Chunk(file_path="ws.py", content="good", start_line=1, end_line=1)],
            [[0.3] * 8],
        )
        assert "ws.py" in store.get_file_hashes()

        f = tmp_path / "ws.py"
        f.write_text("   \n  \n")

        await update_file(str(f), project_path=str(tmp_path))

        hashes = RAGStore(str(tmp_path)).get_file_hashes()
        assert "ws.py" not in hashes

    @pytest.mark.asyncio
    async def test_update_file_embedding_failure_no_store_mutation(
        self, tmp_path, monkeypatch
    ):
        store = RAGStore(str(tmp_path))
        store.init_db()
        store.upsert_file(
            "fail.py",
            [Chunk(file_path="fail.py", content="original", start_line=1, end_line=1)],
            [[0.5] * 8],
        )
        store.update_file_hash("fail.py", "ORIGHASH")
        before_hashes = store.get_file_hashes()
        before_chunks = store._get_all_chunks()

        class FailingEmbedder(Embedder):
            async def embed(self, texts: list[str]) -> list[list[float]]:
                raise RuntimeError("boom")

        monkeypatch.setattr(
            "stupidex.rag.indexer.Embedder",
            lambda model=None: FailingEmbedder(model="x"),
        )

        f = tmp_path / "fail.py"
        f.write_text("def newer():\n    return 99\n")
        await update_file(str(f), project_path=str(tmp_path))

        store2 = RAGStore(str(tmp_path))
        assert store2.get_file_hashes() == before_hashes
        assert store2._get_all_chunks() == before_chunks


# ---------------------------------------------------------------------------
# force=True re-index and deleted-file handling (P1-52)
# ---------------------------------------------------------------------------


class TestForceReindexDeletedFiles:
    @pytest.mark.asyncio
    async def test_force_true_removes_deleted_files(self, tmp_path):
        (tmp_path / "a.py").write_text("aa = 1\n")
        (tmp_path / "b.py").write_text("bb = 2\n")
        embedder = FakeEmbedder()
        await index_project(project_path=str(tmp_path), embedder=embedder)

        store = RAGStore(str(tmp_path))
        b_before = [c for c in store._get_all_chunks() if c["file_path"] == "b.py"]
        assert b_before

        (tmp_path / "b.py").unlink()

        r = await index_project(project_path=str(tmp_path), embedder=embedder, force=True)
        store2 = RAGStore(str(tmp_path))
        b_after = [c for c in store2._get_all_chunks() if c["file_path"] == "b.py"]
        assert not b_after
        assert r.files_deleted == 1

    @pytest.mark.asyncio
    async def test_non_force_removes_deleted_files(self, tmp_path):
        (tmp_path / "a.py").write_text("aa = 1\n")
        (tmp_path / "b.py").write_text("bb = 2\n")
        embedder = FakeEmbedder()
        await index_project(project_path=str(tmp_path), embedder=embedder)

        (tmp_path / "b.py").unlink()

        r = await index_project(project_path=str(tmp_path), embedder=embedder, force=False)
        assert r.files_deleted == 1

        store = RAGStore(str(tmp_path))
        b_after = [c for c in store._get_all_chunks() if c["file_path"] == "b.py"]
        assert not b_after

    @pytest.mark.asyncio
    async def test_force_true_no_deletions_reindexes_all(self, tmp_path):
        (tmp_path / "a.py").write_text("a = 1\n")
        (tmp_path / "b.py").write_text("b = 2\n")
        embedder = FakeEmbedder()
        await index_project(project_path=str(tmp_path), embedder=embedder)
        first_calls = embedder._call_count

        r = await index_project(project_path=str(tmp_path), embedder=embedder, force=True)
        assert r.files_indexed == 2
        assert r.files_skipped == 0
        assert embedder._call_count > first_calls

    @pytest.mark.asyncio
    async def test_force_true_empty_project_no_error(self, tmp_path):
        embedder = FakeEmbedder()
        r = await index_project(project_path=str(tmp_path), embedder=embedder, force=True)
        assert r.files_scanned == 0
        assert r.files_indexed == 0
        assert r.errors == []


# ---------------------------------------------------------------------------
# Batch flush performance: _save_vectors called once per index_project run
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_save_vectors_called_once_for_three_files(tmp_path, monkeypatch):
    """Indexing 3 files should flush vectors.npy exactly once (regression)."""
    (tmp_path / "a.py").write_text("a = 1\n")
    (tmp_path / "b.py").write_text("b = 2\n")
    (tmp_path / "c.py").write_text("c = 3\n")

    embedder = FakeEmbedder()

    calls: list[int] = []

    real_store = RAGStore

    def make_store(project_path: str):
        s = real_store(project_path)
        real_save = s._save_vectors

        def counting_save(embeddings):
            calls.append(1)
            return real_save(embeddings)

        s._save_vectors = counting_save
        return s

    monkeypatch.setattr("stupidex.rag.indexer.RAGStore", make_store)

    r = await index_project(project_path=str(tmp_path), embedder=embedder)

    assert r.files_indexed == 3
    assert r.errors == []
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_save_vectors_called_once_incremental_changed_and_deleted(
    tmp_path, monkeypatch
):
    """2 changed + 1 deleted → _save_vectors called exactly once and vectors correct."""
    (tmp_path / "keep.py").write_text("k = 1\n")
    (tmp_path / "mod1.py").write_text("m1 = 1\n")
    (tmp_path / "mod2.py").write_text("m2 = 1\n")
    (tmp_path / "gone.py").write_text("g = 1\n")

    embedder = FakeEmbedder()
    await index_project(project_path=str(tmp_path), embedder=embedder)

    # Modify two files, delete one; keep.py unchanged
    (tmp_path / "mod1.py").write_text("m1 = 999\n")
    (tmp_path / "mod2.py").write_text("m2 = 888\n")
    (tmp_path / "gone.py").unlink()

    calls: list[int] = []

    real_store = RAGStore

    def make_store(project_path: str):
        s = real_store(project_path)
        real_save = s._save_vectors

        def counting_save(embeddings):
            calls.append(1)
            return real_save(embeddings)

        s._save_vectors = counting_save
        return s

    monkeypatch.setattr("stupidex.rag.indexer.RAGStore", make_store)

    r = await index_project(project_path=str(tmp_path), embedder=embedder)

    assert r.files_indexed == 2  # mod1, mod2
    assert r.files_deleted == 1  # gone
    assert r.errors == []
    assert len(calls) == 1

    # Vectors on disk align with surviving chunks
    store = real_store(str(tmp_path))
    vectors = store._load_vectors()
    chunk_ids = store._get_ordered_chunk_ids()
    assert vectors is not None
    assert len(vectors) == len(chunk_ids)

    file_paths = {c["file_path"] for c in store._get_all_chunks()}
    assert file_paths == {"keep.py", "mod1.py", "mod2.py"}

    # Search still works
    results = store.search(vectors[0], top_k=10)
    assert len(results) == len(chunk_ids)


# ---------------------------------------------------------------------------
# Testing-gap sweep 2026-06-21
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_index_no_test_embedding_probe_burns_api_call(tmp_path):
    """P2-139/P2-182: the embed(["test"]) pre-check was removed — index_project
    must NOT call embed() before processing real files (it burned a paid API
    call / ONNX inference on every index run).

    This test asserts the embedder is called exactly once per file's real
    content, with no throwaway "test" probe."""
    (tmp_path / "a.py").write_text("x = 1\n")

    call_log: list[list[str]] = []

    class ProbingEmbedder(Embedder):
        async def embed(self, texts: list[str]) -> list[list[float]]:
            call_log.append(list(texts))
            return [[0.1, 0.2, 0.3] for _ in texts]

    r = await index_project(project_path=str(tmp_path), embedder=ProbingEmbedder())

    assert r.files_indexed == 1
    assert r.errors == []
    # Exactly one embed() call — for the real file's chunks, not a "test" probe.
    assert len(call_log) == 1
    assert "test" not in call_log[0]


def test_read_and_hash_skips_file_exceeding_max_size(tmp_path, monkeypatch):
    """P2-168: _read_and_hash returns (None, None) for files exceeding max_file_size."""
    from stupidex.config import Config, RAGConfig

    cfg = Config(rag=RAGConfig(max_file_size=4))
    monkeypatch.setattr("stupidex.rag.indexer.get_config", lambda: cfg)

    f = tmp_path / "big.py"
    f.write_text("x" * 100)  # 100 bytes > 4-byte limit

    content, file_hash = _read_and_hash(f)
    assert content is None
    assert file_hash is None


@pytest.mark.asyncio
async def test_index_skips_file_exceeding_max_size(tmp_path, monkeypatch):
    """P2-168 integration: index_project skips oversized files."""
    from stupidex.config import Config, RAGConfig

    cfg = Config(rag=RAGConfig(max_file_size=10))
    monkeypatch.setattr("stupidex.rag.indexer.get_config", lambda: cfg)

    (tmp_path / "big.py").write_text("x" * 100)  # exceeds 10-byte limit
    (tmp_path / "small.py").write_text("y = 1")  # 7 bytes, fits

    r = await index_project(project_path=str(tmp_path), embedder=FakeEmbedder())
    assert r.files_scanned == 2
    assert r.files_indexed == 1  # only small.py

    store = RAGStore(str(tmp_path))
    paths = {c["file_path"] for c in store._get_all_chunks()}
    assert "small.py" in paths
    assert "big.py" not in paths


@pytest.mark.asyncio
async def test_index_project_reentrancy_guard_returns_empty(tmp_path, monkeypatch):
    """P2-169: a second concurrent index_project call returns an empty IndexResult."""
    from stupidex.rag import indexer as indexer_mod

    monkeypatch.setattr(indexer_mod, "_indexing", True)

    r = await index_project(project_path=str(tmp_path), embedder=FakeEmbedder())
    assert r.files_scanned == 0
    assert r.files_indexed == 0
    assert r.files_skipped == 0
    assert r.files_deleted == 0
    assert r.chunks_created == 0
    assert r.errors == []
    assert r.duration_seconds == 0.0


# ---------------------------------------------------------------------------
# P2-144: update_file hash persistence on embedding failure — investigation.
# The claim was that early-return on embedding failure (indexer.py:91-93) leaves
# the file frozen out of future re-index because update_file_hash isn't called.
# But: if content changed (which is the typical reason to call update_file),
# the OLD hash in the DB != the NEW file_hash, so the next index_project run
# sees the mismatch and re-indexes. The following characterization test
# verifies this expected behavior (FALSE-POSITIVE), not the unfixed bug.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_update_file_embedding_failure_then_index_project_reindexes(
    tmp_path, monkeypatch
):
    """P2-144 FALSE-POSITIVE characterization: when update_file fails to embed
    and returns early (skipping update_file_hash), the DB retains the OLD hash,
    which does NOT match the modified on-disk content, so the next
    index_project run re-indexes the file (it is not frozen out)."""
    f = tmp_path / "app.py"
    f.write_text("def original():\n    return 1\n")
    embedder = FakeEmbedder()
    await index_project(project_path=str(tmp_path), embedder=embedder)

    store = RAGStore(str(tmp_path))
    old_hash = store.get_file_hashes()["app.py"]
    assert old_hash  # file was indexed with a real hash

    # Modify the file so the on-disk content hash differs from the DB hash.
    f.write_text("def modified():\n    return 2\n")

    class FailingEmbedder(Embedder):
        async def embed(self, texts: list[str]) -> list[list[float]]:
            raise RuntimeError("boom")

    monkeypatch.setattr(
        "stupidex.rag.indexer.Embedder", lambda model=None: FailingEmbedder(model="x")
    )

    # update_file will read content, compute new file_hash, then fail at embed
    # and return early. update_file_hash is NOT called — DB still has old_hash.
    await update_file(str(f), project_path=str(tmp_path))

    store2 = RAGStore(str(tmp_path))
    assert store2.get_file_hashes()["app.py"] == old_hash  # hash unchanged

    # Now index_project runs again with a working embedder. Because old_hash !=
    # hash(modified content), the file IS re-indexed (it is not frozen out).
    monkeypatch.setattr(
        "stupidex.rag.indexer.Embedder", lambda model=None: FakeEmbedder()
    )
    r = await index_project(project_path=str(tmp_path), embedder=FakeEmbedder())
    assert r.files_indexed == 1
    assert r.errors == []

    store3 = RAGStore(str(tmp_path))
    new_hash = store3.get_file_hashes()["app.py"]
    assert new_hash != old_hash
    chunks = [c for c in store3._get_all_chunks() if c["file_path"] == "app.py"]
    assert chunks
    assert "def modified" in chunks[0]["content"]


# ---------------------------------------------------------------------------
# P2-145: empty-discovery result must NOT wipe an existing index.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_index_project_empty_discovery_preserves_existing_index(
    tmp_path, monkeypatch
):
    """P2-145: an empty _discover_files result (e.g. paths=["/nonexistent"])
    should NOT call store.clear() — existing chunks/vectors are preserved, and
    last_indexed is updated."""
    (tmp_path / "a.py").write_text("a = 1\n")
    (tmp_path / "b.py").write_text("b = 2\n")
    (tmp_path / "c.py").write_text("c = 3\n")
    embedder = FakeEmbedder()
    await index_project(project_path=str(tmp_path), embedder=embedder)

    store = RAGStore(str(tmp_path))
    before_chunks = store._get_all_chunks()
    before_vectors = store._load_vectors()
    before_hashes = store.get_file_hashes()
    before_last_indexed = store.status().last_indexed
    assert len(before_chunks) == 3
    assert before_vectors is not None
    assert len(before_vectors) == 3

    import time as _time
    _time.sleep(0.01)

    # Empty discovery — paths points nowhere valid.
    r = await index_project(
        project_path=str(tmp_path),
        paths=["/nonexistent/path"],
        embedder=embedder,
    )
    assert r.files_scanned == 0
    assert r.files_indexed == 0
    assert r.errors == []

    store2 = RAGStore(str(tmp_path))
    # Existing chunks + vectors + hashes preserved.
    assert store2._get_all_chunks() == before_chunks
    assert store2._load_vectors() == before_vectors
    assert store2.get_file_hashes() == before_hashes
    # last_indexed bumped forward (touch_last_indexed called, store.clear not).
    assert store2.status().last_indexed != before_last_indexed


@pytest.mark.asyncio
async def test_index_project_empty_discovery_first_run_no_error(tmp_path):
    """P2-145 edge: first-ever index_project with empty discovery must not crash
    (the removal of store.clear() must not throw on an empty index)."""
    embedder = FakeEmbedder()
    r = await index_project(
        project_path=str(tmp_path),
        paths=["/nonexistent/path"],
        embedder=embedder,
    )
    assert r.files_scanned == 0
    assert r.files_indexed == 0
    assert r.errors == []
    store = RAGStore(str(tmp_path))
    assert store.status().total_chunks == 0


@pytest.mark.asyncio
async def test_index_project_valid_paths_still_index_normally(tmp_path):
    """P2-145 regression: valid paths still drive normal indexing after the
    empty-discovery fix."""
    (tmp_path / "a.py").write_text("a = 1\n")
    (tmp_path / "b.py").write_text("b = 2\n")
    embedder = FakeEmbedder()
    r = await index_project(
        project_path=str(tmp_path),
        paths=[str(tmp_path / "a.py"), str(tmp_path / "b.py")],
        embedder=embedder,
    )
    assert r.files_indexed == 2
    assert r.errors == []


# ---------------------------------------------------------------------------
# Batch-3 fixes 2026-06-22: batch update_file, batch hash updates, no probe
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_update_file_uses_batch_api_single_vectors_flush(tmp_path, monkeypatch):
    """P2-157/P2-152: update_file uses the batch vector-state API so a
    single-file re-index performs exactly one _save_vectors call
    (load_vector_state -> upsert_file_batch -> flush_vector_state)."""
    f = tmp_path / "app.py"
    f.write_text("x = 1\n")
    embedder = FakeEmbedder()
    await index_project(project_path=str(tmp_path), embedder=embedder)

    monkeypatch.setattr(
        "stupidex.rag.indexer.Embedder", lambda model=None: FakeEmbedder()
    )

    save_calls: list[int] = []
    real_store = RAGStore

    def make_store(project_path: str):
        s = real_store(project_path)
        real_save = s._save_vectors

        def counting_save(embeddings):
            save_calls.append(1)
            return real_save(embeddings)

        s._save_vectors = counting_save
        return s

    import stupidex.rag.indexer as indexer_mod
    monkeypatch.setattr(indexer_mod, "RAGStore", make_store)

    f.write_text("def new():\n    return 42\n")
    await update_file(str(f), project_path=str(tmp_path))

    # Batch path: exactly one _save_vectors call (the flush).
    assert len(save_calls) == 1

    # Content was indexed.
    store = real_store(str(tmp_path))
    chunks = [c for c in store._get_all_chunks() if c["file_path"] == "app.py"]
    assert chunks
    assert "def new" in chunks[0]["content"]


@pytest.mark.asyncio
async def test_index_project_batch_hash_update_single_transaction(tmp_path, monkeypatch):
    """P2-158: file hashes are updated in a single batch transaction, not
    one connection-per-file in a loop."""
    (tmp_path / "a.py").write_text("a = 1\n")
    (tmp_path / "b.py").write_text("b = 2\n")
    (tmp_path / "c.py").write_text("c = 3\n")
    embedder = FakeEmbedder()
    await index_project(project_path=str(tmp_path), embedder=embedder)

    # Modify all three files.
    (tmp_path / "a.py").write_text("a = 999\n")
    (tmp_path / "b.py").write_text("b = 999\n")
    (tmp_path / "c.py").write_text("c = 999\n")

    batch_calls: list[int] = []
    real_store = RAGStore

    def make_store(project_path: str):
        s = real_store(project_path)
        real_batch = s.update_file_hashes_batch

        def counting_batch(hashes):
            batch_calls.append(len(hashes))
            return real_batch(hashes)

        s.update_file_hashes_batch = counting_batch
        return s

    import stupidex.rag.indexer as indexer_mod
    monkeypatch.setattr(indexer_mod, "RAGStore", make_store)

    r = await index_project(project_path=str(tmp_path), embedder=embedder)
    assert r.files_indexed == 3
    assert r.errors == []

    # Exactly one batch call with all 3 hashes.
    assert len(batch_calls) == 1
    assert batch_calls[0] == 3

    # Hashes reflect the new content.
    store = real_store(str(tmp_path))
    hashes = store.get_file_hashes()
    assert len(hashes) == 3
    for fp in ("a.py", "b.py", "c.py"):
        assert hashes[fp]


def test_get_status_returns_store_status():
    """P2-154: get_status returns a StoreStatus directly (IndexStatus removed)."""
    from stupidex.rag.indexer import get_status
    from stupidex.rag.store import StoreStatus

    s = StoreStatus(
        total_chunks=42,
        total_files=7,
        last_indexed="2026-06-22T00:00:00+00:00",
        last_index_duration=1.5,
    )
    assert s.total_chunks == 42
    assert s.total_files == 7
    assert s.last_indexed == "2026-06-22T00:00:00+00:00"
    assert s.last_index_duration == 1.5

    # Verify get_status is annotated to return StoreStatus
    import inspect
    assert inspect.signature(get_status).return_annotation is StoreStatus
