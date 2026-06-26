---
title: "fix: P2 maintainability dedup (Batch 8)"
type: refactor
status: active
date: 2026-06-21
---

# P2 — Maintainability / dedup (Batch 8)

## Summary

Eleven low-risk maintainability fixes across four modules (`llm/`, `tools/`, `screens/`, plus a new `llm/types.py` typing overlay). Work is grouped into four units of escalating scope: (A) typing overlay, (B) mechanical dedup, (C) behavior fixes, (D) latent-hazard keyed cache. Each unit is independently shippable as one commit. Unit E (P2-82, P2-60, P2-101) is deferred — they need design decisions or dedicated passes beyond this batch's "low risk, high value" charter.

P2-78 verified false-positive (already fixed under P1-15 U5: `fnmatch.translate` in `search.py:94`). P2-98 WONTFIX: replacing the hetero-tuple return with a dataclass introduces a construction boundary at the resolver seam + heaviest test churn in the batch (4 test files mock the tuple shape); cost ≫ value.

---

## Problem Frame

The Batch 8 issues were flagged in the P2 code-review enumeration as localized maintainability smells: duplicated helpers, leaked abstractions, hardcoded policy in the wrong layer, silent `except Exception:` swallows, and shared mutable state on screens UI caches. None are correctness bugs on the happy path; several carry latent hazards surfaced during verification (P2-204 implies a latent shallow-copy bug breaking dirty detection; P2-205 implies a latent cross-domain button-id routing hazard). All fixes are designed to preserve existing behavior on the happy path — the dict pass-through design (storage == wire == in-memory == working buffer, per the 2026-06-21 P2-19 WONTFIX decision) is honored throughout.

---

## Requirements

- R1. TypedDicts for OpenAI chat-message and tool-call shapes are available in a new `llm/types.py`; client signatures are annotated against them. No runtime change, no conversion boundary.
- R2. Model qualification `f"{provider}/{model}" if provider else model` is performed exactly once in `llm/providers.py` and reused at all four call sites.
- R3. The `●` picker current-selection marker is emitted from `OptionPicker.__init__` via an optional `current=` parameter; ad-hoc caller-side mutation is removed.
- R4. `_render_mcp_list` is deleted; MCP items render via the existing `_render_keyed_list` helper. The duplicate `.mcp-list-item` CSS rule is removed.
- R5. `Config(**asdict(config))` shallow-copy is centralized in a `SettingsScreen._clone_config` static helper. (Deepcopy / shallow-copy bug in `_original` vs `_config` is deferred to a separate correctness ticket.)
- R6. `_format_edit_result_content` (from `file_manipulation.py`) is the single shared edit-result formatter; ast.py callers pass `replace_all=False` explicitly.
- R7. `execute_edit_tool` and `execute_write_tool` in `file_manipulation.py` reuse `_trigger_post_write_callbacks` (from `ast.py`); callback failures surface in the result content.
- R8. The three `build_*()` factory calls (`build_delegate_tool`, `build_skill_tool`, `build_list_skills_tool`) are memoized inside `get_tool_registry()` keyed off `reset_tool_registry()` cache-bust.
- R9. Plain-string error returns in `file_manipulation.py` (`execute_read_tool`, `execute_read_directory_tool`, `execute_glob_tool`, `execute_write_tool`) are wrapped in a consistent `<file_error tool="..." path="...">` envelope using existing `_xml_attr` / `_cdata_text` helpers. (ast.py "mixed escape" claim is a false positive — `_xml_attr` for attrs, `escape` for text is correct discipline.)
- R10. `set_current_allowed_skills` returns its `ContextVar` token; `stream_response` uses `try/finally reset(token)` to restore the prior value.
- R11. `SettingsScreen._items_cache` is replaced by a `_items_caches: dict[str, list[tuple[str, str]]]` keyed by action prefix (`"prov"`, `"mcp"`); `on_button_pressed` looks up the cache matching the button's prefix; no cross-domain indexing.
- R12. All existing test assertions continue to pass (modulo explicitly enumerated test updates in U6, U7, U11).

---

## Scope Boundaries

- Does **not** introduce any runtime conversion boundary on `dict[str, Any]` tool-call / chat-message objects (per P2-19 WONTFIX rule). TypedDicts in U1 are typing-only — no runtime constructor, no allocation, no attribute access; values remain plain `dict` at runtime.
- Does **not** fix the latent shallow-copy bug in `Config(**asdict(config))` (nested dataclasses shared between `_config` and `_original` undermining dirty detection). U5 centralizes the incantation but preserves `asdict` semantics. Deepcopy / `copy.deepcopy` is a behavior change worth a separate correctness ticket.
- Does **not** change `_history_to_api_messages`, `_stream_task`, `record_streamed_message`, `_reconcile_orphan_tool_results`, or `commit_assistant_with_tool_calls` behavior.
- Does **not** change the layout of `Message.to_storage_dict` / `Message.from_storage_dict` (disk compat).
- Does **not** standardize runtime tc access guards (P2-107 "layer 2") — turning `tc["function"]["name"]` KeyError into an in-band `ExecutorResult` error is a behavior change requiring its own justification. Only the typing overlay ships here.

### Deferred to Follow-Up Work

