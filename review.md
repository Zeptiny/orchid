# Orchid Performance and UI Responsiveness Review

**Date:** 2026-07-26  
**Baseline:** `main` at `14a4df1`  
**Scope:** Electron main process, renderer, streaming IPC, subagent execution, persistence, worker scheduling, cancellation, and long-lived resource retention.  
**Method:** Read-only static review with independent renderer-race, main-process performance, subagent architecture, reliability, and measurement passes. No runtime benchmark was executed, so findings distinguish directly provable work amplification from load-dependent risks that still require profiling.

## Verdict

Orchid already contains several important responsiveness protections, but it can still freeze or become progressively laggy under long streams, tool-heavy histories, and concurrent subagents. The dominant issue is not simply missing worker threads. It is **cumulative-state amplification**: several hot paths repeatedly copy, serialize, validate, persist, or render the complete accumulated state when only a small delta changed.

The highest-leverage corrections are:

1. Avoid full Markdown parsing and syntax highlighting on every streaming frame.
2. Replace full subagent projections/checkpoints with delta-oriented live events and incremental persistence.
3. Stop subagent-only updates from invalidating the main transcript.
4. Fix worker cancellation/health behavior and offload the remaining unbounded synchronous operations.

No P0 data-loss or security-critical performance defect was identified. This report contains **7 P1 findings** and **9 P2 findings**.

## Existing safeguards to preserve

The following mechanisms are already present and should be extended rather than replaced:

- A configurable tool worker pool, default size 2 and maximum 8, is initialized in `electron/src/main/index.ts:260` and used by dispatch in `electron/src/main/llm/tool-dispatch.ts:345`.
- `read`, `grep`, `glob`, `rag_search`, `get_file_skeleton`, and `replace_symbol` opt into worker execution.
- Full RAG and AST project indexing normally runs in dedicated workers.
- Renderer text and thinking deltas are buffered through `requestAnimationFrame` in `electron/src/renderer/hooks/useChat.ts:551`.
- Committed chat history and the live tail are derived separately in `electron/src/renderer/components/ChatStream.tsx:256`.
- Subagent event delivery is coalesced to one full projection per subagent every 16–50 ms in `electron/src/main/ipc/subagents.ts:67`.
- Ordinary subagent persistence is debounced to two seconds per session in `electron/src/main/agents/persist-subagent-chains.ts:17`.
- Normal session lifecycle persistence is incremental rather than rewriting every historical chain.
- Background command output and the RAG search cache have explicit size bounds.

These safeguards control cadence and some workloads. They do not yet bound the amount of accumulated data rebuilt or transmitted at each cadence.

## Systemic hot paths

### Main-agent streaming

```text
provider delta
  -> copy complete accumulated response in the agent machine
  -> send incremental CHAT_CHUNK
  -> renderer publishes another frame
  -> parse and highlight the complete Markdown prefix
```

### Subagent streaming

```text
provider delta
  -> append into several growing strings
  -> clone complete live segments/tool snapshots
  -> coalesce after the full projection has already been rebuilt
  -> send complete projection plus durable record
  -> replace renderer record state and invalidate chat-history dependencies
  -> every ~2s serialize all subagent histories into one SQLite JSON column
```

## Detailed findings

### F-02 — Streaming Markdown reparses and highlights the complete prefix every frame

**Severity:** P1  
**Confidence:** High; the full parser dependency is the growing content string.  
**Primary files:**

- `electron/src/renderer/components/MarkdownContent.tsx:91`
- `electron/src/renderer/components/MarkdownContent.tsx:95`
- `electron/src/renderer/hooks/useChat.ts:595`
- `electron/tests/unit/chat-rendering-contract.test.ts:215`

**Evidence and impact**

Text updates are correctly frame-batched, but every changed content string runs the full CommonMark, GFM, and `rehype-highlight` pipeline over the entire accumulated answer. `useMemo` only avoids work when the content string is unchanged; streaming changes it on every published frame.

Long code blocks, tables, deeply nested lists, or high token rates therefore create increasing renderer work per frame. This can produce dropped frames and UI freezes even after the main-process IPC amplification is fixed.

**Recommended fix**

