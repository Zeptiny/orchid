# Python ↔ Electron Feature Parity Review

**Date:** 2026-07-09  
**Scope:** Python TUI (`src/orchid/`) vs Electron desktop (`electron/src/`)  
**Context:** Follow-up after wiring personalities from disk in Electron. Inventory-level parity tests (tools, agents, skills, config fields, commands) often mark items “ported”; **runtime wiring still has material gaps**.

Older migration notes under `docs/code-review-reports/migration-review-python-to-electron.md` and the plan parity matrix are partially outdated (e.g. skill tool, `file_pattern`, `shell=false`, auto-naming, usage events). Prefer this review against current `electron/src`.

---

## Summary

| Status | Areas |
|--------|--------|
| **Critical runtime gaps** | Dynamic system prompt empty; todos not session-scoped; `/model` stub; skill `allowed_skills` ignored; multi-chain not ported; config timeouts not enforced; MCP restart is UX-only |
| **Mostly fixed / residual** | Personalities (main agent); agents/skills load+seed; 27 tools present; sessions CRUD + auto-name |
| **Electron-only (intentional)** | Onboarding, keychain, auto-updater, Cmd+K palette, Preferences UI, Monaco/xterm widgets |
| **Deferred by design** | Path sandbox / approval (R20), annotated code-review diff (R22), agent graph UI (R19), session encryption |

---

## Critical gaps

### 1. Dynamic system prompt is effectively empty

**Python:** Rebuilds a full dynamic prompt every turn (`src/orchid/llm/dynamic_system_prompt.py`):

- cwd
- directory tree (cached ~5s)
- live subagents
- todos
- background commands

**Electron:** Builder exists (`electron/src/main/llm/system-prompt.ts`) but callers pass stubs:

- `electron/src/main/ipc/chat.ts` — `todos: []`, empty subagent state, empty background commands, **no** `directoryTree`
- `electron/src/main/agents/subagent-runner.ts` — same empty context; also skips `appendPersonality`

**Impact:** Agents never see live todos/subagents/bg processes or project tree in the system prompt.

---

### 2. Todos: session isolation, persistence, and UI

| Python | Electron |
|--------|----------|
| Per-session `TodoStore` rebound via ContextVar | One global store (`tools/index.ts` `builtinContext.todoStore`) |
| 7 statuses + rich transitions + `description` | 3 statuses only (`OPEN` / `IN_PROGRESS` / `DONE`) in `shared/types/todo.ts` |
| Mutations refresh UI via callback | `notifyChanged` not wired into todo tool builders |
| Persisted on session | `toData()` not reliably written back to `session.todoStore` |

**UI:** `useTodos` peeks disk `session.todoStore.tasks` while tools mutate the in-memory singleton → sidebar can stay empty; cross-session leakage risk.

---

### 3. Skill tool not filtered per agent

**Python:** `set_current_allowed_skills` + `build_skill_tool(allowed_skills)` per stream.

**Electron:** `registerBuiltinTools` builds `buildSkillTool(skills)` with **no** `allowedSkills` (`tools/index.ts`). Every agent that can call `skill` sees **all** skills; `allowed_skills` from `AGENT.md` is ignored at invoke time.

---

### 4. Multi-chain model not ported

**Python:** New chain per user message (`app.py` `_start_chain`).

**Electron:** Single accumulating chain via `syncActiveChain` (`session/manager.ts`). UI still fakes per-turn footers from user turns (`ChatStream.tsx`); storage/`parent_chain_index` semantics are weaker.

---

### 5. `/model` is a stub

`CommandPalette.tsx`: on `/model`, only notifies *“Model picker: configure providers in settings first.”*

No tabular metadata / discovery equivalent to Python `session_commands.py` `_build_model_picker_items`. Session model change path is not equivalent.

---

### 6. Config timeouts stored but not enforced

| Field | Status in Electron |
|-------|--------------------|
| `llm_stream_idle_timeout` | In schema/env/merge; **not** used by `orchestrator.ts` (no idle-chunk deadline/retry like Python `client.py`) |
| `background_command_idle_timeout` | `checkIdleOwnership` exists on background store but is **never called** from the main loop |

---

### 7. MCP restart is a UX stub

Preferences show “Restart required” but do not call `app.relaunch()`. MCP/config changes need a manual app restart.

