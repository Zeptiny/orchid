"""Tests for RAG tools (U4 + U6): rag_search and rag_index."""
from unittest.mock import AsyncMock, patch

import pytest

from stupidex.domain.tool import ExecutorResult
from stupidex.rag.chunker import Chunk
from stupidex.rag.embedder import Embedder, EmbeddingError
from stupidex.rag.store import RAGStore
from stupidex.tools.rag import (
    execute_rag_index,
    execute_rag_search,
)


class FakeEmbedder(Embedder):
    def __init__(self, dim: int = 8):
        super().__init__(model="fake-model")
        self.dim = dim

    async def embed(self, texts: list[str]) -> list[list[float]]:
        import hashlib as _hl
        results = []
        for t in texts:
            h = _hl.md5(t.encode()).hexdigest()
            vec = [int(h[i:i+2], 16) / 255.0 for i in range(0, self.dim * 2, 2)]
            while len(vec) < self.dim:
                vec.append(0.0)
            results.append(vec[:self.dim])
        return results


# ---------------------------------------------------------------------------
# rag_search
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_rag_search_empty_query():
    result = await execute_rag_search(query="")
    assert isinstance(result, ExecutorResult)
    assert "<rag_error" in result.content
    assert "query" in result.content


@pytest.mark.asyncio
async def test_rag_search_whitespace_query():
    result = await execute_rag_search(query="   ")
    assert isinstance(result, ExecutorResult)
    assert "<rag_error" in result.content


