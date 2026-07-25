---
date: 2026-07-21
topic: reasoning-effort
---

# Reasoning Effort Configuration

## Summary

Add configurable reasoning effort (thinking budget) to Orchid. Users define available effort levels per model per connection, select an active level via a footer control, and configure per-tier defaults for subagents. The effort input is unified: text values (e.g. `low`, `high`, `max`) map to provider reasoning effort enums; numeric values (e.g. `8192`) map to token budgets.

---

## Problem Frame

Models with reasoning capabilities (OpenAI o-series, Anthropic extended thinking, Google thinking) let callers control how much compute the model spends on internal reasoning. Today Orchid sends no `providerOptions` to `streamText`, so every reasoning-capable model runs at its provider default — users cannot trade speed for depth or vice versa.

Subagents compound the problem: a seed-tier agent doing a simple glob search shouldn't burn the same reasoning budget as a crown-tier agent debugging a race condition, but today they get identical settings because effort isn't configurable at any level.

---

## Actors

- A1. User: configures available levels, sets defaults, adjusts effort mid-session
- A2. Main agent: runs turns with the session's active effort level
- A3. Subagent: runs with tier/agent-definition effort, independent of the parent turn's session override

---

## Key Flows

- F1. Configure available levels for a model
  - **Trigger:** User opens connection/model settings for a model with `capabilities.reasoning: true`
  - **Actors:** A1
  - **Steps:** User adds/removes text levels (e.g. `none`, `low`, `medium`, `high`, `max`) and optionally sets a default active level. Saved to the connection model entry.
  - **Outcome:** The model's connection entry stores the available levels and default.
  - **Covered by:** R1, R2, R3

- F2. Adjust effort mid-session
  - **Trigger:** User interacts with the footer reasoning selector during a chat
  - **Actors:** A1, A2
  - **Steps:** User picks a level from the configured list or types a numeric token budget. The session override is set. Next `streamText` call includes the mapped `providerOptions`.
  - **Outcome:** The current session uses the new effort. The stored default on the connection model is unchanged.
  - **Covered by:** R4, R5, R6

- F3. Subagent effort resolution
  - **Trigger:** A subagent turn begins (via delegate tool)
  - **Actors:** A3
  - **Steps:** Resolve effort: agent definition `reasoning_effort` field → `tier_reasoning_effort[tier]` from config → connection model default for the resolved model → omit providerOptions.
  - **Outcome:** The subagent streams with the resolved effort, independent of the parent session's override.
  - **Covered by:** R7, R8, R9

---

## Requirements

**Model capability and level configuration**

- R1. The `capabilities.reasoning: boolean` flag on a model definition gates whether reasoning effort UI and configuration appear. Models without `reasoning: true` show no effort selector and send no reasoning providerOptions.
- R2. Each connection model entry supports a list of available reasoning levels (text strings like `none`, `low`, `medium`, `high`, `max`). The list is free-form — no fixed vocabulary.
- R3. Each connection model entry stores a default active effort value. The default can be a text level from the configured list or a numeric token budget.
- R13. When models are seeded from models.dev (catalog), known reasoning-capable models come pre-populated with their available levels and a sensible default. Users can edit or override the seeded values. Models without catalog seeding start with an empty level list that the user populates manually.

**Session-level effort control**

- R4. The footer displays a reasoning effort selector next to the model name when the active model has `reasoning: true`. When the model lacks reasoning capability, no selector is shown.
- R5. The footer selector is a combo input: it presents the configured text levels as options and accepts free-text input. If the input is numeric, it is treated as a token budget. If text, it is treated as a reasoning effort level.
- R6. Changing effort in the footer sets a session-only override. It does not persist to the connection model's stored default. New sessions start at the stored default.

**Tier and agent-level defaults**

- R7. Config gains a `tier_reasoning_effort` field: `Record<string, string | number | null>` mirroring the `tier_models` shape. Each tier (seed, sprout, bloom, crown) can have a default effort. Null means "use the connection model default."
- R8. Agent definition files (YAML/JSON) gain an optional `reasoning_effort` field (string or number). When present, it overrides the tier default for that specific agent.
- R9. Subagent effort resolution cascade: agent definition field → `tier_reasoning_effort[tier]` → connection model default → omit providerOptions (provider default). The parent session's override does not propagate to subagents.

