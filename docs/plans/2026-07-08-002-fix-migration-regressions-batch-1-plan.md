---
title: "fix: Migration Regressions Batch 1 — Token Usage, Logging, RAG Embedder, Tools, UI"
type: fix
status: active
date: 2026-07-08
origin: docs/code-review-reports/migration-review-python-to-electron.md
---

# Migration Regressions Batch 1

## Summary

Fix 22 regression items from the Python→Electron migration review, plus all critical items. The work spans 6 areas: token usage data path, session auto-naming, persistent logging, RAG embedder quality, tool enhancements (shell=false, file_pattern, validation, concurrency guards), and UI features (context grid, token sidebar, working directory, live command widgets, interrupt indicators, footer format, subagent tabs, personality system).

---

## Problem Frame

The Electron migration ported all 27 tools and core infrastructure, but left several data paths incomplete and UI features unported. The most critical issue is the RAG embedder using a hash-based tokenizer instead of proper BPE, which degrades retrieval quality. Token usage is tracked by the orchestrator but never reaches the renderer. Sessions don't auto-name. There's no file logging. Several tool features and UI elements from the Python TUI are missing.

---

## Requirements

- R1. Token usage flows from orchestrator → IPC → renderer → Footer display
- R2. Sessions auto-name after first exchange via LLM
- R3. Persistent file logging to `~/.orchid/logs/orchid.log`
- R4. RAG embedder uses proper BPE tokenizer instead of hash-based approximation
- R5. `execute_command` supports `shell=false` (exec without shell)
- R6. `rag_search` supports `file_pattern` glob filter
- R7. Tool argument validation before execution
- R8. Indexing concurrency guards on `/index-rag` and `/index-ast`
- R9. `interrupt_subagents` flushes state callbacks
- R10. Context breakdown grid (8x8 colored blocks) in sidebar
- R11. Token tracking sidebar with per-session totals
- R12. Working directory display in sidebar
- R13. Inline live command widgets in chat stream
- R14. Interrupt two-phase confirmation wired in renderer
- R15. Footer usage breakdown in compact ΣX · ↑Y format
- R16. Subagent tab panes in sidebar
- R17. Personality system ported
- R18. Per-chunk usage streaming (not just final emission)
- R19. Model metadata (max_input_tokens, supports_vision)
- R20. Model endpoint discovery in LLM pipeline
- R21. Skill tool builder filtering by allowed_skills (already done — verify)
- R22. Stream termination diagnostics

---

## Scope Boundaries

- Provider coverage expansion (250+ providers) — deferred, requires significant provider adapter work
- Full model picker with tabular display — deferred to separate plan
- ContextVar pattern for thread-safe state — not applicable to Node.js architecture
- Config-change restart — Electron has different lifecycle; deferred

### Deferred to Follow-Up Work

- Provider coverage expansion: `providers-factory.ts` needs adapter pattern for Bedrock, Vertex, Together, etc.
- Full `/model` command with tabular display and vision indicators
- Streaming message test suite (3,284 lines of Python tests)
- Background commands & PTY test suite (1,859 lines)

---

## Context & Research

### Relevant Code and Patterns

- `electron/src/main/llm/orchestrator.ts:186-277` — usage tracking, already accumulates `totalUsage` and yields `{ type: 'usage' }` at end
- `electron/src/main/ipc/chat.ts:200-257` — actor subscription, sends CHUNK/STATE/DONE/ERROR but ignores usage events
- `electron/src/renderer/hooks/useChat.ts:64-67` — TODO comment, `usage` state ready, Footer display ready
- `electron/src/renderer/components/Footer.tsx` — already renders usage when provided
- `electron/src/main/session/manager.ts` — `autoNameActive()` fully implemented, never triggered
- `electron/src/main/rag/embedder.ts:505-530` — `simpleTokenize()` hash-based tokenizer
- `electron/src/main/tools/process/execute-command.ts:197` — hardcoded `/bin/sh -c`
- `electron/src/main/tools/rag/search.ts` — missing `file_pattern` parameter
- `electron/src/main/agents/xstate/agent-machine.ts` — XState machine, stream callback ignores usage events
- `electron/src/shared/types/ipc.ts` — IPC channel definitions, needs `CHAT_USAGE` channel
- `electron/src/preload/index.ts` — channel allowlists, needs `CHAT_USAGE` added
- `src/orchid/app.py:729-792` — Python auto-naming implementation
- `src/orchid/main.py:10-35` — Python logging setup
- `src/orchid/widgets/sidebar.py:410-591` — Python context breakdown grid

