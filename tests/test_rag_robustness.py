"""Tests for RAG robustness improvements (U8)."""

from unittest.mock import AsyncMock, patch

import pytest

from stupidex.rag.chunker import Chunk
from stupidex.rag.embedder import Embedder, EmbeddingError
from stupidex.rag.indexer import index_project
from stupidex.rag.store import RAGStore


class FakeEmbedder(Embedder):
    def __init__(self, dim: int = 8, fail_after: int | None = None):
        super().__init__(model="fake-model")
        self.dim = dim
        self._call_count = 0
        self._fail_after = fail_after

    async def embed(self, texts: list[str]) -> list[list[float]]:
        import hashlib as _hl
        self._call_count += 1
        if self._fail_after is not None and self._call_count > self._fail_after:
            raise EmbeddingError("Simulated API failure")
        results = []
        for t in texts:
            h = _hl.md5(t.encode()).hexdigest()
            vec = [int(h[i:i+2], 16) / 255.0 for i in range(0, self.dim * 2, 2)]
            while len(vec) < self.dim:
                vec.append(0.0)
            results.append(vec[:self.dim])
        return results


# ---------------------------------------------------------------------------
# Corrupted vectors.npy
# ---------------------------------------------------------------------------


def test_corrupted_vectors_npy_auto_rebuild(tmp_path):
    """Corrupted vectors.npy should be cleared and search returns empty."""
    store = RAGStore(str(tmp_path))
    store.init_db()
    chunks = [Chunk(file_path="a.py", content="x=1", start_line=1, end_line=1)]
    store.upsert(chunks, [[0.5, 0.5]])

    # Corrupt the vectors file
    npy_file = tmp_path / ".stupidex" / "rag" / "vectors.npy"
    npy_file.write_bytes(b"corrupted data here")

    # Search should handle corruption gracefully
    results = store.search([0.5, 0.5], top_k=5)
    assert results == []


# ---------------------------------------------------------------------------
# Corrupted index.db
# ---------------------------------------------------------------------------


def test_corrupted_index_db_init_rebuild(tmp_path):
    """Corrupted index.db should be rebuilt on init_db."""
    store = RAGStore(str(tmp_path))
    store.init_db()

    # Write corrupted data to db
    db_file = tmp_path / ".stupidex" / "rag" / "index.db"
    db_file.write_bytes(b"corrupted sqlite data")

    # init_db should rebuild without error
    store.init_db()

    # Store should work normally now
    status = store.status()
    assert status.total_chunks == 0


def test_corrupted_index_db_get_conn_rebuild(tmp_path):
    """Corrupted index.db should be rebuilt when get_conn fails."""
    store = RAGStore(str(tmp_path))
    store.init_db()

    # Write corrupted data to db
    db_file = tmp_path / ".stupidex" / "rag" / "index.db"
    db_file.write_bytes(b"corrupted sqlite data")

    # get_conn should handle corruption and rebuild
    conn = store._get_conn()
    try:
        # Should be able to query after rebuild
        result = conn.execute("SELECT COUNT(*) FROM chunks").fetchone()
        assert result[0] == 0
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Embedding failure handling
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_embedder_failure_after_retries():
    """Embedder should fail gracefully after max retries."""
    embedder = Embedder(model="work-openai/text-embedding-3-small")

    fake_ref = ("openai", "text-embedding-3-small", "https://example.com", "sk-test")
    error = EmbeddingError("Simulated API failure")
    with (
        patch("stupidex.rag.embedder.resolve_embedding_ref", return_value=fake_ref),
        patch("litellm.aembedding", new_callable=AsyncMock, side_effect=error),
    ):
        with pytest.raises(EmbeddingError) as exc_info:
            await embedder.embed(["test text"])

        assert "Simulated API failure" in str(exc_info.value)


@pytest.mark.asyncio
async def test_embedder_success_with_retries():
    """Embedder should succeed if retry succeeds."""
    from unittest.mock import MagicMock

    embedder = Embedder(model="work-openai/text-embedding-3-small")

    good_response = MagicMock()
    good_response.data = [{"embedding": [0.1, 0.2, 0.3, 0.4]}]

    call_count = 0

    async def fail_then_succeed(*args, **kwargs):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            raise RuntimeError("Temporary provider failure")
        return good_response

    fake_ref = ("openai", "text-embedding-3-small", "https://example.com", "sk-test")
    with (
        patch("stupidex.rag.embedder.resolve_embedding_ref", return_value=fake_ref),
        patch("litellm.aembedding", side_effect=fail_then_succeed),
    ):
        result = await embedder.embed(["test text"])

    assert len(result) == 1
    assert len(result[0]) == 4
    assert call_count == 2


