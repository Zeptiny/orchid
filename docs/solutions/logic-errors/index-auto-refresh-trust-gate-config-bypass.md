---
title: "Index auto-refresh: engine-direct path bypassed trust gate and per-project config resolution"
category: logic-errors
module: indexing
date: 2026-08-22
problem_type: logic_error
component: background_job
severity: high
symptoms:
  - "Merely binding a folder started the chokidar workspace watcher on an untrusted project, no grant required"
  - "External file events on an untrusted project ran embedding/tree-sitter indexing and wrote into its .orchid RAG/AST stores"
  - "Trust revocation detached the watcher but left an armed debounce timer that still flushed onto the revoked project"
  - "Project-level index_refresh settings persisted by the UI were never read (write/read scope mismatch); project ignored_dirs were ignored by the watcher"
root_cause: missing_permission
resolution_type: code_fix
related_components: [project-trust, project-runtime, rag-indexer, ast-indexer, ipc-handlers]
tags: [trust, security, fail-closed, indexing, watcher, rag, ast, project-config]
---

# Index auto-refresh: engine-direct path bypassed trust gate and per-project config resolution

## Problem

The background index-refresh subsystem (`electron/src/main/indexing/` — refresh coordinator, chokidar watcher, mutation-path extraction) called the RAG/AST indexer engines directly instead of through their IPC handlers, silently inheriting none of the contracts that lived only in `ipc/rag.ts` / `ipc/ast.ts`: the fail-closed project-trust gate and the per-project (`.orchid.json`) config resolution. Untrusted projects got watched, embedded, parsed, and written into; project-level config was read from the wrong scope.

Direct recurrence of the rule in `docs/solutions/logic-errors/trusted-projects-fail-closed-gating.md` — with a new bypass vector: the gate existed at one caller layer (IPC) while the engines were callable from another (background subsystems).

## Symptoms

- Binding an untrusted folder started a chokidar watcher; external file events ran embedding/tree-sitter work and wrote index stores into the untrusted project.
- Revoking trust detached the watcher, but a pending debounce timer still fired and flushed a queued batch onto the now-revoked project.
- The project-level `index_refresh` UI persisted values that nothing consumed — the coordinator read process-wide `getConfig()`, which resolves `.orchid.json` only at `process.cwd()`.
- The watcher ignored `ignored_dirs` overrides from the project's `.orchid.json`.
- Entirely silent: no errors, no test failures. Caught only because a reviewer matched the new code against the trust-gating learning, whose rule 1 explicitly lists "RAG/AST indexing" among the gates.

## What Didn't Work

Engine-direct imports (`../rag/indexer`, `../ast/indexer`) looked like the natural seam, and nothing in the engines enforces trust or per-project config — those checks live one layer up in the IPC handlers. The bypass was invisible to the type system and to tests: fixtures that bind fake workspaces mock `getProjectTrustState` to `'trusted'`, so a missing gate cannot fail there. The config half was equally stealthy — `getConfig()` returns correct values whenever the home config matches the defaults, so the overlay miss only manifests when a `.orchid.json` override exists; persisted-but-dead UI values were the only tell. Correctness review alone did not flag it; the institutional-knowledge reviewer pattern-matching the prior doc is what did.

## Solution

**1. Trust gate at the flush sink, fail-closed on throw** (`indexing/refresh-coordinator.ts`):

```ts
function projectTrusted(projectPath: string): boolean {
  try {
    return getProjectTrustState(projectPath) === 'trusted'; // 'untrusted' AND 'changed' both drop
  } catch {
    return false; // fail closed on resolver throw
  }
}
```

`runFlush` drops the batch (logged, `[index-refresh]`) unless `projectTrusted(state.projectPath)`.

**2. Per-project config via the runtime registry with home fallback** — the same resolution chain `ipc/ast.ts` uses, in both coordinator (`currentConfig(projectPath)`) and watcher (`resolveProjectConfig`):

