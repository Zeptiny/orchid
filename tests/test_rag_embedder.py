"""Tests for the Embedder routing switch (U6).

Verifies that ``Embedder(model="alias/model")`` dispatches:

* ``fastembed/<model_id>`` -> local ONNX path (``Embedder._embed_fastembed``)
* any other ``alias/model`` -> ``litellm.aembedding`` with per-call
  ``base_url=`` / ``api_key=`` kwargs (analogous to ``acompletion`` in U3)

Covers R9 (routing applies to embeddings too). See
docs/plans/2026-06-18-001-feat-multi-provider-support-plan.md, unit U6.

Pattern mirrors ``tests/test_providers_resolution.py`` (unittest.TestCase +
patched ``providers_mod.get_config`` for routing tests; ``asyncio.run()``
for async behavior so the file does not depend on pytest-asyncio's mixed-mode
TestCase integration; ``reset_cache()`` in setUp/tearDown to keep the
provider-metadata cache isolated across tests).
"""

import asyncio
import sys
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

import numpy as np

from stupidex.config import Config
from stupidex.llm import providers as providers_mod
from stupidex.llm.providers import ProviderResolutionError, reset_cache
from stupidex.rag.embedder import BATCH_SIZE, MAX_RETRIES, Embedder, EmbeddingError


def _cfg(providers: dict) -> Config:
    return Config(providers=providers)


class EmbedderTestCase(unittest.TestCase):
    """Base: resets the provider-metadata cache and fastembed cache per test."""

    def setUp(self) -> None:
        reset_cache()
        Embedder._fastembed_cache.clear()

    def tearDown(self) -> None:
        reset_cache()
        Embedder._fastembed_cache.clear()

    def _patch_cfg(self, providers: dict):
        return patch.object(providers_mod, "get_config", return_value=_cfg(providers))


class TestResolveRef(EmbedderTestCase):
    def test_fastembed_ref_short_circuits(self):
        """`fastembed/<id>` resolves to `("fastembed", model_id)` without consulting config."""
        e = Embedder("fastembed/BAAI/bge-small-en-v1.5")
        self.assertEqual(
            e._resolve_ref(),
            ("fastembed", "BAAI/bge-small-en-v1.5"),
        )

    def test_provider_alias_ref_returns_litellm_tuple(self):
        """`alias/model` routes through the providers dict to a litellm 4-tuple."""
        providers = {
            "work-openai": {
                "litellm_provider": "openai",
                "base_url": "https://api.openai.com/v1",
                "api_key": "sk-test",
                "models": {"text-embedding-3-small": {}},
            }
        }
        e = Embedder("work-openai/text-embedding-3-small")
        with self._patch_cfg(providers):
            self.assertEqual(
                e._resolve_ref(),
                ("openai", "text-embedding-3-small", "https://api.openai.com/v1", "sk-test"),
            )

    def test_no_api_key_returns_none_in_tuple(self):
        """Provider with no `api_key`/`api_key_env` yields `api_key=None` so litellm uses its own env detection."""
        providers = {
            "work-openai": {
                "litellm_provider": "openai",
                "base_url": "https://api.openai.com/v1",
            }
        }
        e = Embedder("work-openai/text-embedding-3-small")
        with self._patch_cfg(providers):
            ref = e._resolve_ref()
        assert len(ref) == 4  # narrows the union to the litellm 4-tuple form
        self.assertIsNone(ref[3])


