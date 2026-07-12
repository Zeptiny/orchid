# Concurrent Session Workspaces — Code Review

Date: 2026-07-12

Branch: `feat/concurrent-session-workspaces`

Review base: `ead08121b4bc9a499bebc881f8bc8af13ab3d781`
(`feat/ts-electron-migration` merge base)

Status: **Resolved — remediation verified 2026-07-12**

## Remediation update

Every actionable finding below was fixed in the working tree:

- Explicit subagent wait/interrupt operations now enforce `sessionId` ownership.
- Delegated and web-fetch subagents resolve tier models from the frozen project
  runtime; RAG indexing passes the same runtime configuration into its worker.
- Deleting a session first stops its targeted chat/subagent work.
- Project MCP managers use turn leases and retire stale configurations only
  after the last captured turn releases them.
- Lazy draft creation carries a renderer draft generation, preventing stale
  `SESSION_CREATED` events from replacing a newer draft or selection.
- The `changeCwd` IPC type reflects its deliberate nullable draft result.
- The unused chat helper was removed; public activity exports have JSDoc; new
  renderer component files follow the required kebab-case convention.

Verification after remediation:

- Focused affected suite: **10 files / 111 tests passed**.
- `npm run typecheck`: **passed**.
- `npm run lint`: **passed**.
- `git diff --check`: **passed**.

The detailed sections below preserve the original evidence and recommended
fixes as the review record.

## Scope and intent

This review covers the four commits implementing concurrent Electron sessions
and project-scoped runtimes:

1. `2aac704 feat(electron): isolate session state by window owner`
2. `cf0e1af feat(electron): cache independent project runtime layers`
3. `7cdf88a feat(electron): support concurrent project sessions`
4. `d47d510 feat(electron): add project session actions`

The branch changes 69 tracked files (about 5,192 changed executable lines).
Its intended behavior is that several chat sessions can run simultaneously,
including in distinct projects, without sharing session histories, stream
events, todos, subagents, tools, project configuration, provider credentials,
or indexing state. Git worktree isolation is intentionally out of scope.

## Review coverage

The review used independent parallel passes for correctness, security,
reliability, testing, performance, IPC/API contracts, frontend race behavior,
project standards, agent-native parity, and institutional learnings.

The adversarial reviewer could not complete because the platform returned a
usage-limit error. The report therefore does not claim an independent chaos
or cross-model adversarial pass.

The subagent launcher did not expose model or reasoning parameters, so the
requested `gpt-5.6-terra` medium-reasoning override could not be enforced.
No Explorer-type agent was used.

## Findings

### P1 — Explicit subagent IDs bypass session ownership

**Files:** `electron/src/main/tools/subagent/wait.ts:38`,
`electron/src/main/tools/subagent/interrupt.ts:76`

`wait_for_subagent` sends caller-supplied IDs directly to the process-wide
`SubagentManager.wait()`. The result formatting then returns the matching
subagent's task, result/error, and usage. Likewise, `interrupt_subagent`
looks up each explicit ID in the process-wide manager and cancels it without
checking whether the record belongs to `ctx.sessionId`.

The empty-ID interruption path is correctly session-scoped through
`cancelRunning(ctx.sessionId)`, but explicit IDs bypass that boundary. A model
in one session that obtains or guesses another session's subagent ID can read
its output or interrupt it. This directly conflicts with the feature's
session-isolation requirement.

Evidence:

```ts
// wait.ts:38
const records = await manager.wait(subagent_ids);

// interrupt.ts:76
const record = manager.getRecord(sid);
```

Recommended fix:

- Require a session ID in `wait_for_subagent`'s execution context.
- Reject explicit IDs whose record has a different (or absent) `sessionId` as
  not found.
- Prefer `SubagentManager` methods such as `waitOwned(sessionId, ids)` and
  `getOwnedRecord(sessionId, id)` so future callers cannot omit the ownership
  check.
- Add two-session tests proving one session cannot wait for, read output from,
  or interrupt the other's subagents.

### P1 — Delegated subagents use global tier-model configuration

**Files:** `electron/src/main/tools/subagent/delegate.ts:125`,
`electron/src/main/tools/index.ts:193`

