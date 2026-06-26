---
title: feat: Add multi-provider support to config and model routing
type: feat
status: active
date: 2026-06-18
origin: docs/brainstorms/multi-providers-requirements.md
---

# Multi-Provider Support

## Summary

Replace stupidex's single-provider config with a `providers` dict (alias, url, api key inline-or-env-ref, optional litellm provider name, per-model metadata overrides) and route models by `alias/model` strings. Per-model metadata (`max_input_tokens`, `max_output_tokens`, `supports_vision`, `mode` — litellm field names verbatim) is resolved by field-level merge of user override → `litellm.get_model_info` registry → text-only fallback, refreshed once at startup. The model picker surfaces metadata and capability badges derived from `supports_vision` + `mode`.

---

## Problem Frame

Stupidex is currently locked to a single LLM provider via four top-level `Config` fields (`base_url`, `provider_api_type`, `default_model`, `tier_models` in `src/stupidex/config.py:27-37`). The litellm call site (`src/stupidex/llm/client.py:325-332`) assembles `cfg.provider_api_type + "/" + model` and passes `base_url=cfg.base_url` — no per-call `api_key`, no per-call routing beyond that one endpoint. Users wanting a second provider (different OpenAI account, local Llama, Anthropic, a corporate proxy) have no path other than editing config and swapping env vars before each launch. The model picker (`src/stupidex/commands/session_commands.py:55-67`) hits `base_url + "/models"` for one endpoint's catalog and shows bare IDs with no capability or context-window signal. See origin doc for the full problem narrative and key decisions.

---

## Requirements

- R1. Users define one or more providers under a `providers` key; each entry has alias, base URL, API key (inline literal OR env-var reference), optional litellm provider name, and a `models` dict.
- R2. The top-level `base_url`, `provider_api_type`, `default_model`, and `tier_models` config fields are removed; `providers` is the sole source of provider/model config. `default_model` and `tier_models` values become `alias/model` strings.
- R3. Provider aliases must not contain `/` so the `alias/model` reference syntax stays unambiguous.
- R4. Each provider's API key is configurable as either a literal value in config OR an env-variable name reference, selectable per provider; both forms coexist.
- R5. Each model entry has optional per-model metadata overrides using litellm's verbatim field names: `max_input_tokens`, `max_output_tokens`, `supports_vision` (bool), `mode` (str).
- R6. Final metadata resolution per `(provider, model)` is a field-level merge: user override → litellm registry → empty/text-only fallback (`supports_vision=False`, `mode="chat"`).
- R7. The model picker lists all configured models across all providers as `alias/model`, showing resolved `max_input_tokens`, `max_output_tokens`, and capability badges derived from `supports_vision` (vision badge) and `mode` (text badge when `chat` or `completion`).
- R8. Metadata is refreshed once at startup and frozen for the session.
- R9. Model references used by `default_model`, `tier_models`, agent definitions, and the picker are `alias/model` strings; the call site resolves the alias to the matching provider and passes the resolved tuple to litellm.
- R10. Model discovery reflects configured models (not endpoint `/models` calls).
- R11. The shipping default config seeds a `default` provider so a fresh install runs without user config edits.
- R12. Project-level config merges with home config; project providers with the same alias as home override the home entry, project providers with new aliases are added.

**Origin actors:** A1 (End user), A2 (Agent), A3 (litellm registry)
**Origin flows:** F1 (App startup — provider discovery and metadata hydration), F2 (User selects a model in the picker), F3 (Agent call routes to the correct provider), F4 (First-run with no user config)
**Origin acceptance examples:** AE1 (covers R1, R4), AE2 (covers R6), AE3 (covers R6), AE4 (covers R3), AE5 (covers R7, R9), AE6 (covers R11)

---

## Scope Boundaries

- Capability-driven behavior (context truncation, vision-call gating, capability filtering when assigning tier models) — deferred to future work that builds on the captured metadata (see origin doc)
- Lazy / runtime metadata refresh — startup-only for v1
- Per-provider concurrency limits, rate-limit pooling, endpoint failover routing — v1 routes each call to its named provider, no failover
- Multi-key rotation, key vaults, OAuth flows — one key per provider in v1
- Built-in catalog of popular providers / provider presets — users configure explicitly
- Surfaces cost-per-token, latency, availability, or other litellm registry fields beyond the four named in R5
- Per-provider usage analytics or accounting
- A UI for editing providers from inside the app — config-file editing only in v1
---

## Context & Research

### Relevant Code and Patterns