1. Give `MarkdownContent` an explicit streaming mode.
2. While streaming, render a lightweight representation of the active trailing segment, or debounce full Markdown work to a bounded cadence such as 100–250 ms.
3. Disable syntax highlighting for the actively changing block and apply it when the segment settles.
4. Preserve the current full Markdown renderer for committed messages.
5. If partial Markdown fidelity is required, memoize stable parsed blocks and reparse only the active suffix.

**Verification**

Stream 64 KB, 128 KB, and 256 KB responses containing fenced TypeScript and GFM tables at 50–60 updates per second. Capture React commit duration, Chromium long tasks, scripting time, layout time, and dropped frames.

---

### F-04 — Subagent live events rebuild and transmit complete cumulative state

**Severity:** P1  
**Confidence:** High; confirmed independently across main, IPC, and renderer.  
**Primary files:**

- `electron/src/main/agents/manager.ts:768`
- `electron/src/main/agents/manager.ts:1031`
- `electron/src/main/agents/manager.ts:1061`
- `electron/src/main/ipc/subagents.ts:41`
- `electron/src/main/ipc/subagents.ts:67`
- `electron/src/renderer/utils/subagent-stream.ts:136`
- `electron/src/renderer/components/ChatStream.tsx:261`

**Evidence and impact**

Every content delta is appended to `responseText`, `resultText`, `stepText`, and the latest live segment. `_updateLive` then clones complete segment and tool-call arrays. Coalescing happens only after this cumulative projection has already been rebuilt.

Each delivered event contains the complete projection plus a freshly materialized durable record and chain. The renderer maps the full record array and changes record identities even for projection-only changes. Because `ChatStream` depends on the `subagents` array for usage attribution, live subagent text can invalidate the main transcript when no visible chat content changed.

The cost scales with active subagents, accumulated transcript bytes, and frame rate. Four long-running subagents can make the main chat janky even while the main agent is idle.

**Recommended fix**

1. Seed the durable subagent record once at spawn or snapshot hydration.
2. Send content, thinking, tool-argument, and tool-result deltas while running.
3. Send usage snapshots at a slower cadence and a complete durable record only at terminal handoff.
4. Apply a global event/byte budget per frame, not only one event per subagent.
5. Keep durable records referentially stable for projection-only events.
6. Pass `ChatStream` a separately memoized, low-frequency subagent usage summary instead of the full record array.
7. Byte-bound hydration buffering; if the bound is exceeded, discard intermediate cumulative events and request a fresh snapshot.

**Verification**

Run 1, 4, 8, and 16 synthetic subagents producing 100,000 small deltas each. Measure main-process allocation, IPC bytes/sec, preload validation time, React commits, and main-chat history recomputations.

---

### F-05 — Subagent checkpoints synchronously rewrite complete history

**Severity:** P1  
**Confidence:** High for write amplification; runtime pause duration requires measurement.  
**Primary files:**

- `electron/src/main/agents/wire-subagents.ts:31`
- `electron/src/main/agents/persist-subagent-chains.ts:17`
- `electron/src/main/agents/persist-subagent-chains.ts:82`
- `electron/src/main/agents/manager.ts:1107`
- `electron/src/main/session/manager.ts:794`
- `electron/src/main/session/storage.ts:222`
- `electron/src/main/session/storage.ts:478`
- `electron/src/renderer/hooks/useSubagents.ts:169`

**Evidence and impact**

Every live update marks a session dirty. The two-second scheduler limits frequency, but each flush still scans manager records, materializes complete chains plus live tails, merges the full stored list, JSON-stringifies the entire subagent history, and synchronously updates one SQLite column on Electron's main thread.

Terminal events flush immediately, then broadcast `SESSION_SUBAGENTS_CHANGED`; the renderer responds by requesting another full snapshot even though it already received the terminal event. Several near-simultaneous completions can trigger repeated complete serialization and hydration.

The expected symptom is periodic hitching during long subagent runs and completion waves.

**Recommended fix**

1. Normalize subagent records/chains into independently updateable rows, or at minimum persist only dirty subagent IDs.
2. Update one running record per checkpoint rather than replacing the session-wide JSON document.
3. Move serialization and durable writes off the Electron main event loop where practical.
4. Batch terminal completion waves into one bounded flush.
5. Do not issue a post-terminal full snapshot when the terminal event already contains authoritative state.
6. Record checkpoint bytes and duration for diagnostics.

