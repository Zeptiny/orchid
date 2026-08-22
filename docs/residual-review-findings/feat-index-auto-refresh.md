# Residual Review Findings — feat/index-auto-refresh

Source: code review run `20260822-184948-97ac2961` (11 reviewers, artifacts under `/tmp/code-review/20260822-184948-97ac2961/`).
All P1/P2 findings were fixed on-branch (commits `f7636ddc`, `d33bfef1`, `0b9228c3`, `49c1a6a8`, `0538868b`, `bd2df719`, `4765a563`). The items below were accepted as residuals.

| # | Severity | Location | Finding |
|---|----------|----------|---------|
| 1 | P3 | `electron/src/main/indexing/watcher.ts` (~63) | A failed chokidar `importESM` is cached forever — one transient import failure disables watching until restart. Fix: clear the memoized promise on rejection. |
| 2 | P3 | `electron/src/main/indexing/refresh-coordinator.ts` (~110) | Pure debounce with no max-wait: sustained sub-window churn (dev-server rewrites) can postpone a flush indefinitely. Fix: first-entry deadline cap. |
| 3 | P3 | `electron/src/main/indexing/refresh-coordinator.ts` (~193) | A flush that fails (transient embedder/network/SQLITE error) drops its batch permanently until an unrelated mutation. Fix: bounded retry or fallback-to-dirty. |
| 4 | P3 | `electron/src/main/indexing/refresh-coordinator.ts` (~129) | No timeout around `runFlush`; the AST worker path has no idle watchdog (RAG does). A wedged run keeps `flushing=true` and stalls that project's pipeline until restart. |
| 5 | P3 | `electron/src/main/index.ts` (~429) | Shutdown disposes synchronously: in-flight flushes are neither awaited nor cancelled, and post-dispose enqueues can re-arm timers mid-teardown. Recoverable (consistency gate forces rebuild; WAL intact) but costs a re-embed. |
| 6 | P3 | `electron/src/main/indexing/watcher.ts` (~74) | Toggling `index_refresh.watch` at runtime has no effect on existing instances until the next bind cycle. |
| 7 | P3 | `electron/src/main/indexing/mutation-paths.ts` (~43) | `rel.startsWith('..')` drops in-workspace files literally named `..foo` at the workspace root (matches a pre-existing repo idiom). |
| 8 | P3 | `AGENTS.md` | Not updated for the new `electron/src/main/indexing/` module family, the `index_refresh` config section, or the shutdown disposal calls. |
| 9 | P3 | `electron/src/main/indexing/refresh-coordinator.ts` (~146) | Dead `!dirty` term in the flush gate (both branches self-gate on their own flags). |
| 10 | P3 | agent-native | No agent/user-visible refresh outcome: `rag_index`/`ast_index` status carries no last-refresh result or in-progress state (users get `rag:index_state`; agents get static counts). Suggested: `last_refresh {at, outcome}` in store status. |
| 11 | P3 | agent-native | No index-freshness context: the system prompt and `rag_search` description don't mention the ~2s debounce, so an edit→search loop can read a stale index with no signal. |
| 12 | P3 | `electron/src/main/ipc/session.ts` | `session:delete` of the active session changes the window's effective workspace without retargeting the watcher; the sticky-default workspace also has no watcher until a bind/activation. |
| 13 | P3 | `electron/src/main/indexing/watcher.ts` | Ignored-dirs config is captured at instance creation; mid-session `ignored_dirs` edits require a rebind. Watcher-error disable also requires rebind/restart to recover (by design; dirty-flag remains the floor). |
| 14 | P3 | `electron/src/main/rag/indexer.ts` | Read-only commands (`ls`, `git status`) still arm a debounced full hash-diff scan. Cost is now bounded (lazy embedder, no-op scans skip the npy rewrite) but repeated command-heavy turns re-walk large repos. Command risk classification could gate this. |

Testing residuals (from the testing reviewer, not blocking):
- Session-IPC → watcher lifecycle coverage exists but no multi-window refcount edge tests.
- RAG compiled-worker end-to-end (production path) untested under vitest — wire contract proven via echo-worker fixtures; same pre-existing situation as `indexProject`.
- Config-load-failure paths (coordinator drop-batch, watcher fail-safe) untested.
- Project-config-view `index_refresh` save/merge plumbing untested at the renderer contract level.
