# Session Saving to Disk

## Problem

Sessions are entirely in-memory. Every app restart creates a fresh session and discards everything. This causes:

- **Lost conversations** — on crash, timeout, or app exit, all context is gone.
- **No continuity** — users can't resume work across days or app launches.
- **No cross-session awareness** — the AI has no memory of prior conversations, and the user can't reference them either.

## Background — Current State

- `SessionManager` holds a `dict[str, Session]` and an active session reference.
- On `on_mount`, a fresh session is always created — no persistence.
- `Session` contains: `name`, `id`, `chains`, `model`, `todo_store`.
- `Chain` contains: `model`, `messages`, `start/end_times`, `status`.
- `Message` has `to_dict()` for serialization. `Session` and `Chain` do not.
- `TodoStore` has `to_dict()` — already serializable.
- The MCP tool `file_manipulation` has a `search_files` tool that searches file contents via regex — a similar pattern could be reused for cross-session search.

## Requirements

### R1 — Persistent Session Storage

Sessions are saved as individual JSON files in `~/.stupidex/sessions/`, named by session UUID.

Each file contains the full session state: name, id, model, created/updated timestamps, all chains with all messages, and the todo store.

On app startup, nothing changes — a fresh session is always created. Existing sessions are discoverable but not loaded unless the user asks.

### R2 — Auto-Save

After every message exchange (user message + assistant reply), the current session is saved to disk in the background. This must not block the UI or slow down the conversation flow.

Additionally, a `/save` command triggers an explicit save (same path, but synchronous with user feedback like "Session saved.").

### R3 — Auto-Naming

After the first complete exchange (user message + assistant reply), the session gets an auto-generated name. This happens silently — no user prompt, no interruption. The name is a short phrase (3-6 words) that summarizes the topic.

The naming call should be non-blocking (fire-and-forget or background task). It uses the **`tolo` tier model** (fastest/cheapest) regardless of the session's current model. The tier-to-model mapping already exists in `config.py:tier_models` and is resolved via `get_model_for_tier("tolo")`.

The user can rename the session at any time via a `/sessions rename <name>` command.

### R4 — Subagent Persistence

**Problem:** `SubagentRecord` (`agents/manager.py:74-107`) holds subagent messages in-memory but has no serialization. Non-serializable fields (`async_task`, `on_message`, `on_state_change` callbacks) must be excluded. The parent chain *does* capture the `delegate_to_subagent` tool call and `wait_for_subagent` result — so the "what was delegated / what came back" is already in the main chain — but the intermediate subagent conversation (tool calls, thinking, reasoning) is lost.

**Solution:** Add `to_dict()` / `from_dict()` to `SubagentRecord` and `SubagentManager`. Subagent messages are persisted as separate data in the session JSON, tagged with `subagent_id`. On session load, completed subagents are restored into `SubagentManager` so the AI can reference them. Active/running subagents are not restored — they become abandoned.

**Serialization rules for `SubagentRecord.to_dict()`:**
- Serialize: `id`, `name`, `type`, `state`, `messages` (via `Message.to_dict()`), `started_at`, `elapsed`, `error`
- Exclude: `async_task`, `on_message`, `on_state_change`, `progress`, `total`

**Storage:** Subagent chains are stored in a separate `subagent_chains: dict[str, list[dict]]` field on the session JSON (keyed by subagent ID), keeping them distinct from the main conversation chain.

**Restore behavior:** `SubagentManager.from_dict()` rebuilds completed subagent records. The `list_subagents` tool reflects loaded subagents from prior sessions so the AI can reference past subagent work.

### R5 — Session Browser (`/sessions`)

A `/sessions` command shows a list of saved sessions, similar in UX to the current `/model` command (scrollable list, key bindings, search/filter).

Each entry shows: **name**, **date** (last updated), **message count**.

From this view, the user can:
- **Load** a session (replaces the current active session, after saving the current one)
- **Delete** a session
- **Search** within sessions (filter the list by keyword)

### R6 — Cross-Session Reading for the AI

The AI agent gets a tool (e.g., `search_sessions`) that it can invoke to find relevant content in other saved sessions. This lets it answer questions like "what did we discuss about X?" or "what was that config change we made last week?"

The tool should optimize for relevance, not dump entire session histories. Possible approach:
1. Given a query/keyword, search message content across all sessions.
2. Return matching snippets with session name + context (surrounding messages).
3. Limit results to avoid overwhelming the context window.

