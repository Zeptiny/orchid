# Session Loading and Switching Performance Review

| | |
|---|---|
| **Date** | 2026-08-13 |
| **Branch reviewed** | `fix/persist-and-reposition-chat-errors` @ `d2cb2b9` |
| **Scope** | Session list bootstrap, session open/switch, conversation hydration, subagent restoration, renderer first paint, and session-scoped follow-up requests |
| **Method** | Static code-path trace, relevant git-history review, aggregate inspection of a local development session database, and focused local microbenchmarks |
| **Change mode** | Report only; no application code changed |

## Executive summary

Orchid already made the most important first structural improvement: commit `23c7f81` collapsed session switching from three sequential IPC round-trips into one `session:open` request. The current path also preserves the prior session on load failure, reuses in-memory sessions, strips subagent transcripts from the renderer-facing session DTO, collapses older rendered chains, and memoizes message widgets.

The remaining bottleneck is not IPC call count. A session switch still performs too much hidden work before the one IPC response resolves:

1. A cold load reads and parses every main-chain message and every historical subagent transcript.
2. `session:open` then waits for every stored subagent record to be restored into the runtime manager.
3. Only after those steps does the renderer receive the visible conversation.
4. Committing the active session triggers another wave of session-scoped requests, including redundant todo and subagent loads.

The highest-value direction is therefore to define a narrow **session view** critical path: session metadata, the visible/recent conversation page, current todo state, workspace, and live turn state. Full conversation paging, subagent runtime restoration, and inspector data should be separately cached or hydrated after first paint, with correctness-sensitive tool and send paths awaiting readiness only when they actually need it.

### Priority summary

| ID | Priority | Finding | Main effect |
|---|---:|---|---|
| F1 | P0 | Cold session load parses all persisted subagent transcripts even though navigation strips them from the renderer DTO | Disk read, JSON parse, allocation, and garbage collection scale with hidden history |
| F2 | P0 | `session:open` awaits restoration of every stored subagent into the runtime manager | Visible navigation is blocked by runtime/tool readiness work |
| F3 | P0 | The entire main conversation is loaded up front, while the renderer bounds by chain count rather than byte/message cost | Large or tool-heavy sessions remain expensive despite old-chain collapsing |
| F4 | P1 | Todos arrive in `session:open`, then `useTodos` immediately performs another `session:load` | Duplicate full-session work after every switch |
| F5 | P1 | Subagent summaries hydrate on session-ID change and are requested again by the idle refresh effect | Duplicate summary creation and repeated transcript usage scans |
| F6 | P1 | Full sessions and chat histories are retained without an eviction policy, while every switch still returns the full view payload | Fast warm switching is bought with unbounded memory, and unchanged data still crosses IPC |
| F7 | P2 | Working-set focus is persisted synchronously, including file and directory fsync, inside `session:open` | UI navigation pays a durability write before the response resolves |
| F8 | P2 | Active-session commit fans out into many independent status/config/snapshot requests | Main-process and renderer work spikes immediately after first paint |
| F9 | P2 | Startup obtains the session catalog through overlapping session-list and working-set initialization paths | Repeated summary query and grouping work during startup |
| F10 | P3 | Unused loading state and duplicate workspace delivery still invalidate the shared session store | Avoidable renderer notifications and renders around each switch |

## Current switching path

The current flow is logically sound and race-aware, but its critical path is broad:

1. `ChatView.handleSessionSelect` increments a generation and calls `chat.beginSessionSwitch(id)` so late events from the previous session cannot repopulate the pane (`electron/src/renderer/components/ChatView.tsx:353`).
2. `useSession.openShared` invokes `session:open`, toggles the shared `isLoading` state, and adopts the returned session and workspace (`electron/src/renderer/hooks/useSession.ts:309`).
3. The main handler calls `SessionManager.switchTo`. This is a map lookup for an already-loaded session or a full SQLite load and JSON materialization for a cold session (`electron/src/main/ipc/session.ts:323`, `electron/src/main/session/manager.ts:369`).
4. The handler synchronously updates and durably persists working-set focus (`electron/src/main/ipc/session.ts:326`, `electron/src/main/ipc/session-working-set.ts:42`).
5. The handler restores the permission override and then awaits stored subagent hydration (`electron/src/main/ipc/session.ts:327-330`).
6. It flattens all chain messages, seeds main-process chat history, resolves workspace state, gets the live chat snapshot, and returns the combined view (`electron/src/main/ipc/session.ts:342-364`).
7. The renderer commits the todo list and chat snapshot after the open result has arrived (`electron/src/renderer/components/ChatView.tsx:386-396`).
8. React effects keyed to the new session then hydrate todos, subagents, approvals, questions, commands, reasoning/service-tier/permission settings, and workspace index/MCP state.