---

## Partial / residual differences

### Personalities (mostly fixed 2026-07-09)

**Done:**

- Seed/load from `~/.orchid/personalities/*.md`
- Bundled defaults: `default`, `meow`, `pirate`, `socrates`, `stupid`, `zen`
- Palette + Preferences list from disk (`config:listPersonalities`)
- `appendPersonality` on main chat system prompt
- `copy:defaults` build step for packaging

**Remaining:**

- Not applied in `subagent-runner.ts`
- Lazy reload only when name is missing (not forced on every personality file edit mid-run)
- No project-level personalities overlay (Python is also home-only — same)

**Key files:** `electron/src/main/personality/registry.ts`, `electron/src/main/ipc/config.ts`, `electron/src/main/ipc/chat.ts`

---

### Agents

- Seeding + home/project overlay + tiers + 26 defaults: **OK**
- Main agent hard-picks **`general`** (`chat.ts`); no picker for alternate internal agents
- Sidebar footer hardcodes `general`
- Subagent IDs are weaker than UUIDs (`Date.now()`-based)

---

### Skills

- Load/seed/resources/`skill` tool implementation: largely ported
- Gap: global skill listing / no per-agent filter (above)
- Skill tool description not rebuilt when agent changes

---

### Sessions

- CRUD, disk save/load, auto-name after first turn: **implemented**
- Todo rebind on switch: **missing**
- Subagent chains: persisted via `wire-subagents.ts`
- No chain collapse stubs (Python `CollapsedChainStub` for large histories)

---

### Commands / palette

| Command | Status |
|---------|--------|
| `/new`, `/sessions`, `/rename`, `/delete` | Wired |
| `/theme`, `/personality` | Sub-pickers (disk/CSS) |
| `/settings` | Opens Preferences |
| `/index-rag`, `/index-ast`, `/rag status`, `/rag clear` | Wired |
| `/model` | **Stub** |

Electron-only: fuzzy match, recents, Cmd+K.

---

### Tools (27 present; wiring/behavior gaps)

Inventory matches Python names. Notable differences:

- **Todos:** status machine + description + session binding incomplete
- **Skill:** `allowed_skills` not applied
- **maxSteps = 10** hardcoded (`orchestrator.ts`); Python tool loop is unbounded
- **execute_command** `shell=false`: implemented
- **rag_search `file_pattern`:** implemented
- Path sandboxing deferred on FS tools (R20)
- DNS revalidation after redirect deferred (`tools/web/fetch.ts`)

---

### MCP

Lifecycle, stdio/SSE, namespacing, resource tool: present.  
Gaps: restart no-op; no sandbox for servers (documented); schema passthrough quality may differ.

---

### RAG / AST

Indexers, tools, IPC, skip extensions: present.  
RAG embedder may fall back to `simpleTokenize` if tokenizer files missing (quality risk).  
Right sidebar Index UI weaker than Python (status props not always rendered as a full Index section).

---

### LLM

- AI SDK + middleware (retry/throttle/quirks/error class): present
- Usage events: **wired** (`CHAT_USAGE` + `onUsage`); stale TODO comment in `useChat.ts` is misleading
- OS info: platform/release/arch only vs Python distro/`mac_ver`/`win32_ver`
- Providers: OpenAI / OpenAI-compatible; not litellm’s full surface
- Model metadata table exists but not fully used in `/model` UX
- Stream idle timeout: config only

---

### Subagents

Spawn/wait/interrupt + XState + persistence + sidebar list: largely there.  
Gaps: empty dynamic prompt; no personality; no full per-subagent chat tabs like Python `subagent_ui.py`; interrupt two-phase exists in main, renderer support partial.

---

### Themes

Five themes on both sides. **Name mismatch:**

| Python | Electron |
|--------|----------|
| `windows_xp` | `windows-xp` |
| `green_terminal` | `green-terminal` |

Shared `~/.orchid/config.json` theme field will not map cleanly across TUI and desktop.

---

### Onboarding

Six-step flow + provider detect: **Electron-only** (Python has none). Solid enough for first-run.

---

### Spike / dead code

Still in tree (not primary path): `spike-chat.ts`, `SpikeChat.tsx`, `spike-tool.ts`, `spike-agent-machine.ts`.

---

## Hardcoded vs config/disk