@pytest.mark.asyncio
async def test_rag_search_no_index(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    result = await execute_rag_search(query="authentication")
    assert isinstance(result, ExecutorResult)
    assert "No RAG index" in result.display


@pytest.mark.asyncio
async def test_rag_search_with_results(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)

    store = RAGStore(str(tmp_path))
    store.init_db()

    chunks = [
        Chunk(file_path="auth.py", content="def login(): pass", start_line=1, end_line=2),
        Chunk(file_path="db.py", content="def connect(): pass", start_line=1, end_line=2),
    ]
    embeddings = [[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0]]
    store.upsert(chunks, embeddings)

    with patch("stupidex.tools.rag.Embedder") as mock_embedder:
        fake = FakeEmbedder(dim=4)
        mock_embedder.return_value = fake
        fake.embed_single = AsyncMock(return_value=[1.0, 0.0, 0.0, 0.0])

        result = await execute_rag_search(query="authentication")

    assert isinstance(result, ExecutorResult)
    assert "<rag_results" in result.content
    assert "auth.py" in result.content
    assert "result" in result.content


@pytest.mark.asyncio
async def test_rag_search_with_file_pattern(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)

    store = RAGStore(str(tmp_path))
    store.init_db()

    chunks = [
        Chunk(file_path="auth.py", content="login", start_line=1, end_line=1),
        Chunk(file_path="main.ts", content="auth", start_line=1, end_line=1),
    ]
    embeddings = [[1.0, 0.0], [0.0, 1.0]]
    store.upsert(chunks, embeddings)

    with patch("stupidex.tools.rag.Embedder") as mock_embedder:
        fake = FakeEmbedder(dim=2)
        mock_embedder.return_value = fake
        fake.embed_single = AsyncMock(return_value=[1.0, 0.0])

        result = await execute_rag_search(query="auth", file_pattern="*.py")

    assert isinstance(result, ExecutorResult)
    assert "auth.py" in result.content


@pytest.mark.asyncio
async def test_rag_search_embedding_error(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    store = RAGStore(str(tmp_path))
    store.init_db()
    chunks = [Chunk(file_path="a.py", content="x=1", start_line=1, end_line=1)]
    store.upsert(chunks, [[0.5, 0.5]])

    with patch("stupidex.tools.rag.Embedder") as mock_embedder:
        fake = FakeEmbedder()
        mock_embedder.return_value = fake
        fake.embed_single = AsyncMock(side_effect=EmbeddingError("API down"))

        result = await execute_rag_search(query="test")

    assert isinstance(result, ExecutorResult)
    assert "<rag_error" in result.content


@pytest.mark.asyncio
async def test_rag_search_generic_embedding_exception_embeds_message(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    store = RAGStore(str(tmp_path))
    store.init_db()
    chunks = [Chunk(file_path="a.py", content="x=1", start_line=1, end_line=1)]
    store.upsert(chunks, [[0.5, 0.5]])

    with patch("stupidex.tools.rag.Embedder") as mock_embedder:
        fake = FakeEmbedder()
        mock_embedder.return_value = fake
        fake.embed_single = AsyncMock(side_effect=RuntimeError("embedder blew up"))

        result = await execute_rag_search(query="test query")

    assert isinstance(result, ExecutorResult)
    assert result.display == "Embedding error"
    assert "<rag_error" in result.content
    assert "embedder blew up" in result.content


@pytest.mark.asyncio
async def test_rag_search_value_error_from_store_returns_error(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    store = RAGStore(str(tmp_path))
    store.init_db()
    chunks = [Chunk(file_path="a.py", content="x=1", start_line=1, end_line=1)]
    store.upsert(chunks, [[0.5, 0.5, 0.5]])

    with patch("stupidex.tools.rag.Embedder") as mock_embedder:
        fake = FakeEmbedder()
        mock_embedder.return_value = fake
        fake.embed_single = AsyncMock(return_value=[1.0, 0.0])

        result = await execute_rag_search(query="dimension mismatch")

    assert isinstance(result, ExecutorResult)
    assert result.display == "Search error"
    assert "<rag_error" in result.content
    assert "does not match" in result.content


# ---------------------------------------------------------------------------
# rag_index
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_rag_index_invalid_action():
    result = await execute_rag_index(action="invalid")
    assert isinstance(result, ExecutorResult)
    assert "<rag_error" in result.content


@pytest.mark.asyncio
async def test_rag_index_status_no_index(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    result = await execute_rag_index(action="status")
    assert isinstance(result, ExecutorResult)
    assert "<rag_status" in result.content
    assert 'chunks="0"' in result.content


@pytest.mark.asyncio
async def test_rag_index_status_with_data(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)

    (tmp_path / "hello.py").write_text("print('hi')")
    store = RAGStore(str(tmp_path))
    store.init_db()
    chunks = [Chunk(file_path="hello.py", content="print('hi')", start_line=1, end_line=1)]
    store.upsert(chunks, [[0.5, 0.5]])

    result = await execute_rag_index(action="status")
    assert isinstance(result, ExecutorResult)
    assert "<rag_status" in result.content
    assert 'files="1"' in result.content


@pytest.mark.asyncio
async def test_rag_index_clear(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)

    store = RAGStore(str(tmp_path))
    store.init_db()
    chunks = [Chunk(file_path="a.py", content="x=1", start_line=1, end_line=1)]
    store.upsert(chunks, [[0.5]])
    assert store.status().total_chunks == 1

    result = await execute_rag_index(action="clear")
    assert isinstance(result, ExecutorResult)
    assert "<rag_clear" in result.content
    assert 'success="true"' in result.content

    assert store.status().total_chunks == 0


@pytest.mark.asyncio
async def test_rag_index_run(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "main.py").write_text("def hello(): pass")

    with patch("stupidex.tools.rag.Embedder") as mock_embedder:
        fake = FakeEmbedder()
        mock_embedder.return_value = fake

        result = await execute_rag_index(action="index")

    assert isinstance(result, ExecutorResult)
    assert "Indexed" in result.display
    assert "<rag_index" in result.content
    assert 'indexed="1"' in result.content


@pytest.mark.asyncio
async def test_rag_index_run_empty_project(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)

    with patch("stupidex.tools.rag.Embedder") as mock_embedder:
        fake = FakeEmbedder()
        mock_embedder.return_value = fake

        result = await execute_rag_index(action="index")

    assert isinstance(result, ExecutorResult)
    assert "0 files" in result.display
    assert "<rag_index" in result.content
    assert 'indexed="0"' in result.content

    status_result = await execute_rag_index(action="status")
    assert "<rag_status" in status_result.content
    assert 'indexed="never"' not in status_result.content


# ---------------------------------------------------------------------------
# tool registration
# ---------------------------------------------------------------------------


def test_rag_tools_in_registry():
    from stupidex.tools import get_tool_registry
    registry = get_tool_registry()
    assert "rag_search" in registry
    assert "rag_index" in registry
    assert registry["rag_search"]["executor"] is execute_rag_search
    assert registry["rag_index"]["executor"] is execute_rag_index
