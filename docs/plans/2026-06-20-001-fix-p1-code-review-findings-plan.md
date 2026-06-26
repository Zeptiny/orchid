---
title: "fix: Resolve P1 code-review findings across tools, agents, LLM, and MCP"
type: fix
status: active
date: 2026-06-20
origin: 2026-06-20-full-sweep-all-findings.md (project root)
deepened: 2026-06-20
---

# fix: Resolve P1 Code-Review Findings

## Summary

Fix 14 confirmed P1 code-review findings across the `tools/`, `agents/`, `llm/`, and `mcp/` modules. The work spans four clusters: isolated tool bugs (atomic writes, bounded exec output, ReDoS-protected grep, off-by-one line numbers, skill dependency false positives), two interrelated lifecycle/streaming clusters (agent state-machine + mount races; LLM tool-call delta parsing), and MCP hardening (registry shadowing, non-text block handling, blob UX). P1-12 (iteration cap), P1-17 (tier escalation), and P1-22 (workspace-trust RCE) are tracked separately in `README.md` and are out of scope here.

---

## Problem Frame

The 2026-06-20 full code-review sweep surfaced 53 P1 findings. Five were closed by the P0-5 stream idle-timeout work (P1-5/9/10/11) and three (P1-12/17/22) are deferred to README TODO. This plan addresses the remaining 14 confirmed issues. The findings fall into four risk groups:

1. **Isolated tool bugs** with clear, bounded fixes (P1-13/14/15/16/18)
2. **Two interrelated clusters** where findings share root cause and must be fixed together to avoid introducing regressions (agent lifecycle: P1-1/2/3; LLM streaming: P1-6/7/8)
3. **MCP hardening** with three related fixes in the same module (P1-19/20/21)
4. **Tool-output offload** — a non-trivial new behavior adapting the existing web_fetch pattern (P1-4)

---

## Requirements

- R1. No P1 finding in scope regresses after fix — each fix must include tests pinning the specific behavior the finding describes
- R2. Fixes must follow existing codebase patterns (atomic write via ast.py's pattern; output offload via web_fetch's pattern; config fields via existing `_ENV_MAP` convention)
- R3. New configuration fields (none currently anticipated beyond what P0-5/P0-6 added) must be env-overridable and documented in the Config dataclass
- R4. No new external dependencies — use stdlib (`asyncio`, `os`, `tempfile`, `fnmatch`) and existing imports only
- R5. All tests pass; ruff is clean across `src/` and `tests/`; new test files follow existing repo conventions (`pytest`, `unittest.IsolatedAsyncioTestCase` or top-level `async def`)

---

## Scope Boundaries

- P1-12 (agent loop iteration cap) — deferred to README TODO; needs `max_agent_turns` config + behavioral design
- P1-17 (subagent tier escalation) — deferred to README TODO; least-privilege enforcement design needed
- P1-22 (project MCP workspace-trust RCE) — deferred to README TODO; requires trust registry + UI modal
- P1-23 (SSE SSRF) — overlaps with P0-1 SSRF work; will be addressed when P0-1 is tackled
- P2/P3 findings — out of scope; triaged separately
- Refactoring tangential to the fixes (e.g., extracting a shared IO module) is deferred unless directly required by the fix

---

## Context & Research

### Relevant Code and Patterns

- `src/stupidex/tools/ast.py:222-251` — existing `_atomic_write` (temp + fsync + os.replace); the canonical pattern P1-14 reuses
- `src/stupidex/tools/web_fetch.py:168-232` — existing large-output cache pattern: write to `HOME_CONFIG_DIR / "cache" / "web-fetch" / <session> / <slug>.md`, return truncated `ExecutorResult` with file path + warning to LLM. `RAW_CONTENT_THRESHOLD = 10_000` (line 25)
- `src/stupidex/llm/client.py:470-492` — `_executor_task`, the single point where tool results are appended to `api_messages` (P1-4 fix point)
- `src/stupidex/llm/client.py:534-595` — outer `while True` agent re-submission loop; the streaming loop closure logic at 408-465 (P1-6/7/8 cluster)
- `src/stupidex/agents/manager.py:150-282` — `from_storage_dict`, `cancel_*`, and `spawn`/`_run`/`on_spawn` (P1-1/2/3 cluster)
- `src/stupidex/mcp/schema.py:25` and `src/stupidex/mcp/__init__.py:204-255` — registry + call_tool + read_resource (P1-19/20/21)
- `src/stupidex/config.py` — `_ENV_MAP` and `_validate_config` patterns from P0-5/P0-6 (no new fields needed for this plan)

### Institutional Learnings

- The P0-4 fix (per-file `upsert_file` replacing destructive batch) demonstrated the value of matching existing per-record patterns over batch operations — apply the same principle to atomic writes and bounded reads
- The P0-5 stream idle-timeout work added `_safe_aclose()` and exponential backoff + jitter — reuse the backoff helper pattern if any retry logic is needed

### Verification Evidence

