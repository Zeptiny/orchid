---
title: "fix: Filter skill tool listing by agent's allowed_skills"
type: fix
status: active
date: 2026-06-21
---

# Fix: Filter skill tool listing by agent's allowed_skills

## Summary

The `skill` tool's static schema advertises the full global skill registry in its `name` parameter description regardless of which agent is calling. Only the executor enforces `allowed_skills`, so restricted agents (or future ones) see skills they cannot load — wasting tokens and misleading the model into attempts that fail at runtime. This plan rebuilds the `skill` tool's description per agent inside `stream_response` so only `allowed_skills`-matching skills are advertised in the tool schema sent to the LLM.

---

## Problem Frame

When `stream_response` builds `filtered_tools` in `src/stupidex/llm/client.py:757-769`, it pulls each `Tool` object from the process-wide `_TOOL_REGISTRY` cache (`src/stupidex/tools/__init__.py:62-69`). The `skill` entry was registered once via `build_skill_tool()` with no arguments (`tools/__init__.py:88`), so its `name` parameter description contains the `Available skills:` listing computed from the full registry at that moment (`tools/skill.py:96-99,115`).

`stream_response` already accepts `allowed_skills` and stashes it in a `ContextVar` (`llm/client.py:745-748`) so `execute_skill` and `execute_list_skills` can filter at execution time (`tools/skill.py:127-133, 256-260`). But the **tool schema** that the LLM sees in the `tools` array of each request (`client.py:769`) is built from the unfiltered global `Tool` object, so the description still enumerates every skill in the registry.

## Requirements

- R1. The `skill` tool's `name` parameter description sent to the LLM must only advertise skills matching the calling agent's `allowed_skills` patterns.
- R2. Behavior for agents with `allowed_skills: ['*']` (e.g. `general`) must be unchanged — the full listing is still advertised.
- R3. Behavior for agents with `allowed_skills: []` (empty list) must advertise zero skills in the tool description while keeping the `skill` tool available if it is in `allowed_tools`.
- R4. Runtime filtering in `execute_skill` / `execute_list_skills` / `_execute_resource_read` is unaffected and remains the authoritative enforcement layer (defense-in-depth).
- R5. The global `_TOOL_REGISTRY` cache stays shared; only the snapshot sent to the LLM is per-agent. No regression in tool caching semantics.
- R6. No new tool registration callsite; the fix lives where `allowed_skills` is already in scope (`stream_response`).

---

## Scope Boundaries

