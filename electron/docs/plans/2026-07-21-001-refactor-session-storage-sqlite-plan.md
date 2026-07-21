---
title: "refactor: Migrate session storage from JSON files to SQLite"
type: refactor
status: active
date: 2026-07-21
---

# refactor: Migrate session storage from JSON files to SQLite

## Summary

Replace the per-session JSON file storage (`~/.orchid/sessions/<uuid>.json`) with a single SQLite database (`~/.orchid/sessions.db`), eliminating the partial-read regex heuristics, O(n) full-file rewrites per turn, and N-file-scan listing. The public storage API (`saveSession`, `loadSession`, `listSavedSessions`, `deleteSession`) retains its current signatures so `SessionManager` and IPC handlers remain unchanged. No migration from existing JSON sessions is needed.

---

## Problem Frame

Session storage is the only high-write-frequency store still on JSON files. Every turn rewrites the entire session document (all chains, all messages) atomically — O(n) in conversation length. Listing sessions requires opening every file, reading 2048-byte heads, and running regex extraction (`extractJsonString`, `extractChainCount`) with full-parse fallbacks. These heuristics are fragile (they break on reordered keys or nested braces) and cannot support queries like search, filter, or pagination. The codebase already uses better-sqlite3 with WAL for RAG, AST, and accounting — sessions are the outlier.

---

## Requirements

- R1. Session CRUD (create, load, save, delete, list) backed by SQLite with WAL mode
- R2. `listSavedSessions` returns the same `SessionSummary[]` shape via a single indexed query (no file scanning)
- R3. Per-turn writes persist only the affected chain's messages, not the entire session document
- R4. Public API signatures unchanged — `SessionManager`, IPC handlers, and renderer require no modifications
- R5. `StorageOptions` test override mechanism preserved (tests use temp DB paths)
- R6. Tool-output and web-fetch cache directories remain file-based (unchanged)
- R7. Corruption recovery: auto-rebuild schema on malformed DB (matching RAG/AST pattern)

---

## Scope Boundaries

- No migration from existing JSON session files (clean break)
- No changes to `SessionManager` logic, IPC handlers, or renderer
- No changes to tool-output/web-fetch cache (file-based, keyed by session ID)
- No message-level querying or search (future work)
- No changes to config, provider connections, or credentials stores

### Deferred to Follow-Up Work

- Migrate RAG, AST, and accounting stores to the shared SQLite utility extracted in U1: separate PR, low risk, purely mechanical

---

## Context & Research

### Relevant Code and Patterns

- `src/main/session/storage.ts` — current JSON storage (to be rewritten)
- `src/main/session/manager.ts` — SessionManager (unchanged, calls storage functions)
- `src/main/providers/accounting/store.ts` — SQLite pattern: better-sqlite3, WAL, schema versioning, `HOME_CONFIG_DIR`
- `src/main/providers/accounting/schema.ts` — schema-as-constant pattern
- `src/main/rag/store.ts` — corruption recovery pattern (rebuild on malformed DB)
- `src/main/ast/store.ts` — lazy connection caching, `dispose()` lifecycle
- `src/shared/types/session.ts` — `Session`, `SessionStorageDict`, serialization functions
- `src/shared/types/chain.ts` — `Chain`, `ChainStorageDict`, serialization functions
- `tests/unit/session-persistence.test.ts` — existing test patterns (temp dirs, `StorageOptions`)

### Institutional Learnings

- better-sqlite3 requires `npm run rebuild:native` for Electron ABI compatibility (documented in RAG store error handling)
- WAL mode + `busy_timeout = 5000` is the established pragma pattern
- Schema versioning via `schema_meta` table (accounting pattern)

---

## Key Technical Decisions

