---
title: "feat: Add configurable reasoning effort per model, tier, and session"
type: feat
status: active
date: 2026-07-21
origin: docs/brainstorms/reasoning-effort-requirements.md
---

# feat: Add configurable reasoning effort per model, tier, and session

## Summary

Implement reasoning effort (thinking budget) configuration across Orchid's provider, config, agent, and UI layers. The effort value flows through a resolution cascade (session override → agent definition → tier config → connection model default → omit) and is translated to provider-native `providerOptions` at the driver layer before reaching `streamText`.

---

## Problem Frame

Reasoning-capable models run at provider defaults today because Orchid never sends `providerOptions`. Users cannot trade speed for depth, and all subagent tiers burn identical reasoning compute. (see origin: docs/brainstorms/reasoning-effort-requirements.md)

---

## Requirements

- R1. `capabilities.reasoning: boolean` gates reasoning UI and providerOptions
- R2. Connection model entries support a user-defined list of available reasoning levels
- R3. Connection model entries store a default active effort value (text or numeric)
- R4. Footer shows reasoning selector when active model has `reasoning: true`
- R5. Footer selector is a combo input: configured text levels + free-text (numeric = token budget, text = effort level)
- R6. Footer changes are session-only overrides, not persisted to connection default
- R7. Config gains `tier_reasoning_effort: Record<string, string | number | null>`
- R8. Agent definitions gain optional `reasoning_effort` field
- R9. Subagent cascade: agent field → tier config → connection default → omit
- R10. Driver layer translates effort to provider-native providerOptions
- R11. Drivers without reasoning support silently ignore effort
- R12. Main agent cascade: session override → connection default → omit
- R13. Models.dev catalog seeding pre-populates available levels for known models

**Origin actors:** A1 (User), A2 (Main agent), A3 (Subagent)
**Origin flows:** F1 (Configure levels), F2 (Adjust mid-session), F3 (Subagent resolution)
**Origin acceptance examples:** AE1 (R1,R4), AE2 (R5,R6), AE3 (R7,R9), AE4 (R8,R9), AE5 (R10,R11), AE6 (R13)

---

## Scope Boundaries

- No per-message effort override
- No orchestrator control over subagent effort via delegate tool
- No effort-aware cost estimation
- No onboarding wizard integration
- No automatic effort adjustment based on task complexity

---

## Context & Research

### Relevant Code and Patterns

- `electron/src/shared/types/provider.ts` — `ProviderConnection`, `ProviderModelDefinition` with `capabilities.reasoning`, `customModels`
- `electron/src/main/providers/resolver.ts` — resolves `ModelSelection` → `EffectiveModel` via connection + catalog
- `electron/src/main/providers/drivers/native.ts` — creates `LanguageModelV4` per provider (OpenAI, Anthropic, Google, xAI)
- `electron/src/main/llm/orchestrator.ts:553` — `streamText()` call site; currently no `providerOptions`
- `electron/src/main/config/schema.ts` — `configSchema` with `tier_models` pattern to mirror
- `electron/src/shared/types/agent.ts` — `Agent` interface (add `reasoning_effort?`)
- `electron/src/main/agents/subagent-runner.ts:109` — subagent selection resolution
- `electron/src/main/tools/subagent/delegate.ts` — delegate tool (no change needed per scope)
- `electron/src/shared/types/session.ts:38` — `Session` interface (add override field)
- `electron/src/main/ipc/chat.ts:1049` — main agent `resolveExecution` call site
- `electron/src/renderer/components/Footer.tsx` — footer UI (model name + usage)

### Institutional Learnings

- Provider connections store non-secret metadata in `~/.orchid/providers.json`; secrets stay in vault
- `ModelSelection` is `{connectionId, modelId}` — opaque, never parsed
- Config uses Zod schemas with `.strict()` — additive fields need `.optional()` or `.default()`
- Agent definitions are YAML/JSON with frontmatter parsed by `src/shared/utils/frontmatter.ts`

---

## Key Technical Decisions