### Institutional Learnings

- The migration review doc itself (`docs/code-review-reports/migration-review-python-to-electron.md`) is the authoritative source for all regressions

---

## Key Technical Decisions

- **Tokenizer**: Use `@huggingface/tokenizers` npm package for proper BPE tokenization matching the BGE-small model vocabulary. This is the official HuggingFace tokenizer library with Node.js bindings.
- **IPC pattern for usage**: Add `CHAT_USAGE` event channel alongside existing `CHAT_CHUNK`/`CHAT_DONE`. Forward usage from `onStepFinish` callback through the agent machine to IPC.
- **Auto-naming trigger**: Call `sessionManager.autoNameActive()` in the chat IPC handler after `CHAT_DONE` is sent, using the existing `GenerateTitleCallback` pattern.
- **File logging**: Use a simple `fs.appendFileSync`-based logger writing to `~/.orchid/logs/orchid.log`, matching Python's `FileHandler` pattern. No external dependency needed.
- **shell=false**: When `shell=false`, use `command.split(/\s+/)` for argument splitting (simpler than shlex, adequate for Node.js).
- **Context grid**: Port Python's 8x8 colored block grid using CSS grid with colored divs, computing token distribution across categories.
- **Personality system**: Port as a simple registry loading `.md` files from `~/.orchid/personalities/`, integrated into `system-prompt.ts`.

---

## Implementation Units

- U1. **Wire token usage data path**

**Goal:** Token usage flows from orchestrator through IPC to renderer and displays in Footer.

**Requirements:** R1

**Dependencies:** None

**Files:**
- Modify: `electron/src/shared/types/ipc.ts` — add `ChatUsageEvent` interface, `CHAT_USAGE` channel
- Modify: `electron/src/preload/index.ts` — add `CHAT_USAGE` to allowed event channels, add `onUsage` listener
- Modify: `electron/src/main/ipc/chat.ts` — forward usage events from agent machine context to renderer
- Modify: `electron/src/main/agents/xstate/agent-machine.ts` — track usage in context, emit USAGE event
- Modify: `electron/src/renderer/hooks/useChat.ts` — listen for `onUsage`, populate `usage` state, set on assistant message
- Modify: `electron/src/renderer/components/Footer.tsx` — enhance with compact ΣX · ↑Y format (merge with U15)

**Approach:**
- Agent machine context gains `usage: Usage | null` field
- Stream callback receives `{ type: 'usage' }` events and sends `USAGE` XState event
- On `USAGE` event, agent machine assigns usage to context
- Chat IPC subscribes to context changes, sends `CHAT_USAGE` event when usage changes
- `useChat.ts` listens via `onUsage`, updates `usage` state and sets it on the final assistant message
- Footer receives usage and renders compact format

**Test scenarios:**
- Happy path: Send a message, verify Footer shows prompt/cached/completion tokens after stream ends
- Edge case: Cancel mid-stream, verify partial or null usage is handled gracefully
- Integration: Verify usage persists on the assistant message object in the messages array

**Verification:**
- `window.orchid.chat.onUsage` callback fires with valid Usage object after a stream completes
- Footer renders ΣX · ↑Y (⟲Z) ↓W format

---

- U2. **Auto-name sessions after first exchange**

**Goal:** Sessions named "Session ..." get auto-named via LLM after the first assistant response.

**Requirements:** R2

**Dependencies:** U1 (usage must flow for clean stream completion)