**Verification**

Benchmark 1/4/8/16 subagents with 1 KB, 100 KB, and 1 MiB transcripts. Measure each checkpoint duration, bytes serialized, SQLite write time, event-loop p99/max, and redundant snapshot count.

---

### F-06 — Subagent and shared-resource concurrency has no aggregate admission or fairness

**Severity:** P2  
**Confidence:** High for missing bounds; user impact is load-dependent.  
**Primary files:**

- `electron/src/main/agents/manager.ts:247`
- `electron/src/main/tools/subagent/delegate.ts:126`
- `electron/src/main/config/schema.ts:198`
- `electron/src/main/utils/worker-pool.ts:66`
- `electron/src/main/llm/tool-dispatch.ts:339`
- `electron/src/main/mcp/manager.ts:234`

**Evidence and impact**

Every spawn begins immediately. There is no active or queued subagent limit per process, session, connection, or provider. Recursive fan-out is correctly forbidden, but concurrent sessions and windows can still multiply provider streams, retries, worker tasks, foreground processes, and MCP calls.

The worker pool is bounded, but its FIFO queue is unbounded and offers no fairness or reserved main-agent capacity. Queue wait is included in the ordinary tool timeout, so main-agent tools may time out behind background subagent work.

**Recommended fix**

1. Put admission control in `SubagentManager`, not only in the delegation tool.
2. Add configurable global, per-session, and per-provider/connection active limits plus a bounded queue.
3. Schedule queued work fairly across sessions and preserve capacity or priority for the visible main agent.
4. Represent `queued` explicitly in runtime and UI state.
5. Separate queue-wait time from execution timeout and expose both.
6. Add per-MCP-server and aggregate foreground-command semaphores.
7. Coordinate provider retry/backoff per connection to avoid synchronized retry storms.

Exact default limits should be chosen from controlled 1/4/8/16-agent benchmarks rather than guessed from static analysis.

**Verification**

Saturate a size-two worker pool from multiple sessions and verify bounded queue length, fair service, reserved main-agent progress, distinct queue/execution timings, and deterministic rejection when capacity is exhausted.

---

### F-07 — Completed subagents and prompt context accumulate indefinitely

**Severity:** P2  
**Confidence:** Medium-high; retention is directly visible, long-term impact is load-dependent.  
**Primary files:**

- `electron/src/main/agents/manager.ts:138`
- `electron/src/main/agents/manager.ts:298`
- `electron/src/main/agents/manager.ts:698`
- `electron/src/main/agents/manager.ts:918`
- `electron/src/main/llm/build-prompt-context.ts:102`
- `electron/src/main/llm/system-prompt.ts:147`
- `electron/src/main/ipc/session.ts:360`

**Evidence and impact**

The process-global manager adds each record but has no pruning or removal API. Terminal records retain chains, messages, tool results, project runtimes, agent metadata, live projections, and resolved `_runPromise` references. Session deletion stops work and removes session storage but does not purge manager records.

Snapshot and persistence operations repeatedly traverse this growing map. Prompt-context generation also scans terminal records and emits complete task descriptions without a recency bound, increasing model tokens, latency, and cost.

**Recommended fix**

1. After authoritative terminal persistence, evict heavy runtime chain/live/project data or remove the runtime record entirely.
2. Keep only a bounded recent terminal summary cache if live UI continuity requires it.
3. Purge all records, tool history, and scope context owned by a deleted session.
4. Set `_runPromise` to `null` after settlement.
5. Include only active plus a bounded recent/acknowledged set in prompt context; summarize rather than repeat full task text.

**Verification**

Complete thousands of subagents, delete their sessions, and assert bounded `allRecords()` size, stable post-GC heap, bounded snapshot/persistence duration, and stable subagent prompt token contribution.

---

### F-08 — Large canonical tool results remain duplicated across persistence and IPC

**Severity:** P1  
**Confidence:** High; the complete payload remains on every path.  
**Primary files:**

