---
title: "refactor: Worker pool for CPU-heavy tool handler offloading"
type: refactor
date: 2026-07-24
---

# Worker Pool for CPU-Heavy Tool Handler Offloading

## Summary

Add a reusable worker thread pool to the Electron main process and offload CPU-heavy / sync-I/O tool handlers (grep, glob, read, rag_search, AST query tools) to it, keeping permission checks, result finalization, and async tools on the main thread. This eliminates UI freezes caused by synchronous file I/O, regex execution, ONNX inference, and tree-sitter parsing during tool calls.

## Problem Frame

All tool handlers execute on the Electron main process event loop via `executeToolCall` → `registered.handler(args, ctx)` (tool-dispatch.ts:294). Tools that perform synchronous file I/O (`read`, `grep`, `glob`), CPU-bound computation (`rag_search` ONNX inference, AST tree-sitter parsing), or both block the event loop for the duration, freezing the entire UI — no streaming updates, no IPC handling, no abort signals.

The full code review (2026-07-24) identified this as a systemic issue behind 6 performance findings (P1–P3) and 1 adversarial finding (P1 ReDoS). The `Promise.race` timeout pattern used for grep's per-file timeout is structurally incapable of interrupting synchronous code.

The RAG and AST *indexers* already use worker threads (`rag/indexer.ts:425`, `ast/indexer.ts:386`) but create one-shot workers per run with no reuse. No shared pool exists.

## Requirements

**Core offloading**

- R1. CPU-heavy tool handlers execute in a worker thread, not on the main process event loop.
- R2. Permission checks, argument validation, result finalization, and output offloading remain on the main thread.
- R3. The main process event loop stays responsive during offloaded tool execution — streaming, IPC, and abort signals continue to function.
- R4. Tool behavior is identical whether executed on main or in a worker — same inputs produce same outputs.

**Pool management**

- R5. A bounded worker pool (configurable size, default 2) reuses worker threads across tool calls instead of spawning one-shot workers.
- R6. Workers that crash or become unresponsive are replaced automatically.
- R7. The pool shuts down cleanly on app exit — no orphaned worker threads.

**Cancellation**

- R8. Cancelling a tool call (abort signal) terminates the in-flight worker task. The worker is killed and replaced if it cannot be cooperatively cancelled.

**Configuration**

- R9. Tools opt into offloading via a flag on `ToolDefinition`. Tools without the flag execute on the main thread as today.
- R10. Offloaded tools receive a serializable context subset (`cwd`, config values) — never `ProjectRuntime`, `AbortSignal`, or class instances.

**Fallback**

- R11. If the worker bundle is missing or a worker fails to start, the tool falls back to inline main-thread execution (matching the existing indexer fallback pattern).

## Key Technical Decisions

**KTD-1. Split at the handler boundary, not at `executeToolCall`.**
The permission gate (`checkPermission`) uses `ipcMain`/`webContents` for approval dialogs — main-process-only APIs. The split point is between permission check and handler invocation (tool-dispatch.ts:294). Everything before the handler stays on main; only `handler(args, ctx)` is dispatched to a worker.

**KTD-2. Serializable context subset, not full `ToolExecutionContext`.**
Research confirms all CPU-heavy tools need only `cwd: string` and optionally config values (plain data). None use `projectRuntime`, `abortSignal`, `sessionId`, `windowId`, or `agentScopeId`. Define a `WorkerToolContext` type with only serializable fields. The `getToolConfig(ctx)` helper (types.ts:126) falls back to the `getConfig()` singleton — in a worker, config must be passed explicitly since the singleton doesn't exist in the worker isolate.

**KTD-3. Persistent pool with task queue, not one-shot workers.**
The existing indexer pattern (one `new Worker()` per run) is wasteful for tool calls that happen many times per turn. A pool of 2 persistent workers with a task queue amortizes startup cost (tree-sitter native module loading, ONNX session warmup). Pool size is configurable.

**KTD-4. `worker.terminate()` for cancellation, not cooperative abort.**
CPU-heavy tools don't check `abortSignal` today (documented in types.ts:111-114). Adding cooperative cancellation to every sync loop is invasive. Instead: on abort, `terminate()` the worker (kills it immediately) and spawn a replacement. This is the same approach the existing indexers use for cleanup. The terminated worker's task rejects with a cancellation error.

**KTD-5. Worker entry point loads the tool registry, not individual handlers.**
Rather than serializing handler functions (impossible), the worker entry point imports and registers the same builtin tools. The main thread sends `{ toolName, args, context }` and the worker looks up the handler in its own registry. This mirrors how `index-worker.ts` imports `runIndexProjectImpl` directly.

