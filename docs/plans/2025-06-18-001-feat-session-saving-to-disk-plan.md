# feat: Session Saving to Disk

## Problem Frame

Sessions are entirely in-memory. Every app restart creates a fresh session and discards all conversation history, subagent work, and todo state. This plan implements persistent session storage so conversations survive restarts and can be resumed across days.

**Origin:** `docs/brainstorms/session-saving.md`

## Scope

**In scope (v1):**
- Serialization for `Session`, `Chain`, `SubagentRecord`, `TodoStore`
- Auto-save after every message exchange (background, non-blocking)
- Auto-naming after first exchange (background LLM call, `tolo` tier)
- `/sessions` command — list, load, delete, rename

**Out of scope:**
- `/save` command — everything is auto-save only
- Cross-session search tool — each session is independent
- Keyword index
- Read-only session overlay for the user (R7 — deferred)
- Incremental/dirty-flag saves
- Session export/import
- Session file size limits
- Multiple session tabs or split-view

## Key Decisions

1. **Storage format:** One JSON file per session in `~/.stupidex/sessions/<uuid>.json`. Simple, inspectable, no external dependencies. Matches the existing `ConfigManager` save pattern (atomic write with tmp + rename).

2. **Serialization strategy:** Add `to_storage_dict()` / `from_storage_dict()` to `Message` — separate from the existing `to_dict()` which is API-only (strips `type`, `display`, `metadata`, `usage`). `Session`, `Chain`, `SubagentRecord`, `TodoStore` get `to_dict()` / `from_dict()` methods.

3. **Auto-naming model:** Uses `tolo` tier via `get_model_for_tier("tolo")`. Simple `litellm.acompletion()` call (no tools, no streaming). Silent — failures are logged but not shown to the user.

4. **Subagent persistence:** `SubagentRecord` serializes `id`, `agent` (via `Agent.to_dict()`), `state`, `label`, `task`, `result`, `error`, `start_time`, `end_time`, `messages`. Excludes non-serializable fields (`async_task`, callbacks, UI state). Stored as a separate `subagent_chains` dict on the session JSON. On load, completed subagents are restored; running ones become abandoned.

5. **Auto-save granularity:** Saves per exchange (chain), not per individual message. This means if the app crashes mid-stream, the in-progress assistant message is lost. This is acceptable for v1 — per-message saves would increase I/O significantly. Revisit if crash data loss becomes a real problem in practice.

## Implementation Units

### U1. Serialization Layer

**Goal:** Add `to_dict()` / `from_dict()` to all domain objects that need persistence.

**Requirements:** R1, R4

**Files:**
- `src/stupidex/domain/message.py` — add `to_storage_dict()`, `from_storage_dict()`
- `src/stupidex/domain/chain.py` — add `to_dict()`, `from_dict()`
- `src/stupidex/domain/session.py` — add `to_dict()`, `from_dict()`, add `created_at` / `updated_at` fields
- `src/stupidex/domain/todo.py` — add `TodoTask.from_dict()`, `TodoStore.to_dict()`, `TodoStore.from_dict()`
- `src/stupidex/agents/manager.py` — add `SubagentRecord.to_dict()`, `SubagentManager.to_dict()`, `SubagentManager.from_dict()`
- `tests/test_session_serialization.py` — round-trip tests

**Approach:**

`Message.to_storage_dict()` serializes all fields: `role` (as `.value`), `content`, `type` (as `.value`), `display`, `metadata`, `usage` (as dict), `tool_call_id`, `tool_calls`. `Message.from_storage_dict()` reconstructs using enum `.value` mapping.

`Chain.to_dict()` serializes: `model`, `messages` (via `Message.to_storage_dict()`), `start_time`, `end_time`, `status` (as `.value`). `Chain.from_dict()` reconstructs.

`Session.to_dict()` serializes: `id`, `name`, `model`, `created_at`, `updated_at`, `chains`, `subagent_chains` (from `subagent_manager.to_dict()`), `todo_store` (from `todo_store.to_dict()`). `Session.from_dict()` reconstructs, creating a fresh `SubagentManager` for running subagents.