class TestEmbedRouting(EmbedderTestCase):
    """Verifies the dispatch switch in `Embedder.embed()`."""

    def test_empty_text_list_short_circuits_before_resolution(self):
        """An empty text list returns `[]` without consulting `_resolve_ref`.

        Preserves the early-return at the top of `embed()` so a misconfigured
        embedder doesn't crash just because the caller passed `[]`.
        """
        e = Embedder("garbage-no-slash")  # would raise if `_resolve_ref` were called
        self.assertEqual(asyncio.run(e.embed([])), [])

    def test_fastembed_route_calls_embed_fastembed(self):
        """`fastembed/<id>` dispatches to `_embed_fastembed` and never touches litellm."""
        e = Embedder("fastembed/BAAI/bge-small-en-v1.5")
        with (
            patch.object(Embedder, "_embed_fastembed", new_callable=AsyncMock) as mock_fe,
            patch("litellm.aembedding", new_callable=AsyncMock) as mock_ae,
        ):
            result = asyncio.run(e.embed(["hello"]))
        mock_fe.assert_awaited_once_with("BAAI/bge-small-en-v1.5", ["hello"])
        mock_ae.assert_not_called()
        # AsyncMock default return is MagicMock()-ish; the embed loop extends
        # from it. We only assert dispatch shape here, not vector content.
        self.assertIsInstance(result, list)

    def test_litellm_route_passes_base_url_and_api_key(self):
        """`alias/model` dispatches to `litellm.aembedding` with the per-call kwargs."""
        fake_ref = ("openai", "text-embedding-3-small", "https://example.com", "sk-x")
        response = MagicMock()
        response.data = [{"embedding": [0.1, 0.2, 0.3]}]
        e = Embedder("work-openai/text-embedding-3-small")
        with (
            patch("stupidex.rag.embedder.resolve_embedding_ref", return_value=fake_ref),
            patch("litellm.aembedding", new_callable=AsyncMock, return_value=response) as mock_ae,
        ):
            result = asyncio.run(e.embed(["hello"]))
        mock_ae.assert_awaited_once()
        kwargs = mock_ae.call_args.kwargs
        self.assertEqual(kwargs["model"], "openai/text-embedding-3-small")
        self.assertEqual(kwargs["input"], ["hello"])
        self.assertEqual(kwargs["base_url"], "https://example.com")
        self.assertEqual(kwargs["api_key"], "sk-x")
        self.assertEqual(result, [[0.1, 0.2, 0.3]])

    def test_litellm_route_empty_base_url_passes_none(self):
        """Empty string `base_url` is translated to `None` (litellm's env-detection path)."""
        fake_ref = ("openai", "text-embedding-3-small", "", "sk-x")
        response = MagicMock()
        response.data = [{"embedding": [0.1]}]
        e = Embedder("work-openai/text-embedding-3-small")
        with (
            patch("stupidex.rag.embedder.resolve_embedding_ref", return_value=fake_ref),
            patch("litellm.aembedding", new_callable=AsyncMock, return_value=response) as mock_ae,
        ):
            asyncio.run(e.embed(["hi"]))
        self.assertIsNone(mock_ae.call_args.kwargs["base_url"])

    def test_litellm_route_none_api_key_passes_through(self):
        """`api_key=None` is forwarded as-is so litellm can fall back to its own env detection."""
        fake_ref = ("openai", "text-embedding-3-small", "https://example.com", None)
        response = MagicMock()
        response.data = [{"embedding": [0.1]}]
        e = Embedder("work-openai/text-embedding-3-small")
        with (
            patch("stupidex.rag.embedder.resolve_embedding_ref", return_value=fake_ref),
            patch("litellm.aembedding", new_callable=AsyncMock, return_value=response) as mock_ae,
        ):
            asyncio.run(e.embed(["hi"]))
        self.assertIsNone(mock_ae.call_args.kwargs["api_key"])

    def test_litellm_route_bare_model_id_when_no_litellm_provider(self):
        """When the provider has no `litellm_provider`, the litellm call uses the bare model id."""
        fake_ref = ("", "text-embedding-3-small", "https://example.com", "sk-x")
        response = MagicMock()
        response.data = [{"embedding": [0.1]}]
        e = Embedder("work-openai/text-embedding-3-small")
        with (
            patch("stupidex.rag.embedder.resolve_embedding_ref", return_value=fake_ref),
            patch("litellm.aembedding", new_callable=AsyncMock, return_value=response) as mock_ae,
        ):
            asyncio.run(e.embed(["hi"]))
        self.assertEqual(mock_ae.call_args.kwargs["model"], "text-embedding-3-small")