- **Reasoning config on connection, keyed by modelId:** A new optional `reasoningConfig` field on `ProviderConnection` (`Record<modelId, ReasoningModelConfig>`). This applies to ALL models on a connection (catalog and custom), unlike `customModels` which only covers user-defined models. Keeps providers.json as the single source for connection-scoped model metadata.
- **Session override is persisted with the session:** The override survives page reloads within the same session (stored in session JSON) but never writes back to the connection. This matches how `session.selection` works — session-scoped, not global.
- **providerOptions passed at streamText call site:** The orchestrator's `streamText()` gets a new `providerOptions` param built by the driver layer. This keeps the orchestrator provider-agnostic — it receives an opaque `Record<string, Record<string, unknown>>` blob.
- **Driver owns mapping, not a central translator:** Each driver's `createLanguageModel` already knows its provider. A new `buildProviderOptions(effort, model)` method on the driver interface returns the provider-specific options blob. Drivers without reasoning return `undefined`.
- **Effort value type is `string | number`:** Text = effort level name, number = token budget. The driver interprets based on type. This avoids a discriminated union at the config/storage layer.

---

## Open Questions

### Resolved During Planning

- **Where to store reasoning config:** On `ProviderConnection.reasoningConfig` (not `customModels`, not config.json). Rationale: applies to all models including catalog-sourced ones; co-located with connection identity.
- **Should tier_reasoning_effort live alongside tier_models:** Yes, as a sibling field in `configSchema`. Same shape (`Record<string, T | null>`), same resolution pattern.
- **Generic driver reasoning support:** Generic OpenAI-compatible drivers pass through text effort as `reasoningEffort` in providerOptions (the OpenAI-compatible API shape). Numeric budgets are ignored by generic drivers (no standard mapping).

### Deferred to Implementation

- Exact models.dev catalog schema for reasoning levels (depends on catalog format evolution)
- Whether xAI/Grok models support reasoning effort (driver returns undefined until confirmed)
- Animation/transition details for footer selector appearance

---

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```
Resolution cascade (main agent):
  session.reasoningEffortOverride
    ?? connection.reasoningConfig[modelId]?.default
    ?? undefined (omit providerOptions)

Resolution cascade (subagent):
  agent.reasoning_effort
    ?? config.tier_reasoning_effort[tier]
    ?? connection.reasoningConfig[modelId]?.default
    ?? undefined

Driver mapping:
  driver.buildReasoningOptions(effort: string | number, model: EffectiveModel)
    → OpenAI:    { openai: { reasoningEffort: effort } }        (text only)
    → Anthropic: { anthropic: { thinking: { type: 'enabled', budgetTokens: N } } }  (numeric)
                 { anthropic: { reasoningEffort: effort } }      (text, if supported)
    → Google:    { google: { thinkingConfig: { thinkingBudget: N } } }  (numeric)
                 { google: { thinkingConfig: { thinkingLevel: effort } } }  (text, if supported)
    → Generic:   { openaiCompatible: { reasoningEffort: effort } }  (text only)
    → No support: undefined
```

---

## Implementation Units

- U1. **Shared types and Zod schemas**

**Goal:** Define the reasoning effort types and extend existing schemas (provider, config, agent, session) with reasoning fields.

**Requirements:** R1, R2, R3, R7, R8, R6

**Dependencies:** None

**Files:**
- Modify: `electron/src/shared/types/provider.ts`
- Modify: `electron/src/shared/types/session.ts`
- Modify: `electron/src/shared/types/agent.ts`
- Modify: `electron/src/main/config/schema.ts`
- Modify: `electron/src/shared/types/ipc-boundary.ts`
- Test: `electron/tests/unit/reasoning-effort-types.test.ts`

**Approach:**
- Add `ReasoningModelConfig` type: `{ levels: string[], default: string | number | null }`
- Add optional `reasoningConfig?: Record<string, ReasoningModelConfig>` to `providerConnectionSchema`
- Add `reasoningEffortOverride: string | number | null` to `Session` interface (default null)
- Add optional `reasoning_effort?: string | number` to `Agent` interface
- Add `tier_reasoning_effort: z.record(z.string(), z.union([z.string(), z.number()]).nullable()).default({seed: null, sprout: null, bloom: null, crown: null})` to `configSchema`
- Add `reasoning_effort` to `Config` interface in ipc-boundary.ts
- All new fields are optional/nullable with defaults — additive, non-breaking

