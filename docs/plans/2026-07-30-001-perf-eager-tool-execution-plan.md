---
title: "perf: Eager tool execution during model streaming"
type: perf
date: 2026-07-30
branch: perf/eager-tool-execution
---

# Eager Tool Execution During Model Streaming

## Summary

Start executing a tool call as soon as its arguments finish streaming, even while the model is still generating subsequent tool calls in the same step. Today the AI SDK defers **all** tool execution until the model finishes the entire step, then runs the batch via `Promise.all`. This change overlaps tool execution with the tail of the model's generation, reducing wall-clock latency for multi-tool steps without altering the agentic loop, message accumulation, usage accounting, or result semantics.

The mechanism is **pre-execution memoization**: Orchid kicks off `executeToolCall` when it sees the incremental `tool-input-available` stream chunk, stores the promise keyed by `toolCallId`, and the tool's AI SDK `execute` callback becomes a thin shim that awaits the already-running promise. The SDK continues to own the multi-step loop entirely.

## Problem Frame

The core agent loop delegates tool execution to the Vercel AI SDK (`ai@7.0.19`). Each tool is registered with an `execute` callback (`orchestrator.ts:1023`, skill `:1065`, MCP `:1124`), and `streamText` drives the multi-step loop via `stopWhen` (`orchestrator.ts:585-658`). The XState agent machine is informational-only for tools (`agent-machine.ts:319-387`) — it never schedules execution.

Inside the SDK, `executeToolsFromStream` (`node_modules/ai/dist/index.js:7688`) governs timing:

- As the model streams, each completed tool call emits a `tool-call` chunk **incrementally**, per tool, mid-stream. The UI-facing stream surfaces this as `tool-input-available` (`index.js:7344`) carrying the validated `input`, `toolCallId`, `toolName`, and `providerExecuted` flag.
- The SDK only **collects** these: `toolCallsToExecute.push(chunk)` (`index.js:7731`, `:7791`).
- Execution happens only on the `model-call-end` chunk — after the model finishes the **entire** step — via `Promise.all(toolCallsToExecute.map(...))` (`index.js:7795-7831`).

Consequence: when a step contains tool calls #1…#N, tool #1 does not begin until #2…#N have finished *generating*. There is no SDK option to change this; the deferral to `model-call-end` is unconditional.

Orchid already receives the incremental `tool-input-available` chunk and even pauses its idle watchdog there (`orchestrator.ts:744-759`) — it simply does not act on it. The hook point for eager execution already exists in the event stream.

**Why this is semantically safe:** within a single assistant step, all tool calls are generated without any results available to the model, so they are independent by construction. The SDK already executes them concurrently via `Promise.all`. Starting them earlier overlaps execution with generation but does not change the set of concurrent operations or their relative ordering — any race that could occur with eager execution (e.g., two tools touching the AGENTS.md seen-tracker) can already occur today.

**Expected magnitude:** the saving per step is `min(remaining generation time of #2…#N, execution time of #1…#N-1)`. Largest for steps mixing a slow tool (`execute_command` build, slow MCP tool) with others, or steps with many calls. Modest for the common case of a few fast `read`/`grep` calls. This is a latency refinement, not a throughput change.

## Requirements

**Eager execution**

- R1. When a tool call's arguments are fully streamed (`tool-input-available`), its handler begins executing immediately, without waiting for the rest of the step to finish generating.
- R2. Eager execution applies uniformly to registry tools, the per-agent `skill` tool, and MCP tools.
- R3. Provider-executed tools (`providerExecuted: true`) are never eagerly executed locally — the provider owns their execution.

**Correctness preservation**

- R4. Each tool call executes exactly once. The SDK's `execute` callback returns the result of the eager run; it never triggers a second execution.
- R5. If a tool call was not eagerly started for any reason, the `execute` callback falls back to running it normally — behavior is identical to today.
- R6. Tool results, canonical status, agent projections, output offloading, AGENTS.md injection/enforcement, and permission gating are byte-for-byte identical to the current path (all still flow through `executeToolCall`).
- R7. Cancelling the turn (abort signal) cancels eagerly-started tools in flight, exactly as it cancels tools today.
- R8. A tool handler that throws produces the same error result it produces today; the error surfaces through the SDK's normal tool-error handling.

**Lifecycle**