The parent tool context correctly carries `projectRuntime`, but delegated
subagents and web-fetch summary subagents resolve their model through
`getModelForTier()`, which reads the process/global configuration. Concurrent
projects with different `tier_models` can therefore execute delegated work on
the wrong configured model.

Evidence:

```ts
// delegate.ts:125
const model = getModelForTier(resolvedTier);

// tools/index.ts:193
model: getModelForTier(agent.tier),
```

Recommended fix:

- Resolve each tier from `ctx.projectRuntime?.config` or, for the summarizer,
  `context.projectRuntime?.config`.
- Retain the global resolver only as a legacy fallback when no project runtime
  exists.
- Add a concurrent two-project regression test with distinct `tier_models`
  covering both `delegate_to_subagent` and web-fetch summarization.

### P1 — RAG indexing ignores the project runtime

**Files:** `electron/src/main/tools/rag/index.ts:66`,
`electron/src/main/rag/indexer.ts:183`

`rag_index` invokes `indexProject()` without the frozen project runtime or
configuration. The indexer then calls `getConfig()`, which now represents the
home/global compatibility configuration rather than a selected project's
configuration. The worker/embedder path also obtains configuration globally.

Consequently, RAG searches can use project-specific settings while the index
was built with global settings. Projects that differ in embedding model,
batching, chunking, thread, ignore, or similar RAG settings cannot remain
isolated.

Evidence:

```ts
// rag/index.ts:66
await indexProject(projectPath, undefined, false);

// rag/indexer.ts:183
const cfg = getConfig();
```

Recommended fix:

- Thread the frozen, secret-free RAG configuration through `rag_index`,
  `indexProject`, the inline implementation, and the worker message.
- Construct/configure the embedder from that frozen project configuration.
- Add tests with two projects whose RAG settings differ, covering both index
  creation and search compatibility.

### P1 — Deleting a background session does not stop its work

**Files:** `electron/src/main/ipc/session.ts:239`,
`electron/src/main/ipc/chat.ts:144`

Deleting a non-selected session removes it from the session catalog and the
activity store, but it does not stop the session-addressed chat actor or its
subagents. The active actor remains in `activeAgents` under the deleted session
ID and can keep calling providers and tools. On completion, it can persist
state and recreate activity for a conversation no longer present in the
catalog.

Evidence:

```ts
// session.ts:239
const deleted = manager.delete(parsed.data.id);

// chat.ts:144
const activeAgents = new Map<string, ActiveAgent>();
```

Recommended fix:

- Target-stop or target-abort the requested session before deleting it,
  regardless of which window currently selects it.
- Ensure terminal persistence and activity updates are suppressed once the
  session is deleted.
- Add an IPC regression test that deletes a running, non-selected session and
  verifies its actor/subagents stop and no activity or snapshot can reappear.

### P1 — MCP managers accumulate for historical configurations

**File:** `electron/src/main/mcp/project-registry.ts:49`

The MCP registry key includes the entire project server configuration. Any
project configuration change creates a new manager and can start another set
of server transports. Old managers remain in both `byProject` and `managers`
until application shutdown; runtime/config invalidation does not retire them.

This leaks MCP server processes and connections during a long-running app
session where a project configuration changes repeatedly.

Evidence:

```ts
// project-registry.ts:49
const manager = new MCPManager();
```

Recommended fix:

- Add manager invalidation that closes and removes superseded configurations
  once no turn still holds their frozen runtime.
- Connect definition/config/runtime invalidation to that lifecycle.
- Test repeated MCP configuration edits and verify old transports are closed
  rather than accumulated.

### P2 — Delayed session creation can steal a pending selection

**File:** `electron/src/renderer/hooks/useSession.ts:153`

The `SESSION_CREATED` listener adopts every created session whenever
`activeSession` is `null`. A pending session load leaves that state null until
its IPC request finishes. If a draft send lazily creates a session during that
interval, its delayed event can set the created session as selected even though
the user has already selected another conversation or started another draft.

`ChatView` has a selection generation guard for session-load and snapshot
responses, but that guard does not cover the independent `SESSION_CREATED`
subscription in `useSession`.

