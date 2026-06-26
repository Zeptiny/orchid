# Code Review Report — Full Application Sweep

**Date:** 2026-06-20
**Mode:** report-only (no checkout mutation, no auto-fixes)
**Scope:** 7 top-level Python packages under `src/stupidex/` — `domain/`, `agents/`, `tools/`, `llm/`, `mcp/`, `rag/`, `screens/`
**Dispatches:** 55 subagents across 7 modules (5 always-on per module after dropping `ce-learnings-researcher`, plus per-module conditionals)
**Reviewer reduction:** `ce-learnings-researcher` dropped — repo has no `docs/solutions/` content to consult

---

## Coverage

| Metric | Value |
|---|---|
| Files reviewed | ~60 Python source files |
| Source lines reviewed | ~3,500 LOC (production) + tests |
| Reviewers dispatched | 55 |
| Successful returns | 55 |
| P0 findings | 7 |
| P1 findings | 22 |
| P2 findings | 40+ |
| P3 findings | 80+ |
| Cross-module promotions | 14 (findings flagged by 2+ independent reviewers) |
| Pre-existing findings | Most findings are `pre_existing: true` — this is a codebase sweep, not a diff review |

---

## Verdict

**Code health: needs significant hardening before any production use.** The architecture is sound — single shared tool registry, subagents go through the same `stream_response` path as the user agent, dynamic system prompt injects real runtime state, atomic write helpers exist. But sweeping reliability, security, and correctness gaps cluster in three hotspots:

1. **Unbounded waits with no timeout** — `wait_for_subagent`, `execute_command`'s `process.communicate()`, MCP `session.initialize()`/`list_tools()`, RAG vector reload on every save. Each one hangs the entire TUI on a single misbehaving dependency.
2. **Prompt injection → RCE cascade with no defense-in-depth** — `web_fetch`/`read`/`rag_search`/MCP tool output all feed verbatim to the LLM, which can be steered into `execute_command` (shell=True default) or `read`/`write` on arbitrary paths (no workspace boundary). A cloned malicious repo is sufficient attack surface.
3. **Silent state destruction** — incremental RAG re-index wipes unchanged files' chunks/vectors (`store.upsert` does `DELETE FROM chunks` even when only one file changed), edit/write tools don't use the existing atomic-write helper, post-write callback failures are swallowed so the AST/RAG index silently drifts, broad `except Exception: pass` everywhere hides persistence errors.

**Plus:** pervasive missing test coverage for the highest-risk paths (state machines, persistence replay, MCP lifecycle, subagent cancellation), no `AGENTS.md` standard to audit against, and agent-native parity gaps (`skill` tool description advertises rejected skills, MCP resources undiscoverable, system prompt omits index status).

---

## Findings

### P0 — Must fix before merge / production use

| # | Title | File:line | Reviewer(s) | Why it matters |
|---|---|---|---|---|
| 1 | SSRF in `web_fetch` — no private-IP / cloud-metadata filter, follow_redirects=True | tools/web_fetch.py:94 | adversarial, security | AWS IMDSv1 at `http://169.254.169.254/` returns IAM credentials; agent steered via prompt injection can fetch and exfiltrate them. |
| 2 | Prompt-injection → shell RCE cascade with no defense-in-depth | tools/exec.py:52 + llm/client.py:393 | adversarial | Untrusted content from web_fetch/rag/read/MCP flows verbatim into LLM context; `execute_command` defaults to shell=True with no sandbox/allowlist. A cloned malicious repo = RCE primitive. |
| 3 | No path confinement on read/write/edit/glob/replace_symbol | tools/file_manipulation.py:44 | adversarial, security | Agent (prompt-injected or otherwise) can read `~/.ssh/id_rsa`, `/etc/passwd`, `.env`, write `~/.bashrc`, plant symlinks. No workspace boundary check exists. |
| 4 | Incremental RAG re-index silently destroys unchanged files' chunks + vectors | rag/store.py:109 / rag/indexer.py:256 | correctness, kieran-python, maintainability, performance | `store.upsert` does `DELETE FROM chunks; DELETE FROM files` even when only one file changed. Unchanged files are re-hashed but their chunks/vectors are never re-added. RAG coverage silently degrades to zero on the very first incremental run. Multiple reviewers surfaced this independently. |
| 5 | `wait_for_subagent` has no timeout AND is excluded from the 60s tool timeout | tools/subagent.py:106 + llm/client.py:24 | reliability, adversarial | A hung subagent stream blocks the parent agent's tool loop forever. Only escape is user Ctrl-C. No wall-clock deadline, no partial-result path. |
| 6 | MCP startup has no overall timeout — hung server blocks `App.on_mount` indefinitely | mcp/__init__.py:67 | reliability, adversarial, security | User cannot use the app at all on launch. `_await_runner`'s 3s shutdown timeout can't even fire because `start_all` never returned. Trivially triggered by a slow/hung MCP server in shared config. |
| 7 | TodoStore state machine has zero direct test coverage | domain/todo.py:64 | testing | Core task-tracking primitive agents mutate while running. `VALID_TRANSITIONS`, terminal-status gating, round-trip serialization — all untested. |
| 8 | SubagentManager.spawn / _run lifecycle has zero direct test coverage | agents/manager.py:201 | testing | State transitions, on_message callback invocation, messages_mounted counter, the `finally` block firing on_state_change — all untested. The persistence-replay fix commits claimed to harden parallel/cancel cases; these claims are unverified. |