- `electron/src/main/llm/tool-dispatch.ts:403`
- `electron/src/main/llm/tool-dispatch.ts:565`
- `electron/src/main/llm/tool-dispatch.ts:883`
- `electron/src/main/ipc/chat.ts:1658`
- `electron/src/main/llm/message-factories.ts:113`
- `electron/src/main/session/storage.ts:207`
- `electron/src/main/ipc/session.ts:267`

**Evidence and impact**

Tool-output offloading bounds the model-facing `agentProjection`, but the complete canonical result remains embedded in persisted tool-result messages and IPC updates. Oversized projection caching synchronously writes the payload and immediately reads it back for verification on the main event loop.

Session open can return history both inside `session.chains` and as a flattened `messages` array. Tool-heavy sessions with repeated 1–5 MiB canonical results therefore suffer pauses at tool completion, turn finalization, and cold session hydration, along with heap and database growth.

**Recommended fix**

1. Add a typed durable large-result reference containing an opaque cache ID, size, digest, bounded summary, and retrieval metadata.
2. Persist/cache the complete canonical payload once.
3. Carry only the typed reference and bounded display summary through session rows and ordinary IPC.
4. Retrieve full data lazily for expansion, copy, or detail actions.
5. Avoid returning the same history in both `Session.chains` and a second flattened message list.
6. Move cache writes and integrity verification off the main event loop or use asynchronous durable APIs.

**Verification**

Create sessions containing 25, 50, and 100 synthetic 1 MiB tool results. Measure tool-finalization latency, database size, cold-open latency, serialized IPC bytes, peak heap/RSS, and event-loop delay.

---

### F-10 — Failed worker replacement can permanently strand queued tools

**Severity:** P1  
**Confidence:** High; replacement failure only logs.  
**Primary files:**

- `electron/src/main/utils/worker-pool.ts:82`
- `electron/src/main/utils/worker-pool.ts:214`
- `electron/src/main/utils/worker-pool.ts:226`
- `electron/src/main/utils/worker-pool.ts:228`
- `electron/src/main/tools/ast/get-file-skeleton.ts:43`

**Evidence and impact**

If a worker crashes and its replacement fails to become available, capacity is permanently reduced. The failure is logged, but queued tasks are neither rejected nor moved to a healthy fallback. If all workers are lost, no-timeout tools can remain pending until application restart.

Worker initialization also has no readiness deadline; a worker that starts but never posts `ready` can hang application startup.

**Recommended fix**

1. Track healthy, starting, and failed pool capacity explicitly.
2. Apply a worker-readiness timeout.
3. Use bounded replacement retries with jitter.
4. Open a circuit after repeated failures and reject queued/future tasks with a typed `WorkerPoolUnavailableError`.
5. Consider inline fallback only for demonstrably bounded tools; never silently run known freeze-prone operations inline.
6. Expose degraded pool health to logging and the UI.

**Verification**

Test worker crash, failed replacement, zero remaining capacity, already-aborted tasks, readiness timeout, queue rejection, recovery, and clean disposal without orphan workers.

---

### F-11 — `get_function` can block Electron indefinitely on large source files

**Severity:** P1  
**Confidence:** Medium-high; the operation is synchronous and unbounded.  
**Primary files:**

- `electron/src/main/tools/ast/get-function.ts:45`
- `electron/src/main/tools/ast/get-function.ts:95`
- `electron/src/main/ast/parser.ts:297`
- `electron/src/main/config/schema.ts:150`

**Evidence and impact**

`get_function` synchronously reads and parses the selected file on Electron's main thread. It disables the outer timeout, does not opt into worker execution, and does not enforce `ast_max_file_size` before reading/parsing.

A large minified or pathological supported-language file can block every window, IPC callback, cancellation request, and watchdog timer until parsing completes.

**Recommended fix**

1. Enforce `ast_max_file_size` before reading the file.
2. Move parsing and extraction into the tool worker pool.
3. Ensure combined parent/timeout cancellation can terminate the worker.
4. Bound the process-global `sentHashes` cache and clear it when sessions/workspaces are released.

**Verification**

Run against 1 MB, 10 MB, and pathological minified files while a 16 ms main-thread heartbeat is active. Verify bounded rejection for oversized files and responsive worker execution for accepted files.

