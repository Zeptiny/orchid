---
date: 2026-08-08
topic: provider-capabilities
---

# Provider Capabilities Rework

## Summary

Standardize the built-in provider system around code-owned capability facets — quota, custom currencies, dynamic pricing, prompt-cache breakpoint placement, thinking/reasoning handling, and service tiers — exposed as optional driver hooks with typed metadata. Pair it with user-facing configurability: per-model pricing overrides, live model discovery from provider APIs, a unified model listing, and a new OpenAI-Responses protocol.

---

## Problem Frame

The current driver interface (`electron/src/main/providers/drivers/`) expresses only protocol, auth, and model construction. Everything else a real provider differs on is either absent or ad-hoc. Neuralwatt and Lilac get untyped status blobs; quota and subscription data have no typed contract and no generic surface. Costs are computed from static catalog pricing only, so providers with live pricing (Lilac, Neuralwatt energy spot rates) or non-fiat billing units (kWh) produce wrong or unknown costs. Prompt caching is never shaped by Orchid despite Anthropic/OpenAI/OpenRouter exposing explicit breakpoints, so stable prefixes go uncached. Thinking content is replayed as plain text, which is wrong for Anthropic (signed blocks, mandatory in tool loops, redacted variants) and Meta (encrypted replay on Responses only, redacted on Chat Completions), and impossible for OpenAI reasoning models. Service tiers (OpenRouter `service_tier`, Neuralwatt `-flex`/`-fast`/`-short` variants) are unreachable. Model lists come only from the signed catalog; providers that publish `/v1/models` with fresh metadata and pricing cannot update connections.

The result: adding a provider is bespoke work, costs are unreliable, and multi-turn reasoning correctness silently degrades per provider.

---

## Key Decisions

- **Code-owned capabilities over declarative data.** Facets are optional hooks on trusted drivers. Remote catalog and user data may select among driver-declared options but never construct requests or introduce behavior — this preserves the existing trust posture.
- **Reported-first pricing ladder.** API-reported cost wins; then reported usage × rates; rate sources resolve provider pricing API → user-set → catalog. Provider numbers are authoritative; user rates fill gaps below the provider's own API.
- **Driver-owned breakpoint placement; user controls TTL.** Placement is provider semantics, not preference. TTL is a cost trade-off (e.g. Anthropic 5m at 1.25× vs 1h at 2× write), so it is user-selectable where the driver declares options.
- **Generic connections get implicit caching only.** User-provided endpoints rarely support explicit breakpoints, so Orchid sends no cache markers to them and only reports cache usage from responses.
- **Persist opaque thinking artifacts.** Signatures and encrypted content grow chain storage and tie history to the producing provider/model; accepted in exchange for correct multi-turn replay.
- **Tier variants grouped, no duplicate rows.** Model-name variants (Neuralwatt `-flex`/`-fast`/`-short`) render as tiers under one base model entry; the driver maps selection → model ID. The Neuralwatt `service_tier` parameter is ignored in favor of variant names.
- **Quota stays informational.** Quota never gates usability, routing, or sends — the existing separation between status and request paths is preserved.
- **Responses protocol in scope.** Meta's reasoning replay and summaries are unreachable through Chat Completions; a first-class `openai-responses` protocol is required.
- **Discovery on demand, not polling.** Models endpoints change slowly; pricing has its own refresh cadence, so discovery runs once at connection creation and on manual fetch.

---

## Requirements

**Driver capability interface**

- R1. Each facet (quota, currency, dynamic pricing, caching, thinking, tiers) is an optional hook on the trusted driver interface; a provider implements only the facets it supports.
- R2. Facet hooks are code-owned: catalog and user data select among declared options but never construct requests or introduce new behavior.
- R3. Adding a new built-in provider consists of one driver module against shared helpers plus a catalog entry, with no changes to the orchestration loop, accounting, or UI paths.
- R4. Every facet exposes typed metadata consumed generically by UI and accounting; known providers no longer surface untyped observation data.

**Pricing and currencies**

