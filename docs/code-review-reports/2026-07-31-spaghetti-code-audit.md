# Orchid Electron spaghetti-code audit

## Metadata

| Field | Value |
|---|---|
| Date | 2026-07-31 |
| Branch | `feat/progressive-startup-screen` |
| Commit | `4a1cf74` |
| Scope | Maintained Electron application under `electron/src/**` |
| Mode | Report and recommendations only; no production code changed |
| Related review | [`docs/architecture-review.md`](../architecture-review.md) |

## Purpose

This report identifies code that meets the practical definition of spaghetti code: responsibilities, state, or dependencies are sufficiently entangled that a local change can require tracing unrelated paths or can produce failures in a different subsystem.

File length and cyclomatic complexity are used only as discovery signals. A large parser, contract file, or lookup table is not classified as spaghetti when its responsibility and dependency direction remain clear.

The current application is not uniformly spaghetti code, and a rewrite is not recommended. The problems are concentrated in five areas:

1. A main-process runtime dependency knot spanning 16 modules.
2. The `streamChat()` LLM orchestration function.
3. Duplicated chat state and message materialization across main and renderer.
4. The multi-responsibility `SubagentManager`.
5. The renderer `ChatView` god component.

All five are maintainability and change-risk findings. They are not evidence that the current application is failing. The targeted verification performed during this audit passed.

## Executive summary

| ID | Problem | Classification | Priority | Primary consequence |
|---|---|---|---|---|
| SPG-01 | Main-process runtime dependency knot | Circular dependencies and inverted layering | High | Initialization order and unrelated modules affect each other |
| SPG-02 | `streamChat()` orchestration monolith | Tangled control flow | High | Provider, tool, retry, and UI-event changes share one fragile loop |
| SPG-03 | Duplicated chat truth | Distributed mutable state and reconciliation logic | High | Races, stale events, duplicate messages, and difficult hydration |
| SPG-04 | `SubagentManager` god object | Mixed lifecycle, persistence, projection, and execution responsibilities | High | New lifecycle operations interact with hidden invariants |
| SPG-05 | `ChatView` god component | UI coordination monolith | Medium | Unrelated renderer changes collide and trigger broad rerenders |

Priority describes remediation value, not current bug severity.

---

## SPG-01: Main-process runtime dependency knot

### Classification

Confirmed circular-dependency and layering problem.

### Locations

The largest runtime-import strongly connected component contains these 16 modules:

- `main/agents/persist-subagent-chains.ts`
- `main/agents/registry.ts`
- `main/ipc/chat/events.ts`
- `main/ipc/config.ts`
- `main/ipc/session-activity.ts`
- `main/ipc/session-working-set.ts`
- `main/ipc/session.ts`
- `main/project/runtime.ts`
- `main/project/workspace.ts`
- `main/session/singleton.ts`
- `main/skills/registry.ts`
- `main/tools/index.ts`
- `main/tools/subagent/close.ts`
- `main/tools/subagent/delegate.ts`
- `main/tools/subagent/follow-up.ts`
- `main/tools/subagent/hydrate.ts`

There is a second runtime cycle between:

- `shared/types/chain.ts`
- `shared/types/subagent.ts`

The scan inspected 358 TypeScript/TSX files and 1,254 static runtime-import edges. Imports declared with `import type` or `export type` were excluded.

### Evidence

#### Config, workspace, and session form a direct cycle

[`project/workspace.ts`](../../electron/src/main/project/workspace.ts) imports `withConfigSaveLock` from the IPC config module. [`ipc/config.ts`](../../electron/src/main/ipc/config.ts) imports `resolveWindowWorkspace` from session IPC. [`ipc/session.ts`](../../electron/src/main/ipc/session.ts) imports project workspace functions.

The dependency direction is therefore:

```text
project/workspace
  -> ipc/config
  -> ipc/session
  -> project/workspace
```

This contradicts the intended layering described in `project/workspace.ts`, where session-manager coupling is supposed to remain in callers so the module stays free of IPC/session cycles.

#### Definition registries reach upward into the entire tool runtime

[`agents/registry.ts`](../../electron/src/main/agents/registry.ts) and [`skills/registry.ts`](../../electron/src/main/skills/registry.ts) call `registerBuiltinTools()` as a side effect of loading definitions.