The earlier three-call flow is no longer present. This review does not recommend reversing the one-call navigation API; it recommends narrowing what must complete inside that call.

## Measurements

These measurements used aggregate sizes and timings from a local development database. No message or transcript contents were copied into this report.

### Dataset shape

| Measure | Observed value |
|---|---:|
| Session database size | Approximately 498 MB |
| Saved sessions | 132 |
| Serialized main-chain message JSON | Approximately 130 MB |
| Serialized subagent record JSON | Approximately 195 MB |
| Larger sampled sessions, combined serialized JSON | Approximately 11-27 MB each |

Subagent records are a larger aggregate payload than main-chain messages in this dataset. That matters because cold navigation parses those records before discarding them from the renderer-facing session object.

### Focused timings

| Operation | Payload | Observed warm timing |
|---|---:|---:|
| SQLite fetch plus `JSON.parse` | 11.6 MB session | Approximately 60 ms median |
| SQLite fetch plus `JSON.parse` | 23.1 MB, subagent-heavy session | Approximately 157 ms median |
| SQLite fetch plus `JSON.parse` | 26.5 MB, subagent-heavy session | Approximately 176 ms median |
| Structured-clone proxy | 5.3 MB object graph | Approximately 11-13 ms median |
| Atomic working-set write on local Btrfs | Small `ui-state.json` | 5.1 ms median, 9.2 ms P95, 28.8 ms maximum |

The session-load timings are lower bounds. They exclude domain conversion, subagent runtime hydration, IPC serialization/deserialization, React state propagation, Markdown parsing, DOM construction, layout, and paint. They were collected with warm filesystem/cache conditions on one development machine, so they should guide prioritization rather than serve as production latency claims.

## Detailed findings

### F1 — P0: cold navigation materializes hidden subagent transcripts

**Evidence**

- `loadSession` selects every `record_json` row from `subagent_chains` and runs `JSON.parse` plus `subagentRecordFromStorageDict` for each record (`electron/src/main/session/storage.ts:652`, `electron/src/main/session/storage.ts:712-727`).
- The resulting `Session` contains all `subagentChains`.
- Immediately before returning the navigation result, `sessionForRenderer` replaces `subagentChains` with an empty array because historical transcripts are fetched through the detail endpoint (`electron/src/shared/types/session.ts:54-62`).

**Impact**

Cold-switch latency and heap pressure scale with all historical subagent transcript bytes even when the user never opens the subagent inspector. In the measured dataset, subagent JSON accounts for roughly 195 MB in aggregate and dominates some of the largest sessions.

**Recommendation**

Persist and query a bounded `SubagentSummary` read model separately from full `record_json`. The summary should include the fields already needed by the list and chain footers: identity, role/type/tier, task, status, timestamps, parent-chain attribution, revision, and precomputed usage. Load full `record_json` only for:

- an explicitly selected transcript;
- runtime restoration for lifecycle tools or prompt context;
- a live/active record that must be resumed.

Avoid deriving summary usage during navigation by rescanning `record.chain.messages`; update it during the existing incremental subagent persistence lifecycle.

### F2 — P0: subagent runtime restoration blocks visible navigation

**Evidence**

- `session:open` awaits `hydrateOpenedSessionSubagents` before flattening and returning visible messages (`electron/src/main/ipc/session.ts:323-342`).
- `hydrateSessionSubagents` restores every stored record for the session and may resolve a project runtime first (`electron/src/main/tools/subagent/hydrate.ts:140`).
- The code comment explicitly notes that the renderer already renders stored rows; hydration is needed for prompt context and lifecycle tools, not for the initial display.