class TestEmbedErrors(EmbedderTestCase):
    def test_fastembed_no_model_id_raises_provider_resolution_error(self):
        """`fastembed` alone (no model id) propagates `ProviderResolutionError` (unwrapped).

        Decision: resolution errors are NOT wrapped in `EmbeddingError`. The
        `tools/rag.py` entry points catch the broad `Exception` branch and map
        to a `rag_error` ExecutorResult, so propagation is safe and preserves
        the typed-error signal for callers who want to distinguish config-missing
        (`EmbeddingError`) from bad-alias (`ProviderResolutionError`).
        """
        e = Embedder("fastembed")
        with self.assertRaises(ProviderResolutionError):
            asyncio.run(e.embed(["x"]))

    def test_unknown_alias_raises_provider_resolution_error(self):
        """A `alias/model` whose alias is not in the providers dict raises `ProviderResolutionError`."""
        e = Embedder("unknown-alias/text-embedding-3-small")
        with self.assertRaises(ProviderResolutionError):
            asyncio.run(e.embed(["x"]))

    def test_empty_model_raises_embedding_error(self):
        """An empty model is a config bug -> EmbeddingError mentioning `rag_embedding_model`."""
        with self.assertRaises(EmbeddingError) as ctx:
            asyncio.run(Embedder("").embed(["x"]))
        self.assertIn("rag.embedding_model", str(ctx.exception))

    def test_none_model_raises_embedding_error(self):
        """A `None` model is a config bug -> EmbeddingError mentioning `rag_embedding_model`."""
        with self.assertRaises(EmbeddingError) as ctx:
            asyncio.run(Embedder(None).embed(["x"]))
        self.assertIn("rag.embedding_model", str(ctx.exception))

    def test_litellm_failure_retries_then_raises_embedding_error(self):
        """After `MAX_RETRIES` attempts, a litellm exception surfaces as `EmbeddingError`."""
        fake_ref = ("openai", "text-embedding-3-small", "https://example.com", "sk-x")
        e = Embedder("work-openai/text-embedding-3-small")
        with (
            patch("stupidex.rag.embedder.resolve_embedding_ref", return_value=fake_ref),
            patch("litellm.aembedding", new_callable=AsyncMock, side_effect=RuntimeError("boom")),
            patch("asyncio.sleep", new_callable=AsyncMock) as mock_sleep,
            self.assertRaises(EmbeddingError) as ctx,
        ):
            asyncio.run(e.embed(["x"]))
        self.assertIn("boom", str(ctx.exception))
        # MAX_RETRIES (3) attempts yield MAX_RETRIES - 1 backoff sleeps.
        self.assertEqual(mock_sleep.await_count, MAX_RETRIES - 1)