- R5. Cost resolution order is API-reported cost, then API-reported usage × rates, with rates resolved provider pricing API → user-set → catalog; every resolved rate carries provenance.
- R6. Users can set field-level rate overrides per model on any connection; overrides fill gaps below the provider pricing API and above the catalog.
- R7. Providers with dynamic pricing declare a refresh cadence; rates refresh in the background, each request freezes the latest-known rates at start, and an unreachable pricing endpoint falls back down the ladder with stale provenance marked.
- R8. Currencies generalize beyond ISO fiat: drivers may declare non-fiat units (e.g. kWh), usage/quota/analytics render native units without forced conversion, and attempt records retain native-unit evidence (consumed/charged amounts, multiplier).
- R9. Rate dimensions cover at least input, output, cache read, cache write (including TTL variants), reasoning, per-request fees, and context-length tiers.

**Caching facet**

- R10. For explicit-cache providers the driver owns breakpoint placement: one breakpoint at the end of the stable tools-plus-system prefix, one that advances with the conversation tail, and a stable session-scoped cache key where the provider supports routing keys.
- R11. User control over caching is limited to driver-declared options (e.g. TTL choice); placement itself is not configurable.
- R12. Generic connections (user-provided compatible endpoints) send no cache markers; their cache usage is only reported from responses.
- R13. Cache read/write usage is normalized into attempt accounting and rendered per attempt.
- R14. Prompt construction keeps the stable-prefix order (static system prompt and tools before volatile content); new dynamic context must land in the dynamic region, for main agents and subagents.

**Thinking facet**

- R15. Each driver/model declares a thinking policy: exposure (readable / summary / opaque / none), replay rule (mandatory-in-tool-loop / recommended / impossible), and request knobs (display mode, summary profile, encrypted-content opt-in).
- R16. Replay artifacts (signatures, encrypted content, reasoning text) persist with chain messages and are replayed per policy; replayable artifacts from a prior model are stripped when the provider or model changes.
- R17. The UI renders readable thinking text or provider summaries, and renders opaque thinking as an indicator with token count rather than text.
- R18. User-configurable thinking options are limited to driver-declared ones: existing per-model reasoning levels plus display/summary options where supported.

**Service tier facet**

- R19. Drivers declare their tier mechanism: request parameter (e.g. OpenRouter `service_tier`) or model-name variants (e.g. Neuralwatt); where variants exist, variant names are used and parameter forms are ignored.
- R20. Model-name variants render grouped under the base model entry with a tier selector; no duplicate model rows; the driver maps the selected tier to the model ID at request time.
- R21. Tier selection is per-model with session-level override, following the reasoning-effort selector pattern.
- R22. The actually-served tier reported by the provider is captured in attempt evidence, and billing uses the served tier's rates.
- R23. Tiers are opt-in: nothing is sent unless selected, and drivers assert provider preconditions (e.g. Neuralwatt flex requires streaming).

**Quota facet**

- R24. Quota and subscription state are a typed driver facet exposing balances, subscription state, and allowances in provider-native units.
- R25. Quota data is informational only — rendered in connection details and analytics — and never gates connection usability, routing, or sends.

**Discovery and unified listing**

- R26. Connections support live model discovery from the provider's models endpoint: automatically once at connection creation with a working credential, and on manual fetch in the wizard and connection edit; no background polling.
- R27. Model metadata precedence is live API > user-set > catalog; discovered models absent from the catalog are added as connection models with provider provenance; endpoints returning only ids contribute nothing beyond the id.
- R28. One unified listing per connection treats catalog, discovered, and user-defined custom models identically — enable/disable, pricing override, reasoning levels, tier selection — with a provenance badge distinguishing origin.
- R29. Custom models keep their manual metadata form (capabilities, limits, pricing) since nothing is known about them.

**Protocols**

- R30. `openai-responses` becomes a first-class protocol with its own driver path, message mapping, usage normalization, and reasoning handling.
- R31. Per-model protocol selection remains the mechanism for multi-API providers; drivers may declare the Responses protocol per model where the provider supports it.

---

## Key Flows

- F1. **Live model discovery**
  - **Trigger:** Connection created with a working credential, or user invokes fetch models.
  - **Actors:** User, driver, provider models endpoint.
  - **Steps:** Driver fetches the endpoint; entries are validated; metadata merges by precedence (live > user > catalog); unknown models are added with provider provenance; the unified listing updates.
  - **Covered by:** R26, R27, R28