**Impact**

Session viewing is coupled to agent-runtime readiness. A session with many historical subagents cannot paint until record conversion/restoration has finished, even if the user only wants to read the main conversation.

**Recommendation**

Move restoration behind a per-session single-flight readiness task:

- `session:open` starts or reuses hydration but does not await it for the visible result.
- `chat:send` awaits readiness before building prompt context.
- `wait_for_subagent`, `interrupt_subagent`, `answer_subagent`, follow-up, and close operations await readiness before acting on a stored record.
- Live records and currently executing sessions remain pinned and must not be replaced by stored state.
- Failures remain observable and retryable; they must not silently make stored subagents disappear.

This separation preserves correctness while removing nonvisual work from the navigation critical path.

### F3 — P0: main conversation loading and rendering are not byte-bounded

**Evidence**

- Every chain row is loaded and converted during `loadSession`, including all `messages_json` (`electron/src/main/session/storage.ts:662-709`).
- `session:open` flattens every message and seeds the complete main-process chat history before returning (`electron/src/main/ipc/session.ts:342-345`).
- Renderer history collapsing is based on `CHAIN_COLLAPSE_THRESHOLD = 20`, not message count, Markdown size, tool-result size, or estimated render cost (`electron/src/renderer/utils/stream-building.ts:26`, `electron/src/renderer/utils/stream-building.ts:204-243`).
- The visible 20 chains are fully walked. A single chain can still contain a very large response or tool-heavy transcript.

**Impact**

Old-chain collapsing reduces DOM work but does not reduce SQLite reads, JSON parsing, domain allocation, main-process history seeding, or IPC payload construction. It also cannot protect first paint from a small number of exceptionally large chains.

**Recommendation**

Introduce a renderer-oriented `SessionView` and paged history contract:

- load metadata plus a recent byte/message-budgeted window;
- retain chain boundary, footer, usage, and error metadata for unloaded history;
- hydrate older message bodies on expansion or upward navigation;
- virtualize long visible histories;
- treat a byte/message budget, not only chain count, as the mounting limit.

The main process may still need complete model history for a new send. That history should be loaded or retained independently from the renderer page so UI paging does not truncate model context.

### F4 — P1: todo state is loaded twice on every session switch

**Evidence**

- `session:open` returns `session.todoStore`, and `ChatView` immediately calls `todos.applyFromSession` (`electron/src/renderer/components/ChatView.tsx:386`).
- Changing `activeSessionId` also triggers `useTodos.refresh`, which calls `session:load({ activate: false })` (`electron/src/renderer/hooks/useTodos.ts:51-84`).
- That peek is a session load, not a todo-only query. On a cold/racy path it can repeat the expensive full materialization described in F1 and F3.

**Impact**

The initial value is correct, but an automatic stale-while-revalidate request follows it immediately and can repeat substantial main-process work.

**Recommendation**

Seed todos from the `session:open` result with a revision and suppress revalidation for that same revision. Thereafter refresh only on:

- a todo mutation event;
- explicit user refresh;
- a detected revision gap.

If a snapshot endpoint remains useful, make it todo-specific rather than routing through `session:load`.

### F5 — P1: subagent summaries are requested twice and recomputed from transcripts

**Evidence**

- `useSubagents` hydrates a snapshot whenever `activeSessionId` changes (`electron/src/renderer/hooks/useSubagents.ts:211-217`).
- `ChatView` also calls `subagents.refresh()` whenever chat is idle and its dependencies change; a session switch satisfies those dependencies (`electron/src/renderer/components/ChatView.tsx:945-951`).
- Snapshot creation merges stored/runtime records and calls `summarizeSubagentRecord` (`electron/src/main/ipc/subagents.ts:48-63`).
- `summarizeSubagentRecord` calculates usage with `sumMessageUsages(record.chain.messages)` (`electron/src/shared/types/subagent.ts:260-275`).
- `manager.allRecords()` traverses the global runtime collection before filtering to the selected session.

**Impact**