- R9. Eager-execution state is scoped to a single `streamChat` invocation and does not leak across turns or idle-retry attempts.
- R10. The idle watchdog, usage accounting, and step-event delivery continue to behave as they do today.

**Verification**

- R11. A test demonstrates that a tool's handler is invoked before the model finishes generating a subsequent tool call in the same step (the defining behavior of this change).

## Key Technical Decisions

**KTD-1. Pre-execution memoization, not a manual agent loop.**
The alternative — taking over the agentic loop from the SDK (the "manual agent loop" cookbook pattern) and calling `streamText` one step at a time — would also achieve eager execution, but forces reimplementation of multi-step message accumulation, reasoning/thinking pass-back (required by Anthropic), per-step usage aggregation, `onStepFinish`, `stopWhen`, and middleware application. Memoization keeps all of that intact: the SDK still calls `execute` at `model-call-end` via `Promise.all`, but each `execute` awaits work that started earlier. The change is confined to `buildToolMap` and the `tool-input-available` handler.

**KTD-2. A coordinator object bridges `buildToolMap` and the stream loop.**
`buildToolMap` knows the correct registry per tool (main `registry`, a one-shot `skillRegistry`, or a per-MCP-tool `dynamicRegistry`), but the `tool-input-available` chunk arrives later in the stream loop, keyed by `toolCallId` (unknown at build time) and `toolName`. A small `EagerToolExecutor` coordinator resolves this:
- `buildToolMap` registers a **launcher** per internal tool name, each bound to its own registry + frozen `ToolDispatchOptions`.
- The stream loop calls `coordinator.start(toolName, toolCallId, input)` on `tool-input-available`; the coordinator looks up the launcher, invokes `executeToolCall`, and stores the promise keyed by `toolCallId`.
- The `execute` shim calls `coordinator.take(toolCallId)`; if a promise exists it awaits it, otherwise it falls back to a direct `executeToolCall` (R5).
This keeps registry knowledge inside `buildToolMap` and avoids the stream loop needing per-tool registry resolution.

**KTD-3. Key launchers by internal tool name; key in-flight promises by `toolCallId`.**
MCP tools are registered in the SDK tool map under a provider-mangled name (`toProviderMcpToolName`), but the stream loop normalizes chunk tool names back to internal names via `toInternalToolName` (`orchestrator.ts:748`). Launchers are therefore keyed by **internal** name so the loop's normalized name resolves directly. In-flight promises are keyed by `toolCallId` (globally unique), which is what the `execute` shim receives in `executionOptions.toolCallId`.

**KTD-4. Eager execution uses the turn-level abort signal only.**
The SDK's per-call abort signal is created inside `executeToolsFromStream` and is only available inside the `execute` callback — not at `tool-input-available` time. Eager execution passes `dispatchOptions.abortSignal` (the parent-turn signal, `tool-dispatch.ts:123`), which is the signal user cancellation (Esc) aborts. The fallback path inside the shim still combines both via `withSdkAbortSignal` as today. Net effect: user cancellation works for eager tools; the SDK's secondary per-call signal is only relevant on the fallback path. This matches the cancellation guarantee users observe today.

**KTD-5. Coordinator lifetime matches `tools`, not the idle-retry attempt.**
`buildToolMap` runs once per `streamChat` (`orchestrator.ts:465`), outside the idle-retry loop (`:505`), while `seenToolCallIds` is per-attempt (`:547-548`). The coordinator is created alongside `tools` (once) and shared with both the `execute` closures and the per-attempt stream loop. Because `toolCallId`s are globally unique, stale entries from an idle-aborted attempt can never collide with a later attempt's IDs; an aborted attempt's rejected promise is simply never looked up again. No per-attempt clearing is required, though `take()` removes entries on read so the map stays bounded by in-flight + unread tools.

**KTD-6. Trigger on `tool-input-available`, skip `providerExecuted` and duplicates.**
The stream loop already has a `case 'tool-input-available': case 'tool-call':` branch (`orchestrator.ts:744`). Eager start is added there, guarded by: `toolCallId` present, `part.providerExecuted !== true` (R3), and not already started (idempotent against the dual `tool-input-available`/`tool-call` labeling and any repeated chunks). The parsed `part.input ?? part.args` object is passed directly to `executeToolCall` (which accepts pre-parsed args, `tool-dispatch.ts:168-182`) — not the stringified form used for the UI `StreamEvent`.