---

### F-12 — `rename_symbol` performs project-wide synchronous reads and durable writes

**Severity:** P2  
**Confidence:** High for blocking behavior; typical workload size is unknown.  
**Primary files:**

- `electron/src/main/tools/ast/rename-symbol.ts:37`
- `electron/src/main/tools/ast/rename-symbol.ts:75`
- `electron/src/main/tools/ast/rename-symbol.ts:102`
- `electron/src/main/tools/ast/rename-symbol.ts:168`
- `electron/src/main/tools/ast/utils.ts:48`

**Evidence and impact**

`rename_symbol` is exempt from timeout and remains on the main process. It locates every reference, reads every affected file synchronously, retains old and new contents during planning, then performs synchronous durable writes with file and directory fsync work.

Renaming a common symbol across hundreds or thousands of files can create a hard UI freeze and substantial temporary memory usage.

**Recommended fix**

1. Execute rename planning and durable writes in a dedicated serialized mutation worker or worker queue.
2. Add cooperative cancellation and progress boundaries between files.
3. Bound the maximum file count/bytes in one operation or require explicit confirmation for exceptional scope.
4. Avoid retaining duplicate full contents for every file when rollback is not actually implemented.

**Verification**

Generate indexed projects with 100, 1,000, and 10,000 referencing files. Measure total time, main-loop maximum stall, cancellation latency, peak RSS, and per-file fsync time on fast and slow filesystems.

---

### F-13 — `web_fetch` converts and caches large HTML synchronously on the main process

**Severity:** P2  
**Confidence:** High for blocking work; impact depends on response size/shape.  
**Primary files:**

- `electron/src/main/tools/web/fetch.ts:118`
- `electron/src/main/tools/web/fetch.ts:162`
- `electron/src/main/tools/web/fetch.ts:204`
- `electron/src/main/tools/web/fetch.ts:303`
- `electron/src/main/config/schema.ts:200`

**Evidence and impact**

The network wait is asynchronous, but after download Orchid materializes the complete body, decodes it, runs Turndown synchronously, and may durably cache it with synchronous file operations. The configured body limit is 10 MiB.

Large or structurally complex HTML can freeze the UI immediately after the download completes and delay Esc/cancel handling.

**Recommended fix**

1. Transfer the downloaded buffer to a worker for decoding, Turndown conversion, and cache creation.
2. Use asynchronous durable file APIs if caching remains in the main process.
3. Add independent conversion and cache-write timeouts/cancellation.
4. Retain the existing body-size cap and bounded inline result.

**Verification**

Serve deterministic 1/5/10 MiB fixtures, including deeply nested and table-heavy HTML. Measure conversion CPU, cache-write duration, event-loop p99/max, memory, and cancellation latency.

---

### F-14 — Every streaming frame still remaps the visible transcript

**Severity:** P2  
**Confidence:** Medium-high; scaling needs React profiling.  
**Primary files:**

- `electron/src/renderer/components/ChatStream.tsx:53`
- `electron/src/renderer/components/ChatStream.tsx:382`
- `electron/src/renderer/components/ChatStream.tsx:394`
- `electron/src/renderer/components/ChatStream.tsx:550`

**Evidence and impact**

History construction is memoized separately, which is good, but every live frame still spreads history and live items into a new array, creates React elements for every visible row, and reconciles the entire keyed sequence. The newest 20 chains remain fully mounted, and legacy mega-chains have no item-level windowing.

`MessageWidget` memoization avoids some deep work but cannot remove the O(visible item count) parent traversal.

**Recommended fix**

1. Isolate stable history behind a memoized history component or memoized node sequence.
2. Keep the live tail and active footer in a small independently updating subtree while preserving live-to-committed key continuity.
3. After measurement, add `content-visibility` or windowing for old chain bodies if commit duration still exceeds budget.
4. Prefer a small local boundary before introducing a virtualization dependency.

**Verification**

Profile 100, 1,000, 2,000, and 5,000 visible items during a fixed 60-frame stream. Chart commit duration and verify stable-history components do not rerender for live-only deltas.

---

### F-15 — Collapsed tool results eagerly create their full hidden DOM

