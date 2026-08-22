# Residual Review Findings — feat/index-auto-refresh

Source: code review run `20260822-184948-97ac2961` (11 reviewers, artifacts under `/tmp/code-review/20260822-184948-97ac2961/`).
All P1/P2 findings were fixed on-branch. A follow-up hardening pass fixed residuals 1-9, 12, 13, all minor concerns, and all testing residuals. What remains is listed below.

## Remaining residuals

| # | Severity | Location | Finding |
|---|----------|----------|---------|
| 10 | P3 | agent-native | No agent/user-visible refresh outcome: `rag_index`/`ast_index` status carries no last-refresh result or in-progress state. Suggested: `last_refresh {at, outcome, errors}` in store status, plus `isIndexing`/phase (already computed by `getIndexState`) in tool status payloads. |
| 11 | P3 | agent-native | No index-freshness context: the system prompt and `rag_search` description don't mention the ~2s debounce, so an edit→search loop can read a stale index with no signal. |
| 14 | P3 | `electron/src/main/llm/tool-dispatch.ts` | Read-only commands (`ls`, `git status`) still arm a debounced full hash-diff scan. Cost is bounded (lazy embedder, no-op scans skip the npy rewrite) but repeated command-heavy turns re-walk large repos. Command risk classification could gate this. |
| — | P3 | `electron/src/main/rag/indexer.ts` | `rag_index` vs auto-refresh conflict is opaque: the single-flight sentinel surfaces as `errors: 1` with no message in the manual tool outcome; AST joins the in-flight run instead. Divergent semantics for the same user action. |
| — | P3 | `electron/src/main/ipc/session.ts` | Per-window watcher references are never released when a window closes (only shutdown clears them). With the startup attach via `session:get_workspace`, a macOS `activate` window re-creation takes a fresh sticky-default reference nothing detaches. Single-window Win/Linux flows unaffected. |
| — | P4 | `electron/src/main/ipc/session.ts` | `session:get_workspace` is a read IPC that now carries an idempotent watcher-attach side effect (documented at the handler). A purer seam (explicit window-ready IPC) would drop in via the recorded-reference map. |

## Known trade-offs (accepted, documented in code/tests)

- A flush branch that times out (600s internal cap) is abandoned without a dirty-retry — retrying a wedged run risks a second long hang.
- The watcher's 5s event-time config cache means an out-of-band `~/.orchid/config.json` edit can leak events for up to 5s on a live instance (config saves close/recreate immediately).
- The env-gated RAG compiled-worker smoke test (`tests/unit/rag-worker-smoke.test.ts`) fails rather than skips against a STALE `dist/` build — intentional drift detection; run `npm run build:main` to enable it.
- AST watchdog windows in tests are 1s/2s (not ms) to avoid racing worker boot under parallel-suite load.

## Fixed in the follow-up pass

1. chokidar import-failure caching (retry on later attach)
2. debounce starvation (max-wait = max(3x debounce, 10s) from first pending)
3. flush-failure batch loss (bounded once-per-batch dirty-retry self-heal)
4. flush/worker watchdogs (600s branch cap; AST worker idle watchdog at RAG parity)
5. shutdown disposal (awaited `disposeIndexRefreshCoordinatorAsync` + disposed latch; watchers close first)
6. runtime `index_refresh.watch` toggle (reconfigure on config save, both user + project)
9. dead `!dirty` term in the flush gate
12. `session:delete` active-session retarget + startup sticky-default attach (`session:get_workspace` reconcile)
13. `ignored_dirs` re-captured on instance recreation; watcher state (`watcher.watching`) surfaced via `rag:status`
- minor: per-event config cost (5s TTL cache), per-index sentinel requeue (AST entries no longer reprocessed), trust-grant-while-watch-false (recreate path), `rag:clear` drains the coordinator
- testing: multi-window refcount edges, RAG compiled-worker e2e (env-gated), config-load-failure paths, renderer contract coverage (project-config-view + config-form-contracts), watcher sleep flakiness (poll-based waits), Windows matcher coverage, `..`-prefixed filename over-match (mutation-paths + watcher)
- docs: AGENTS.md updated (indexing/ tree, index_refresh config rows, auto-refresh feature section)