- **P2-82** — One-line dead-code removal (`reversed(lines_before[:-1])` ternary in `ast.py:157`). Trivial and cosmetic; bundle opportunistically with the next ast.py touch-up.
- **P2-60** — `execute_command` hardcoded `working_directory="."`. Needs a design decision: extend `Config` with `command_working_directory` (matches the established `command_timeout` pattern in `config.py:74-77`) or document that `.` is intentional. Defaulting to extend-Config for consistency; awaiting confirmation in a dedicated pass.
- **P2-101** — Cross-module imports in `dynamic_system_prompt.py:7-10` reaching into `agents.manager` + `domain.todo`. Fix via dependency inversion or pre-assembled-state arg passing; non-trivial and touches `test_dynamic_system_prompt.py` patch paths. Deferred to a dedicated dynamic-system-prompt refactor pass.
- **P2-100** — Dual signaling via `tool_calls_started` Event + queues. Real, but heaviest test churn in Batch 8 (~10 harness sites in `test_streaming_messages.py` construct `asyncio.Event()` directly). Needs a dedicated plan.
- **P2-98** — WONTFIX. `resolve_embedding_ref` heterogeneous tuple union. Replacing with a dataclass introduces a minor construction boundary at the resolver seam + 4 test files mock the tuple return shape. Cost ≫ value. The bare tuple is workable; callers use `len(ref) == 2` once at the consumer site.

---

## Context & Research

### Relevant Code and Patterns

- `src/stupidex/llm/client.py` — stream loop, `_execute_tool`, `_history_to_api_messages`, `stream_response`; signatures at `:210, :324, :451, :740`. ContextVar assignment at `:747-748` (P2-111).
- `src/stupidex/llm/providers.py` — model-qualification helper duplication at `:144` (P2-97); `resolve_embedding_ref` at `:161`.
- `src/stupidex/tools/ast.py` — `_format_edit_result` at `:108-138` (hardcodes `replace_all="false"` at `:123`); `_trigger_post_write_callbacks` at `:231-240` (returns `list[str]` of failures).
- `src/stupidex/tools/file_manipulation.py` — `_format_edit_result_content` at `:112-143` (parametrized `replace_all: bool` at `:117`); inline post-write callback loops at `:205-209` (edit) and `:371-375` (write); plain-string error returns at `:44-50, :64-66, :69-72, :80-81, :282-286, :341-344, :383-384`; `_xml_attr` / `_cdata_text` imported at `:12`.
- `src/stupidex/tools/__init__.py` — registry pattern at `:62-100`; three builders at `:84, :88-89`.
- `src/stupidex/screens/settings.py` — `●` marker sites at `:1104, :1182, :1200, :1218` (P2-201); `_render_mcp_list` at `:941-949` vs `_render_keyed_list` at `:1231-1246` (P2-202); 4 bare `except Exception:` sites at `:25, :220, :270, :1331` (P2-203 — deferred), `Config(**asdict(...))` ×4 at `:765-766, :1284-1285` (P2-204); `_items_cache` field at `:767`, writers at `:949, :1237`, readers at `:872-880, :882-890` (P2-205). Note: `●` marker also appears at `:1328, :1334, :1336` for dirty-tab indicators — **different semantics, must not be folded into P2-201 fix**.
- `src/stupidex/screens/picker.py` — `OptionPicker.__init__` and `_build_options` at `:24` (P2-201 home for `current=` param).
- `src/stupidex/tools/skill.py:9-13` — `_current_allowed_skills: ContextVar[list[str] | None]`; `set_current_allowed_skills` currently returns `None`.
- `src/stupidex/domain/tool.py` — `Tool` dataclass (referenced for U8 pattern only).
- `tests/test_streaming_messages.py` — ~10 harness sites construct `tool_calls_started = asyncio.Event()` (deferred P2-100 only).
- `tests/test_file_manipulation.py:25-29, 51, :97-101, :135` — XML str assertions + post-write-callback test.
- `tests/test_settings_screen.py:1187-1210` — four `_items_cache = [...]` setters directly (U11 must update these).

### Institutional Learnings

- `docs/solutions/runtime-errors/mcp-runner-cancellederror-skips-aclose.md` — confirms the pattern of preserving current behavior on happy paths while addressing latent hazards.
- P2-19 WONTFIX (2026-06-21): TypedDicts are typing-only and do not introduce a conversion boundary; dataclasses do. U1 honors this rule.

### External References

- None — all fixes follow existing in-codebase patterns.

---

## Key Technical Decisions

- **TypedDict over dataclass (U1).** Per the 2026-06-21 P2-19 WONTFIX decision, TypedDicts are typing-only overlays: no runtime constructor, no allocation, no attribute access. Values remain plain `dict` at runtime. This is categorically different from the `ToolCall` dataclass that was WONTFIX'd.
- **Pure typing for P2-107 (U1).** Only the typing-overlay layer (Layer 1) ships here. Turning `tc["function"]["name"]` `KeyError` into an in-band `ExecutorResult` (Layer 2) is a behavior change that needs its own justification and is deferred.
- **Memoize factories, don't convert them (U8).** The three `build_*()` calls run once per `get_tool_registry()` invocation; the issue is that `reset_tool_registry()` invalidates the dict and the next call re-invokes the builders. Memoize the result inside the registry (or, equivalently, cache the built Tool on a sentinel). Do **not** convert the other 23 module-level Tool instances into builders — that's churn with no value.
- **Shared formatter, not duplicated helpers (U6).** The ast.py `_format_edit_result` always passes `replace_all="false"` because replace-all genuinely doesn't apply to single-symbol tools (replace_symbol/rename_symbol). The correctness framing "divergent behavior" was misleading — divergence is intentional per tool semantics. The duplication, however, is genuine. Consolidate to the more general `_format_edit_result_content` (the file_manipulation.py version), which accepts `replace_all: bool` as a required kwarg.
- **`_clone_config` shallow, deepcopy deferred (U5).** The latent shallow-copy bug (nested `RAGConfig`, `mcp_servers`, `tier_models`, `providers` shared between `_config` and `_original`) is real and breaks dirty detection. But switching to `copy.deepcopy` is a behavior change that may surface previously-masked faults; it deserves its own ticket with regression tests on nested-element mutation. U5 only centralizes the incantation.
- **P2-205 keyed dict, not button-id encoding (U11).** Replacing the shared `_items_cache: list` with a `_items_caches: dict[str, list]` keyed by action prefix (`"prov"`, `"mcp"`) is backward-compatible with the existing `action_prefix` parameter already threaded through `_render_keyed_list`. Button-id encoding (e.g., `prov-edit-{alias}` with URL-encoded alias) is more invasive and not worth the churn.
- **ast.py escape claim is a false positive (P2-66).** `_xml_attr` for XML attribute values (quotes, ampersands) + `escape` for element text (`<`, `>`, `&`) on the same value in different positions is correct discipline, not "mixed escapes". Only the file_manipulation.py plain-string error returns are real (U9).
- **P2-98 WONTFIX.** Construction boundary at the resolver seam + heaviest test churn in the batch (4 test files).
- **P2-100 deferred.** Real but heavy test churn (~10 harness sites). Needs dedicated plan.