**Files:**
- Modify: `electron/src/main/ipc/chat.ts` — call `autoNameActive()` after `CHAT_DONE` event
- Modify: `electron/src/main/session/manager.ts` — verify `autoNameActive()` works with injected callback
- Modify: `electron/src/main/ipc/session.ts` — ensure rename IPC sends update to renderer
- Test: `electron/tests/unit/session-auto-name.test.ts`

**Approach:**
- After the agent machine reaches `idle` state (stream complete), call `sessionManager.autoNameActive()` with a callback that uses the seed-tier model to generate a title
- The callback resolves the model, calls `streamChat` with a title-generation prompt, extracts the first line
- Non-fatal on failure (console.debug log)
- Session rename is sent to renderer via existing `session:rename` IPC

**Test scenarios:**
- Happy path: First exchange with "Session ..." name → name updates to a 3-6 word title
- Edge case: Session already renamed by user → no auto-naming attempted
- Error path: LLM call fails → session name unchanged, no error shown to user
- Integration: After auto-naming, session list in sidebar reflects new name

**Verification:**
- `sessionManager.autoNameActive()` called after each stream completion
- Session name changes from "Session ..." to LLM-generated title

---

- U3. **Persistent file logging**

**Goal:** All `console.*` calls are also written to `~/.orchid/logs/orchid.log`.

**Requirements:** R3

**Dependencies:** None

**Files:**
- Create: `electron/src/main/logging.ts` — file logger with rotation
- Modify: `electron/src/main/index.ts` — initialize logging at startup
- Test: `electron/tests/unit/file-logging.test.ts`

**Approach:**
- Create a `FileLogger` class that wraps `console.*` methods
- Writes to `~/.orchid/logs/orchid.log` with append
- Format: `YYYY-MM-DD HH:mm:ss LEVEL message`
- Log level controlled by `ORCHID_LOG_LEVEL` env var (default: INFO)
- Rotate when file exceeds 10MB (keep 1 backup)
- Override `console.log`, `console.warn`, `console.error`, `console.debug` to also write to file

**Test scenarios:**
- Happy path: Log message appears in file with correct format and level
- Edge case: Log directory doesn't exist → created automatically
- Error path: File write fails → original console call still works, no crash
- Integration: App startup logs appear in file

**Verification:**
- `~/.orchid/logs/orchid.log` exists after app startup
- Log entries match expected format

---

- U4. **Replace RAG embedder tokenizer with proper BPE**

**Goal:** RAG embedding quality matches Python's fastembed by using proper BPE tokenization.

**Requirements:** R4

**Dependencies:** None

**Files:**
- Modify: `electron/src/main/rag/embedder.ts` — replace `simpleTokenize()` with `@huggingface/tokenizers`
- Create: `electron/tests/unit/embedder-tokenizer.test.ts`

**Approach:**
- Install `@huggingface/tokenizers` npm package
- Load the BGE-small tokenizer from the model's `tokenizer.json` file (downloaded alongside the ONNX model)
- Replace `simpleTokenize()` with `tokenizer.encode(text)` which returns proper BPE token IDs
- Fall back to `simpleTokenize()` if tokenizer file is not found (graceful degradation)
- Cache the tokenizer instance for reuse

**Test scenarios:**
- Happy path: Same input text produces token IDs matching BGE-small's expected vocabulary
- Edge case: Tokenizer file not found → falls back to simpleTokenize with console warning
- Error path: Corrupt tokenizer file → falls back gracefully
- Integration: Embedding a query produces a vector that matches indexed chunks correctly

**Verification:**
- `simpleTokenize()` is no longer the primary tokenizer
- Token IDs are valid BPE tokens from the BGE vocabulary
- RAG search results quality matches Python implementation

---

- U5. **Add shell=false support to execute_command**

**Goal:** `execute_command` can run commands without shell interpretation when `shell=false`.

**Requirements:** R5

**Dependencies:** None