- `src/stupidex/config.py:25-86` — `Config` dataclass with the four top-level fields to remove (lines 27-37). The `mcp_servers` field (75-86) is the model for `providers` shape.
- `src/stupidex/config.py:192-230` — `ConfigManager.load()` merge flow (home → project → env → validate). The duplicated `mcp_servers` deep-merge blocks at 203-208 and 216-221 are the template — and the duplication is a refactor opportunity (extract a shared `_deep_merge_dict_key` helper, with recursive variant for nested `models`).
- `src/stupidex/config.py:137-186` — `_validate_config`. The MCP server validation at 163-184 (`isinstance(dict)`, `_MCP_SERVER_NAME_RE`, per-field type-checks, warn-and-skip) is the template for provider validation. The regex `_MCP_SERVER_NAME_RE = r"^[a-z0-9-]+$"` at line 10 forbids `/` already; a similar regex for provider aliases works.
- `src/stupidex/config.py:89-106` — `_ENV_MAP`. Three entries must be removed: `STUPIDEX_BASE_URL`, `STUPIDEX_DEFAULT_MODEL`, `STUPIDEX_PROVIDER_API_TYPE` (lines 90-92).
- `src/stupidex/config.py:232-251` — `ensure_home_config()` writes `asdict(Config())` to `~/.stupidex/config.json` only when the file is absent (line 236). The shipping `Config()` defaults must produce a `providers` section with a `default` provider reproducing today's `https://opencode.ai/zen/go/v1` + `openai` + `mimo-v2.5`.
- `src/stupidex/config.py:200-223` — `ConfigManager.load` merge loop only merges keys `in merged` (line 201 and 213), silently dropping unknown keys. Since the project is still in development, no legacy-key tolerance is needed — users will simply write a fresh config matching the new schema when they upgrade.
- `src/stupidex/llm/client.py:293-369` — `stream_response`. The litellm call at 325-332 assembles `cfg.provider_api_type + "/" + (model or cfg.default_model)` and passes `base_url=cfg.base_url`. Resolution must produce `(litellm_provider, model_id, base_url, api_key)` and pass `base_url=` + `api_key=` as named kwargs. Resolution happens once before the `while True` loop (model is fixed per session). See §Key Technical Decisions for `base_url` vs `api_base`.
- `src/stupidex/llm/models.py:1-24` — `Model` dataclass (bare `id: str`) and `list_models()` httpx call to `cfg.base_url + "/models"`. The function and dataclass are replaced by the new resolved-model object in U2; `list_models()` is removed (R10 drops endpoint discovery).
- `src/stupidex/screens/picker.py:1-75` — `OptionPicker(Screen[str])` generic picker; `PickerItem` is a 2-field dataclass (`label`, `id`). `_filter` at 31-33 matches on `label.lower()` and `id.lower()`. **Badges formatted into the `label` string at construction time is the lower-risk path** — keeps picker changes to zero and search behavior intact. The picker is shared by 5 commands (`/switch`, `/delete`, `/model`, `/theme`, `/personality` in `session_commands.py:41,54,67,82,95`).
- `src/stupidex/commands/session_commands.py:55-67` — `/model` case. Currently builds `PickerItem(label=m.id, id=m.id)` from `list_models()`. Becomes: iterate configured providers, build PickerItem list from each provider's resolved models, format label with badges and token shorthand.
- `src/stupidex/domain/session.py:31-39` — `SessionManager.create()` sets `model=cfg.default_model`. Post-refactor `cfg.default_model` is an `alias/model` string; no code change here.
- `src/stupidex/config.py:287-289` — `get_model_for_tier(tier)` returns `cfg.tier_models.get(tier, cfg.default_model)`. Post-refactor both emit `alias/model` strings; no code change here.
- `src/stupidex/tools/subagent.py:76` — `model = get_model_for_tier(resolved_tier.value)`; flows into `SubagentManager.spawn(..., model: str | None)`. Unchanged contract post-refactor.
- `src/stupidex/rag/embedder.py:19-27` — `Embedder.__init__(model, provider_api_type="openai", embedding_provider="")`. The `provider_api_type` parameter and its 4 call sites (`rag/indexer.py:86,98`; `tools/rag.py:86,178`) are updated in U6 to migrate embeddings to `alias/model` references routed through the providers dict, with `"fastembed/<model_id>"` as a built-in pseudo-provider for local ONNX embeddings.
- `tests/test_mcp_config.py` — pattern for testing `_validate_config` as a pure function (construct `Config(...)`, call `_validate_config(cfg)` directly, assert per-entry outcomes).
- `tests/test_streaming_messages.py` — pattern for testing `stream_response` internals with `SimpleNamespace` chunks and `unittest.mock.patch` to swap `litellm.acompletion` and assert kwargs.

### Institutional Learnings

No `docs/solutions/` entries exist for this work — the directory tree is scaffolded but empty. The `/ce-compound` step after landing should capture at least: the litellm `get_model_info` raise-vs-None behavior, the `LITELLM_LOCAL_MODEL_COST_MAP=True` convention, the env-var-reference API key pattern, and the deep-merge recursion constraint on the mcp_servers pattern.

### External References