That means a filesystem-oriented definition registry depends on the tool composition root. The tool composition root imports subagent management, session access, providers, MCP, process tools, filesystem tools, and other application services. Project runtime loading then imports the registries, completing the larger cycle.

#### IPC helper modules import the IPC registration barrel

[`ipc/chat/events.ts`](../../electron/src/main/ipc/chat/events.ts) and [`ipc/session-working-set.ts`](../../electron/src/main/ipc/session-working-set.ts) import session access through `ipc/session.ts`. Session IPC imports those helpers in return.

These helpers need the session service, not the session IPC registration module.

#### Dynamic imports are already compensating for the topology

[`tools/subagent/hydrate.ts`](../../electron/src/main/tools/subagent/hydrate.ts) says its lazy session import avoids a tools/session IPC circular initialization. [`ipc/session.ts`](../../electron/src/main/ipc/session.ts) dynamically imports chat snapshot functions to avoid a session/chat cycle. [`agents/persist-subagent-chains.ts`](../../electron/src/main/agents/persist-subagent-chains.ts) was extracted partly to avoid a tools/wiring cycle.

Dynamic imports are appropriate for optional or expensive dependencies. When they are needed merely to keep ordinary domain modules loadable, they indicate an unresolved dependency boundary.

### Why this qualifies as spaghetti code

- Dependency arrows travel both down into domain services and back up into IPC/composition layers.
- Loading an agent or skill definition can initialize unrelated tool and session infrastructure.
- A module's behavior can depend on which member of the cycle is imported first.
- Tests must mock or lazily load modules because ordinary static composition is unsafe.
- The cycle spans unrelated concerns: configuration, workspace resolution, session UI events, definitions, tools, and subagent persistence.

### Risks

- A harmless new top-level initializer can observe a partially initialized export.
- Tests may pass or fail based on import order and module-cache state.
- Moving one helper can unexpectedly load Electron, native modules, or provider infrastructure.
- Domain code becomes difficult to reuse without the entire application composition root.
- Future attempts to isolate workers or test modules independently become more expensive.

### Recommendations

#### 1. Move the config write lock below IPC

Create a lower-level module such as:

```text
main/config/write-lock.ts
```

Move `withConfigSaveLock` and its test reset there. Both `ipc/config.ts` and `project/workspace.ts` should import that module. Project code must not import an IPC registration module for synchronization.

This breaks the shortest and clearest cycle with little behavioral risk.

#### 2. Make agent and skill registries pure loaders

Remove the `registerBuiltinTools()` side effect from `loadAgents()` and `loadSkills()`.

The application composition or definition-reload layer should explicitly perform:

1. Load agents.
2. Load skills.
3. Rebuild compatibility tool surfaces when required.

`readAgents()` and `readSkills()` are already close to the desired pure behavior. The same separation should apply to their stateful loading variants.

#### 3. Stop importing services through IPC barrels

- `ipc/chat/events.ts` should import `getSessionManager` from `session/singleton.ts`.
- `ipc/session-working-set.ts` should do the same.
- Other main-process domain modules should import session services from `main/session/**`, not `main/ipc/session.ts`.
- `ipc/session.ts` should own validation and handler registration only.

#### 4. Separate recursive domain types from their serializers

`Chain` and `SubagentRecord` legitimately refer to one another. Their runtime serializers do not need to reside in both type modules.

Move the mutually recursive storage conversion into one dedicated module, for example:

```text
shared/serialization/chain-subagent.ts
```

The type modules can then use type-only imports while the serialization module owns the runtime recursion explicitly.

#### 5. Add a dependency-cycle regression check

Add a repository script that:

- Resolves relative runtime imports under `electron/src`.
- Ignores type-only edges.
- Reports strongly connected components.
- Initially pins the known baseline if removing every cycle requires multiple changes.
- Fails on new or enlarged components.
- Moves to a zero-cycle rule once SPG-01 is complete.

The guard should report the concrete edge path, not merely say that a cycle exists.

### Incremental implementation order

1. Extract the config write lock.
2. Change IPC helpers to import `session/singleton.ts` directly.
3. Remove registry-to-tool side effects and update the reload composition point.
4. Move recursive serializers.
5. Add the dependency guard and reduce its baseline to zero.

Each step can be reviewed and tested separately. A broad directory reshuffle is unnecessary.

### Acceptance criteria