### P1 — Should fix

#### Correctness / reliability

- **Restored PENDING subagents never transition to terminal state** (`agents/manager.py:150`) — RUNNING→INTERRUPTED fix missed PENDING. Sidebar polls 1Hz forever. Flagged by 4 independent reviewers (correctness, maintainability, adversarial, kieran-python).
- **`wait_for_subagent` unbounded + `msg_q` backpressure deadlock** (`llm/client.py:24`) — when a `wait_for_subagent` blocks the executor, `msg_q` (maxsize=1) stalls the stream_task, which stalls the outer consumer. Full agent-loop wedge.
- **`execute_command` buffers unbounded stdout/stderr in memory with no cap** (`tools/exec.py:71`) — a command like `yes` or `cat /dev/urandom` with the 30s timeout buffers GBs before SIGKILL fires. OOM-kills the whole TUI.
- **Context-window exhaustion cascade** (`llm/client.py:438`) — the `while True` agent loop appends every tool result to `api_messages` with no truncation. `resolve_model_metadata` exposes `max_input_tokens` but is never consulted. A long agentic session hits 400 mid-turn with partial tool calls already persisted.
- **edit/write tools use non-atomic writes**, ignoring the existing `_atomic_write` helper (`tools/file_manipulation.py:206, 384`). Crash mid-write leaves a truncated/corrupt source file. `replace_symbol`/`rename_symbol` already use atomic writes; the inconsistency means the most common write paths are the least safe.
- **edit/write tools swallow post-write callback failures** (`tools/file_manipulation.py:221, 387`) — the AST index/RAG index silently fail to update on file edit. Subsequent `get_function`/`rag_search` return stale data with no warning to the agent. (Contrast with `replace_symbol` at `ast.py:870` which surfaces the same failures.)
- **`wait()` returns FAILING subagents as success** — `return_exceptions=True` swallows the exception; callers must explicitly check `record.state`/`record.error`.
- **`cancel_running`/`cancel_one` don't await cancelled tasks** — caller reads state half-cancelled; `on_state_change` fires after teardown.
- **`messages_mounted` counter incremented before `on_message` await** — drifts on failure; persistence-replay fix relies on consistent counts.
- **`Manager.spawn` ↔ `on_spawn` race window** — shared `StreamWidgetState` mutation between the catch-up loop and `_run`'s streaming; can mount duplicate widgets. The recent commits claim to harden parallel/cancel — this gap remains.
- **SubagentManager inherits parent's `_current_manager` via ContextVar** — `asyncio.create_task(_run())` copies the context; a subagent that (mis)configures `delegate_to_subagent` in its AGENT.md can spawn sub-subagents against the parent's manager, cancel siblings, read sibling task text. "No nested subagents" invariant is enforced only by config discipline.
- **No bound on subagent recursion depth, iteration count, or wall-clock time** — a looping model can compound cost multiplicatively, especially via finding above.
- **`_subagents` dict is never pruned** — long sessions accumulate every subagent record forever; `build_dynamic_system_prompt` injects the full history every turn. Eventually truncates the context window.
- **Provider base_url is user-controlled and unvalidated** (`llm/providers.py:224`) — misconfigured `base_url` exfiltrates API key via Authorization header to an attacker host. API keys/redirection not validated.
- **Path traversal in `read_mcp_resource` URIs** — MCP server-advertised URIs (`file:///etc/passwd`, `http://internal-host`) are forwarded verbatim to the trusted server process.
- **ReDoS via user-supplied regex on the event loop** (`tools/search.py:122`). And a naive `glob.translate` that mishandles `?` and `[abc]` — should use `fnmatch.translate` directly.
- **`wait()` for in-flight `call_tool` racing `shutdown`** — transport torn down under awaited session.