All 14 findings were verified as CONFIRMED by subagent dispatch on 2026-06-20. Detailed evidence and fix plans from subagents inform the implementation units below. P1-21 was a partial false-positive (no TypeError; `blob` is `str` in this SDK), so its fix is UX-only.

---

## Key Technical Decisions

- **Atomic write sharing:** Promote `_atomic_write` from `tools/ast.py` to a shared location rather than duplicating. Chosen: keep in `ast.py` but import from `file_manipulation.py` (minimal churn, dependency already exists via `post_write_callbacks`). Alternative (move to `tools/_io.py`) deferred to reduce scope.
- **Tool output offload scope:** Apply the offload only at `_executor_task` (the api_messages append point), not also at `_history_to_api_messages`. Reason: with the guard at write time, persisted `Message` content is already bounded — no second pass needed.
- **Skip-set for offload:** `read`, `grep`, `glob`, `directory_tree`, `web_fetch` are exempt from offload (they already self-limit or have offset/limit knobs). Defining explicitly avoids circular "use read tool to read this" instructions.
- **MCP registry separator:** Replace `mcp_{server}_{tool}` with `mcp::{server}::{tool}` — `::` cannot appear in server names (regex `^[a-z0-9-]+$` forbids colons) and is unlikely in tool names. Defense-in-depth: also add a shadowing warning before dict assignment.
- **Agent mount lock:** Per-subagent `asyncio.Lock` in `SubagentUIManager` rather than per-message locks — both `on_spawn`'s replay and `_run`'s stream go through `on_message`, so a single lock guards all mounts.
- **LLM streaming dedup set for P1-6:** Add `enqueued_tool_calls: set[int]` rather than reworking the completeness model — preserves existing transition/end-of-stream semantics, just prevents re-enqueue.
- **No new config fields:** None of the in-scope fixes require user-tunable config. Thresholds use module-level constants (`_TOOL_OUTPUT_INLINE_THRESHOLD = 10_000`, `MAX_OUTPUT_BYTES = 1 * 1024 * 1024`, etc.), matching `web_fetch.py`'s `RAW_CONTENT_THRESHOLD` pattern.

---

## Open Questions

### Resolved During Planning

- **P1-21 severity:** Verified as false-positive on TypeError claim (`BlobResourceContents.blob` is `str` per installed MCP SDK, not `bytes`). Fix is UX-only: replace raw base64 dump with a placeholder marker. Lower priority than other MCP fixes.
- **P1-4 line number:** Finding cites `client.py:438` but that's `_stream_task`'s tool-call announcement. Actual unbounded append is at `_executor_task` lines 486-490; unguarded outer loop is line 534. Fix targets the append point.
- **P1-18 storage vs display:** `rename_symbol` at `ast.py:985` uses `s["start_line"]` as a 0-indexed array index into `lines = content.split("\n")`. Therefore the fix is **display-only** (`+1` at the `find_symbol_references` output formatter); storage stays 0-indexed to preserve `rename_symbol`'s semantics.

### Deferred to Implementation

- Exact chunk size for bounded exec reads (64KB suggested; tune during implementation)
- Whether to also bound `msg_q` (UI display) for large exec output, or keep UI full-content and only bound `api_messages` — recommendation is to bound both to avoid TUI memory bloat

---

## Implementation Units

- U1. **P1-18: Fix 0-indexed line numbers in find_symbol_references**

**Goal:** Make `find_symbol_references` report 1-indexed line numbers consistent with `get_file_skeleton` and `get_function`.

**Requirements:** R1

**Dependencies:** None

**Files:**
- Modify: `src/stupidex/tools/ast.py` (lines 678-680 area, the `execute_find_symbol_references` formatter)
- Test: `tests/test_ast_tools.py` (extend with line-number consistency test)

**Approach:**
- Add `+ 1` to `s["start_line"]` and `s["end_line"]` in the XML attribute formatting at the display boundary
- Do NOT change `src/stupidex/ast/parser.py` or the SQLite store — `rename_symbol` relies on 0-indexed storage for array indexing at `ast.py:985`
- Leave `start_column`/`end_column` unchanged (not reported by other tools; column convention is out of scope)

**Patterns to follow:**
- `ast.py:457,462` (`get_file_skeleton` does `line_num + 1`)
- `ast.py:568-569` (`get_function` does `start_point[0] + 1`)

**Test scenarios:**
- Happy path: parse a file with a known symbol at line N (1-indexed); assert `find_symbol_references` reports `start_line=N`, not `N-1`
- Consistency: assert `find_symbol_references` line numbers match `get_file_skeleton`'s reported lines for the same symbol
- Regression: `rename_symbol` still works correctly after the display-only change (existing rename tests pass unchanged)

**Verification:**
- `find_symbol_references` output line numbers are 1-indexed and consistent with other AST tools

---

- U2. **P1-16: Fix skill dependency cycle false-positive on diamond deps**

**Goal:** Allow diamond/shared transitive dependencies to resolve correctly while still detecting true cycles.

**Requirements:** R1

**Dependencies:** None

