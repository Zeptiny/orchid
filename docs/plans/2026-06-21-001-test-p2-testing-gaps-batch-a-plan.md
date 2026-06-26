---
title: "test: Close P2/P3 testing-gap findings (Batch A)"
type: test
status: active
date: 2026-06-21
---

# Close P2/P3 Testing-Gap Findings (Batch A)

## Summary

Add test coverage for 41 `gated_auto` testing-gap findings surfaced in `todo-pendings-fixes.md` (P2 and P3 tiers). Zero production code changes — pure test additions across 7 modules. Executed as 6 parallel per-module subagents, each scoped to its module's test file(s) and the specific branches flagged as untested.

---

## Problem Frame

The 2026-06-20 full-codebase review flagged ~40 P2/P3 findings whose only action is "add tests" — specific branches in existing code paths with no direct test coverage. These are `gated_auto` (concrete, mechanical work) but were never applied because the sweep ran in `report-only` mode. P0 and P1 testing gaps have already been closed; the P2/P3 gap is the remaining backlog.

These gaps matter because:
- Untested branches hide latent bugs (e.g., P2-163 stale-index truncation, P2-166 malformed embedding response)
- Some untested code is security-relevant (P2-49 XML escaping in `format_subagent_attrs`, P2-105 timeout-bypass branch)
- Future refactors (Batch B/C) need a safety net; closing these first surfaces any latent bugs the gated fixes must respect

---

## Requirements

- R1. Every branch named in the 41 findings' titles must have at least one test that exercises it and asserts the expected behavior
- R2. No production source code may be modified. If a subagent discovers a bug while writing a test, it must report the bug back rather than fixing it (Batch B/C handles fixes)
- R3. All new tests pass; the full existing suite (814 tests) continues to pass
- R4. `ruff check .` remains clean on all touched test files
- R5. Each fixed finding is marked `[FIXED — testing-gap sweep 2026-06-21]` in `todo-pendings-fixes.md` (or `[NO-OP — ...]` / `[BLOCKED — ...]` as applicable)

---

## Scope Boundaries

- **In scope:** test additions only, for the 41 findings listed in the implementation units below
- **Out of scope:** any production code changes, any `gated_auto` finding that is not a testing gap (Batch B/C), any `manual` or `advisory` finding
- **Deferred to follow-up work:** bugs discovered while writing tests are reported and deferred to Batch B/C, not fixed in this pass

---

## Context & Research

### Relevant Code and Patterns

- Existing test files are the pattern source — each subagent reads the sibling test file(s) before writing
- Test framework: `pytest` + `pytest-asyncio` (`asyncio_mode=auto`), `pytest-timeout` (120s). `ruff` for lint.
- Screens tests use plain `unittest.TestCase` + `unittest.mock` (no Textual Pilot harness) — verified in `tests/test_settings_screen.py:1-30`
- Source paths in `todo-pendings-fixes.md` omit the `src/stupidex/` prefix; subagents translate to `src/stupidex/<module>/<file>.py`

### Institutional Learnings

- `docs/solutions/` is essentially empty — no prior learnings to carry forward.

---

## Key Technical Decisions

- **Parallel per-module subagents (6 agents, one round):** Each module's tests live in module-specific files, so no file-level collision risk. Parallel dispatch minimizes wall-clock time. Subagents are `general` type with full tool access (read, edit, grep, glob, bash for pytest/ruff).
- **No production code changes (hard constraint):** Keeps this batch a pure coverage expansion. Bugs found are reported, not fixed — fixes belong to Batch B/C. This keeps the diff reviewable (only test files + the findings doc change).
- **Grouping:** domain (5) + tools (2) combined for balance; all other modules get dedicated agents. Smallest groups (tools+mcp) paired; largest (rag=12, screens=9) dedicated.
- **Sequencing:** All 6 agents dispatched in a single parallel round. Final verification (full pytest + ruff) runs after all return, in a sequential step.
- **Mark-as-fixed protocol:** Each subagent marks its own findings in `todo-pendings-fixes.md` using `[FIXED — testing-gap sweep 2026-06-21]`. Safe because each finding appears on a unique line and edits are non-overlapping.