class TestEmbedLitellmErrorPaths(EmbedderTestCase):
    """P2-165 / P2-166: litellm ImportError + empty/malformed response.data."""

    _FAKE_REF = ("openai", "text-embedding-3-small", "https://example.com", "sk-x")

    def test_litellm_import_error_raises_embedding_error(self):
        """P2-165: when `from litellm import aembedding` raises ImportError,
        Embedder raises a clean EmbeddingError pointing to the package name."""
        e = Embedder("work-openai/text-embedding-3-small")
        with (
            patch("stupidex.rag.embedder.resolve_embedding_ref", return_value=self._FAKE_REF),
            patch.dict(sys.modules, {"litellm": None}),
            self.assertRaises(EmbeddingError) as ctx,
        ):
            asyncio.run(e.embed(["hi"]))
        self.assertIn("litellm is required for embeddings", str(ctx.exception))

    def test_litellm_empty_response_data_returns_empty_list(self):
        """P2-166 (fixed): `response.data == []` -> _embed_litellm raises
        EmbeddingError immediately (hard failure, not retried, not silent [])."""
        response = MagicMock()
        response.data = []
        e = Embedder("work-openai/text-embedding-3-small")
        with (
            patch("stupidex.rag.embedder.resolve_embedding_ref", return_value=self._FAKE_REF),
            patch("litellm.aembedding", new_callable=AsyncMock, return_value=response) as mock_ae,
            patch("asyncio.sleep", new_callable=AsyncMock) as mock_sleep,
            self.assertRaises(EmbeddingError) as ctx,
        ):
            asyncio.run(e.embed(["hi"]))
        self.assertIn("empty response.data", str(ctx.exception))
        self.assertIn("text-embedding-3-small", str(ctx.exception))
        # Hard failure: not retried.
        self.assertEqual(mock_ae.await_count, 1)
        mock_sleep.assert_not_awaited()

    def test_embed_empty_response_raises_not_silent(self):
        """P2-166 (fixed): embed(["text"]) with provider returning empty
        response.data raises EmbeddingError rather than returning []."""
        response = MagicMock()
        response.data = []
        e = Embedder("work-openai/text-embedding-3-small")
        with (
            patch("stupidex.rag.embedder.resolve_embedding_ref", return_value=self._FAKE_REF),
            patch("litellm.aembedding", new_callable=AsyncMock, return_value=response),
            self.assertRaises(EmbeddingError),
        ):
            asyncio.run(e.embed(["text"]))

    def test_litellm_malformed_response_data_raises_embedding_error(self):
        """P2-166: `response.data` items missing the `embedding` key surface
        as EmbeddingError after MAX_RETRIES retries."""
        response = MagicMock()
        response.data = [{}]  # no "embedding" key
        e = Embedder("work-openai/text-embedding-3-small")
        with (
            patch("stupidex.rag.embedder.resolve_embedding_ref", return_value=self._FAKE_REF),
            patch("litellm.aembedding", new_callable=AsyncMock, return_value=response),
            patch("asyncio.sleep", new_callable=AsyncMock),
            self.assertRaises(EmbeddingError) as ctx,
        ):
            asyncio.run(e.embed(["hi"]))
        self.assertIn("Embedding failed after", str(ctx.exception))


class TestEmbedBatching(EmbedderTestCase):
    """P2-167: batches of >BATCH_SIZE texts are split into multiple calls."""

    def test_more_than_batch_size_text_is_split_into_multiple_calls(self):
        e = Embedder("fastembed/BAAI/bge-small-en-v1.5")
        texts = [f"t{i}" for i in range(BATCH_SIZE * 2 + 50)]  # 250

        captured_batches: list[list[str]] = []

        async def fake_embed(model, batch):
            captured_batches.append(list(batch))
            return [[0.1, 0.2, 0.3] for _ in batch]

        with patch.object(
            Embedder, "_embed_fastembed", new_callable=AsyncMock, side_effect=fake_embed
        ) as mock_fe:
            result = asyncio.run(e.embed(texts))

        self.assertEqual(mock_fe.await_count, 3)
        self.assertEqual(len(captured_batches[0]), BATCH_SIZE)
        self.assertEqual(len(captured_batches[1]), BATCH_SIZE)
        self.assertEqual(len(captured_batches[2]), 50)
        self.assertEqual(len(result), len(texts))
        self.assertEqual(len(result), 250)

    def test_exactly_batch_size_is_single_call(self):
        e = Embedder("fastembed/BAAI/bge-small-en-v1.5")
        texts = [f"t{i}" for i in range(BATCH_SIZE)]

        async def fake_embed(model, batch):
            return [[0.1, 0.2, 0.3] for _ in batch]

        with patch.object(
            Embedder, "_embed_fastembed", new_callable=AsyncMock, side_effect=fake_embed
        ) as mock_fe:
            result = asyncio.run(e.embed(texts))

        self.assertEqual(mock_fe.await_count, 1)
        self.assertEqual(len(result), BATCH_SIZE)