- No runtime strongly connected component remains under `electron/src/main`.
- `main/project/**`, `main/session/**`, `main/agents/**`, and `main/tools/**` do not import `main/ipc/**` for domain services.
- Loading an agent or skill registry does not register tools as a side effect.
- `chain.ts` and `subagent.ts` have only type-level cross-dependencies.
- Existing config, workspace, session, registry, and subagent tests pass.
- The new cycle check runs in CI.

---

## SPG-02: `streamChat()` orchestration monolith

### Classification

Confirmed tangled control-flow hotspot.

### Location

[`main/llm/orchestrator.ts`](../../electron/src/main/llm/orchestrator.ts), principally `streamChat()`.

### Evidence

Diagnostic ESLint rules measured `streamChat()` at:

- 651 non-blank/non-comment function lines.
- 216 statements.
- Cyclomatic complexity 114.
- Nesting up to seven blocks deep.

The same function owns all of these concerns:

1. System prompt and history preparation.
2. Conversion into AI SDK model messages.
3. Built-in, skill, and MCP tool construction.
4. Middleware composition.
5. Step-count and early-stop policy.
6. Idle watchdog creation, pausing, and retry decisions.
7. Abort-signal merging and disposal.
8. Reconstruction of streamed tool-input JSON.
9. Eager tool launching and exactly-once memoization.
10. UI-facing eager start and completion queues.
11. Full-stream AI SDK part normalization.
12. Tool call/result deduplication.
13. Usage calculation and step tracking.
14. `fullStream` to `textStream` fallback.
15. Stream error classification and terminal event emission.

The central switch handles provider events, mutates watchdog state, mutates eager-execution state, updates deduplication sets, and yields product events from the same branches.

### Why this qualifies as spaghetti code

The problem is not that a protocol adapter has a large switch. The problem is that the switch is interleaved with several independent state machines:

- Provider stream lifecycle.
- Idle watchdog lifecycle.
- Eager tool lifecycle.
- Tool-call deduplication lifecycle.
- Step and usage lifecycle.
- Fallback-stream lifecycle.

A change to one state machine requires understanding the invariants of the others. For example, tool execution affects whether the idle timer may run, whether an eager completion may be emitted, whether the SDK result must be ignored, and when the executor entry can be forgotten.

### Risks

- Duplicate or missing tool events when providers emit different combinations of parts.
- A tool being run twice or forgotten before its SDK completion arrives.
- Idle timeouts firing while a legitimate tool is running.
- Fallback behavior emitting usage or tool events in a different order.
- A provider-specific compatibility change altering normal provider behavior.
- Reviewers needing to reason about hundreds of lines to validate a small event case.

### Recommendations

#### 1. Extract model-message construction

Move the remaining `ApiMessage` to AI SDK `ModelMessage` conversion out of `streamChat()`. History normalization belongs beside `history.ts` or in a dedicated model-message adapter.

`streamChat()` should receive or create model messages through one named function rather than manually branching over assistant, tool, and user messages.

#### 2. Introduce an attempt-scoped controller

Create an object or focused function that owns only one stream attempt:

```text
llm/stream/attempt-controller.ts
```

It should own:

- The merged abort signal.
- Idle timer state.
- The tool-in-flight counter.
- Cleanup/disposal.
- The decision about whether an idle failure is retryable.

This makes watchdog behavior testable without a live SDK stream.

#### 3. Extract the eager-tool bridge

Move streamed input accumulation, JSON finalization, eager starts, early completion queues, and seen-ID coordination into:

```text
llm/stream/eager-tool-bridge.ts
```

The bridge should expose a small event-driven API such as:

- `inputStarted(...)`
- `inputDelta(...)`
- `inputEnded(...)`
- `sdkCallAvailable(...)`
- `sdkResultAvailable(...)`
- `drainEvents()`
- `dispose()`

The existing `EagerToolExecutor` remains the exactly-once execution primitive. The bridge owns provider-stream reconciliation around it.

#### 4. Extract AI SDK part normalization

Move the large provider-part switch into a stream adapter:

```text
llm/stream/sdk-event-adapter.ts
```

Its input should be an SDK part plus explicit adapter state. Its output should be zero or more normalized `StreamEvent` values and a small set of controller actions, such as resetting the idle timer or recording a completed tool.

Keep provider field-shape quirks inside this adapter rather than spreading them through orchestration.

#### 5. Isolate fallback iteration

`fullStream` and `textStream` fallback should be separate iterators that both produce the same internal normalized event stream. The outer orchestration should not contain a second event-delivery implementation for the fallback path.

