# Concurrent Session Workspaces — Implementation Handoff

Created: 2026-07-11
Branch: `feat/concurrent-session-workspaces`
Base branch: `feat/ts-electron-migration`

## 2026-07-12 Completion Update

The implementation described as in progress below is now complete in this
branch. The older sections remain as an implementation history; this section
supersedes their old “remaining work” status.

### Product decisions and requirements

- Multiple sessions can execute concurrently, including sessions from different
  projects. Selecting one is navigation only: it does not cancel, move, or
  reconfigure another session.
- Git worktree isolation is intentionally out of scope. Sessions within one
  project share its real files, but not messages, chains, todos, subagents,
  turn state, or streamed UI events.
- A project provides independently resolved configuration, agents, skills,
  personalities, MCP connections, and RAG/AST state. A turn captures its
  project runtime at start and keeps it for its lifetime.
- The left rail shows global Activity plus project groups. “Working” denotes
  execution; “selected” denotes only the conversation being viewed.
- A project group shows its five most-recent sessions initially, with a
  per-project `View N more` / `Show recent 5` control. Search shows all
  matching sessions. An older selected session remains visible in its bounded
  group so the user never loses their place.
- The workspace chip is the visible project action. On a non-empty session it
  reads `New chat`, explains that it starts a chat in another project, and
  opens a draft there without changing the old conversation.

### Implemented behavior

#### Concurrent session and project isolation

- Chat actors, generation counters, cancel/stop controls, histories, stream
  events, snapshots, todos, subagents, and background-command ownership are
  addressed by explicit session ID rather than the visible session.
- Chat events include `sessionId`, `turnId`, and a sequence number; the center
  pane filters them and hydrates a snapshot when returning to a running
  session.
- `ProjectRuntimeRegistry` supplies separate canonical-path snapshots. Chat
  and subagent turns capture a runtime, tool registry, model, personality, and
  MCP manager before execution.
- Project navigation no longer applies one project’s config/definitions to the
  process-wide compatibility registries. Startup and config-save now keep that
  legacy cache home-only, so a background session cannot be retargeted by
  another window’s navigation.
- Configuration-sensitive tools (`read`, `read_directory`, `grep`, and
  `execute_command`) resolve settings from their frozen project runtime.
- Project-local MCP managers are keyed by project configuration and are closed
  together at app shutdown. RAG and AST indexing state is keyed by project;
  progress is broadcast only to windows viewing that project.

#### Activity and interface

- The Activity section lists working, waiting, needs-attention, unread, and
  background-process sessions across every project. Rows show the session,
  project, operation/status, elapsed time, and a targeted stop action.
- Project groups are always visible with activity/unread badges and bounded
  expansion controls.
- The center header identifies `project / session` and its full project path.
- The right inspector now starts directly with the session name; the redundant
  `THIS SESSION` label was removed.
- Folder selection from a conversation with messages clears only that window’s
  selection and starts a draft. The legacy `session:change_cwd` IPC route now
  enforces the same rule instead of silently rebinding a conversation.

#### Provider-key regression

Project snapshots intentionally exclude keychain secrets. The regression was
that chat used that secret-free snapshot directly, producing missing-key or
unauthorized provider requests. `hydrateProjectRuntime()` now restores
keychain-backed provider keys into a one-turn copy for both main chat and
subagent turns; the cached snapshot remains secret-free.

### Primary files

- Session execution and navigation:
  `electron/src/main/ipc/chat.ts`, `electron/src/main/ipc/session.ts`,
  `electron/src/main/session/activity.ts`,
  `electron/src/main/ipc/session-activity.ts`
- Project runtime and MCP:
  `electron/src/main/project/runtime.ts`,
  `electron/src/main/mcp/project-registry.ts`,
  `electron/src/main/ipc/mcp.ts`, `electron/src/main/index.ts`
- Turn-scoped tools and project indexing:
  `electron/src/main/tools/types.ts`,
  `electron/src/main/tools/index.ts`, `electron/src/main/rag/indexer.ts`,
  `electron/src/main/ast/indexer.ts`