- The `list_skills` tool's description does NOT embed a skill listing (it is filtered at runtime by `execute_list_skills`), so its static schema needs no change.
- The `general` agent's system prompt currently instructs the model to read the listing from the tool — that contract is preserved (the listing still lives in the `skill` tool's `name` description, just filtered).
- No change to skill *execution* semantics, dependency resolution, or resource-read path-traversal guards.
- Migration of the skill listing into the system prompt (opencode's pattern) is explicitly out of scope — that is a larger architectural change.

### Deferred to Follow-Up Work

- Audit whether `list_skills` should embed a filtered summary in its own description for discoverability (separate PR).
- Consider moving the skill catalog from the tool's parameter description into `build_dynamic_system_prompt` so it can be refreshed mid-session without rebuilding the tool schema (architectural; needs its own plan).

---

## Context & Research

### Relevant Code and Patterns

- `src/stupidex/tools/skill.py:93-122` — `build_skill_tool(allowed_skills)` already accepts an optional filter and produces a `Tool` with a filtered `Available skills:` block. The fix reuses this; no new function needed.
- `src/stupidex/tools/skill.py:20-28` — `filter_skills(allowed, registry)` performs fnmatch glob filtering; reused by both the builder and the executors.
- `src/stupidex/llm/client.py:740-769` — `stream_response` is the single place the tool schema is assembled per call; the only call site that has `allowed_skills` in scope. Already imports `set_current_allowed_skills` from `tools.skill`.
- `src/stupidex/tools/__init__.py:65-97` — `get_tool_registry()` returns the cached global dict; `reset_tool_registry()` exists for cache invalidation after agent/skill changes.
- `src/stupidex/domain/agent.py:65-96` — `Agent.allowed_skills` is `list[str]` glob patterns, threaded through `app.py:323` and `agents/manager.py:321` into `stream_response`.
- `src/stupidex/agents/defaults/general/AGENT.md:34-35` — `general` has `allowed_skills: ['*']`; the only shipped agent that lists `skill` in `allowed_tools`. All reviewer/implementer agents either have `allowed_skills: []` or do not expose the `skill` tool — the bug is latent but real for any future agent configured with both.

### Institutional Learnings

- None found in `docs/solutions/` directly addressing tool-schema filtering. The closest pattern is the per-agent `allowed_tools` glob filtering already applied at `client.py:759`, which this fix mirrors for the skill listing.

### External References

- None needed — pure internal architecture fix.

---

## Key Technical Decisions

- **Rebuild the `skill` Tool snapshot inside `stream_response`, not in the registry.** The global registry stays cached and shared; only the per-call `filtered_tools` dict gets its `skill` entry swapped for a filtered `Tool` built via the existing `build_skill_tool(allowed_skills)`. Rationale: `build_skill_tool` already does the right thing, and `stream_response` is the only place that has both the agent's `allowed_skills` and the moment where `tools_list` is serialized to dicts.
- **Only override when `skill` is in `filtered_tools` AND `allowed_skills` is not `None`.** Passing `allowed_skills=None` to `build_skill_tool` falls back to the full registry, matching the legacy behavior — so the override is a no-op for callers that don't set the filter. This keeps the `general` (full-access) path byte-identical to today.
- **Do NOT remove the runtime ContextVar filter.** The executor-side `filter_skills` call in `execute_skill` / `execute_list_skills` / `_execute_resource_read` stays as authoritative enforcement. The schema-level fix is advisory (saves tokens, avoids misleading the model); the executor fix is what actually blocks unauthorized loads. Two layers, no conflict.
- **Override the dict entry, not the `Tool` object.** `filtered_tools["skill"]` is a `{"tool": Tool, "executor": ...}` dict; we replace only the `"tool"` value, leaving the executor wiring untouched.

---

## Open Questions

### Resolved During Planning

- **Should `list_skills` also get a per-agent description rebuild?** No — its description has no skill listing; runtime filtering already handles it.
- **Should agents with `allowed_skills: []` lose the `skill` tool entirely?** No — that's an `allowed_tools` concern, orthogonal to this fix. Some future agent may want the tool available (e.g. for resource reads) without advertising loadable skills.

### Deferred to Implementation

- Whether to also pass the resolved filter down through `wait_for_subagent` / nested delegation chains. The fix lives in `stream_response`, which both `app.py` and `agents/manager.py` already route through with `allowed_skills`, so it should "just work" — implementer should verify with a subagent integration test.

---

## Implementation Units

- U1. **Rebuild the `skill` Tool entry per agent inside `stream_response`**

**Goal:** When assembling `filtered_tools` in `stream_response`, replace the global `skill` Tool with one built from the current `allowed_skills` so the LLM only sees advertised skills the calling agent can actually load.

**Requirements:** R1, R2, R3, R5, R6

**Dependencies:** None

**Files:**
- Modify: `src/stupidex/llm/client.py`
- Test: `tests/test_streaming_messages.py` (or a new `tests/test_skill_tool_filtering.py` — see Approach)

**Approach:**
- Inside `stream_response`, after `filtered_tools` is built (`client.py:759-767`) and before `tools_list = [entry["tool"].to_dict() ...]` (`client.py:769`), if `"skill"` is in `filtered_tools` and `allowed_skills is not None`, replace the `"tool"` slot with `build_skill_tool(allowed_skills)`.
- Import `build_skill_tool` lazily alongside the existing `from stupidex.tools.skill import set_current_allowed_skills` import (`client.py:747`) to avoid module-load cycles.
- Do not touch the executor slot; do not touch `list_skills`.
- The new `Tool` object is rebuilt per `stream_response` call. This is cheap — `build_skill_tool` does one dict comprehension over the skill registry, which is small and already loaded.

**Patterns to follow:**
- The existing `from fnmatch import fnmatch` + glob-filter pattern at `client.py:758-760` for `allowed_tools` — this is the symmetric move for skills.
- The existing `build_skill_tool(allowed_skills=None)` signature already supports both filtered and unfiltered paths (`tools/skill.py:93-99`).

**Test scenarios:**
- **Happy path (full access):** `allowed_skills=['*']` → `build_skill_tool` description contains every skill name in the registry; matches the legacy global listing byte-for-byte. Covers R2.
- **Happy path (restricted):** `allowed_skills=['work', 'plan']` with a registry of `{work, plan, debug, commit}` → the `skill` tool's serialized `name` parameter description mentions `work` and `plan` but not `debug` or `commit`. Covers R1.
- **Edge case (empty list):** `allowed_skills=[]` → `build_skill_tool` description has an empty `Available skills:` block (or whatever `filter_skills([], registry)` produces today — empty dict). The `skill` tool is still present in `filtered_tools` if it is in `allowed_tools`. Covers R3.
- **Edge case (None — legacy default):** `allowed_skills=None` → the override is skipped, the global cached `Tool` is used unchanged. Behavior identical to pre-fix. Covers R5.
- **Edge case (glob pattern):** `allowed_skills=['*-reviewer']` with registry `{correctness-reviewer, security-reviewer, work}` → matched ones listed, `work` excluded. Covers R1 with glob.
- **Integration (subagent path):** Spawning a subagent whose `Agent.allowed_skills` is restricted via `delegate_to_subagent` → the subagent's `stream_response` invocation sees the filtered listing in its own tool schema. This validates that the fix rides the existing `allowed_skills` plumbing through `agents/manager.py:321` without additional changes. Covers R6.
- **Regression (runtime enforcement still active):** Even when the schema advertises a skill, calling `execute_skill` for a skill not in `allowed_skills` must still return `"not available for this agent"`. Locks in defense-in-depth (R4).

**Verification:**
- Run `pytest tests/test_skill_tools.py` — existing skill-tool tests still pass unchanged.
- Add a focused test that calls `stream_response` (or a small extracted helper) with a stubbed registry and asserts the serialized `tools_list` advertises only the filtered subset.
- Run the existing test suite `pytest` to confirm no regression in `tests/test_streaming_messages.py` or `tests/test_dynamic_system_prompt.py` (the fix touches the tool-schema path, not the system prompt).

---

- U2. **Test coverage for per-agent skill schema filtering**

**Goal:** Add a unit/integration test that locks in the new behavior and prevents regression. The existing `tests/test_skill_tools.py` covers `execute_skill` / `execute_list_skills` / dependency resolution / resource reads, but nothing currently inspects the **schema-level** listing that `build_skill_tool` bakes into the `Tool` description.

**Requirements:** R1, R2, R3

**Dependencies:** U1

**Files:**
- Create: `tests/test_skill_tool_filtering.py`
- Reference: `tests/test_skill_tools.py` (for the `_patch_registry` / `_build_skill` fixture pattern)

**Approach:**
- Build a small fake registry (`_registry(_skill('work'), _skill('plan'), _skill('debug'))`) and monkeypatch `stupidex.tools.skill.get_skill_registry` the same way `tests/test_skill_tools.py` does.
- Call `build_skill_tool(['work', 'plan'])` directly and assert the returned `Tool`'s `parameters.properties['name'].description` lists `work` and `plan` but not `debug`. This pins the contract that `build_skill_tool` already honors the filter (today) and protects against future regressions.
- Then add a higher-level test that exercises `stream_response`'s override: mock the LLM call so that the captured `tools` array passed to litellm contains a `skill` function whose `parameters.properties.name.description` matches the filtered set. The cleanest seam is to extract the tool-list assembly into a small helper (e.g. `_build_tools_for_request(allowed_tools, allowed_skills)`) that `stream_response` calls and the test calls directly, avoiding the need to mock the network.

**Execution note:** If extraction of `_build_tools_for_request` is trivial during U1, do it then. Otherwise land it as part of U2 to keep the test honest.

**Patterns to follow:**
- Fixture style from `tests/test_skill_tools.py:113-115` (`_patch_registry` via `monkeypatch.setattr`).
- Assertion style from `tests/test_skill_tools.py:230-236` (string membership on the serialized description).
- Async-test pattern using `asyncio.run` (or `pytest-asyncio` if the project standardizes on it — `pyproject.toml` lists `pytest-asyncio` in dev deps) matches the existing suite.

**Test scenarios:**
- **Happy path:** `build_skill_tool(['work', 'plan'])` → description contains both `work` and `plan`, excludes `debug`. Covers R1.
- **Regression (full access):** `build_skill_tool(['*'])` → description matches the unfiltered `build_skill_tool(None)` description (sanity check that the `*` glob path and the None path agree). Covers R2.
- **Edge case (empty):** `build_skill_tool([])` → `filter_skills([], registry)` returns `{}` (per `tools/skill.py:22-23` `if not allowed: return {}`), so the `Available skills:` block is empty / the description still has its leading prose. Verify the resulting `Tool` is still serializable to a valid dict via `to_dict()`. Covers R3.
- **Integration (filter plumbing through stream_response):** with a stubbed registry and `allowed_skills=['work']`, the serialized `tools_list` from `stream_response` (or the extracted helper) advertises only `work` in the `skill` tool's `name` description, while the `list_skills` tool's description is unchanged (it has no skill listing). Covers R1 + R6.

**Verification:**
- `pytest tests/test_skill_tool_filtering.py` is green.
- `pytest` (full suite) remains green.

---

## System-Wide Impact

- **Interaction graph:** Touches only the `tools_list` construction path inside `stream_response`. No new entry points, no new callbacks. Both `app.py:_stream_response` and `agents/manager.py:spawn` already route through `stream_response` with `allowed_skills`, so both paths get the fix for free.
- **Error propagation:** `build_skill_tool` is pure (no I/O, no exceptions beyond `get_skill_registry` failing, which is already exercised by the existing global registration). Adding the override cannot introduce a new failure mode unless the skill registry is uninitialized at call time — but the global `skill` tool is already built from the same registry at startup, so if registry init were broken, the system would already be broken.
- **State lifecycle risks:** The per-call `Tool` object is short-lived (built fresh each `stream_response` invocation, serialized to a dict, then discarded). No caching, no shared mutation. The global `_TOOL_REGISTRY` is never reassigned here.
- **API surface parity:** No public API change. The `Tool` dataclass, `build_skill_tool` signature, and `stream_response` signature are all unchanged.
- **Integration coverage:** U2's "filter plumbing through `stream_response`" test is the cross-layer scenario — it proves the plumbing from `Agent.allowed_skills` → `stream_response` → serialized `tools_list` → LLM-facing schema is intact end-to-end at the schema level (not just the executor level, which was already covered).
- **Unchanged invariants:**
  - `list_skills` runtime filtering (`tools/skill.py:256-260`) — unchanged.
  - `execute_skill` runtime filtering (`tools/skill.py:127-145`) — unchanged.
  - `_execute_resource_read` access control (`tools/skill.py:176-216`) — unchanged.
  - Skill dependency resolution (`tools/skill.py:31-69`) — unchanged.
  - The global `_TOOL_REGISTRY` cache and `reset_tool_registry()` semantics — unchanged.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Per-call `Tool` rebuild adds latency on every `stream_response` turn (the LLM is called in a tight loop across many turns). | `build_skill_tool` does a single dict-comprehension over a small registry (~tens of skills). Cost is microseconds compared to a network LLM round-trip. Negligible. If profiling later shows it matters, cache by `tuple(allowed_skills)` — but only if measured. |
| A future caller of `stream_response` forgets to pass `allowed_skills`, silently re-introducing the unfiltered listing. | The default `allowed_skills=None` preserves legacy behavior intentionally (the `general` agent's full-access path). Document this in the `stream_response` docstring as part of U1. Add a test (U2) that pins the `None` → full-listing contract so a future change to the default is caught. |
| The override silently breaks if someone renames the `skill` tool or adds a new skill-loading tool. | Pin via a unit test that asserts the `skill` entry in `filtered_tools` after the override has a description containing only the filtered subset. U2 covers this. |
| Skill registry might be mutated after `_TOOL_REGISTRY` is built but before `stream_response` runs (e.g. skills hot-loaded mid-session). | `get_skill_registry()` is called fresh inside `build_skill_tool` on every rebuild, so the per-call snapshot is always current. The global cached `Tool` would be stale, but we are no longer using it for the schema. This is actually a latent improvement. |

---

## Documentation / Operational Notes

- Add a one-line comment in `stream_response` (next to the override) explaining that the `skill` tool's description is rebuilt per-agent so the LLM only sees `allowed_skills`-matching skills. (Comments are allowed here because this explains a non-obvious invariant per the project's "no comments unless asked" rule — the implementer should judge whether the code is self-explanatory; if `build_skill_tool(allowed_skills)` reads obviously, skip the comment.)
- No user-facing docs change (this is an internal correctness fix).
- No config or migration impact.

---

## Sources & References

- Related code: `src/stupidex/tools/skill.py:93-122` (`build_skill_tool`), `src/stupidex/llm/client.py:740-769` (`stream_response` tool-schema assembly), `src/stupidex/tools/__init__.py:62-97` (global registry cache), `src/stupidex/domain/agent.py:65-96` (`Agent.allowed_skills`)
- Existing tests: `tests/test_skill_tools.py` (executor-side filtering + resource path traversal)
- Origin finding: prior turn's analysis of `tools/skill.py` showing the static tool description is registered globally unfiltered while only the executor enforces `allowed_skills`.