**KTD-6. `get_function` module-level state (`sentHashes`) stays on main.**
`get_function` (get-function.ts:52) maintains a `Map<string, string>` of file hashes for change detection ("no changes" responses). This state must persist across calls. Two options: (a) keep `get_function` on main thread (simplest), or (b) move the hash map to the main thread and pass/return it per call. Decision: option (a) — keep `get_function` on main. It's tree-sitter parsing but typically fast for single functions. Revisit if profiling shows it's a bottleneck.

**KTD-7. AST tools that call `ensureIndexed()` are excluded from initial offloading.**
`find_symbol_references` and `rename_symbol` call `ensureIndexed()` which may spawn an indexer worker internally. Nesting workers (tool worker → indexer worker) adds complexity. These tools stay on main in the initial implementation. `get_file_skeleton` and `replace_symbol` (which don't call `ensureIndexed`) can be offloaded.

## High-Level Technical Design

```
Main Thread                              Worker Pool (2 threads)
───────────                              ───────────────────────
executeToolCall()
  ├─ validate args (Zod)
  ├─ checkPermission()  ← IPC to renderer
  ├─ recordToolCall()
  │
  ├─ definition.offload?
  │   ├─ NO  → handler(args, ctx)        [inline, as today]
  │   └─ YES → pool.run(toolName, args, workerCtx)
  │              │
  │              ├─ serialize {toolName, args, workerCtx}
  │              ├─ postMessage → worker ──→  receive task
  │              │                            ├─ registry.get(toolName)
  │              │                            ├─ handler(args, workerCtx)
  │              │                            ├─ postMessage(result)
  │              │  ←────────────────────────┘
  │              ├─ deserialize result
  │              └─ return to executeToolCall
  │
  ├─ finalizeHandlerResult()
  ├─ maybeOffloadAgentProjection()
  └─ executionSchema.parse()
```

**Worker lifecycle:**

```
Pool.init(size=2)
  ├─ Worker 1: new Worker('tool-worker.js', { workerData: { config } })
  │   └─ loads tool registry, signals 'ready'
  ├─ Worker 2: same
  │
  ├─ Task queue: FIFO, dispatches to idle workers
  ├─ On worker crash: spawn replacement, re-queue failed task
  ├─ On abort: worker.terminate(), spawn replacement, reject task
  └─ Pool.dispose(): terminate all workers, drain queue with errors
```

**Message protocol (typed discriminated union):**

```
Main → Worker:
  { type: 'execute', taskId, toolName, args, context: WorkerToolContext }

Worker → Main:
  { type: 'result', taskId, result: ToolHandlerOutcome }
  { type: 'error', taskId, error: string }
  { type: 'ready' }
```

## Scope Boundaries

**In scope:**
- Worker pool infrastructure (pool, task queue, lifecycle)
- Worker entry point (`tool-worker.ts`)
- `offload` flag on `ToolDefinition`
- `WorkerToolContext` serializable type
- Dispatch integration in `executeToolCall`
- Offloading: `grep`, `glob`, `read`, `rag_search`, `get_file_skeleton`, `replace_symbol`
- Cancellation via `worker.terminate()`
- Fallback to inline on missing bundle / worker failure
- Tests for pool, dispatch, serialization, fallback

**Out of scope (explicit non-goals):**
- Offloading `execute_command`, `web_fetch`, `ask_question`, subagent tools (already async)
- Offloading `find_symbol_references`, `rename_symbol` (call `ensureIndexed()` → nested workers)
- Offloading `get_function` (module-level `sentHashes` state — KTD-6)
- Offloading MCP proxy tools (need MCP manager on main)
- Offloading `todo_*`, `skill`, `rag_index`, `ast_index` (in-memory or already use workers)
- Cooperative cancellation within tool handlers (abort signal forwarding)
- Async-ifying sync fs calls within handlers (separate improvement, can be done independently)
- Changing the indexer worker pattern to use the pool (separate refactor)

## Implementation Units

### U1. WorkerToolContext type and ToolDefinition.offload flag

**Goal:** Define the serializable context type and the opt-in flag.

**Requirements:** R9, R10

**Dependencies:** None

**Files:**
- `electron/src/main/tools/types.ts` — add `offload?: boolean` to `ToolDefinition`, add `WorkerToolContext` interface, add `toWorkerContext(ctx, config)` helper
- `electron/src/shared/types/tool-result.ts` — no changes needed (handler outcome already JSON-safe)

**Approach:**
- `WorkerToolContext` contains: `cwd: string`, `config: Config` (the frozen, secret-free config object already used by indexers). No `ProjectRuntime`, no `AbortSignal`.
- `toWorkerContext(ctx: ToolExecutionContext): WorkerToolContext` extracts `cwd` and resolves config via `ctx.projectRuntime?.config ?? getConfig()`.
- `offload?: boolean` on `ToolDefinition` defaults to `false` (undefined = main thread).

**Patterns to follow:** `RagWorkerStartData` (rag/indexer.ts) for serializable worker input shape. `noTimeout?: boolean` on `ToolDefinition` for the flag pattern.

**Test scenarios:**
- `toWorkerContext` extracts cwd and config from a full context
- `toWorkerContext` falls back to `getConfig()` when `projectRuntime` is absent
- `WorkerToolContext` is JSON-serializable (round-trip through `structuredClone`)
- `offload` flag defaults to falsy when unset

**Verification:** Types compile. Unit tests pass.

### U2. Worker pool infrastructure

**Goal:** A reusable, bounded worker thread pool with task queue, crash recovery, and clean shutdown.

**Requirements:** R5, R6, R7, R8

**Dependencies:** None (parallel with U1)

**Files:**
- `electron/src/main/utils/worker-pool.ts` — new file: `WorkerPool` class
- `electron/tests/unit/worker-pool.test.ts` — new file

**Approach:**
- `WorkerPool` constructor: `(workerScript: string, size: number, workerData?: unknown)`
- Creates `size` workers on `init()`, each sends `{ type: 'ready' }` when initialized
- `run<T>(message: unknown): Promise<T>` — enqueues a task, dispatches to next idle worker, returns a promise resolved by the worker's response
- Task tracking: `Map<number, { resolve, reject, workerId }>` keyed by monotonic `taskId`
- Worker crash (`'error'` or unexpected `'exit'`): reject in-flight task, spawn replacement worker
- `terminate(workerId)`: `worker.terminate()`, reject in-flight task, spawn replacement
- `dispose()`: terminate all workers, reject all queued tasks with `PoolDisposedError`
- Worker script receives `workerData` at construction (config, etc.)
- Message protocol: `{ type: 'execute', taskId, ...payload }` in, `{ type: 'result'|'error', taskId, ... }` out

**Patterns to follow:** `runIndexInWorker` (rag/indexer.ts:425-505) for Worker creation options (`{ workerData, env: process.env }`), message handling, and error/exit handling.

**Test scenarios:**
- Pool creates N workers and waits for ready signals
- Tasks are dispatched to idle workers and results returned
- Tasks queue when all workers are busy, dispatched in FIFO order
- Worker crash rejects the in-flight task and spawns a replacement
- `terminate(workerId)` kills the worker, rejects its task, spawns replacement
- `dispose()` terminates all workers and rejects queued tasks
- Pool handles concurrent tasks across multiple workers
- Pool with size 1 serializes tasks correctly

**Verification:** Unit tests pass with a trivial echo worker script. No orphaned workers after dispose.

### U3. Tool worker entry point

**Goal:** A worker script that loads the builtin tool registry and executes tool handlers on demand.

**Requirements:** R1, R4, R10

**Dependencies:** U1 (WorkerToolContext type)

**Files:**
- `electron/src/main/tools/tool-worker.ts` — new file: worker entry point
- `electron/tests/unit/tool-worker.test.ts` — new file

**Approach:**
- On load: read `workerData` (contains `config`), call `ConfigManager.load(config)` to set up the config singleton in the worker isolate, create a builtin tool registry via `createBuiltinToolRegistry()` (no `ProjectRuntime` needed — the registry only needs definitions + handlers)
- Listen for `{ type: 'execute', taskId, toolName, args, context: WorkerToolContext }` messages
- Look up handler in registry, call `handler(args, { cwd: context.cwd, projectRuntime: undefined, abortSignal: undefined })` — the handler receives a minimal `ToolExecutionContext` with only `cwd` set. `getToolConfig(ctx)` falls back to `getConfig()` which was loaded from `workerData`.
- Post `{ type: 'result', taskId, result }` or `{ type: 'error', taskId, error }` back
- Post `{ type: 'ready' }` after initialization

**Patterns to follow:** `rag/index-worker.ts` (78 lines) and `ast/index-worker.ts` (72 lines) for the entry point structure: read `workerData`, initialize, listen on `parentPort`, post typed messages.

**Test scenarios:**
- Worker initializes, loads registry, signals ready
- Worker executes `glob` handler with `{ cwd, pattern }` and returns correct results
- Worker executes `grep` handler and returns matches
- Worker returns `{ type: 'error' }` for unknown tool names
- Worker returns `{ type: 'error' }` for handler exceptions
- Config values (e.g., `grep_max_results`) are respected in the worker

**Verification:** Integration test spawns a real worker, sends a glob task, receives results.

### U4. Dispatch integration in executeToolCall

**Goal:** Route offloaded tools to the worker pool instead of inline execution.

**Requirements:** R1, R2, R3, R9, R11

**Dependencies:** U1, U2, U3

**Files:**
- `electron/src/main/llm/tool-dispatch.ts` — modify `executeToolCall` to check `definition.offload` and dispatch to pool
- `electron/src/main/llm/tool-pool.ts` — new file: singleton pool accessor, `getToolWorkerPool()`, `initToolWorkerPool()`, `disposeToolWorkerPool()`
- `electron/tests/unit/tool-dispatch-offload.test.ts` — new file

**Approach:**
- `tool-pool.ts`: lazy singleton `WorkerPool` instance. `initToolWorkerPool(config)` creates the pool with the tool-worker script path and config as `workerData`. `disposeToolWorkerPool()` for app shutdown. `getToolWorkerPool()` returns the instance or `null` if not initialized.
- In `executeToolCall`, after permission check and context construction (line ~294), replace:
  ```
  result = await runWithToolTimeout(() => registered.handler(handlerArgs, toolCtx), ...)
  ```
  with:
  ```
  if (registered.definition.offload && getToolWorkerPool()) {
    const workerCtx = toWorkerContext(toolCtx);
    result = await runWithToolTimeout(
      () => getToolWorkerPool()!.run({ toolName: name, args: handlerArgs, context: workerCtx }),
      name, { timeoutSeconds, noTimeout, abortController: timeoutAbort }
    );
  } else {
    result = await runWithToolTimeout(() => registered.handler(handlerArgs, toolCtx), ...);
  }
  ```
- On abort (`timeoutAbort` fires): call `pool.terminate(workerId)` to kill the worker executing this task. The pool spawns a replacement.
- Fallback (R11): if `getToolWorkerPool()` returns `null` (bundle missing, init failed), fall through to inline execution. Log a warning.
- Wire `initToolWorkerPool` into app startup (main/index.ts) and `disposeToolWorkerPool` into `app.on('before-quit')`.

**Patterns to follow:** The existing `runWithToolTimeout` wrapper stays unchanged — it wraps the pool's `run()` promise the same way it wraps the inline handler promise. The indexer fallback pattern (rag/indexer.ts:433-446) for graceful degradation.

**Test scenarios:**
- Offloaded tool executes in worker and returns correct result
- Non-offloaded tool executes inline as before
- Offloaded tool with missing pool falls back to inline execution
- Timeout fires → worker is terminated → task rejects with timeout error → replacement worker spawned
- Abort signal fires → worker is terminated → task rejects with cancellation error
- Permission check still runs on main thread before worker dispatch
- Result finalization and output offloading still run on main thread after worker returns
- Concurrent offloaded tool calls are distributed across pool workers

**Verification:** Integration test: send a grep tool call through `executeToolCall` with `offload: true`, verify result matches inline execution. Verify main thread event loop is not blocked during execution (e.g., a `setImmediate` callback fires during the tool call).

### U5. Flag CPU-heavy tools for offloading

**Goal:** Set `offload: true` on the tool definitions that benefit from worker execution.

**Requirements:** R1, R4

**Dependencies:** U4

**Files:**
- `electron/src/main/tools/search/grep.ts` — add `offload: true` to definition
- `electron/src/main/tools/filesystem/glob.ts` — add `offload: true`
- `electron/src/main/tools/filesystem/read.ts` — add `offload: true`
- `electron/src/main/tools/rag/search.ts` — add `offload: true`
- `electron/src/main/tools/ast/get-file-skeleton.ts` — add `offload: true`
- `electron/src/main/tools/ast/replace-symbol.ts` — add `offload: true`
- `electron/tests/unit/tool-offload-flags.test.ts` — new file

**Approach:**
- Add `offload: true` to each tool's `ToolDefinition` object literal.
- Tools NOT flagged (with reasons):
  - `get_function` — module-level `sentHashes` state (KTD-6)
  - `find_symbol_references`, `rename_symbol` — call `ensureIndexed()` → nested workers (KTD-7)
  - `execute_command`, `web_fetch`, subagent tools — already async
  - `write`, `edit`, `apply_patch` — mutation tools with `atomicWrite`, fast enough
  - `todo_*`, `skill`, `ask_question` — in-memory, trivial
  - `rag_index`, `ast_index` — already use their own workers
  - MCP tools — need MCP manager on main

**Patterns to follow:** `noTimeout: true` flag on AST tool definitions for the flag placement pattern.

**Test scenarios:**
- Flagged tools have `offload: true` in their definitions
- Non-flagged tools do not have `offload` set
- Each flagged tool produces identical output when run inline vs in worker (parity test)
- `grep` with a catastrophic backtracking pattern in worker doesn't freeze main thread (main-thread responsiveness assertion)

**Verification:** Parity tests pass. Manual test: run a `glob **/*` on a project with `node_modules` — UI stays responsive.

### U6. App lifecycle integration and pool configuration

**Goal:** Wire pool init/dispose into the Electron app lifecycle and make pool size configurable.

**Requirements:** R5, R7

**Dependencies:** U4

**Files:**
- `electron/src/main/index.ts` — call `initToolWorkerPool()` during startup, `disposeToolWorkerPool()` on quit
- `electron/src/main/config/schema.ts` — add `tool_worker_pool_size` config field (default: 2)
- `electron/tests/unit/tool-pool-lifecycle.test.ts` — new file

**Approach:**
- `initToolWorkerPool(config)` called after config is loaded, before first chat turn. Uses `config.tool_worker_pool_size ?? 2` for pool size.
- `disposeToolWorkerPool()` called in `app.on('before-quit')` handler alongside existing cleanup.
- Pool script path resolved via `path.join(__dirname, 'tool-worker.js')` — same pattern as indexers.
- If the worker script doesn't exist (dev mode without build), log a warning and skip pool init (fallback to inline per R11).

**Patterns to follow:** `initUpdater()` call in index.ts for startup wiring. `app.on('before-quit')` for shutdown cleanup.

**Test scenarios:**
- Pool initializes on app startup with configured size
- Pool disposes on app quit — no orphaned workers
- Missing worker script → pool not initialized → tools fall back to inline
- Config `tool_worker_pool_size: 3` creates 3 workers
- Config `tool_worker_pool_size: 0` disables the pool (all inline)

**Verification:** App starts and quits cleanly with pool. `ps` shows no orphaned worker processes after quit.

## Risks & Dependencies

**Risk: tree-sitter native module in worker.**
AST tools use `tree-sitter` (native `.node` addon). Native modules must be loaded in each worker thread. The `env: process.env` worker option (used by indexers) ensures native module resolution works. If tree-sitter's initialization is slow, the first AST tool call per worker pays a one-time cost. Mitigation: pool workers are persistent, so this cost is paid once per worker, not per call.

**Risk: ONNX runtime in worker for rag_search.**
`rag_search` creates an `Embedder` which loads an ONNX model. The ONNX session is per-worker (not shared with main or indexers). First call per worker pays model load cost. Mitigation: same as tree-sitter — persistent workers amortize this. The main-thread ONNX session (used today) is eliminated, freeing main-thread memory.

**Risk: `replace_symbol` writes files from a worker.**
`replace_symbol` uses `fs.writeFileSync` and `atomicWrite`. File writes from workers are safe (Node.js `fs` is thread-safe for independent paths). The permission gate already ran on main before dispatch, so the write is authorized. No additional risk.

**Risk: config drift between main and workers.**
Workers receive config at pool init time. If the user changes config mid-session (via UI), workers have stale config. Mitigation: config changes are rare and typically require app restart. If needed, `disposeToolWorkerPool()` + `initToolWorkerPool(newConfig)` on config save. Not implemented in initial version.

**Dependency: Vite build must compile `tool-worker.ts` to `tool-worker.js`.**
The existing `index-worker.ts` files are compiled by the Vite build. `tool-worker.ts` must be added to the same build configuration. Check `electron/vite.config.ts` for how `index-worker.ts` entries are handled.

## Sources / Research

- Full code review findings: `/tmp/code-review/20260724-161351-3daed2a1/` (performance.json, adversarial.json)
- Tool architecture exploration: `ToolDefinition` (types.ts:43-78), `executeToolCall` (tool-dispatch.ts:132-372), `ToolExecutionContext` (types.ts:86-116)
- Existing worker pattern: `runIndexInWorker` (rag/indexer.ts:425-505), `index-worker.ts` (rag, ast)
- CPU-heavy tool context usage: all 6 offload candidates use only `ctx.cwd` + config values
- `getToolConfig(ctx)` fallback: types.ts:126 — `ctx.projectRuntime?.config ?? getConfig()`
- `get_function` state: `sentHashes` Map at get-function.ts:52
- `ensureIndexed()` nesting: find-symbol-references.ts, rename-symbol.ts
- AbortSignal gap: types.ts:111-114 documents that sync FS tools don't cooperatively cancel
