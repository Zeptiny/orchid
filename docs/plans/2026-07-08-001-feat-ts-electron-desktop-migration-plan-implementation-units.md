---
title: "Implementation Units — TS/Electron Desktop Migration"
companion: 2026-07-08-001-feat-ts-electron-desktop-migration-plan.md
---

# Implementation Units

Companion to the [main plan](2026-07-08-001-feat-ts-electron-desktop-migration-plan.md). 29 implementation units across 6 phases.

---

## Phase A: Foundation (U1-U2)

### U1. Project Scaffolding & Build Pipeline

**Goal:** Create the Electron + React + TypeScript monorepo with build tooling, linting, testing, and dev workflow.

**Requirements:** All (enables all subsequent units)

**Dependencies:** None

**Files:**
- Create: `electron/package.json`, `electron/tsconfig.json`, `electron/vite.config.ts`, `electron/electron-builder.yml`
- Create: `electron/src/main/index.ts` (placeholder entry)
- Create: `electron/src/renderer/App.tsx` (placeholder entry)
- Create: `electron/src/preload/index.ts` (placeholder bridge)
- Create: `electron/src/shared/types/index.ts`
- Create: `electron/tests/unit/.gitkeep`, `electron/tests/integration/.gitkeep`, `electron/tests/parity/.gitkeep`

**Approach:**
- `electron-vite` or manual Vite config for the renderer build. Main process uses `tsc` or `esbuild` for fast builds.
- `electron-builder` config in `electron-builder.yml`: appId, product name, mac/win/linux targets, directories.
- TypeScript strict mode (`strict: true`), ESNext target, `moduleResolution: bundler`.
- ESLint + Prettier matching the Python codebase's quality bar (ruff + pyright strict).
- Test framework: Vitest (fast, Vite-native) for unit tests. Playwright for E2E (future).
- Dependency list: `electron`, `electron-builder`, `electron-updater`, `xstate`, `ai`, `@ai-sdk/openai`, `@ai-sdk/openai-compatible`, `@modelcontextprotocol/sdk`, `zod`, `react`, `react-dom`, `@monaco-editor/react`, `xterm`, `xterm-addon-fit`, `better-sqlite3`, `onnxruntime-node`, `web-tree-sitter`, `electron-rebuild`, `vite`, `vitest`, `typescript`, `eslint`, `prettier`.
- Preload stub with `contextBridge.exposeInMainWorld('orchid', {})`.
- Main process stub creating a `BrowserWindow` loading the renderer.

**Test scenarios:**
- Happy path: `npm run dev` starts Electron with a blank window. App compiles without type errors. `npm run test` runs (empty suite passes).
- Edge case: `npm run build` produces a distributable package (placeholder app).

**Verification:**
- `npm run typecheck` passes (strict mode).
- `npm run lint` passes.
- `npm run dev` opens Electron window showing the placeholder React app.
- `npm run build` produces platform-specific distributable.

---

### U2. Foundation Patterns Spike — Go/No-Go Gate

**Goal:** Validate that the three foundation patterns (XState actors, AI SDK streamText + middleware, zod tool schemas) compose cleanly end-to-end: user message -> XState agent actor -> AI SDK streamText -> one tool call (zod schema validated) -> tool result feeds back -> stream continues -> final response renders in React. This is the **go/no-go gate**.

**Requirements:** R1, R2, R3 (foundation patterns)

**Dependencies:** U1

**Files:**
- Create: `electron/src/main/agents/xstate/spike-agent-machine.ts`
- Create: `electron/src/main/llm/middleware/spike-retry.ts`
- Create: `electron/src/main/tools/spike-tool.ts` (minimal zod-validated tool)
- Create: `electron/src/main/ipc/spike-chat.ts`
- Create: `electron/src/renderer/components/SpikeChat.tsx`
- Test: `electron/tests/integration/spike.test.ts`

**Approach:**
- Model the spike agent as an XState machine: `idle -> streaming -> tool_executing -> streaming -> idle`. Use `fromCallback` for LLM stream (push-based chunks to parent), `fromPromise` for tool execution.
- Wrap a real `streamText` call with one AI SDK middleware (retry). Validate that middleware can observe a "content delivered" flag and suppress retries after first token.
- Define one tool with a zod schema (`z.object({ query: z.string() })`). Validate: (a) schema produces valid JSON Schema via `z.toJSONSchema()`, (b) tool executes and result feeds back into stream loop, (c) `streamText` with `stopWhen: isStepCount(5)` handles multi-step tool calling.
- Test with a real LLM call (at least one OpenAI-compatible provider). Also test with at least one non-OpenAI provider to validate `@ai-sdk/openai-compatible`.
- Validate IPC: main process -> renderer streaming updates via `webContents.send`.

**Technical design:**

> *Directional guidance, not implementation specification.*

```
XState Agent Machine:
  states: { idle, streaming, toolExecuting, done, error }
  idle -> streaming: on USER_INPUT
  streaming -> toolExecuting: on TOOL_CALL (invoke tool via fromPromise)
  streaming -> idle: on STREAM_END (no tool calls)
  toolExecuting -> streaming: on TOOL_RESULT (feed result back)
  toolExecuting -> error: on TOOL_ERROR

  streaming state uses fromCallback:
    sendBack: { type: 'CHUNK', data } | { type: 'TOOL_CALL', toolCall } | { type: 'STREAM_END' }
    receive: { type: 'CANCEL' } -> abort stream
```

**Patterns to follow:**
- XState v5 `setup()` pattern for typed machines
- AI SDK `streamText` with `tools` (zod `inputSchema`) and `stopWhen`
- `wrapLanguageModel` with custom middleware

**Test scenarios:**
- Happy path: Send "What is 2+2?" -> agent streams text response -> no tool call -> response renders.
- Happy path with tool: Send "What files are in the current directory?" -> agent calls a minimal `list_files` tool -> tool result feeds back -> agent summarizes.
- Multi-step: Send "Find all TypeScript files and count them" -> agent calls `list_files` -> result -> agent calls `count` tool -> result -> agent responds.
- Error path: LLM returns rate limit error -> retry middleware retries transparently -> succeeds.
- Error path: Tool execution throws -> error surfaces to agent -> agent responds with error message.
- Interrupt: User sends cancel while streaming -> stream aborts -> agent state returns to idle.
- AI SDK middleware: After first token delivered, subsequent rate-limit errors do NOT cause a retry (content-delivered guard).