**Patterns to follow:**
- `tier_models` shape in `configSchema` for `tier_reasoning_effort`
- `customModels` optional field pattern on `providerConnectionSchema`
- `Session.selection` nullable pattern for `reasoningEffortOverride`

**Test scenarios:**
- Happy path: `providerConnectionSchema` parses a connection with `reasoningConfig` containing levels and default
- Happy path: `configSchema` parses `tier_reasoning_effort` with mixed string/number/null values
- Edge case: connection without `reasoningConfig` field parses successfully (backward compat)
- Edge case: `tier_reasoning_effort` with unknown tier keys parses (record is open)
- Edge case: agent with `reasoning_effort: 8192` (numeric) and `reasoning_effort: "high"` (text) both valid
- Error path: `reasoningConfig` with empty `levels` array rejected (min 1)

**Verification:**
- `npm run typecheck` passes
- New unit tests pass
- Existing provider/config/session tests still pass (no schema breakage)

---

- U2. **Effort resolution logic**

**Goal:** Pure functions that resolve the effective reasoning effort for main agent and subagent turns.

**Requirements:** R9, R12

**Dependencies:** U1

**Files:**
- Create: `electron/src/main/llm/reasoning-effort.ts`
- Test: `electron/tests/unit/reasoning-effort-resolution.test.ts`

**Approach:**
- `resolveMainAgentEffort(session, connection, modelId): string | number | undefined`
  - session.reasoningEffortOverride → connection.reasoningConfig[modelId]?.default → undefined
- `resolveSubagentEffort(agent, config, connection, modelId): string | number | undefined`
  - agent.reasoning_effort → config.tier_reasoning_effort[agent.tier] → connection.reasoningConfig[modelId]?.default → undefined
- Both return `undefined` when no effort is configured (caller omits providerOptions)
- Guard: if model lacks `capabilities.reasoning`, return `undefined` regardless of config

**Patterns to follow:**
- `getTierModelSelection()` in `electron/src/main/config/loader.ts` — same cascade style
- Pure functions, no side effects, fully testable

**Test scenarios:**
- Happy path: main agent with session override returns override value
- Happy path: main agent without override falls back to connection default
- Happy path: subagent with agent definition field returns that value
- Happy path: subagent without agent field falls back to tier config
- Happy path: subagent without tier config falls back to connection default
- Edge case: model with `reasoning: false` returns undefined even when config has effort set
- Edge case: all levels empty/null → returns undefined
- Edge case: numeric effort (8192) passes through unchanged
- Covers AE3. Given tier_reasoning_effort.seed = "low" and seed agent with no field → returns "low"
- Covers AE4. Given tier_reasoning_effort.bloom = "medium" and bloom agent with field "high" → returns "high"

**Verification:**
- All resolution paths covered by unit tests
- `npm run typecheck` passes

---

- U3. **Driver-layer providerOptions mapping**

**Goal:** Each provider driver translates an effort value into provider-native `providerOptions` for `streamText`.

**Requirements:** R10, R11

**Dependencies:** U1

**Files:**
- Modify: `electron/src/main/providers/drivers/types.ts`
- Modify: `electron/src/main/providers/drivers/native.ts`
- Modify: `electron/src/main/providers/drivers/compatible.ts`
- Test: `electron/tests/unit/reasoning-effort-driver-mapping.test.ts`