#### 6. Leave `streamChat()` as composition

After extraction, `streamChat()` should visibly perform this sequence:

1. Build prompt, model messages, tools, and middleware.
2. Create an attempt controller and stream adapters.
3. Iterate normalized events and yield them.
4. Retry only an eligible pre-output idle failure.
5. Dispose attempt resources.

### Safe extraction sequence

1. Preserve the existing event-trace tests as characterization tests.
2. Extract model-message conversion without changing output.
3. Extract the idle/abort attempt controller.
4. Extract eager input and deduplication state.
5. Extract the SDK event switch.
6. Unify the fallback iterator last.

Do not combine this refactor with AI SDK upgrades, new provider support, or changes to event ordering.

### Acceptance criteria

- `streamChat()` is an orchestration function rather than the implementation of every policy.
- Eager execution still routes through `executeToolCall()` exactly once.
- Tool start, result, usage, step-finish, and terminal event traces remain unchanged.
- Idle timeout remains paused while tools are in flight.
- Retry still occurs only before any user-visible output.
- `fullStream` and fallback tests exercise a shared normalized output contract.
- Diagnostic function complexity for `streamChat()` is reduced below 30; remaining complexity is located in named, independently tested adapters.

---

## SPG-03: Duplicated chat truth across main and renderer

### Classification

Confirmed distributed-state and reconciliation problem.

### Locations

- [`main/ipc/chat.ts`](../../electron/src/main/ipc/chat.ts)
- [`main/ipc/chat/state.ts`](../../electron/src/main/ipc/chat/state.ts)
- [`main/ipc/chat/snapshot.ts`](../../electron/src/main/ipc/chat/snapshot.ts)
- [`main/ipc/chat/persist.ts`](../../electron/src/main/ipc/chat/persist.ts)
- [`renderer/hooks/useChat.ts`](../../electron/src/renderer/hooks/useChat.ts)

### Evidence

The main-process `registerChatIPC()` function still contains a 616-line `chat:send` handler. Its subscription callback has diagnostic complexity 47 and is responsible for translating actor snapshots into IPC events, activity updates, live tool state, checkpoint messages, and terminal persistence.

The renderer `useChat()` hook contains:

- 16 React state values.
- 18 mutable refs.
- 21 callbacks.
- Separate state for accumulated content, accumulated thinking, tool blocks, stream segments, pending RAF batches, session affinity, turn identity, sequence numbers, cancel serialization, usage, hydration, and send locking.

The same logical turn exists in several forms:

1. XState `AgentContext`.
2. Main-process `ActiveAgent` mutable state.
3. Main-process `turnMessages` and stream segments.
4. Persisted session chains.
5. IPC event sequences and snapshots.
6. Renderer refs used as synchronous sources of truth.
7. Renderer React state used for presentation.
8. Renderer-generated `Message[]` created by `commitSegmentsToMessages()`.

The test suite contains explicit protections for stale sequences, wrong-session events, duplicate tool messages, live-history deduplication, buffered hydration events, and `SESSION_UPDATED` races. Those tests are valuable, but their number reflects the amount of reconciliation the architecture requires.

### Why this qualifies as spaghetti code

- More than one layer decides how stream segments become durable-looking messages.
- React state and mutable refs mirror each other because neither alone is authoritative during same-tick event races.
- Completion, error, cancellation, hydration, and session navigation each have separate reconciliation paths.
- Correctness depends on session ID, turn ID, sequence, generation, committed offsets, and deduplication checks remaining mutually consistent.
- A new chat event usually requires coordinated changes in main state, IPC types, preload, renderer subscriptions, hydration, and persistence.

### Risks

- Duplicate assistant or tool messages at completion.
- Lost final tool arguments when `CHAT_DONE` follows immediately after a delta.
- Stale events from a prior session or turn updating the selected view.
- Hydration snapshots overwriting newer buffered events.
- Renderer history diverging temporarily from persisted history.
- Cancellation persisting a different transcript than the renderer displays.

### Recommendations

#### 1. Define one pure turn projection reducer

Create a platform-independent reducer that accepts normalized chat events and produces a `ChatTurnProjection`:

```text
shared/chat/turn-projection.ts
```

The projection should contain, at minimum:

- Session and turn identity.
- Last accepted sequence.
- Stream status and interruption phase.
- Ordered text/thinking/tool segments.
- Tool snapshots.
- Current usage.
- Terminal result or error.