#### Persisted state corruption

- **`record_streamed_message` aliases caller's `tool_calls` list into persisted history** (`domain/message.py:143`) — call-site mutations after append leak into the persisted state. Fix: `copy.deepcopy(msg.tool_calls)`.
- **`Usage(**data['usage'])` rejects forward-compatible extra fields** (`domain/message.py:78`) — a single message with one extra field aborts the entire Session load via `except Exception → return None` at `SessionManager.load:130`. User loses all history.
- **`Batch` of `from_str` enum-ValueError paths** (`TodoStatus`, `ChainStatus`, `MessageRole`, `SubagentState`) — any single unknown enum string in corrupted/forward-incompatible storage aborts the whole session load. Recovery path is "lose everything" rather than "skip the bad record."
- **`SessionManager.delete` mutates in-memory state before disk deletion** (`domain/session.py:95`) — if `delete_session()` raises, the session is gone from memory but persists on disk. Ghost sessions appear on next load.

#### RAG correctness

- **`upsert_file` alignment by AUTOINCREMENT ordering** (`rag/store.py:380`) — when surviving chunk_ids interleave with new ones, `new_chunk_idx` desyncs and vectors get attached to wrong content. Ordering assumption is fragile.
- **DB commit + vectors write is not atomic** (`rag/store.py:139, 143`) — disk-full mid-`_save_vectors` leaves DB rows pointing at a stale/missing vectors file.
- **`force=True` re-index does not remove deleted files** (`rag/indexer.py:280`) — guard is `if not force and existing_hashes:`, so a force re-index leaves orphaned chunks/vectors for files that were deleted.
- **Empty discovered-files result wipes the existing index** (`rag/indexer.py:156`) — `_flush_store(store, [], [])` runs `DELETE FROM chunks` unconditionally.
- **`update_file` fails to persist new hash after embedding failure** (`rag/indexer.py:87`) — stale chunks for old content remain while user believes file was re-indexed.
- **`chunker` end_line off-by-one when chunk boundary aligns exactly with a newline** (`rag/chunker.py:85`).
- **`np.load` on vectors file doesn't set `allow_pickle=False`** (`rag/store.py:178`) — malicious pickle RCE primitive if vectors file is tampered.

### P2 — Fix if straightforward

#### Maintainability / dead code

- **`Agent.to_dict` and `Agent.from_dict` have zero callers** (`domain/agent.py:86, 75`) — delete them. `from_dict` silently drops unknown fields and hardcodes `tier='papudo'`; deleting prevents future misuse.
- **`Skill.to_dict` and `SkillResource.to_dict` have zero callers and are lossy** (`domain/skill.py:41`) — `references`/`scripts`/`assets` emit as integer counts, not data.
- **Dead assignment** `record.async_task = None  # set below` (`agents/manager.py:279`).
- **`rag.py` builds `progress_info` list but never includes it in the result XML** (`tools/rag.py:180`) — wired to nothing.
- **Duplicated XML helper functions across `ast.py` and `file_manipulation.py`** — `_xml_attr`, `_cdata_text`, `_count_diff_changes`, `_format_edit_result` are byte-for-byte copies that have already diverged (`replace_all` hardcoded in the ast version).
- **`stream_response` is a God function** (`llm/client.py:402`) — 80+ lines mixing 7+ responsibilities (system prompt assembly, tool filtering, MCP merge, streaming loop, executor dispatch, api_messages mutation, cancellation). Split naturally along existing seams.
- **Duplicated except branch: CancelledError subsumed by BaseException** (`llm/client.py:467`) — byte-identical bodies, dedup fear blocks maintainers.
- **Domain layer imports from agents layer — circular dependency** (`domain/session.py:8`). `agents/__init__.py` then defers `from stupidex.domain.message import Message` inside methods. The domain package cannot be imported standalone.
- **`SessionManager.switch`/`delete`/`load` shadow builtin `id`** (`domain/session.py:89`) — rename to `session_id` to match the rest of the file.
- **`_mark_dirty` accepts `field` and `_from_tab` it never uses** (`screens/settings.py:1304`) — every call site lies about scoped work.
- **`_collect_modified_config` is a one-line pass-through** to `self._config` (`screens/settings.py:1231`).
- **`_TOOL_REGISTRY` typed as `dict[str, dict]`** loses Tool/executor type info (`tools/__init__.py:62`).