**Indexing:** Build an in-memory keyword index on startup by scanning all session files once. This keeps queries fast (no file I/O per search) at the cost of slightly slower startup. The index maps keywords/phrases to `(session_id, message_index)` tuples. A simple tokenization + inverted index is sufficient for v1 — no need for embeddings or fuzzy matching.

### R7 — Cross-Session Reading for the User

From the `/sessions` browser, the user can open a saved session in read-only mode to browse its messages. This is a view-only overlay — it doesn't switch the active session. The user can close it and return to their current conversation.

## Design Considerations

### File Format

One JSON file per session:

```shell
~/.stupidex/sessions/
  <uuid-1>.json
  <uuid-2>.json
  <uuid-3>.json
```

Simple, inspectable, no external dependencies. Each file is self-contained and can be shared/backed up manually.

For the cross-session search tool, an in-memory index (built on startup by scanning all session files) would avoid reading every file on each query. This can be a simple keyword → (session_id, message_index) mapping, or we can lean on the existing regex search pattern from `file_manipulation`.

### Save Performance

Sessions start small but can grow large over long conversations. Two mitigations:

1. **Incremental save** — track which chains/messages are dirty (new or modified since last save) and only serialize those.
2. **Background I/O** — save in a background thread/task so the UI never waits.

For v1, a simple full-save-on-each-exchange is acceptable — session files will be modest in size (< 1MB for most sessions). Incremental save is an optimization for later.

### Auto-Naming Strategy

**Decision: Dedicated `tolo` tier model for auto-naming.** The fastest/cheapest model is used regardless of the session's current model. This keeps naming quick and cheap. The tier-to-model mapping is already in `config.py:tier_models` and resolved via `get_model_for_tier("tolo")`.

The naming call runs in a background task after the first complete exchange. It does not block the UI or delay the assistant's response.

### Session Loading

When the user loads a session from `/sessions`:

1. Save the current session first (if it has content).
2. Deserialize the selected session from disk.
3. Replace the active session in `SessionManager`.
4. Refresh the UI to show the loaded session's messages and todo list.

This means `SessionManager` needs `load_session(session_id)` and `save_session(session_id)` methods.

### Memory vs. Disk

`SessionManager` remains the source of truth during runtime. Disk is the persistence layer. On startup, the manager is empty. Sessions are loaded into the manager on demand. The auto-save writes the in-memory state to disk after each exchange.

## Open Questions — Resolved

1. **Naming model** → Use the **`tolo` tier** (fastest/cheapest) via `get_model_for_tier("tolo")`. No need to reuse the session's model.

2. **Cross-session search indexing** → **Build an in-memory inverted index on startup.** Scan all session files once at boot, build a keyword → `(session_id, message_index)` mapping. Queries are then fast lookups. Startup cost is proportional to total session count — acceptable for v1.

3. **Session file size limits** → **No cap for v1.** Logged as a known future concern (see below).

4. **Concurrent access** → **Only one instance at a time.** No locking needed.

5. **Session export/import** → **Not in scope for v1.** JSON format makes it trivial later.

## Known Future Concerns

- **Session file size:** No cap in v1. If sessions grow beyond a few hundred messages, full-serialization on every save becomes expensive. Mitigation options for later: incremental/dirty-flag saves, message truncation, or archiving old chains.

## Scope

### In Scope (v1)

- [ ] `Session.to_dict()` / `Session.from_dict()` serialization
- [ ] `Chain.to_dict()` / `Chain.from_dict()` serialization
- [ ] `SubagentRecord.to_dict()` / `SubagentManager.from_dict()` serialization (exclude non-serializable fields)
- [ ] `SessionManager.save_session()` and `load_session()`
- [ ] Auto-save on message exchange (background, non-blocking)
- [ ] `/save` command (synchronous, with feedback)
- [ ] Auto-naming after first exchange (background LLM call, `tolo` tier)
- [ ] `/sessions` command — list, load, delete, rename (modeled after `/model`)
- [ ] `search_sessions` tool for the AI agent
- [ ] In-memory keyword index for cross-session search (built on startup)

### Out of Scope (v1)

- Read-only session overlay for the user (nice-to-have, can come later)
- Incremental/dirty-flag saves
- Session export/import
- Session file size limits
- Multiple session tabs or split-view