**Files:**
- Modify: `src/stupidex/tools/skill.py` (lines 31-62, `resolve_skill_dependencies`)
- Test: `tests/test_skill_tools.py` (extend with diamond-dependency test)

**Approach:**
- Separate "currently on recursion stack" (true cycle detection) from "already resolved" (dedup short-circuit)
- Add a `_stack: set[str] | None = None` parameter alongside `_visited`
- Use `_stack` for the cycle check at line 41-42; add `name` to `_stack` before recursing (line ~43), `stack.discard(name)` before returning
- Keep `_visited` (or rename to `_resolved`) only as a dedup short-circuit: if `name in _resolved`, return `[]` — do NOT raise
- The existing output dedup at line 58 (`ds.name not in [s.name for s in result]`) remains as a safety net

**Technical design (directional):**
```
resolve(name, registry, allowed, _stack=None, _resolved=None):
    if _stack is None: _stack = set()
    if _resolved is None: _resolved = set()
    if name in _stack: raise CircularDependency
    if name in _resolved: return []
    _stack.add(name)
    for dep in skill.requires:
        result += resolve(dep, ...)
    _stack.discard(name)
    _resolved.add(name)
    return result + [skill]
```

**Patterns to follow:**
- Standard topological-sort cycle detection (DFS with on-stack set)

**Test scenarios:**
- Happy path: A→[B,C], B→[D], C→[D] (diamond) resolves without raising; D appears once in output
- True cycle: A→B→A raises `ValueError("Circular dependency")`
- Self-dependency: A→A raises
- Linear chain: A→B→C→D resolves in dependency order (deepest first)
- Sibling sharing: A→[B,C], B→[D,E], C→[E] — E appears once, no false positive

**Verification:**
- Diamond dependencies resolve without raising; true cycles still raise

---

- U3. **P1-14: Atomic writes in file_manipulation tools**

**Goal:** Eliminate torn writes and TOCTOU windows in `execute_write_tool` and `execute_edit_tool` by reusing ast.py's `_atomic_write`.

**Requirements:** R1, R2

**Dependencies:** None

**Files:**
- Modify: `src/stupidex/tools/file_manipulation.py` (lines 206-207 edit write; lines 384-385 write tool)
- Modify: `src/stupidex/tools/ast.py` (export `atomic_write` as alias for `_atomic_write`, or make importable)
- Test: `tests/test_file_manipulation.py` (extend with atomic-write tests)

**Approach:**
- Export `_atomic_write` from `ast.py` as `atomic_write` (or import the private name directly — `file_manipulation.py` already imports from `stupidex.tools.ast`)
- In `execute_write_tool` (line 384): replace `aiofiles.open(path, "w") + f.write(content)` with `loop.run_in_executor(None, atomic_write, str(path), content)` — preserves async semantics matching the existing pattern at lines 289/334
- In `execute_edit_tool` (lines 206-207): same replacement for the write half
- Keep `aiofiles.open` for reads (line 44, line 166) — only the write path changes
- Fire `post_write_callbacks` after the atomic replace succeeds (existing behavior at lines 221-225, 387-391)
- `atomic_write` already preserves file mode bits and fsyncs the directory — strict improvement over current direct-write

**Patterns to follow:**
- `src/stupidex/tools/ast.py:222-251` (`_atomic_write` — temp + fsync + os.replace + chmod)

**Test scenarios:**
- Happy path: `execute_write_tool` writes content; file exists with correct content and original mode bits preserved
- Atomicity: simulate a crash mid-write (mock `os.replace` to raise); assert target file is unchanged (temp file is orphaned, target intact)
- Edit atomicity: `execute_edit_tool` on an existing file; concurrent read during write sees either old or new content, never partial
- Callback firing: `post_write_callbacks` fire after successful atomic write; if atomic write raises, callbacks do NOT fire
- Directory creation: `execute_write_tool` to a path with non-existent parent directories still creates them (existing `mkdir(parents=True, exist_ok=True)` preserved)

**Verification:**
- No `aiofiles.open(..., "w")` direct-write paths remain in `file_manipulation.py` (grep confirms)

---

- U4. **P1-13: Bounded exec output to prevent OOM**

**Goal:** Cap stdout/stderr from `execute_command` at a byte limit to prevent memory exhaustion from commands like `cat /dev/urandom` or `yes`.

**Requirements:** R1, R4

**Dependencies:** None

**Files:**
- Modify: `src/stupidex/tools/exec.py` (lines 70-83, replace `communicate()`)
- Test: `tests/test_exec.py` (new file, or extend if exists)

**Approach:**
- Add module-level `MAX_OUTPUT_BYTES = 1 * 1024 * 1024` (1MB total across stdout+stderr)
- Replace `process.communicate()` (line 72) with a helper `_read_bounded(process, timeout, max_bytes) -> tuple[bytes, bytes, bool]` that:
  - Schedules two reader coroutines: `process.stdout.read(65536)` and `process.stderr.read(65536)` in a loop
  - Accumulates into `bytearray` buffers; stops when combined size exceeds `max_bytes`
  - Returns `(stdout_bytes, stderr_bytes, truncated: bool)`
  - Wrapped in `asyncio.wait_for(..., timeout=timeout)` to preserve existing timeout semantics
