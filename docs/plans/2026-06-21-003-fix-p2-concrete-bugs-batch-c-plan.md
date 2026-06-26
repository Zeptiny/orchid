---
title: "fix: P2 concrete bugs (Batch C)"
type: fix
status: active
date: 2026-06-21
origin: todo-pendings-fixes.md (P2-49, P2-89, P2-91, P2-141, P2-143, P2-144, P2-145, P2-166, P2-187, P2-188, P2-189 + SYSTEM-role mutation)
---

# fix: P2 concrete bugs (Batch C)

## Summary

Fix the 10 concrete bugs surfaced or pinned by the safe_auto + Batch A sweeps — XML attribute-injection in `format_subagent_attrs`, SYSTEM-role message mutation in `record_streamed_message`, empty-data swallow + IndexError in the RAG embedder, vector/content mismatch in `upsert_file`, chunker end_line off-by-one, hash-persistence gap in `update_file`, empty-discovery index wipe, stale directory-tree cache after `chdir`, and unescaped cwd/tree in the dynamic system prompt. Also verify 2 already-fixed screen rename bugs (P2-188, P2-189) and mark as duplicates of P1-53.

---

## Problem Frame

Three bugs were **pinned by characterization tests in Batch A** and escalated to this batch for production fixes:

1. **`format_subagent_attrs` doesn't escape `"`** (P2-49 BLOCKED): `xml.sax.saxutils.escape` escapes `<`, `>`, `&` by default but NOT `"`. Attribute values like `a"b` pass through verbatim, breaking the XML attribute boundary (`id="a"b"` → attribute value `a`, then garbage `b"`). In `dynamic_system_prompt.py` this XML is fed to the LLM inside `<subagent>` elements — a malicious subagent name, task, or ID containing `"` could inject attributes or break framing. Pinned at `tests/test_subagent_manager.py:807`.