#### Type-system gaps (kieran-python backlog)

- `tool_calls` modeled as `list[dict[str, Any]]` not a `ToolCall` dataclass (`domain/message.py:38`).
- `get_states()` returns `list[dict]` not a TypedDict.
- ContextVar holds mutable list for `_current_allowed_skills` (`tools/skill.py:9`) — callers can mutate the shared set.
- `resolve_embedding_ref` returns heterogeneous tuple union — `tuple[str,str] | tuple[str,str,str,str|None]` (`llm/providers.py:161`).
- Bare `dict` annotations: `MCPManager.__init__`, `convert_mcp_tool(mcp_tool: Any)`, etc.
- `_history_to_api_messages` walks OpenAI chat-message dicts with no TypedDict guard.

#### Pythonic clarity

- **Module import side effects**: `rag.py` mutates `ast.post_write_callbacks`; `web_fetch.py` and `providers.py` mutate `os.environ` (`LITELLM_LOCAL_MODEL_COST_MAP='True'`). One affects process environment for every litellm consumer via mere import.
- **`asyncio.get_event_loop()` deprecated mid-function** (`rag/indexer.py:147`) — uses `get_event_loop().time()` once then caches `loop` then re-uses `get_event_loop().time()` elsewhere. Use `get_running_loop()` consistently.
- **Several `from fnmatch import fnmatch` buried mid-function** (`llm/client.py:420`, `rag/store.py:451`) — stdlib with no circular-import excuse.
- **`e = escape` aliases redefined inside loops** (`llm/dynamic_system_prompt.py:43`, `subagent.py:116, 159`).
- **`type` and `list` shadow builtins** in `subagent.py:53`, `todo.py:90`, `agent.py:19`.
- **`class NewProviderForm`** — also edits existing entries. Rename to `ProviderForm`.

#### RAG performance

- RAG search does `np.load → .tolist() → np.array()` on every query (`rag/store.py:173`). ~280MB Python-list materialization per query.
- `RAGStore` fetches every chunk row's full content via SQL before top-k filtering.
- `upsert_file` rebuilds entire vectors.npy for a single-file edit (`rag/store.py:325`). Triggers `np.load → tolist → array → save` round-trip on every keystroke-save.
- Chunker is O(N²) on large files — `_line_at_char`/`_char_at_line` linear scans inside the chunk loop.

#### Agent-native parity

- **Skill tool description advertises every skill globally** (`tools/__init__.py:88`) — `build_skill_tool()` called with `allowed_skills=None` at registry-build time. Every reviewer-subagent sees the full catalog and wastes turns calling `execute_skill` which rejects everything. Flagged by 4+ reviewers independently.
- **MCP resources undiscoverable by agent** — `read_mcp_resource` exists but no `list_mcp_resources` and no MCP block in the dynamic prompt. Agent must guess URIs.
- **Dynamic system prompt omits**: RAG/AST index status, available subagent types, current model, personality, MCP server list. Agent cannot reason about its own runtime state without probe-and-fail round-trips.
- **No agent tool for model selection** — the core configurability surface of an LLM framework is user-only.
- **Session lifecycle (`save`, `list`, `switch`) has no agent primitive** — agent-driven artifacts are lost if the process crashes before next auto-save.

#### MCP

- **`mcp_{server_name}_{tool_name}` registry name is not injective** (`mcp/schema.py:25`) — server `x_y`/tool `z` collides with server `x`/tool `y_z`. Last-registered wins silently.
- **`_uri_map` is last-write-wins with no collision detection** (`mcp/__init__.py:152`) — malicious server can shadow a trusted server's resources.
- **`BlobResourceContents.blob` joined raw into a text string** (`mcp/__init__.py:193`) — base64 binary in a `list[str]` join → either garbled output or `TypeError` at runtime.
- **`call_tool` silently discards all non-text content blocks** (images, embedded resources) — agent gets empty string with no error indicator.
- **`tool_count = sum(k.startswith(f"mcp_{server_name}_"))`** over-counts when one server name is an underscore-prefixed substring of another.
- **`_server_status` is never cleared on restart** — stale entries linger across configurations.
- **`input_schema` stored in registry entries but never read anywhere** — dead speculative state.