A session switch can issue two near-identical snapshots. For transcript-heavy sessions, each summary pass may scan message histories solely to reconstruct usage that changed only when persistence changed.

**Recommendation**

- Trigger the idle refresh only on a real `streaming -> idle` transition for the same session, not on initial idle mount/session switch.
- Persist usage and summary revision alongside each subagent record.
- Maintain a session-keyed runtime record index instead of filtering a global `allRecords()` result.
- Reuse the snapshot revision to avoid returning an unchanged summary payload.

### F6 — P1: warm-session speed relies on unbounded memory and unchanged full payloads

**Evidence**

- `SessionManager._sessions` retains every loaded full session, with no size or recency eviction policy (`electron/src/main/session/manager.ts:115`).
- The separate `messageHistory` map retains seeded histories per session until explicitly cleared (`electron/src/main/ipc/chat-history.ts:9-30`).
- `switchTo` correctly reuses a loaded session, but `session:open` still constructs and returns the full renderer view on each switch.

**Impact**

Repeatedly opening large sessions improves later disk latency at the cost of process memory. Long-running applications can retain many full histories and subagent record graphs. Warm switches also pay IPC traversal and renderer adoption for data that may not have changed.

**Recommendation**

Use bounded, revision-aware caches:

- pin sessions with an active turn or running subagents;
- keep a size-aware LRU for inactive renderer history pages and model histories;
- evict closed/inactive sessions first;
- include a session/history revision in `session:open` requests;
- when the renderer already has that revision, return only live state, workspace/focus state, and changed slices.

The cache budget should be byte-based because session sizes vary by orders of magnitude.

### F7 — P2: focus durability is synchronous on the switch critical path

**Evidence**

- `session:open` calls `workingSetOpenOrFocus` before returning (`electron/src/main/ipc/session.ts:326`).
- `mutateAndPersist` calls `sessionWorkingSet.saveToDisk()` synchronously and only then broadcasts (`electron/src/main/ipc/session-working-set.ts:42-52`).
- `saveToDisk` uses `atomicWriteJson`, which writes a temporary file, fsyncs it, renames it, chmods it, and fsyncs the parent directory (`electron/src/main/session/working-set.ts:170-188`, `electron/src/main/config/loader.ts:57-119`).

**Impact**

Even a warm in-memory switch waits on filesystem durability. The local median was modest, but the observed maximum was 28.8 ms, and slower disks, antivirus, networked profiles, or filesystem contention can make this tail larger.

**Recommendation**

Update memory and broadcast focus immediately, then debounce/coalesce the durable write. Flush pending state during orderly shutdown and at natural durability boundaries. This deliberately changes the crash guarantee: a hard crash may lose only the most recent focus/MRU update, not session content. Confirm that trade-off before implementation.

### F8 — P2: active-session commit causes an inspector/status request burst

**Evidence**

After `activeSession` and workspace change, independent hooks request:

- reasoning configuration, service-tier configuration, and permission mode (`electron/src/renderer/components/Footer.tsx:166-220`);
- permission approval snapshot (`electron/src/renderer/hooks/usePermissionApproval.ts:46-105`);
- ask-question snapshot (`electron/src/renderer/hooks/useAskQuestion.ts:244-304`);
- background command list (`electron/src/renderer/hooks/useBackgroundCommands.ts:69-77`);
- subagent snapshot (`electron/src/renderer/hooks/useSubagents.ts:211-217`);
- todo refresh (`electron/src/renderer/hooks/useTodos.ts:78-84`);
- RAG and AST status on workspace change (`electron/src/renderer/components/ChatView.tsx:929-931`);
- MCP status refresh/polling (`electron/src/renderer/components/ChatView.tsx:922-943`).

**Impact**

Most calls are individually small and occur after the primary response, but together they create a burst of main-process work and React updates exactly when the new conversation is painting.

**Recommendation**

- Cache stable configuration by model/session/workspace revision.
- Seed values already present in the open result rather than immediately refetching them.
- Hydrate collapsed/hidden inspector panels lazily.
- Coalesce closely related lightweight snapshots only where they share invalidation semantics.

Do not replace the burst with one unbounded mega-payload. The goal is explicit critical and deferred slices, not simply another larger `session:open` response.