**KTD-7. `executeToolCall` and the projection/offload pipeline are unchanged.**
All size control, AGENTS.md handling, permission gating, and canonicalization live inside `executeToolCall` (`tool-dispatch.ts:149`). Eager execution calls the same function with the same frozen `ToolDispatchOptions`, so R6 holds by construction. No projection-level or offload-level changes.

## High-Level Technical Design

**Current timing (SDK-deferred):**

```
model stream:  ──[tool#1 args]──[tool#2 args]──[tool#3 args]──┤ model-call-end
                                                                  │
SDK:           collect #1      collect #2       collect #3        ├─ Promise.all(exec #1,#2,#3)
                                                                  │      ▲
execute #1 ───────────────────────────────────────────────────────┘      │
                                                            (idle gap — #1 waits for #3 to finish generating)
```

**Proposed timing (eager):**

```
model stream:  ──[tool#1 args]──[tool#2 args]──[tool#3 args]──┤ model-call-end
                       │                │               │
tool-input-available:  ▼                ▼               ▼
coordinator.start(#1)  start(#2)        start(#3)
       │                  │                │
exec #1 ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│                │          ← runs while #2,#3 still generate
exec #2                 ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│
exec #3                                  ▓▓▓▓▓▓▓▓▓▓▓
                                                          │
model-call-end → SDK Promise.all(execute shims) ──────────┤  each shim awaits the
                                                          │  already-running promise
                                                          ▼  (usually already resolved)
                                                   tool-output-available
```

**Coordinator shape:**

```
EagerToolExecutor
  ├─ launchers: Map<internalToolName, (toolCallId, input) => Promise<ToolExecutionResult>>
  │     └─ populated by buildToolMap, one per tool, bound to its registry + dispatchOptions
  ├─ inflight:  Map<toolCallId, Promise<ToolExecutionResult>>
  ├─ start(toolName, toolCallId, input):
  │     launcher = launchers.get(toolName); if none → no-op (fallback path will run it)
  │     if inflight.has(toolCallId) → no-op (idempotent)
  │     inflight.set(toolCallId, launcher(toolCallId, input))
  └─ take(toolCallId): Promise<ToolExecutionResult> | undefined
        pops and returns inflight.get(toolCallId)   ← used by the execute shim
```

**Execute shim (per tool, in buildToolMap):**

```
execute: async (args, { toolCallId, abortSignal }) => {
  const eager = coordinator.take(toolCallId);
  if (eager) return eager;                       // R4: await the eager run, no re-exec
  return executeToolCall(                        // R5: defensive fallback (today's behavior)
    { id: toolCallId, name, args },
    registry,
    withSdkAbortSignal(dispatchOptions, abortSignal),
  );
}
```

## Implementation Units

### U1. EagerToolExecutor coordinator

**Goal:** A small, pure module that bridges eager start (stream loop) and await (execute shim), with launcher registration and in-flight promise tracking.

**Requirements:** R2, R4, R5, R9

**Dependencies:** None

**Files:**
- `electron/src/main/llm/eager-tool-executor.ts` — new file
- `electron/tests/unit/eager-tool-executor.test.ts` — new file

**Approach:**
- `type ToolLauncher = (toolCallId: string, input: unknown) => Promise<ToolExecutionResult>`
- `class EagerToolExecutor`:
  - `registerLauncher(internalToolName: string, launcher: ToolLauncher): void`
  - `start(internalToolName: string, toolCallId: string, input: unknown): void` — no-op if no launcher or already in-flight (idempotent); otherwise invoke launcher and store the promise. Launcher exceptions must not throw synchronously out of `start` — the launcher returns a promise, so a rejection is captured in the stored promise and surfaces when awaited (R8).
  - `take(toolCallId: string): Promise<ToolExecutionResult> | undefined` — returns and deletes the in-flight entry (bounds memory, R9).
  - `has(toolCallId: string): boolean` — optional, for tests/logging.
- No SDK imports; depends only on the `ToolExecutionResult` type. Fully unit-testable without mocking `ai`.

**Patterns to follow:** plain-class coordinators in `llm/` (e.g., the snapshot builder in `context-snapshot.ts`).

**Test scenarios:**
- `start` with a registered launcher invokes it once and stores the promise; `take` returns the same promise and removes it.
- `start` is idempotent: a second `start` for the same `toolCallId` does not re-invoke the launcher.
- `start` with no launcher for the tool name is a no-op; subsequent `take` returns `undefined` (fallback path).
- `take` for an unknown `toolCallId` returns `undefined`.
- A launcher that returns a rejected promise: `take` returns the rejecting promise (error propagates to awaiter, not to `start`).
- Two different tool names register independent launchers; interleaved starts resolve to the correct promises.