Both live events and hydration snapshots should use the same state vocabulary. A snapshot should represent a reducer state at a known sequence, not a separate model requiring ad hoc translation.

#### 2. Establish one owner for durable message materialization

The main process should remain the authority for session persistence. There should be only one implementation that converts a terminal turn projection into durable `Message[]` and chain state.

Two viable approaches are:

- Main process finalizes the turn and includes the finalized turn messages in the terminal event/snapshot.
- A pure shared materializer is used identically by main persistence and renderer presentation.

The first option provides a clearer authority boundary. The second is acceptable if the function remains pure and contract-tested. What should be avoided is separate main and renderer implementations that merely attempt to produce equivalent results.

#### 3. Replace most mirrored renderer state with `useReducer`

Use a reducer for logical chat state. Keep refs only for concerns that genuinely require imperative identity:

- The current selected session/turn affinity used by event callbacks.
- The pending animation-frame handle.
- Temporary chunk queues between animation frames.
- The synchronous send/cancel re-entry guard.

Tool blocks, segments, usage, stream status, error, and terminal state should be updated through reducer events rather than through paired ref and `setState` writes.

#### 4. Make hydration event replay a first-class protocol operation

Model hydration as:

1. Begin buffering events for session S.
2. Receive snapshot at revision/sequence N.
3. Seed the reducer from the snapshot.
4. Replay only buffered events newer than N for the same session and turn.
5. Resume normal delivery.

This procedure already exists implicitly. Encoding it as a named reducer/controller operation will make the invariant visible and reusable.

#### 5. Keep IPC transport separate from turn semantics

`ipc/chat.ts` should validate requests, invoke a chat-turn service, and forward typed events. Actor-to-projection logic, persistence, event sequencing, and title generation should remain outside the registration function.

The recent extraction into `ipc/chat/**` is a good start. The remaining send handler should become a composition layer over those modules rather than continuing to own the state flow through nested closures.

### Safe extraction sequence

1. Write event-trace fixtures representing normal, tool-heavy, error, cancel, and hydration flows.
2. Extract the renderer reducer while preserving existing IPC events.
3. Use the reducer for both live events and snapshot hydration.
4. Make the main process return authoritative finalized turn messages.
5. Remove renderer-only durable message reconstruction and obsolete deduplication.
6. Thin the `chat:send` handler after the data flow is stable.

Do not change the IPC event protocol and the persistence representation in the same step.

### Acceptance criteria

- Replaying events after snapshot sequence N produces the same projection as receiving the final snapshot directly.
- Only one implementation creates durable terminal messages.
- Renderer refs no longer mirror tool, segment, usage, and status state.
- Normal completion, error, cancellation, session switching, and hydration use the same reducer semantics.
- Existing affinity, history-deduplication, chat IPC, and rendering tests pass.
- Event-trace parity tests cover full-stream and hydrated entry paths.

---

## SPG-04: `SubagentManager` god object

### Classification

Confirmed multi-responsibility stateful god object.

### Location

[`main/agents/manager.ts`](../../electron/src/main/agents/manager.ts)

### Evidence

- 1,963 lines.
- 58 methods.
- `_startRun()` has diagnostic complexity 58, 220 non-blank/non-comment lines, and 96 statements.
- The runtime `SubagentRecord` mixes durable domain fields with live execution internals and persistence control flags.

The class currently owns:

1. Admission limits and queue interaction.
2. Spawn and follow-up transitions.
3. Running, completed, failed, interrupted, and closed transitions.
4. Waiter registration, timeout, abort, and question wakeups.
5. Abort controllers and asynchronous run ownership.
6. Stream-event to message conversion.
7. Live text, thinking, tool, and usage projections.
8. Delta sequence and session-revision publication.
9. Durable dirty revisions and persistence confirmation.
10. Hydration of persisted records.
11. Terminal summary eviction and retention.
12. Pending question routing and answers.
13. Conversion between runtime and domain records.

The runtime record contains flags such as `_evicted`, `_resumeQueued`, `_liveTerminalEmitted`, `_liveCommittedSegmentCount`, `_runPromise`, `_resolveWait`, and `_lastUsageDeltaAt`. These encode cross-cutting invariants that callers must understand before mutating the record safely.