**Files:**
- Modify: `electron/src/main/tools/process/execute-command.ts` — add shell=false path using `spawn` with args array

**Approach:**
- When `shell=false`, split command on whitespace (`command.split(/\s+/)`) and use `spawn(args[0], args.slice(1), ...)` instead of `spawn('/bin/sh', ['-c', command], ...)`
- Reject `shell=false` with `background=true` (matching Python constraint)
- Keep existing `shell=true` path unchanged

**Test scenarios:**
- Happy path: `shell=false` with `echo hello` → spawns `echo` with arg `hello`
- Edge case: `shell=false` with `background=true` → returns error
- Error path: Command not found with `shell=false` → returns error message
- Integration: Tool schema includes `shell` parameter, LLM can set it

**Verification:**
- `spawn` called with parsed args array when `shell=false`
- Existing `shell=true` behavior unchanged

---

- U6. **Add file_pattern to rag_search**

**Goal:** `rag_search` tool accepts optional `file_pattern` to filter results by glob.

**Requirements:** R6

**Dependencies:** None

**Files:**
- Modify: `electron/src/main/tools/rag/search.ts` — add `file_pattern` to schema and handler
- Modify: `electron/src/main/rag/store.ts` — add file_pattern filter to `search()` method

**Approach:**
- Add `file_pattern: z.string().optional()` to `ragSearchSchema`
- Pass `file_pattern` to `store.search()` 
- In `RAGStore.search()`, filter results using `minimatch` on `filePath` before returning
- Use `minimatch` (already a dependency in the project) for glob matching

**Test scenarios:**
- Happy path: `file_pattern: "*.py"` returns only Python files
- Edge case: `file_pattern` omitted → all files returned (existing behavior)
- Error path: Invalid glob pattern → returns all results (graceful degradation)
- Integration: LLM can pass file_pattern to narrow search results

**Verification:**
- `rag_search` with `file_pattern: "*.ts"` returns only `.ts` file results
- Without file_pattern, all results returned as before

---

- U7. **Add tool argument validation before execution**

**Goal:** Tool arguments are validated against the tool's Zod schema before execution.

**Requirements:** R7

**Dependencies:** None

**Files:**
- Modify: `electron/src/main/tools/registry.ts` — add `validateArgs()` method
- Modify: `electron/src/main/ipc/chat.ts` — validate args in `createExecuteFn()`
- Test: `electron/tests/unit/tool-validation.test.ts`

**Approach:**
- Add `validate(toolName, args)` method to `ToolRegistry` that runs `tool.inputSchema.safeParse(args)`
- In `createExecuteFn()`, call `validate()` before `tool.handler()`
- On validation failure, return `{ content: "Invalid args: ...", isError: true }` without executing
- Matches Python's `_validate_tool_args()` behavior

**Test scenarios:**
- Happy path: Valid args → tool executes normally
- Edge case: Extra unknown args → returns validation error listing unknown params
- Error path: Missing required args → returns validation error listing missing params
- Integration: LLM sends malformed tool call → gets clear error message back

**Verification:**
- `ToolRegistry.validate()` catches schema violations
- Invalid tool calls return descriptive error messages

---

- U8. **Add indexing concurrency guards**

**Goal:** `/index-rag` and `/index-ast` commands reject if indexing is already in progress.

**Requirements:** R8

**Dependencies:** None

**Files:**
- Modify: `electron/src/main/rag/indexer.ts` — add `isIndexing()` guard
- Modify: `electron/src/main/ast/indexer.ts` — add `isIndexing()` guard
- Modify: `electron/src/main/ipc/rag.ts` — check guard before indexing
- Modify: `electron/src/main/ipc/ast.ts` — check guard before indexing

**Approach:**
- Add `_indexing: boolean` flag to each indexer module
- Set `true` at start of `indexProject()`, reset in `finally` block
- Export `isIndexing()` function
- In IPC handlers, check `isIndexing()` before calling index, return warning if already running

