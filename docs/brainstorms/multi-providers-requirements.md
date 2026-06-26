---
date: 2026-06-18
topic: multi-providers
---

# Multi-Provider Support

## Summary

Replace stupidex's single-provider config with a `providers` dict where users define one or more providers (url, api key, models). Models are referenced as `provider_alias/model`. Per-model metadata (`max_input_tokens`, `max_output_tokens`, `supports_vision`, `mode`) uses litellm's own field names verbatim and is sourced from the litellm registry by default with user overrides winning; capability badges (vision, text) shown in the picker are derived from `supports_vision` and `mode`. v1 surfaces the data in the model picker so future behavioral consumption can build on a captured dataset.

---

## Problem Frame

Stupidex is currently locked to one provider through four top-level `Config` fields: `base_url`, `provider_api_type`, `default_model`, and `tier_models`. A user who wants to talk to a second endpoint — a different OpenAI account, a local Llama server, an Anthropic model, a corporate proxy — has no path other than editing config and swapping env vars by hand before each launch.

Beyond routing, the app has no knowledge of model characteristics. `stream_response` sends text-only messages and never truncates context, and the model picker shows bare IDs with no signal about context window, output cap, or modality. As the app grows toward multi-model and multi-provider use, this absence becomes the bottleneck: capability-aware behavior (history truncation, vision-call gating, tier filtering) can't be built until the data exists.

---

## Actors

- A1. **End user**: Configures providers in config files (url, api key either inline or as env-var reference, per-model metadata overrides), launches stupidex, expects models from all configured providers to appear in the picker with their capabilities shown.
- A2. **Agent (general/subagent)**: Receives tool calls and streams responses via litellm; unaware of provider routing, just uses the resolved `(litellm_provider, model, base_url, api_key)` tuple.
- A3. **litellm registry**: External source of default per-model metadata (`max_input_tokens`, `max_output_tokens`, `supports_vision`, `mode`) consulted at startup for known models.

---

## Key Flows

- F1. **App startup — provider discovery and metadata hydration**
  - **Trigger:** User launches `stupidex`
  - **Actors:** A1, A3
  - **Steps:** Load config → read `providers` section → for each provider, validate (alias, url, api key form, models) → for each configured model, resolve metadata: user override (field-level merge) → litellm registry (queried with the resolved litellm provider string) → empty/text-only fallback → store resolved provider/model objects → log summary of discovered providers and models
  - **Outcome:** All configured providers and their models are known to the app, each model carrying its final resolved metadata, ready for picker display and call-site resolution.
  - **Covered by:** R1, R2, R3, R5, R6, R8

- F2. **User selects a model in the picker**
  - **Trigger:** User opens the model picker
  - **Actors:** A1
  - **Steps:** Picker lists every configured model across all providers, keyed by `alias/model` → each entry shows `max_input_tokens`, `max_output_tokens`, and capability badges (vision, text) — vision derived from `supports_vision`, text derived from `mode` → user selects an entry → the `alias/model` string becomes the active model reference for the session
  - **Outcome:** Session's `default_model` (or per-tier model, depending on entry point) is set to a provider-qualified reference; picker surfaced capability metadata to inform the choice.
  - **Covered by:** R7, R9

- F3. **Agent call routes to the correct provider**
  - **Trigger:** LLM stream requested for a given `alias/model` reference
  - **Actors:** A2
  - **Steps:** Resolve `alias/model` → look up provider by alias → assemble `(litellm_provider, model, base_url, api_key)` from provider config and the chosen model → call litellm with those parameters → stream back as today
  - **Outcome:** The call hits the correct endpoint with the correct credentials; existing streaming, tool-call, and message-handling paths are unchanged.
  - **Covered by:** R1, R4, R10

- F4. **First-run with no user config**
  - **Trigger:** Fresh install launches `stupidex` for the first time
  - **Actors:** A1
  - **Steps:** `ensure_home_config` writes the shipping default config → default config contains a single `"default"` provider entry (url, api-key form, and one model) that reproduces today's out-of-box behavior → app loads with that provider as the sole source of models
  - **Outcome:** A new user can launch the app and get a working model without editing config; existing users who never touched config land in the same working state.
  - **Covered by:** R1, R11

---

## Requirements

**Provider configuration**
- R1. Users define one or more providers under a `providers` key in `~/.stupidex/config.json` and `.stupidex.json`. Each provider entry has an alias (used as the routing prefix in `alias/model` references), a base URL, an API key (in one of two supported forms), an optional litellm provider name, and its own models dict.
- R2. The top-level `base_url`, `provider_api_type`, `default_model`, and `tier_models` config fields are removed. `providers` is the sole source of provider and model configuration. `default_model` and `tier_models` values, where they still appear in config or agent definitions, become `alias/model` strings.
- R3. Provider aliases must not contain `/` so the `alias/model` reference syntax stays unambiguous. Validation rejects invalid aliases with a logged warning and skips that provider.
- R4. Each provider's API key is configured in one of two forms, selectable per provider: a literal value written directly in the config file, OR a reference to an environment variable by name. Both forms coexist — a user may use an env-var reference for one provider and an inline literal for another.

