"""Provider resolution and model metadata hydration (U2).

Resolves `alias/model` strings to `(litellm_provider, model_id, base_url, api_key)`
tuples for litellm calls, and hydrates per-model capability metadata via a
field-level merge of user override -> litellm registry -> text-only default.

Also exports `resolve_embedding_ref` for the RAG embedder so `fastembed/`
references short-circuit to local ONNX and `alias/model` references route
through the same resolver as chat models.

Covers R6, R8, R9. See
docs/plans/2026-06-18-001-feat-multi-provider-support-plan.md (unit U2).
"""

import logging
import os

# litellm fetches `model_prices_and_context_window.json` over the network at
# import time unless this flag is set first. Set it before the `import litellm`
# below so the cost-map is read from the packaged local copy instead.
os.environ.setdefault("LITELLM_LOCAL_MODEL_COST_MAP", "True")

import httpx  # noqa: E402
import litellm  # noqa: E402

from stupidex.config import get_config  # noqa: E402

log = logging.getLogger(__name__)


def qualify_model(provider: str | None, model_id: str) -> str:
    """Build a litellm-qualified model string: ``provider/model`` or bare ``model``."""
    return f"{provider}/{model_id}" if provider else model_id


_SUPPORTED_FIELDS = ("max_input_tokens", "max_output_tokens", "supports_vision", "mode")
_DEFAULT_METADATA: dict = {
    "max_input_tokens": None,
    "max_output_tokens": None,
    "supports_vision": False,
    "mode": "chat",
}

_metadata_cache: dict[tuple[str, str], dict] = {}
_discovery_cache: dict[str, list[str]] = {}
_DISCOVERY_TIMEOUT = 2.0
_DISABLE_DISCOVERY_VALUES = {"1", "true", "yes"}


class ProviderResolutionError(Exception):
    """Raised when an `alias/model` reference cannot be resolved to a provider."""


def get_provider(alias: str) -> dict:
    """Return the provider entry for `alias`, or raise `ProviderResolutionError`."""
    cfg = get_config()
    provider = cfg.providers.get(alias)
    if provider is None:
        raise ProviderResolutionError(
            f"Unknown provider alias {alias!r}; not present in config providers"
        )
    return provider


def _resolve_api_key(provider: dict, alias: str) -> str | None:
    """Resolve an API key for a provider entry.

    Prefers a literal `api_key`; falls back to the env var named by
    `api_key_env`. Returns `None` when neither is available so litellm can
    fall back to its own env detection (e.g. `OPENAI_API_KEY`).
    """
    api_key = provider.get("api_key")
    if api_key:
        return api_key
    api_key_env = provider.get("api_key_env")
    if api_key_env:
        value = os.environ.get(api_key_env)
        if not value:
            # Treat both unset (None) and explicitly-empty env vars as missing
            # so litellm falls back to its own detection (e.g. `OPENAI_API_KEY`).
            log.debug(
                "Provider %r: env var %r is unset or empty; letting litellm fall "
                "back to its default API key detection",
                alias,
                api_key_env,
            )
            return None
        return value
    return None


def resolve_model_ref(alias_model: str) -> tuple[str, str, str, str | None]:
    """Resolve an `alias/model` reference to a litellm call tuple.

    Returns `(litellm_provider, model_id, base_url, api_key)`:

    * `litellm_provider` -- the provider's litellm provider name, or `""` if
      unset (the call site passes a bare `model_id` to litellm in that case).
    * `model_id` -- the part after the first `/`. Need NOT be declared in the
      provider's `models` dict; resolution succeeds for undeclared models.
    * `base_url` -- the provider's base URL, or `""` if unset.
    * `api_key` -- resolved literal/env value, or `None` when neither
      `api_key` nor `api_key_env` is set (litellm then uses its own detection).

    Raises `ProviderResolutionError` if the input lacks a `/` or the alias is
    not a configured provider.
    """
    alias, sep, model_id = alias_model.partition("/")
    if not sep:
        raise ProviderResolutionError(
            f"Model reference {alias_model!r} must be in `alias/model` form"
        )
    if not alias or not model_id:
        raise ProviderResolutionError(
            f"Model reference {alias_model!r} has an empty alias or model id; "
            "expected `alias/model` with both parts non-empty"
        )
    provider = get_provider(alias)
    api_key = _resolve_api_key(provider, alias)
    base_url = provider.get("base_url") or ""
    litellm_provider = provider.get("litellm_provider") or ""
    return litellm_provider, model_id, base_url, api_key