The repository learning [`subagent-resume-lifecycle-races.md`](../solutions/logic-errors/subagent-resume-lifecycle-races.md) documents concrete races caused by interactions among resume, cancellation, asynchronous teardown, persistence eligibility, and eviction.

### Why this qualifies as spaghetti code

- Lifecycle state is not sufficient to determine whether a record is safe to mutate; hidden flags and asynchronous ownership also matter.
- Durable data, live presentation, execution control, and persistence bookkeeping share one mutable object.
- The run loop directly mutates lifecycle state, message history, live projections, persistence revisions, and event output.
- New lifecycle entry points must audit every path that changes eviction, queueing, run ownership, or durable state.
- The manager is both a domain aggregate and an infrastructure coordinator.

### Risks

- A completed-looking record may still have an old run unwinding.
- Eviction may make a successful-looking mutation impossible to persist.
- A resumed run may be overwritten by cleanup from the previous run.
- Queue transitions may diverge from durable status.
- Live and durable transcripts may commit segments in a different order.
- Persistence confirmation may evict data still needed by another operation.

### Recommendations

#### 1. Preserve `SubagentManager` as a facade

Do not begin by changing every caller. Keep the existing public API and move responsibilities behind it incrementally. This reduces integration risk across tools, IPC, prompt building, and persistence wiring.

#### 2. Separate durable records from active run state

Define explicit objects with different lifetimes:

```text
SubagentRecord       durable/domain-facing identity and terminal result
SubagentRun          one active run: runId, abort controller, promise, counters
SubagentProjection   renderer-facing live segments, tools, usage, sequence
```

A follow-up creates a new `SubagentRun` generation instead of reusing all run-specific fields on the durable record. Cleanup from an older generation must be unable to clear or overwrite the current generation.

#### 3. Centralize lifecycle transitions

Create a lifecycle store or reducer that owns state transitions and their guards:

```text
agents/subagent-lifecycle.ts
```

Examples:

- `spawn`
- `admit`
- `start`
- `complete`
- `fail`
- `interrupt`
- `queueFollowUp`
- `close`
- `confirmPersisted`

Each transition should return declared effects such as `emitDelta`, `wakeWaiters`, `schedulePersistence`, or `admitNext`, rather than allowing several methods to duplicate the mutation sequence.

#### 4. Extract stream assembly from `_startRun()`

Move `StreamEvent` folding into a focused run assembler:

```text
agents/subagent-run-assembler.ts
```

It should own:

- Text and thinking accumulation.
- Tool call/result pairing.
- Step-result selection.
- Live segment commitment.
- Final or partial transcript construction.

The manager should start the runner, feed events into the assembler, and apply the assembler's outputs through lifecycle/projection interfaces.

#### 5. Extract live projection publication

Move segment mutation, tool snapshots, sequence increments, terminal projection, and delta emission into:

```text
agents/subagent-live-projection.ts
```

This module can be tested by applying a sequence of events and comparing its live projection with the equivalent snapshot, matching the renderer's existing delta-parity tests.

#### 6. Isolate persistence and eviction policy

The checkpoint scheduler is already separate. Continue that direction by moving:

- Dirty-revision tracking.
- Last-persisted revision tracking.
- Hydration decisions.
- Terminal summary eviction.
- Retention FIFO management.

into a persistence/retention collaborator. Persistence eligibility should be expressed as one named predicate or state transition rather than inferred from several flags in multiple modules.

#### 7. Replace timing assumptions with run generations

The existing still-settling guard prevents a known race. A stronger long-term invariant is that every asynchronous run captures a generation and may mutate only when it is still the record's current generation.

This does not remove the need for cleanup, but it prevents an older `finally` block from clobbering a newly resumed run.

### Safe extraction sequence

1. Document and test the lifecycle transition matrix.
2. Introduce a run-generation object while retaining current behavior.
3. Extract `_startRun()` event folding into a pure assembler.
4. Extract live projection and delta publication.
5. Extract persistence revision, hydration, and eviction policy.
6. Reduce `SubagentManager` to a facade coordinating the collaborators.

Avoid a one-shot rewrite of the state model. Existing behavior includes subtle resume, cancel, wait, question, retention, and durability guarantees.

### Acceptance criteria

- Durable record fields do not contain promises, abort controllers, waiter callbacks, or renderer projection state.
- An old run generation cannot mutate a newer follow-up run.
- Lifecycle transitions and effects are defined in one place.
- Stream-event assembly can be tested without constructing the whole manager.
- Persistence eligibility and eviction are owned by one collaborator.
- Existing subagent runtime, tool, IPC, persistence, transcript, question, and eviction tests pass.
- The known resume/cancel/eviction races remain explicitly covered.