```ts
try {
  return getProjectRuntimeRegistry().get(projectPath).config; // applies the .orchid.json layer
} catch {
  // Runtime cannot resolve the project — home-only config applies.
}
return configOrNull(getConfig); // log-and-drop on failure
```

Background work reads the **live** config, never a turn-frozen projectRuntime snapshot (refreshes may fire long after the turn ends).

**3. Watcher gates at creation and event time** (`indexing/watcher.ts`): `ensureInstance` never creates a chokidar instance for an untrusted project (refcount still held); `eventsEnabled` re-checks trust per event, covering revocation racing an in-flight event.

**4. Revoke cancels pending refresh state** (`ipc/session.ts` → `revokeProjectTrustForDir`): alongside `cancelIndex` + `detachWorkspaceWatcher`, `cancelProjectRefresh(canonical)` clears the project's pending queue, dirty flag, and armed timer — record drop first, then cache invalidation, then work cancellation (the ordering contract from the parent learning's rule 5).

**5. Grant starts the deferred watcher, refcount-neutral** (`ipc/trust.ts` grant path calls `ensureWorkspaceWatcherStarted(dir)`): a project bound while untrusted holds a refcount but no instance; the grant is the only event that flips eligibility. Calling plain `attachWorkspaceWatcher` instead would leak — an extra reference no detach would ever release.

## Why This Works

- **Three independent layers of one gate.** Instance creation, per-event re-check, and flush-time refusal. Even if one layer is raced, the terminal sink drops the work. This is the parent learning's rule 1 applied with the corrected reading: *every entry point regardless of layer*, not every IPC channel.
- **Fail-closed on throw and drift.** A throwing trust resolver and fingerprint-drift (`changed`) both drop, matching the established never-fail-open rule.
- **The revoke race is closed at the source**, not just defended — the armed timer is cleared, layered on top of the flush-time gate.
- **One config truth.** Background work and the IPC layer resolve through the same chain, so the project-config UI, the coordinator's debounce flags, and the watcher's `watch`/`ignored_dirs` read identical values.

## Prevention

Any new **engine-direct execution path** — watchers, background jobs, scheduler-triggered work, worker threads — must, at its entry:

1. **Gate on project trust, fail-closed.** Only `'trusted'` proceeds; `'untrusted'`, `'changed'`, and a throwing resolver all drop.
2. **Resolve config per project** via `getProjectRuntimeRegistry().get(projectPath).config` with `getConfig()` fallback. Never process-wide `getConfig()` in per-project background work — it resolves `.orchid.json` only at `process.cwd()`.
3. **Register cancellation on trust revoke** — clear pending/armed state (`cancelProjectRefresh(path)`) alongside existing cancels.
4. **Gate process start on grant** if untrust deferred it — refcount-neutral `ensure*Started(path)`, never re-attach.

Architectural root cause worth remembering: **invariants enforced at only one call-site layer don't exist for any other caller.** The current pattern replicates gates at each new entry; the harder fix — pushing trust gating into a shared engine-adjacent seam so engine-direct callers cannot forget it — is worth doing before the next engine-direct consumer appears.

**Config-key ripple** (same review, adjacent failure mode): every new top-level `Config` key must be mirrored in the renderer's `config-draft.ts` (the `AssertSameKeys<Config, ConfigPatch>` compile guard enforces it) and in `tests/parity/config.test.ts`, which pins exact key counts. Both are invisible to `tests/unit` — a schema-only addition ships a project-config UI that persists values nothing consumes.

**Process lesson:** reviewers matching `docs/solutions/` against new engine paths is load-bearing review infrastructure, not documentation overhead — this bug was caught exactly that way. Keep the corpus current.

Cross-references: `docs/solutions/logic-errors/trusted-projects-fail-closed-gating.md` (parent rule set), `docs/plans/2026-08-22-001-feat-rag-ast-index-auto-refresh-plan.md` (origin plan), `CONCEPTS.md` → Bind-then-Gate.