- F2. **Request-time pricing freeze**
  - **Trigger:** A provider request starts.
  - **Actors:** Orchestrator, pricing facet, accounting.
  - **Steps:** The driver's latest rates are resolved down the ladder with provenance; a pricing snapshot freezes at request start; after the response, reported cost or reported usage wins in the attempt record.
  - **Covered by:** R5, R7, R8
- F3. **Thinking replay across a tool loop (Anthropic)**
  - **Trigger:** Tool results return after a thinking-enabled assistant turn.
  - **Actors:** Agent loop, thinking facet, provider.
  - **Steps:** Thinking blocks with signatures (including redacted blocks) were persisted with the assistant message; the next request replays them complete and unmodified alongside the tool results; the provider verifies via signatures.
  - **Covered by:** R15, R16
- F4. **Tier selection to billing**
  - **Trigger:** User sets a tier for a model, or a session overrides it.
  - **Actors:** User, driver, provider.
  - **Steps:** The driver maps the tier to a request parameter or variant model ID and asserts preconditions; the provider reports the served tier; evidence is recorded and the attempt bills at the served tier's rates.
  - **Covered by:** R19, R20, R21, R22, R23

---

## Acceptance Examples

- AE1. **Covers R5, R7.** Given a dynamic-pricing provider whose pricing endpoint is unreachable, when a request starts, then the user-set rate (else catalog rate) is frozen into the snapshot and the provenance marks the fallback source.
- AE2. **Covers R20.** Given a provider exposing `glm-5.2`, `glm-5.2-flex`, `glm-5.2-fast`, and `glm-5.2-short`, when the connection lists models, then one `glm-5.2` entry appears with a standard/flex/fast/short selector, and selecting flex sends the variant model id.
- AE3. **Covers R22, R23.** Given an OpenRouter connection with flex selected for a model, when the provider serves the request on a flex endpoint, then the attempt records the served tier and bills at flex rates; when no flex capacity exists, the provider's error surfaces instead of a silent standard-tier fallback.
- AE4. **Covers R16.** Given an Anthropic conversation with extended thinking, when a tool loop continues, then persisted thinking and redacted-thinking blocks are replayed unmodified with the tool results, and no path constructs altered or rebuilt blocks.
- AE5. **Covers R15, R30, R31.** Given a Meta reasoning model, when run over Chat Completions, then thinking exposure is none and each turn reasons from scratch; when run over the Responses protocol, then encrypted-content replay and summaries are available per the declared policy.
- AE6. **Covers R25.** Given a connection whose key allowance is blocked, when the user sends a message, then Orchid sends anyway, the provider rejection surfaces as an attempt error, and the quota panel shows the blocked state.
- AE7. **Covers R8.** Given an energy-accounting Neuralwatt connection, when attempts complete, then charged kWh and the pricing multiplier are retained as evidence, costs compute from the energy rate snapshot, and quota/analytics render kWh natively.
- AE8. **Covers R27.** Given a catalog context length that the live models endpoint contradicts, when discovery runs, then the live value replaces it with provider provenance shown.

---

## Success Criteria

- Adding a new built-in provider with all facets requires one driver module and one catalog entry, with zero edits to orchestration, accounting, or UI code.
- Every attempt cost carries provenance (reported vs each fallback rung); no unknown-cost records when any ladder rung has data.
- Anthropic tool-loop conversations produce no thinking-related 400 errors from Orchid's message construction.
- Neuralwatt and OpenRouter connections show zero duplicate model rows, and tier selection changes billed rates as provider docs describe.
- Cache reads appear in attempt accounting, and Anthropic/OpenAI explicit-cache connections show cache hits on the stable prefix across turns.
- Existing connections keep working without reconfiguration.

---

## Scope Boundaries

- OpenRouter provider-routing options (`provider.order`, `only`/`ignore`, `allow_fallbacks`) and data-collection policies.
- Behavioral quota: gating sends, auto tier downgrade, spend enforcement.
- OAuth or subscription-login auth flows; multi-key rotation; endpoint failover routing.
- Background or periodic refresh of model lists.
- Project-level provider/connection overrides.
- Sending explicit cache markers from generic connections.