Add `created_at: float` and `updated_at: float` fields to `Session`. Initialize `created_at` on creation, update `updated_at` on each save.

`SubagentRecord.to_dict()` serializes the fields listed in Key Decision 4. `SubagentRecord.from_dict()` reconstructs, setting `async_task=None`, callbacks to `None`.

`SubagentManager.to_dict()` returns a dict of `{subagent_id: record.to_dict()}` for all completed/interrupted/failed records (skips running ones). `SubagentManager.from_dict()` rebuilds completed records.

**Patterns to follow:**
- `Agent.to_dict()` / `Agent.from_dict()` in `src/stupidex/domain/agent.py` — same pattern
- `TodoTask.to_dict()` in `src/stupidex/domain/todo.py` — same pattern

**Test scenarios:**
- Round-trip `Message` through `to_storage_dict()` / `from_storage_dict()` — all field combinations (text, thinking, tool_call, tool_result, error, with/without usage, with/without metadata)
- Round-trip `Chain` — with messages, different statuses, with/without end_time
- Round-trip `Session` — with chains, subagents, todo tasks
- Round-trip `SubagentRecord` — completed, failed, interrupted states
- Round-trip `TodoStore` — with tasks in various statuses
- Edge case: empty session (no chains, no subagents, no tasks)
- Edge case: message with `None` optional fields

**Verification:** All round-trip tests pass. No existing tests break (existing `Message.to_dict()` unchanged).

---

### U2. Session Storage Engine

**Goal:** File I/O operations for reading, writing, listing, and deleting session JSON files.

**Requirements:** R1

**Dependencies:** U1

**Files:**
- `src/stupidex/storage.py` — new file, `SessionStorage` class
- `tests/test_session_storage.py` — file I/O tests with temp directories

**Approach:**

`SessionStorage` class with class methods (singleton pattern like `ConfigManager`):

- `save(session: Session)` — serialize via `session.to_dict()`, atomic write to `~/.stupidex/sessions/<session.id>.json` (tmp file + `os.replace()`, same pattern as `ConfigManager.save()`)
- `load(session_id: str) -> Session` — read JSON, deserialize via `Session.from_dict()`
- `list_all() -> list[SessionSummary]` — scan directory, return lightweight summaries (id, name, updated_at, message_count) without loading full sessions
- `delete(session_id: str) -> bool` — remove JSON file
- `rename(session_id: str, new_name: str) -> bool` — load, update name, save
- `ensure_sessions_dir()` — create `~/.stupidex/sessions/` if missing

`SessionSummary` is a lightweight dataclass: `id`, `name`, `updated_at`, `message_count`. Used by `list_all()` to avoid loading full sessions into memory.

Atomic write pattern (from `ConfigManager.save()`):
```text
write to tmp file → flush → fsync → os.replace to final path → fsync dir
```

**Patterns to follow:**
- `ConfigManager.save()` in `src/stupidex/config.py:258-280` — atomic write pattern
- `HOME_CONFIG_DIR` in `src/stupidex/config.py:12` — path constant pattern

Add `HOME_SESSIONS_DIR = HOME_CONFIG_DIR / "sessions"` to `config.py`.

**Test scenarios:**
- Save and load a session — verify round-trip
- `list_all()` with multiple sessions — verify summaries
- `list_all()` with empty directory — returns empty list
- `delete()` — verify file removed, returns True
- `delete()` nonexistent — returns False
- `rename()` — verify name updated in file
- Corrupt JSON file — `load()` raises a clear error or returns None
- Missing sessions directory — `ensure_sessions_dir()` creates it
- Concurrent saves (same session) — no corruption (atomic write)

**Verification:** All file I/O tests pass with temp directories.

---

### U3. SessionManager Integration

**Goal:** Wire storage operations into `SessionManager` so it can save/load sessions from disk.

**Requirements:** R1, R4

**Dependencies:** U2

**Files:**
- `src/stupidex/domain/session.py` — add `save_session()`, `load_session()` to `SessionManager`

**Approach:**