- `litellm.get_model_info(model)` raises `ValueError` ("This model isn't mapped yet...") for unknown models — does not return None. Verified against litellm 1.83.7. Confirmed by GitHub issue [#23054](https://github.com/BerriAI/litellm/issues/23054).
- `litellm.acompletion` accepts `base_url=` and `api_key=` as named kwargs in this version (1.83.7). The signature declares `base_url` (not `api_base`); `api_base` works only via `**kwargs` legacy alias. Use `base_url=` + `api_key=`.
- `get_model_info` returns a `ModelInfo` TypedDict with the verbatim field names: `max_input_tokens` (int|None), `max_output_tokens` (int|None), `supports_vision` (bool|None), `mode` (str: one of `chat`, `completion`, `embedding`, `image_generation`, `audio_transcription`, `responses`). Also returns `litellm_provider`, `key`. **Do NOT use `max_tokens`** — it's a legacy ambiguous field (sometimes equals input, sometimes output).
- `get_model_info` accepts both provider-qualified (`"openai/gpt-4o"`) and bare (`"gpt-4o"`) strings; the provider-qualified form is more specific and preferred. Lookup is case-insensitive.
- litellm routes `acompletion(model=...)` based on the prefix before `/`: `"openai/gpt-4o"` → OpenAI backend, `"azure/gpt-4o"` → Azure backend. The user-defined alias is NOT a litellm provider — must resolve the alias to a real litellm provider string before constructing the model string for `acompletion`.
- `LITELLM_LOCAL_MODEL_COST_MAP=True` env var skips the network fetch of `model_prices_and_context_window.json` at import time and uses the bundled local backup. Set before `import litellm`. Doc: https://docs.litellm.ai/docs/completion/token_usage ("Don't pull hosted model_cost_map").
- The litellm model cost map is NOT in the request path — `acompletion` calls succeed even when a model is missing from the map; only `get_model_info` raises. Startup-only metadata refresh is safe.

---

## Key Technical Decisions

- **New module `src/stupidex/llm/providers.py` for resolution + metadata hydration (not in `config.py`):** Keeps the config dataclass focused on shape and validation; the resolution code lives next to the LLM client that consumes it. Module-level functions `resolve_model_ref`, `get_provider`, `resolve_model_metadata` follow the existing module-level-helper pattern (`get_config`, `get_model_for_tier`, `get_current_theme`).
- **`LITELLM_LOCAL_MODEL_COST_MAP=True` set at module import in `llm/providers.py`:** Deterministic, network-free at startup. Litellm's bundled backup may lag newer models — that's an acceptable tradeoff given R6's fall-through to user override or text-only default, and consistent with R8 (frozen for session, restart picks up updates).
- **Metadata resolver wraps `litellm.get_model_info` in try/except, falls through to text-only default:** Critical — litellm raises `ValueError`, doesn't return None. The catch produces an explicit text-only default (`supports_vision=False`, `mode="chat"`, `max_input_tokens=None`, `max_output_tokens=None`) so the picker still renders sensibly for local/unknown models.
- **Field-level merge (not all-or-nothing) for metadata overrides:** User override keys are intersected with the four supported fields; only fields the user supplied win; the rest come from litellm. This is the lowest-cost override UX — users type one field, inherit the rest.
- **Use `base_url=` + `api_key=` as named kwargs to `litellm.acompletion`:** Matches the signature in litellm 1.83.7 (where `base_url` is the explicit named parameter, not `api_base`). The existing code at `client.py:329` already uses `base_url=` — extending with `api_key=` is consistent.
- **Format picker badges into the `PickerItem.label` string (not extending `PickerItem`/`OptionPicker`):** Lowest blast radius — the picker is shared by 5 commands; `_filter` already matches against `label.lower()`, so badges remain searchable. Extending `PickerItem` would touch every caller for no real win over a formatted string.
- **Recursive deep-merge for `providers.<alias>.models`:** The current `mcp_servers` merge (`config.py:203-208`) only merges one level of fields inside each entry — a nested `models` sub-dict would be replaced, not merged. A small recursive helper variant is needed so project-level config can add a single model to a home-level provider without clobbering the rest.
- **`list_models()` and the bare `Model` dataclass in `llm/models.py` removed:** R10 drops endpoint discovery; the picker builds from configured providers via the new resolver. The endpoint `/models` call (`src/stupidex/llm/models.py:18`) is dead code post-refactor.
- **RAG embeddings migrate to provider routing with `fastembed/` as a built-in pseudo-provider:** The `Embedder` accepts `alias/model` references just like `stream_response`. References with alias `"fastembed"` (e.g. `"fastembed/BAAI/bge-small-en-v1.5"`) short-circuit to the local ONNX path; all other references resolve through the providers dict and call `litellm.aembedding` with per-call `base_url` + `api_key`. The `rag_embedding_provider` top-level config field is dropped; `rag_embedding_model` becomes the sole embeddings config field, defaulting to `"fastembed/BAAI/bge-small-en-v1.5"` so a fresh install still gets zero-config local embeddings.

---

## Open Questions

### Resolved During Planning

- **Does `litellm.get_model_info` return None or raise for unknown models?** Raises `ValueError`. The resolver must try/except. Verified against litellm 1.83.7 source and GitHub issue #23054.
- **Exact litellm call kwargs for per-call base_url and api_key?** `base_url=` and `api_key=` as named params (not `api_base=`). Confirmed via `inspect.signature(litellm.acompletion)` on the installed version.
- **Exact field names returned by `get_model_info`?** `max_input_tokens`, `max_output_tokens`, `supports_vision`, `mode`, `litellm_provider`, `key`. NOT `max_tokens` (legacy, ambiguous). Confirmed via `litellm/types/utils.py:166-261`.
- **Does the existing `mcp_servers` deep-merge generalize to nested `models` sub-dicts?** No — it only merges one level. A recursive variant is required for `providers.<alias>.models` deep-merge (Outstanding Question Q4 from origin doc, resolved by U1 approach).
- **How are existing user configs containing the removed top-level fields handled?** Not migrated — the project is still in development, so users write a fresh config matching the new schema on upgrade. No legacy-key tolerance needed in `ConfigManager.load`.
- **What's the disposition of `list_models()` and the `Model` dataclass?** Removed entirely. R10 drops endpoint discovery; the picker builds from configured providers. (Origin Doc Outstanding Question Q3, resolved.)
- **API key form convention?** Two keys per provider entry: `api_key` (literal string value) OR `api_key_env` (string naming an env var). Both fields optional; resolver reads the one that's set. If `api_key_env` is set, resolver resolves `os.environ[name]` at startup; if the env var is unset, warn and skip the provider (matches mcp_servers warn-and-skip). (Origin Doc Outstanding Question Q1, resolved.)

### Deferred to Implementation

- Exact label format for picker badges (e.g., `"[vision]  gpt-4o  128k→16k"` or `"gpt-4o  🟦  128k in / 16k out"`) — finalize during U5 once the resolved object shape is concrete. Must remain plain-text since `Option.label` is a string and `_filter` matches on it.
- Whether the `default` provider seeded by `ensure_home_config` (R11) includes an API key (`api_key_env: "OPENAI_API_KEY"`) or leaves it unset (relying on litellm's env-default behavior). Probably the latter to avoid baking in an env-var-name assumption — but verify the unauthenticated path still produces a sensible error rather than a crash.
- `litellm.aembedding` signature: verify it accepts `base_url=` and `api_key=` as named kwargs in 1.83.7 (analogous to `acompletion`). If `aembedding` uses `api_base=` instead, adjust U6 accordingly. The liitellm source for `acompletion` declares `base_url=`; the embedding counterpart is expected to follow the same pattern but should be confirmed before implementation.

---

## Output Structure

No new directories — the additions live alongside existing modules:

```
src/stupidex/
├── config.py                         (modified: dataclass + merge + validate + ensure_home_config; drop rag_embedding_provider)
├── llm/
│   ├── client.py                     (modified: stream_response call site)
│   ├── models.py                     (deleted: list_models and Model removed per R10)
│   └── providers.py                  (NEW: resolution + metadata hydration, including embedding ref resolver)
├── rag/
│   ├── embedder.py                   (modified: migrate to alias/model refs; fastembed/ as pseudo-provider)
│   └── indexer.py                    (modified: drop cfg.provider_api_type arg at 2 sites, pass cfg.rag_embedding_model)
└── commands/
    └── session_commands.py           (modified: /model picker case)

src/stupidex/tools/
└── rag.py                            (modified: drop cfg.provider_api_type arg at 2 sites, pass cfg.rag_embedding_model)

tests/
├── test_providers_config.py          (NEW: validation, merge, defaults)
└── test_providers_resolution.py      (NEW: metadata hydration, field-level merge, raise-on-unknown, fastembed pseudo-provider)
```

---

## Implementation Units

- U1. **Extend Config dataclass with `providers` and remove top-level provider fields**

**Goal:** Replace the four single-provider config fields with a `providers` dict; add validation, deep-merge, first-run seed; drop the `rag_embedding_provider` field (replaced by `alias/model` references in `rag_embedding_model`).

**Requirements:** R1, R2, R3, R4, R11, R12

**Dependencies:** None (foundational; other units depend on this shape)

**Files:**
- Modify: `src/stupidex/config.py`
- Test: `tests/test_providers_config.py` (new)

**Approach:**
- Add `providers: dict[str, dict]` field to `Config` dataclass, defaulting to a `default_factory=lambda: {"default": {...today's defaults...}}`. The default `default` provider reproduces today's `https://opencode.ai/zen/go/v1` + `openai` + `mimo-v2.5`.
- The default `default_model` value becomes `"default/mimo-v2.5"` (R2). Default `tier_models` values become `"default/mimo-v2.5"` for all four tiers.
- Remove `base_url` and `provider_api_type` from the `Config` dataclass (they move into each provider entry). Keep `default_model` and `tier_models` as top-level fields (their values become `alias/model` strings).
- Add `_PROVIDER_ALIAS_RE = re.compile(r"^[a-z0-9-]+$")` mirroring `_MCP_SERVER_NAME_RE`. Aliases forbidding `/` via this regex (R3).
- Extend `_validate_config` with a provider-validation block mirroring the pattern at 163-184: warn-and-skip invalid entries. For each provider: validate `isinstance(dict)`, alias matches `_PROVIDER_ALIAS_RE` (already true from dict key), `base_url` is a non-empty string (optional if the provider is `anthropic` etc. where litellm supplies the URL — defer this nuance to implementation), `api_key` and `api_key_env` are mutually-exclusive strings if present (if both present, drop `api_key_env` with warning), `litellm_provider` is an optional string, `models` is a dict of `{model_id: {override fields}}`. Validate that metadata override keys are within the allowed set (`max_input_tokens`, `max_output_tokens`, `supports_vision`, `mode`, `litellm_provider`); warn and drop unknown override keys.
- Remove `STUPIDEX_BASE_URL` and `STUPIDEX_PROVIDER_API_TYPE` from `_ENV_MAP` (lines 90, 92). Keep `STUPIDEX_DEFAULT_MODEL` since `default_model` remains a top-level field.
- Update `_NON_EMPTY_STRINGS` (line 137) to drop `base_url` and `provider_api_type`; keep `default_model`.
- Drop the `rag_embedding_provider` top-level field (lines 69). Its role is subsumed by `rag_embedding_model`, which now accepts `alias/model` references (including the `fastembed/<model_id>` pseudo-provider handled in U6). Update `rag_embedding_model` default value to `"fastembed/BAAI/bge-small-en-v1.5"` (matches today's effective default of fastembed + the local ONNX model name in `DEFAULT_FASTEMBED_MODEL`). Remove `STUPIDEX_RAG_EMBEDDING_PROVIDER` from `_ENV_MAP`; keep `STUPIDEX_RAG_EMBEDDING_MODEL`. Drop the `valid_providers = {"", "openai", "fastembed"}` validation block at 159-161 (no longer relevant).
- Update the merge flow for the `providers` key in `ConfigManager.load` (lines 200-223): extract a shared `_deep_merge_provider_dict(home, project)` helper that recursively deep-merges per-provider entries AND their nested `models` sub-dicts. Reuse this helper for `mcp_servers` (the existing duplication at 203-208 and 216-221 is consolidated — same helper for both keys, with a recursion flag or two helpers depending on which keys have nested dicts to merge).
- Update `ensure_home_config` (lines 232-251): no logic change — `asdict(Config())` already writes the new `providers` field with its `default_factory` default. Confirm by inspecting the written JSON.
- No legacy-key tolerance needed — the project is still in development, so an existing user's `~/.stupidex/config.json` containing `base_url`/`provider_api_type` would simply fail `Config(**merged)`, signaling that the user needs to rewrite the config. (If the team prefers a softer landing, this is a follow-up — but not in scope per the user's directive.)

**Execution note:** Test-first on `_validate_config` and the merge helper as pure functions, mirroring `test_mcp_config.py`'s pattern (construct `Config(...)`, call `_validate_config(cfg)` directly).

**Patterns to follow:**
- `src/stupidex/config.py:163-184` (MCP server validation block — mirror for provider validation)
- `src/stupidex/config.py:203-208` and `:216-221` (the merge pattern to refactor and generalize)

**Test scenarios:**
- Happy path: Config with two valid providers (one with `api_key`, one with `api_key_env`) loads without warnings, both providers present in `cfg.providers`.
- Edge case: Empty `providers` dict — pin behavior (likely falls back to `default_factory` default, but verify).
- Edge case: Provider with alias containing `/` is skipped with a warning per R3; `covers AE4`.
- Edge case: Provider with both `api_key` and `api_key_env` set: `api_key_env` is dropped with a warning, `api_key` is used.
- Edge case: Provider entry that is not a dict is skipped with a warning.
- Edge case: Model override with unknown field (e.g. `{"cost_per_token": 0.001}`) is dropped with a warning.
- Edge case: `rag_embedding_model` default is `"fastembed/BAAI/bge-small-en-v1.5"`; `rag_embedding_provider` field is absent from `Config()`.
- Integration: project config with `providers.work-openai.models = {"gpt-4o": {"max_input_tokens": 32768}}` merging onto a home config `providers.work-openai.models = {"gpt-4o": {}, "gpt-4o-mini": {}}`: the resulting `gpt-4o` entry has `{"max_input_tokens": 32768}` and `gpt-4o-mini` is preserved (recursive merge for nested `models` sub-dict).
- Integration: `rag_embedding_model` env override via `STUPIDEX_RAG_EMBEDDING_MODEL="work-openai/text-embedding-3-large"` — verify env mapping still works.

**Verification:**
- `python -m pytest tests/test_providers_config.py -v` passes.
- `python -c "from stupidex.config import ConfigManager; ConfigManager.reset(); print(ConfigManager.load().providers)"` shows the `default` provider with the default URL/model.

---

- U2. **Add provider resolution and metadata hydration module**

**Goal:** New `src/stupidex/llm/providers.py` module that resolves `alias/model` strings to `(litellm_provider, model_id, base_url, api_key)` tuples and hydrates per-model metadata via field-level merge with `litellm.get_model_info`. Also exports `resolve_embedding_ref` for the RAG embedder to route `alias/model` embedding references (with `fastembed/` short-circuiting to local ONNX).

**Requirements:** R6, R8, R9

**Dependencies:** U1 (Config shape with `providers` dict must exist)

**Files:**
- Create: `src/stupidex/llm/providers.py`
- Test: `tests/test_providers_resolution.py` (new)

**Approach:**
- Set `LITELLM_LOCAL_MODEL_COST_MAP=True` at module import (before any `import litellm` happens — order matters; either set in this module's top-level before the litellm import, or in `main.py` startup before any litellm usage). Recommend setting in `src/stupidex/main.py` startup before the first litellm touch, AND defensively in this module's top.
- Three module-level functions following the existing `get_config` / `get_model_for_tier` pattern:
  - `get_provider(alias: str) -> dict`: returns the provider entry from `cfg.providers[alias]` or raises a typed `ProviderResolutionError`.
  - `resolve_model_ref(alias_model: str) -> tuple[str, str, str, str | None]`: split on first `/`, look up provider, resolve API key (literal `api_key` OR `os.environ[api_key_env]` if `api_key_env` is set), return `(litellm_provider, model_id, base_url, api_key)`. Raises `ProviderResolutionError` with a clear message if alias unknown or api_key env var unset. The model_id need not be pre-declared in `provider["models"]` (resolution succeeds even for undeclared models — the picker shows only declared ones, but the call site tolerates undeclared).
  - `resolve_model_metadata(alias: str, model_id: str) -> dict`: field-level merge of user override → `litellm.get_model_info` (wrapped in try/except ValueError) → text-only default (`{"max_input_tokens": None, "max_output_tokens": None, "supports_vision": False, "mode": "chat"}`). Only the four supported fields are returned; unknown fields from litellm are dropped.
  - `resolve_embedding_ref(model_ref: str) -> tuple[Literal["fastembed"], str] | tuple[str, str, str, str | None]`: handles embedding model references. If alias is `"fastembed"`, returns `("fastembed", model_id)` so the embedder routes to local ONNX (no provider lookup, no base_url, no api_key). Otherwise calls `resolve_model_ref` and returns the resolved `(litellm_provider, model_id, base_url, api_key)` tuple for `litellm.aembedding` to consume.
- Resolution is startup-once (matches R8). Either cache resolved metadata in a module-level dict on first access, OR run once at app startup (`src/stupidex/app.py` on_mount) and store on a module-level singleton. Recommend: lazy-cache on first access — simpler test setup. Add a `reset_cache()` function for tests.
- `litellm.get_model_info` is queried with the resolved litellm provider-qualified model string: `f"{provider['litellm_provider']}/{model_id}"` if `litellm_provider` is set in config, else just `model_id`. The provider-qualified form is more specific.
- Capabilities are derived (not stored separately): the picker derives the vision badge from `supports_vision` and the text badge from `mode in {"chat", "completion"}`.
- API key resolution: a helper `_resolve_api_key(provider: dict, alias: str) -> str | None` reads `api_key` (literal) first if set, else `api_key_env` (env var name → `os.environ[name]`); if the env var is unset, warn and skip the provider at validation time so resolution never reaches an unset env var. But also handle the None case in resolution — log a warning, return None, and let litellm fall back to its env detection (for OpenAI, `OPENAI_API_KEY`).

**Technical design**: *(directional, not implementation specification)*

```python
# Pseudo-flow for resolve_model_metadata(alias, model_id)
override = provider["models"].get(model_id, {})
qualified = f"{provider.get('litellm_provider', '')}/{model_id}".lstrip("/")
try:
    info = litellm.get_model_info(qualified)
    registry = {k: info.get(k) for k in ("max_input_tokens", "max_output_tokens", "supports_vision", "mode")}
except ValueError:
    registry = {}
default = {"max_input_tokens": None, "max_output_tokens": None, "supports_vision": False, "mode": "chat"}
return {**default, **registry, **override}  # override wins, registry fills, default handles None

# Pseudo-flow for resolve_embedding_ref(model_ref)
alias, _, model_id = model_ref.partition("/")
if alias == "fastembed":
    return ("fastembed", model_id)
return resolve_model_ref(model_ref)
```

**Patterns to follow:**
- `src/stupidex/config.py:283-315` — module-level helpers like `get_config`, `get_model_for_tier`.

**Test scenarios:**
- Happy path: Provider `work-openai` with `litellm_provider: "openai"` and model `gpt-4o` (no override) — `resolve_model_metadata("work-openai", "gpt-4o")` returns dict with `supports_vision=True`, `mode="chat"`, and integer `max_input_tokens` / `max_output_tokens` matching litellm's registry for `openai/gpt-4o`. Mock `litellm.get_model_info` to return a known dict.
- `covers AE2` — Provider with `gpt-4o` whose override is `{"max_input_tokens": 32768}` only: resolved metadata has `max_input_tokens=32768` (override), the other three fields inherited from litellm.
- `covers AE3` — Provider with `local-llama-70b` that litellm's `get_model_info` raises on (mock raises ValueError): resolved metadata has the user-supplied fields plus `supports_vision=False`, `mode="chat"` defaults for anything omitted.
- Edge case: Provider with `litellm_provider` unset — `resolve_model_metadata` uses bare `model_id` (no prefix) when querying `get_model_info`.
- Edge case: Resolve an unknown alias — `resolve_model_ref("nonexistent/model")` raises `ProviderResolutionError` with a message naming the alias.
- Edge case: Resolve a known alias with an undeclared model (not in `provider["models"]`) — resolution succeeds, metadata falls through to litellm registry or text-only default.
- Edge case: `resolve_embedding_ref("fastembed/BAAI/bge-small-en-v1.5")` returns `("fastembed", "BAAI/bge-small-en-v1.5")` — no provider lookup, no litellm call.
- Edge case: `resolve_embedding_ref("work-openai/text-embedding-3-small")` returns the resolved `(litellm_provider, model_id, base_url, api_key)` tuple, identical to what `resolve_model_ref` would return for the same reference.
- Error path: `api_key_env` set to an env var that doesn't exist — provider is skipped at validation (U1); confirm `resolve_model_ref` returns `api_key=None` so litellm falls back to its default env detection.
- Integration: calling `resolve_model_metadata` twice for the same `(alias, model_id)` returns the cached result without re-querying litellm (mock called once).

**Verification:**
- `python -m pytest tests/test_providers_resolution.py -v` passes.
- `python -c "from stupidex.llm.providers import resolve_model_metadata; print(resolve_model_metadata('default', 'mimo-v2.5'))"` returns a dict with the four fields (without crashing).
- `python -c "from stupidex.llm.providers import resolve_embedding_ref; print(resolve_embedding_ref('fastembed/BAAI/bge-small-en-v1.5'))"` returns the pseudo-provider tuple.

---

- U3. **Update `stream_response` to resolve `alias/model` and pass per-call `base_url` + `api_key`**

**Goal:** The litellm call site in `src/stupidex/llm/client.py` resolves `alias/model` strings via the new resolver and passes resolved `base_url` and `api_key` per call.

**Requirements:** R9 (covers F3 — agent call routes to the correct provider)

**Dependencies:** U2 (resolver exists)

**Files:**
- Modify: `src/stupidex/llm/client.py`
- Test: `tests/test_streaming_messages.py` (extend with a new test case) or `tests/test_llm_client.py` (new — prefer extending existing convention)

**Approach:**
- At the top of `stream_response` (around line 303 where `cfg = get_config()` is read), call `resolve_model_ref(model or cfg.default_model)` once to get `(litellm_provider, model_id, base_url, api_key)`. Construct the litellm model string as `f"{litellm_provider}/{model_id}"` if `litellm_provider` is truthy, else just `model_id`.
- Update the `litellm.acompletion(...)` call at lines 325-332 to pass `model=<resolved string>`, `base_url=<resolved url>`, `api_key=<resolved key or None>`. Drop the `cfg.provider_api_type + "/" + (model or cfg.default_model)` assembly at line 326.
- Resolution happens once before the `while True` loop (the model is fixed for the session — no need to re-resolve per iteration).
- Extend `classify_error` (lines 26-51) with a branch for `ProviderResolutionError` mapping to a clear user-facing message ("Unknown provider" or "Model not found").

**Execution note:** Test-first — add a test that mocks `litellm.acompletion`, calls `stream_response` with a known `alias/model`, and asserts the mocked `acompletion` was called with the correct `base_url`, `api_key`, and `model=` kwargs. Pattern from `test_streaming_messages.py`.

**Patterns to follow:**
- `tests/test_streaming_messages.py:613` — `unittest.mock.patch` for swapping `litellm.acompletion`.
- `tests/test_streaming_messages.py:22-28` — `SimpleNamespace` chunk construction for fake async generators.

**Test scenarios:**
- Happy path: `stream_response(model="default/mimo-v2.5", ...)` calls `litellm.acompletion` with `model="openai/mimo-v2.5"` (or whatever the default `litellm_provider` is), `base_url="https://opencode.ai/zen/go/v1"`, `api_key=<resolved or None>`. Mock and assert kwargs.
- Happy path: A model with `api_key="sk-..."` literal in config: `acompletion` called with `api_key="sk-..."`.
- Happy path: A model with `api_key_env="OPENAI_KEY"` and the env var set: `acompletion` called with `api_key=<env value>`.
- Error path: `stream_response(model="unknown/model", ...)` raises `ProviderResolutionError` and it's surfaced as a typed error message (not a generic stack trace).
- `covers F3` — an LLM stream requested for `alias/model` resolves to the matching provider and passes the tuple to litellm; existing streaming, tool-call, and message-handling paths are unchanged (no tool-call or message-format assertions change).

**Verification:**
- `python -m pytest tests/test_streaming_messages.py -v` passes (extended assertions).
- App launches and a `/model` selection produces a working stream (manual smoke after U5 lands).

---

- U4. **Update tier_models and default_model to emit `alias/model` strings**

**Goal:** Shipping `Config()` defaults for `default_model` and `tier_models` use `alias/model` references (e.g., `"default/mimo-v2.5"`); verify `get_model_for_tier` and `SessionManager.create` emit valid references to the new resolver.

**Requirements:** R2 (covers F4 — first-run with no user config)

**Dependencies:** U1 (Config shape updated)

**Files:**
- Modify: `src/stupidex/config.py` (dataclass defaults — already done in U1; this unit is verification + any missed call sites)
- Test: `tests/test_providers_config.py` (extend — assert defaults)

**Approach:**
- The `Config()` defaults are updated as part of U1: `default_model="default/mimo-v2.5"`, all four `tier_models` values = `"default/mimo-v2.5"`. This unit is mostly verification that every consumer of `default_model` and `get_model_for_tier` works without modification:
  - `src/stupidex/domain/session.py:35` — `SessionManager.create()` sets `model=cfg.default_model` — string format change only, no code change.
  - `src/stupidex/config.py:289` — `get_model_for_tier` returns `cfg.tier_models.get(tier, cfg.default_model)` — string format change only, no code change.
  - `src/stupidex/tools/subagent.py:76` — `model = get_model_for_tier(...)` — passes the string through to the (U3-updated) `stream_response`.
- If `app.py` (line 87, `self.model`) or `change_model` (`session.py:57-59`) does any prefix-validation or string manipulation on model strings, verify they tolerate `alias/model` format. From the research, neither does — they pass strings through opaquely.

**Execution note:** Mostly verification — no new code if U1 and U3 landed cleanly. Add a test that constructs `Config()` default and asserts `cfg.default_model == "default/mimo-v2.5"` and `cfg.tier_models["tolo"] == "default/mimo-v2.5"` etc.

**Patterns to follow:**
- `tests/test_mcp_config.py:11-13` — pure-function instantiation pattern for `Config()` defaults.

**Test scenarios:**
- Happy path: `Config()` default has `default_model == "default/mimo-v2.5"` and all four `tier_models` values resolve to `"default/mimo-v2.5"`.
- `covers F4` — first-run install: `ConfigManager.reset(); ensure_home_config()` writes a `providers.default` entry; `ConfigManager.load().default_model` is `"default/mimo-v2.5"`; `get_model_for_tier("tolo")` returns `"default/mimo-v2.5"`.
- Edge case: Custom config with `tier_models.tolo = "work-openai/gpt-4o-mini"` — `get_model_for_tier("tolo")` returns the string; passes to `stream_response` which resolves it.
- Edge case: Custom config with `tier_models.tolo = "missing-alias/gpt-4o"` — value is stored, but resolution at call time raises `ProviderResolutionError` (handled by U3's error classification).

**Verification:**
- `python -m pytest tests/test_providers_config.py -v` passes (extended defaults test).

---

- U5. **Update `/model` picker to display metadata badges from configured providers**

**Goal:** The `/model` command in `src/stupidex/commands/session_commands.py` builds the picker list from configured providers (not endpoint discovery), with each entry's label showing capability badges and token shorthand derived from resolved metadata.

**Requirements:** R7, R10

**Dependencies:** U1 (Config shape), U2 (resolver)

**Files:**
- Modify: `src/stupidex/commands/session_commands.py`
- Delete: `src/stupidex/llm/models.py` (the `Model` dataclass and `list_models()` — `R10` drops endpoint discovery)
- Test: `tests/test_session_commands.py` (new — or extend an existing commands test if present)

**Approach:**
- Replace the `/model` case (lines 55-67) with code that iterates `cfg.providers` and builds `PickerItem` entries:
  - For each provider alias, iterate its `models` dict.
  - Call `resolve_model_metadata(alias, model_id)` to get the resolved dict.
  - Build the label as something like `f"{alias}/{model_id}  [vision]  {max_in}k→{max_out}k"` — exact format deferred to implementation (Open Question).
  - The `id` is the `alias/model` string (which `change_model` already accepts at `session.py:57-59`).
- Drop the `from stupidex.llm.models import list_models` import at line 8.
- Delete `src/stupidex/llm/models.py` entirely — `list_models()` and the bare `Model` dataclass are dead code per R10. Verify no other importers (grep before delete).

**Execution note:** Verify the picker label format renders well in the TUI before finalizing — run `stupidex` and open `/model` to check the label width doesn't break the layout.

**Patterns to follow:**
- `src/stupidex/commands/session_commands.py:68-82` (`/theme` case — similar structure: build PickerItems from a registry, push OptionPicker).
- `src/stupidex/screens/picker.py:31-33` (`_filter` matches on `label.lower()` — badges remain searchable).

**Test scenarios:**
- Happy path: Config with two providers each having one model — picker builds 2 items, each labeled `alias/model  [badges]  tokens`.
- `covers AE5` — Two providers, multiple models: picker shows `work-openai/gpt-4o`, `work-openai/gpt-4o-mini`, `anthropic-prod/claude-3-opus` with badges and tokens; capability badges derived from `supports_vision` and `mode`.
- Edge case: A model with `supports_vision=True` has a `[vision]` badge; one with `supports_vision=False` does not.
- Edge case: A model with `max_input_tokens=None` (litellm didn't know it, user didn't override) renders without token shorthand (e.g., omits `→16k`) rather than showing `None→None`.
- Edge case: Empty `models` dict in a provider — provider contributes no picker items.
- Error path: `resolve_model_metadata` raises for one model — that model is skipped with a `log.warning`; other models still appear.

**Verification:**
- `python -m pytest tests/test_session_commands.py -v` passes.
- Manual: launch `stupidex`, run `/model`, see all configured models with badges and token shorthand; selecting one switches the active session's model.

---

- U6. **Migrate RAG embeddings to provider routing with `fastembed/` pseudo-provider**

**Goal:** The `Embedder` accepts `alias/model` references via `rag_embedding_model` and routes through the providers dict (with `litellm.aembedding` getting per-call `base_url` + `api_key`), while `"fastembed/<model_id>"` references short-circuit to the existing local ONNX path. Drops the `rag_embedding_provider` config field (already removed in U1) and the `Embedder.provider_api_type` constructor parameter.

**Requirements:** R2 (cleanup after field removal), R9 (routing applies to embeddings too)

**Dependencies:** U1 (Config shape updated, `rag_embedding_provider` dropped, `rag_embedding_model` default is `"fastembed/BAAI/bge-small-en-v1.5"`), U2 (`resolve_embedding_ref` exported from `llm/providers.py`)

**Files:**
- Modify: `src/stupidex/rag/embedder.py`
- Modify: `src/stupidex/rag/indexer.py`
- Modify: `src/stupidex/tools/rag.py`
- Test: `tests/test_rag_smoke.py` (extend — assert both fastembed and litellm routing paths work)
- Test: `tests/test_rag_embedder.py` (new — unit tests for the routing switch in `Embedder`)

**Approach:**
- In `Embedder.__init__` (`embedder.py:19-24`): drop the `provider_api_type: str = "openai"` and `embedding_provider: str = ""` parameters. Replace with a single `model: str` parameter that holds the `alias/model` reference (the caller passes `cfg.rag_embedding_model`). Remove `self.provider_api_type` and `self.embedding_provider` attributes.
- Replace `_resolve_provider` and `_resolve_model` (`embedder.py:29-45`) with a single `_resolve_ref()` that calls `resolve_embedding_ref(self.model)` from `llm/providers.py`. Returns either `("fastembed", model_id)` or `(litellm_provider, model_id, base_url, api_key)`.
- Update `embed()` (`embedder.py:47-64`) to branch on the resolved tuple type: if first element is `"fastembed"`, call `_embed_fastembed(model_id, texts)`; else call `_embed_litellm(litellm_provider, model_id, base_url, api_key, texts)`.
- Update `_embed_litellm` (`embedder.py:86-116`) to call `litellm.aembedding(model=f"{litellm_provider}/{model_id}", input=texts, base_url=base_url, api_key=api_key)` — adding the per-call `base_url=` and `api_key=` kwargs (analogous to `acompletion` in U3). The model string passed to litellm is provider-qualified (litellm routes by prefix). Drop the previous `model=model` form that relied on litellm's env-default behavior.
- Drop the `provider_api_type=cfg.provider_api_type, embedding_provider=cfg.rag_embedding_provider` arguments in the 4 `Embedder(...)` calls (`rag/indexer.py:84-88`, `rag/indexer.py:95-100`, `tools/rag.py:84-88`, `tools/rag.py:176-180`). Pass only `model=cfg.rag_embedding_model`. The duplicated `Embedder(...)` constructions at `indexer.py:84-88` and `:95-100` are a refactor opportunity but out of scope for this unit.
- Remove `DEFAULT_OPENAI_MODEL` constant (`embedder.py:6`) — no longer needed since the model is always supplied via config. Keep `DEFAULT_FASTEMBED_MODEL` (`embedder.py:7`) as the implicit fastembed model fallback only if a user passes `"fastembed"` without a model (edge case — consider this an error: `"fastembed"` alone is not a valid `alias/model` reference; require `"fastembed/<model_id>"`).

**Execution note:** Test-first on the routing switch in `Embedder.embed()` — mock `litellm.aembedding` and `_embed_fastembed`, assert each branch is taken correctly based on the input `alias/model` reference.

**Patterns to follow:**
- `src/stupidex/llm/client.py:325-332` (the `litellm.acompletion` call shape U3 establishes — `base_url=` + `api_key=` named kwargs, provider-qualified model string).

**Test scenarios:**
- Happy path: `Embedder("fastembed/BAAI/bge-small-en-v1.5").embed(["text"])` calls `_embed_fastembed`, not `litellm.aembedding`. No provider lookup happens.
- Happy path: `Embedder("work-openai/text-embedding-3-small").embed(["text"])` calls `litellm.aembedding` with `model="openai/text-embedding-3-small"`, `base_url=<work-openai url>`, `api_key=<resolved>`. Mock and assert kwargs.
- Edge case: `Embedder("fastembed")` (no model id) — decide and pin: either raises `EmbeddingError` ("fastembed requires a model id, use `fastembed/<model_id>`") or falls back to `DEFAULT_FASTEMBED_MODEL`. Recommend raising — matches the `alias/model` strictness elsewhere.
- Edge case: An empty text list returns `[]` without calling any embedder (preserve existing behavior at `embedder.py:48-49`).
- Error path: `Embedder("unknown-alias/text-embedding-3-small")` raises `ProviderResolutionError` (propagated from `resolve_embedding_ref`); the caller (`rag_search`, `rag_index`) maps it to an `ExecutorResult` error message.
- Error path: `litellm.aembedding` raises — existing retry logic at `embedder.py:89-110` (3 retries with exponential backoff) still applies; final failure raises `EmbeddingError` as today.
- Integration: `rag_index` tool with default config (`rag_embedding_model="fastembed/BAAI/bge-small-en-v1.5"`) indexes a small project without network calls (smoke test).
- Integration: `rag_search` tool with a provider-routed embedding model returns results (mock `litellm.aembedding` to return canned embeddings; assert cosine similarity works end-to-end through `RAGStore.search`).

**Verification:**
- `python -m pytest tests/test_rag_embedder.py tests/test_rag_smoke.py tests/test_rag_tools.py -v` passes.
- `ruff check src/stupidex/rag/embedder.py src/stupidex/rag/indexer.py src/stupidex/tools/rag.py` clean.
- `python -c "from stupidex.rag.embedder import Embedder; e = Embedder('fastembed/BAAI/bge-small-en-v1.5'); import asyncio; print(asyncio.run(e.embed_single('hello'))[:5])"` returns a 5-element float list (local ONNX, no network).

---

## System-Wide Impact

- **Interaction graph:** `stream_response` (the central streaming entry point in `src/stupidex/llm/client.py`) and `Embedder.embed` (in `src/stupidex/rag/embedder.py`) both gain a new dependency on `src/stupidex/llm/providers.py`. `SessionManager.create` (`domain/session.py:31-39`) and `get_model_for_tier` (`config.py:287-289`) emit differently-formatted strings but no code change. `/model` command (`commands/session_commands.py:55-67`), the `litellm.acompletion` call site, the `litellm.aembedding` call site, and the 4 `Embedder(...)` construction sites change shape.
- **Error propagation:** A new `ProviderResolutionError` typed exception flows from `llm/providers.py` → `stream_response` → `classify_error` (must add a branch) and from `llm/providers.py` → `Embedder.embed` → `rag_search`/`rag_index` tools → `ExecutorResult` (already-error-shaped). Resolution failures become user-facing error messages, not crashes. Validation-time failures (in `_validate_config`) follow warn-and-skip per the mcp_servers pattern.
- **State lifecycle risks:** Resolved metadata is cache-once at module level; `reset_cache()` must be called in tests or single-config tests will see leakage. `ConfigManager.reset()` (existing) clears the singleton but not the providers cache — add a call to `providers.reset_cache()` if it exists, or document that `ConfigManager.reset()` does not invalidate provider cache.
- **API surface parity:** No external API changes; this is internal plumbing. The `/model` command, `default_model`, `tier_models`, `SessionManager.change_model`, and `rag_embedding_model` interface contracts are preserved (string IDs become `alias/model` strings, but the contract is "string ID"). `rag_embedding_provider` is removed entirely.
- **Integration coverage:** Cross-layer scenarios unit tests alone will not prove: (a) `stream_response` plus the litellm call actually streams when given a real `alias/model`; (b) `Embedder` plus `litellm.aembedding` actually embeds when given a real `alias/model`. Add a smoke test for each after implementation. (The first-run default `fastembed/BAAI/bge-small-en-v1.5` means RAG smoke tests need no network.)
- **Unchanged invariants:** existing agent flow (system prompt building at `llm/static_system_prompt.py` and `llm/dynamic_system_prompt.py`), tool execution (`_execute_tool`, `_stream_task`, `_executor_task`), MCP tool integration (`tools/mcp_resource.py`), and subagent spawning (`tools/subagent.py`) are unchanged. They consume the `model` string opaquely and pass it through; the format change (`alias/model`) is transparent.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `litellm.get_model_info` raises for unknown models — naive code crashes | Try/except in `resolve_model_metadata`; text-only fallback. Tested in U2. |
| Picker label format breaks `OptionPicker._filter` matching | Format badges into the `label` string (searchable); no `OptionPicker` changes. Verified by U5 tests. |
| `LITELLM_LOCAL_MODEL_COST_MAP=True` setting races other code importing litellm first | Set env var in `src/stupidex/main.py` startup before any `import litellm`. Verified by smoke test. |
| Litellm version drift (version unpinned in `pyproject.toml`) breaks the `base_url`/`api_key` kwarg contract | Tests assert the call shape; CI matrix catches drift. The litellm API has been stable across v1.6x–v1.83. |
| `litellm.aembedding` signature differs from `acompletion` (e.g. doesn't accept `base_url`/`api_key`) | Deferred-to-implementation verification of `aembedding` signature; tests in U6 assert the call kwargs. If `aembedding` uses `api_base` instead, U6 adjusts. Same fix as U3 if both kwarg names are needed. |
| Resolved metadata cache leaks across tests | `reset_cache()` helper; tests call `ConfigManager.reset()` and `providers.reset_cache()` in setUp. |
| `providers` merge semantics differ from `mcp_servers` (nested `models` deep-merge) | New recursive helper tested explicitly in U1; behavior pinned by integration test for `models.<id>` field-level merge. |
| User passes a bare model name (no `/`) to `Embedder` or `stream_response` | `resolve_*_ref` raises `ProviderResolutionError` with a clear message; covered by U2/U6 tests. |
| `fastembed` model name collision with a user-defined `fastembed` provider alias | The pseudo-provider check happens before provider-dict lookup; a user alias literally named `fastembed` is shadowed. Document this as a reserved alias. Consider validating in U1 that no provider alias is `fastembed`. |

---

## Documentation / Operational Notes

- Update `README.md` "Some ground rules" or any config documentation section to reflect the new `providers` config shape and the `rag_embedding_model` `alias/model` convention. Check `README.md` for example configs that would need updating.
- The reserved alias `fastembed` is built-in; users should not define a provider alias named `fastembed`. The resolver short-circuits to local ONNX before consulting the providers dict. U1 should validate and warn if a user defines `providers.fastembed`.
- The `/ce-compound` step after landing should capture: the litellm `get_model_info` raise behavior, the `LITELLM_LOCAL_MODEL_COST_MAP=True` convention, the `api_key` vs `api_key_env` pattern, the recursive-merge requirement for the providers key, the `fastembed/` pseudo-provider convention for local embeddings, and the `litellm.aembedding` kwarg contract.

---

## Sources & References

- **Origin document:** [docs/brainstorms/multi-providers-requirements.md](docs/brainstorms/multi-providers-requirements.md)
- Code: `src/stupidex/config.py` (Config dataclass, ConfigManager, _validate_config, ensure_home_config)
- Code: `src/stupidex/llm/client.py` (stream_response litellm call site)
- Code: `src/stupidex/llm/models.py` (to be deleted per R10)
- Code: `src/stupidex/screens/picker.py` (OptionPicker, PickerItem)
- Code: `src/stupidex/commands/session_commands.py` (/model command)
- Code: `src/stupidex/rag/embedder.py`, `src/stupidex/rag/indexer.py`, `src/stupidex/tools/rag.py` (embeddings routing migration)
- Tests: `tests/test_mcp_config.py` (validation test pattern), `tests/test_streaming_messages.py` (litellm.acompletion mocking pattern), `tests/test_rag_smoke.py` (RAG embedding smoke pattern)
- External: litellm `get_model_info` source verified against installed v1.83.7; [GitHub issue #23054](https://github.com/BerriAI/litellm/issues/23054) confirming raise behavior
- External: litellm token usage docs, https://docs.litellm.ai/docs/completion/token_usage (LITELLM_LOCAL_MODEL_COST_MAP)