**Severity:** P1  
**Confidence:** High; children always mount.  
**Primary files:**

- `electron/src/renderer/components/ui/CollapsibleRegion.tsx:34`
- `electron/src/renderer/components/ToolResults/ToolResultShell.tsx:96`
- `electron/src/renderer/components/ToolResults/ToolResultShell.tsx:145`
- `electron/src/renderer/components/ToolResults/FileContentToolResult.tsx:54`
- `electron/src/renderer/components/ToolResults/diff-view.tsx:42`

**Evidence and impact**

Closed disclosures remain mounted for animation/state preservation. `ToolResultShell` also builds the result body before passing it into the closed region. Tool-heavy histories therefore create every hidden file line, search result, directory row, and diff line during hydration.

The UI looks compact while retaining a large invisible DOM and parsing/render cost.

**Recommended fix**

1. Add a `lazyMount` or equivalent mode to `CollapsibleRegion`/`ToolResultShell`.
2. Do not instantiate the result body until first expansion.
3. After first expansion, keep it mounted if state preservation and collapse animation require it.
4. Apply the same behavior to collapsed tool-activity groups.
5. Bound the module-global expansion-state map or clear it on session disposal.

**Verification**

Load 20 chains containing 50 large read/diff results each. Compare session-switch scripting time, node count, heap, and first-expansion latency before and after lazy mounting.

---

### F-17 — Historical or missing background commands can poll forever

**Severity:** P2  
**Confidence:** High; “not found” is represented as “still running.”  
**Primary files:**

- `electron/src/main/ipc/chat.ts:2008`
- `electron/src/main/ipc/chat.ts:2015`
- `electron/src/renderer/hooks/useLiveCommandOutput.ts:84`
- `electron/src/renderer/hooks/useLiveCommandOutput.ts:96`
- `electron/src/renderer/hooks/useLiveCommandOutput.ts:142`

**Evidence and impact**

When a command is absent after restart, eviction, or session mismatch, snapshot IPC returns `{ tail: '', exitCode: null }`. The renderer interprets `exitCode: null` as still running and polls every 200 ms indefinitely.

Each stale widget adds five IPC round trips per second. Large histories can steadily degrade both processes without any visible progress.

**Recommended fix**

1. Make the snapshot response discriminated: `{ found: false }` or `{ found: true, tail, exitCode }`.
2. Stop polling immediately on `found: false` and render a historical/unavailable state.
3. Poll only visible or expanded command widgets.
4. Consider centralizing polling so multiple widgets share one bounded scheduler.

**Verification**

Persist a background-command widget, restart with an empty store, mount the history, and assert that polling stops after the first not-found response.

---

### F-18 — RAG download/body stalls can hold indexing indefinitely

**Severity:** P2  
**Confidence:** High for missing deadlines.  
**Primary files:**

- `electron/src/main/rag/embedder.ts:272`
- `electron/src/main/rag/embedder.ts:589`
- `electron/src/main/rag/indexer.ts:181`
- `electron/src/main/rag/indexer.ts:461`

**Evidence and impact**

First-use model downloads do not have an end-to-end request/body timeout. API embedding clears its timeout after headers, before fully consuming the body. The indexing worker itself has no watchdog. A server can accept a connection and then stall the body indefinitely, leaving the project registered as actively indexing and blocking subsequent attempts until restart.

**Recommended fix**

1. Keep an abort deadline active through complete body consumption.
2. Add download inactivity and total-duration limits.
3. Add a worker watchdog and explicit cancellation path.
4. On timeout/cancel, terminate the worker, remove temporary files, reject the request, and release `activeIndexes` in every path.

**Verification**

Use fetch fixtures that return headers and then never yield a body. Assert bounded rejection, worker termination, temporary-file cleanup, and immediate ability to start another index.

---

### F-19 — Retry backoff can issue new provider attempts after cancellation

**Severity:** P2  
**Confidence:** Medium-high; backoff sleep is not abortable.  
**Primary files:**

- `electron/src/main/llm/middleware/retry.ts:112`
- `electron/src/main/llm/middleware/retry.ts:131`
- `electron/src/main/llm/middleware/retry.ts:178`
- `electron/src/main/utils/async.ts:17`