**Test scenarios:**
- Happy path: First indexing call proceeds normally
- Edge case: Second call while first is running → returns "already in progress" message
- Error path: First call fails → flag resets, next call can proceed
- Integration: RAG and AST indexing can run independently (separate flags)

**Verification:**
- Concurrent indexing calls are rejected with a warning message
- Flag resets after completion or failure

---

- U9. **Flush state callbacks on interrupt_subagents**

**Goal:** `interrupt_subagents` tool flushes pending state callbacks before cancelling.

**Requirements:** R9

**Dependencies:** None

**Files:**
- Modify: `electron/src/main/tools/subagent/interrupt.ts` — add callback flushing
- Modify: `electron/src/main/agents/manager.ts` — add `flushStateCallbacks()` method

**Approach:**
- Add `flushStateCallbacks()` to `SubagentManager` that resolves any pending state update promises
- In `interruptSubagents` handler, call `flushStateCallbacks()` before `cancelRunning()`
- Ensures clean state transitions when interrupting

**Test scenarios:**
- Happy path: Interrupt with pending callbacks → callbacks flushed, then subagents cancelled
- Edge case: No pending callbacks → flush is no-op, cancellation proceeds
- Integration: Interrupt during tool execution → clean state reset

**Verification:**
- `flushStateCallbacks()` called before `cancelRunning()`
- No dangling promises after interrupt

---

- U10. **Add context breakdown grid to sidebar**

**Goal:** Sidebar shows 8x8 colored block grid representing context token distribution.

**Requirements:** R10

**Dependencies:** U1 (token usage must flow for context data)

**Files:**
- Modify: `electron/src/renderer/components/Sidebar.tsx` — add context grid component
- Create: `electron/src/renderer/components/ContextGrid.tsx` — 8x8 colored blocks
- Modify: `electron/src/renderer/hooks/useChat.ts` — expose context breakdown data

**Approach:**
- Port Python's `_compute_context_tokens()` logic: estimate per-category tokens from character ratios
- Categories: free (green), system (blue), tools (purple), tool_use (amber), messages (violet)
- Render 8 rows × 8 cols of colored blocks using CSS grid
- Show legend with per-category token counts and percentages
- Update when usage data changes

**Test scenarios:**
- Happy path: Context grid renders with correct color distribution
- Edge case: No usage data → grid shows all gray blocks
- Integration: Grid updates when new usage data arrives mid-stream

**Verification:**
- 8×8 grid renders in sidebar with colored blocks
- Legend shows token counts per category

---

- U11. **Add token tracking sidebar section**

**Goal:** Sidebar shows per-session token totals with compact format.

**Requirements:** R11

**Dependencies:** U1

**Files:**
- Modify: `electron/src/renderer/components/Sidebar.tsx` — add token summary section

**Approach:**
- Display cumulative usage from all messages in current session
- Format: `Σ12.5k · ↑8.2k (⟲1.0k) ↓4.3k` matching Python's `_format_footer_usage_label()`
- Show below the session info in sidebar
- Update reactively as messages accumulate

**Test scenarios:**
- Happy path: After several exchanges, sidebar shows accumulated token counts
- Edge case: No messages → shows Σ0 · ↑0 ↓0
- Integration: Counts update after each stream completion

**Verification:**
- Token totals in sidebar match sum of all message usage objects

---

- U12. **Add working directory display in sidebar**

**Goal:** Sidebar shows current working directory.

**Requirements:** R12

**Dependencies:** None

**Files:**
- Modify: `electron/src/renderer/components/Sidebar.tsx` — add cwd display
- Modify: `electron/src/main/ipc/chat.ts` — include cwd in state events

**Approach:**
- Send `cwd` as part of `ChatStateEvent` or a new `CHAT_META` event
- Display in sidebar header or info section
- Update when directory changes (if applicable)

**Test scenarios:**
- Happy path: Sidebar shows current working directory
- Integration: Directory display matches `process.cwd()`

**Verification:**
- Working directory visible in sidebar

---

- U13. **Add inline live command widgets in chat**