---

## SPG-05: `ChatView` renderer god component

### Classification

Confirmed UI coordination monolith, with lower runtime risk than SPG-01 through SPG-04.

### Location

[`renderer/components/ChatView.tsx`](../../electron/src/renderer/components/ChatView.tsx)

### Evidence

The `ChatView` function currently has:

- 1,055 non-blank/non-comment lines.
- Diagnostic cyclomatic complexity 65.
- 21 local `useState` values.
- 23 effects.
- 38 callbacks.
- 35 imports.

It coordinates:

1. Session creation, selection, deletion, rename, and tab working sets.
2. Draft-mode entry, exit, and composer resets.
3. Project selection and project configuration navigation.
4. Chat send, retry, queue, stop, cancellation, and hydration.
5. Provider/model catalog selection and context limits.
6. Theme and personality state.
7. Left and right sidebars.
8. Subagent view navigation.
9. Message queue presentation.
10. MCP status polling.
11. RAG and AST status/index operations.
12. Global shortcuts and overlay focus behavior.
13. Toasts, confirmations, and settings events.
14. Final shell layout and prop assembly.

### Why this qualifies as spaghetti code

- Unrelated product surfaces share one render scope and dependency list.
- Session navigation changes must account for chat hydration, drafts, tabs, providers, and composer state in the same function.
- Effects coordinate state belonging to separate subsystems.
- Large callback dependency arrays make ownership difficult to see.
- Adding a new shell feature increases the cognitive load of every future change to the component.

### Risks

- Stale closures during async navigation or provider changes.
- Effects firing due to unrelated state changes.
- Unnecessary rerenders during token streaming.
- Keyboard and overlay behavior interacting unexpectedly.
- Session/draft state becoming inconsistent after navigation failures.
- Merge conflicts because most renderer-shell work touches one file.

### Recommendations

#### 1. Keep `ChatView` as a layout shell

The target component should primarily:

- Compose the left rail, main pane, composer, footer, and right inspector.
- Select which major surface is visible.
- Pass focused view models and callbacks to those surfaces.

It should not directly implement every subsystem's data loading and transitions.

#### 2. Extract session and draft navigation

Create a focused hook such as:

```text
renderer/hooks/useChatSessionNavigation.ts
```

It should own:

- Session selection and hydration ordering.
- Draft entry and exit.
- Tab close/focus behavior.
- Project-session creation.
- Composer reset decisions.

Its public return value should describe navigation state and named actions rather than exposing every internal setter.

#### 3. Extract provider selection

Create or extend a provider-selection hook that owns:

- Available text-generation models.
- Current/default selection reconciliation.
- Picker labels and detail metadata.
- Session model changes.
- Context-window limit selection.

This also addresses duplicated provider option mapping already noted in the simplification backlog.

#### 4. Extract workspace service status

Create:

```text
renderer/hooks/useWorkspaceServices.ts
```

It should own MCP, RAG, and AST status, polling, workspace-change refresh, indexing actions, and surfaced errors. `ChatView` should receive one view model rather than manage three service lifecycles directly.

#### 5. Extract shell overlays and shortcuts

Group palette, help, close confirmation, inspector focus, global shortcut mapping, and focus trapping in a shell-interaction hook or small controller component.

Related overlay state may use a reducer. Do not move all 21 state values into one giant `ChatContext`; that would relocate the god object rather than remove it.

#### 6. Prefer focused contexts over broad prop drilling only where needed

React context is appropriate for stable cross-cutting shell data used by many descendants, but each context should have one clear domain. Examples include session navigation or provider selection. Avoid one `ChatContext` containing all application state and actions.

### Safe extraction sequence

1. Extract MCP/RAG/AST status because it has a narrow boundary.
2. Extract provider selection and model metadata.
3. Extract session/draft navigation with existing behavior tests intact.
4. Extract shortcut and overlay coordination.
5. Reduce the remaining JSX into named shell sections where that improves readability.

These changes should remain behavior-preserving. Do not combine them with visual redesign or IPC protocol changes.

### Acceptance criteria