Evidence:

```ts
// useSession.ts:153
setActiveSession((prev) => {
  if (prev != null) return prev;
  return event.session;
});
```

Recommended fix:

- Track draft/navigation generation or the pending lazy-created session ID.
- Adopt `SESSION_CREATED` only when it belongs to the current draft generation.
- Add a delayed-event test covering New Chat/project selection and a pending
  `session:load` request.

### P2 — `session.changeCwd` has an inaccurate public return type

**Files:** `electron/src/shared/types/ipc.ts:451`,
`electron/src/main/ipc/session.ts:343`

The public preload contract declares `changeCwd` as `Promise<Session>`. The
new behavior deliberately returns `null` when a conversation already has
chains, because changing its project now opens a draft instead of mutating the
old conversation. Existing or future consumers can therefore legally infer a
`Session` and dereference a `null` value on the normal non-empty-session path.

Evidence:

```ts
// ipc.ts:451
changeCwd: (message: SessionChangeCwdMessage) => Promise<Session>;

// session.ts:343
return hadConversation ? null : manager.getActive(windowId);
```

Recommended fix:

- Change the return contract to `Promise<Session | null>`, or preferably use a
  discriminated result that makes the new-draft behavior explicit.
- Update preload typing, consumers, and tests together.

### P3 — New renderer files violate the naming convention

**Files:** `electron/src/renderer/components/SessionHeader.tsx:1`,
`electron/src/renderer/components/SessionActivitySection.tsx:1`

`electron/CLAUDE.md` requires `kebab-case.ts` and `kebab-case.tsx` filenames.
The new files are PascalCase, so the branch introduces a documented project
standards violation.

Recommended fix:

- Rename the files to `session-header.tsx` and
  `session-activity-section.tsx` and update imports.

### P3 — Session-activity public exports lack JSDoc

**File:** `electron/src/main/ipc/session-activity.ts:31`

`electron/CLAUDE.md` requires JSDoc on exports. New public functions in this
module, including `publishSessionActivity` and `completeSessionActivity`, do
not have it.

Recommended fix:

- Add concise JSDoc to every exported activity IPC lifecycle function.

## Verified non-findings and residual risks

- A security pass identified unrestricted `chat:snapshot(sessionId)` access
  from a renderer. It was not retained as a primary finding: the current app
  has no native multi-window surface, and a renderer can already select any
  catalogued same-user session. If native multi-window sharing boundaries are
  introduced, re-evaluate snapshot authorization.
- The performance pass noted that different projects may index concurrently
  and project runtime snapshots are not evicted. Both are intentional parts of
  the current concurrent-project model. A shared index-worker budget and cache
  policy may become necessary under large project counts, but neither was
  retained as an immediate defect.
- The historical MCP lifecycle learning requires cancellation-path shutdown
  coverage for a real in-progress MCP startup/runner. Current registry tests
  verify mock manager shutdown only. This is a test gap, not evidence of a
  current defect.
- Existing provider-key hydration coverage verifies restoration and cached
  runtime immutability. An IPC-level check that no hydrated key reaches a
  renderer or persisted snapshot would further strengthen that boundary.

## Verification performed

| Check | Result |
|---|---|
| `git diff --check` | Passed |
| Focused concurrent-session suite | Passed: 6 files, 36 tests |
| `npm run typecheck` | Passed |
| `npm run lint` | Failed |

Lint failure:

```text
electron/src/main/ipc/chat.ts:684
'resolveUiWorkspaceCwd' is defined but never used.
```

This lint failure is already sufficient to block merge until the unused helper
is removed or made necessary. It is not listed as a separate code-review
finding because the linter reports it directly.

## Recommended remediation order

1. Enforce subagent ownership in explicit wait/interrupt operations.
2. Make all delegated, web-fetch, and RAG execution use the frozen project
   runtime configuration.
3. Stop and tombstone work before deleting a session.
4. Add MCP manager retirement for superseded configuration snapshots.
5. Close the selection-creation race and correct the legacy `changeCwd` IPC
   contract.
6. Add the missing regression coverage, fix lint, then rerun the focused
   suite, typecheck, lint, and an Electron smoke test with two projects.