### Spawning strategy

```
Round 1 (parallel, 6 agents):
  ├─ Agent A (domain):       5 findings → tests/test_chain.py, tests/test_*.py
  ├─ Agent B (agents):       4 findings → tests/test_subagent_manager.py
  ├─ Agent C (tools+mcp):    4 findings → tests/test_file_manipulation.py, tests/test_rag_tools.py, tests/test_mcp_*.py
  ├─ Agent D (llm):          7 findings → tests/test_streaming_messages.py, tests/test_dynamic_system_prompt.py
  ├─ Agent E (rag):         12 findings → tests/test_rag_*.py
  └─ Agent F (screens):      9 findings → tests/test_settings_screen.py, tests/test_*.py

Round 2 (sequential, orchestrator):
  └─ Full pytest + ruff + commit
```

---

## Implementation Units

- U1. **domain tests (5 findings)**

**Goal:** Cover the 5 domain-layer testing gaps.

**Dependencies:** None

**Files:**
- Test: `tests/test_chain.py`, `tests/test_message.py`, `tests/test_agent.py` (create if absent), `tests/test_session.py` (create if absent), `tests/test_tool.py` (create if absent)

**Findings:**
- P2-14: `domain/chain.py:32` — `Chain.finish()` idempotency guard and `format_elapsed` boundaries
- P2-15: `domain/agent.py:10` — `AgentTypes.from_str`/`ModelTier.from_str` error paths and `Agent` dict round-trip
- P2-16: `domain/session.py:40` — `Session.to/from_storage_dict` round-trip and corrupt-subagent resilience
- P2-18: `domain/tool.py:35` — `Tool.to_dict()` OpenAI function-schema serialization
- P3-13: `domain/message.py:148` — `record_streamed_message` SYSTEM-role and catch-all branches

**Test scenarios:**
- Covers P2-14. `finish()` twice → second is no-op; `format_elapsed` at 0s / 59s / 1h+ / 1h+59m boundaries
- Covers P2-15. invalid `AgentTypes`/`ModelTier` string → raises with correct message listing raw enum values; `Agent.to_dict → from_dict` round-trips all fields including `allowed_tools`/`allowed_skills`
- Covers P2-16. `Session` storage round-trip preserves chains + subagents; one corrupt subagent dict is skipped gracefully, other entries still load
- Covers P2-18. `Tool.to_dict` produces valid OpenAI function schema (`name`, `description`, `parameters` with `type:object`, `properties`, `required`, `strict`)
- Covers P3-13. `record_streamed_message` with `role=SYSTEM` updates system message; unknown role/type hits catch-all without raising

**Verification:** `python -m pytest tests/test_chain.py tests/test_message.py tests/test_agent.py tests/test_session.py tests/test_tool.py -q` passes; `ruff check` clean on touched files.

---

- U2. **agents tests (4 findings)**

**Goal:** Cover the 4 agents-layer testing gaps in `SubagentManager` and helpers.

**Dependencies:** None

**Files:**
- Test: `tests/test_subagent_manager.py`

**Findings:**
- P2-49: `agents/manager.py:63` — `format_subagent_attrs` escape + elapsed branches (security boundary for XML injection)
- P2-50: `agents/manager.py:101` — `elapsed_seconds` property three branches
- P2-51: `agents/manager.py:263` — empty/blank content handling in result assignment
- P2-52: `agents/manager.py:188` — `cancel_all` clearing `on_spawn=None` side effect

**Test scenarios:**
- Covers P2-49. `format_subagent_attrs` with content containing `<`, `&`, `"`, `>` → escaped in output; `elapsed_seconds` for record with `end_time=None` (running), `end_time` set, `start_time=None`
- Covers P2-50. `elapsed_seconds`: running record (no end_time → now - start); completed record (end - start); restored with neither (0.0)
- Covers P2-51. subagent result content blank/empty/`None` → assigned value is empty string or placeholder, not `None` crash
- Covers P2-52. `cancel_all()` sets `on_spawn = None`; subsequent `spawn()` raises (or no-ops) rather than calling a dead callback

**Verification:** `python -m pytest tests/test_subagent_manager.py -q` passes; `ruff check` clean.