- On `truncated=True`: append `"\n[output truncated at {MAX_OUTPUT_BYTES} bytes]"` to the decoded output (both returncode==0 and error branches at lines 85-109)
- On timeout or truncation: kill process group via existing `os.killpg(process.pid, signal.SIGKILL)` (lines 75-79) and `await process.wait()`
- Consider also bounding `msg_q` output (the `result_msg.content` that goes to UI) — recommendation: bound both UI and api_messages to avoid TUI memory bloat

**Patterns to follow:**
- `web_fetch.py`'s `RAW_CONTENT_THRESHOLD` constant pattern for the size cap

**Test scenarios:**
- Happy path: `execute_command("echo hello")` returns stdout="hello\n", not truncated
- Truncation: mock process producing 2MB of output; assert result is truncated at 1MB, contains "[output truncated]" suffix, process is killed
- Timeout: command sleeping longer than timeout; assert TimeoutError handling preserved, process killed
- Stderr only: command writing only to stderr; assert stderr captured and bounded independently or jointly
- Exit code: nonzero exit code path still reports returncode correctly after truncation
- Binary output: `execute_command("cat /dev/urandom")` does not OOM; truncated with note

**Verification:**
- `execute_command` with unbounded output does not exhaust memory; truncation note appears when threshold exceeded

---

- U5. **P1-15: Grep ReDoS protection and fnmatch translation**

**Goal:** Prevent catastrophic-backtracking regex from freezing the TUI, and fix naive glob→regex translation.

**Requirements:** R1, R4

**Dependencies:** None

**Files:**
- Modify: `src/stupidex/tools/search.py` (lines 64-65 regex compile; lines 89-91 glob translation; lines 111-126 search loop)
- Test: `tests/test_search.py` (new file or extend if exists)

**Approach:**
- Replace hand-rolled glob translation (lines 89-91: `.replace(".", r"\.").replace("*", ".*")`) with `fnmatch.translate(include_pattern)` — correctly handles `?`, `[abc]`, `[a-z]`, `[!abc]`, and escapes regex metacharacters
- Add `import fnmatch` at top of file
- Move the per-file `regex.search(line)` loop (lines 120-123) into a sync helper `_search_file_sync(path, regex, max_results)` and submit via `await asyncio.wait_for(loop.run_in_executor(None, _search_file_sync, ...), timeout=<per_file_timeout>)`
- Add a per-search aggregate deadline (e.g., 30s) via `asyncio.wait_for` over the `as_completed` loop, checked between completions
- Optional defense-in-depth: add a regex complexity guard (reject patterns with nested unbounded quantifiers like `(a+)+`) before `re.compile` — this is supplementary; the executor timeout is the real backstop

**Patterns to follow:**
- `ast.py`'s use of `loop.run_in_executor` for CPU-heavy work (if any precedent exists)

**Test scenarios:**
- Happy path: `execute_grep_tool("def ", ".")` returns matching lines with file paths
- ReDoS: pattern `(a+)+` against `"aaaaaaaaaaaaaaaaaaaab"` — does not freeze; completes within timeout or returns empty
- Invalid regex: malformed pattern raises `re.error` → handled as error result, not crash
- Glob translation: `include_pattern="*.py"` matches `foo.py` not `foo.txt`; `"?_test.py"` matches `a_test.py`; `"[abc].py"` matches `a.py` not `d.py`
- Max results: search returning >max_results truncates and does not leak running tasks (preserve existing early-break fix)
- Per-file timeout: a huge file does not dominate the budget; other files still searched

**Verification:**
- Catastrophic-backtracking regex does not freeze the TUI; glob patterns translate correctly via `fnmatch.translate`

---

- U6. **P1-20 + P1-21: MCP call_tool non-text blocks and read_resource blob UX**

**Goal:** Stop silently dropping non-text content blocks in `call_tool`; replace garbled base64 blob dump in `read_resource` with a readable placeholder.

**Requirements:** R1

**Dependencies:** None

**Files:**
- Modify: `src/stupidex/mcp/__init__.py` (lines 238 call_tool content join; lines 249-255 read_resource blob handling)
- Test: `tests/test_mcp_call_tool.py` (new) or extend `tests/test_mcp_startup_timeout.py`

**Approach:**
- **P1-20 (call_tool, line 238):** Partition `result.content` blocks by type. Text blocks join as before. Non-text blocks (image, embedded resource, audio) emit a placeholder marker like `[image: <mime>]` or `[embedded resource: <uri>]` into the text. Emit `logger.warning("MCP tool '%s' returned %d non-text blocks that were dropped", tool_name, dropped)` when any non-text block is present.
- **P1-21 (read_resource, lines 249-255):** Replace `parts.append(item.blob)` (raw base64 string) with `parts.append(f"[binary resource: {item.mimeType or 'application/octet-stream'}, {len(item.blob)} base64 chars]")`. Log at debug. This is a UX improvement only — the finding's TypeError claim was a false positive (`blob` is `str` in this SDK).