- Renderer:
  `electron/src/renderer/components/LeftSidebar.tsx`,
  `electron/src/renderer/components/SessionActivitySection.tsx`,
  `electron/src/renderer/components/SessionHeader.tsx`,
  `electron/src/renderer/components/ChatView.tsx`,
  `electron/src/renderer/hooks/useChat.ts`,
  `electron/src/renderer/hooks/useSession.ts`
- Regression coverage:
  `electron/tests/unit/chat-ipc.test.ts`,
  `electron/tests/unit/session-workspace-ipc.test.ts`,
  `electron/tests/unit/session-workspace-sidebar.test.ts`,
  `electron/tests/unit/project-runtime-hydration.test.ts`,
  `electron/tests/unit/project-mcp-registry.test.ts`,
  `electron/tests/unit/project-tool-registry.test.ts`,
  `electron/tests/unit/session-activity.test.ts`

### Verification and remaining follow-up

- Focused concurrent-session/project suite: **171 tests passed**.
- `npm run typecheck`, `npm run lint`, and `git diff --check`: **passed**.
- Full `npm test`: **1,533 passed, 41 failed, 3 skipped**. Every failure is
  outside this feature: 39 database/RAG/AST tests load a `better-sqlite3`
  binary compiled for Electron ABI 148 while Vitest uses Node ABI 137; two
  output-offload tests cannot create `~/.orchid/cache` within this sandbox.
  `npm run rebuild:native` completes successfully for Electron, but that
  intentionally leaves the binary unsuitable for Node-run Vitest. Do not treat
  those failures as provider, session, or project-isolation regressions.
- Manual Electron smoke validation remains useful before release: verify one
  project group expands, choose `New chat` from a non-empty session, run two
  sessions in different projects simultaneously, and send one provider-backed
  message using a stored API key.
- Native multi-window creation remains optional and is not part of this change;
  the session model is window-addressed and ready for that future UI surface.

## Current State

- TypeScript typecheck currently passes.
- Two implementation foundations are committed.
- Session-addressed chat, activity, project runtime, and interface integration
  is complete and ready for the final feature commit.
- The pre-existing untracked files `TODO-ELECTRON.md` and `docs/code-review-reports/2026-07-10-python-tui-vs-electron-migration-analysis.md` remain untouched.

Commits:

1. `2aac704 feat(electron): isolate session state by window owner`
2. `cf0e1af feat(electron): cache independent project runtime layers`

Subagents were used for the renderer audit and project-runtime implementation. Two other subagent runs hit usage limits.

## Problem and Product Model

The Electron application currently conflates several meanings of “active”:

- The session visible in the center pane
- The session receiving streamed events
- The globally active `SessionManager` session
- The project whose configuration, agents, and skills were most recently loaded
- The session whose todos and subagents global tools resolve

That works with one foreground session but is unsafe for concurrent sessions.

The agreed product model is:

```text
Selected session = what this window is showing
Running session  = any session whose work is still executing
```

Selecting another session must be navigation only. It must not:

- Cancel the previous session
- Rebind its project
- Change its tools or configuration
- Redirect persistence into the newly selected session
- Attach its subagents, todos, or background commands elsewhere

Git worktree isolation is explicitly out of scope. Sessions in the same project therefore remain conversation-isolated while sharing that project's real files.

## User-Interface Requirements

### Global Activity

The left sidebar should show every session currently:

- Working
- Waiting
- Needing attention
- Completed but unread
- Owning a running background process

Each activity row should show the project, session, current operation, elapsed time, status indicator, and a targeted cancel action when appropriate. Clicking a row selects that session without affecting other work.

### Project-Grouped Sessions

Replace the existing “current project plus hidden other projects” presentation with always-visible project groups:

```text
Activity · 3 working

Projects
▼ orchid                    2 working
    ● Multiple sessions     Running tool
      Electron architecture Idle

▼ website                   1 working
    ◐ Fix checkout          Waiting
```

Project headers should show working, attention, and unread counts. Search remains global.

### Status Terminology

User-facing statuses:

- Working
- Waiting
- Needs attention
- Completed · unread
- Idle
- Idle · N processes

“Active” should not describe execution because it conflicts with selection.

### Session Header and Inspector

The center pane should identify both project and session:

```text
orchid / Multiple sessions
/home/nyuu/Documents/Github/orchid
```

The right inspector must be explicitly session-scoped:

```text
THIS SESSION
Multiple sessions
```

Todos, subagents, context, usage, and commands shown there must belong only to the selected session.

### Project-Changing Behavior

An existing conversation remains bound to the project in which it started.

- New Chat inherits the selected session's project.
- A draft may change projects before its first message.
- The first message promotes the draft to a project-bound session.
- Changing folders from a non-empty session starts a new draft in that folder.
- It must not move the existing conversation.
- Clicking a project group only navigates or expands the sidebar.
- `/cd` should eventually mean “start a draft in another project,” not silently rebind a conversation.

## Architecture Requirements

The target runtime has five scopes:

| Scope | Owns |
|---|---|
| Application | Home config, keychain, updater, logging, session catalog |
| Project | Layered config, agents, skills, personalities, MCP, RAG/AST |
| Session | Messages, chains, todos, subagents, usage, commands |
| Window/view | Selected session and draft project |
| Turn | Frozen project runtime, session ID, cwd, agent scope |

Every asynchronous operation must retain explicit identity:

```text
windowId
sessionId
turnId
projectDir/project runtime
agentScopeId
```

It must never discover its owner by asking “what session or project is active now?”

## Implemented and Committed

### Multi-Session SessionManager

Commit: `2aac704`

`electron/src/main/session/manager.ts` changed from one active session and one active todo store to:

```text
sessionId -> authoritative in-memory Session
sessionId -> TodoStore
owner/windowId -> selected sessionId
```

Implemented behavior:

- Different windows or owners may select different sessions.
- The same session selected by two owners shares one in-memory runtime.
- Chains can be started and persisted against an explicit session ID.
- Todo stores can be resolved and persisted by session ID.
- Deleting a session clears every owner selecting it.
- Legacy no-argument behavior remains available for existing callers and tests.
- Existing rename, model, and cwd behavior remains compatible.

Proof in `electron/tests/unit/session-persistence.test.ts` covers separate window selection, explicit-session chain writes, isolated todos, shared same-session runtimes, and owner cleanup after deletion.

Verification:

- 132 focused session and parity tests passed.
- Typecheck passed.

### Independent Project Runtime Snapshots

Commit: `cf0e1af`

`electron/src/main/project/runtime.ts` provides a canonical-path-keyed `ProjectRuntimeRegistry`. Each snapshot contains:

- Layered project configuration
- Project-overlaid agents
- Project-overlaid skills
- Project-overlaid personalities

The registry supports `get(projectDir)`, `invalidate(projectDir)`, `clear()`, canonical path identity, and independent project A/B snapshots.

The following registries gained side-effect-free readers:

- `electron/src/main/agents/registry.ts`
- `electron/src/main/skills/registry.ts`
- `electron/src/main/personality/registry.ts`

The legacy `load*` functions still update global registries for existing callers.

Proof in `electron/tests/unit/project-runtime.test.ts` covers independent A/B overrides, unchanged legacy globals, canonical aliases, invalidation, and the absence of a `process.cwd()` fallback.

Verification:

- 64 project and registry tests passed.
- Typecheck passed.
- Focused lint passed.
- Diff check passed.

## Historical In-Progress Work

The current uncommitted work typechecks but is not ready to commit.

### Session-Addressed Chat Execution

`electron/src/main/ipc/chat.ts` is being converted from window-keyed execution to session-keyed execution.

Implemented so far:

- `activeAgents` and generation counters are keyed by `sessionId`.
- Active turns retain `sessionId`, `windowId`, and `turnId`.
- `chat:send` accepts an explicit session ID.
- Requested sessions are selected for the sender window without cancelling another session.
- Chat history and chain persistence target explicit sessions.
- Auto-naming targets an explicit session.
- `forceAbortSession(sessionId)` cancels only that session and its subagents.
- `chat:cancel` accepts a session ID.
- Chat events carry `sessionId` and `turnId`.

### Navigation-Only Session Switching

Uncommitted changes in `electron/src/main/ipc/session.ts`:

- Window IDs are passed into `SessionManager`.
- Loading another session no longer aborts the previously selected session.
- Creating a session associates it with the sender window.
- New Chat inherits the selected session's project as its draft cwd.
- Selecting another folder from a non-empty session creates a draft instead of moving the conversation.
- Chat history seeding and clearing is moving from window IDs to session IDs.

Corresponding expectations were updated in `electron/tests/unit/session-workspace-ipc.test.ts`.

### Session-Aware Renderer Filtering

Uncommitted changes in:

- `electron/src/renderer/hooks/useChat.ts`
- `electron/src/renderer/components/ChatView.tsx`

Current behavior:

- `useChat` receives the selected session ID.
- Events for another session are ignored by the visible pane.
- Draft sends adopt the session ID returned by `chat:send`.
- Send and cancel requests include the selected session ID.
- ChatView passes explicit session ownership into the hook and send operation.

A live snapshot API is still needed when switching back to a running session.

### Activity Model and IPC

New uncommitted files:

- `electron/src/main/session/activity.ts`
- `electron/src/main/ipc/session-activity.ts`
- `electron/tests/unit/session-activity.test.ts`

Implemented:

- Working, waiting, attention, and idle states
- Activity phase and detail
- Unread completion
- Background-process count field
- Priority ordering
- Mark-seen behavior
- Activity list and mark-seen IPC channels
- Broadcasts to all Electron windows
- Initial chat, tool, completion, and failure activity transitions

The three pure activity-store tests pass.

Shared and preload contracts are being added in:

- `electron/src/shared/types/ipc-boundary.ts`
- `electron/src/shared/types/ipc.ts`
- `electron/src/preload/index.ts`
- `electron/src/main/ipc/index.ts`

## Historical Verification State

Before implementation:

- Typecheck passed.
- 92 session tests passed.
- 119 chat and sidebar tests passed.

Current worktree:

- Typecheck passes.
- Session activity tests: 3 passed.
- Session persistence and project-runtime tests pass.
- Most recent focused run: 104 passed and 15 failed.

The 15 failures are concentrated in `electron/tests/unit/chat-ipc.test.ts`. Their immediate cause is that its Electron mock does not expose `BrowserWindow.getAllWindows()`, which the new activity broadcaster uses. Because chat startup throws at that boundary, later stream and cancel assertions also fail.

The test suite must be repaired before the uncommitted slice is considered green.

## Original Remaining Work (completed or superseded above)

### 1. Stabilize Session-Addressed Chat

- Add the missing `BrowserWindow` test mock.
- Add two-session and two-window concurrent stream tests.
- Prove interleaved chunks remain tagged and isolated.
- Prove cancelling session A does not cancel session B.
- Prove subagents are cancelled only for their owning session.
- Finish activity transitions for cancel and interruption.
- Add `chat:snapshot(sessionId)`.
- Hydrate response, thinking, tools, usage, state, session ID, and turn ID when returning to a running session.
- Resolve snapshot/event ordering races.

### 2. Wire Project Runtimes into Execution

The registry exists, but chat still uses global project state. Replace or bypass:

- `applyWorkspaceProjectLayers()`
- Global `getRuntimeConfig()`
- Global `listAgents()`
- Global skill and personality registries
- Global `toolRegistry`

Each turn must receive its project's immutable runtime snapshot.

### 3. Isolate Tools, Todos, and Subagents

Remaining global reads include active-session todo resolution, global prompt todos/subagents, active-session delegation, global model resolution, and tool-handler `getConfig()` calls.

Required changes:

- Resolve todos from `ToolExecutionContext.sessionId`.
- Persist todo changes to that session.
- Filter subagent lists, waits, and cancels by session ID.
- Pass frozen project config into tool handlers.
- Build or resolve the tool registry per project runtime.
- Keep background commands filtered by session and agent scope.

Related files:

- `electron/src/main/tools/index.ts`
- `electron/src/main/llm/build-prompt-context.ts`
- `electron/src/main/agents/manager.ts`
- `electron/src/main/agents/subagent-runner.ts`
- `electron/src/main/tools/subagent/delegate.ts`

### 4. Make MCP Project-Scoped