**Goal:** Background commands show live output inline in the chat stream.

**Requirements:** R13

**Dependencies:** None

**Files:**
- Modify: `electron/src/renderer/components/MessageWidget.tsx` — render live command blocks
- Modify: `electron/src/renderer/components/ToolWidgets/TerminalWidget.tsx` — embed inline variant
- Modify: `electron/src/main/ipc/chat.ts` — forward background command output events

**Approach:**
- When a tool result contains a background command ID, render a collapsible terminal widget inline
- Use xterm.js `TerminalWidget` in a compact inline mode (not full ToolRail)
- Show command, exit code, and last N lines of output
- Throttle updates to 200ms (matching Python's `LiveCommandOutputWidget`)

**Test scenarios:**
- Happy path: Background command started → inline widget appears with output
- Edge case: Command finishes → widget shows exit code, stops updating
- Integration: Multiple background commands → each has its own inline widget

**Verification:**
- Live command output visible inline in chat message area
- Widget collapses/expands on click

---

- U14. **Wire interrupt two-phase confirmation in renderer**

**Goal:** Renderer shows interrupt state hints (Esc again: interrupt agent/subagents).

**Requirements:** R14

**Dependencies:** None

**Files:**
- Modify: `electron/src/renderer/components/Footer.tsx` — show interrupt hints
- Modify: `electron/src/renderer/hooks/useChat.ts` — track interrupt state
- Modify: `electron/src/shared/types/ipc.ts` — add interrupt state to ChatStateEvent
- Modify: `electron/src/main/ipc/chat.ts` — forward interrupt machine state

**Approach:**
- Add interrupt state to `ChatStateEvent`: `interruptState: 'idle' | 'confirmAgent' | 'confirmSubagents'`
- Renderer displays hint text in Footer: "Esc again: cancel agent" or "Esc again: cancel subagents"
- Auto-hides after 5s (matching Python's timeout)
- First Esc during streaming → show hint. Second Esc → cancel.

**Test scenarios:**
- Happy path: Press Esc during stream → hint appears in footer
- Edge case: Second Esc within 5s → cancels stream, hint disappears
- Error path: 5s timeout → hint disappears, state resets to idle
- Integration: Subagent running → Esc shows "cancel subagents" hint

**Verification:**
- Footer shows contextual interrupt hints
- Second Esc cancels as expected

---

- U15. **Enhance Footer with compact usage format**

**Goal:** Footer shows ΣX · ↑Y (⟲Z) ↓W format matching Python.

**Requirements:** R15

**Dependencies:** U1

**Files:**
- Modify: `electron/src/renderer/components/Footer.tsx` — compact format

**Approach:**
- Replace current label:value format with Python's compact `Σ12.5k (45%) · ↑8.2k (⟲1.0k) ↓4.3k`
- Include context percentage when `max_context` is available
- Keep elapsed time display during streaming

**Test scenarios:**
- Happy path: Footer shows `Σ12.5k · ↑8.2k (⟲1.0k) ↓4.3k`
- Edge case: No usage → shows only model name and elapsed

**Verification:**
- Footer format matches Python's `_format_footer_usage_label()` output

---

- U16. **Add subagent tab panes to sidebar**

**Goal:** Sidebar has dedicated subagent tab with live status for each subagent.

**Requirements:** R16

**Dependencies:** None

**Files:**
- Modify: `electron/src/renderer/components/Sidebar.tsx` — add subagent tab with panes
- Modify: `electron/src/renderer/hooks/useSubagents.ts` — expose per-subagent detail

**Approach:**
- Add a "Subagents" tab to the sidebar (alongside Sessions, Todos)
- Each subagent shows: name, type, tier, state (pending/running/completed/failed), elapsed time, task description
- Running subagents show a spinner/progress indicator
- Completed subagents show success/failure status
- Click to expand and see subagent's output summary

**Test scenarios:**
- Happy path: Subagent spawned → appears in sidebar tab with running state
- Edge case: Multiple subagents → each in its own pane
- Error path: Subagent fails → shows failed state with error info
- Integration: Subagent completes → state updates to completed, elapsed time stops

**Verification:**
- Subagent tab shows live status of all active and recently completed subagents
- States update in real-time

---

- U17. **Port personality system**

**Goal:** Personality system loads markdown files and appends to system prompt.

**Requirements:** R17

**Dependencies:** None

**Files:**
- Create: `electron/src/main/personality/registry.ts` — personality registry
- Create: `electron/src/main/personality/defaults/` — default personality files (default.md, meow.md, pirate.md, socrates.md, stupid.md, zen.md)
- Modify: `electron/src/main/llm/system-prompt.ts` — integrate personality into prompt
- Modify: `electron/src/main/ipc/chat.ts` — pass personality to system prompt builder
- Modify: `electron/src/renderer/components/CommandPalette.tsx` — add /personality command
- Test: `electron/tests/unit/personality.test.ts`

**Approach:**
- Load `.md` files from `~/.orchid/personalities/` (seed defaults on first run)
- `PersonalityRegistry` class with `load()`, `get()`, `list()`, `appendPersonality(prompt)` methods
- `appendPersonality()` appends `\n\n## Personality\n\n{text}\n` to system prompt
- `/personality` command in palette lets users switch active personality
- Config stores `personality` field (already exists in schema)

**Test scenarios:**
- Happy path: Default personality loaded, appended to system prompt
- Edge case: Custom personality file added → appears in list
- Error path: Personality file corrupt → falls back to default
- Integration: `/personality pirate` → system prompt includes pirate personality

**Verification:**
- `PersonalityRegistry` loads defaults and custom personalities
- System prompt includes personality text when configured

---

- U18. **Stream per-chunk usage events**

**Goal:** Usage is forwarded per-step, not just at stream end.

**Requirements:** R18

**Dependencies:** U1

**Files:**
- Modify: `electron/src/main/llm/orchestrator.ts` — yield usage per step
- Modify: `electron/src/main/agents/xstate/agent-machine.ts` — handle per-step usage

**Approach:**
- In `onStepFinish` callback, yield `{ type: 'usage', usage: stepUsage }` after each step (not just at end)
- Agent machine receives USAGE event per step, updates context
- IPC forwards each usage update to renderer
- Renderer accumulates and displays running total

**Test scenarios:**
- Happy path: Multi-step tool call → usage updates after each step
- Integration: Footer shows increasing token counts during multi-step execution

**Verification:**
- `CHAT_USAGE` events fire after each step, not just at stream end

---

- U19. **Add model metadata resolution**

**Goal:** Model metadata (max_input_tokens, supports_vision) available for UI display.

**Requirements:** R19

**Dependencies:** None

**Files:**
- Create: `electron/src/main/llm/model-metadata.ts` — metadata resolution
- Modify: `electron/src/main/config/schema.ts` — add model metadata fields to provider config
- Modify: `electron/src/shared/types/ipc-boundary.ts` — expose model metadata type

**Approach:**
- Create `ModelMetadata` interface with `max_input_tokens`, `max_output_tokens`, `supports_vision`, `mode`
- Default metadata for known models (GPT-4, Claude, Gemini, etc.)
- Merge: defaults → provider config overrides
- Cache by model ID
- Expose via config IPC for renderer display

**Test scenarios:**
- Happy path: Known model → returns correct metadata
- Edge case: Unknown model → returns defaults (null limits, no vision)
- Integration: `/model` command shows vision support indicator

**Verification:**
- `resolveModelMetadata()` returns correct data for known models
- Metadata available via config IPC

---

- U20. **Add model endpoint discovery to LLM pipeline**

**Goal:** Model discovery available in the LLM pipeline, not just onboarding.

**Requirements:** R20

**Dependencies:** U19

**Files:**
- Modify: `electron/src/main/llm/providers.ts` — add `discoverModels()` function
- Modify: `electron/src/main/ipc/config.ts` — add model discovery endpoint

**Approach:**
- `discoverModels(baseUrl, apiKey)` fetches `GET /models` from provider
- Cache results per provider alias (matching Python pattern)
- Respect `ORCHID_DISABLE_MODEL_DISCOVERY` env var
- Return empty list on failure (never throw)
- Expose via IPC for renderer model picker

**Test scenarios:**
- Happy path: Provider with /models endpoint → returns model list
- Edge case: Endpoint unreachable → returns empty list
- Integration: Model picker shows discovered models

**Verification:**
- `discoverModels()` returns model list from compatible providers
- Graceful failure when endpoint unavailable

---

- U21. **Verify skill tool builder filtering**

**Goal:** Confirm skill tool builder correctly filters by agent's allowed_skills.

**Requirements:** R21

**Dependencies:** None

**Files:**
- Verify: `electron/src/main/tools/skill/skill.ts` — already implements filtering
- Test: `electron/tests/unit/skill-tool-filtering.test.ts`

**Approach:**
- Verify existing implementation matches Python's `build_skill_tool(allowed_skills)` behavior
- If gaps found, fix them
- Add test coverage for filtering with glob patterns

**Test scenarios:**
- Happy path: Agent with `allowed_skills: ["debug", "commit"]` → skill tool lists only those
- Edge case: `allowed_skills: ["*"]` → all skills listed
- Integration: Different agents see different skill lists

**Verification:**
- Skill tool filtering works correctly per agent configuration

---

- U22. **Add stream termination diagnostics**

**Goal:** Log warnings when stream terminates abnormally (finish_reason='length', etc.).

**Requirements:** R22

**Dependencies:** U3

**Files:**
- Modify: `electron/src/main/llm/orchestrator.ts` — log finish reason diagnostics

**Approach:**
- After `yield { type: 'finish', finishReason }`, check for abnormal reasons
- `finish_reason === 'length'` → warn "Stream terminated due to max token limit"
- `finish_reason === 'content_filter'` → warn "Stream terminated by content filter"
- Log via structured logger (from U3)

**Test scenarios:**
- Happy path: Normal finish → no warning
- Edge case: finish_reason='length' → warning logged
- Integration: Warning appears in log file

**Verification:**
- Abnormal finish reasons produce console.warn/log messages

---

## System-Wide Impact

- **Interaction graph:** U1 (usage) feeds U10 (context grid), U11 (token sidebar), U15 (footer format), U18 (per-chunk usage). U3 (logging) feeds U22 (diagnostics). U4 (embedder) is isolated.
- **Error propagation:** IPC validation errors surface as `CHAT_ERROR` events. Tool validation errors return `isError: true` to the LLM.
- **State lifecycle risks:** Usage state must not leak across sessions. Auto-naming must not fire if session was already named. Indexing guards must reset on failure.
- **API surface parity:** New IPC channels (`CHAT_USAGE`) must be added to allowlists in preload.
- **Integration coverage:** Token usage flow spans orchestrator → agent machine → IPC → renderer — needs integration test.
- **Unchanged invariants:** All 27 tool definitions and handlers remain unchanged (except execute-command shell=false enhancement and rag_search file_pattern addition).

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `@huggingface/tokenizers` binary compatibility across platforms | Test on macOS/Linux/Windows; fall back to simpleTokenize |
| Auto-naming race condition with rapid session switching | Use session ID comparison, only name the active session |
| Context grid performance with frequent updates | Throttle to 500ms updates |
| xterm.js inline mode may conflict with full terminal | Use separate component instances, not shared singleton |

---

## Sources & References

- **Origin document:** `docs/code-review-reports/migration-review-python-to-electron.md`
- Python reference: `src/orchid/app.py`, `src/orchid/llm/client.py`, `src/orchid/main.py`
- Electron target: `electron/src/main/`, `electron/src/renderer/`, `electron/src/shared/`
- Related plans: `docs/plans/2026-07-08-001-feat-ts-electron-desktop-migration-plan.md`