class TestEmbedSingle(EmbedderTestCase):
    """P3-78: embed_single public method."""

    def test_returns_single_vector_with_correct_dimension(self):
        e = Embedder("fastembed/BAAI/bge-small-en-v1.5")
        with patch.object(
            Embedder,
            "_embed_fastembed",
            new_callable=AsyncMock,
            return_value=[[0.1, 0.2, 0.3]],
        ) as mock_fe:
            vec = asyncio.run(e.embed_single("text"))
        self.assertEqual(vec, [0.1, 0.2, 0.3])
        mock_fe.assert_awaited_once()

    def test_empty_text_characterization(self):
        """Characterization: with a normal embedder, embed_single("") returns
        a vector (no IndexError). The IndexError path only triggers when the
        underlying provider returns an empty list (see test_empty_provider_raises_indexerror)."""

        class FakeEmpty(Embedder):
            async def embed(self, texts: list[str]) -> list[list[float]]:
                return [[0.0, 0.0, 0.0, 0.0] for _ in texts]

        e = FakeEmpty(model="fake")
        vec = asyncio.run(e.embed_single(""))
        self.assertEqual(vec, [0.0, 0.0, 0.0, 0.0])

    def test_empty_provider_raises_indexerror(self):
        """Fixed (P2-187): when embed() returns [], embed_single raises
        EmbeddingError (not bare IndexError)."""

        class EmptyEmbedder(Embedder):
            async def embed(self, texts: list[str]) -> list[list[float]]:
                return []

        e = EmptyEmbedder(model="fake")
        with self.assertRaises(EmbeddingError) as ctx:
            asyncio.run(e.embed_single("anything"))
        self.assertIn("no vectors", str(ctx.exception))


class TestFastembedRetry(EmbedderTestCase):
    """P2-146: fastembed path now has retry with exponential backoff."""

    def test_fastembed_retries_then_succeeds(self):
        """A transient fastembed failure is retried, then succeeds."""
        e = Embedder("fastembed/BAAI/bge-small-en-v1.5")

        call_count = 0

        class FakeEmbed:
            def embed(self, texts):
                nonlocal call_count
                call_count += 1
                if call_count < 2:
                    raise RuntimeError("transient ONNX failure")
                return [np.array([0.1, 0.2, 0.3]) for _ in texts]

        with (
            patch.dict("sys.modules", {"fastembed": type("M", (), {"TextEmbedding": lambda **kw: FakeEmbed()})}),
            patch("asyncio.sleep", new_callable=AsyncMock),
        ):
            result = asyncio.run(e.embed(["hello"]))

        self.assertEqual(call_count, 2)
        self.assertEqual(result, [[0.1, 0.2, 0.3]])

    def test_fastembed_non_retryable_error_not_retried(self):
        """A TypeError (programming bug) is not retried — fastembed path."""
        e = Embedder("fastembed/BAAI/bge-small-en-v1.5")

        call_count = 0

        class FakeEmbed:
            def embed(self, texts):
                nonlocal call_count
                call_count += 1
                raise TypeError("bad arg")

        with (
            patch.dict("sys.modules", {"fastembed": type("M", (), {"TextEmbedding": lambda **kw: FakeEmbed()})}),
            patch("asyncio.sleep", new_callable=AsyncMock) as mock_sleep,
            self.assertRaises(EmbeddingError) as ctx,
        ):
            asyncio.run(e.embed(["hello"]))

        self.assertEqual(call_count, 1)
        self.assertIn("non-retryable", str(ctx.exception))
        mock_sleep.assert_not_awaited()


class TestLitellmImportHoist(EmbedderTestCase):
    """P2-179: litellm import is hoisted out of the retry loop.

    When litellm cannot be imported, EmbeddingError is raised immediately
    (no retry attempts, no asyncio.sleep) — the import happens once before
    the retry loop, not inside it."""

    def test_litellm_import_error_raises_immediately_no_retry(self):
        e = Embedder("work-openai/text-embedding-3-small")
        fake_ref = ("openai", "text-embedding-3-small", "https://example.com", "sk-x")

        # Make `from litellm import aembedding` raise ImportError.
        with (
            patch("stupidex.rag.embedder.resolve_embedding_ref", return_value=fake_ref),
            patch.dict(sys.modules, {"litellm": None}),
            patch("asyncio.sleep", new_callable=AsyncMock) as mock_sleep,
            self.assertRaises(EmbeddingError) as ctx,
        ):
            asyncio.run(e.embed(["hi"]))

        self.assertIn("litellm is required for embeddings", str(ctx.exception))
        # Import error is raised before the retry loop — no sleeps.
        mock_sleep.assert_not_awaited()



if __name__ == "__main__":
    unittest.main()