### F9 — P2: startup repeats session-catalog summary work

**Evidence**

- `useSession.ensureBootstrapped` calls `session.list()` (`electron/src/renderer/hooks/useSession.ts:166-208`).
- `useSessionTabs` independently calls `session.getWorkingSet()` on mount (`electron/src/renderer/hooks/useSessionTabs.ts:33-53`).
- The working-set handler calls `tryListSessionCatalog`, which calls `manager.listSaved()` to filter missing session IDs (`electron/src/main/ipc/session-working-set.ts:61-105`).
- `listSavedSessions` performs a `LEFT JOIN` over chains, groups by session, counts chains, and orders the full result (`electron/src/main/session/storage.ts:740-768`).

**Impact**

Startup may execute the session summary query multiple times before any user action. With 132 sessions this was not the dominant measured cost, but it grows with the catalog and competes with initial session selection.

**Recommendation**

Build one revisioned session catalog snapshot during startup and reuse it for sidebar summaries and working-set validation. Invalidate it on create, rename, delete, chain-count change, or recency update. If exact chain counts are not needed for first paint, compute or refresh them after the session names and focus state are visible.

### F10 — P3: avoidable shared-store invalidations remain

**Evidence**

- `openShared` sets shared `isLoading` before and after every open (`electron/src/renderer/hooks/useSession.ts:309-337`).
- `isLoading` is part of the `useSyncExternalStore` snapshot returned to every `useSession` consumer, but no renderer consumer currently reads it outside the hook (`electron/src/renderer/hooks/useSession.ts:148-157`, repository search on 2026-08-13).
- Main emits `workspace:changed` and also returns the workspace in `session:open`; `useSession` adopts both object instances, and `setWorkspaceState` deduplicates by reference only (`electron/src/main/ipc/session.ts:348-359`, `electron/src/renderer/hooks/useSession.ts:147`, `electron/src/renderer/hooks/useSession.ts:270-278`).

**Impact**

These are small compared with transcript parsing, but they cause avoidable store snapshots, listener notifications, and dependent renders around the switch.

**Recommendation**

Remove unused `isLoading` from the shared store or expose it through a selector/subscription used only by a loading indicator. For workspace state, choose the response or event as authoritative for navigation, or deduplicate by stable fields/revision rather than object identity.

## What is already working well

These pieces should be preserved while optimizing:

- **One navigation IPC:** `23c7f81` removed the prior peek, live snapshot, and activate sequence in favor of one coherent `session:open` result.
- **Switch race protection:** renderer generations drop stale results, and `beginSessionSwitch` changes event affinity before awaiting the open.
- **Failure behavior:** a missing/corrupt target retains the previous painted conversation instead of flashing empty state.
- **Warm reuse:** `SessionManager.switchTo` reuses in-memory state, including live todos.
- **Renderer DTO boundary:** historical subagent transcripts are already omitted from the session returned to the renderer.
- **Lazy subagent detail:** the full selected transcript has its own detail endpoint.
- **Render containment:** old chains collapse to stubs and `MessageWidget` is memoized.
- **Incremental persistence:** session lifecycle writes already avoid full-database rewrites; see `docs/solutions/performance-issues/incremental-sqlite-session-lifecycle-writes.md`.

The main opportunity is to extend these same bounded/read-model principles to the session-open read path.

## Recommended implementation sequence

### 1. Add end-to-end instrumentation first

Capture timings and byte/count metadata for:

- click/keyboard selection to `session:open` invocation;
- manager cache hit or cold SQLite load;
- chain fetch/parse and subagent fetch/parse separately;
- working-set persistence;
- subagent runtime hydration;
- IPC response resolution;
- active-session commit;
- first new-session message paint;
- Markdown/layout completion for the initial viewport.

Record only counts, byte estimates, revisions, and durations—not message content. Split cold, warm, small, large-main-history, and subagent-heavy sessions. Establish percentile budgets from production-like packaged builds before setting hard thresholds.

### 2. Remove duplicate post-open work

F4, F5, F10, and part of F8 are relatively low-risk:

- seed todos and suppress same-revision revalidation;
- distinguish session-switch idle from an actual completed turn;
- avoid duplicate workspace adoption;
- remove or scope unused loading notifications.

This reduces noise in later profiles and ensures the measurements represent one intended load per slice.

### 3. Split persisted subagent summaries from full records

Implement F1 before attempting broad history paging. It targets the largest hidden payload in the measured dataset and aligns with the existing renderer DTO/detail split. Backfill or lazily derive summaries for existing rows, then persist them incrementally so navigation never needs transcript scans.

### 4. Make runtime subagent restoration asynchronous and correctness-gated

Implement F2 with a per-session single-flight promise, explicit readiness/revision state, and focused lifecycle tests. Keep display independent, but require send and lifecycle operations to await readiness. Test switch-away/switch-back, concurrent send, missing project runtime, agent definition drift, active live records, and hydration failure/retry.

### 5. Introduce a paged `SessionView`

Implement F3 using a recent byte/message budget and explicit older-history loading. Keep model context storage independent from renderer pagination. Add regression coverage for chain footers, errors, usage, active turns, collapsed-chain expansion, tool-call/result pairing, and rapid session switching.

### 6. Bound caches and add revision-aware opens

Once session slices have revisions, implement F6. Size-aware eviction and `knownRevision` requests can then avoid both unbounded retention and repeated unchanged payloads.

### 7. Move durability and secondary status work off first paint

Finally implement F7-F9: coalesced working-set persistence, lazy inspector hydration, stable config/status caches, and a shared startup catalog snapshot. These should be measured after the dominant parsing/hydration work has been removed so their real contribution is visible.

## Verification and performance test plan

### Correctness coverage

- Cold-open a session with no subagents, many terminal subagents, and a live subagent.
- Switch rapidly A -> B -> C and prove no stale history, workspace, todos, approvals, or subagent summaries land in C.
- Open a session and immediately send; prove full model history and subagent prompt context are ready before orchestration begins.
- Open and immediately run wait/interrupt/answer/follow-up/close operations against stored subagents; prove they await the same hydration task.
- Expand paged historical chains and prove message order, tool pairing, chain errors, usage, and footer attribution are unchanged.
- Delete or corrupt a session/subagent row and retain the existing fail-soft navigation behavior.
- Keep a turn running while switching away and back; prove cache eviction never removes live runtime state.
- Crash/restart around debounced working-set focus and verify only view focus may lag, never conversation data.

### Performance fixtures

Add deterministic generated fixtures rather than checking in private transcripts:

- small: a few short chains, no subagents;
- long-main: many message bytes across few chains;
- many-chains: more than the collapse threshold;
- subagent-heavy: many terminal subagents with large transcripts;
- mixed-live: large history plus an active main turn and running subagent.

Track at least cold-open duration, warm-open duration, first-message paint, bytes parsed, bytes sent over IPC, peak heap delta, number of IPC calls caused by a switch, and number of Markdown message bodies mounted initially.

## Risks and non-goals

- **Do not truncate model context accidentally.** Renderer paging and LLM history are separate concerns.
- **Do not allow lifecycle tools to race incomplete subagent restoration.** Deferred hydration needs an awaited readiness boundary.
- **Do not evict active state.** Sessions with active turns, approvals, questions, commands, or subagents require pinning.
- **Do not make `session:open` a new unbounded aggregate endpoint.** Slice ownership and invalidation should remain explicit.
- **Do not optimize only development mode.** React development behavior and source maps distort timings; validate packaged builds.
- **Do not use chain count as the only size proxy.** Message bytes, tool-result structure, and Markdown complexity vary substantially.
- **Do not weaken persistence without naming the guarantee.** Debouncing focus state is reasonable only if losing the latest focus/MRU entry on hard crash is accepted.

## Conclusion

The current architecture has already eliminated unnecessary sequential navigation IPC. The next performance step is to stop treating a session as one indivisible object at read time. The largest expected gains come from avoiding full subagent transcript materialization, decoupling runtime restoration from visual navigation, and loading only the initial conversation window. Duplicate effects, durability writes, cache policy, and status fan-out are worthwhile follow-ups once those dominant costs are instrumented and removed.