def resolve_model_metadata(alias: str, model_id: str) -> dict:
    """Resolve capability metadata for a (provider alias, model id) pair.

    Field-level merge: text-only default <- litellm registry <- user override
    (override wins, registry fills gaps, default handles everything missing).
    Only the four supported fields are returned; the `litellm_provider` key
    that config permits on model overrides is used only to qualify the litellm
    query and is dropped from the returned dict.

    Never raises: an unknown alias or an unknown model falls through to the
    text-only default so the picker can iterate every configured model without
    exception handling.
    """
    cache_key = (alias, model_id)
    cached = _metadata_cache.get(cache_key)
    if cached is not None:
        return cached

    cfg = get_config()
    provider = cfg.providers.get(alias, {})
    override = provider.get("models", {}).get(model_id, {})

    # A model-scoped litellm_provider override takes precedence over the
    # provider entry's litellm_provider when forming the litellm query.
    effective_provider = override.get("litellm_provider") or provider.get("litellm_provider")
    qualified = qualify_model(effective_provider, model_id)

    registry: dict = {}
    try:
        info = litellm.get_model_info(qualified)
        if info:
            registry = {k: info.get(k) for k in _SUPPORTED_FIELDS}
    except Exception:  # noqa: BLE001 -- litellm raises broad errors for unmapped models
        registry = {}

    merged = {**_DEFAULT_METADATA, **registry, **override}
    result = {k: merged.get(k, _DEFAULT_METADATA[k]) for k in _SUPPORTED_FIELDS}

    _metadata_cache[cache_key] = result
    return result


def resolve_embedding_ref(
    model_ref: str,
) -> tuple[str, str] | tuple[str, str, str, str | None]:
    """Resolve an embedding model reference.

    `fastembed/<model_id>` short-circuits to local ONNX and returns
    `("fastembed", model_id)` -- no provider lookup, no env var consulted, no
    litellm call. Any other `alias/model` reference returns the resolved litellm
    tuple `(litellm_provider, model_id, base_url, api_key)` from
    `resolve_model_ref`.
    """
    alias, _, model_id = model_ref.partition("/")
    if alias == "fastembed":
        if not model_id:
            raise ProviderResolutionError(
                "`fastembed` requires a model id; use `fastembed/<model_id>`"
            )
        return ("fastembed", model_id)
    return resolve_model_ref(model_ref)


def reset_cache() -> None:
    """Clear the resolved-metadata + endpoint-discovery caches (test hook)."""
    _metadata_cache.clear()
    _discovery_cache.clear()


def discover_provider_models(alias: str, force: bool = False) -> list[str]:
    """Discover available model IDs from a provider's `GET /models` endpoint.

    Hybrid fallback for the `/model` picker: when a provider's `models`
    dict is undeclared (or empty), the picker calls this to list what the
    endpoint actually serves. Resolved entries still pass through
    `resolve_model_metadata`, so well-known models get badges + token
    shorthand from litellm's registry.

    * Cached per-alias for the session — call `force=True` to refetch.
    * Respects `STUPIDEX_DISABLE_MODEL_DISCOVERY=1/true/yes` for strict
      configured-only behavior.
    * Returns `[]` when the provider has no `base_url`, the endpoint is
      unreachable, or the response is malformed. Network failures never
      raise — they just yield an empty list so the picker degrades to
      "no models for this provider" instead of crashing.

    Raises `ProviderResolutionError` only if `alias` itself is unknown.
    """
    if os.environ.get("STUPIDEX_DISABLE_MODEL_DISCOVERY", "").lower() in _DISABLE_DISCOVERY_VALUES:
        log.debug("Model discovery disabled via STUPIDEX_DISABLE_MODEL_DISCOVERY")
        return []
    if not force and alias in _discovery_cache:
        return _discovery_cache[alias]

    provider = get_provider(alias)
    base_url = provider.get("base_url") or ""
    if not base_url:
        _discovery_cache[alias] = []
        return []

    api_key = _resolve_api_key(provider, alias)
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}

    try:
        with httpx.Client(timeout=_DISCOVERY_TIMEOUT) as client:
            response = client.get(f"{base_url.rstrip('/')}/models", headers=headers)
            response.raise_for_status()
            data = response.json()
            model_ids = [
                m["id"]
                for m in data.get("data", [])
                if isinstance(m, dict)
                and isinstance(m.get("id"), str)
                and m["id"]
            ]
    except Exception as e:  # noqa: BLE001 -- network is best-effort
        log.warning("Model discovery for provider %r failed: %s", alias, e)
        _discovery_cache[alias] = []
        return []

    _discovery_cache[alias] = model_ids
    return model_ids