---

- U3. **tools + mcp tests (4 findings)**

**Goal:** Cover the 2 tools-layer and 2 mcp-layer testing gaps.

**Dependencies:** None

**Files:**
- Test: `tests/test_file_manipulation.py`, `tests/test_rag_tools.py`, `tests/test_mcp_lifecycle.py`, `tests/test_mcp_schema.py`

**Findings:**
- P2-70: `tools/file_manipulation.py:162` — `execute_edit_tool` `replace_all=true`, multiple-matches, and generic Exception error path
- P2-72: `tools/rag.py:107` — `execute_rag_search` `ValueError` branch and generic `Exception` embedding branch
- P2-128: `mcp/__init__.py:113` — `_await_runner` timeout/cancel branch
- P2-129: `mcp/example_server.py:44` — zero test coverage on the MCP integration entrypoint

**Test scenarios:**
- Covers P2-70. `execute_edit_tool` with `replace_all=true` replaces all matches; multiple matches without `replace_all` → error result; tool raises generic Exception → ExecutorResult with error message (not propagated)
- Covers P2-72. `execute_rag_search` with a `ValueError` from underlying search → ExecutorResult error; generic `Exception` from embedder → error message embedded in result content (not propagated)
- Covers P2-128. `_await_runner` with a runner that doesn't stop within 3s → cancelled; runner that stops cleanly → returns without cancel
- Covers P2-129. `example_server` `echo` tool returns `arguments['message']` verbatim; missing `message` arg → sensible error/empty result

**Verification:** `python -m pytest tests/test_file_manipulation.py tests/test_rag_tools.py tests/test_mcp_lifecycle.py tests/test_mcp_schema.py -q` passes; `ruff check` clean.

---

- U4. **llm tests (7 findings)**

**Goal:** Cover the 7 llm-layer testing gaps.

**Dependencies:** None

**Files:**
- Test: `tests/test_streaming_messages.py`, `tests/test_dynamic_system_prompt.py`, `tests/test_static_system_prompt.py` (create if absent)

**Findings:**
- P2-102: `llm/static_system_prompt.py:22` — `build_static_system_prompt` and `_get_os_info` OS branches
- P2-103: `llm/client.py:56` — `classify_error` missing `BadGatewayError` branch test
- P2-104: `llm/client.py:114` — `_history_to_api_messages` THINKING-between-tool_calls-and-result invariant
- P2-105: `llm/client.py:210` — `_TOOLS_WITHOUT_TIMEOUT` bypass branch in `_execute_tool`
- P3-55: `tests/test_streaming_messages.py` — `_history_to_api_messages` orphan/tool_calls invariants
- P3-56: `llm/client.py:34` — `classify_error` exception-type ladder exercised by neither test nor type discipline
- P3-57: `llm/client.py:467` — stream-cancel propagation path (the formerly-duplicated except block) has no concurrency test

**Test scenarios:**
- Covers P2-102. `build_static_system_prompt` produces valid structure on Linux/macOS/Windows-ish envs; `_get_os_info` returns string for known + unknown platforms
- Covers P2-103 + P3-56. `classify_error` with `BadGatewayError`, `ServiceUnavailableError`, `APIError`, `Timeout`, `RateLimitError`, generic `Exception` → each maps to correct classification string
- Covers P2-104 + P3-55. `_history_to_api_messages` with THINKING chunk between `tool_calls` and `tool_result` → preserved in order; orphan `tool_call` with no matching result → handled (not raised); `tool_result` with no preceding `tool_calls` → handled
- Covers P2-105. `_execute_tool` with a tool name in `_TOOLS_WITHOUT_TIMEOUT` set → no timeout applied; tool not in set → timeout applied
- Covers P3-57. stream cancellation mid-stream → cleanup runs (no dangling tasks; assistant message not committed or committed-with-marker)

**Verification:** `python -m pytest tests/test_streaming_messages.py tests/test_dynamic_system_prompt.py tests/test_static_system_prompt.py -q` passes; `ruff check` clean.

---

- U5. **rag tests (12 findings)**

**Goal:** Cover the 12 rag-layer testing gaps — the largest module.