**Evidence and impact**

Retry middleware uses a plain `setTimeout` sleep and does not check the call's abort signal before the next setup or mid-stream retry. Cancelling during backoff can therefore leave the retry task alive and cause another provider request for a turn the user considers stopped.

With many subagents, transient provider failures can amplify into detached requests and synchronized retry pressure.

**Recommended fix**

1. Preserve the request `AbortSignal` in retry middleware.
2. Check it before every attempt and after every failure.
3. Replace plain sleep with an abortable delay.
4. Cancel the current stream reader on abort.
5. Coordinate connection-level retry timing and add jitter when many streams share a provider.

**Verification**

Force a transient failure, abort during backoff, advance fake timers, and assert that no additional `doStream` call occurs. Repeat for setup and mid-stream retry paths.

---

### F-20 — Permanent subagent persistence failures retry forever

**Severity:** P2  
**Confidence:** High; retries have no terminal state.  
**Primary files:**

- `electron/src/main/agents/persist-subagent-chains.ts:40`
- `electron/src/main/agents/persist-subagent-chains.ts:47`
- `electron/src/main/agents/persist-subagent-chains.ts:55`
- `electron/tests/unit/subagent-ipc.test.ts:170`

**Evidence and impact**

A failed checkpoint marks the session dirty again and reschedules indefinitely. Backoff reaches a two-second ceiling but attempts are unlimited. Permanent disk or database failures therefore retain timers and produce continuous write/log churn for every affected session.

**Recommended fix**

1. Add a bounded retry budget and circuit-breaker state per session.
2. After exhaustion, stop automatic retries and surface a degraded-persistence status.
3. Retry only on explicit user action, new durable activity, or a storage-recovery signal.
4. Clear retry state when a session is deleted or the app shuts down.
5. Preserve immediate recovery behavior for temporary failures.

**Verification**

Test temporary recovery and permanent failure separately. The permanent case must stop scheduling after the configured budget and release timers/maps cleanly.

## Additional watchlist items

These items were not promoted to primary findings because impact or provider behavior needs confirmation, but they should be covered by profiling and targeted tests:

- `electron/src/renderer/hooks/useSmartAutoScroll.ts:155` reads `scrollHeight` and scrolls on every content revision; Chrome tracing should confirm whether it forces layout once per frame.
- `electron/src/renderer/utils/subagent-stream.ts:169` buffers complete cumulative events during hydration with no byte/count bound.
- `electron/src/main/llm/orchestrator.ts:744` may overcount tools in flight if a provider emits duplicate tool-call alias events, potentially disabling the idle watchdog.
- `electron/src/main/updater.ts:171` has a separate updater-driven shutdown path that may bypass normal worker/MCP/accounting/logging cleanup.
- `electron/src/main/mcp/manager.ts:609` drops the runner reference after a shutdown timeout without proving the child transport stopped.
- RAG/AST workers emit progress without main-process coalescing; very large projects may create avoidable IPC load.
- `better-sqlite3` operations are synchronous and use a five-second busy timeout. Routine lock stalls were not proven, but operation-duration tracing should be added.
- Missing RAG/AST/tool-worker bundles fall back to inline execution. The degraded state is logged but not surfaced to the user.

## Recommended implementation order

### Batch 1 — Low-risk, immediate amplification fixes

1. F-17: stop polling missing background commands.

These changes are comparatively localized and should reduce unnecessary work without changing stored data formats.

### Batch 2 — Renderer streaming and hydration

1. F-02: add a lightweight/deferred streaming Markdown path.
2. F-15: lazy-mount collapsed tool-result bodies.
3. F-14: isolate stable history from the live tail.

Profile after each change; virtualization should be introduced only if stable-history isolation and lazy mounting do not meet the frame budget.

### Batch 3 — Subagent live/durable separation

1. F-04: change live IPC from cumulative projections to deltas.
2. F-05: persist dirty subagents incrementally and remove redundant snapshot refreshes.
3. F-06: introduce bounded admission/fair scheduling.
4. F-07: add runtime retention and prompt-context limits.

This is the most substantial architectural batch and should be designed as one coherent change because live events, durable handoff, persistence, and renderer selectors share one protocol boundary.