Add to `SessionManager`:
- `save_session(session: Session | None = None)` — calls `SessionStorage.save()`. Defaults to `self.active`. Updates `session.updated_at`.
- `load_session(session_id: str) -> Session | None` — calls `SessionStorage.load()`. Adds to `self.sessions` dict. Returns the loaded session (does NOT switch to it — caller decides).
- `delete_saved(session_id: str) -> bool` — calls `SessionStorage.delete()`. Also removes from `self.sessions` if present.

The `load_session()` method reconstructs the full session object including `SubagentManager` and `TodoStore`. The `SubagentManagerContextVar` needs to be updated when switching sessions.

**Test scenarios:**
- `save_session()` persists to disk
- `load_session()` returns a valid Session object
- `load_session()` with nonexistent ID returns None
- `delete_saved()` removes file and in-memory entry
- Save → load → verify all fields match

**Verification:** Integration tests pass.

---

### U4. Auto-Save on Message Exchange

**Goal:** After every message exchange (chain completion), save the current session to disk in the background without blocking the UI.

**Requirements:** R2

**Dependencies:** U3

**Files:**
- `src/stupidex/app.py` — add auto-save call after `streaming_finished()`

**Approach:**

In `Stupidex.streaming_finished()` (line 393), after the chain is frozen and footer is rerendered, fire a background save:

```python
async def streaming_finished(self) -> None:
    # ... existing code ...
    # Auto-save (fire-and-forget)
    if self.sessions.active:
        asyncio.create_task(self._auto_save())

async def _auto_save(self) -> None:
    try:
        self.sessions.save_session()
    except Exception:
        log.exception("Auto-save failed")
```

Use an `asyncio.Lock` on `_auto_save` to prevent concurrent file writes. If a save is already in progress, skip (the next exchange will save anyway).

Also add auto-save in:
- `/new` command — save current before creating new
- `/switch` command — save current before switching
- `/delete` command — save current before deleting

**Test scenarios:**
- After a message exchange, the session file exists on disk
- Auto-save does not block the UI (fire-and-forget)
- Concurrent auto-saves don't corrupt the file
- Auto-save failure is logged but not shown to the user

**Verification:** Manual test — send a message, verify `~/.stupidex/sessions/<uuid>.json` exists.

---

### U5. Auto-Naming

**Goal:** After the first complete exchange, silently generate a short session name using the `tolo` tier model.

**Requirements:** R3

**Dependencies:** U3

**Files:**
- `src/stupidex/domain/session.py` — add `auto_name()` method or separate service
- `src/stupidex/app.py` — trigger auto-naming after first exchange

**Approach:**

After the first message exchange (when `session.name` still starts with "Session " — the default format from `SessionManager.create()`), fire a background LLM call:

```python
async def _auto_name_session(self) -> None:
    session = self.sessions.active
    if not session or not session.name.startswith("Session "):
        return  # Already named or no session

    messages = session.messages
    if len(messages) < 2:
        return  # Need at least one exchange

    try:
        from stupidex.config import get_model_for_tier, get_config
        import litellm

        cfg = get_config()
        model = get_model_for_tier("tolo")

        # Build a simple prompt with the first exchange
        context = []
        for msg in messages[:4]:  # First 2 exchanges max
            context.append(f"{msg.role.value}: {msg.content[:200]}")

        prompt = "Generate a short session title (3-6 words) based on this conversation. Return ONLY the title, nothing else.\n\n" + "\n".join(context)

        response = await litellm.acompletion(
            model=cfg.provider_api_type + "/" + model,
            messages=[{"role": "user", "content": prompt}],
            base_url=cfg.base_url,
            stream=False,
        )

        name = response.choices[0].message.content.strip().strip('"').strip("'")
        if name and len(name) < 60:
            session.name = name
            # Update title in UI
            try:
                from textual.widgets import Static
                self.query_one("#title", Static).update(session.name)
            except Exception:
                pass
            # Save with new name
            self.sessions.save_session()
    except Exception:
        log.exception("Auto-naming failed")
```