**Dependencies:** None

**Files:**
- Test: `tests/test_rag_store.py`, `tests/test_rag_indexer.py`, `tests/test_rag_embedder.py`, `tests/test_rag_chunker.py`

**Findings:**
- P2-162: `rag/store.py:236` — search dimension-mismatch error path
- P2-163: `rag/store.py:226` — search vector/chunk count mismatch (stale-index truncation)
- P2-164: `rag/indexer.py:190` — embedding pre-check unexpected format branch in `index_project`
- P2-165: `rag/embedder.py:105` — litellm `ImportError` branch in `_embed_litellm`
- P2-166: `rag/embedder.py:104` — `aembedding` returning empty/malformed `response.data`
- P2-167: `rag/embedder.py:49` — embedding batching (`BATCH_SIZE=100`) with >100 texts
- P2-168: `rag/indexer.py:392` — `_read_and_hash` `max_file_size` branch
- P2-169: `rag/indexer.py:120` — `_indexing` re-entrancy guard returns empty `IndexResult`
- P2-170: `rag/store.py:405` — `delete_by_file` vector-realignment branch (len mismatch)
- P3-77: `rag/store.py:313` — `record_index_duration` direct test
- P3-78: `rag/embedder.py:128` — `embed_single` public method
- P3-79: `rag/store.py:273` — `_cosine_similarity` zero-vector guard