**Patterns to follow:**
- Existing `logger.warning` / `logger.debug` usage in `mcp/__init__.py`

**Test scenarios:**
- Happy path text: `call_tool` with text-only blocks returns joined text, no warning logged
- Mixed blocks: mock `session.call_tool` returning one text + one image + one embedded resource block; assert text present in content, placeholder markers present, warning logged, no exception
- All non-text: all image blocks → content contains placeholders, warning logged, no empty string
- Blob resource: `read_resource` with `BlobResourceContents` → returns readable placeholder, not raw base64
- Text resource: `read_resource` with `TextResourceContents` → returns text unchanged (regression)

**Verification:**
- Non-text blocks produce visible placeholders and warnings; blob resources show human-readable markers

---

- U7. **P1-19: MCP registry name injectivity**

**Goal:** Prevent silent tool shadowing from non-injective registry names.

**Requirements:** R1, R4

**Dependencies:** None

**Files:**
- Modify: `src/stupidex/mcp/schema.py` (line 25, `convert_mcp_tool` registry name)
- Modify: `src/stupidex/mcp/__init__.py` (line 204, shadow warning before assignment)
- Test: `tests/test_mcp_registry.py` (new)

**Approach:**
- Change registry name from `f"mcp_{server_name}_{tool_name}"` to `f"mcp::{server_name}::{tool.name}"` — `::` cannot appear in server names (regex `^[a-z0-9-]+$` forbids colons) and is rare in tool names
- Add shadow guard before `self._tools[registry_name] = ...` at line 204: `if registry_name in self._tools: logger.warning("MCP tool '%s' from server '%s' shadows existing registration", registry_name, server_name)`
- Defense-in-depth: in `_connect_server`, skip servers whose name fails `_MCP_SERVER_NAME_RE.match()` and log — this makes validation a hard gate rather than advisory

**Patterns to follow:**
- Existing `logger.warning` usage in `mcp/__init__.py`

**Test scenarios:**
- Happy path: two servers with distinct names register tools without collision
- Collision avoided: server="a_b" (invalid per regex) is skipped during `start_all`; server="a", tool="b_c" registers as `mcp::a::b_c`
- Shadow warning: forcing a duplicate registration logs a warning (mock the registry to allow direct insertion)
- Registry round-trip: `mcp::server::tool` name can be parsed back to `(server, tool)` by splitting on `::`

**Verification:**
- No two distinct server/tool combinations produce the same registry name; shadowing attempts log warnings

---

- U8. **P1-4: Tool output offload to file for large results**

**Goal:** Prevent context-window exhaustion from large tool outputs by writing them to a cache file and sending a truncated summary + file path to the LLM.

**Requirements:** R1, R2

**Dependencies:** U4 (exec bounded output) — partial overlap; both bound tool output. U4 bounds exec specifically; U8 bounds all tools generically at the api_messages append point.

**Files:**
- Modify: `src/stupidex/llm/client.py` (lines 470-492 `_executor_task`, the api_messages append point; add helper near line 22-24)
- Test: `tests/test_tool_output_offload.py` (new)