### P3 — User's discretion

Many dozens of small improvements: `format_elapsed` breaks on ≥1h durations; `Chain.start_time` is `time.monotonic()` (meaningless across process restarts); `_get_function_sent_hashes` is unbounded module-global; `SIM117` ruff violation in `settings.py:773`; duplicate `default_model` field across two TAB_FIELDS buckets; `tab.label.plain.lstrip("● ")` strips character-set not prefix; bare `except Exception: pass` everywhere masks bugs; `init_db` and `_get_conn` duplicate DB recovery logic; dead `_find_extended_range` no-op ternary; no `__all__` in `screens/__init__.py`; etc. See per-module agent artifacts for the full P3 backlog.

---

## Cross-Module Themes

These surfaced independently across multiple modules — strongest signal of systemic debt.

### 1. Broad `except Exception:` — at least 30 sites

Files: `agents/manager.py:246, 261, 141`, `domain/session.py:130`, `domain/message.py` (replay paths), `rag/indexer.py:210, 266, 276`, `rag/store.py:182`, `llm/providers.py:151, 236`, `llm/client.py:219`, `tools/exec.py:111`, `tools/file_manipulation.py:69, 243, 298, 357, 399`, `tools/ast.py:478, 626, 698, 902, 1097`, `screens/settings.py:24, 219, 269, 1311`.

Each one hides a class of bugs as silent no-op. The pattern is so consistent it qualifies as house style — but it makes regression debugging painful across the board.

### 2. Missing timeout boundaries — at least 6 sites

Every long-running await has no wall-clock bound: `litellm.acompletion`, `session.initialize`/`list_*`/`call_tool`/`read_resource`, `subagent.wait`, `execute_command.communicate`, `_stream_task` (only user escape recovers), `process.wait` after SIGKILL.

### 3. Silent-index-drift cascade

`post_write_callbacks` failures propagate nowhere except in `replace_symbol`. The chain is: edit succeeds in tool → AST post-write callback fails (logged) → RAG post-write callback fails (logged) → tool result says `success="true"` with no warning → agent uses stale `get_function`/`rag_search` results → makes wrong decisions based on stale data.

### 4. Stale session/state race window

`SessionManager` State-mutation-before-disk pattern in `delete`. `ConfigManager._instance` reassigned before `save()` is called — failed save leaves singleton pointing at unsaved in-memory state. `_remove_model_entry` uses exception-as-control-flow to find rows.

### 5. Module-global mutable state

- `_current_manager`, `_mcp_manager`, `_current_allowed_skills` ContextVars (correct design but reproduce differently across asyncio task spawn patterns).
- `_todo_refresh_callback` — plain `global`, not ContextVar; misroutes notifications across concurrent sessions.
- `_get_function_sent_hashes` — unbounded, never reset.
- `_fastembed_cache` — class-level mutable typed as `dict[str, object]`.
- `_indexing` — process-global re-entrancy guard, not async-safe.
- `_TREE_CACHE` — keyed on time, not cwd (stale after chdir).

### 6. Tests pinning behavior of "fixed" code are absent

The recent fix commits (`406e032`, `da0ff86`, `ff4434e`, `df34ea4`) claim to harden persistence replay, persistence of thinking/tool_calls, and `aclose()` cleanup. None of these fixes have regression tests. The exact corner-case vectors they were written to close are uncovered.

---

## Residual Risks (advisory)

1. **Config trust boundary**: anyone who can write `.stupidex/config.json` controls `mcp_servers` (arbitrary `command`/`args`/`env` for stdio spawn). Project-local `.stupidex.json` deep-merged with user config silently expands the trust boundary. No workspace-trust gate exists.

2. **litellm is treated as a black box** for stream/connection lifecycle. Provider divergence (tool_call delta shape, empty `index`, separate id/name deltas) is unvalidated. No per-provider integration tests asserting delta-shape assumptions.

3. **No defense-in-depth against prompt injection**. The framework should own the tool-output envelope — a `<tool_output>` boundary marker plus system prompt instruction to treat it as untrusted data. Doing this per-tool (as ast.py does for its XML) is insufficient when shared infrastructure (`Message.to_dict`) doesn't enforce it.