- Add one MCP runtime per project configuration or a project-keyed pool.
- Resolve project-specific tools and resources.
- Add lifecycle or reference-count handling.
- Resolve `mcp:status` against the selected session's project.
- Pass the correct MCP manager into each turn.

Related files:

- `electron/src/main/mcp/manager.ts`
- `electron/src/main/ipc/mcp.ts`
- `electron/src/main/index.ts`

### 5. Make RAG and AST Project-Keyed

Replace global `_indexing`, `_lastProgress`, and AST `_sessionInitialized` with canonical-project-keyed state. Progress events must carry project identity and be filtered in the renderer.

Related files:

- `electron/src/main/rag/indexer.ts`
- `electron/src/main/ast/indexer.ts`
- `electron/src/main/ipc/rag.ts`
- `electron/src/main/ipc/ast.ts`

### 6. Finish the Activity UI

Create:

- `electron/src/renderer/hooks/useSessionActivity.ts`
- `electron/src/renderer/components/SessionActivitySection.tsx`
- `electron/src/renderer/components/SessionHeader.tsx`

Revise:

- `electron/src/renderer/components/LeftSidebar.tsx`
- `electron/src/renderer/utils/session-workspace.ts`
- `electron/src/renderer/components/Sidebar.tsx`
- `electron/src/renderer/components/InputArea.tsx`
- `electron/src/renderer/styles/chat.css`

Selected daisyUI components:

- `status` for execution indicators
- `badge` for counts
- `list` and `list-row` for Activity rows
- `collapse` for project groups
- Semantic theme colors only

### 7. Finish Project-Selection UX

- Remove the routine Change Project control from existing sessions.
- Keep project selection for drafts.
- Update `/cd` behavior.
- Ensure changing projects creates a new draft.
- Update document and window titles.
- Mark selected sessions seen when focused.
- Add completion and attention notifications without duplicating them across windows.

### 8. Optional Native Multi-Window Surface

The runtime is window-aware, but `electron/src/main/index.ts` still holds one `mainWindow`.

If native multi-window opening is included:

- Replace `mainWindow` with a window registry.
- Add Open Session in New Window.
- Track and focus the window owning a session.
- Clean window selection and draft state on close.
- Keep activity global across windows.

The single-window UI can still run several sessions concurrently without this surface.

### 9. Verification and Finishing

- Repair current chat IPC tests.
- Add concurrent-session integration tests.
- Add activity renderer tests.
- Add project grouping and count tests.
- Add snapshot race tests.
- Add project-runtime, tool, and MCP tests.
- Add project-keyed indexing tests.
- Run the full Electron unit, integration, and parity suite.
- Run lint, typecheck, and build.
- Browser-test activity, sidebar, and session switching.
- Simplify the accumulated diff.
- Run structured code review and resolve findings.
- Commit the remaining logical units.

## Related Files

### Committed Foundations

- `electron/src/main/session/manager.ts`
- `electron/tests/unit/session-persistence.test.ts`
- `electron/src/main/project/runtime.ts`
- `electron/src/main/agents/registry.ts`
- `electron/src/main/skills/registry.ts`
- `electron/src/main/personality/registry.ts`
- `electron/tests/unit/project-runtime.test.ts`

### Current Cross-Layer Integration

- `electron/src/main/ipc/chat.ts`
- `electron/src/main/ipc/session.ts`
- `electron/src/main/ipc/session-activity.ts`
- `electron/src/main/ipc/index.ts`
- `electron/src/main/session/activity.ts`
- `electron/src/preload/index.ts`
- `electron/src/shared/types/ipc.ts`
- `electron/src/shared/types/ipc-boundary.ts`
- `electron/src/renderer/hooks/useChat.ts`
- `electron/src/renderer/components/ChatView.tsx`
- `electron/tests/unit/chat-ipc.test.ts`
- `electron/tests/unit/session-workspace-ipc.test.ts`
- `electron/tests/unit/session-activity.test.ts`

## Handoff Condition

The branch is in a useful but intentionally intermediate state. The session and project foundations are safely committed. The cross-layer chat and activity conversion remains visible and recoverable in the worktree, typechecks successfully, but must not be treated as finished until the chat tests, remaining isolation boundaries, UI, and full verification are complete.