| Area | Python | Electron |
|------|--------|----------|
| Personality | Disk + config | Disk + config (main agent) |
| Agents/skills | Disk + seed | Disk + seed |
| Themes | `windows_xp` / `green_terminal` | `windows-xp` / `green-terminal` |
| Dynamic prompt context | Live stores | Hardcoded empty arrays |
| Main agent | general | Hardcoded general |
| Tool loop depth | Unlimited | `maxSteps = 10` |
| Todo state machine | 7 statuses | 3 statuses |
| API keys | Plaintext config | Keychain + plaintext fallback |
| `llm_stream_idle_timeout` | Enforced | Config field only |
| Skill availability | Per-agent globs | All skills always |

---

## Intentionally different / Electron-only

**Deferred (see `docs/plans/deferred-features-todo.md`):**

- R20 path sandbox / diff-gated approval
- R22 annotated code-review diff
- R19 agent graph UI
- Session encryption deferred (`keychain.ts` threat model)

**Electron-only / better UX:**

- Onboarding wizard
- OS keychain (`config/keychain.ts`)
- Auto-updater (`updater.ts`)
- Monaco diff, xterm, ToolRail widgets
- Cmd+K fuzzy palette, Preferences multi-tab
- Context isolation + typed IPC + Zod
- XState agent/interrupt machines
- File logging (`logging.ts`)

**Architecture (not feature parity):** multi-process IPC vs Textual single process.

---

## Likely fine / already at parity

- **27 tool names** present and registered
- **26 agent defaults** + home/project merge + tiers
- **15 skills** with resources/requires/scripts
- **Config fields** + env overrides + validation schema
- **12 slash commands** listed (behavior of `/model` excepted)
- Personality load/seed/append for main agent
- Session auto-naming after first exchange
- Subagent runtime wiring + chain persistence
- MCP connect + namespaced tools + `read_mcp_resource`
- RAG/AST core indexing and tools
- Themes (5) and CSS switching
- `shell=false` / `file_pattern` on rag_search
- Interrupt machine (main) + Esc flow infrastructure
- Token usage events
- Provider discovery in Preferences/onboarding (not in `/model`)

---

## Suggested fix order

1. **Populate dynamic system prompt** from todo store, subagent manager, background store, and directory tree each turn.
2. **Session-scoped TodoStore:** rebind on create/switch, snapshot into session on mutate, notify UI; restore full status machine + `description` if desired.
3. **Per-agent `buildSkillTool(allowed_skills)`** inside stream / tool-map setup.
4. **`/model` picker** using providers + `resolveModelMetadata` + discovery; apply to session model.
5. Enforce **`llm_stream_idle_timeout`** (and wire background idle check).
6. **Multi-chain** (or consciously document single-chain as intentional product choice).
7. **`app.relaunch()`** for MCP changes; theme key aliasing (`windows_xp` ↔ `windows-xp`); personality on subagents.

---

## Key source references

| Concern | Python | Electron |
|---------|--------|----------|
| Personalities | `src/orchid/personality/__init__.py` | `electron/src/main/personality/registry.ts` |
| Dynamic prompt | `src/orchid/llm/dynamic_system_prompt.py` | `electron/src/main/llm/system-prompt.ts`, `ipc/chat.ts` |
| Todos | `src/orchid/domain/todo.py`, tools | `electron/src/shared/types/todo.ts`, `tools/todo/*` |
| Skills filter | `src/orchid/tools/skill.py`, client | `electron/src/main/tools/skill/skill.ts`, `tools/index.ts` |
| Commands | `src/orchid/commands/session_commands.py` | `electron/src/renderer/commands/registry.ts`, `CommandPalette.tsx` |
| Chains | `src/orchid/app.py` `_start_chain` | `electron/src/main/session/manager.ts` |
| Themes | `src/orchid/themes/registry.py` | `electron/src/shared/commands.ts`, `renderer/themes/` |

---

## Related docs

- `docs/plans/2026-07-08-001-feat-ts-electron-desktop-migration-plan-parity-matrix.md`
- `docs/code-review-reports/migration-review-python-to-electron.md` (partially outdated)
- `docs/plans/deferred-features-todo.md`
- `docs/plans/ts-electron-migration-review-findings-p2-p3.md`
- `electron/CLAUDE.md`