**Approach:**
- Add optional method to `ProviderDriver` interface: `buildReasoningOptions?(effort: string | number, model: EffectiveModel): Record<string, Record<string, unknown>> | undefined`
- OpenAI driver: text effort → `{ openai: { reasoningEffort: effort } }`; numeric → `{ openai: { maxReasoningTokens: N } }` (or undefined if unsupported)
- Anthropic driver: numeric → `{ anthropic: { thinking: { type: 'enabled', budgetTokens: N } } }`; text → map to budget heuristic or `{ anthropic: { reasoningEffort: effort } }`
- Google driver: numeric → `{ google: { thinkingConfig: { thinkingBudget: N } } }`; text → `{ google: { thinkingConfig: { thinkingLevel: effort } } }`
- xAI driver: return undefined (no known reasoning support yet)
- Generic compatible driver: text → `{ openaiCompatible: { reasoningEffort: effort } }`; numeric → undefined
- Drivers without the method → caller treats as undefined (R11)

**Patterns to follow:**
- Existing `createLanguageModel` / `createEmbeddingTarget` optional method pattern on `ProviderDriver`
- `BUILTIN_PROVIDER_ORIGINS` switch structure in native.ts

**Test scenarios:**
- Happy path: OpenAI driver maps "high" → `{ openai: { reasoningEffort: 'high' } }`
- Happy path: Anthropic driver maps 8192 → `{ anthropic: { thinking: { type: 'enabled', budgetTokens: 8192 } } }`
- Happy path: Google driver maps 4096 → `{ google: { thinkingConfig: { thinkingBudget: 4096 } } }`
- Edge case: xAI driver returns undefined for any effort value
- Edge case: generic driver returns undefined for numeric effort
- Error path: driver without `buildReasoningOptions` method → caller gets undefined
- Covers AE5. OpenAI + "high" → correct providerOptions; unsupported provider → undefined

**Verification:**
- Each driver's mapping covered by unit tests
- `npm run typecheck` passes

---

- U4. **Orchestrator and chat IPC integration**

**Goal:** Wire resolved effort + driver mapping into the `streamText` call for both main agent and subagent turns.

**Requirements:** R10, R12, R9

**Dependencies:** U2, U3

**Files:**
- Modify: `electron/src/main/llm/orchestrator.ts`
- Modify: `electron/src/main/ipc/chat.ts`
- Modify: `electron/src/main/agents/subagent-runner.ts`
- Modify: `electron/src/main/providers/index.ts`
- Test: `electron/tests/unit/reasoning-effort-orchestrator.test.ts`

**Approach:**
- Add `providerOptions?: Record<string, Record<string, unknown>>` to `StreamChatParams`
- Pass `providerOptions` to `streamText()` call (AI SDK 7 supports this natively)
- In `chat.ts` main agent path: after `resolveExecution`, call `resolveMainAgentEffort()` then `driver.buildReasoningOptions()` → pass to `streamChat`
- In `subagent-runner.ts`: after resolving selection, call `resolveSubagentEffort()` then driver mapping → pass to `streamChat`
- `ProviderRuntime.resolveExecution` returns the driver reference (or a new `buildReasoningOptions` on `ResolvedProviderExecution`) so callers can map effort without re-resolving

**Patterns to follow:**
- Existing `accounting` optional param pattern on `StreamChatParams`
- How `modelInstance` flows from `resolveExecution` → `streamChat`

**Test scenarios:**
- Happy path: main agent with session override "high" → streamText receives providerOptions
- Happy path: main agent without override and no connection default → streamText receives no providerOptions
- Happy path: subagent with tier effort "low" → streamText receives mapped providerOptions
- Edge case: model without reasoning capability → no providerOptions regardless of config
- Integration: effort resolution + driver mapping + streamText param all wire together correctly
- Covers AE2. Session override "4096" (numeric) → providerOptions with token budget

**Verification:**
- `streamText` receives correct `providerOptions` in each scenario
- Existing orchestrator tests still pass
- `npm run typecheck` passes

---

- U5. **IPC surface and session override**

**Goal:** Expose reasoning configuration to the renderer and allow session-level effort override via IPC.

**Requirements:** R4, R5, R6

**Dependencies:** U1, U4

**Files:**
- Modify: `electron/src/shared/types/ipc.ts`
- Modify: `electron/src/main/ipc/session.ts`
- Modify: `electron/src/preload/index.ts`
- Modify: `electron/src/main/ipc/providers.ts`
- Test: `electron/tests/unit/reasoning-effort-ipc.test.ts`