Call `_auto_name_session()` at the end of `streaming_finished()`, after auto-save. The check `session.name.startswith("Session ")` ensures it only fires once (when the default name is still set).

**Test scenarios:**
- First exchange → name changes from "Session 2025-06-15 ..." to a short phrase
- Subsequent exchanges → name does not change
- LLM failure → name stays as default, no error shown to user
- Empty response → name stays as default
- Very long response → truncated or ignored (len < 60 check)

**Verification:** Manual test — send a first message, wait for the title to update in the header.

---

### U6. `/sessions` Command

**Goal:** A `/sessions` command that shows saved sessions and allows loading, deleting, and renaming.

**Requirements:** R5

**Dependencies:** U3

**Files:**
- `src/stupidex/commands/session_commands.py` — add `/sessions`, `/sessions delete`, `/sessions rename` commands
- `src/stupidex/screens/session_picker.py` — new file, `SessionPicker` screen
- `src/stupidex/app.py` — add `load_session()` method for UI refresh after load

**Approach:**

**SessionPicker screen** — extends the `OptionPicker` pattern from `src/stupidex/screens/picker.py`. Shows session name, date, and message count in each option label. Supports a `mode` parameter: `"load"` (default), `"delete"`.

For load mode:
- Select → dismiss with session ID
- The caller saves current session, loads the selected one, calls `rerender_all()`

For delete mode:
- Select → dismiss with session ID
- The caller deletes the session from disk

**Commands:**

`/sessions` — shows `SessionPicker` in load mode. On selection:
1. Save current session
2. Load selected session from disk
3. Set as active, update todo store, update subagent manager
4. Call `rerender_all()`

`/sessions delete` — shows `SessionPicker` in delete mode. On selection:
1. Delete session from disk
2. If it was the active session, create a new one

`/sessions rename` — prompts for new name via `Input` screen or inline argument. Updates `session.name`, saves.

**Patterns to follow:**
- `/model` command in `session_commands.py:55-67` — picker pattern
- `/switch` command in `session_commands.py:31-41` — session switching pattern
- `OptionPicker` in `src/stupidex/screens/picker.py` — screen structure

**Test scenarios:**
- `/sessions` with no saved sessions — shows empty picker or "No saved sessions" notification
- `/sessions` → select → session loaded, UI refreshed
- `/sessions` → select → current session saved first
- `/sessions delete` → select → session removed from disk
- `/sessions rename` → enter new name → session name updated
- Session picker search — filter by name works

**Verification:** Manual test — save a session, restart app, `/sessions`, load it.

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Large sessions slow down auto-save | Medium | v1 accepts full-save. Future: incremental/dirty-flag saves (logged as known concern in brainstorm) |
| Auto-save per exchange loses mid-stream crash data | Low | Acceptable for v1. Per-message saves would increase I/O significantly. Revisit if crash data loss is a real problem |
| Auto-naming generates bad names | Low | Silent failure, name stays as default. User can rename via `/sessions rename` |
| `Message.to_storage_dict()` diverges from `to_dict()` | Low | Clear naming distinction. Tests enforce round-trip correctness |
| Concurrent auto-saves corrupt file | Low | Atomic write pattern (tmp + rename) prevents partial reads. `asyncio.Lock` prevents concurrent writes |

## Deferred Items

- **Session file size limits** — logged in brainstorm as known future concern
- **Read-only session overlay** (R7) — out of scope for v1
- **Incremental saves** — future optimization when sessions grow large
- **Session export/import** — JSON format makes it trivial later
- **`/save` command** — removed in favor of auto-save only
- **Cross-session search** — removed; each session is independent, cross-session patterns belong to the `compound` workflow

## Dependency Graph

```mermaid
U1 (Serialization) ──→ U2 (Storage Engine) ──→ U3 (SessionManager Integration)
                                                    ├──→ U4 (Auto-Save)
                                                    ├──→ U5 (Auto-Naming)
                                                    └──→ U6 (/sessions Command)
```

**Recommended execution order:** U1 → U2 → U3 → U4 + U5 + U6 (parallel)