2. **`record_streamed_message` SYSTEM+TEXT mutates prior assistant snapshot**: SYSTEM-role TEXT messages fall through to the `if msg.type == MessageType.TEXT:` branch — the cumulative-snapshot logic that overwrites `state.content.content` (the prior ASSISTANT message's content) with the SYSTEM message's content. The assistant message is silently corrupted. Pinned at `tests/test_message.py:342`.

3. **`embed_single` raises `IndexError` on empty provider response** (P2-187) + **`embed()` silently returns `[]` on empty `response.data`** (P2-166): `embed_single` does `results[0]` with no guard; `embed` returns `[]` on empty `response.data` without raising, failing silently. Pinned at `tests/test_rag_embedder.py:326` and `:339`.

The RAG correctness cluster (P2-141, P2-143, P2-144, P2-145) are data-integrity bugs in the indexing pipeline: vector/content mismatch when vectors.npy is stale, chunker line-number off-by-one at newline boundaries, hash-not-persisted after embedding failure (freezes re-index), and empty-discovery wiping the whole index.

The LLM prompt cluster (P2-89, P2-91) are injection-framing bugs: directory-tree cache keys on time not cwd (stale after `chdir`), and cwd + tree content injected raw into the system prompt without XML escaping (filenames with `<`, `>`, `&`, or `"` break framing).

The 2 screen-rename bugs (P2-188, P2-189) were already fixed by P1-53 — verification confirms the `_on_edit_provider_result` and `_on_edit_mcp_result` code at `settings.py:852-867` and `:978-993` already pops the stale old alias and rejects rename-to-existing. Mark as duplicates.

---

## Requirements

- R1. `format_subagent_attrs` MUST escape `"` in attribute values (alongside `<`, `>`, `&`).
- R2. `record_streamed_message` MUST append SYSTEM-role TEXT messages as distinct entries instead of mutating prior assistant message content; `state.content` tracking MUST NOT be affected by SYSTEM messages.
- R3. `embed()` MUST raise `EmbeddingError` when provider returns empty `response.data` instead of silently returning `[]`.
- R4. `embed_single` MUST raise a descriptive `EmbeddingError` (not bare `IndexError`) when the underlying `embed` returns an empty list.
- R5. `upsert_file` MUST correctly align new embeddings with their chunk_ids even when the existing vectors.npy is stale/missing — by querying only this file's new chunk_ids instead of iterating all chunk_ids.
- R6. Chunker `end_line` MUST be correct when a chunk boundary aligns exactly with a newline.
- R7. `update_file` MUST persist the new file hash even when embedding fails, so the file is not frozen out of future re-index attempts (investigate whether this is a real bug or false-positive; if false-positive, mark accordingly).
- R8. `_index_project_impl` MUST NOT wipe the existing index when `_discover_files` returns empty — just touch `last_indexed` and return.
- R9. `_TREE_CACHE` MUST key on `(cwd, expiry_time)` so a `chdir` within the TTL window produces a fresh tree.
- R10. `build_dynamic_system_prompt` MUST XML-escape `cwd` and `tree` content before interpolating into the system prompt XML.
- R11. Verify P2-188 and P2-189 are already fixed by P1-53; if confirmed, mark as duplicates.

---

## Scope Boundaries

- NO changes to `record_streamed_message` TOOL_CALL or TOOL_RESULT branches (only the SYSTEM+TEXT routing is fixed)
- NO changes to the `escape` function itself or other callers of `escape` outside `format_subagent_attrs`
- NO restructuring of `upsert_file` to use the batch path (P2-147, manual — separate batch); only fix the vector-alignment bug
- NO O(N²) chunker performance fix (P2-156, manual — separate batch)
- NO changes to `_get_all_chunks` typing (P2-174, manual)
- NO changes to `static_system_prompt.py` (P2-93/P3-48, advisory — separate concern)
- NO changes to TodoStore (P2-10, manual — different deserialization path)
- NO new dependencies (use stdlib `xml.sax.saxutils.escape` with custom entities dict for `"`)

### Deferred to Follow-Up Work

- RAG batching across files (P2-161): manual, requires pipeline restructure
- RAG search in-memory reload (P2-155): manual, requires ANN index
- `static_system_prompt.py` raw interpolation (P2-93/P3-48): advisory, separate module

---

## Context & Research

### Relevant Code and Patterns

- `src/stupidex/agents/manager.py:70-78` — `format_subagent_attrs` (uses `escape` without `"`)
- `src/stupidex/domain/message.py:117-170` — `record_streamed_message` (SYSTEM+TEXT falls through to TEXT branch)
- `src/stupidex/rag/embedder.py:42-63, 104, 128-130` — `embed` + `embed_single` (no empty-response guard)
- `src/stupidex/rag/store.py:351-417` — `upsert_file` vector rebuild (iterates ALL chunk_ids)
- `src/stupidex/rag/store.py:473-554` — `upsert_file_batch` (correct pattern: queries only file's chunk_ids)
- `src/stupidex/rag/chunker.py:88-91` — end_line calculation (off-by-one at newline boundary)
- `src/stupidex/rag/indexer.py:87-97` — `update_file` (early return on embedding failure skips hash persist)
- `src/stupidex/rag/indexer.py:156-163` — empty-discovery index wipe
- `src/stupidex/llm/dynamic_system_prompt.py:13-28` — `_TREE_CACHE` (keys on time only)
- `src/stupidex/llm/dynamic_system_prompt.py:30-36` — directory tree / cwd interpolated raw
- `src/stupidex/screens/settings.py:852-867, 978-993` — rename flow (already fixed by P1-53)
- `tests/test_message.py:325-399` — Batch A characterization tests pinning SYSTEM-role bug
- `tests/test_rag_embedder.py:312-350` — Batch A characterization tests pinning empty-response + embed_single bugs
- `tests/test_subagent_manager.py:793-818` — Batch A characterization tests pinning `"`-escaping bug

### Institutional Learnings

- Batch A pinned 3 bugs with characterization tests — each test must be UPDATED to assert the fixed behavior (not deleted; the old assertion becomes the new expected behavior).
- P2-166 (empty-data swallow) was characterized as "returns `[]` silently" in Batch A. The fix changes this to raise `EmbeddingError`, so the characterization test's premise changes.
- P2-187 (IndexError) was characterized as "raises IndexError". The fix wraps this as `EmbeddingError`.
- P2-188/P2-189 were flagged in the overview summary but the code at `settings.py:855-864` and `:981-990` already has the correct behavior (pop old alias, reject collision). P1-53 tests at `test_settings_screen.py:865` and `:951` cover both.

---

## Key Technical Decisions

- **`escape` with custom entities dict**: Use `xml.sax.saxutils.escape(s, entities={'"': '&quot;'})` to escape `"` in `format_subagent_attrs`. This is the documented stdlib approach for attribute-value escaping. Alternatively, `xml.sax.saxutils.quoteattr` wraps the value in quotes AND escapes — but `format_subagent_attrs` already wraps in quotes, so `escape` with entities is cleaner.
- **SYSTEM-role dedicated branch**: Add `if msg.role == MessageRole.SYSTEM:` before the TEXT branch in `record_streamed_message`. SYSTEM messages always append directly and reset stream state (same as USER messages). This is correct because SYSTEM messages never arrive as cumulative streaming snapshots — they're injected by the framework.
- **Empty-response raises EmbeddingError**: In `_embed_litellm`, after `response = await aembedding(...)`, check `if not response.data:` and raise `EmbeddingError("Embedding provider returned empty response data")`. This is a hard failure (provider is broken) not a retryable one, so it should raise immediately, not go through the retry loop. Place the check after the `return [item["embedding"]...]` line — if `response.data` is empty, the list comprehension returns `[]`, which is the silent-swallow bug. Check before the comprehension.
- **`embed_single` wraps IndexError**: Change `return results[0]` to check `if not results: raise EmbeddingError("Embedding returned no vectors")`. This is the defensive fallback in case `embed` returns `[]` despite the new check in `_embed_litellm` (e.g., the fastembed path could also return empty).
- **`upsert_file` uses `_chunk_ids_for_file`**: After the DB insert, call `self._chunk_ids_for_file(file_path)` (which already exists at store.py:462) to get ONLY this file's new chunk_ids. Zip with `embeddings` directly. For OTHER files' chunks, rebuild the vectors from `id_to_vec` (old vectors). This matches the `upsert_file_batch` pattern at store.py:525-535.
- **Chunker end_line investigation**: The current logic at `chunker.py:90-91` subtracts 1 from `end_char` when the next char is `\n`. The implementer should write a test with a file where a chunk boundary falls exactly on a `\n` and verify whether `end_line` is correct. If the line is wrong, fix the calculation. If it's already correct, mark P2-143 as false-positive.
- **Empty-discovery no-wipe**: Remove the `store.clear()` call at `indexer.py:159`. Just call `store.touch_last_indexed()` and return. An empty discovery result means no files to index — it does NOT mean "clear existing index."
- **Tree cache key on cwd**: Change `_TREE_CACHE: tuple[float, str] | None` to `_TREE_CACHE: tuple[str, float, str] | None` (cwd, expiry, tree). On cache check, compare both cwd and expiry.
- **Escape cwd and tree**: Use `xml.sax.saxutils.escape` on `cwd` and `tree` before interpolating into the system prompt XML. `escape` is already imported at `dynamic_system_prompt.py:5`.

---

## Open Questions

### Resolved During Planning

- **Should `format_subagent_attrs` use `quoteattr` instead of `escape`?** No — `quoteattr` adds its own surrounding quotes, which would conflict with the manual `id="..."` wrapping in the function. Use `escape` with `entities={'"': '&quot;'}`.
- **Should the empty-response check in `_embed_litellm` go through the retry loop?** No — an empty response.data is not a transient error (it's a provider bug/breakage). Raise immediately.
- **Are P2-188/P2-189 already fixed?** Yes — code review confirms `_on_edit_provider_result` (settings.py:855-864) pops `original_alias` and rejects collision; `_on_edit_mcp_result` (:981-990) has the same pattern. P1-53 tests cover both. Mark as duplicates.
- **Is P2-144 (hash persist on embedding failure) a real bug?** Investigation needed at implementation time. The current flow: embedding fails → return early → `update_file_hash` not called → DB retains old hash. If the file's content changed, the old hash != new content hash, so next `index_project` will re-index. If the content DIDN'T change, the old hash matches and the file is correctly skipped. The only degenerate case is if `upsert_file` was called successfully but `update_file_hash` failed — but `update_file` returns before `upsert_file` when embedding fails, so this doesn't apply. P2-144 may be a false-positive; investigate and mark accordingly.

### Deferred to Implementation

- **Exact end_line fix in chunker.py**: depends on reproducing the off-by-one with a specific test case. Implementer writes the test first to demonstrate the bug.
- **Whether to also escape `tree` in `dynamic_system_prompt.py` or just `cwd`**: escape both — directory/file names can contain `<`, `>`, `&`.

---

## Implementation Units

- U1. **`format_subagent_attrs` quote escaping (P2-49)**

**Goal:** Close the XML attribute-injection gap by escaping `"` in attribute values.

**Requirements:** R1

**Dependencies:** None

**Files:**
- Modify: `src/stupidex/agents/manager.py`
- Test: `tests/test_subagent_manager.py`

**Approach:**
- In `format_subagent_attrs`, change `e = escape` to `e = lambda s: escape(s, entities={'"': '&quot;'})` OR define a local `_attr_escape` function. Apply to all attribute values (id, name, type, state).
- Update the characterization test `test_quote_not_escaped_known_bug_documents_attribute_breakout` (line 807) to assert the FIXED behavior: `&quot;` IS present, `a"b` is NOT in the output (the raw `"` is escaped).

**Patterns to follow:**
- Existing `escape` usage in the same function

**Test scenarios:**
- **Happy path**: simple values without special chars; output unchanged.
- **Happy path**: values with `<`, `>`, `&`; still escaped (existing test at line 794 still passes).
- **Fixed path**: value with `"` (e.g., `a"b`); output contains `&quot;`, not the raw `"`; attribute boundary intact.
- **Edge case**: value is all `"` (e.g., `"""`); all three escaped to `&quot;&quot;&quot;`.
- **Integration**: `build_dynamic_system_prompt` with a subagent whose name contains `"` produces well-formed XML (no attribute breakout).

**Verification:**
- `python -m pytest tests/test_subagent_manager.py -q` all pass
- `python -m pytest tests/test_dynamic_system_prompt.py -q` all pass (no regression)

---

- U2. **SYSTEM-role message append (SYSTEM-mutation bug)**

**Goal:** SYSTEM+TEXT messages are appended as distinct entries, not mutated into prior assistant messages.

**Requirements:** R2

**Dependencies:** None

**Files:**
- Modify: `src/stupidex/domain/message.py`
- Test: `tests/test_message.py`

**Approach:**
- In `record_streamed_message`, add a dedicated `if msg.role == MessageRole.SYSTEM:` branch BEFORE the `if msg.type == MessageType.TEXT:` branch.
- SYSTEM messages (any type) should: append to history, reset `state.thinking = None` and `state.content = None`, return `True`.
- This matches the existing `if msg.role == MessageRole.USER:` branch pattern (which also appends directly + resets state).
- Update the characterization test `test_system_text_with_prior_assistant_mutates_existing_snapshot` (test_message.py:342) to assert the FIXED behavior: SYSTEM message is appended as a new entry, prior assistant message's content is UNCHANGED, `appended == True`, `len(history) == 2`.
- Update `test_system_non_text_type_hits_catch_all_and_appends` (line 360) if needed — with the new SYSTEM branch, SYSTEM+ERROR also goes through the SYSTEM branch (appends + resets), not the catch-all. The test should still pass (it asserts `appended == True` and `sys_err in history`), but the stream-state reset will be handled by the SYSTEM branch instead of the catch-all.

**Patterns to follow:**
- Existing `if msg.role == MessageRole.USER:` branch at message.py:138-142

**Test scenarios:**
- **Fixed path**: SYSTEM+TEXT with prior assistant; SYSTEM message appended as new entry; assistant content UNCHANGED; `appended == True`; `len(history) == 2`.
- **Happy path**: SYSTEM+TEXT with no prior state; message appended; `state.content is None` (SYSTEM doesn't anchor to stream state).
- **Happy path**: SYSTEM+ERROR; message appended; `state` reset.
- **Integration**: stream simulation with USER → ASSISTANT(TEXT) → SYSTEM(TEXT) → ASSISTANT(TEXT); each SYSTEM message is distinct in history; assistant snapshots are not corrupted.

**Verification:**
- `python -m pytest tests/test_message.py -q` all pass
- `python -m pytest tests/test_streaming_messages.py -q` all pass (no regression in stream behavior)

---

- U3. **Embedder empty-response + embed_single (P2-166, P2-187)**

**Goal:** Empty provider response raises `EmbeddingError` instead of silently returning `[]`; `embed_single` raises `EmbeddingError` instead of bare `IndexError`.

**Requirements:** R3, R4

**Dependencies:** None

**Files:**
- Modify: `src/stupidex/rag/embedder.py`
- Test: `tests/test_rag_embedder.py`

**Approach:**
- In `_embed_litellm`, after `response = await aembedding(...)`, before the list comprehension: check `if not response.data: raise EmbeddingError("Embedding provider returned empty response data for model: {model}")`. This is a hard failure outside the retry loop (provider is broken, retrying won't help).
- In `embed_single`, change `return results[0]` to: `if not results: raise EmbeddingError("Embedding returned no vectors for input text")` then `return results[0]`. This is the defensive fallback for ALL embed paths (litellm + fastembed).
- In `embed`, add a post-loop guard after all batches are processed: if `all_embeddings` is empty and `texts` was non-empty, raise `EmbeddingError`. (This covers the edge case where all batches return empty silently — now caught by the _embed_litellm check, but belt-and-suspenders for the fastembed path.)
- Update the characterization tests:
  - `test_litellm_empty_response_data_returns_empty_list` (test_rag_embedder.py:240): change to assert `EmbeddingError` is raised (not that `[]` is returned).
  - `test_empty_provider_raises_indexerror` (test_rag_embedder.py:339): change to assert `EmbeddingError` is raised (not `IndexError`).

**Patterns to follow:**
- Existing `EmbeddingError` usage and message format in `embedder.py`

**Test scenarios:**
- **Fixed path**: `_embed_litellm` with mock returning `response.data = []`; raises `EmbeddingError` with message mentioning empty response; does NOT go through retry loop (raises immediately).
- **Fixed path**: `embed_single` with embed returning `[]`; raises `EmbeddingError` (not `IndexError`).
- **Happy path**: `embed_single("text")` with normal embed returning `[vec]`; returns `vec`.
- **Happy path**: `embed(["text"])` with normal response; returns `[vec]`.
- **Edge case**: `embed([])` — still returns `[]` (empty input, existing short-circuit at embedder.py:43).

**Verification:**
- `python -m pytest tests/test_rag_embedder.py -q` all pass
- `python -m pytest tests/test_rag_indexer.py tests/test_rag_store.py -q` all pass (no regression)

---

- U4. **`upsert_file` vector alignment fix (P2-141)**

**Goal:** `upsert_file` correctly aligns new embeddings with chunk_ids even when vectors.npy is stale/missing.

**Requirements:** R5

**Dependencies:** None

**Files:**
- Modify: `src/stupidex/rag/store.py`
- Test: `tests/test_rag_store.py`

**Approach:**
- In `upsert_file`, after the DB insert, replace the `new_ids = self._get_ordered_chunk_ids()` + iteration logic with:
  1. Query `file_new_ids = self._chunk_ids_for_file(file_path)` (returns only this file's chunk_ids, ordered).
  2. Build the full vector list: iterate `self._get_ordered_chunk_ids()`, use `id_to_vec` for old chunk_ids, and for new file chunk_ids use `embeddings` in order (zip with `file_new_ids`).
- OR (simpler): after the insert, build `new_ids = self._get_ordered_chunk_ids()` and create a `file_new_id_set = set(file_new_ids)`. In the rebuild loop, when a chunk_id is in `file_new_id_set` (not in `id_to_vec`), pop from `embeddings` by index. This avoids iterating all IDs and guessing — the `file_new_id_set` tells us exactly which IDs are new for this file.
- Either approach matches the `upsert_file_batch` pattern at store.py:525-535 which queries `_chunk_ids_for_file` after the insert.

**Patterns to follow:**
- `upsert_file_batch` at store.py:525-535 (queries file's chunk_ids after insert, zips with embeddings)

**Test scenarios:**
- **Happy path**: single file, 3 chunks, 3 embeddings; vectors correctly aligned.
- **Happy path**: 2 files interleaved in DB; `upsert_file` for file A; file A's new vectors correctly aligned, file B's vectors preserved.
- **Fixed path**: stale vectors.npy (wrong length); `upsert_file` for file A; file A's embeddings correctly aligned with its chunk_ids (not assigned to file B's chunks).
- **Edge case**: file with 0 chunks (empty embeddings); no new vectors appended; other files' vectors preserved.
- **Integration**: sequential `upsert_file` calls for 2 different files; both files' vectors correct.

**Verification:**
- `python -m pytest tests/test_rag_store.py -q` all pass

---

- U5. **Chunker end_line off-by-one (P2-143)**

**Goal:** `end_line` is correct when a chunk boundary aligns exactly with a newline.

**Requirements:** R6

**Dependencies:** None

**Files:**
- Modify: `src/stupidex/rag/chunker.py`
- Test: `tests/test_rag_chunker.py`

**Approach:**
- Write a test that creates a file with known line structure and a chunk_size that causes the boundary to fall exactly on a `\n`. Assert `end_line` matches the expected line number.
- If the test fails (bug confirmed), fix the calculation at `chunker.py:90-91`.
- If the test passes (no bug), mark P2-143 as false-positive.
- The current logic: `end_char_for_line = end_char - 1 if end_char < total_chars and content[end_char] == '\n' else end_char`. This subtracts 1 when the next char is `\n` to avoid counting the newline as part of the next line. But `_line_at_char` returns the 0-indexed line containing the char; if `end_char - 1` is the last char BEFORE the newline, it's on the same line as the newline. So `end_line = _line_at_char(lines, end_char - 1) + 1` gives the line number of the chunk's last content line. This might be off by one if the chunk INCLUDES the newline.
- The fix (if needed): the adjustment depends on whether `end_char` is exclusive (points past the last char in the chunk) or inclusive. Looking at `chunk_text = content[char_pos:end_char]`, `end_char` is exclusive. So `content[end_char - 1]` is the last char in the chunk. If that's a `\n`, the chunk includes a trailing newline, and `end_line` should be the line OF that newline (which `_line_at_char(lines, end_char - 1)` returns). The current `-1` adjustment may be incorrect here.

**Patterns to follow:**
- Existing `_line_at_char` usage in the same function

**Test scenarios:**
- **Investigation test**: 3-line file `"abc\ndef\nghi"`, chunk_size=4 (boundary at `\n` after "abc"); assert `start_line=1`, `end_line=1` (chunk is `abc\n`, which is line 1).
- **Investigation test**: same file, chunk_size=8 (boundary at `\n` after "def"); assert chunk includes both newlines and `end_line=2`.
- **Happy path**: file with no trailing newline; `end_line` is the last line of the chunk.
- **Edge case**: single-line file shorter than chunk_size; `start_line=1`, `end_line=1`.
- **Edge case**: file where chunk boundary does NOT align with newline; `end_line` is approximate (break-point logic may shift it).

**Execution note:** Write the investigation test first to confirm or deny the bug before modifying the code.

**Verification:**
- `python -m pytest tests/test_rag_chunker.py -q` all pass

---

- U6. **`update_file` hash persistence (P2-144)**

**Goal:** Investigate whether the hash-persistence gap is a real bug; fix if confirmed, mark false-positive if not.

**Requirements:** R7

**Dependencies:** None

**Files:**
- Modify: `src/stupidex/rag/indexer.py` (only if bug confirmed)
- Test: `tests/test_rag_indexer.py`

**Approach:**
- Read `update_file` at indexer.py:75-97. The early return at line 93 (on embedding failure) skips `store.update_file_hash` at line 97. Investigate:
  1. Is the OLD hash still in the DB? Yes — `upsert_file` was not called, so `update_file_hash` is the only path that sets the real hash.
  2. Does the OLD hash match the current file content? No — the content changed (that's why `update_file` was called). So the hash mismatch will trigger re-index on next `index_project`.
  3. Conclusion: the file is NOT frozen out — next `index_project` will re-index because old_hash != new_content_hash.
- If investigation confirms this is a false-positive: add a test that demonstrates the file IS re-indexed after embedding failure (content changes → next `index_project` re-indexes), and mark P2-144 as false-positive.
- If investigation reveals a real bug (e.g., `upsert_file` IS called but `update_file_hash` fails): fix by persisting the hash in the `except` block or a `finally` block.

**Execution note:** Write investigation test first to determine if the bug is real.

**Test scenarios:**
- **Investigation test**: file indexed with hash="A"; content changes to hash="B"; `update_file` called but embedding fails; verify DB still has hash="A"; content on disk has hash="B"; next `index_project` run: `existing_hashes["file"] = "A"` vs `file_hash = "B"` → file IS re-indexed.
- If bug confirmed: **Fixed path** after fix, hash is persisted even on embedding failure.

**Verification:**
- If false-positive: mark P2-144 as `**[FALSE-POSITIVE — Batch C 2026-06-21: verified file is re-indexed because old hash doesn't match new content]**`
- If real bug: `python -m pytest tests/test_rag_indexer.py -q` all pass

---

- U7. **Empty-discovery no-wipe (P2-145)**

**Goal:** Empty discovered-files result no longer wipes the existing index.

**Requirements:** R8

**Dependencies:** None

**Files:**
- Modify: `src/stupidex/rag/indexer.py`
- Test: `tests/test_rag_indexer.py`

**Approach:**
- In `_index_project_impl`, at the `if not files:` block (indexer.py:156-163), remove the `store.clear()` and second `store.init_db()` calls. Replace with just:
  ```python
  if not files:
      store = RAGStore(project_path)
      store.init_db()
      await loop.run_in_executor(None, store.touch_last_indexed)
      stats.duration_seconds = asyncio.get_event_loop().time() - t0
      return stats
  ```
- The `store.clear()` was wiping chunks + vectors + files when discovery returned empty. This can happen when `paths` points to non-existent directories or all files match ignore patterns. The existing index should be preserved in this case.

**Patterns to follow:**
- `touch_last_indexed` already exists at store.py:338

**Test scenarios:**
- **Fixed path**: build an index with 3 files; re-run `index_project` with `paths=["/nonexistent"]`; existing chunks/vectors preserved; `last_indexed` updated.
- **Happy path**: `index_project` with `paths` pointing to valid files re-indexes normally (existing behavior).
- **Edge case**: first-ever `index_project` with empty paths; no error; empty index (no crash from the removal of `store.clear()`).

**Verification:**
- `python -m pytest tests/test_rag_indexer.py -q` all pass

---

- U8. **Dynamic system prompt cache keying + escaping (P2-89, P2-91)**

**Goal:** Directory-tree cache keys on `(cwd, expiry)`; cwd and tree content are XML-escaped before interpolation.

**Requirements:** R9, R10

**Dependencies:** U1 (U1 changes `format_subagent_attrs` which is called in this file — coordinate via sequential execution or the agent handles both)

**Files:**
- Modify: `src/stupidex/llm/dynamic_system_prompt.py`
- Test: `tests/test_dynamic_system_prompt.py`

**Approach:**
- Change `_TREE_CACHE: tuple[float, str] | None` to `_TREE_CACHE: tuple[str, float, str] | None` (cwd, expiry, tree).
- In the cache check: `if _TREE_CACHE and _TREE_CACHE[0] == cwd and _TREE_CACHE[1] > now:` → use cache. Else: regenerate `tree`, set `_TREE_CACHE = (cwd, now + _TREE_TTL, tree)`.
- XML-escape `cwd` and `tree` in the f-string at lines 30-36:
  ```python
  esc_cwd = escape(cwd)
  esc_tree = escape(tree)
  content = f"""...<working_directory>{esc_cwd}</working_directory>...<directory_structure>\n{esc_tree}\n</directory_structure>..."""
  ```
- `escape` is already imported at line 5.

**Patterns to follow:**
- Existing `escape` usage for subagent attrs and todos in the same file (lines 43-61)

**Test scenarios:**
- **Fixed path** (P2-89): first call sets cache with cwd="/a"; `os.chdir("/b")` → second call within TTL window: cache miss (cwd differs) → tree regenerated for "/b".
- **Happy path** (cache hit): two calls with same cwd within TTL → second call uses cache (tree not regenerated).
- **Fixed path** (P2-91): cwd containing `<` (e.g., `"/tmp/a<b>c"`); system prompt contains `&lt;` not raw `<`; XML framing intact.
- **Fixed path** (P2-91): directory tree containing a filename with `&` (e.g., `a&b.py`); system prompt contains `&amp;`.
- **Edge case**: cwd with `"`; escaped to `&quot;` in the XML.
- **Integration**: full `build_dynamic_system_prompt` with subagents + todos + tree + cwd; all values escaped.

**Verification:**
- `python -m pytest tests/test_dynamic_system_prompt.py -q` all pass

---

- U9. **Verify already-fixed screen rename bugs (P2-188, P2-189)**

**Goal:** Confirm P2-188 and P2-189 are already fixed by P1-53; mark as duplicates.

**Requirements:** R11

**Dependencies:** None

**Files:**
- Test: `tests/test_settings_screen.py` (add verification tests if coverage is insufficient)

**Approach:**
- Code review confirms:
  - `_on_edit_provider_result` at `settings.py:855-864`: pops `original_alias` on rename, rejects collision.
  - `_on_edit_mcp_result` at `settings.py:981-990`: same pattern for MCP servers.
- Existing tests at `test_settings_screen.py:865` (`test_rename_removes_old_alias_adds_new`) and `:951` (`test_rename_to_existing_name_rejected`) cover both.
- If test coverage is sufficient: mark as already-fixed without code changes.
- If test coverage is insufficient: add focused tests and mark.

**Test scenarios:**
- **Verification**: existing `test_rename_removes_old_alias_adds_new` passes (P2-188: stale entry removed).
- **Verification**: existing `test_rename_to_existing_alias_rejected` passes (P2-189: collision rejected).

**Verification:**
- `python -m pytest tests/test_settings_screen.py -q` all pass

---

## System-Wide Impact

- **Interaction graph:** `format_subagent_attrs` is called by `build_dynamic_system_prompt` (llm/dynamic_system_prompt.py:44). Escaping `"` there affects the dynamic system prompt XML which is fed to the LLM. `record_streamed_message` is called in `llm/client.py` (stream) and `agents/manager.py` (subagent stream). Adding SYSTEM branch changes message persistence behavior for any SYSTEM messages in the stream.
- **Error propagation:** `EmbeddingError` from empty-response will propagate through `embedder.embed` → `indexer.update_file` / `_index_project_impl` → already caught by existing `except Exception` at indexer.py:91/184. The error message will now be more descriptive.
- **State lifecycle risks:** `upsert_file` vector rebuild now uses `_chunk_ids_for_file` — this queries the DB after the insert, so chunk_ids are guaranteed to be the newly-inserted ones. No partial-write concern because the DB insert commits before the query.
- **Unchanged invariants:** `record_streamed_message` return signature unchanged (bool: whether appended). `filter_subagent_attrs` signature unchanged. `embed`/`embed_single` signatures unchanged. `_TREE_CACHE` is a module global (unchanged visibility).

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| SYSTEM-role branch changes message-list length for streams that include SYSTEM messages | Streams with SYSTEM messages were previously corrupted (content overwritten); the new behavior appends correct entries. Any test asserting `len(history)` for SYSTEM streams must be updated. |
| Empty-response raising `EmbeddingError` instead of returning `[]` changes caller behavior | Callers (`indexer.py`) already catch `Exception` around `embedder.embed()`; the new `EmbeddingError` is caught and logged. No behavior change in the indexer — it already fails gracefully on embedding errors. |
| Chunker fix may change `end_line` for existing test fixtures | Investigate first; only fix if test demonstrates the bug. Existing chunker tests must still pass. |
| `upsert_file` rebuild logic change could affect existing tests | Tests at `test_rag_store.py` cover `upsert_file` — must pass after the fix. The new approach uses existing `_chunk_ids_for_file` method, reducing risk. |
| U8 depends on U1 (same file calls `format_subagent_attrs`) | If dispatched to the same agent, no conflict. If different agents, U8 runs after U1. |

---

## Documentation / Operational Notes

- After Batch C lands, the 3 Batch A-pinned bugs are fixed. `todo-pendings-fixes.md` marks: P2-49 (BLOCKED → FIXED), SYSTEM-mutation (pinned → FIXED), P2-187 (pinned → FIXED), P2-166 (pinned → FIXED).
- P2-144 may be marked as FALSE-POSITIVE if investigation confirms the file is re-indexed.
- P2-143 may be marked as FALSE-POSITIVE if investigation confirms `end_line` is correct.
- P2-188 and P2-189 marked as duplicates of P1-53.

---

## Sources & References

- **Origin document:** `todo-pendings-fixes.md` (P2-49, P2-89, P2-91, P2-141, P2-143, P2-144, P2-145, P2-166, P2-187, P2-188, P2-189)
- **Batch A plan:** `docs/plans/2026-06-21-001-test-p2-testing-gaps-batch-a-plan.md` (3 bugs pinned)
- **Batch B plan:** `docs/plans/2026-06-21-002-fix-p2-persistence-replay-batch-b-plan.md` (persistence/replay robustness)
- Related code: `src/stupidex/agents/manager.py`, `src/stupidex/domain/message.py`, `src/stupidex/rag/embedder.py`, `src/stupidex/rag/store.py`, `src/stupidex/rag/chunker.py`, `src/stupidex/rag/indexer.py`, `src/stupidex/llm/dynamic_system_prompt.py`, `src/stupidex/screens/settings.py`
- Prior art: P1-53 (already fixed screen rename flow — `docs/plans/2026-06-20-002-fix-p1-testing-gaps-plan.md`)