**Verification:** Unit tests pass with fake launchers (no real tools, no SDK).

### U2. Wire launchers and execute shims into buildToolMap

**Goal:** Register a launcher for every tool (registry, skill, MCP) bound to its correct registry, and replace each `execute` body with the await-or-fallback shim.

**Requirements:** R2, R3, R4, R5, R6, R8

**Dependencies:** U1

**Files:**
- `electron/src/main/llm/orchestrator.ts` — modify `buildToolMap` (`:997-1152`): accept an `EagerToolExecutor`, register launchers, swap `execute` bodies
- `electron/tests/unit/build-tool-map-eager.test.ts` — new file

**Approach:**
- Add a parameter `eager: EagerToolExecutor` to `buildToolMap` (after `skillOptions`).
- For **registry tools** (`:1014-1045`): define a launcher `(toolCallId, input) => executeToolCall({ id: toolCallId, name: definition.name, args: input }, registry, dispatchOptions)` and `eager.registerLauncher(definition.name, launcher)`. Replace the `execute` body with the shim: `const p = eager.take(executionOptions.toolCallId); if (p) return p; return executeToolCall({ id, name, args }, registry, withSdkAbortSignal(dispatchOptions, executionOptions.abortSignal))`.
- For the **skill tool** (`:1049-1087`): same, bound to `skillRegistry`; launcher key is the skill tool's internal name (`definition.name`, i.e. `skill`).
- For **MCP tools** (`:1090-1148`): launcher bound to the per-tool `dynamicRegistry` and the **internal** name (`definition.name`), not `providerName` (KTD-3). The shim is identical, using `internalName` in the fallback `executeToolCall`.
- `toModelOutput` is unchanged for all three — it parses whatever the shim returns, which is the same `ToolExecutionResult` shape as today.
- The fallback path preserves `withSdkAbortSignal` exactly as today; the eager path relies on `dispatchOptions.abortSignal` already embedded in the launcher's options (KTD-4).

**Patterns to follow:** the existing per-category `execute`/`toModelOutput` construction already in `buildToolMap`; keep the three categories structurally parallel.

**Test scenarios:**
- A registry tool: after `eager.start(name, id, input)`, calling the tool's `execute(args, { toolCallId: id })` returns the eager result and the underlying handler runs exactly once (spy count === 1) (R4).
- A registry tool with no eager start: `execute` falls back and runs the handler once, returning an identical result (R5 parity).
- Skill tool and MCP tool each honor eager start and fallback (R2).
- MCP launcher is keyed by internal name: `eager.start(internalName, ...)` is picked up by the MCP tool's `execute` even though the SDK map key is the provider name (KTD-3).
- Eager result and fallback result are deep-equal for the same input (R6).
- A handler that throws: eager promise rejects and `execute` rejects with the same error (R8).

**Verification:** Unit tests build a real `ToolRegistry` with a stub handler, call `buildToolMap`, and drive `execute` directly. No SDK stream needed.

### U3. Trigger eager start from the stream loop

**Goal:** On `tool-input-available`, start eager execution for eligible tools.

**Requirements:** R1, R3, R10

**Dependencies:** U1, U2

**Files:**
- `electron/src/main/llm/orchestrator.ts` — create the coordinator next to `tools` (`:465`), pass it to `buildToolMap`, and invoke `coordinator.start(...)` in the `tool-input-available`/`tool-call` case (`:744-759`)
- `electron/tests/unit/orchestrator-eager-execution.test.ts` — new file (see Testing Strategy)

**Approach:**
- In `streamChat`, before `buildToolMap`: `const eager = new EagerToolExecutor();` and pass it into `buildToolMap(...)` (KTD-5: same lifetime as `tools`, outside the idle-retry loop).
- In the `case 'tool-input-available': case 'tool-call':` branch (`:744`), after computing `toolCallId` and `toolName` (internal), add:
  ```
  if (toolCallId && part.providerExecuted !== true) {
    eager.start(toolName, toolCallId, part.input ?? part.args);
  }
  ```
  `eager.start` is itself idempotent, so the dual-label case and repeated chunks are safe (KTD-6). The existing `pauseIdleForTool()` and `StreamEvent` yield remain unchanged (R10).
