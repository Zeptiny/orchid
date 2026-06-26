import asyncio
import logging

from stupidex.llm.providers import resolve_embedding_ref

logger = logging.getLogger(__name__)

BATCH_SIZE = 100
MAX_RETRIES = 3

# Exception types that are almost certainly programming bugs, not transient
# provider failures — retrying them just wastes time and (for API providers)
# tokens. KeyError/ValueError are deliberately excluded: a provider returning
# a malformed payload once can recover on retry.
_NON_RETRYABLE = (TypeError, AttributeError)


class EmbeddingError(Exception):
    pass


class Embedder:
    _fastembed_cache: dict[str, object] = {}

    def __init__(self, model: str | None = None):
        self.model = model or ""

    def _resolve_ref(self) -> tuple[str, str] | tuple[str, str, str, str | None]:
        """Resolve self.model to an embedding ref via the providers resolver.

        Returns ``("fastembed", model_id)`` for the local ONNX short-circuit, or
        ``(litellm_provider, model_id, base_url, api_key)`` for an ``alias/model``
        reference routed through the providers dict.

        Raises:
            EmbeddingError: if no model is configured (empty/None).
            ProviderResolutionError: propagated from ``resolve_embedding_ref`` when
                ``self.model`` is not a valid ``alias/model`` reference (e.g. bare
                ``"fastembed"`` or an unknown provider alias).
        """
        if not self.model:
            raise EmbeddingError(
                "No embedding model configured. Set 'rag.embedding_model' in "
                "config.json or STUPIDEX_RAG_EMBEDDING_MODEL env var."
            )
        return resolve_embedding_ref(self.model)

    async def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []

        ref = self._resolve_ref()
        all_embeddings: list[list[float]] = []

        for i in range(0, len(texts), BATCH_SIZE):
            batch = texts[i : i + BATCH_SIZE]
            if len(ref) == 2:
                _, model_id = ref
                logger.debug("Embedding %d texts with fastembed/%s", len(batch), model_id)
                batch_embeddings = await self._embed_fastembed(model_id, batch)
            else:
                _, model_id, base_url, api_key = ref
                litellm_provider = ref[0]
                qualified = f"{litellm_provider}/{model_id}" if litellm_provider else model_id
                logger.debug("Embedding %d texts with %s", len(batch), qualified)
                batch_embeddings = await self._embed_litellm(qualified, batch, base_url, api_key)
            all_embeddings.extend(batch_embeddings)

        return all_embeddings

    async def _embed_fastembed(self, model: str, texts: list[str]) -> list[list[float]]:
        try:
            from fastembed import TextEmbedding
        except ImportError as err:
            raise EmbeddingError(
                "fastembed is required for local embeddings. "
                "Install it with: pip install fastembed"
            ) from err

        if model not in self._fastembed_cache:
            self._fastembed_cache[model] = await asyncio.to_thread(
                TextEmbedding, model_name=model
            )
        embedder = self._fastembed_cache[model]

        last_error: Exception | None = None
        for attempt in range(MAX_RETRIES):
            try:
                def _run() -> list[list[float]]:
                    return [v.tolist() for v in embedder.embed(texts)]

                return await asyncio.to_thread(_run)
            except _NON_RETRYABLE as e:
                raise EmbeddingError(
                    f"fastembed inference failed (non-retryable {type(e).__name__}): {e}"
                ) from e
            except Exception as e:
                last_error = e
                if attempt < MAX_RETRIES - 1:
                    wait = 2**attempt
                    logger.warning(
                        "fastembed attempt %d failed (%s), retrying in %ds...",
                        attempt + 1,
                        e,
                        wait,
                    )
                    await asyncio.sleep(wait)

        raise EmbeddingError(
            f"fastembed inference failed after {MAX_RETRIES} attempts: {last_error}"
        )

    async def _embed_litellm(
        self,
        model: str,
        texts: list[str],
        base_url: str,
        api_key: str | None,
    ) -> list[list[float]]:
        try:
            from litellm import aembedding
        except ImportError as err:
            raise EmbeddingError(
                "litellm is required for embeddings. "
                "Install it with: pip install litellm"
            ) from err

        last_error: Exception | None = None

        for attempt in range(MAX_RETRIES):
            try:
                response = await aembedding(
                    model=model,
                    input=texts,
                    base_url=base_url or None,
                    api_key=api_key,
                )
                if not response.data:
                    raise EmbeddingError(
                        f"Embedding provider returned empty response.data for model: {model}"
                    )
                return [item["embedding"] for item in response.data]
            except EmbeddingError:
                raise
            except _NON_RETRYABLE as e:
                # Programming/config errors won't fix themselves on retry.
                raise EmbeddingError(
                    f"Embedding failed (non-retryable {type(e).__name__}): {e}\n"
                    "Check your embedding model configuration in config.json or set "
                    "STUPIDEX_RAG_EMBEDDING_MODEL env var."
                ) from e
            except Exception as e:
                last_error = e
                if attempt < MAX_RETRIES - 1:
                    wait = 2**attempt
                    logger.warning(
                        "Embedding attempt %d failed (%s), retrying in %ds...",
                        attempt + 1,
                        e,
                        wait,
                    )
                    await asyncio.sleep(wait)

        raise EmbeddingError(
            f"Embedding failed after {MAX_RETRIES} attempts: {last_error}\n"
            "Check your embedding model configuration in config.json or set "
            "STUPIDEX_RAG_EMBEDDING_MODEL env var."
        )

    async def embed_single(self, text: str) -> list[float]:
        results = await self.embed([text])
        if not results:
            raise EmbeddingError("Embedding returned no vectors for input text")
        return results[0]