**Approach:**
- Add IPC channel `session:set_reasoning_effort` — sets `reasoningEffortOverride` on the active session (runtime + persisted to session JSON)
- Add IPC channel `session:get_reasoning_config` — returns `{ levels, default, override, supportsReasoning }` for the active session's model
- Extend `providers:save_connection` to accept `reasoningConfig` updates
- Preload exposes `window.orchid.setReasoningEffort(value: string | number | null)` and `window.orchid.getReasoningConfig()`
- Add to `ALLOWED_INVOKE_CHANNELS`

**Patterns to follow:**
- `session:set_workspace` IPC pattern for session-scoped mutations
- `providers:save_connection` for connection metadata updates
- Existing preload `contextBridge` exposure pattern

**Test scenarios:**
- Happy path: `session:set_reasoning_effort` with "high" sets override on active session
- Happy path: `session:set_reasoning_effort` with null clears override
- Happy path: `session:get_reasoning_config` returns levels, default, current override, and supportsReasoning flag
- Edge case: model without reasoning → `supportsReasoning: false`, levels empty
- Edge case: setting override on session with no active model → no-op or error
- Error path: invalid channel payload rejected by Zod

**Verification:**
- IPC channels registered and allowlisted
- Preload API accessible from renderer
- Session override persists across page reload (session JSON)
- `npm run typecheck` passes

---

- U6. **Footer reasoning selector UI**

**Goal:** Render a reasoning effort combo-selector in the footer when the active model supports reasoning.

**Requirements:** R4, R5, R6

**Dependencies:** U5

**Files:**
- Modify: `electron/src/renderer/components/Footer.tsx`
- Create: `electron/src/renderer/components/ReasoningSelector.tsx`
- Modify: `electron/src/renderer/hooks/useChat.ts` (or new hook)
- Test: `electron/tests/unit/renderer-reasoning-selector.test.ts`

**Approach:**
- `ReasoningSelector` component: combo input (dropdown of configured levels + free-text input)
- Only rendered when `supportsReasoning` is true for the active session's model
- On change: call `window.orchid.setReasoningEffort(value)` — session-only override
- Display current effective value (override or default) with visual indicator when overridden
- Numeric input detected by `/^\d+$/` regex → treated as token budget
- Follows primitive-first rule: use `components/ui/` primitives, no raw component roots

**Patterns to follow:**
- Existing Footer layout (model name + token usage + elapsed time)
- `components/ui/` primitive patterns (Record<Union, string> class maps, forwardRef)
- Theme token usage (no raw colors)

**Test scenarios:**
- Happy path: model with reasoning → selector visible with configured levels
- Happy path: selecting "high" calls setReasoningEffort("high")
- Happy path: typing "8192" calls setReasoningEffort(8192)
- Edge case: model without reasoning → selector not rendered
- Edge case: clearing input resets to null (falls back to default)
- Covers AE1. Model with reasoning: false → no selector in footer
- Covers AE2. Typing "4096" sets session override; new session starts at stored default

**Verification:**
- Selector appears/disappears based on model capability
- Session override changes take effect on next message send
- Visual smoke across all 5 themes
- `npm run typecheck` and `npm run lint` pass

---

- U7. **Connection config UI for reasoning levels**

**Goal:** Allow users to configure available reasoning levels and default effort per model in the connection/model settings panel.

**Requirements:** R2, R3

**Dependencies:** U5

**Files:**
- Modify: `electron/src/renderer/components/Preferences/` (relevant provider/connection panel)
- Test: `electron/tests/unit/renderer-reasoning-config.test.ts`

**Approach:**
- In the connection model settings, when `capabilities.reasoning: true`, show a reasoning config section
- UI: list of text levels (add/remove), default selector (dropdown of levels + numeric input)
- Save writes `reasoningConfig[modelId]` to the connection via `providers:save_connection`
- Models without reasoning capability show no reasoning section

**Patterns to follow:**
- Existing connection model editing UI in Preferences
- Primitive-first styling rules