- `ChatView` is primarily layout and high-level composition, with a target size below roughly 300 lines.
- Direct MCP/RAG/AST IPC calls live in a workspace-services hook.
- Provider selection and model metadata have one renderer owner.
- Session/draft navigation has a named, independently tested controller.
- Related overlay state has explicit transitions.
- No single replacement context or hook simply absorbs every old responsibility.
- Session navigation, composer, shortcuts, provider selection, and rendering tests pass.
- Streaming does not rerender hidden or unrelated shell sections more often than before.

---

## Large or complex code not currently classified as spaghetti

### `shared/types/ipc.ts`

This file is large because it centralizes the preload contract, channel names, allowlists, and payload types. Splitting it could improve navigation, but its dependency direction and responsibility are clear. Treat it as organizational debt, not a spaghetti hotspot.

### `renderer/utils/tool-title.ts`

`buildToolTitle()` has high measured complexity, but most branches form an explicit tool-name lookup with no shared mutation. A data-driven table may improve extensibility, but the function is not comparable to the lifecycle problems above.

### Parsers and cost calculations

The apply-patch parser, provider cost calculation, and message-history reconciliation contain legitimate branching over structured inputs. They should be tested thoroughly, but branch count alone does not establish entanglement.

### RAG embedder and storage

The RAG files are large but organized into cohesive classes and clearly labeled stages. They are candidates for file-level decomposition if they continue growing, not current priority spaghetti.

### `tool-dispatch.ts`

`executeToolCall()` is a watchlist item. It has diagnostic complexity 45 because it composes argument validation, permission gating, AGENTS.md enforcement, worker dispatch, timeout/cancellation, result projection, and output offloading.

Unlike `streamChat()`, the flow is mostly a linear policy pipeline. Preserve that ordering. If more cross-cutting policies are added, formalize the stages rather than adding more branches to the central function.

### Large renderer forms and the composer

`InputArea`, onboarding, provider wizards, and configuration views are large. Most currently represent cohesive interactive flows. Extract focused hooks or subcomponents as they change; do not schedule broad size-only rewrites.

---

## Recommended remediation sequence

| Wave | Work | Rationale |
|---|---|---|
| 1 | Break runtime cycles in SPG-01 | Establishes trustworthy dependency direction before further decomposition |
| 2 | Extract `streamChat()` controllers and adapters from SPG-02 | Isolates the most complex main-process control flow behind existing tests |
| 3 | Introduce the canonical chat projection/reducer from SPG-03 | Reduces duplicated state before thinning chat IPC and renderer code |
| 4 | Decompose `SubagentManager` from SPG-04 | High value but requires careful lifecycle characterization |
| 5 | Decompose `ChatView` from SPG-05 | Lower-risk renderer cleanup after chat state ownership is clearer |

SPG-02 and the early pure-reducer work in SPG-03 may proceed independently if their file ownership does not overlap. The persistence-authority changes in SPG-03 should wait until the normalized stream contract from SPG-02 is stable.

## Cross-cutting guardrails

1. Refactor one boundary at a time; avoid a main/renderer protocol rewrite in the same change.
2. Preserve public facades initially so callers do not all change together.
3. Capture event traces and lifecycle transition tables before moving logic.
4. Prefer pure reducers/adapters over new process-wide singleton services.
5. Do not introduce a generic framework merely to reduce line counts.
6. Keep current Electron security boundaries, Zod IPC validation, frozen turn context, and exactly-once tool execution unchanged.
7. Add architectural regression checks where the desired property is mechanical, especially runtime import cycles.

## Verification performed for this audit

The following completed successfully on the audited checkout:

```text
npm run typecheck

npx vitest run \
  tests/unit/llm-orchestrator.test.ts \
  tests/unit/chat-ipc.test.ts \
  tests/unit/subagent-runtime.test.ts \
  tests/unit/use-chat-affinity.test.ts \
  tests/unit/chat-live-history-dedupe.test.ts
```

Result:

- TypeScript type-check passed.
- 5 test files passed.
- 197 tests passed.

The complexity figures in this report came from temporary diagnostic ESLint rules and are not existing project lint failures. The import-cycle result came from a static relative-import graph that excluded type-only edges.

## Final assessment

Orchid's macro architecture remains recoverable without a rewrite. The healthiest remediation strategy is to restore dependency direction first, then isolate state machines and authoritative data ownership. The primary goal is not smaller files by itself; it is making each behavior have one owner, one direction of dependency, and one independently testable set of invariants.