- **Messages stored as JSON blob per chain, not normalized rows**: The access pattern is always "all messages for a chain" (replace on update, flatMap on read). Normalizing into a messages table adds join complexity with no query benefit. The JSON blob is serialized via the existing `messageToStorageDict`/`messageFromStorageDict` functions.
- **Two tables (sessions + chains), not one**: Chains are updated independently per turn (`updateActiveChainMessages` replaces one chain's messages). A single-table design would still rewrite the full row. Two tables allow targeted chain updates while session metadata updates remain cheap.
- **SubagentChains and TodoStore as JSON columns on sessions**: Both are always loaded/saved as a unit (`syncSubagentChains` does full replacement, `persistTodos` snapshots the store). No per-item querying exists.
- **DB path in StorageOptions**: `dbPath` replaces `sessionsDir` as the override field. Cache directory overrides remain unchanged.
- **No lazy connection pooling**: A single cached connection per process (matching AST store pattern) is sufficient — all access is main-process, single-threaded.

---

## Open Questions

### Resolved During Planning

- **Where does the DB live?** `~/.orchid/sessions.db` — alongside `accounting.db`, `providers.json`, `credentials.json`. Global, not per-project.
- **What happens to `isValidSessionId`?** Retained as a defense-in-depth check before DB writes (prevents garbage IDs from entering the store).
- **Does `deleteSession` still clean caches?** Yes — the file-based tool-output and web-fetch caches are keyed by session ID and must still be removed.

### Deferred to Implementation

- Exact index choices beyond the obvious (session ID primary key, chain session_id FK, updated_at for listing) — tune after seeing query plans
- Whether `PRAGMA synchronous = NORMAL` is acceptable or should remain `FULL` — benchmark write latency

---

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```
sessions table
├── id TEXT PRIMARY KEY
├── name TEXT NOT NULL
├── selection_json TEXT          -- ModelSelection | null
├── model_label TEXT
├── cwd TEXT
├── active_chain_id TEXT
├── subagent_chains_json TEXT    -- SubagentRecord[]
├── todo_store_json TEXT         -- TodoStoreData
├── created_at TEXT NOT NULL
└── updated_at TEXT NOT NULL

chains table
├── id TEXT PRIMARY KEY
├── session_id TEXT NOT NULL → sessions(id) ON DELETE CASCADE
├── ordinal INTEGER NOT NULL     -- insertion order within session
├── status TEXT NOT NULL
├── selection_json TEXT
├── model_label TEXT
├── agent_name TEXT
├── agent_type TEXT
├── agent_tier TEXT
├── subagent_record_json TEXT
├── messages_json TEXT NOT NULL  -- Message[] serialized
├── start_time TEXT
└── end_time TEXT

Indexes:
├── idx_chains_session ON chains(session_id, ordinal)
└── idx_sessions_updated ON sessions(updated_at DESC)
```

Write paths:
- `saveSession` → UPSERT sessions row + replace all chains (transaction)
- `updateActiveChainMessages` (via SessionManager) → UPDATE single chain's `messages_json`
- `listSavedSessions` → SELECT id, name, model_label, cwd, updated_at + COUNT chains, ordered by updated_at DESC

---

## Implementation Units

- U1. **Extract shared SQLite utility**

**Goal:** Consolidate the duplicated database-open/pragma/corruption-recovery logic (currently in RAG, AST, and accounting stores) into a single reusable module.

**Requirements:** R1, R7

**Dependencies:** None

**Files:**
- Create: `src/main/utils/sqlite.ts`
- Test: `tests/unit/sqlite-util.test.ts`

**Approach:**
- Export `openSqliteDb(dbPath: string, opts?: { schema?: string; corruptionCheck?: string })` that:
  - Uses dynamic `require('better-sqlite3')` (RAG pattern) for ABI-mismatch detection with actionable error message
  - Sets `journal_mode = WAL` and `busy_timeout = 5000`
  - Optionally runs a schema SQL string
  - Optionally runs a corruption-check query (e.g., `SELECT 1 FROM <table> LIMIT 1`)
  - On corruption (regex match on error message: `malformed|not a database|disk image|header mismatch|is encrypted`), deletes the file and rebuilds
- Export `type SqliteDatabase = import('better-sqlite3').Database` for consumers
- Export the corruption regex as `SQLITE_CORRUPTION_RE` for stores that do their own recovery
- RAG/AST/accounting are NOT migrated in this PR (deferred) — the session store is the first consumer

**Patterns to follow:**
- `src/main/rag/store.ts` `openDatabase()` (most complete: dynamic require, ABI message, WAL)
- `src/main/ast/store.ts` `isCorruptionError()` (corruption regex)

**Test scenarios:**
- Happy path: opens a fresh DB, sets WAL mode, returns usable connection
- Happy path: runs provided schema SQL on open
- Edge case: creates parent directories if missing
- Error path: ABI mismatch produces actionable error mentioning `npm run rebuild:native`
- Error path: corrupted DB file triggers delete + rebuild when schema is provided
- Error path: corrupted DB without schema throws (caller handles)

**Verification:**
- `openSqliteDb` produces a WAL-mode database with schema applied
- Corruption recovery works without manual intervention
- Error messages match the quality of the existing RAG store messages

---

- U2. **Session schema and database initialization**

**Goal:** Define the session schema and provide a thin session-specific DB wrapper using the shared utility.

**Requirements:** R1, R7

**Dependencies:** U1

**Files:**
- Create: `src/main/session/schema.ts`
- Create: `src/main/session/db.ts`
- Test: `tests/unit/session-db.test.ts`

**Approach:**
- `schema.ts`: Export `SESSION_SCHEMA_VERSION` and `SESSION_SCHEMA_SQL` constants (following `accounting/schema.ts` pattern)
- `db.ts`: Export `openSessionDb(dbPath)` — a thin wrapper calling `openSqliteDb(dbPath, { schema: SESSION_SCHEMA_SQL, corruptionCheck: 'SELECT 1 FROM sessions LIMIT 1' })`. Export a `SessionDb` class wrapping the connection with `dispose()`.

**Patterns to follow:**
- `src/main/providers/accounting/schema.ts` (schema constant)
- `src/main/ast/store.ts` (lazy connection, dispose)

**Test scenarios:**
- Happy path: opening a fresh DB creates both tables and schema_meta row
- Happy path: opening an existing DB reuses it without re-creating tables
- Error path: corrupted DB file triggers rebuild via shared utility
- Integration: dispose() closes the connection; subsequent operations throw or re-open

**Verification:**
- `openSessionDb` produces a valid database with expected tables
- Corruption recovery delegates to shared utility

---

- U3. **Storage layer rewrite — save and load**

**Goal:** Implement `saveSession` and `loadSession` backed by SQLite, preserving the existing function signatures and `StorageOptions` override mechanism.

**Requirements:** R1, R3, R4, R5

**Dependencies:** U2

**Files:**
- Modify: `src/main/session/storage.ts`
- Test: `tests/unit/session-persistence.test.ts` (update existing)

**Approach:**
- Replace `StorageOptions.sessionsDir` with `StorageOptions.dbPath` (default: `~/.orchid/sessions.db`). Retain `toolOutputCacheDir` and `webFetchCacheDir` for cache cleanup.
- `saveSession`: UPSERT into sessions table (serialize selection, subagentChains, todoStore as JSON columns). DELETE existing chains for session_id, INSERT all chains with ordinal index. Wrap in a transaction.
- `loadSession`: SELECT session row + all chains ordered by ordinal. Deserialize via existing `messageFromStorageDict`, `chainFromStorageDict`-compatible logic. Return `null` on not-found.
- Retain `isValidSessionId` guard before writes.
- Retain `ensureSessionsDir` renamed to `ensureSessionDb` (creates parent dir, opens DB).
- The `Session` ↔ row mapping replaces `sessionToStorageDict`/`sessionFromStorageDict` for the persistence path, but those shared functions remain for any other consumers (IPC boundary types).

**Patterns to follow:**
- `src/main/providers/accounting/store.ts` (prepared statements, transactions)
- Existing `sessionToStorageDict`/`sessionFromStorageDict` serialization logic for field mapping

**Test scenarios:**
- Happy path: save a session with 2 chains × 3 messages, load it back, verify deep equality
- Happy path: save overwrites existing session (save twice with different name, load returns latest)
- Edge case: session with empty chains array round-trips correctly
- Edge case: session with null selection, null cwd, null modelLabel round-trips
- Edge case: session with subagentChains and todoStore round-trips
- Error path: load with non-existent UUID returns null
- Error path: load with invalid session ID (path traversal chars) returns null
- Integration: save is transactional — simulate failure mid-write (e.g., constraint violation on second chain), verify session row is not partially written

**Verification:**
- All existing `session-persistence.test.ts` save/load tests pass with the new backend
- No JSON files are created

---

- U4. **Storage layer rewrite — list and delete**

**Goal:** Implement `listSavedSessions` as a single indexed query and `deleteSession` with cascade + cache cleanup.

**Requirements:** R2, R4, R5, R6

**Dependencies:** U3

**Files:**
- Modify: `src/main/session/storage.ts`
- Test: `tests/unit/session-persistence.test.ts` (update existing)

**Approach:**
- `listSavedSessions`: `SELECT s.id, s.name, s.model_label, s.cwd, s.updated_at, COUNT(c.id) as chain_count FROM sessions s LEFT JOIN chains c ON c.session_id = s.id GROUP BY s.id ORDER BY s.updated_at DESC`. Map to `SessionSummary[]`. No file I/O.
- `deleteSession`: `DELETE FROM sessions WHERE id = ?` (CASCADE removes chains). Then remove tool-output and web-fetch cache directories (existing logic, unchanged). Return `true` if the session row existed.
- Remove all partial-read helpers: `extractJsonString`, `extractJsonNumber`, `extractJsonNullableString`, `extractChainCount`, `cwdFromParsed`, `modelLabelFromParsed`, `isLegacySessionVersion`.

**Patterns to follow:**
- `src/main/ast/store.ts` `deleteByFile` (delete + cleanup)
- Existing `deleteSession` cache cleanup logic (retain as-is)

**Test scenarios:**
- Happy path: 3 sessions with different updated_at → list returns newest first
- Happy path: list returns correct chainCount per session
- Edge case: list with zero sessions returns empty array
- Edge case: session with 0 chains shows chainCount 0
- Happy path: delete removes session and its chains from DB
- Happy path: delete removes tool-output and web-fetch cache directories
- Edge case: delete non-existent session returns false
- Error path: delete with invalid session ID returns false

**Verification:**
- Listing 100+ sessions is a single query (no N+1 file reads)
- All existing list/delete tests pass

---

- U5. **SessionManager compatibility and dead-code removal**

**Goal:** Verify SessionManager works unchanged against the new storage, remove all dead JSON-file code, and update module documentation.

**Requirements:** R4, R5

**Dependencies:** U4

**Files:**
- Modify: `src/main/session/storage.ts` (remove dead exports, update docstring)
- Modify: `src/main/session/manager.ts` (update imports if any removed exports were used)
- Modify: `src/shared/types/session.ts` (no change expected, verify)
- Test: `tests/unit/session-persistence.test.ts` (full suite green)
- Test: `tests/unit/session-auto-name.test.ts` (verify green)
- Test: `tests/parity/sessions.test.ts` (update if it references removed functions)

**Approach:**
- Remove: `SESSIONS_DIR` constant (replaced by `SESSION_DB_PATH`), all `extractJson*` helpers, `ensureSessionsDir` (replaced by `ensureSessionDb`)
- Verify `SessionManager` calls only `saveSession`, `loadSession`, `deleteSession`, `listSavedSessions` — no direct file I/O
- Update the module docstring in `storage.ts` to describe the SQLite backend
- Run full test suite to confirm no regressions

**Patterns to follow:**
- Existing module docstring style

**Test scenarios:**
- Integration: SessionManager.create → switchTo → startChain → updateActiveChainMessages → finishActiveChain → load from fresh manager instance → verify full round-trip
- Integration: SessionManager.listSaved returns correct summaries after multiple creates
- Integration: SessionManager.delete clears in-memory cache and DB row

**Verification:**
- `npm run test` passes (all session-related tests green)
- `npm run typecheck` passes
- `npm run lint` passes
- No references to `sessionsDir`, `extractJsonString`, or `.json` session files remain in `src/main/session/`

---

## System-Wide Impact

- **Interaction graph:** `SessionManager` → storage functions (unchanged interface). IPC handlers (`session.ts`, `chat.ts`, `chat-history.ts`) call SessionManager, not storage directly. Renderer unaffected.
- **Error propagation:** DB open failure throws with actionable message (matching RAG store ABI-mismatch pattern). Query failures propagate as thrown errors to IPC handlers (existing error boundary).
- **State lifecycle risks:** The in-memory `SessionManager._sessions` cache remains authoritative for loaded sessions. DB is the persistence layer. No dual-write concern — storage functions are the sole write path.
- **API surface parity:** `StorageOptions` changes (`sessionsDir` → `dbPath`). Only test code and `SessionManager` constructor reference this. IPC and renderer never see it.
- **Integration coverage:** The full agent loop (chat:send → startChain → stream → persistTurn → finishActiveChain) exercises the write path end-to-end. Existing integration tests cover this.
- **Unchanged invariants:** Tool-output offloading still writes to `~/.orchid/cache/tool-output/<session_id>/`. Session ID validation (`isValidSessionId`) remains. `Session` and `Chain` shared types unchanged. `sessionToStorageDict`/`sessionFromStorageDict` remain available for any non-persistence consumers.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| better-sqlite3 ABI mismatch on fresh install | Reuse RAG store's error message pattern directing users to `npm run rebuild:native` |
| Large message JSON blobs (long conversations) | SQLite handles multi-MB TEXT columns well; WAL mode keeps reads non-blocking |
| Concurrent access (multiple windows) | Single main process owns the DB; WAL allows concurrent reads if needed later |
| Test suite breakage from StorageOptions change | U2 updates tests in lockstep; `dbPath` override replaces `sessionsDir` |

---

## Sources & References

- Related code: `src/main/session/storage.ts`, `src/main/session/manager.ts`
- Related code: `src/main/providers/accounting/store.ts`, `src/main/providers/accounting/schema.ts`
- Related code: `src/main/rag/store.ts`, `src/main/ast/store.ts`
- Related tests: `tests/unit/session-persistence.test.ts`, `tests/parity/sessions.test.ts`