**Test scenarios:**
- Happy path: adding levels ["low", "medium", "high"] and setting default "medium" persists to connection
- Happy path: removing a level updates the stored config
- Edge case: model without reasoning → no reasoning config section shown
- Edge case: setting numeric default (8192) persists correctly
- Error path: empty levels list → validation error, cannot save

**Verification:**
- Reasoning config persists to providers.json
- Footer selector reflects configured levels after save
- `npm run typecheck` and `npm run lint` pass

---

- U8. **Catalog seeding of reasoning levels**

**Goal:** When models are seeded from models.dev, pre-populate `reasoningConfig` for known reasoning-capable models.

**Requirements:** R13

**Dependencies:** U1

**Files:**
- Modify: `electron/src/main/providers/catalog/schema.ts` (or seeding logic)
- Modify: `electron/src/main/providers/connection-store.ts`
- Test: `electron/tests/unit/reasoning-effort-catalog-seeding.test.ts`

**Approach:**
- Extend the catalog model schema to include optional `reasoningLevels: string[]` and `reasoningDefault: string | number`
- When a connection is created or models are synced from catalog, populate `reasoningConfig[modelId]` from catalog data if the model has `capabilities.reasoning: true`
- User edits to `reasoningConfig` take precedence — seeding only fills empty/absent entries
- Known seed data: o1/o3/o4-mini → ["low", "medium", "high"], default "medium"; Claude thinking models → ["low", "medium", "high"] + numeric budget, default "medium"; Gemini 2.5 → ["low", "medium", "high"] + numeric budget

**Patterns to follow:**
- Existing catalog → connection model sync logic
- `catalogToProviderDefinitions()` in catalog/schema.ts

**Test scenarios:**
- Happy path: seeding o3 model populates reasoningConfig with [low, medium, high] and default medium
- Happy path: user-modified reasoningConfig is not overwritten by re-seed
- Edge case: model without reasoning capability → no reasoningConfig seeded
- Edge case: catalog model without reasoningLevels field → no seeding (graceful)
- Covers AE6. Fresh connection with o3 → levels pre-populated; user can later modify

**Verification:**
- New connections with reasoning models get pre-populated config
- Existing user config is preserved on re-sync
- `npm run typecheck` passes

---

## System-Wide Impact

- **Interaction graph:** `streamText` providerOptions → AI SDK → provider adapter → API request. Middleware stack (retry, throttle) wraps the model before providerOptions are applied — no interaction conflict.
- **Error propagation:** Invalid effort values (e.g., text level not supported by provider) should be silently ignored by the driver (R11), not throw. Provider API errors from unsupported options surface through existing stream error classification.
- **State lifecycle risks:** Session override must not leak into connection config. Connection `reasoningConfig` writes must be atomic with the rest of the connection save (no partial writes).
- **API surface parity:** Preload API (`window.orchid`) gains new methods. IPC allowlists must be updated. No renderer-accessible secrets.
- **Integration coverage:** End-to-end: user sets effort in footer → session override stored → next streamChat call includes providerOptions → provider receives reasoning config. Subagent: tier config → subagent-runner → streamChat with providerOptions.
- **Unchanged invariants:** `ModelSelection` shape unchanged (`{connectionId, modelId}`). Delegate tool interface unchanged (no reasoning param). `tier_models` resolution unchanged. Existing connections without `reasoningConfig` parse identically.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| AI SDK provider adapters may not support all effort mappings | Driver returns undefined for unsupported combinations; silent degradation (R11) |
| Provider APIs reject unknown providerOptions keys | Only send options for models with `reasoning: true`; driver validates before sending |
| Catalog seeding overwrites user config | Seed only fills absent entries; never overwrite existing reasoningConfig |
| Session override stale after model change | Clear override when session model changes (existing `session:change_model` handler) |

---

## Sources & References

- **Origin document:** [docs/brainstorms/reasoning-effort-requirements.md](docs/brainstorms/reasoning-effort-requirements.md)
- Related code: `electron/src/main/llm/orchestrator.ts` (streamText call), `electron/src/main/providers/drivers/` (driver layer)
- AI SDK 7 `providerOptions`: passed to `streamText()`, forwarded to provider adapter