### Batch 4 — Large results and main-thread isolation

1. F-08: introduce durable large-result references and lazy IPC retrieval.
2. F-10: add worker readiness/health/circuit-breaker behavior.
3. F-11, F-12, F-13: bound or offload remaining synchronous AST and HTML work.

### Batch 5 — Cancellation and long-lived failure cleanup

1. F-18: end-to-end RAG download/body/worker deadlines.
2. F-19: abort-aware retry backoff.
3. F-20: bounded persistence recovery.
4. Address watchlist shutdown and MCP cleanup risks.

## Performance verification plan

### CI-safe behavioral tests

- Stream 2,000 committed messages plus 1,000 content/thinking/tool deltas under a fake `requestAnimationFrame`. Assert one publication per frame, exact final state, and no committed-history rebuild for live-only text.
- Saturate a size-two worker pool with eight jobs. Assert `activeCount <= 2`, bounded queue behavior, cancellation recovery, failed-respawn rejection, and complete cleanup.
- Exercise compiled RAG/AST worker boundaries and their missing-worker fallback explicitly.
- Verify subagent persistence work grows with dirty bytes/records rather than total historical transcript bytes.
- Verify closed tool disclosures do not mount result-row DOM until first expansion.
- Verify deleted sessions and completed subagents release runtime records, timers, worker tasks, and prompt context.

### Controlled local Electron profiles

- Load a 2,000-message tool-heavy transcript, stream 50 deltas/second for 60 seconds, switch sessions, type, scroll, and open Subagent View.
- Run 1/4/8/16 concurrent subagents with 1 KB/100 KB/1 MiB transcripts and completion waves.
- Hydrate sessions containing 25/50/100 one-MiB canonical tool results.
- Run AST/RAG indexing, `get_function`, `rename_symbol`, and 1/5/10 MiB `web_fetch` fixtures while sampling a 10–16 ms heartbeat.
- Run a 30-minute soak covering chats, session switches, subagents, background commands, RAG searches, index cancellation, and session deletion.

### Provisional responsiveness budgets

These should be calibrated per supported hardware/platform after baselines exist:

- Main-process event-loop delay: p99 below 50 ms; maximum below 200 ms during normal workloads.
- Renderer: no task above 200 ms; no more than five tasks above 50 ms per minute.
- Interaction latency: p95 at or below 100 ms during streaming.
- Renderer publication: no more than one state publication per animation frame for each live surface.
- Dropped-frame rate: below 1% in the controlled streaming profile.
- Soak retention: worker/child/native-handle counts return to baseline; main RSS growth below 50 MiB after warm-up and explicit GC in profiling builds.
- Incremental indexing: unchanged warm run no more than 25% of cold duration.

## Observability gaps

Orchid currently records some indexing durations and provider attempt timestamps, but no production responsiveness instrumentation was found for:

- Node event-loop delay/utilization;
- main/renderer memory and process metrics;
- worker queue depth and wait time;
- IPC events and bytes per second;
- SQLite and checkpoint duration/bytes;
- provider time-to-first-token and Orchid publication overhead;
- renderer long tasks, commit durations, forced layout, or dropped frames;
- retained subagent records/transcript bytes.

At minimum, profiling builds should add counters/timers at the main streaming, subagent event, checkpoint, worker queue, and renderer publication boundaries. Performance tests need behavioral and byte-volume assertions in addition to source-string contract tests.

## Completion criteria

The performance work should be considered complete only when:

1. Main and subagent streaming cost scales with newly produced bytes, not accumulated transcript size times event count.
2. Unrelated surfaces do not rerender for live events they do not display.
3. Large collapsed tool results do not create hidden DOM before first expansion.
4. Subagent and worker demand is bounded, fair, cancellable, and observable.
5. Session/subagent persistence updates dirty records rather than rewriting complete accumulated histories.
6. Large canonical results cross IPC and persistence by bounded summaries/references.
7. Remaining synchronous main-process operations have explicit size/time limits or worker isolation.
8. Runtime records, queues, timers, processes, and native resources return to a bounded baseline after completion, cancellation, deletion, and shutdown.
9. The controlled profiles meet the agreed responsiveness budgets on every supported platform class.