**Verification:**
- All test scenarios pass end-to-end with a real LLM provider.
- XState machine transitions are correct (inspected via actor snapshot).
- AI SDK middleware chain executes in correct order (logged).
- Zod schema produces valid JSON Schema that the LLM accepts.
- **GO/NO-GO decision**: If this unit fails (XState/AI SDK don't compose cleanly), stop and reopen R1/R2 before proceeding.

---

## Phase B: Core Infrastructure (U3-U7)

### U3. Config System

**Goal:** Port the configuration system with deep-merge of global and project configs, environment variable overrides, validation, and persistence.

**Requirements:** R8, R18

**Dependencies:** U1

**Files:**
- Create: `electron/src/main/config/loader.ts`, `electron/src/main/config/merge.ts`, `electron/src/main/config/validation.ts`, `electron/src/main/config/schema.ts`, `electron/src/main/config/index.ts`
- Test: `electron/tests/unit/config.test.ts`

**Approach:**
- Config type as zod schema (`ConfigSchema`). Single source of truth for TS types, JSON validation, env override casting.
- 3-layer merge: defaults -> `~/.orchid/config.json` -> `.orchid.json` (project-local). Then `ORCHID_`-prefixed env overrides.
- Deep-merge for `mcp_servers` and `providers` dicts (recursive per-alias merge). Scalars: project overrides home.
- `ConfigManager` singleton: `load()`, `save()`, `get()`, `reset()`. Atomic write (temp + fsync + replace, chmod 600).
- `ensure_home_config()`: creates `~/.orchid/` structure, seeds agents/skills/personalities, writes default config.
- All 22 config fields ported from Python `config.py` line 40-104.

**Test scenarios:**
- Default config loads with all fields populated.
- Deep merge: Home sets `default_model`, project overrides `ignored_dirs` -> merged correctly.
- Env override: `ORCHID_DEFAULT_MODEL=test/model` overrides file value. `ORCHID_COMMAND_TIMEOUT=60` casts to int.
- Validation: Empty `default_model` -> error. Negative `command_timeout` -> error.
- Persistence: `save()` + `load()` round-trips. Atomic write (no partial on crash).

**Verification:**
- Config loads identically to Python TUI for the same config files.

---

### U4. Domain Models

**Goal:** Port all domain models as TypeScript types with serialization (toStorageDict/fromStorageDict).

**Requirements:** R4, R5, R9

**Dependencies:** U1

**Files:**
- Create: `electron/src/shared/types/session.ts`, `chain.ts`, `message.ts`, `agent.ts`, `tool.ts`, `todo.ts`, `skill.ts`, `subagent.ts`, `index.ts`
- Test: `electron/tests/unit/domain.test.ts`

**Approach:**
- Each model: TypeScript interface + zod schema (for runtime validation on restore).
- Enums as const objects (not TS enums — more ergonomic for JSON serialization).
- `Message.toApiFormat()` replaces Python's `to_dict()` for OpenAI-shaped API messages.
- `toStorageDict()` / `fromStorageDict()` for each model with forward-compat for extra keys.
- `Chain.fromStorageDict()` runs orphan tool result reconciliation on restore.
- `SubagentRecord.fromStorageDict()` migrates PENDING/RUNNING -> INTERRUPTED on restore.
- `TodoStore` with state machine (`VALID_TRANSITIONS`), session-scoped.
- `Usage` dataclass with `prompt_tokens`, `completion_tokens`, `total_tokens`, `cached_tokens`.

**Test scenarios:**
- Create Session -> add Chain -> add Messages -> serialize -> deserialize -> identical.
- Chain orphans: TOOL_RESULT with no preceding assistant tool_calls -> dropped.
- Subagent restore: PENDING -> INTERRUPTED. RUNNING -> INTERRUPTED with preserved end_time.
- Todo: OPEN -> IN_PROGRESS -> DONE (valid). DONE -> IN_PROGRESS (invalid).
- Corrupted chain -> per-chain error isolation (other chains survive).

**Verification:**
- TypeScript types match Python domain models field-for-field.
- TypeScript types define the TS app's own session format (version 1 JSON). No backward-compatibility with Python TUI sessions required.

---

### U5. Session Persistence

**Goal:** Port session persistence (atomic JSON writes, list, delete, restore, auto-naming, switching).

**Requirements:** R9

**Dependencies:** U3, U4

**Files:**
- Create: `electron/src/main/session/storage.ts`, `electron/src/main/session/manager.ts`
- Test: `electron/tests/unit/session-persistence.test.ts`

**Approach:**
- `saveSession(data)` — atomic write (temp + fsync + replace + chmod 600).
- `loadSession(id)` — read + parse JSON + deserialize with error isolation.
- `listSavedSessions()` — partial read optimization (first 2048 bytes, regex extract id/name/model, fallback to full parse).
- `deleteSession(id)` — remove file + tool-output cache + web-fetch cache.
- `SessionManager`: `create()`, `switch(id)`, `delete(id)`, `rename(id, name)`, `changeModel(model)`, `saveActive()`, `load(id)`, `listSaved()`, `getActive()`.
- Auto-naming: After first exchange, if name starts with "Session ", use seed-tier model for 3-6 word title.
- Session switching: Running subagents NOT cancelled (matching Python). Background commands continue.

**Test scenarios:**
- Save -> load -> identical content.
- Atomic write: Simulate crash -> no partial file.
- List: Multiple sessions -> mtime order (newest first).
- Delete: File removed, caches cleaned.
- Auto-naming: Default name + first exchange -> descriptive title.
- Switching: In-flight subagents continue running.

---

### U6. Agent & Skill Loading

**Goal:** Port agent and skill loading from AGENT.md/SKILL.md frontmatter, registries, tier resolution, seeding.

**Requirements:** R5, R6

**Dependencies:** U3, U4

**Files:**
- Create: `electron/src/main/agents/registry.ts`, `electron/src/main/skills/registry.ts`, `electron/src/shared/utils/frontmatter.ts`
- Create: `electron/src/main/agents/defaults/` (AGENT.md files for all 26 agents)
- Create: `electron/src/main/skills/defaults/` (SKILL.md files for all 15 skills)
- Test: `electron/tests/unit/agent-skill-loading.test.ts`

**Approach:**
- Custom YAML frontmatter parser (no PyYAML dependency). Supports key-value and list syntax between `---` delimiters.
- `load_agents()`: Merge home (`~/.orchid/agents/`) overlaid by project (`.orchid/agents/`). Parse frontmatter (name, type, tier, description, allowed_tools, allowed_skills). Body = system_prompt.
- `load_skills()`: Same merge. Parse frontmatter (name, description, requires). Scan `scripts/`, `references/`, `assets/` subdirs.
- `seed_agents_dir()` / `seed_skills_dir()`: Copy defaults if not present.
- Tier resolution: `get_modelForTier(tier)` -> `config.tierModels[tier]` || `config.defaultModel`.
- Both `load_agents()` and `load_skills()` trigger `reset_tool_registry()`.

**Test scenarios:**
- Load all 26 agents -> correct tiers, types, tools.
- Load all 15 skills -> correct dependencies, resources.
- Merge: Home agent `general` with `['*']` tools. Project agent overrides -> project wins.
- Seeding: Empty dirs -> defaults copied. Existing -> not overwritten.
- Skill resources: `references/*.md` -> discovered with descriptions.

---

### U7. Zod Tool Registry Framework

**Goal:** Build the tool registration framework where each tool is defined by a zod schema (single source of truth for TS types, IPC validation, JSON Schema generation, MCP exposure).

**Requirements:** R3, R4

**Dependencies:** U1

**Files:**
- Create: `electron/src/main/tools/registry.ts`, `electron/src/main/tools/types.ts`, `electron/src/main/tools/index.ts`
- Test: `electron/tests/unit/tool-registry.test.ts`

**Approach:**
- `ToolDefinition`: `name`, `description`, `inputSchema` (zod), `outputSchema` (zod, optional), `actionLabel`, `category`, `noTimeout` (bool).
- `ToolRegistry`: `register(definition, handler)`, `get(name)`, `filter(allowedTools)` (glob matching via minimatch), `listAll()`, `toJsonSchema()` (via `z.toJSONSchema()`), `reset()`.
- Each tool directory exports `ToolDefinition` + async handler. Auto-registration via module exports.
- `filter()` uses glob matching (same as Python's `fnmatch`): `mcp::context7::*`, `*`, `read*`.
- `toJsonSchema()` converts zod input schema to JSON Schema for MCP exposure and LLM function-calling format.
- Shared schemas in `electron/src/shared/schemas/` for IPC validation (same zod schemas used by main and renderer).

**Test scenarios:**
- Register 3 tools -> `listAll()` returns 3. `get("read")` returns read tool.
- `filter(["read", "grep"])` -> only read and grep. `filter(["*"])` -> all.
- `filter(["mcp::context7::*"])` -> matches all context7 MCP tools.
- `toJsonSchema()` -> valid JSON Schema accepted by LLM.
- `reset()` clears registry -> next access rebuilds.

---

## Phase C: LLM & Agent Orchestration (U8-U12)

### U8. AI SDK Middleware Layer

**Goal:** Build the composable AI SDK middleware layer for streaming, retries, throttling, error classification, and provider quirks — replacing the 1175-line `llm/client.py` monolith.

**Requirements:** R2

**Dependencies:** U2, U3, U7

**Files:**
- Create: `electron/src/main/llm/middleware/retry.ts`, `throttle.ts`, `error-classification.ts`, `provider-quirks.ts`, `index.ts`
- Create: `electron/src/main/llm/stream.ts`, `electron/src/main/llm/providers.ts`, `electron/src/main/llm/system-prompt.ts`
- Test: `electron/tests/unit/llm-middleware.test.ts`

**Approach:**
- **Retry middleware**: Exponential backoff with jitter (`0.2 * 2^attempt + uniform(0, 0.2)`). Max retries from config. **Critical guard**: "no retry after content delivered" — once any token streamed, retries suppressed (replicating `client.py:1146-1171`).
- **Throttle middleware**: Minimum interval between thinking-content yields (0.1s equivalent).
- **Error classification**: Maps exceptions to user-facing `(title, detail)`. 13 branches covering auth, rate limit, timeout, connection, bad request, server errors (replicating `classify_error()`).
- **Provider quirks middleware**: Re-derives the following behavioral contracts against AI SDK's actual failure modes. These are NOT litellm-specific — they are provider-agnostic contracts any LLM client must implement:
  1. **Empty-choices IndexError**: Usage-only chunks with empty `choices` list must not crash the stream (Python: `_patch_litellm_raise_on_model_repetition`, lines 125-180).
  2. **MidStreamFallbackError detection**: Benign mid-stream errors (usage-only chunks) must continue, not terminate (Python: `_is_benign_midstream_litellm_error`, lines 185-215).
  3. **Tool output offloading**: Outputs >20KB written to cache files, replaced with pointer message (Python: `_maybe_offload_tool_output`, lines 251-307). Owned by U9.
  4. **THINKING replay**: THINKING messages replayed as assistant content, NOT as `reasoning` field (strict providers 400 on it) (Python: `_history_to_api_messages`, lines 360-377). Owned by U9.
- **Provider resolution**: `resolve_model_ref(alias/model)` -> AI SDK provider object. Map `litellm_provider` to AI SDK provider selection:
  - `openai` or no provider specified -> `@ai-sdk/openai` (direct) or `@ai-sdk/openai-compatible` (custom base_url)
  - `anthropic` -> `@ai-sdk/anthropic`
  - `google` / `gemini` -> `@ai-sdk/google`
  - `groq` -> `@ai-sdk/groq`
  - `xai` -> `@ai-sdk/xai`
  - Any other -> `@ai-sdk/openai-compatible` (assumes OpenAI-compatible API)
  - Note: The TS config does not need to use `litellm_provider` — use a new `provider` field or infer from `base_url`.
- **System prompt**: Static (OS info + instructions) + dynamic (time, cwd, directory tree, subagent states, todos, background commands).
- All middleware composable via `wrapLanguageModel({ model, middleware: [...] })`.

**Test scenarios:**
- Retry: Transient error -> retried with backoff. Second attempt succeeds.
- Retry guard: First token delivered -> transient error -> NOT retried.
- Error classification: RateLimitError -> ("Rate Limit Exceeded", "Too many requests"). All 13 branches covered.
- Provider quirks: Mid-stream empty-choices chunk -> stream continues (not truncated).
- Provider resolution: `work-openai/gpt-4o` -> correct base_url + api_key + model_id.

**Verification:**
- Retry behavior matches Python TUI (including "no retry after content delivered" guard).
- Error classification covers all 13 Python branches.

---

### U9. LLM Stream Orchestration

**Goal:** Build the LLM stream orchestration loop: tool dispatch, tool_call/tool_result pairing, output offloading, history conversion, multi-step agentic loop.

**Requirements:** R2, R4

**Dependencies:** U4, U7, U8

**Files:**
- Create: `electron/src/main/llm/history.ts`, `tool-dispatch.ts`, `orchestrator.ts`, `cleanup.ts`
- Test: `electron/tests/unit/llm-orchestrator.test.ts`

**Approach:**
- **History conversion**: Persisted messages to API messages. Bidirectional tool_call/tool_result pairing invariant: orphaned results dropped, dangling tool_calls filtered. THINKING replayed as assistant content (NOT `reasoning` field — strict providers 400 on it). (Replicates `client.py:310-399`.)
- **Tool dispatch**: Execute tool calls with 60s timeout (configurable). Certain tools exempt. Output offloading: >20KB written to `~/.orchid/cache/tool-output/<session_id>/<slug>.txt`. Certain tools exempt (read, grep, glob, etc.). (Replicates `client.py:251-307`.)
- **Orchestrator**: Main async generator. Builds system prompt + history + dynamic prompt. Filters tool registry by agent's `allowed_tools`. Includes MCP tools. Calls `streamText` with composed middleware. Processes chunks: thinking -> yield, content -> yield, tool_call -> dispatch -> result -> continue. `stopWhen` for multi-step. Token usage tracking.
- **Sequence guarantee**: Executor waits for assistant message commit before appending tool results to `apiMessages`.

**Test scenarios:**
- No tool calls -> text response yielded.
- Tool call -> tool executed -> result fed back -> stream continues.
- Multi-step: tool call -> result -> another tool call -> result -> final text.
- Pairing invariant: Orphaned TOOL_RESULT -> dropped. Dangling tool_calls -> filtered.
- Output offloading: >20KB -> cache file, pointer returned. Exempt tool -> inline.
- Usage tracking: Stream ends with usage data -> Usage object populated.
- Timeout: Tool >60s -> TimeoutError caught, error result returned.

---

### U10. XState Actor Hierarchy

**Goal:** Build the XState actor hierarchy for agent orchestration: general agent machine, subagent spawning, interrupt state machine, session actor.

**Requirements:** R1, R5

**Dependencies:** U2, U4, U8, U9

**Files:**
- Create: `electron/src/main/agents/xstate/session-machine.ts`, `agent-machine.ts`, `interrupt-machine.ts`, `subagent-machine.ts`, `events.ts`
- Create: `electron/src/main/agents/manager.ts` (SubagentManager)
- Test: `electron/tests/unit/xstate-agents.test.ts`

**Approach:**
- **Agent machine**: `idle -> streaming -> toolExecuting -> streaming -> idle -> interrupted`. `fromCallback` for LLM stream, `fromPromise` for tool execution. `CANCEL` -> `interrupted` (cancels in-flight invoke).
- **Interrupt machine**: Nested inside agent's `streaming`. `IDLE -> CONFIRM_AGENT -> CONFIRM_SUBAGENTS`. First Esc = CONFIRM_AGENT, second = cancel stream, third = cancel subagents. Auto-resets after 5s.
- **Session machine**: Parent actor owning active agent, background commands, session state. Receives `USER_INPUT`, delegates to agent. Spawns child subagent machines.
- **Subagent machine**: `pending -> running -> completed | failed | interrupted`. Reports completion via `sendParent`. Isolated chain (messages, model, system prompt).
- **SubagentManager**: `spawn()`, `wait()`, `cancel_one()`, `cancel_all()`, `cancel_running()`, `get_states()`, `all_records()`.

**Test scenarios:**
- Agent idle -> user input -> streaming -> text -> idle.
- Streaming -> tool_call -> toolExecuting -> tool result -> streaming -> idle.
- Subagent spawn -> runs -> completes -> result reported to parent.
- Esc -> CONFIRM_AGENT -> Esc -> stream cancelled -> idle.
- Esc -> CONFIRM_SUBAGENTS -> Esc -> subagents cancelled.
- Interrupt timeout: 5s no action -> auto-reset.
- Subagent isolation: child tool calls don't affect parent state.

---

### U11. Subagent Delegation Tools

**Goal:** Port `delegate_to_subagent`, `wait_for_subagent`, `interrupt_subagents`.

**Requirements:** R4, R5

**Dependencies:** U7, U10

**Files:**
- Create: `electron/src/main/tools/subagent/delegate.ts`, `wait.ts`, `interrupt.ts`, `index.ts`
- Test: `electron/tests/unit/subagent-tools.test.ts`

**Approach:**
- `delegate_to_subagent`: Dynamically built (description lists available agents). Params: `name`, `task`, `type`, optional `tier`. Looks up agent, resolves model, spawns via SubagentManager.
- `wait_for_subagent`: Params: `subagent_ids` (string array). Blocks until complete, returns results.
- `interrupt_subagents`: Params: `subagent_ids` (empty = all). Cancels running tasks.
- Subagents cannot create subagents (enforced by tool filtering).

**Test scenarios:**
- Delegate -> subagent spawned, ID returned. Wait -> result returned. Interrupt -> cancelled.
- Dynamic description lists available agent types with tiers.
- Tier override: `tier: "crown"` -> uses crown-tier model.
- Not found: wait for non-existent ID -> error.

---

### U12. MCP Client

**Goal:** Port MCP client with stdio and SSE transports, dynamic tool registration, resource reading, lifecycle management.

**Requirements:** R10

**Dependencies:** U4, U7

**Files:**
- Create: `electron/src/main/mcp/manager.ts`, `transport.ts`, `schema.ts`, `index.ts`
- Test: `electron/tests/unit/mcp-client.test.ts`

**Approach:**
- `@modelcontextprotocol/sdk` (TypeScript MCP SDK) for client sessions, transports, tool listing, resource reading.
- `MCPManager`: `start_all(servers)`, `shutdown()`, `get_tools()`, `call_tool()`, `read_resource()`. Lifecycle in single dedicated async context.
- Tool registration: `mcp::{server_name}::{tool_name}` namespacing.
- Per-server startup timeout (default 10s). Overall timeout (default 60s). Graceful degradation: failed -> "failed", overall timeout -> "unavailable".
- MCP reconfiguration: Prompt for app restart on config change (user decision).
- Resource reading: `read_mcp_resource` tool calls `session.read_resource(uri)`.
- **Security note**: MCP servers are external processes that register tools dynamically and execute arbitrary code on the user's machine. No sandboxing, tool-output validation, or capability restriction is implemented. MCP servers are considered trusted (user-installed). A malicious or compromised MCP server could register deceptive tools, inject prompt-injection payloads via tool output, or access any user-accessible resource. Output sanitization for MCP tool results should be evaluated in a future iteration.

**Test scenarios:**
- Start stdio server -> tools registered -> tool call works -> shutdown clean.
- SSE transport -> tools registered -> tool call works.
- Per-server timeout -> marked "failed" -> others continue.
- Overall timeout -> remaining marked "unavailable".
- Tool `read-docs` from `context7` -> registered as `mcp::context7::read-docs`.
- Graceful degradation: one server fails -> app works with rest.
- Shutdown: all transports torn down cleanly.

---

## Phase D: Tool Port (U13-U18)

### U13. File Tools

**Goal:** Port `read`, `edit`, `write`, `read_directory`, `glob`.

**Requirements:** R4

**Dependencies:** U7, U9

**Files:**
- Create: `electron/src/main/tools/filesystem/read.ts`, `edit.ts`, `write.ts`, `read-directory.ts`, `glob.ts`, `index.ts`
- Test: `electron/tests/unit/file-tools.test.ts`

**Approach:**
- `read`: `file_path`, `offset`, `limit`. Lines with `num | content` prefix.
- `edit`: `file_path`, `old_string`, `new_string`, `replace_all`. Exact string replacement. Refuses multiple matches unless `replace_all`. Atomic write. Unified diff. **Post-write callbacks** (RAG + AST re-indexing).
- `write`: `file_path`, `content`. Auto-create parent dirs. Atomic write. Post-write callbacks.
- `read_directory`: `directory_path`, `max_depth`, `include_hidden`. ASCII tree.
- `glob`: `directory_path`, `pattern`, `include_hidden`. Sorts by mtime.
- Shared `atomic_write()` utility (temp + fsync + replace + preserve permissions + fsync parent dir).
- **Security note**: Path sandboxing is deferred (permission system is a future addition). File tools operate on arbitrary filesystem paths with no restriction to the project directory. This creates a data exfiltration risk: the agent can read sensitive files and include their contents in responses. Document this as a known security gap for the unsigned beta phase.

**Test scenarios:**
- Read lines 10-20 of 100-line file. Empty file.
- Edit: single match, multiple match guard, `replace_all`. Diff produced.
- Write: new file with parent dirs. Existing file overwrite.
- Glob: `**/*.ts` -> all TS files sorted by mtime.
- Post-write callbacks: edit triggers RAG and AST re-indexing.

---

### U14. Search & Process Tools

**Goal:** Port `grep`, `execute_command`, `read_output`, `send_input`, `terminate_command`.

**Requirements:** R4, R11

**Dependencies:** U7, U9

**Files:**
- Create: `electron/src/main/tools/search/grep.ts`
- Create: `electron/src/main/tools/process/execute-command.ts`, `read-output.ts`, `send-input.ts`, `terminate-command.ts`, `background-store.ts`, `head-tail-buffer.ts`, `index.ts`
- Test: `electron/tests/unit/search-process-tools.test.ts`

**Approach:**
- **grep**: Regex search, bounded concurrency (semaphore=32), per-file timeout (10s), binary detection. `include_pattern` with glob-to-regex. Cancels on `max_results`.
- **execute_command**: Foreground: child process, `NO_COLOR=1 TERM=dumb`, stdout+stderr up to 1 MiB cap, SIGTERM->SIGKILL on timeout. Background: delegates to BackgroundProcessStore. `interactive=true` forces background with PTY.
- **BackgroundProcessStore**: Max 64 entries, LRU eviction (8 protected). HeadTailBuffer (first 512KB + last 512KB, ~1MB cap). Session-scoped visibility. Ownership model (AGENT vs USER). Idle timeout for USER-owned.
- **read_output**: Long-poll (50ms polling, 300ms grace). Returns tail from HeadTailBuffer.
- **send_input**: Rejected if not interactive/exited/USER-owned. Writes to PTY stdin.
- **terminate_command**: SIGTERM -> SIGKILL to process group.

**Test scenarios:**
- Grep: Search for "function" in `.ts` files. Binary skipped. Max results -> cancel remaining.
- Execute foreground: `echo hello` -> stdout, exit code 0. Long-running -> timeout -> killed.
- Execute background: `sleep 10` -> ID returned. Read output -> streams.
- Send input: Interactive -> stdin written. Non-interactive -> rejected.
- Terminate: Running -> killed.
- HeadTailBuffer: >1MB -> middle dropped, head+tail preserved.
- LRU: 64 + new spawn -> oldest evicted.

---

### U15. Todo & Web Tools

**Goal:** Port `todo_create`, `todo_update`, `todo_list`, `todo_delete`, `web_fetch`.

**Requirements:** R4

**Dependencies:** U4, U7, U9

**Files:**
- Create: `electron/src/main/tools/todo/create.ts`, `update.ts`, `list.ts`, `delete.ts`, `index.ts`
- Create: `electron/src/main/tools/web/fetch.ts`, `index.ts`
- Test: `electron/tests/unit/todo-web-tools.test.ts`

**Approach:**
- **Todo tools**: Session-scoped TodoStore (from U4). `todo_create` generates 8-hex UUID. `todo_update` validates transitions against `VALID_TRANSITIONS`. `todo_list` filters by status/subagent_id. `todo_delete` removes. All trigger `notify_todo_changed()`.
- **web_fetch**: URL validation: block private IP ranges (RFC 1918: 10.x, 172.16-31.x, 192.168.x), link-local (169.254.x.x), localhost/loopback, cloud metadata endpoints (169.254.169.254). Only allow http/https schemes. Maximum response body size cap. Fetch via `fetch()` with 30s timeout. Summarize mode: HTML to markdown, sends to web-fetch agent. Raw mode: markdown; >10K chars -> cache file. Title extraction via HTML parsing.

**Test scenarios:**
- Todo: create -> ID. OPEN -> IN_PROGRESS -> DONE (valid). DONE -> IN_PROGRESS (invalid).
- Web fetch summarize: URL -> summarized answer. Raw: URL -> markdown. Large -> cached.

---

### U16. RAG Pipeline

**Goal:** Port RAG: file discovery, chunking, embeddings (onnxruntime-node), vector store (SQLite + arrays), cosine similarity, auto re-indexing.

**Requirements:** R7

**Dependencies:** U3, U7, U9, U13 (post-write callbacks)

**Files:**
- Create: `electron/src/main/rag/chunker.ts`, `embedder.ts`, `store.ts`, `indexer.ts`
- Create: `electron/src/main/tools/rag/search.ts`, `index.ts`
- Test: `electron/tests/unit/rag-pipeline.test.ts`

**Approach:**
- **Chunker**: Splits code into overlapping chunks respecting blank-line break points. `chunk_size` (default 2000), `chunk_overlap` (default 200). Binary detection. Min chunk guard.
- **Embedder**: `onnxruntime-node` with BGE-small ONNX model (~130MB). Runs in a `worker_threads` worker in the main process. Batch 100, retries 3. Warmup on first call (throwaway run to avoid slow first inference). **ONNX model distribution**: Downloaded on first RAG index (not bundled in app). URL: configured in the app or fetched from a known CDN. Offline fallback: if no network, RAG indexing fails gracefully with an error message. This avoids inflating the app by ~130MB for all users.
- **Store**: `better-sqlite3` with WAL. Tables: chunks, files, meta. Vectors as `.npy` (Float32Array). Cosine similarity: `(V @ q) / (||V|| * ||q||)`. Process-level cache. Corruption recovery.
- **Indexer**: Full project index with MD5 hash change detection. `update_file()` for single-file re-index (post-write callback). File discovery: 25 extensions, `ignored_dirs` from config.
- **Auto re-index**: Post-write callback on module import. `edit`/`write` trigger `indexer.update_file()`.

**Test scenarios:**
- Chunker: Short file -> single chunk. Long file -> overlapping chunks with natural breaks.
- Embedder: Batch 100 texts -> 100 Float32Arrays. Warmup reduces latency.
- Store: Upsert + search -> correct ranking. Corruption -> auto-rebuild.
- Indexer: First index -> all files. Second -> only changed.
- Auto re-index: Edit file -> RAG updated automatically.
- RAG search: Query -> results with scores. RAG index: status/clear.

**Verification:**
- 1000 chunks indexed in < 30 seconds.
- Search results comparable to Python TUI.

---

### U17. AST Pipeline

**Goal:** Port AST: tree-sitter parsing, symbol indexing, 5 AST tools.

**Requirements:** R15

**Dependencies:** U3, U7, U9, U13 (post-write callbacks)

**Files:**
- Create: `electron/src/main/ast/parser.ts`, `indexer.ts`, `store.ts`
- Create: `electron/src/main/ast/queries/python.scm`, `javascript.scm`, `typescript.scm`
- Create: `electron/src/main/tools/ast/get-file-skeleton.ts`, `get-function.ts`, `find-symbol-references.ts`, `replace-symbol.ts`, `rename-symbol.ts`, `index.ts`
- Test: `electron/tests/unit/ast-pipeline.test.ts`

**Approach:**
- **Parser**: `web-tree-sitter` (WASM) for renderer, `node-tree-sitter` (native) for main. Lazy grammar loading. Languages: `.py`, `.js`, `.jsx`, `.ts`, `.tsx`.
- **Symbol extraction**: Tree-sitter queries per language. Dedup by position.
- **Store**: `better-sqlite3` with WAL. Tables: files, symbols, meta. Corruption recovery.
- **Indexer**: Full project with hash change detection. `update_file()` (post-write callback). `ensure_indexed()` lazy init.
- **get_file_skeleton**: Definitions with line ranges, call extraction, visual separators.
- **get_function**: Source with class context, imports. FNV-1a change detection ("No changes" on repeat).
- **find_symbol_references**: Query by name, filtered by type.
- **replace_symbol**: Definitions via tree-sitter, extends range for decorators/comments. Ambiguity guard. Reverse-byte replacements. Atomic write. Post-write callbacks.
- **rename_symbol**: Two-phase (compute in memory, write atomically). Word boundary guard. Byte-to-char column conversion.

**Test scenarios:**
- Parse Python file -> tree structure. Index project -> all symbols.
- get_file_skeleton: functions + classes with line numbers.
- get_function: source with imports + class context. Change detection: "No changes".
- find_symbol_references: all references with file:line.
- replace_symbol: replace body, diff, post-write callbacks. Ambiguity -> error.
- rename_symbol: cross-project rename, word boundary guard.
- Post-write callbacks: AST tool modifies -> RAG + AST re-indexed.

---

### U18. Skill & MCP Resource Tools

**Goal:** Port `skill` tool (dynamic building, dependency resolution, resource reads) and `read_mcp_resource`.

**Requirements:** R4, R6, R10

**Dependencies:** U6, U7, U12

**Files:**
- Create: `electron/src/main/tools/skill/skill.ts`, `index.ts`
- Create: `electron/src/main/tools/mcp/resource.ts`, `index.ts`
- Test: `electron/tests/unit/skill-mcp-tools.test.ts`

**Approach:**
- **skill**: Dynamically built (description lists available skills). Params: `name` (skill name or `skill_name/resource_path`). Dependency resolution: depth-first, circular detection. Injection: deepest dependency first. XML blocks. Resource access via `name/path` with path traversal protection. `.md` frontmatter stripped.
- **read_mcp_resource**: Params: `uri`. Looks up server by URI in MCPManager. Calls `session.read_resource(uri)`.
- Agent-scoped skill filtering: `build_skill_tool(allowedSkills)` only lists matching skills.

**Test scenarios:**
- Skill with dependencies -> injected in dependency order. Circular -> error.
- Resource: `work/references/api-errors.md` -> content, frontmatter stripped.
- Path traversal: `../../../etc/passwd` -> error.
- Agent-scoped: only listed skills matching agent's `allowed_skills`.
- MCP resource: valid URI -> text. Unknown URI -> error. Server unavailable -> error.

---

## Phase E: UI Shell (U19-U24)

### U19. Electron App Shell

**Goal:** Build the Electron app shell with main process, renderer, IPC bridge, window management, themes.

**Requirements:** R13, R15b

**Dependencies:** U3, U8, U10

**Files:**
- Create: `electron/src/main/index.ts` (full app entry), `electron/src/main/ipc/` (IPC handlers)
- Create: `electron/src/preload/index.ts` (contextBridge with typed API)
- Create: `electron/src/renderer/App.tsx` (root with theme provider)
- Create: `electron/src/renderer/themes/` (5 CSS themes: default/dark, solarized-light, bluey, windows_xp, green_terminal)
- Test: `electron/tests/integration/app-shell.test.ts`

**Approach:**
- Main: `BrowserWindow` with `contextIsolation: true`, `nodeIntegration: false`. IPC handlers for chat, config, session, tools, agents, MCP.
- Preload: typed API via `contextBridge.exposeInMainWorld('orchid', {...})`. Each method is `ipcRenderer.invoke` wrapper.
- Renderer: React with theme provider. 5 CSS themes as CSS custom properties. Live switching.
- IPC channels: `chat:send`, `chat:cancel`, `config:get`, `config:save`, `session:list`, `session:load`, `tool:execute`, `agent:list`, `agent:spawn`, `mcp:status`, `rag:status`, `ast:status`.
- All IPC payloads validated with zod at main-process boundary.

**Test scenarios:**
- App starts, React renders, theme applied.
- IPC: `chat:send` -> main processes -> response streams back.
- Theme switch -> CSS variables update -> UI changes.
- Security: `window.require` undefined in renderer.

---

### U20. Chat Stream + Sidebar

**Goal:** Build Phase 1 primary interface: chat stream + collapsible right sidebar. Four interaction states on all surfaces.

**Requirements:** R15b, R15c

**Dependencies:** U4, U9, U10, U11, U15, U19

**Files:**
- Create: `electron/src/renderer/components/ChatStream.tsx`, `MessageWidget.tsx`, `Sidebar.tsx`, `InputArea.tsx`, `Footer.tsx`
- Create: `electron/src/renderer/hooks/useChat.ts`, `useSession.ts`, `useSubagents.ts`, `useTodos.ts`
- Test: `electron/tests/integration/chat-sidebar.test.ts`

**Approach:**
- **Chat stream**: Messages in scrollable container. Each type (user, assistant, thinking, tool_call, tool_result, error) has distinct widget. Streaming updates in real-time via IPC events. Smart auto-scroll.
- **Sidebar**: Sessions (date-grouped), Subagents (status indicators), Todos (status badges), MCP status (connected/failed/unavailable), Index status (RAG/AST). Each section independently collapsible.
- **Input area**: Text input with submit (Enter/Ctrl+S), clear (Ctrl+C), model indicator.
- **Footer**: Model label, token usage (prompt/cached/completion), elapsed, shortcuts.
- **Interaction states** (R15c): Every surface: loading (spinner), empty (placeholder + CTA), error (message + retry), partial (truncated + "show more"). Consistent messaging and recovery actions.
- **Model switching**: `/model` command -> picker -> changes session model.

**Test scenarios:**
- Chat: Send message -> streaming response -> auto-scroll.
- Sidebar: sessions by date, subagent status, todos, MCP, index.
- Model switch: `/model` -> picker -> new model for next chain.
- Interrupt: Esc -> stream cancelled -> "[Interrupted by user]".
- Interaction states: empty, error, loading, partial on all surfaces.

---

### U21. Command Palette

**Goal:** Port command palette as Cmd+K/Ctrl+K with fuzzy search across commands, sessions, settings, navigation.

**Requirements:** R14

**Dependencies:** U19, U20

**Files:**
- Create: `electron/src/renderer/components/CommandPalette.tsx`
- Create: `electron/src/main/commands/registry.ts`, `session-commands.ts`
- Test: `electron/tests/integration/command-palette.test.ts`

**Approach:**
- Cmd+K (macOS) / Ctrl+K (Win/Linux) opens modal palette (overlay, highest z-index).
- Fuzzy search: commands (12 slash commands), sessions, settings, navigation.
- Result categories: Commands (with `/` prefix), Sessions (with date), Settings (with section name), Navigation (sidebar sections).
- Empty query: show recent commands (last 5 used) + all commands.
- Keyboard: Up/Down arrows navigate results, Enter executes selected, Esc closes. Mouse click selects.
- All 12 commands ported: `/new`, `/sessions`, `/rename`, `/delete`, `/model`, `/theme`, `/personality`, `/settings`, `/index-rag`, `/index-ast`, `/rag status`, `/rag clear`.
- `/settings` opens Preferences (U24). `/index-rag` and `/index-ast` run in background with progress notification.

**Test scenarios:**
- Cmd+K -> palette opens. Type "mod" -> `/model`. Type "ses" -> `/sessions` + session names.
- Select `/new` -> new session. Select session name -> session loaded.
- All 12 commands accessible and functional.

---

### U22. Native Tool-Call Widgets (R21)

**Goal:** Implement native tool-call widgets in side rail: Monaco diff for edits, xterm.js for commands, file-preview for reads, results table for grep.

**Requirements:** R21

**Dependencies:** U13, U14, U19, U20

**Files:**
- Create: `electron/src/renderer/components/ToolWidgets/DiffWidget.tsx`, `TerminalWidget.tsx`, `FilePreview.tsx`, `ResultsTable.tsx`, `ToolWidgetContainer.tsx`, `index.ts`
- Test: `electron/tests/integration/tool-widgets.test.ts`

**Approach:**
- Tool calls render as structured widgets in collapsible side rail (right of chat, left of sidebar).
- **Trigger mechanism**: Side rail auto-opens when a tool call occurs. User can collapse/expand via collapse button.
- **Side rail width**: 40% of window width (min 300px, max 600px). Resizable via drag handle.
- **Multiple tool calls**: When multiple tool calls are in flight, show tabs or a list in the rail. Active tool call is selected by default.
- **Layout impact**: When rail opens, ChatStream shrinks to accommodate. Smooth transition animation.
- **DiffWidget**: Monaco editor in diff mode. Before/after for `edit`, `write`, `replace_symbol`, `rename_symbol`. Syntax highlighting.
- **TerminalWidget**: xterm.js for `execute_command` (background). Streaming output. Interactive input.
- **FilePreview**: Rendered preview for `read`. Line numbers, syntax highlighting.
- **ResultsTable**: Tabular for `grep`. Columns: file, line, matched text. Clickable rows.
- Each tool call is a structured persisted event — sessions replay exact widget state on restore.

**Test scenarios:**
- Edit -> DiffWidget shows before/after. Execute -> TerminalWidget streams. Read -> FilePreview. Grep -> ResultsTable.
- Session reloaded -> widget reconstructs correctly.
- Collapse -> minimizes to tool name + summary.

---

### U23. ~~Annotated Diff Code Review (R22)~~ — DEFERRED

**Status:** Deferred to a future planning cycle. R22 has been moved out of Phase 1 scope. Added to todo for later implementation.

**Original goal:** Navigable annotated diff with line-level finding markers, color-coded by persona, filterable by severity, reasoning on hover.

**Why deferred:** This is a significant UI feature (Monaco diff markers, persona color-coding, severity filtering, reasoning popovers) that is not required for engine parity. It can be added as a fast-follow after parity is declared.

---

### U24. Preferences & Onboarding

**Goal:** Native preferences window (5 tabs) and first-run onboarding (provider detection, config seeding).

**Requirements:** R8, R18, R18b

**Dependencies:** U3, U6, U19, U21

**Files:**
- Create: `electron/src/renderer/components/Preferences/PreferencesWindow.tsx`, `ProvidersTab.tsx`, `MCPServersTab.tsx`, `TierModelsTab.tsx`, `RAGTab.tsx`, `GeneralTab.tsx`
- Create: `electron/src/renderer/components/Onboarding/OnboardingScreen.tsx`
- Create: `electron/src/main/onboarding/detect.ts`
- Test: `electron/tests/integration/preferences-onboarding.test.ts`

**Approach:**
- **Preferences**: 5 tabs (Providers, MCP Servers, Tier Models, RAG, General). Ctrl+S saves. Esc -> unsaved-changes dialog. MCP changes -> restart prompt.
- **Providers**: List/edit/delete. Add with model table. Model discovery via `GET /models`.
- **MCP Servers**: List/edit/delete. Add with command/url/args/env.
- **Tier Models**: Change per tier -> model picker.
- **RAG**: Chunk size/overlap/top_k/max_file_size. Embedding model picker.
- **General**: Default model, theme, personality, numeric configs.
- **Onboarding flow** (6 steps):
  1. **Welcome**: App name, brief description, "Get Started" button.
  2. **Provider detection**: Scan for Ollama (localhost:11434), check env vars for API keys (OPENAI_API_KEY, ANTHROPIC_API_KEY, etc.). Show detected providers with checkmarks.
  3. **Provider confirmation**: Pre-filled config with detected providers. User can add/edit/remove. If none detected: guide to install Ollama (link + instructions) or enter API key inline.
  4. **Model selection**: Pick default model from detected providers. Recommend based on provider capabilities.
  5. **Config seeding**: Show what will be created (agents, skills, personalities directories). User confirms.
  6. **Done**: "You're ready to go!" with "Start chatting" button. User lands in empty ChatStream.
- **Skip onboarding**: User can skip at any step. Skipped steps use defaults. Config can be changed later via `/settings`.
- **API keys**: Via OS keychain (U25). Display masked (last 4 chars).

**Test scenarios:**
- Preferences: 5 tabs render. Edit provider -> save. MCP change -> restart prompt. Unsaved -> dialog.
- Onboarding: Providers detected -> confirmation. None -> guide. Confirm -> config + seeds.

---

## Phase F: Cross-Platform & Parity (U25-U29)

### U25. OS Keychain Integration

**Goal:** Integrate Electron `safeStorage` for API key storage. Redaction in logs, sessions, UI.

**Requirements:** R18b

**Dependencies:** U3, U19

**Files:**
- Create: `electron/src/main/config/keychain.ts`
- Test: `electron/tests/unit/keychain.test.ts`

**Approach:**
- `safeStorage.encryptString()` -> Buffer. Store as base64 in config/SQLite.
- `safeStorage.decryptString()` -> plaintext. Only when key needed.
- Config serialization redacts: `apiKey` -> last 4 chars.
- Session persistence redacts: API key in error messages -> masked.
- UI masks: onboarding, preferences, logs -> last 4 chars.
- Fallback: If `isEncryptionAvailable()` false (Linux without libsecret) -> plaintext with warning.
- **Threat model**: Session files and tool-output cache store sensitive data (conversation history, file contents, command outputs) as plaintext, protected only by filesystem permissions (chmod 600). On a shared or compromised machine, any process running as the same user can read all session data. This unit only protects API keys, not session content. Evaluate encrypting session files at rest in a future iteration. Implement cache cleanup policies (max age, max total size) and ensure uninstall clears cached data.

**Test scenarios:**
- Encrypt/decrypt round-trip. Config redaction. Session redaction. Fallback with warning.

---

### U26. Packaging & Distribution

**Goal:** Distributable packages for macOS (dmg), Windows (nsis), Linux (AppImage, deb).

**Requirements:** R16

**Dependencies:** U1, U19

**Files:**
- Finalize: `electron/electron-builder.yml`
- Create: `.github/workflows/electron-build.yml`

**Approach:**
- `electron-builder`: appId `com.orchid.app`, productName `Orchid`.
- macOS: `dmg`. Windows: `nsis`. Linux: `AppImage` + `deb`.
- CI: GitHub Actions with platform-specific runners.
- Native modules: `@electron/rebuild` for better-sqlite3, onnxruntime-node.

**Test scenarios:**
- macOS dmg mounts + runs. Windows nsis installs + runs. Linux AppImage runs. Linux deb installs + runs.
- Native modules work in packaged app.

---

### U27. Auto-Update

**Goal:** Auto-update via electron-updater, gated to signed releases.

**Requirements:** R17

**Dependencies:** U26

**Files:**
- Create: `electron/src/main/updater.ts`
- Modify: `electron/electron-builder.yml` (publish config)

**Approach:**
- `electron-updater` with GitHub releases. `autoDownload = false`.
- Events: `update-available` -> notify UI. `update-downloaded` -> prompt restart.
- Gated to signed releases (macOS Gatekeeper blocks unsigned).
- `publish.provider: github`. `generateUpdatesFilesForAllChannels: true`.

**Test scenarios:**
- Mock server returns new version -> notification. Download -> progress. Restart -> new version.
- Unsigned -> disabled -> manual download. Same version -> no notification.

---

### U28. Parity Matrix & Parity Tests

**Goal:** Create parity matrix tracking every tool, agent, skill, config field, command against TS port status. Write automated parity tests.

**Requirements:** All (verification)

**Dependencies:** All previous units

**Files:**
- Create: `docs/plans/2026-07-08-001-feat-ts-electron-desktop-migration-plan-parity-matrix.md`
- Create: `electron/tests/parity/tools.test.ts`, `agents.test.ts`, `skills.test.ts`, `config.test.ts`, `sessions.test.ts`, `commands.test.ts`

**Approach:**
- Parity matrix: one row per capability. Columns: name, Python source, TS port, status (ported/parity-tested/skipped), notes.
- Parity tests: each tool verifies same output structure. All 26 agents load correctly. All 15 skills load correctly. All 30+ config fields. All 12 commands.
- Session format: version 1 JSON (TS app's own format, not backward-compatible with Python TUI).

**Test scenarios:**
- Every row "ported" + "parity-tested" -> parity complete.
- 27 tools have at least one test. 26 agents load. 15 skills load. All config fields. All commands.

---

### U29. Architecture Validation & Cross-Platform Smoke Tests

**Goal:** Validate that the TS architecture delivers the properties promised by the migration (parallel subagents, reactive state updates, responsive input, correct auto-scroll). Run cross-platform smoke tests.

**Requirements:** Success Criteria

**Dependencies:** U28

**Files:**
- Create: `electron/tests/integration/architecture-validation.test.ts`
- Create: `electron/tests/integration/cross-platform-smoke.test.ts`

**Approach:**
- **Architecture property validation**: Test that the new system delivers the architectural properties the migration promises:
  - Parallel subagents: Spawn 4 subagents -> all run in parallel via worker_threads (not serialized on event loop).
  - Reactive state updates: Stream with tool calls -> context (dynamic system prompt) updates between calls.
  - Responsive input: Rapid input during stream -> input not stuck after stream completes.
  - Correct auto-scroll: Long conversation -> auto-scroll behaves correctly (doesn't auto-scroll when user scrolled up).
- **Cross-platform smoke**: On each platform:
  - App starts -> onboarding -> send message -> response.
  - All 5 themes render. Command palette opens (Cmd+K / Ctrl+K).
  - Background command -> OS notification on completion.

**Verification:**
- All architecture properties validated.
- App works on macOS, Windows, Linux.