**Models and metadata**
- R5. Each provider entry contains a `models` dict. Each model entry has a model ID (the part used in `alias/model`) and optional per-model metadata overrides using litellm's field names verbatim: `max_input_tokens`, `max_output_tokens`, `supports_vision` (bool), and `mode` (e.g., `"chat"`, `"completion"`). Fields not supplied by the user fall through to the litellm registry or empty/text-only defaults. Convention is one-to-one with litellm so a user can copy any field value from litellm's docs into their config without translation.
- R6. For any `(provider, model)`, final metadata resolution is a field-level merge in this order: (a) user override from the provider's `models` entry — any field the user supplied wins; (b) litellm registry, queried with the resolved litellm provider-qualified model string — fills any field the user didn't override; (c) empty fallback, with `supports_vision` defaulting to `False` and `mode` defaulting to `"chat"` (text-only) — for fields litellm doesn't know and the user didn't supply. A user overriding just `max_input_tokens` still inherits `max_output_tokens`, `supports_vision`, and `mode` from litellm.
- R7. The model picker lists all configured models across all providers, displayed as `alias/model`. Each entry shows the resolved `max_input_tokens`, `max_output_tokens`, and capability badges derived from the resolved metadata: "vision" badge when `supports_vision` is `True`, "text" badge when `mode` is `"chat"` or `"completion"`.
- R8. Metadata is refreshed once at startup and frozen for the session. Restarting the app picks up newly released model metadata from the litellm registry; users do not need to edit anything to get updated capabilities for known models.

**Routing and discovery**
- R9. Model references used by `default_model`, `tier_models`, agent definitions, and the picker selection screen are `alias/model` strings. The call site resolves the alias to the matching provider and passes the `(litellm_provider, model, base_url, api_key)` tuple to litellm.
- R10. Model discovery aggregates across all configured providers rather than hitting a single endpoint. Each provider's models come from its `models` dict in config; the picker reflects the full configured set, not one endpoint's catalog.

**Defaults and compatibility**
- R11. The shipping default config (written on first run by the existing `ensure_home_config` path) contains a single `"default"` provider entry that reproduces today's out-of-box endpoint, provider type, and starter model. A fresh install launches and runs without any user config edits.
- R12. Project-level config (`.stupidex.json`) merges with home config. Project `providers` entries with the same alias as home entries override the home entry; project entries with new aliases are added. Merge semantics follow the existing per-key deep-merge pattern already used for `mcp_servers`.

---

## Acceptance Examples

- AE1. **Covers R1, R4.** Given a provider `work-openai` configured with `api_key_env: "OPENAI_KEY"` and a provider `local-llama` configured with `api_key: "sk-local-dev"`, when stupidex launches, then both providers are loaded: the first resolves its key from the `OPENAI_KEY` environment variable, the second uses the inline literal directly.
- AE2. **Covers R6.** Given a provider with a model `gpt-4o` whose config entry is `{ "max_input_tokens": 32768 }` (override only) and no other metadata fields, when metadata is resolved at startup, then the final model object has `max_input_tokens` `32768` (from user override), and `max_output_tokens`, `supports_vision`, and `mode` inherited from the litellm registry entry for `gpt-4o`.
- AE3. **Covers R6.** Given a provider with a model `local-llama-70b` that the litellm registry does not know, when metadata is resolved at startup, then the final model object has whatever fields the user supplied in config plus the empty fallback (`supports_vision` = `False`, `mode` = `"chat"` — i.e., a text-only model) for anything the user omitted.
- AE4. **Covers R3.** Given a provider alias `my/proxy` (contains `/`), when stupidex launches, then a warning is logged and that provider is skipped; all other providers load normally.
- AE5. **Covers R7, R9.** Given two configured providers `work-openai` (models: `gpt-4o`, `gpt-4o-mini`) and `anthropic-prod` (model: `claude-3-opus`), when the user opens the picker, then the list shows `work-openai/gpt-4o`, `work-openai/gpt-4o-mini`, and `anthropic-prod/claude-3-opus`, each entry showing its `max_input_tokens`, `max_output_tokens`, and capability badges.
- AE6. **Covers R11.** Given a fresh install with no `~/.stupidex/config.json`, when the user launches stupidex for the first time, then `ensure_home_config` writes a default config containing a `providers` section with a `default` provider, and the app launches with a working model available without any further edits.

---

## Success Criteria