**Test scenarios:**
- Covers P2-162. `search` with query vector of wrong dimension → error result (not crash)
- Covers P2-163. `search` when `len(vectors) != len(chunks)` → truncates to min and returns partial results (or error, per current behavior — pin it)
- Covers P2-164. `index_project` embedding pre-check returns unexpected format (not list/non-empty) → error
- Covers P2-165. `_embed_litellm` with `litellm` not installed → `ImportError` → clear error message (not stack trace)
- Covers P2-166. `aembedding` returns `data=[]` or malformed → `ValueError` surfaced cleanly
- Covers P2-167. `embed` with >100 texts → batched into multiple calls; result length matches input
- Covers P2-168. `_read_and_hash` with file larger than `max_file_size` → skipped/handled
- Covers P2-169. second concurrent `index_project` call → returns empty `IndexResult` (re-entrancy guard)
- Covers P2-170. `delete_by_file` when vector count != chunk count after deletion → realigns correctly
- Covers P3-77. `record_index_duration` writes duration to store; retrievable
- Covers P3-78. `embed_single("text")` returns single vector of correct dimension; empty text → error (Pin the behavior; if it raises `IndexError`, that's P2-187 for Batch C)
- Covers P3-79. `_cosine_similarity` with zero vector → returns 0.0 (no `NaN`, no `DivisionByZero`)

**Verification:** `python -m pytest tests/test_rag_store.py tests/test_rag_indexer.py tests/test_rag_embedder.py tests/test_rag_chunker.py -q` passes; `ruff check` clean.

---

- U6. **screens tests (9 findings)**

**Goal:** Cover the 9 screens-layer testing gaps. Uses plain `unittest` + `unittest.mock` pattern (no Textual Pilot needed — verified).

**Dependencies:** None

**Files:**
- Test: `tests/test_settings_screen.py`, `tests/test_input_modal.py` (create), `tests/test_picker.py` (create)

**Findings:**
- P2-208: `screens/input_modal.py:7` — `InputModal` zero coverage (all branches)
- P2-209: `screens/picker.py:15` — `OptionPicker` zero coverage
- P2-210: `screens/settings.py:282` — `NewProviderForm` model-row removal branch
- P2-211: `screens/settings.py:286` — `NewProviderForm` `on_input_changed` / `on_select_changed` state-sync
- P2-212: `screens/settings.py:541` — `ConfirmScreen` 'Close and Save' path and `_on_confirm_discard('save_close')`
- P2-213: `screens/settings.py:859` — `SettingsScreen.on_button_pressed` routing branches
- P2-214: `screens/settings.py:1064` — `SettingsScreen` picker flows (theme/personality/default_model/embedding)
- P3-92: `screens/settings.py:453` — `NewMCPServerForm` Cancel button and Escape paths
- P3-93: `screens/settings.py:1274` — `key_ctrl_s` save-in-place path

**Test scenarios:**
- Covers P2-208. `InputModal` conform with text → returns value; Cancel/Escape → returns `None`; empty submit → `None` (pin current behavior even if P2-206 is advisory)
- Covers P2-209. `OptionPicker` with items → compose builds Options; `key_up`/`key_down` moves highlight; filter narrows list; Enter returns selected id; empty-string id handled
- Covers P2-210. `NewProviderForm` removing a model row → row removed from UI + internal state
- Covers P2-211. `on_input_changed` on alias field → state updated; `on_select_changed` on provider dropdown → state synced
- Covers P2-212. `ConfirmScreen` with 'save_close' → save triggered then dismiss; 'discard' → dismiss without save
- Covers P2-213. `on_button_pressed` with each button id → routes to correct handler (edit/add provider, edit/add MCP, etc.)
- Covers P2-214. Each picker flow (theme/personality/default_model/embedding) → opens picker, returns value, updates config
- Covers P3-92. `NewMCPServerForm` Cancel button → form dismissed without save; Escape key → same
- Covers P3-93. `key_ctrl_s` → save triggered in place (no dismiss)

**Verification:** `python -m pytest tests/test_settings_screen.py tests/test_input_modal.py tests/test_picker.py -q` passes; `ruff check` clean.

---

- U7. **Final verification + doc update + commit**

**Goal:** Confirm no cross-interference, mark findings, commit.

**Dependencies:** U1–U6 all complete.

**Files:** `todo-pendings-fixes.md`

**Approach:**
- Run `python -m pytest -q` — full suite (814 existing + new tests) must pass
- Run `ruff check .` — clean
- Handle per-finding outcomes: FIXED → mark `[FIXED — testing-gap sweep 2026-06-21]`; NO-OP (test already existed) → mark `[NO-OP — ...]`; BLOCKED (bug found that prevents the test) → mark `[BLOCKED — ...]` and escalate to user
- Commit: `test: close P2/P3 testing-gap findings (Batch A)`

**Verification:** `git status` clean after commit; `git log --oneline -1` shows the commit.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Subagent discovers a bug in untested code and "helps" by fixing it | Hard constraint in prompt: report-only, no production edits. Blocked agents escalate back. |
| Two subagents edit `todo-pendings-fixes.md` simultaneously | Each finding is on a unique line; edits use unique `[FIXED — ...]` anchors. Run doc-marking sequentially in U7 if parallel edits cause conflicts. |
| Screens tests need Textual Pilot harness (async) | Verified: existing `test_settings_screen.py` uses plain `unittest` + mocks. No Pilot needed. |
| Subagent invents tests that pass without exercising the branch | Prompt requires reading the source branch first and asserting on branch-specific behavior (not just "no exception"). |
| Some findings overlap (e.g., P2-104 + P3-55 both cover `_history_to_api_messages`) | Grouped in the same unit (U4) so one agent writes complementary, non-duplicated tests. |
| New test files need `__init__.py` or import path fixes | `tests/__init__.py` already exists; new test files just need `from stupidex.<module>...` imports. |

---

## System-Wide Impact

- **Interaction graph:** New tests import from production modules but do not modify them. No callbacks, middleware, or entry points affected.
- **Unchanged invariants:** All production behavior unchanged. If a test reveals an invariant is actually broken, that's a Batch B/C finding — not fixed here.
- **API surface parity:** N/A — no API changes.

---

## Sources & References

- **Findings doc:** `todo-pendings-fixes.md` (lines 133–363 for P2, 398–508 for P3 gated_auto testing gaps)
- Related prior work: `docs/plans/2026-06-20-002-fix-p1-testing-gaps-plan.md` (P1 testing-gap sweep — same pattern, smaller scope)
- Related prior work: `docs/plans/2026-06-20-001-fix-p1-code-review-findings-plan.md` (P1 fixes)
- Test harness conventions: `tests/test_settings_screen.py:1-30` (screens pattern), `tests/test_rag_store.py` (rag pattern), `tests/test_subagent_manager.py` (agents pattern)