**Provider mapping**

- R10. The driver layer translates Orchid's effort value into the provider-native format. Text levels map to provider reasoning effort enums (e.g. OpenAI `reasoningEffort`, Anthropic thinking mode). Numeric values map to token budgets (e.g. Anthropic `budgetTokens`, Google `thinkingBudget`).
- R11. Drivers that do not support reasoning effort silently ignore the value — no error, no providerOptions sent.
- R12. The main agent's turn resolves effort as: session override → connection model default → omit providerOptions.

---

## Acceptance Examples

- AE1. **Covers R1, R4.** Given a model with `reasoning: false`, when the user opens a session with that model, the footer shows no reasoning effort selector.
- AE2. **Covers R5, R6.** Given a model with levels `[low, medium, high]` and default `medium`, when the user types `4096` in the footer selector, the session override becomes a 4096-token budget. Opening a new session with the same model starts at `medium`.
- AE3. **Covers R7, R9.** Given `tier_reasoning_effort: { seed: "low" }` and a seed-tier agent with no `reasoning_effort` field, when that agent is delegated a task, it streams with effort `low`.
- AE4. **Covers R8, R9.** Given `tier_reasoning_effort: { bloom: "medium" }` and a bloom-tier agent with `reasoning_effort: "high"` in its definition, when that agent runs, it streams with effort `high`.
- AE5. **Covers R10, R11.** Given effort `high` and an OpenAI connection, the driver sends `providerOptions: { openai: { reasoningEffort: 'high' } }`. Given the same effort and a provider without reasoning support, no providerOptions are sent.
- AE6. **Covers R13.** Given a fresh connection with model `o3` seeded from models.dev, the model's available levels are pre-populated as `[low, medium, high]` with default `medium`. The user can later change the list to `[none, low, medium, high, max]` and set default to `high`.

---

## Success Criteria

- Users can control how much reasoning compute each model uses, per session, without leaving the chat.
- Subagent tiers get appropriate effort levels by default — seed agents don't over-think, crown agents get depth.
- The system degrades gracefully: models without reasoning capability are unaffected; drivers without reasoning support ignore the setting silently.
- Planning can proceed without inventing resolution order, storage location, or UI behavior.

---

## Scope Boundaries

- No per-message effort override (one-off for a single send)
- No automatic effort adjustment based on task complexity via catalog heuristics
- No reasoning effort in the onboarding wizard
- No effort-aware cost estimation in the footer
- No orchestrator (main agent) control over subagent effort via delegate tool params

---

## Key Decisions

- **Unified input (text + numeric):** A single input handles both enum-style levels and token budgets. Simpler mental model than two separate controls.
- **Catalog seeds, user owns:** Models.dev pre-populates available levels for known models (removes cold-start), but users have final say. The catalog is a starting point, not a constraint.
- **Session-only footer override:** Changing effort mid-chat doesn't mutate stored config. Prevents accidental permanent changes during flow.
- **No orchestrator override:** Effort is a user concern, not an agent concern. The orchestrator controls *what* a subagent does (task, tier), not *how hard it thinks*.
- **Driver-layer mapping:** Each driver owns translation to provider-native format. Keeps the orchestrator and config provider-agnostic.

---

## Dependencies / Assumptions

- AI SDK 7's `streamText` accepts `providerOptions` and passes them through to the provider adapter. Verified: the SDK supports this.
- `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google` accept reasoning-related provider options. Verified: these packages support `reasoningEffort`, `thinking.budgetTokens`, and `thinkingConfig.thinkingBudget` respectively.
- The connection model entry in providers.json can be extended with reasoning fields without breaking existing connection documents (additive schema change).

---

## Outstanding Questions

### Deferred to Planning

- [Affects R2][Technical] Should available levels be stored on the existing `customModels` array entries or a new parallel structure on the connection? Both are in providers.json.
- [Affects R5][Technical] Exact UX for the combo input — dropdown with free-text, or a text input with datalist suggestions?
- [Affects R10][Needs research] Do OpenAI-compatible generic endpoints (e.g. local servers) support reasoning effort passthrough, or should generic drivers always ignore it?
- [Affects R7][Technical] Should `tier_reasoning_effort` live in config.json alongside `tier_models`, or as a sibling field in the same schema object?