- A user can add a second provider to their config, launch the app, and see its models in the picker alongside the first provider's models, with no code changes.
- Every model in the picker shows accurate `max_input_tokens`, `max_output_tokens`, and capability badges — accurate means matching litellm's registry for known models, matching user overrides where supplied, and falling back cleanly (text-only) for unknown models.
- A first-run install with no user config lands in a working state indistinguishable in behavior from today's first run.
- Capability metadata is captured and queryable at the resolved model object level, so downstream behavioral features (context truncation, vision-call gating, tier filtering) can be built on top of it without re-architecting config or routing.
- Existing flows — agent streaming, tool execution, subagent tier resolution — work unchanged once the call site resolves `alias/model` to a provider tuple.

---

## Scope Boundaries

- Capability-driven behavior (context truncation to fit `max_input_tokens`, refusing vision calls on models with `supports_vision` = `False`, capability filtering when assigning tier models) — deferred to future work that builds on the captured metadata
- Lazy / runtime metadata refresh — startup-only for v1; restarting picks up registry updates
- Per-provider concurrency limits, rate-limit pooling, endpoint failover routing — v1 routes each call to its named provider, no failover
- Multi-key rotation, key vaults, or OAuth flows per provider — one key per provider in v1, in either inline or env-var form
- Built-in catalog of popular providers or provider presets — users configure providers explicitly
- Cost-per-token, latency, availability, or other litellm registry fields beyond `max_input_tokens`, `max_output_tokens`, `supports_vision`, and `mode` — not surfaced in v1
- Per-provider usage analytics or accounting
- A UI for editing providers from inside the app — config-file editing only in v1

---

## Key Decisions

- **Replace, don't extend, the top-level provider fields:** Removing `base_url`, `provider_api_type`, `default_model`, and `tier_models` entirely eliminates dual sources of truth. The cost (existing configs break, including the shipping default) is paid once by seeding a `default` provider in the first-run config.
- **Hybrid metadata source with field-level merge:** Users get accurate data for litellm-known models without typing anything, and can override any single field where litellm is wrong, missing, or where a proxy truncates differently from the upstream model. Field-level merge (not all-or-nothing) keeps the override cost low.
- **API key form is per-provider, both forms coexist:** Env-var references match litellm's convention and keep real secrets off disk; inline literals support local-LLM dev keys and rapid iteration. The form is chosen per provider, so a user can mix.
- **litellm registry consulted with the resolved provider string, not the alias:** litellm lookups differ by provider (e.g., `gpt-4o` under `openai` vs. `azure` — the alias is a stupidex-level routing concern, not a litellm-level one).
- **Startup-only metadata refresh:** Matches the existing config-load-once behavior. Avoids runtime registry calls in the streaming hot path.
- **Model discovery via config, not endpoint `/models`:** The current single-endpoint `/models` call is dropped; the picker reflects configured models, not discovered ones. Users add models to config explicitly. Keeps the picker deterministic and avoids partial-failure states from a flaky endpoint.
- **Project + home config merge follows existing `mcp_servers` pattern:** Deep-merge per-provider entries with project-overrides-home semantics. No new merge pattern introduced.

---

## Dependencies / Assumptions

- `litellm.get_model_info` (or equivalent) accepts a provider-qualified model string and returns `max_input_tokens`, `max_output_tokens`, `supports_vision`, and `mode` (plus other fields not consumed in v1). If the installed litellm version's registry does not know a model, it returns nothing and the resolution falls through to the user override or empty fallback.
- The installed litellm version exposes a stable API for per-call `api_base` and `api_key` overriding so the call site can route each request to the correct provider and credentials.
- Existing config merge logic (the `mcp_servers` deep-merge in `ConfigManager.load`) generalizes cleanly to `providers` — both are dicts of named entries that need per-entry field merging.
- The model picker can be extended to render per-item badges and metadata fields without breaking its current search / filter contract.
- Agent definitions and tier model references that today use bare model names will be updated to `alias/model` as part of this work; the migration of any in-repo defaults is part of the work, not a separate task.

---

## Outstanding Questions

### Resolve Before Planning

- *(none)*

### Deferred to Planning

- Affects R4, R6. [Technical] Exact field names for the API key forms in config (e.g., `api_key` for literal vs. `api_key_env` for env-var reference, or a single `api_key` field with a sigil convention like `$OPENAI_KEY`) — pin down during planning once config dataclass shape is being designed.
- Affects R6. [Needs research] Confirm `litellm.get_model_info` is the right API (not `model_cost` dict or `get_supported_openai_params`) and verify the exact return shape — field names `max_input_tokens`, `max_output_tokens`, `supports_vision`, and `mode` and their types. Field names in config overrides must match litellm's verbatim per R5, so the exact source field names matter.
- Affects R10. [Technical] Whether the current `list_models` endpoint-discovery function in `src/stupidex/llm/models.py` is removed entirely or repurposed (e.g., as an optional "discover models for this provider and add them to config" flow). Out of scope per scope boundaries, but the function's disposition needs deciding.
- Affects R12. [Technical] How provider-level merge handles nested `models` dicts — does a project-level provider entry deep-merge its `models` into the home-level entry's `models`, or replace the whole `models` dict? Follows the same question that would apply to nested MCP server config if servers had sub-dicts.
