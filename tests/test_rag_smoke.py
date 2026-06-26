import random
import tempfile

from stupidex.rag.chunker import chunk_file
from stupidex.rag.store import RAGStore


def test_chunker_produces_multiple_chunks():
    code = "def foo():\n    pass\n\n" * 200
    chunks = chunk_file("test.py", code, chunk_size=2000, chunk_overlap=200)
    assert len(chunks) > 1
    assert len(chunks) <= 5
    for c in chunks:
        assert c.start_line >= 1
        assert c.end_line >= c.start_line


def test_chunker_small_file_single_chunk():
    code = "x = 1\n"
    chunks = chunk_file("small.py", code)
    assert len(chunks) == 1
    assert chunks[0].content == code


def test_chunker_binary_rejected():
    assert chunk_file("x.bin", "hello\x00world") == []


def test_store_upsert_and_search():
    code = "def foo():\n    pass\n\n" * 200
    chunks = chunk_file("test.py", code, chunk_size=2000, chunk_overlap=200)
    dim = 8

    with tempfile.TemporaryDirectory() as tmpdir:
        store = RAGStore(tmpdir)
        store.init_db()

        fake_embeddings = [[random.random() for _ in range(dim)] for _ in chunks]
        store.upsert(chunks, fake_embeddings)

        status = store.status()
        assert status.total_chunks == len(chunks)
        assert status.total_files == 1

        query = [random.random() for _ in range(dim)]
        results = store.search(query, top_k=3)
        assert len(results) == 3
        assert all(r.score >= 0 for r in results)

        results_filtered = store.search(query, top_k=3, file_pattern="*.ts")
        assert len(results_filtered) == 0

        results_match = store.search(query, top_k=3, file_pattern="*.py")
        assert len(results_match) == 3

        store.clear()
        assert store.status().total_chunks == 0


def test_store_empty_search():
    with tempfile.TemporaryDirectory() as tmpdir:
        store = RAGStore(tmpdir)
        store.init_db()
        results = store.search([1.0, 0.0], top_k=5)
        assert results == []


def test_store_file_hash_tracking():
    with tempfile.TemporaryDirectory() as tmpdir:
        store = RAGStore(tmpdir)
        store.init_db()

        hashes = store.get_file_hashes()
        assert hashes == {}

        store.update_file_hash("src/foo.py", "abc123")
        hashes = store.get_file_hashes()
        assert hashes["src/foo.py"] == "abc123"


def test_delete_by_file():
    code = "x = 1\n"
    chunks = chunk_file("a.py", code)
    with tempfile.TemporaryDirectory() as tmpdir:
        store = RAGStore(tmpdir)
        store.init_db()
        store.upsert(chunks, [[0.5, 0.5]])
        assert store.status().total_chunks == 1

        store.delete_by_file("a.py")
        assert store.status().total_chunks == 0
        assert store.status().total_files == 0


def test_embedder_fastembed_local_routes_correctly():
    """`Embedder("fastembed/<id>")` dispatches to the local ONNX path and returns vectors.

    Smoke test for U6: verifies the fastembed pseudo-provider routing switch in
    `Embedder.embed()` without depending on the network or the slow ONNX model
    init. `fastembed.TextEmbedding` is stubbed via `sys.modules` so no model
    download happens and the test stays fast.
    """
    from unittest.mock import patch

    import numpy as np

    from stupidex.rag.embedder import Embedder

    e = Embedder("fastembed/BAAI/bge-small-en-v1.5")
    Embedder._fastembed_cache.clear()
    mock_vector = np.array([0.1, 0.2, 0.3])

    class FakeTextEmbedding:
        def __init__(self, **kw):
            pass

        def embed(self, texts):
            return [mock_vector for _ in texts]

    fake_module = type("M", (), {"TextEmbedding": FakeTextEmbedding})
    with patch.dict("sys.modules", {"fastembed": fake_module}):
        import asyncio

        vectors = asyncio.run(e.embed(["hello", "world"]))

    assert isinstance(vectors, list)
    assert len(vectors) == 2
    assert all(isinstance(v, list) for v in vectors)
    assert all(isinstance(x, float) for x in vectors[0])