---

## Dependencies / Assumptions

- The AI SDK provides usable paths for the Responses protocol, Anthropic `cache_control`/signature round-trips, and OpenAI prompt-cache parameters; verified during planning.
- The signed catalog pipeline can carry new facet fields (tier definitions, thinking policy, pricing dimensions).
- Chain storage can grow per-message replay payloads within existing persistence and hydration paths.
- Provider endpoints behave as documented when verified on 2026-08-08 (see Sources).
- Prompt assembly already places the static system prompt before conversation and dynamic content; R14 guards this order against future change.

---

## Outstanding Questions

### Resolve Before Planning

- *(none)*

### Deferred to Planning

- Affects R1, R4. [Technical] Exact hook signatures, facet metadata shapes, and the shared-helper boundaries drivers reuse.
- Affects R8, R9. [Technical] How cache-write TTL variants (e.g. `input_cache_write_1h`) and per-request fees map onto pricing schema dimensions.
- Affects R15, R18. [Technical] Driver defaults for display/summary options (e.g. Anthropic display mode, Meta summary profile) and their connection-level override UI.
- Affects R16. [Technical] Chain-storage format for replay payloads and their hydration/persistence behavior, including subagent chains.
- Affects R22. [Technical] Where served-tier evidence lands on the attempt record (existing evidence fields vs new columns).
- Affects R24. [Technical] Typed quota contract shape shared across Neuralwatt, Lilac, and future providers; Lilac's supply-state/discount fields come from an endpoint not covered by its public inference docs and need identification.
- Affects R26, R27. [Technical] Connection document migration for discovered-model entries and provenance tracking.
- Affects R30, R31. [Technical] Per-model protocol selection mechanics for drivers offering multiple protocols for the same model (OpenCode Go pattern vs Meta Responses).

---

## Sources / Research

Verified by direct fetch on 2026-08-08; used to ground the facets above.

- OpenAI prompt caching — automatic vs explicit breakpoints (GPT-5.6+), `prompt_cache_key`, 30m TTL, write pricing, `cached_tokens`/`cache_write_tokens` usage fields. https://developers.openai.com/api/docs/guides/prompt-caching
- OpenRouter prompt caching — per-provider mechanisms, marker translation, sticky routing, per-provider cache pricing multipliers. https://openrouter.ai/docs/guides/best-practices/prompt-caching.md
- OpenRouter service tiers — `flex`/`priority` via top-level `service_tier`, opt-in, billed at served tier, per-provider tier endpoints. https://openrouter.ai/docs/guides/features/service-tiers.md
- Anthropic prompt caching — explicit `cache_control` (max 4), automatic mode, tools→system→messages order, TTL pricing, 20-block lookback, minimums. https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- Anthropic extended thinking — multi-turn replay rules, signatures, redacted thinking, display modes, cache invalidation on config change, streaming. https://docs.claude.com/en/docs/build-with-claude/extended-thinking
- Meta prompt caching — fully automatic prefix caching, ordering-only control, `prompt_cache_key`, 24h retention hint. https://dev.meta.ai/docs/prompt-caching
- Meta reasoning — effort levels, redacted `reasoning_content` on Chat Completions, encrypted replay and summaries on Responses, token accounting. https://dev.meta.ai/docs/reasoning
- Neuralwatt API — models endpoint with inline pricing/limits/reasoning metadata, quota endpoint (balance, subscription, key allowances), energy usage, flex tier mechanics (variant names, streaming requirement, 0.65 multiplier). https://portal.neuralwatt.com/docs/api/models, /docs/api/quota, /docs/api/usage, /docs/guides/flex-tier
- OpenCode Go — subscription model, models endpoint (ids only), per-model protocol mapping (Anthropic Messages / OpenAI Responses / chat completions), dollar-cap billing, per-model pricing table. https://opencode.ai/docs/go/
- Lilac — public status endpoint (performance metrics only; supply-state/pricing fields not in public inference docs), OpenAI-compatible chat completions with standard usage. https://docs.getlilac.com/inference/status, /inference/chat-completions