# ---------------------------------------------------------------------------
# Indexer robustness
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_indexer_handles_embedding_failure(tmp_path):
    """Indexer should handle embedding failures gracefully."""
    (tmp_path / "main.py").write_text("def hello(): pass")

    embedder = FakeEmbedder(fail_after=0)

    result = await index_project(
        project_path=str(tmp_path),
        embedder=embedder,
    )

    # Should have errors but not crash
    assert len(result.errors) > 0
    assert result.files_indexed == 0


@pytest.mark.asyncio
async def test_indexer_handles_corrupted_db(tmp_path):
    """Indexer should handle corrupted DB during indexing."""
    (tmp_path / "main.py").write_text("def hello(): pass")

    # Create corrupted DB
    rag_dir = tmp_path / ".stupidex" / "rag"
    rag_dir.mkdir(parents=True)
    db_file = rag_dir / "index.db"
    db_file.write_bytes(b"corrupted")

    embedder = FakeEmbedder()

    # Should rebuild and succeed
    result = await index_project(
        project_path=str(tmp_path),
        embedder=embedder,
    )

    assert result.files_indexed == 1


@pytest.mark.asyncio
async def test_indexer_handles_missing_vectors(tmp_path):
    """Indexer should handle missing vectors.npy after DB exists."""
    (tmp_path / "main.py").write_text("def hello(): pass")

    embedder = FakeEmbedder()

    # Index once
    await index_project(project_path=str(tmp_path), embedder=embedder)

    # Delete vectors but keep DB
    vectors_file = tmp_path / ".stupidex" / "rag" / "vectors.npy"
    if vectors_file.exists():
        vectors_file.unlink()

    # Second index with force=True should still work
    result = await index_project(project_path=str(tmp_path), embedder=embedder, force=True)
    assert result.files_indexed == 1


# ---------------------------------------------------------------------------
# Embedding provider routing
# ---------------------------------------------------------------------------


def test_resolve_ref_fastembed_pseudo_provider():
    """`fastembed/<model_id>` short-circuits to local ONNX without consulting config."""
    e = Embedder("fastembed/BAAI/bge-small-en-v1.5")
    assert e._resolve_ref() == ("fastembed", "BAAI/bge-small-en-v1.5")


def test_resolve_ref_provider_alias_routes_to_litellm():
    """`alias/model` resolves through the providers dict to a litellm 4-tuple."""
    from stupidex.config import Config
    from stupidex.llm import providers as providers_mod

    providers = {
        "work-openai": {
            "litellm_provider": "openai",
            "base_url": "https://api.openai.com/v1",
            "api_key": "sk-test",
            "models": {"text-embedding-3-small": {}},
        }
    }
    cfg = Config(providers=providers)
    e = Embedder("work-openai/text-embedding-3-small")
    with patch.object(providers_mod, "get_config", return_value=cfg):
        assert e._resolve_ref() == (
            "openai",
            "text-embedding-3-small",
            "https://api.openai.com/v1",
            "sk-test",
        )


def test_resolve_ref_explicit_model_id_preserved():
    """The model id portion of `alias/<model_id>` is preserved verbatim."""
    from stupidex.config import Config
    from stupidex.llm import providers as providers_mod

    providers = {
        "work-openai": {
            "litellm_provider": "openai",
            "base_url": "https://api.openai.com/v1",
            "api_key": "sk-test",
        }
    }
    cfg = Config(providers=providers)
    e = Embedder("work-openai/custom-embedding-model")
    with patch.object(providers_mod, "get_config", return_value=cfg):
        ref = e._resolve_ref()
    # ref is a 4-tuple (litellm_provider, model_id, base_url, api_key)
    assert ref[1] == "custom-embedding-model"


@pytest.mark.asyncio
async def test_fastembed_missing_package_raises():
    e = Embedder("fastembed/BAAI/bge-small-en-v1.5")
    Embedder._fastembed_cache.clear()
    with (
        patch.dict("sys.modules", {"fastembed": None}),
        pytest.raises(EmbeddingError, match="fastembed is required"),
    ):
        await e.embed(["hello"])


@pytest.mark.asyncio
async def test_fastembed_routing_called():
    import numpy as np

    e = Embedder("fastembed/BAAI/bge-small-en-v1.5")
    Embedder._fastembed_cache.clear()
    mock_vectors = [np.array([0.1, 0.2, 0.3])]

    class FakeEmbed:
        def __init__(self, **kw):
            pass

        def embed(self, texts):
            return mock_vectors

    with patch.dict("sys.modules", {"fastembed": type("M", (), {"TextEmbedding": FakeEmbed})}):
        result = await e.embed(["hello"])

    assert len(result) == 1
    assert result[0] == [0.1, 0.2, 0.3]