- The parsed input object (`part.input ?? part.args`) is passed directly — not `stringifyToolInput(...)` — because `executeToolCall` accepts pre-parsed args.
- `providerExecuted` is read from the chunk (present per `index.js:7349`); provider-executed tools are skipped (R3). Their `execute` is never called by the SDK anyway, so the shim is never hit for them.

**Patterns to follow:** the existing guards in this branch (`seenToolCallIds`, `deliveredAny`). Eager start is independent of `seenToolCallIds` (it keys on the coordinator's own in-flight set) but sits in the same branch for locality.

**Test scenarios:** see Testing Strategy (timing assertion is the headline test, R11).
- `tool-input-available` for a non-provider tool triggers exactly one `eager.start`.
- `tool-input-available` with `providerExecuted: true` triggers no start.
- Repeated `tool-input-available`/`tool-call` chunks for the same id start only once.
- Idle watchdog still pauses on `tool-input-available` (unchanged behavior).

**Verification:** The orchestrator integration test (below) plus the coordinator/shim unit tests.

### U4. Regression guardrails

**Goal:** Ensure the existing dispatch behaviors are provably unchanged through the eager path.

**Requirements:** R6, R7, R10

**Dependencies:** U2, U3

**Files:**
- `electron/tests/unit/eager-tool-executor.test.ts` — extend (abort propagation)
- `electron/tests/unit/agents-md-enforcement.test.ts` — extend with an eager-path parity case (reuse the existing `executeToolCall` harness)

**Approach:**
- **Cancellation (R7):** create an `AbortController`, pass its signal in `dispatchOptions`, `start` a long-running stub tool, abort, and assert the stored promise resolves/rejects to the cancelled terminal execution that `executeToolCall` already produces for an aborted signal (`tool-dispatch.ts:158-166`).
- **AGENTS.md parity (R6):** run one write-tool call through the eager path and one through the direct path with the same session tracker state; assert identical enforcement outcomes for `block`/`warn`/`inject`. This reuses the existing `executeToolCall` test harness in `agents-md-enforcement.test.ts`.
- **Output offloading parity (R6):** assert a large tool result is offloaded identically whether produced eagerly or via fallback (same `ToolExecutionResult.agentProjection`).

**Patterns to follow:** the dynamic-import + `executeToolCall` harness already established in `agents-md-enforcement.test.ts:359+`.

**Test scenarios:**
- Abort before/during eager execution yields the same cancelled result as today.
- AGENTS.md `block` denies an eagerly-started write exactly as it denies a direct write.
- Offloaded projection content is byte-identical across eager vs fallback.

**Verification:** Extended suites pass; no changes to `tool-dispatch.ts` required (this unit only adds tests, confirming KTD-7).

## Testing Strategy

**Unit (no SDK):** U1 coordinator and U2 `buildToolMap` shim tests exercise the full eager-vs-fallback logic with stub handlers and a real `ToolRegistry`. These cover R2, R4, R5, R6, R8, R9 deterministically.

**Integration (mocked SDK stream):** the headline timing test (R1, R11) drives `streamChat` against a mocked `streamText`. `streamChat` obtains the SDK via `importESM('ai')` (`orchestrator.ts:367`); the test mocks the `ai` module (vitest `vi.mock` / module stub) so `streamText` returns an object whose `fullStream` is a hand-authored async generator emitting, in order:
1. `start-step`
2. `tool-input-available` for tool A (a slow stub handler that records its start timestamp and awaits a controllable promise)
3. a measurable delay (e.g., a few `await setTimeout` ticks simulating tool B's generation)
4. `tool-input-available` for tool B
5. `model-call-end` / `finish-step`

Assertion: tool A's handler start timestamp is recorded **before** step 4 completes (i.e., before the model "finishes" generating B) — the defining behavior. A secondary assertion confirms each handler ran exactly once and both results were yielded as `tool_result` events.

A fallback integration case emits `tool-call` chunks but bypasses eager start (e.g., provider-executed flag) and asserts behavior matches the pre-change path.

**Parity (existing harness):** U4 reuses `agents-md-enforcement.test.ts` patterns to prove dispatch-side behavior is unchanged.

**Manual smoke:** run a turn that emits several tool calls (e.g., multiple `read`/`grep`) and a turn with one slow `execute_command` alongside a fast tool; confirm results are correct and observe earlier tool-result arrival in the tool rail.

## Risks & Dependencies

**Risk: tool-approval coupling (latent).**
The SDK's `executeToolsFromStream` resolves tool approval before pushing to `toolCallsToExecute` (`index.js:7721-7793`). Orchid passes no `toolApproval` to `streamText` (`orchestrator.ts:585-658`), so every tool is `not-applicable` → auto-executed, and eager start matches current semantics. If a tool-approval system is added later (a `feat/tool-permission-system-plan.md` exists), eager start would bypass the approval gate and must be reconciled then. Mitigation: document this coupling in `eager-tool-executor.ts`; gate `eager.start` behind a future "approval not required" check if/when approval lands.

**Risk: SDK per-call abort signal not applied to eager runs.**
Eager execution uses only `dispatchOptions.abortSignal` (KTD-4). The SDK's secondary per-call signal (created inside `executeToolsFromStream`) does not propagate to eager work. User cancellation (Esc → turn abort) is fully covered; only an SDK-internal per-call abort (not a user-facing path today) would differ. Acceptable; revisit if the SDK gains user-visible per-tool cancellation.

**Risk: nondeterministic within-step ordering.**
Eager tools start at staggered times as their inputs complete, rather than all at `model-call-end`. The set of concurrently-running tools is unchanged (the SDK already runs the batch via `Promise.all`), so no new races are introduced — but timing-sensitive tests must not assume a fixed completion order. Mitigation: tests assert start-time ordering (deterministic, driven by the mocked stream) and execution counts, not completion order.

**Risk: memory growth in the in-flight map.**
`take()` deletes entries on read, and the SDK reads every started tool at `model-call-end`, so the map is bounded by tools started-but-not-yet-awaited within a step. The coordinator is garbage-collected with the `streamChat` generator. A tool started eagerly but never awaited (e.g., the stream errors before `model-call-end`) leaves a promise that settles and is collected with the coordinator. No unbounded growth.

**Risk: idle-retry attempt reuse.**
The coordinator outlives individual idle-retry attempts (KTD-5). An attempt that idle-aborts leaves rejected promises in the map; later attempts use fresh `toolCallId`s and never look them up. Confirmed safe by ID uniqueness; a per-attempt `clear()` could be added for tidiness but is not required for correctness.

**Dependency: none on the worker-pool offload plan.**
This change is orthogonal to `2026-07-24-001-refactor-worker-pool-tool-offload-plan.md`. Eager execution calls the same `executeToolCall`; whether a handler runs inline or in a worker is decided inside it. The two can land in either order.

## Sources / Research

- SDK deferral (decisive): `executeToolsFromStream` — `node_modules/ai/dist/index.js:7688`; collect at `:7731`/`:7791`; execute at `model-call-end` via `Promise.all` at `:7795-7831`.
- Incremental `tool-input-available` UI chunk with `input`/`toolCallId`/`providerExecuted`: `node_modules/ai/dist/index.js:7344-7354`.
- SDK version: `ai@7.0.19` (`electron/package.json:52`).
- Orchid stream loop: `streamChat` (`orchestrator.ts:346`), `buildToolMap` call (`:465-479`), `streamText` invocation (`:585-658`), idle-retry loop (`:505`), per-attempt seen-sets (`:547-548`), `tool-input-available`/`tool-call` case (`:744-759`).
- `buildToolMap` execute wiring: registry (`:1023-1036`), skill (`:1065-1078`), MCP (`:1124-1139`); `toModelOutput` (`:1037-1043`).
- Helpers: `streamToolCallId` (`:1257`), `stringifyToolInput` (`:1246`), `toInternalToolName` (`:87`), `toProviderMcpToolName` (`:74`), `withSdkAbortSignal` (`:1154`).
- Dispatch contract: `executeToolCall` (`tool-dispatch.ts:149`), `ToolDispatchOptions.abortSignal` (`tool-dispatch.ts:123`), aborted-signal short-circuit (`:158-166`), pre-parsed args handling (`:168-182`).
- XState machine is informational-only for tools: `agent-machine.ts:319-387`.
- Existing `executeToolCall` test harness: `electron/tests/unit/agents-md-enforcement.test.ts:359+`.
- AI SDK docs (lifecycle hooks, parallel tool calls): ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling, /resources/recipes/node/call-tools-in-parallel.