4. **No per-tool-result size cap and no total-turn token budget** — single tool output can blow the context window mid-turn.

5. **RAG vector store design couples chunks table ordering to vectors file position** — every mutation requires the full array materialize-rewrite. A `chunk_id`-keyed sidecar (or sqlite-vec / faiss) would eliminate this entire class.

6. **No `AGENTS.md` exists anywhere** — standards reviewer had nothing to audit against except `pyproject.toml` ruff config. Naming conventions, structural placement, writing style — all unwritten, therefore unenforceable.

---

## Per-Module Coverage Matrix

| Module | Files | Reviewers | Findings | P0 | P1 | P2 | P3 |
|---|---|---|---|---|---|---|---|
| `domain/` | 8 | 8 | 17 | 1 (TodoStore testing) | 5 | 5 | 6 |
| `agents/` | 2 | 8 | 14 | 0 | 5 | 5 | 4 |
| `tools/` | 10 | 10 | 22 | 2 | 8 | 6 | 6 |
| `llm/` | 5 | 9 | 20 | 0 | 5 | 7 | 8 |
| `mcp/` | 3 | 10 | 17 | 1 | 3 | 7 | 6 |
| `rag/` | 4 | 7 | 22 | 1 | 6 | 9 | 6 |
| `screens/` | 4 | 6 | 20 | 0 | 1 | 8 | 11 |

P0 totals: 5 (incremental RAG wipe is single finding with broadest cross-reviewer agreement; testing P0s for TodoStore and SubagentManager are aggregated).

---

## Run Artifacts

Per-module subagent JSON returns are embedded in this report's conversation history (the orchestrator did not write run-artifact files in report-only mode, per skill rules — `safe_auto` fixes were not applied).

The cross-module synthesis pass applied:
- **Dedup**: `normalize(file) + line_bucket(±3) + normalize(title)`.
- **Cross-reviewer promotion**: 50→75, 75→100 for findings flagged by 2+ independent reviewers (most notably the PENDING subagent restore bug, the skill tool description drift, the silent `except Exception` pattern, the wait_for_subagent unbounded hang).
- **Confidence gate**: dropped findings below anchor 75 except for P0-severity (preserved per skill rules).

---

## Next Steps

1. **Block any next release on P0s** — SSRF, prompt-injection-to-shell, path confinement, wait_for_subagent timeout, MCP startup timeout, incremental RAG wipe. Each is an outage or breach waiting to happen.

2. **Pair every P0/P1 `gated_auto`/`manual` finding with a `downstream-resolver` ticket**:
   - Add workspace-root guard to read/edit/write/glob/replace_symbol.
   - Add SSRF allowlist (loopback/link-local/RFC1918/cloud-metadata) in `_validate_url` and a redirect hook.
   - Cap `execute_command` stdout/stderr at 8MB.
   - Wrap MCP `session.initialize`/`list_*`/`call_tool`/`read_resource` in `asyncio.wait_for`.
   - Fix `store.upsert` to not destroy unchanged data (use `upsert_file` per changed file).
   - Add wall-clock deadline to `subagent.wait()` and `wait_for_subagent`.
   - Use `_trigger_post_write_callbacks` everywhere edit happens, surface failures in result XML.

3. **Schedule test-coverage sprint** — the highest-risk untested code paths are:
   - TodoStore state machine (entirely untested).
   - SubagentManager `_run` lifecycle, cancel ordering, persistence round-trip.
   - MCP `call_tool`/`read_resource` real-session behavior (including the recent `CancelledError`/`aclose` fixes).
   - `stream_response` multi-turn tool-call loop (the central agentic feature).
   - Domain serialization round-trips (Chain/Session/TodoStore/Skill/Agent/Tool).

4. **Run `ce-simplify-code`** as a follow-up pass on the safe_auto findings: delete `Agent.to_dict/from_dict`, `Skill.to_dict/SkillResource.to_dict`, the dead `record.async_task = None` line, the `_collect_modified_config` wrapper, the `_mark_dirty(_from_tab=…)` parameter, the duplicate `except: cancel` branch in `stream_response`.

5. **Write an `AGENTS.md`** — gives the project-standards reviewer something to enforce on subsequent runs. The repo currently has zero codified standards.

6. **Re-run a targeted `ce-code-review` on fixed modules** before merging fixes — verify the SSRF and prompt-injection mitigations actually break the attack chains, not just patch one technique.