**Approach:**
- Add constants near line 22-24: `_TOOL_OUTPUT_INLINE_THRESHOLD = 10_000` (mirror `web_fetch.py`'s `RAW_CONTENT_THRESHOLD`); `_TOOL_OUTPUT_CACHE_DIR_NAME = "tool-output"`
- Define skip-set: `_TOOLS_WITHOUT_OUTPUT_OFFLOAD = {"read", "grep", "glob", "directory_tree", "web_fetch"}` — these already self-limit or have offset/limit knobs; offloading them would create circular "use read tool to read this" instructions
- Add helper `_maybe_offload_tool_output(tool_name: str, content: str, tool_call_id: str) -> str`:
  - If `len(content) <= threshold` OR tool in skip-set → return `content` unchanged
  - Else, require `get_current_session_id()` (import from `stupidex.domain.session`, matching `web_fetch.py:17`). If no session, hard-truncate to threshold with a `<warning>` (no file path)
  - Else, write to cache file under `HOME_CONFIG_DIR / "cache" / "tool-output" / <session_id> / <tool_name>_<tool_call_id_slug>.txt` (reuse `web_fetch.py`'s `_write_cache_file` pattern: `os.open` with `O_WRONLY|O_CREAT|O_TRUNC`, mode `0o600`, dir `0o700`)
  - Return substituted string: `<{tool_name}_result length={N} file="{path}"><warning>Output exceeded {threshold} characters and was written to {path}. Use read (with offset/limit) or grep to inspect.</warning></{tool_name}_result>`
- Wire in `_executor_task` between `_execute_tool` returning `result_msg` (line 483) and `api_messages.append(...)` (lines 486-490): replace `result_msg.content` with `trimmed = _maybe_offload_tool_output(tc["function"]["name"], result_msg.content, tc["id"])` and append `trimmed` to api_messages
- Keep `msg_q.put(result_msg)` (line 484) with full content so UI shows complete output (matching web_fetch's display vs content split) — OR bound both if implementation reveals UI memory issues
- Note: the finding cites line 438 but actual fix point is `_executor_task` lines 486-490

**Technical design (directional):**
```
_executor_task:
    tc = await ready_q.get()
    result_msg = await _execute_tool(tc, filtered_tools)
    await msg_q.put(result_msg)  # full content to UI
    await assistant_appended.wait()
    trimmed = _maybe_offload_tool_output(
        tc["function"]["name"], result_msg.content, tc["id"]
    )
    api_messages.append({
        "role": "tool",
        "tool_call_id": tc["id"],
        "content": trimmed,  # bounded
    })
```

**Patterns to follow:**
- `src/stupidex/tools/web_fetch.py:168-232` (`_write_cache_file`, `_raw_result` threshold + offload pattern)
- `src/stupidex/config.py`'s `HOME_CONFIG_DIR` for cache directory root

**Test scenarios:**
- Happy path small: tool returning 5KB content → api_messages gets full content, no cache file written
- Threshold exceeded: tool returning 50KB content → api_messages contains `<warning>` and file path, not the body; cache file exists with full body
- Skip-set: `read` tool returning 50KB → content passes through unchanged (no offload)
- No session: `get_current_session_id()` returns None → hard-truncate to threshold with `<warning>` (no file path, no crash)
- File write failure: mock `os.open` to raise → graceful degradation (fall back to hard-truncate with `<warning>`, no exception)
- `api_messages` integration: stub executor to return large output; assert next `litellm.acompletion` call (mocked) receives trimmed `api_messages`

**Verification:**
- Large tool output does not blow context; LLM receives truncated summary + file path instead of full payload

---

- U9. **P1-1 + P1-2 + P1-3: Agent lifecycle cluster (PENDING migration, cancel-on-no-task, mount lock)**

**Goal:** Fix the three interrelated agent lifecycle bugs that cause stuck subagents, divergent state, and message-mounting races.

**Requirements:** R1

**Dependencies:** None (can proceed in parallel with other units, but the three sub-fixes must land together)

**Files:**
- Modify: `src/stupidex/agents/manager.py` (lines 150-152 `from_storage_dict` migration; lines 173-199 `cancel_one`/`cancel_running`/`cancel_all`; lines 279-282 `spawn` scheduling; lines 233-262 `_run` message handling)
- Modify: `src/stupidex/widgets/subagent_ui.py` (lines 75-86 `on_message` shared `StreamWidgetState`; add per-subagent lock)
- Test: `tests/test_subagent_manager.py` (extend)
- Test: `tests/test_subagent_ui_race.py` (new, for mount race)

**Approach:**

**P1-1 (PENDING migration, `from_storage_dict` line 150):**
- Expand the migration: `if state in (SubagentState.PENDING, SubagentState.RUNNING): state = SubagentState.INTERRUPTED`
- Defensive: set `end_time = end_time or start_time or time.time()` for migrated records so `elapsed_seconds` resolves
- This ensures restored PENDING records become terminal → `_tick_timer` stops, `has_running` returns False

**P1-2 (cancel-on-no-task, `cancel_one`/`cancel_running`/`cancel_all` lines 173-199):**
- Decouple cancellation from task liveness — always transition state regardless of `async_task`:
  - Check `record.state in TERMINAL` → return False/[] (no-op)
  - Set `record.state = SubagentState.INTERRUPTED`
  - Set `record.error = record.error or "Interrupted by user"`
  - Set `record.end_time = record.end_time or time.time()`
  - If `task and not task.done(): task.cancel()`
  - Fire `on_state_change` callback if present
  - Return True / [ids]
- This handles: spawn-window PENDING (async_task=None), restored records (async_task=None), already-done tasks

**P1-3 (mount race, `spawn`/`_run`/`on_spawn` lines 279-282 + `subagent_ui.py:75-86`):**
- Add `self._mount_locks: dict[str, asyncio.Lock]` to `SubagentUIManager`
- In `on_message`, acquire `self._mount_locks.setdefault(subagent_id, asyncio.Lock())` before mounting — serializes `on_spawn` replay and `_run` stream callbacks
- Remove the shared-list aliasing in `StreamWidgetState` construction: copy `raw.get("temp")` into a new list rather than aliasing (defense-in-depth alongside the lock)
- Optional: replace the silent `except Exception: return` at `subagent_ui.py:67` with a debug log so future regressions surface
- Note: full elimination of the read-write race on `messages_mounted` counter requires awaiting `on_spawn` before scheduling `_run` — consider as follow-up if the lock alone doesn't fully resolve double-mounting in testing

**Technical design (directional, cancel_one):**
```
def cancel_one(self, subagent_id):
    record = self._subagents.get(subagent_id)
    if not record or record.state in TERMINAL:
        return False
    task = record.async_task
    record.state = SubagentState.INTERRUPTED
    record.error = record.error or "Interrupted by user"
    record.end_time = record.end_time or time.time()
    if task and not task.done():
        task.cancel()
    if record.on_state_change:
        _fire_and_forget(record.on_state_change(record.state))
    return True
```

**Patterns to follow:**
- Existing `TERMINAL` set usage in `subagent_ui.py:41-43`
- Existing `_fire_and_forget` pattern in `manager.py:32`

**Test scenarios:**
- P1-1: `from_storage_dict` with `{"state": "pending"}` → state is `INTERRUPTED`, `async_task` is None, `has_running` returns False
- P1-1: `from_storage_dict` with `{"state": "running"}` → state is `INTERRUPTED` (regression pin)
- P1-1: restored manager wired through `SubagentUIManager.has_running` → False → timer not armed
- P1-2: `cancel_one` on record with `async_task=None`, `state=PENDING` → returns True, state→INTERRUPTED, `end_time` set, `on_state_change` fired
- P1-2: `cancel_one` on terminal record → returns False, no mutation
- P1-2: `cancel_running` on restored records (async_task=None) → transitions to INTERRUPTED, returns their IDs
- P1-2: `cancel_one` on already-`.done()` task but state still PENDING → transitions, does NOT call `.cancel()` on finished task
- P1-3: `spawn` with fake `stream_response` yielding N messages → each message mounted exactly once (count `mount_streamed_message` calls), `messages_mounted == len(messages)`
- P1-3: two `on_message` coroutines for same subagent_id run concurrently via `asyncio.gather` → no `temp`-list corruption, stable final state
- P1-3: pane not yet mounted → message dropped with debug log (not silent)

**Verification:**
- Restored PENDING records become terminal; cancel always transitions state; no double-mounting under concurrent `on_spawn` + `_run`

---

- U10. **P1-6 + P1-7 + P1-8: LLM streaming tool-call parsing cluster**

**Goal:** Fix the three interrelated streaming bugs that cause duplicate tool execution, empty id/name commits, and content divergence.

**Requirements:** R1

**Dependencies:** None (independent of other units, but the three sub-fixes must land together to avoid introducing regressions)

**Files:**
- Modify: `src/stupidex/llm/client.py` (lines 377-386 `commit_assistant_with_tool_calls`; lines 408-465 streaming delta handling; lines 441-446 and 457-462 enqueue points)
- Test: `tests/test_streaming_messages.py` (extend)

**Approach:**

**P1-6 (interleaved requeue, lines 441-446 and 457-462):**
- Add `enqueued_tool_calls: set[int]` alongside `emitted_tool_calls` at the top of `_stream_task`
- In the transition branch (line 445) and end-of-stream branch (line 462), guard the `ready_q.put` with: `if prev_index not in enqueued_tool_calls: enqueued_tool_calls.add(prev_index); await ready_q.put(tool_calls[prev_index])`
- This preserves existing transition/end-of-stream semantics; only prevents re-enqueue of the same index

**P1-7 (empty id/name, `commit_assistant_with_tool_calls` lines 377-386):**
- Add validation at commit time: filter `tool_calls` to entries where `id` and `function.name` are non-empty before appending to `api_messages` and emitting the persisted `Message`
- If no entries survive the filter, fall back to the empty-assistant path already used in `_history_to_api_messages` (lines 184-190)
- At enqueue points (lines 445, 462), skip enqueuing a `tc` whose `id` or `function.name` is empty AND emit a diagnostic `MessageType.ERROR` `Message` so the user sees the malformed tool call rather than silently sending empties upstream

**P1-8 (content divergence, `commit_assistant_with_tool_calls` + content branch lines 408-415):**
- Hold a live mutable reference for content: after `commit_assistant_with_tool_calls`, keep `assistant_api_msg: dict | None` pointing to the last-appended assistant dict in `api_messages`
- In the content branch (line 408-415), after `content += delta.content`, if `assistant_api_msg` is not None, update `assistant_api_msg["content"] = content` — keeps api_messages in sync with accumulated content
- Stop emitting stacked TEXT messages post-commit: after `tool_calls_started.is_set()`, the content branch should update the committed assistant message rather than pushing a new TEXT per delta; emit the final TEXT once at end of stream (after `await flush_thinking()`, line 455)
- The persisted `Message` should reflect the final accumulated content — either via mutable holder or by upserting final content after stream completes

**Technical design (directional, P1-6 dedup):**
```
enqueued_tool_calls: set[int] = set()
...
if prev_index is not None and prev_index != tc_delta.index:
    await flush_thinking()
    if not tool_calls_started.is_set():
        await commit_assistant_with_tool_calls()
    if prev_index not in enqueued_tool_calls:
        enqueued_tool_calls.add(prev_index)
        await ready_q.put(tool_calls[prev_index])
```

**Patterns to follow:**
- Existing `emitted_tool_calls` set pattern (the announcement-side dedup already exists)

**Test scenarios:**
- P1-6: interleaved deltas `[idx0 args, idx1 id, idx0 args, idx1 args]` → `ready_q` receives each index exactly once; `api_messages` ends with one `tool` message per `tool_call_id`
- P1-6: monotonic indices `[idx0, idx0, idx1, idx1]` → each enqueued once (regression)
- P1-6: `_executor_task` invoked exactly `len(tool_calls)` times regardless of interleaving
- P1-7: first delta for an index omits `id` → committed assistant `tool_calls` contains only well-formed entries; empty-id entries filtered
- P1-7: stream ends with an index that never received `function.name` → no empty-id `tool` result appended; ERROR message yielded
- P1-7: strict provider payload (golden assertion) → `api_messages` assistant `tool_calls` entries all have non-empty `id` and `function.name`
- P1-8: stream `[content "A", tool_calls idx0 id+name, content "B", tool_calls idx0 args]` → final `api_messages` assistant entry has `content="AB"` (not `"A"`)
- P1-8: same stream → `_history_to_api_messages(recorded_messages) == api_messages` for that assistant turn
- P1-8: exactly one assistant TEXT message persisted per turn even when `delta.content` arrives after `delta.tool_calls`

**Verification:**
- Interleaved deltas don't cause re-execution; empty id/name filtered before provider submission; content stays in sync between api_messages and persisted history

---

## System-Wide Impact

- **Interaction graph:** U8 (tool output offload) touches the `_executor_task` → `api_messages` path that every tool result flows through; U9 (agent lifecycle) touches `SubagentUIManager` and `SubagentManager` used by all subagent spawns; U10 (LLM streaming) touches the central streaming loop that all agent turns pass through. Other units are more isolated.
- **Error propagation:** U4 (bounded exec) and U8 (offload) must degrade gracefully — on cache write failure, fall back to hard-truncate rather than crashing the agent turn. U9 cancel fixes must not raise on edge cases (None task, already-done task).
- **State lifecycle risks:** U9 PENDING migration (`from_storage_dict`) changes what state restored records have — any code checking `record.state == PENDING` after restore must be audited. U10 content-divergence fix changes when TEXT messages are emitted — `record_streamed_message` callers that expect per-delta TEXT must be verified.
- **API surface parity:** No external API changes. All fixes are internal to existing tool/manager/client methods.
- **Integration coverage:** U9 requires testing through `SubagentUIManager.has_running` (cross-layer: manager + UI widget + timer). U10 requires testing through the full `_stream_task` → `_executor_task` → `_history_to_api_messages` round-trip.
- **Unchanged invariants:** `rename_symbol`'s 0-indexed array indexing (U1 must not change storage). `web_fetch`'s own threshold/offload (U8 reuses the pattern but does not modify web_fetch itself). Existing `post_write_callbacks` firing order (U3 preserves).

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| U9 PENDING migration breaks code that checks `state == PENDING` after restore | Grep for `PENDING` checks across `src/`; audit each call site; the migration to INTERRUPTED is strictly safer (terminal state) |
| U10 content-divergence fix changes TEXT message emission timing | Test through `_history_to_api_messages` round-trip to verify persisted history matches api_messages |
| U8 offload creates cache files that accumulate over time | Follow web_fetch's existing cache directory pattern; cache cleanup is out of scope (matches web_fetch's current behavior) |
| U3 atomic write changes file mode handling | `atomic_write` already preserves mode bits via `os.chmod` after replace — verify with mode-preservation test |
| U10 dedup set (P1-6) might miss edge cases in provider delta ordering | Test with both monotonic (OpenAI-style) and interleaved (Anthropic-style) delta patterns |
| U9 mount lock might not fully resolve double-mounting if `on_spawn` and `_run` fire on different event loop ticks | Test with `asyncio.gather` to force concurrent execution; if lock alone insufficient, await `on_spawn` before scheduling `_run` |

---

## Documentation / Operational Notes

- No config changes (no new fields in `config.py`)
- No migration needed — existing sessions restore with INTERRUPTED state for PENDING records (U9 P1-1)
- Cache files from U8 (tool output offload) accumulate under `~/.stupidex/cache/tool-output/<session_id>/` — matches web_fetch's existing cache behavior; cleanup is out of scope
- The `tests/test_subagent_manager.py` (19 tests from P0-8) and `tests/test_streaming_messages.py` (existing) must continue to pass — they serve as regression guards for U9 and U10 respectively

---

## Sources & References

- **Origin document:** `2026-06-20-full-sweep-all-findings.md` (project root) — P1 section
- **Verification plans:** `docs/plans/2026-06-20-p0-verification-and-fix-plan.md` (P0 precedent for methodology)
- Related code: `src/stupidex/tools/ast.py:222-251` (`_atomic_write`), `src/stupidex/tools/web_fetch.py:168-232` (offload pattern), `src/stupidex/llm/client.py:470-492` (`_executor_task`), `src/stupidex/agents/manager.py:150-282` (lifecycle)
- Verification subagent reports: dispatched 2026-06-20, all findings CONFIRMED (P1-21 partial false-positive)