---

## Open Questions

### Resolved During Planning

- **Should `_format_edit_result` and `_format_edit_result_content` be unified under a new module or kept in `_xml_utils.py`?** Resolved: move into `src/stupidex/tools/_xml_utils.py` (the existing home of `_xml_attr` / `_cdata_text`); both ast.py and file_manipulation.py already import from there.
- **Should `set_current_allowed_skills` return the token directly or via a new `reset_current_allowed_skills` helper?** Resolved: have `set_current_allowed_skills` return its token (the standard pattern — `contextvars.ContextVar.set` already returns one); caller does `try/finally reset_current_allowed_skills(token)`. Add a small `reset_current_allowed_skills(token: Token)` for symmetry with the existing setter.
- **Should the `_items_cache` rename also update the field to a `dict[str, list]`, or thread by prefix at each method call?** Resolved: dict-keyed by prefix. The existing `action_prefix` parameter on `_render_keyed_list` already establishes the protocol; we're making the cache match.
- **Should P2-66 fix the ast.py escape pattern too?** Resolved: no — that's a false positive (`_xml_attr` for attrs, `escape` for text is correct).

### Deferred to Implementation

- **Exact name for the centralized formatter in `_xml_utils.py`.** Likely `format_edit_result` (drops the `_content` suffix since it's now public/shared). Confirm during U6 implementation; rename is local to that unit.
- **Whether `_TOOLS_WITHOUT_TIMEOUT` (P2-99) should also be addressed in this batch by moving the list to `Tool.needs_timeout` dataclass fields.** Deferred to a follow-up Batch 8 stretch — it touches ~10 `fake_execute_tool` fakes in `test_streaming_messages.py` whose bare `Tool` instances rely on defaults. Defaults preserve behavior, but verification is non-trivial.

---

## Implementation Units

- U1. **TypedDict overlay for chat-message and tool-call shapes (P2-106 + P2-107 layer 1)**

**Goal:** Provide TypedDict definitions for OpenAI chat-message and tool-call shapes; annotate `client.py` signatures against them. Pure typing win, no runtime change, no test rewrites required.

**Requirements:** R1, R12

**Dependencies:** None — first unit; no runtime change to anything downstream.

**Files:**
- Create: `src/stupidex/llm/types.py`
- Modify: `src/stupidex/llm/client.py` (annotate `_history_to_api_messages`, `_execute_tool`, `_stream_task`, `stream_response`)
- Test: `tests/test_llm_types.py` (optional — for shape contracts)

**Approach:**
- Define `ChatMessage` (TypedDict, with `role`, `content`, optional `tool_calls`, optional `tool_call_id`, optional `name`) — total=False for optional fields.
- Define `ToolCall` (TypedDict with `id: str`, `type: str`, `function: ToolCallFunction`) — total=False to tolerate in-flight delta shape.
- Define `ToolCallFunction` (TypedDict with `name: str`, `arguments: str`) — total=False.
- Annotate `_history_to_api_messages(messages: list[Message]) -> list[ChatMessage]`, `_execute_tool(tc: ToolCall, filtered_tools: dict[str, dict[str, Any]]) -> Message`, `_stream_task(... api_messages: list[ChatMessage] ...)`, `stream_response(...) -> AsyncGenerator[Message, None]`.
- Values remain plain `dict` at runtime — TypedDicts have no constructor and no runtime check. Storage == wire == in-memory == working buffer is preserved.

**Execution note:** No tests strictly required — TypedDicts are erased at runtime. Optionally lock shape contracts in a new `tests/test_llm_types.py` (e.g., `assert ChatMessage.__required_keys__` for documentation only).

**Patterns to follow:** PEP 692 (`typing.TypedDict`, `total=False`).

**Test scenarios:**
- Test expectation: none — runtime behavior unchanged. Optionally a static-types assertion in `test_llm_types.py` for documentation only.

**Verification:**
- All existing tests pass unchanged (1057+).
- `python -m mypy src/stupidex/llm/client.py` (if mypy is configured) surfaces no new errors.

---

- U2. **Extract `qualify_model` helper (P2-97)**

**Goal:** Eliminate the duplicated `f"{provider}/{model}" if provider else model` incantation across four sites. Single source of truth in `llm/providers.py`.

**Requirements:** R2, R12

**Dependencies:** None.

**Files:**
- Modify: `src/stupidex/llm/providers.py` (define `qualify_model(provider: str | None, model_id: str) -> str`)
- Modify: `src/stupidex/llm/client.py:774` (call helper)
- Modify: `src/stupidex/llm/providers.py:144` (call helper)
- Modify: `src/stupidex/rag/embedder.py:58` (call helper)
- Modify: `src/stupidex/tools/web_fetch.py:248` (call helper — currently always-qualified path, may simplify)
- Test: `tests/test_providers_resolution.py` (add coverage for `qualify_model` behavior)

**Approach:**
- Define `qualify_model(provider: str | None, model_id: str) -> str: return f"{provider}/{model_id}" if provider else model_id`.
- Replace the two duplicated inline expressions at `client.py:774` and `providers.py:144` (already in the same pattern).
- Replace `_resolve_ref`'s inline expression in `embedder.py:58`.
- Audit `web_fetch.py:248` — it always qualifies even when `provider` is empty; reconsider whether that's intended or should match the helper's semantics. If breaking, leave the call-site explicit.
- No conversion boundary introduced — the helper returns a `str` over existing primitives.

**Patterns to follow:** Module-level functions next to related resolution logic in `providers.py`.

**Test scenarios:**
- Happy path: `qualify_model("openai", "gpt-4") == "openai/gpt-4"`.
- Empty provider: `qualify_model(None, "gpt-4") == "gpt-4"`; `qualify_model("", "gpt-4") == "gpt-4"`.
- Idempotency check: existing call sites produce identical output before/after the swap (verified via existing tests in `test_streaming_messages.py` model-resolution assertions around L1569–1748).

**Verification:**
- Existing tests in `test_providers_resolution.py`, `test_streaming_messages.py`, `test_rag_embedder.py`, and `test_web_fetch.py` pass unchanged.

---

- U3. **`OptionPicker.current=` parameter for `●` marker (P2-201)**

**Goal:** Eliminate four ad-hoc `●` picker current-selection marker sites in `screens/settings.py` by moving the marker into `OptionPicker.__init__`.

**Requirements:** R3, R12

**Dependencies:** None.

**Files:**
- Modify: `src/stupidex/screens/picker.py` (add optional `current: str | None = None` to `OptionPicker.__init__`; prefix with `● ` when `item.id == current` else `  ` in `_build_options` at `:24`).
- Modify: `src/stupidex/screens/settings.py` (delete post-hoc loop mutations at `:1102-1105, :1179-1183`; collapse inline conditionals at `:1200, :1218`; pass `current=` to `OptionPicker` calls).
- Test: `tests/test_picker.py` (optional — guard test for the new `current=` behavior)

**Approach:**
- Add `current: str | None = None` to `OptionPicker.__init__`; in `_build_options`, prefix `item.label` with `f"● {item.label}" if item.id == current else f"  {item.label}"`.
- Migrate all four sites in `settings.py` to pass `current=<currently-selected value>` and remove the mutation/inline conditional.
- Do **not** touch the `●` markers at `settings.py:1328, :1334, :1336` (`_update_tab_labels`) — those mark dirty/modified tabs, not picker current-selection. Different semantics.
- Watch out: line 1093 pre-pads labels with two spaces and line 1104 then `strip()`s them — that coupling goes away once both sites delegate to the picker.

**Patterns to follow:** Existing `OptionPicker.__init__` param signature; `PickerItem(label, id)` constructor.

**Test scenarios:**
- Happy path: building an `OptionPicker([PickerItem(label="A", id="a"), ...], current="a")` produces a list whose first item label starts with `● ` and others start with `  `.
- Edge case — current id not in list: no items marked, no error raised.
- Edge case — `current=None` (default): behavior identical to today (no prefix added); backward-compatible with existing tests.

**Verification:**
- All existing `tests/test_picker.py` and `tests/test_settings_screen.py` tests pass unchanged (the new param defaults to `None` and produces no prefix when not set).
- `grep -n '●' src/stupidex/screens/settings.py` shows the `●` glyph only in `_update_tab_labels` (dirty-tab indicators) and `OptionPicker._build_options`.

---

- U4. **Delete `_render_mcp_list` + duplicate CSS rule (P2-202)**

**Goal:** Collapse the duplicated MCP renderer onto the existing `_render_keyed_list` helper and remove the byte-identical CSS rule.

**Requirements:** R4, R12

**Dependencies:** None.

**Files:**
- Modify: `src/stupidex/screens/settings.py` (delete `_render_mcp_list` at `:941-949`; build MCP items inline in `_render_mcp_servers` at `:932` then call `self._render_keyed_list(container, items, "mcp")`).
- Modify: `src/stupidex/screens/settings.py` (delete `.mcp-list-item` CSS rule at `:663-669` — identical to `.settings-list-item` at `:643`).
- Test: `tests/test_settings_screen.py` (no existing test touches `_render_mcp_list` — keep `_render_keyed_list` tests unchanged at `:437-442`).

**Approach:**
- The only functional difference between `_render_mcp_list` and `_render_keyed_list` is the data construction (MCP reads from `self._config.mcp_servers` and chooses `SSE:` vs `command args:` formatting) and the CSS class. The CSS class difference is non-functional (identical rules).
- Move the data-building logic (`if "url" in entry: detail = f"SSE: {entry['url']}" else: detail = f"{entry.get('command','?')} {' '.join(entry.get('args',[]))}"`) into `_render_mcp_servers` (line 932), producing `items: list[tuple[str, str]]`, then call `self._render_keyed_list(container, items, "mcp")`.
- Optionally add a regression test rendering MCP servers through the unified helper.

**Patterns to follow:** `_render_keyed_list` at `:1231-1246` (the helper being kept).

**Test scenarios:**
- Integration: rendering MCP servers with one SSE entry and one command entry produces both rows with the expected `mcp-edit-0` / `mcp-del-1` button ids.
- Integration: `_items_caches["mcp"]` (after U11) holds the rendered items in the same shape as the deleted `_items_cache` would have.

**Verification:**
- `grep -n '_render_mcp_list' src/stupidex/screens/settings.py` returns no matches.
- `grep -n 'mcp-list-item' src/stupidex/` returns no matches.

---

- U5. **`_clone_config` static helper (P2-204)**

**Goal:** Centralize the four `Config(**asdict(config))` shallow-copy incantations into one named helper. The latent deepcopy vs shallow-copy bug is **deferred** to a separate ticket.

**Requirements:** R5, R12

**Dependencies:** None.

**Files:**
- Modify: `src/stupidex/screens/settings.py` (add `_clone_config` static helper; replace 4 occurrences at `:765-766, :1284-1285`).
- Test: `tests/test_settings_screen.py` (no test asserts on the clone mechanism).

**Approach:**
- Add `@staticmethod def _clone_config(cfg: Config) -> Config: return Config(**asdict(cfg))`.
- Replace the four incantations in `__init__` and `_do_save` with `self._config = self._clone_config(config)` and `self._original = self._clone_config(config)`.
- **Defer the deepcopy fix** — switching to `copy.deepcopy(cfg)` is a behavior change: nested dataclasses (`RAGConfig`, `mcp_servers` dict, `tier_models` dict, `providers` dict) are currently shared between `_config` and `_original`, so dirty detection (`_tab_differs` at `:1335`) is subtly broken. Fixing this requires regression tests for nested-element mutation isolation. Track separately.

**Patterns to follow:** `dataclasses.asdict` for shallow config copies; `@staticmethod` for pure helpers.

**Test scenarios:**
- Test expectation: none — mechanical refactor only. The four `_clone_config` calls produce byte-identical `Config` instances to today.
- Optionally: characterization test that `_clone_config(cfg) != cfg is cfg` (different identity) and `asdict(_clone_config(cfg)) == asdict(cfg)` (same content).

**Verification:**
- `grep -n 'Config(\*\*asdict' src/stupidex/screens/settings.py` returns zero matches (all four replaced).
- All existing tests in `tests/test_settings_screen.py` pass unchanged.

---

- U6. **Consolidate `format_edit_result` into `tools/_xml_utils.py` (P2-62)**

**Goal:** Single shared edit-result XML formatter. ast.py callers pass `replace_all=False` explicitly.

**Requirements:** R6, R12

**Dependencies:** None — independent of U7 (U7 changes post-write callback plumbing, not formatter).

**Files:**
- Modify: `src/stupidex/tools/_xml_utils.py` (add `format_edit_result(path, message, replace, replace_all, content_match=False, ...) -> str` — port `_format_edit_result_content` from `file_manipulation.py:112-143`).
- Modify: `src/stupidex/tools/file_manipulation.py:112-143` (delete `_format_edit_result_content`; import from `_xml_utils`).
- Modify: `src/stupidex/tools/ast.py:108-138` (delete `_format_edit_result`; import shared `format_edit_result`; update call sites at `:682, :709, :768, :791, :822, :845, :859, :873` to pass `replace_all=False`).
- Test: `tests/test_file_manipulation.py` (existing XML str assertions at `:25-29, :51, :67` — verify they still pass; the consolidated formatter must emit byte-identical output for the same inputs).

**Approach:**
- The ast.py version hardcodes `'replace_all="false"'` at `:123`; the file_manipulation.py version accepts `replace_all: bool` and emits `f'replace_all="{str(replace_all).lower()}"'` at `:128`. The file_manipulation version is the more general superset.
- Move the more general version into `_xml_utils.py` as `format_edit_result(..., replace_all: bool, ...)`.
- ast.py callers pass `replace_all=False` — output is byte-identical to today.
- file_manipulation.py callers pass whatever they pass today — output is byte-identical.

**Patterns to follow:** Existing `_xml_attr` / `_cdata_text` helpers in `_xml_utils.py`.

**Test scenarios:**
- Happy path (ast): `replace_symbol` results still emit `replace_all="false"` in XML (regression test).
- Happy path (file_manipulation): `execute_edit_tool` with `replace_all=True` still emits `replace_all="true"`; with `replace_all=False` still emits `replace_all="false"` (regression tests in `test_file_manipulation.py:25-29, :51`).
- Edge case — `replace_all` arg omission: should be a required kwarg on the new shared helper (no silent default) to force callers to be explicit.

**Verification:**
- `grep -n '_format_edit_result' src/stupidex/tools/` returns no matches (both helpers deleted; only `format_edit_result` in `_xml_utils.py`).
- All existing tests in `tests/test_file_manipulation.py`, `tests/test_ast_tools.py`, `tests/test_streaming_messages.py:1062`, `tests/test_tool_output_offload.py:41,111,116` pass.

---

- U7. **Reuse `_trigger_post_write_callbacks` in file_manipulation.py (P2-63)**

**Goal:** Surface post-write callback failures from `execute_edit_tool` and `execute_write_tool` in the result content; stop swallowing them silently.

**Requirements:** R7, R12

**Dependencies:** None — independent of U6.

**Files:**
- Modify: `src/stupidex/tools/file_manipulation.py:205-209` (replace inline `for cb in post_write_callbacks: try/except` with `cb_failures = await _trigger_post_write_callbacks(file_path)`; thread failures into `_format_edit_result_content(..., message="; ".join(cb_failures) if cb_failures else None)`).
- Modify: `src/stupidex/tools/file_manipulation.py:371-375` (same pattern in `execute_write_tool`; append warning line to returned content if failures).
- Modify: `src/stupidex/tools/file_manipulation.py` (add `from stupidex.tools.ast import _trigger_post_write_callbacks`).
- Test: `tests/test_file_manipulation.py` (existing `test_write_tool_fires_post_write_callbacks:135` continues to pass; add new `test_edit_tool_surfaces_post_write_callback_failure` and `test_write_tool_surfaces_post_write_callback_failure` using `AsyncMock(side_effect=RuntimeError)`).

**Approach:**
- ast.py's `_trigger_post_write_callbacks(file_path) -> list[str]` collects per-callback failures and returns the list (callers in ast.py at `:837, :1015` surface them in the result XML).
- file_manipulation.py's inline loop at `:205-209, :371-375` swallows the same failures via `logger.warning(...)` — never reaches the `ExecutorResult`, so the agent never learns the AST index is stale.
- Replace the inline loop with the shared helper and pass failures into the result's `message`. For `execute_edit_tool`, `_format_edit_result_content` already has a `message` parameter. For `execute_write_tool`, append failures to the returned content string if non-empty.
- Watch for import-cycle risk: `file_manipulation.py` importing from `ast.py` — verify the import doesn't create a cycle (ast.py currently imports from `_xml_utils`, not from file_manipulation). If cycle, move `_trigger_post_write_callbacks` into a shared module.

**Patterns to follow:** ast.py callers at `:837, :1015`.

**Test scenarios:**
- Happy path — no callback failures: result content is unchanged from today (regression).
- Error path — one callback raises: failures are surfaced in `result.content` (or `result.message`) as `"; ".join(cb_failures)`.
- Error path — multiple callbacks raise: all failures surfaced, joined by `"; "`.
- Edge case — empty `post_write_callbacks` list: no failures, behavior unchanged.

**Verification:**
- `grep -n 'for cb in post_write_callbacks' src/stupidex/tools/file_manipulation.py` returns no matches.
- New tests `test_edit_tool_surfaces_post_write_callback_failure` and `test_write_tool_surfaces_post_write_callback_failure` pass.

---

- U8. **Memoize `build_*()` factory calls in `get_tool_registry` (P2-65)**

**Goal:** Stop re-invoking the three `build_*()` factory calls on every `get_tool_registry()` invocation after `reset_tool_registry()` invalidates the dict.

**Requirements:** R8, R12

**Dependencies:** None.

**Files:**
- Modify: `src/stupidex/tools/__init__.py:84, :88-89` (cache the three `build_*()` results — use either module-level singletons initialized lazily or cache them inside `get_tool_registry()` keyed off a sentinel that `reset_tool_registry()` can invalidate).
- Test: `tests/test_tool.py` (optional — new test asserting `get_tool_registry()` returns equivalent `Tool` objects across calls after `reset_tool_registry()`).

**Approach:**
- Pick the lower-cost fix: memoize `build_delegate_tool()`, `build_skill_tool()`, `build_list_skills_tool()` results inside `get_tool_registry()` based on a cache-bust key, since `reset_tool_registry()` already invalidates the dict. The three builders take real runtime arguments (`allowed_skills: list[str] | None = None`), so the cache key must include their current arguments.
- **Do not** convert the other 23 module-level Tool instances to builders — that's churn with no value.
- The cache invalidation path is the existing `reset_tool_registry()` at `:100`. The memoized builders should observe the same invalidation.

**Patterns to follow:** Existing `_TOOL_REGISTRY` dict at `:62` with `reset_tool_registry()` at `:100`.

**Test scenarios:**
- Happy path — first call after `reset_tool_registry()`: builders run once, populate the dict.
- Happy path — second call without reset: cached results returned, builders not re-invoked.
- Edge case — `allowed_skills` argument changes: cache is properly invalidated when the argument differs.

**Verification:**
- `tests/test_ast_tools.py:679` still passes (`"find_symbol_references" in registry`).
- New `test_tool_registry_caches_builders` passes.

---

- U9. **Wrap plain-string error returns in `<file_error>` envelope (P2-66 file_manipulation half)**

**Goal:** Consistent XML error envelope across `file_manipulation.py`'s read/read_directory/glob/write failure paths. The ast.py "mixed escape" half of P2-66 is a false positive (`_xml_attr` for attrs + `escape` for text on the same value is correct discipline).

**Requirements:** R9, R12

**Dependencies:** None — independent of U6 (different helpers).

**Files:**
- Modify: `src/stupidex/tools/file_manipulation.py:44-50, :64-66, :69-72, :80-81` (`execute_read_tool` error returns).
- Modify: `src/stupidex/tools/file_manipulation.py:282-286` (`execute_read_directory_tool` error).
- Modify: `src/stupidex/tools/file_manipulation.py:341-344` (`execute_glob_tool` error).
- Modify: `src/stupidex/tools/file_manipulation.py:383-384` (`execute_write_tool` error).
- Test: `tests/test_file_manipulation.py:97-101` (`test_edit_tool_generic_exception_returned_as_error_result` — asserts `"disk on fire" in result.content`, survives XML wrapping).

**Approach:**
- Define a small inline helper or reuse a pattern: `f'<file_error tool="read" path="{_xml_attr(file_path)}">{_cdata_text(str(e))}</file_error>'` for each error site.
- Import `_xml_attr` and `_cdata_text` from `_xml_utils.py` (already on `:12`).
- Update existing `disk on fire` test to assert the error substring continues to appear (the substring is preserved by the XML wrapping).

**Patterns to follow:** ast.py's `<ast_error tool="get_file_skeleton" file="{_xml_attr(file_path)}">File not found: {escape(file_path)}</ast_error>` envelope at `:377-378`.

**Test scenarios:**
- Happy path — read error: `result.content` contains `<file_error tool="read" path="...">` envelope.
- Happy path — directory read error: same shape with `tool="read_directory"`.
- Happy path — glob error: `tool="glob"`.
- Happy path — write error: `tool="write"`.
- Regression — existing `disk on fire` assertion: `"disk on fire" in result.content` still True (substring preserved inside the XML element text).
- Edge case — file_path with special XML chars (`<`, `>`, `&`, `"`): properly escaped in both attribute and text positions.

**Verification:**
- `grep -n 'Error reading file' src/stupidex/tools/file_manipulation.py` returns no matches (all wrapped in `<file_error>`).

---

- U10. **ContextVar token restoration in `stream_response` (P2-111)**

**Goal:** `stream_response` no longer leaks `allowed_skills` ContextVar state into the caller's task.

**Requirements:** R10, R12

**Dependencies:** None.

**Files:**
- Modify: `src/stupidex/tools/skill.py:9-13` (`set_current_allowed_skills` returns the `ContextVar` token; add `reset_current_allowed_skills(token: Token[list[str] | None]) -> None`).
- Modify: `src/stupidex/llm/client.py:747-748` (`stream_response` captures the token, then `try/finally reset_current_allowed_skills(token)` around the generator body).
- Test: `tests/test_skill_tools.py:115` (existing call to `set_current_allowed_skills` without restoration — may gain value from asserting restoration; minor adjustment if API surface changes).
- Test: `tests/test_streaming_messages.py` (verify no test relies on cross-invocation leakage — drive `stream_response` twice in the same task and assert skill filtering is independent per call).

**Approach:**
- Standard `contextvars` token pattern: `token = _current_allowed_skills.set(allowed)` returns a `Token`; `try/finally _current_allowed_skills.reset(token)` restores the prior value on exit (including exceptions and generator close).
- Add a `reset_current_allowed_skills(token)` helper for symmetry with the existing setter, since the ContextVar itself is module-private.
- `stream_response` is an async generator, so the `finally` block must wrap the entire body including `yield` statements — the generator's `aclose()` will trigger the `finally`.

**Patterns to follow:** Standard `contextvars` token pattern (PEP 567).

**Test scenarios:**
- Happy path — single `stream_response` invocation: prior `allowed_skills` state is restored after the generator exhausts.
- Happy path — generator closed early (`aclose()`): prior state is restored.
- Happy path — exception inside the generator: prior state is restored (via `finally`).
- Edge case — two `stream_response` invocations in the same task with different `allowed_skills`: second invocation's skill filter does not see the first's `allowed_skills` (after U10).

**Verification:**
- `grep -n 'set_current_allowed_skills' src/stupidex/llm/client.py` returns one call inside `stream_response`, paired with `reset_current_allowed_skills(token)` in a `finally` block.
- New tests pass.

---

- U11. **Keyed-dict `_items_caches` by action prefix (P2-205)**

**Goal:** Eliminate the latent cross-domain button-id routing hazard on `SettingsScreen._items_cache`. The cache becomes a `dict[str, list[tuple[str, str]]]` keyed by action prefix (`"prov"`, `"mcp"`); `on_button_pressed` resolves the cache by deriving the prefix from the button id.

**Requirements:** R11, R12

**Dependencies:** U4 (deletes `_render_mcp_list` so the only MCP writer left is `_render_keyed_list` with action_prefix `"mcp"`). Can ship without U4 by adapting `_render_mcp_list` to write to `_items_caches["mcp"]` — but cleaner after U4.

**Files:**
- Modify: `src/stupidex/screens/settings.py:767` (change `_items_cache: list[...]` field to `_items_caches: dict[str, list[tuple[str, str]]] = {}`).
- Modify: `src/stupidex/screens/settings.py:949` (`_render_mcp_list` writer — or, post-U4, the `_render_keyed_list` call from `_render_mcp_servers`).
- Modify: `src/stupidex/screens/settings.py:1237` (`_render_keyed_list` writer — store under `self._items_caches[action_prefix] = items`).
- Modify: `src/stupidex/screens/settings.py:872-880, :882-890` (`on_button_pressed` readers — derive prefix from button id and look up `self._items_caches[prefix]`; fail safely if missing).
- Test: `tests/test_settings_screen.py:1187-1210` (four `_items_cache = [...]` setters updated to `_items_caches["prov"] = [...]` / `_items_caches["mcp"] = [...]`).

**Approach:**
- The `action_prefix` parameter already threaded through `_render_keyed_list` (`"prov"` for providers, `"mcp"` for MCP servers) is the key.
- Replace the field with `self._items_caches: dict[str, list[tuple[str, str]]] = {}`.
- Writers: `self._items_caches[action_prefix] = items`.
- Readers in `on_button_pressed`: derive prefix from `btn_id.split("-")[0]`; look up `cache = self._items_caches.get(prefix, [])`; if missing, log a warning and return.
- Defensive handling for the case where `btn_id` doesn't match the expected `{prefix}-{action}-{idx}` shape.

**Patterns to follow:** `_render_keyed_list` `action_prefix` parameter already establishes the protocol.

**Test scenarios:**
- Happy path — prov edit: `_items_caches["prov"] = [("openai", "...")]`; clicking `prov-edit-0` routes to `on_provider_action_edit("openai", ...)`.
- Happy path — mcp edit: `_items_caches["mcp"] = [("slack", "...")]`; clicking `mcp-edit-0` routes to `on_mcp_action_edit("slack", ...)`.
- Edge case — button id without recognized prefix: no crash, logged warning.
- Edge case — empty cache for the prefix: no crash, logged warning or silent no-op.
- Edge case — `prov-edit-0` clicked when `_items_caches["prov"]` is empty / not yet populated: explicit no-op rather than silent wrong-domain route.

**Verification:**
- Updated `test_settings_screen.py:1187-1210` pass.
- `grep -n '_items_cache[^s]' src/stupidex/screens/settings.py` returns no matches (the bare-list field is gone; only `_items_caches` dict remains).

---

## System-Wide Impact

- **Interaction graph:** U7 (post-write callback reuse) creates a new import `file_manipulation.py -> ast.py` — verify no import cycle. U6 (formatter consolidation) creates `ast.py -> _xml_utils.py -> file_manipulation.py` rewritten as `ast.py -> _xml_utils.py` only (no new cycle). U10 adds `client.py -> tools/skill.py` `reset_current_allowed_skills` call (already imports `set_current_allowed_skills`). U8 may change building lifecycle for delegate/skill tools.
- **Error propagation:** U7 surfaces previously-swallowed failures; error path now affects the agent's view of write results. U9 wraps all `file_manipulation.py` error returns in a consistent XML envelope — existing substring-matching tests (e.g., `disk on fire`) continue to pass because the substring is preserved inside the element text. U11 replaces silent cross-domain indexing with explicit no-op-on-missing-prefix.
- **State lifecycle risks:** U5 defers the shallow-vs-deep-copy bug but doesn't fix it — nested dataclasses remain shared between `_config` and `_original`; dirty-detection correctness is still subtly broken and tracked separately.
- **API surface parity:** U10's `reset_current_allowed_skills` is a new public-by-convention function on `tools/skill.py`; document its pairing with `set_current_allowed_skills`. U2's `qualify_model` is a new module-level helper in `llm/providers.py`; export it from `__init__.py` if the package exposes helpers.
- **Integration coverage:** Cross-layer scenarios: U10's `aclose()` path on the async generator should be exercised by a test that consumes partially then closes the generator explicitly. U11's prefix-routing should be tested end-to-end through `on_button_pressed` (not just the cache write).
- **Unchanged invariants:** `Message.to_storage_dict` / `from_storage_dict` shape (disk compat). `_history_to_api_messages` wire format. `_TOOLS_WITHOUT_TIMEOUT` policy (deferred P2-99 — not part of this batch). `_stream_task` control flow (deferred P2-100).

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| U7 import cycle (`file_manipulation.py -> ast.py`) | Verify `ast.py` doesn't import from `file_manipulation.py`. If it does, move `_trigger_post_write_callbacks` into a shared module (e.g., `tools/_post_write.py`). |
| U3 OptionPicker `●` glyph couples label pre-padding (line 1093 + strip at 1104) | Removing both sites at once eliminates the coupling. Verify all 4 picker openings produce identical labels before/after. |
| U4 deletes the `.mcp-list-item` CSS rule — verify no other widget uses it | `grep -n 'mcp-list-item' src/stupidex/` should return matches only in `settings.py:949` (writer) and `:663` (CSS rule). Delete both together. |
| U6 test churn — 3 test files assert exact `<edit_result ...>` XML strings | Consolidated formatter must emit byte-identical output for the same inputs. Run all 3 test files (`test_file_manipulation.py`, `test_ast_tools.py`, `test_streaming_messages.py:1062`) in one pass; if any assertion changes shape, investigate before continuing. |
| U11 test churn — 4 test sites at `test_settings_screen.py:1187-1210` set `_items_cache` directly | Mechanical update to `_items_caches["prov"] = [...]` / `_items_caches["mcp"] = [...]`. Pair each test update with a re-run. |
| U8 cache invalidation timing — `allowed_skills` argument changes might not invalidate cache | Cache key includes current `allowed_skills`; verify with a test that changes the argument and asserts builders re-run. |
| U10 generator-`aclose()` race — the `finally` block must run on both normal exhaustion and early close | Test both paths explicitly: normal consumption and `aclose()` mid-stream. |
| U9 `_cdata_text` vs `escape` discipline — verify existing `_cdata_text` helper exists; if only `escape` is imported, use `escape` for element text | Check `file_manipulation.py:12` imports; use whichever helper ast.py's `<ast_error>` uses for consistency. |

---

## Documentation / Operational Notes

- No user-facing behavior changes. No migration. No feature flags.
- After U1 ships, downstream typing work can reference `ChatMessage` / `ToolCall` TypedDicts.
- After U2 ships, new model-qualification call sites use `qualify_model(provider, model_id)` from `llm.providers`.
- After U10 ships, any new caller of `set_current_allowed_skills` should pair it with `reset_current_allowed_skills(token)` in a `try/finally`.
- After U11 ships, new screen pickers should pass a unique `action_prefix` to `_render_keyed_list` and read from `_items_caches[prefix]` in their button handlers.
- The latent deepcopy vs shallow-copy bug (U5) is tracked separately — see "Deferred to Follow-Up Work".

---

## Sources & References

- **Origin enumeration:** `todo-pendings-fixes.md` (Batch 8 cluster: lines 110-129, 144-154, 232-243)
- **Verification context:** Three `explore` subagent dispatches (tools/, llm/, screens/) on 2026-06-21
- **Prior decisions:** `docs/plans/2026-06-21-004-fix-p2-streaming-tool-call-batch-1-plan.md` (P2-19 WONTFIX rule on dict pass-through design)
- Related code: `src/stupidex/llm/client.py`, `src/stupidex/llm/providers.py`, `src/stupidex/tools/ast.py`, `src/stupidex/tools/file_manipulation.py`, `src/stupidex/tools/__init__.py`, `src/stupidex/tools/skill.py`, `src/stupidex/screens/settings.py`, `src/stupidex/screens/picker.py`
- Related PRs/issues: P2-62, P2-63, P2-65, P2-97, P2-101 (rolled into Deferred), P2-106, P2-107, P2-111, P2-201, P2-202, P2-204, P2-205 in `todo-pendings-fixes.md`
