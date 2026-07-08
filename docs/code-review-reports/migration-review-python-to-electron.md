# Migration Review: Python+Textual → TypeScript+Electron

**Date:** 2026-07-08
**Scope:** Full comparative analysis across 6 dimensions
**Status:** Complete

---

## Table of Contents

1. [Architecture & Code Structure](#1-architecture--code-structure)
2. [LLM Integration & AI Pipeline](#2-llm-integration--ai-pipeline)
3. [Tools, Commands & Capabilities](#3-tools-commands--capabilities)
4. [UI / Frontend / User Experience](#4-ui--frontend--user-experience)
5. [MCP, Agents, RAG, AST](#5-mcp-agents-rag-ast)
6. [Testing, Quality & Developer Experience](#6-testing-quality--developer-experience)
7. [Critical Items Summary](#7-critical-items-summary)

---

## 1. Architecture & Code Structure

### 1.1 Overall Architecture

**Python (`src/orchid/`)** — Monolithic TUI

```
src/orchid/
├── main.py              ← Entry point
├── app.py               ← Orchid App class (Textual App subclass)
├── config.py            ← Config loading, validation, persistence
├── storage.py           ← File I/O helpers
├── domain/              ← Domain models (Session, Message, Chain, Agent, Tool, Todo)
├── llm/                 ← LLM client, providers, system prompts
├── agents/              ← Agent registry, SubagentManager
├── widgets/             ← Textual UI widgets
├── screens/             ← Textual screens (Settings, Picker, InputModal)
├── commands/            ← Session commands
├── tools/               ← Tool definitions
├── mcp/                 ← MCP client
├── rag/                 ← RAG indexing and search
├── ast/                 ← AST symbol indexing and query
├── themes/              ← Theme registry
├── personality/         ← Personality system
└── skills/              ← Skill system
```

- Monolithic single-process. The `Orchid` class (`app.py:290`) subclasses `Textual.App` and is the root of everything.
- Domain models cleanly separated in `domain/`.
- The `Orchid` App class mixes controller and view — manages state, handles input, and renders widgets.

**Electron (`electron/src/`)** — Multi-process with strict IPC boundary

```
electron/src/
├── main/
│   ├── index.ts              ← Entry point (Electron main process)
│   ├── ipc/                  ← IPC handlers
│   ├── config/               ← Config (schema, loader, merge, validation, keychain)
│   ├── agents/               ← Agent registry + XState machines
│   ├── llm/                  ← LLM orchestrator, providers, middleware
│   ├── tools/                ← Tool registry + implementations
│   ├── mcp/                  ← MCP manager and transport
│   ├── rag/                  ← RAG indexing and search
│   ├── ast/                  ← AST symbol indexing and query
│   ├── session/              ← Session manager
│   └── updater.ts            ← electron-updater integration
├── preload/
│   └── index.ts              ← contextBridge API (typed channel allowlist)
├── renderer/
│   ├── main.tsx              ← React entry point
│   ├── App.tsx               ← Root React component
│   ├── components/           ← UI components
│   ├── hooks/                ← React hooks
│   ├── commands/             ← Renderer-side command palette
│   ├── themes/               ← CSS theme files
│   └── styles/               ← Global CSS
└── shared/
    └── types/                ← Shared types (ipc, message, session, chain, tool, agent)
```

- Strictly layered multi-process (Main ↔ Preload ↔ Renderer).
- Clean three-layer split: main owns business logic, renderer owns UI, preload is security boundary.
- Communication via typed IPC only.

### 1.2 Module Mapping

| Python Module | TS Equivalent | Notes |
|---|---|---|
| `main.py` | `electron/src/main/index.ts` | TS adds auto-updater, graceful shutdown |
| `app.py` | `renderer/App.tsx` + `main/ipc/chat.ts` + `main/agents/xstate/agent-machine.ts` | Split across 3 files — UI, chat IPC, agent orchestration |
| `config.py` | `main/config/` (schema.ts, loader.ts, merge.ts, validation.ts, keychain.ts) | Expanded: zod schema, layered merge, OS keychain |
| `domain/message.ts` | `shared/types/message.ts` | TS adds zod schemas, typed `ToolCall[]` |
| `domain/session.ts` | `shared/types/session.ts` + `main/session/manager.ts` | Split into type + runtime manager |
| `domain/chain.ts` | `shared/types/chain.ts` | TS adds `agentName`/`agentType`/`agentTier` |
| `domain/agent.ts` | `shared/types/agent.ts` + `main/agents/registry.ts` | Split |
| `domain/tool.ts` | `shared/types/tool.ts` + `main/tools/registry.ts` | Expanded with ToolRegistry class |
| `llm/client.py` | `main/llm/orchestrator.ts` | Ported: litellm → AI SDK streamText |
| `llm/providers.py` | `main/llm/providers.ts` + `providers-factory.ts` | Ported |
| `agents/manager.py` | `main/agents/manager.ts` | TS adds XState actors instead of asyncio tasks |
| — (new) | `main/agents/xstate/` | **New**: XState finite state machines for agent lifecycle |
| `mcp/` | `main/mcp/` | Direct port |
| `rag/` | `main/rag/` | Direct port |
| `ast/` | `main/ast/` | Direct port |
| `tools/*.py` | `main/tools/` | Direct port |
| `widgets/sidebar.py` | `renderer/components/Sidebar.tsx` | Rewritten in React + DaisyUI |
| `widgets/message_widget.py` | `renderer/components/MessageWidget.tsx` | Rewritten. Adds markdown rendering, collapsible tool calls |
| `widgets/command_picker.py` | `renderer/components/CommandPalette.tsx` | Rewritten |
| `widgets/smart_scroll.py` | `renderer/components/ChatStream.tsx` | Rewritten with auto-scroll |
| `widgets/subagent_ui.py` | `renderer/hooks/useSubagents.ts` | No dedicated subagent tab UI yet |
| `widgets/live_command.py` | Not yet ported | **GAP** |
| `personality/` | `main/llm/system-prompt.ts` | Integrated into orchestrator |
| `skills/` | `main/skills/` | Partially ported |
| — (new) | `main/updater.ts` | **New**: auto-update via electron-updater |
| — (new) | `main/config/keychain.ts` | **New**: OS keychain encryption for API keys |
| — (new) | `shared/types/ipc.ts` | **New**: typed IPC channel API surface |
| — (new) | `preload/index.ts` | **New**: security boundary with channel allowlist |
| — (new) | `renderer/components/ToolWidgets/` | **New**: rich tool result widgets |
| — (new) | `renderer/components/Onboarding/` | **New**: first-run onboarding flow |
| — (new) | `renderer/components/Preferences/` | **New**: multi-tab preferences UI |

### 1.3 IPC / Communication Model

| Aspect | Python (Textual) | TypeScript (Electron) |
|---|---|---|
| Architecture | Single process | Main + Renderer + Preload (3 processes) |
| Communication | Direct object references + Textual message passing | `ipcMain.handle` / `ipcRenderer.invoke` + `webContents.send` |
| Security boundary | None | `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, channel allowlists |
| Streaming | `run_worker` + asyncio generator | IPC returns immediately; chunks pushed via `webContents.send` |
| Payload validation | Duck-typing + dataclasses | Zod schemas at every IPC boundary |
| Event subscription | Textual `on_*` method dispatch | `window.orchid.chat.onChunk(callback)` returns unsub function |
| Tool IPC | Direct Python import | Renderer-restricted allowlist (`RENDERER_ALLOWED_TOOLS`) |

### 1.4 State Management

| Aspect | Python (Textual) | TypeScript (React) |
|---|---|---|
| Core approach | Mutable object state + Textual reactive `@watch` decorators | React `useState` + `useCallback` hooks + XState machines |
| Session state | `self.sessions: SessionManager` on Orchid instance | `useSession()` hook with typed states (loading/empty/ready/partial/error) |
| Chat state | Direct iteration over chain, `_active_worker` | `useChat()` hook with typed `ChatState` interface |
| Agent orchestration | `_stream_response()` async generator | XState `agentMachine` with explicit states: `idle → streaming → toolExecuting → idle |
| Interrupt handling | `InterruptState` enum with timer-based auto-reset | XState `interrupted` state with `after.INTERRUPT_RESET` delay |
| Config | Singleton `ConfigManager._instance` | Same pattern, TS adds `reset()` for testing |

### 1.5 Configuration

| Feature | Python `config.py` | TS `electron/src/main/config/` |
|---|---|---|
| Source of truth | `@dataclass Config` class | `zod` schema (`schema.ts:30-97`) |
| Merge order | defaults → ~/.orchid/config.json → .orchid.json → env | Same order |
| Validation | `validate_config()` function, manual type checks | Zod type guards |
| API Key storage | Plaintext in `~/.orchid/config.json` | `keychain.ts` — OS encryption with fallback |
| API Key redaction | Not present | `redactApiKey()` returns last 4 chars |

### 1.6 Entry Points

| Aspect | Python `main.py` | TS `electron/src/main/index.ts` |
|---|---|---|
| Logging | File handler to `~/.orchid/logs/orchid.log` | `console.log`/`console.warn` only |
| Restart | `os.execv` re-exec for config/mcp refresh | Not present — user must manually relaunch |
| Shutdown | `on_unmount()` cleanup | `app.on('before-quit')` with lifecycle: unregister IPC, shutdown MCP, destroy updater |
| Dev vs Production | Same entry point | Conditional: `localhost:5173` for dev, `index.html` for prod |

### 1.7 Improvements Gained

1. Security model (contextIsolation + sandbox + typed preload)
2. XState finite state machines for agent orchestration
3. Strictly typed IPC boundary with Zod validation
4. OS keychain encrypted API key storage
5. Auto-updater via electron-updater
6. Rich renderer (React + DaisyUI, markdown, tool widgets)
7. Dev server with hot reload
8. Graceful shutdown lifecycle
9. Onboarding flow + multi-tab preferences
10. Explicit async states (loading/empty/error/ready for every hook)

### 1.8 Regressions

1. Token usage not wired in renderer (`useChat.ts:64` TODO)
2. Live command widgets not ported
3. Chain collapse (>20 messages → stubs) not ported
4. Auto-naming sessions via LLM not ported
5. Persistent file logging lost
6. Config-change restart lost
7. Subagent tab UI not ported
8. Personality & skills modules partially ported
9. ContextVar pattern for thread-safe state lost
10. Interrupt two-phase confirmation not fully wired in renderer
11. Footer usage breakdown (ΣX · ↑Y etc.) missing

---

## 2. LLM Integration & AI Pipeline

### 2.1 LLM Client/Provider

| Dimension | Python (litellm) | Electron (AI SDK) |
|---|---|---|
| Engine | `litellm.acompletion` | Vercel AI SDK `streamText` |
| Provider coverage | 250+ providers implicitly | 6 canned (`openai`, `anthropic`, `google`, `gemini`, `groq`, `xai`) + `openai-compatible` catch-all |
| Model metadata | `max_input_tokens`, `max_output_tokens`, `supports_vision`, `mode` | None |
| Model discovery | `GET /models` on base_url | Only in renderer onboarding, not in LLM pipeline |
| Embedding | `fastembed/` shortcut for local ONNX; generic fallback | `onnxruntime-node` for RAG, no `resolve_embedding_ref` |
| Error types | 13 branches + httpx + litellm typed exceptions | 13 branches via custom error hierarchy |

### 2.2 System Prompts

| Aspect | Python | Electron |
|---|---|---|
| OS info richness | Distro name, macOS version, Windows build | Bare `platform + release + arch` |
| Directory tree | Async, cached per-cwd with 5s TTL | Pre-computed by caller (no caching) |
| Dynamic prompt timing | Built per-stream turn | Built once, passed as `context` |
| Subagent/todo/bg | All fetched fresh from stores | All pre-computed by caller |

### 2.3 Streaming & Message Handling

| Aspect | Python | Electron |
|---|---|---|
| Concurrency model | 2 concurrent tasks (stream + executor) via queues | Single async generator, AI SDK manages tool execution |
| Multi-step tool loop | Manual anchoring + executor task | `maxSteps=10` built into AI SDK |
| Idle timeout | Per-chunk deadline with retry on idle | AI SDK default timeout only |
| Thinking throttling | 100ms throttle inline | Throttle middleware with TransformStream |
| Stream termination logging | Detailed: finish_reason='length' warning | None |
| Usage tracking | Per-chunk, emitted as message | Accumulated at step boundaries, single final emission |

### 2.4 Middleware (New in Electron)

Five composable middleware replace Python's inline error handling:

| Middleware | File | Maps to Python |
|---|---|---|
| Retry | `retry.ts` | Inline retry in `stream_response()` (client.py:1060-1171) |
| Throttle | `throttle.ts` | `_YIELD_THROTTLE = 0.1` + `flush_thinking()` |
| Provider Quirks | `provider-quirks.ts` | `_patch_litellm_raise_on_model_repetition` + `_is_benign_midstream_litellm_error` |
| Error Classification | `error-classification.ts` | `classify_error()` (13 branches) |
| Index | `index.ts` | `createMiddlewareStack()` composes ordered layers |

### 2.5 Tool Dispatch

| Aspect | Python | Electron |
|---|---|---|
| Timeout | 60s, same exempt set | 60s, same exempt set + `noTimeout` flag |
| Offloading | 20KB threshold | Same threshold, same path |
| MCP tools | Merged into filtered_tools dict | Added to AI SDK tool map |
| Skill tool | Replaced with `build_skill_tool(allowed_skills)` | Not implemented |
| Tool validation | Schema-based `_validate_tool_args` | No schema validation before execution |

### 2.6 History/Context Management

- **Core algorithm**: Identical — pre-pass for `survivingToolCallIds`, THINKING replay as content, tool_calls filtering, orphan tool result dropping.
- **Improvement**: `cleanup.ts` introduces `cleanOrphanToolResults()`, `cleanDanglingToolCalls()`, `reconcileChain()`, `cleanStreamingArtifacts()` — dedicated message reconciliation.
- **Regression**: None significant.

### 2.7 Regressions

| # | Regression | Severity |
|---|---|---|
| 1 | Provider coverage (250+ → 6 + openai-compatible) | High |
| 2 | Model metadata (no max_input_tokens, supports_vision) | Medium |
| 3 | Model endpoint discovery not in LLM pipeline | Medium |
| 4 | fastembed embedding shortcut lost | Medium |
| 5 | OS info richness (distro name, macOS version) | Low |
| 6 | Tool argument validation not ported | Low |
| 7 | Skill tool builder not ported | Medium |
| 8 | Stream termination diagnostics lost | Low |
| 9 | Stream idle timeout retry lost | Medium |
| 10 | Per-chunk usage streaming lost | Low |
| 11 | Directory tree caching (5s TTL) lost | Low |

### 2.8 Improvements

| # | Improvement | Significance |
|---|---|---|
| 1 | Middleware architecture (5 composable modules) | High |
| 2 | AI SDK `maxSteps` for multi-turn tool loops | High |
| 3 | Cleanup utilities (reconcileChain, etc.) | Medium |
| 4 | Composable error hierarchy | Medium |
| 5 | TransformStream-based throttling | Low |
| 6 | TypeScript types for stream events | Medium |
| 7 | Content-delivered guard using TransformStream | Medium |
| 8 | Tool `noTimeout` flag support | Low |
| 9 | AbortSignal support | Low |

---

## 3. Tools, Commands & Capabilities

### 3.1 Tool Inventory

**27/27 tools ported. Zero missing, zero new.**

| # | Tool Name | Python Source | Electron Source | Status |
|---|-----------|---------------|-----------------|--------|
| 1 | `read` | `file_manipulation.py:18` | `filesystem/read.ts` | Ported |
| 2 | `edit` | `file_manipulation.py:84` | `filesystem/edit.ts` | Ported |
| 3 | `read_directory` | `file_manipulation.py:207` | `filesystem/read-directory.ts` | Ported |
| 4 | `glob` | `file_manipulation.py:253` | `filesystem/glob.ts` | Ported |
| 5 | `write` | `file_manipulation.py:311` | `filesystem/write.ts` | Ported |
| 6 | `grep` | `search.py:11` | `search/grep.ts` | Ported |
| 7 | `rag_search` | `rag.py:20` | `rag/search.ts` | Ported |
| 8 | `rag_index` | `rag.py:43` | `rag/index.ts` | Ported |
| 9 | `todo_create` | `todo.py:20` | `todo/create.ts` | Ported |
| 10 | `todo_update` | `todo.py:43` | `todo/update.ts` | Ported |
| 11 | `todo_list` | `todo.py:77` | `todo/list.ts` | Ported |
| 12 | `todo_delete` | `todo.py:96` | `todo/delete.ts` | Ported |
| 13 | `execute_command` | `exec.py:68` | `process/execute-command.ts` | Ported |
| 14 | `web_fetch` | `web_fetch.py:30` | `web/fetch.ts` | Ported |
| 15 | `delegate_to_subagent` | `subagent.py:10` | `subagent/delegate.ts` | Ported |
| 16 | `wait_for_subagent` | `subagent.py:88` | `subagent/wait.ts` | Ported |
| 17 | `interrupt_subagents` | `subagent.py:146` | `subagent/interrupt.ts` | Ported |
| 18 | `skill` | `skill.py:91` | `skill/skill.ts` | Ported |
| 19 | `read_mcp_resource` | `mcp_resource.py:3` | `mcp/resource.ts` | Ported |
| 20 | `get_file_skeleton` | `ast.py:249` | `ast/get-file-skeleton.ts` | Ported |
| 21 | `get_function` | `ast.py:269` | `ast/get-function.ts` | Ported |
| 22 | `find_symbol_references` | `ast.py:293` | `ast/find-symbol-references.ts` | Ported |
| 23 | `replace_symbol` | `ast.py:316` | `ast/replace-symbol.ts` | Ported |
| 24 | `rename_symbol` | `ast.py:344` | `ast/rename-symbol.ts` | Ported |
| 25 | `read_output` | `background_io.py:23` | `process/read-output.ts` | Ported |
| 26 | `send_input` | `background_io.py:53` | `process/send-input.ts` | Ported |
| 27 | `terminate_command` | `background_io.py:218` | `process/terminate-command.ts` | Ported |

### 3.2 Tool Implementation Quality

#### Filesystem Tools

| Aspect | Python | Electron | Delta |
|---|---|---|---|
| `read` | Async via aiofiles | Sync `fs.readFileSync`, **adds binary detection** | Electron improves |
| `edit` | Python `difflib.unified_diff`, XML output | Custom LCS-based diff, raw diff text | Different approach |
| `write` | Async, atomic write | Sync, **preserves file permissions** (chmod 0o644) | Electron improves |
| `glob` | `glob_module.glob()` | Custom recursive glob implementation | Functionally equivalent |
| Post-write callbacks | Mutable module-level list | Register/unregister/clear API | Electron improves |

#### Process Tools

| Aspect | Python | Electron | Delta |
|---|---|---|---|
| `execute_command` | Supports `shell=False` via `shlex.split` | Hardcoded `/bin/sh -c` | Python more flexible |
| Background store | `os.openpty()` | `node-pty` (real native PTY) | Electron more robust on Windows |
| `terminate_command` | SIGKILL immediately | 2s grace delay then SIGKILL | Different behavior |

#### AST Tools

All 5 tools ported. Need to verify:
- Disambiguation for multiple definitions in `replace_symbol` (Python `ast.py:783-807`)
- Word boundary checking in `rename_symbol` (Python `ast.py`)

#### Search, RAG, Web Tools

| Aspect | Python | Electron | Delta |
|---|---|---|---|
| `grep` | Semaphore=32, per-file timeout 10s, binary detection | Same — essentially equivalent | Equivalent |
| `rag_search` | Supports `file_pattern` glob filter | **Missing `file_pattern` parameter** | Regression |
| `web_fetch` SSRF | Validates URL before fetch only | Validates before AND after redirects, comprehensive private IP blocking | Electron greatly improves |
| `web_fetch` size | No max body size | 10 MiB max | Electron adds cap |

### 3.3 Commands System

| Command | Python | Electron | Notes |
|---|---|---|---|
| `/new` | Implemented | Implemented | Both |
| `/sessions` | OptionPicker with date-grouped sessions | Opens sub-picker | Both |
| `/rename` | InputModal | Custom event | Different UX |
| `/delete` | OptionPicker | Direct delete | Both |
| `/model` | Tabular display with tokens/vision + model discovery | Stub | **Python richer** |
| `/theme` | OptionPicker | Sub-picker | Equivalent |
| `/personality` | OptionPicker | Sub-picker | Equivalent |
| `/settings` | Full SettingsScreen | Delegates to onOpenSettings() | **Python richer** |
| `/index-rag` | Async with concurrent guard | Direct call | Python has guard |
| `/index-ast` | Async with concurrent guard | Direct call | Python has guard |

**Electron-only improvements:**
- Fuzzy matching with scored ranking (`commands/registry.ts:43-81`)
- Character-level match highlighting
- Recent commands tracking via localStorage
- Category-based command organization

### 3.4 Tool Registry

| Aspect | Python | Electron |
|---|---|---|
| Type | Module-level dict | `class ToolRegistry` with `Map` |
| Validation | None (raw dict) | Zod schema validation |
| Tool model | `Tool` class with XML-like parameters | `ToolDefinition` with Zod inputSchema |
| Filtering | None built-in | `filter()` with minimatch glob patterns |
| JSON Schema | Not available | `toJsonSchema()` via zod-to-json-schema |
| Duplicate guard | Silent overwrite | Throws Error on duplicate |
| Architecture | Monolithic dict | Decentralized registration per category |

### 3.5 New Capabilities in Electron

1. Binary file detection in `read` tool
2. File permission preservation on `write`
3. SSRF protection (private IP blocking + redirect revalidation)
4. Response size cap (10 MiB)
5. Zod schema validation at tool definition
6. JSON Schema generation for MCP/LLM
7. Callback unregister API
8. Duplicate registration guard
9. Tool categories
10. `noTimeout` flag
11. Decentralized registration
12. Fuzzy command matching
13. Recent commands tracking
14. Real PTY via node-pty

### 3.6 Regressions

| # | Item | Severity |
|---|------|----------|
| 1 | `execute_command` `shell=false` support lost | Medium |
| 2 | `rag_search` `file_pattern` parameter missing | Low |
| 3 | Model picker with auto-discovery | Medium |
| 4 | Settings screen with MCP restart | Medium |
| 5 | Indexing concurrency guard | Low |
| 6 | `interrupt_subagents` `flush_state_callbacks()` | Low |
| 7 | XML-wrapped diff output in `edit` | Low |

---

## 4. UI / Frontend / User Experience

### 4.1 Component Mapping

| Python Widget | React Component | Status |
|---|---|---|
| `UserMessageWidget` | `MessageWidget.tsx:44` | Full |
| `AssistantMessageWidget` | `MessageWidget.tsx:58` | Full |
| `ThinkingMessageWidget` | `MessageWidget.tsx:81` | Partial (no collapse) |
| `ToolResultMessageWidget` | `MessageWidget.tsx:121` | Partial (no inline diff) |
| `ErrorMessageWidget` | `MessageWidget.tsx:151` | Full |
| `CommandPicker` | `CommandPalette.tsx:39` | Evolved (Cmd+K modal) |
| `Sidebar` | `Sidebar.tsx:33` | Full |
| `SmartScrollContainer` | `ChatStream.tsx:26-58` | Full |
| `ChainFooterWidget` | `Footer.tsx:15` | Full |
| `LiveCommandOutputWidget` | `TerminalWidget.tsx` | Replaced by xterm.js |
| `SubagentUIManager` | `useSubagents` hook | Partial (no tab panes) |
| `OptionPicker` | CommandPalette search-based | Evolved |
| `InputModal` | — | **Missing** |

### 4.2 New Components (Electron only)

| Component | File | Purpose |
|---|---|---|
| `OnboardingScreen` | `Onboarding/OnboardingScreen.tsx:51` | 6-step first-run setup |
| `ProviderDetector` | `Onboarding/ProviderDetector.tsx` | Scans for Ollama, checks env vars |
| `CommandPalette` | `CommandPalette.tsx:39` | Cmd+K fuzzy search |
| `DiffWidget` | `ToolWidgets/DiffWidget.tsx:80` | Monaco side-by-side diff |
| `TerminalWidget` | `ToolWidgets/TerminalWidget.tsx:25` | xterm.js terminal |
| `FilePreview` | `ToolWidgets/FilePreview.tsx:97` | Syntax-highlighted file preview |
| `ResultsTable` | `ToolWidgets/ResultsTable.tsx:56` | Sortable table for grep results |
| `ToolRail` | `ToolWidgets/ToolRail.tsx:35` | Collapsible, resizable side rail |
| `MarkdownContent` | `MarkdownContent.tsx:26` | Zero-dependency markdown renderer |
| `PreferencesWindow` | `Preferences/PreferencesWindow.tsx:119` | 5-tab modal with Save/Discard |

### 4.3 Theming

| Aspect | Python (Textual) | Electron (DaisyUI/Tailwind) |
|---|---|---|
| Themes | 4 | 5 |
| Variables | ~12 | ~40+ CSS custom properties |
| Approach | Textual `Theme` class | CSS custom properties + DaisyUI |
| Capabilities | 16 ANSI colors, no shadows | Oklch color space, shadows, blur, animations, transitions |
| Font control | Terminal-dependent | Per-theme `--font-family` |

### 4.4 Chat Experience

| Feature | Python | Electron |
|---|---|---|
| Markdown rendering | Textual's built-in `Markdown` widget | Custom `MarkdownContent` with regex parsing |
| Streaming | `MarkdownStream` with delta-based throttled writes | Full-content re-render on every chunk |
| Thinking messages | Collapsible with throttle/flush/finish lifecycle | Basic italic display, no collapse |
| Tool calls | Static placeholder text | DaisyUI Collapse with expandable JSON args |
| Tool results | Collapsible with custom diff rendering | Collapse with "Show more" truncation |
| Diff rendering | Rich Text diff with line numbers + syntax highlighting in chat | Monaco DiffEditor in ToolRail (not inline) |

### 4.5 Styling

| Aspect | Python (TCSS) | Electron (Tailwind + DaisyUI) |
|---|---|---|
| Lines | ~507 | 2900+ |
| Layout | Flexbox | Flexbox + CSS Grid |
| Depth | No shadows, no blur | Box shadows, backdrop blur |
| Animations | None | Blink cursor, pulsing status, spinning loaders |
| Statefulness | None | Loading/empty/error/partial visual patterns |
| Typography | Terminal-dependent | Inter, JetBrains Mono, 5 font-size levels |

### 4.6 Accessibility

**Electron improvements:**
- ARIA roles on modals, tabs, buttons
- Focus traps in modal dialogs
- `kbd` elements for keyboard shortcut hints
- Semantic HTML structure

**Electron regressions:**
- No `aria-live` region for chat stream updates
- No toast announcements
- Depends on web accessibility standards (may not be fully implemented)

### 4.7 Regressions

| # | Regression | Severity |
|---|---|---|
| 1 | Context breakdown grid (8x8 colored blocks) | Medium |
| 2 | Per-subagent tab panes | High |
| 3 | Token tracking sidebar | Medium |
| 4 | Background command sidebar entries with live tail | Medium |
| 5 | Inline diff rendering in chat | Low |
| 6 | Throttled streaming (delta-based writes) | Medium |
| 7 | Working directory display in sidebar | Low |
| 8 | Generic InputModal | Low |
| 9 | Inline live command widgets in chat | Medium |

### 4.8 Improvements

| # | Improvement | Significance |
|---|---|---|
| 1 | Monaco Diff Editor | High |
| 2 | xterm.js Terminal | High |
| 3 | Command Palette (Cmd+K) | High |
| 4 | ToolRail with tabs | High |
| 5 | Onboarding wizard | Medium |
| 6 | 5 themes with 40+ CSS vars | Medium |
| 7 | Tailwind + DaisyUI | Medium |
| 8 | Preference window | Medium |
| 9 | CSS animations | Low |
| 10 | Keyboard shortcuts (Cmd+K, Cmd+B, etc.) | Medium |
| 11 | Markdown rendering (zero-dep) | Medium |
| 12 | System messages | Low |
| 13 | Interrupt indicators | Low |
| 14 | Empty states | Low |
| 15 | Error banners | Low |

---

## 5. MCP, Agents, RAG, AST

### 5.1 MCP (Model Context Protocol)

**Architecture:** Both implement the same lifecycle pattern — dedicated runner task, stdio and SSE transports, per-server timeout (10s) + overall startup timeout (60s), graceful degradation, namespaced tool registration.

**Improvements:**
- Structured `_clearDisconnectedState()` (`manager.ts:486-512`)
- Dedicated `_parseToolName()` parser (`manager.ts:520-536`)
- `mcpServerConfigSchema` Zod schema for config validation (`schema.ts:41-57`)
- Clean transport factory pattern (`transport.ts:32-46`)
- Shared `MCPServerStatus` types cross IPC boundary

**Regressions:**
- Passthrough Zod schema discards MCP tool JSON Schema details (`manager.ts:549-552`)
- Returns plain `unknown` instead of typed `ExecutorResult`
- Uses deprecated `SSEClientTransport` (acknowledged in code)

### 5.2 Agents / Subagents

**What XState adds (biggest architectural leap):**

| Machine | File | States |
|---|---|---|
| Agent Machine | `agent-machine.ts:234-432` | `idle`, `streaming`, `toolExecuting`, `interrupted`, `error` |
| Subagent Machine | `subagent-machine.ts:166-273` | `pending`, `running`, `completed`, `failed`, `interrupted` |
| Session Machine | `session-machine.ts:72-282` | Root actor managing agent + subagent actors |
| Interrupt Machine | `interrupt-machine.ts:43-104` | `idle→confirmAgent→confirmSubagents→idle` with 5s auto-reset |

**Registry pattern improvements:**
- `loadAgents()` with explicit options (`homeDir`, `projectDir`) for testability
- `getAgent()`, `listAgents()`, `resetAgentRegistry()` clean API
- Separation of concerns — registry has no lifecycle management

**Regressions:**
- Non-cryptographic ID generation (`Date.now()` base, collision-prone)
- No Chain integration — `chain: null`; loss of message persistence
- No `_pending_callback_tasks` / `flush_state_callbacks()`
- No `_restore_agent()` fallback for storage recovery
- No storage serialization (`to_storage_dict`/`from_storage_dict`)
- No `finalize_chain_on_restore()` logic

### 5.3 RAG (Retrieval Augmented Generation)

**CRITICAL REGRESSION — Embedding quality:**

Python uses `fastembed` which provides proper BPE tokenization via HuggingFace tokenizers. Electron implements `simpleTokenize()` (`embedder.ts:505-530`) — a hash-based approximation explicitly noted as "For production, replace with a proper tokenizer." Hash collisions will produce incorrect embeddings, degrading retrieval quality.

Additional RAG regressions:
- No API-based embedding fallback (Python supports litellm)
- Inline ONNX inference (Python offloads to fastembed thread)
- Custom `.npy` parser instead of numpy (fragile binary format handling)
- Manual cosine similarity (no SIMD) vs numpy vectorized ops
- No equivalent to Python's `_should_include()` with `SKIP_EXTS` check

RAG improvements:
- Full `downloadModel()` system with progress, atomic writes, file size verification
- `isModelAvailable()` for checking before use
- Pre-filters by file pattern before cosine similarity scoring

### 5.4 AST (Abstract Syntax Tree)

| Aspect | Python | Electron |
|---|---|---|
| Runtime | Native `.so` (ctypes) | WASM (web-tree-sitter) |
| Portability | Platform-dependent | Fully portable (WASM) |
| API style | Synchronous | Async (WASM init) |
| Memory | GC-collected | Explicit `tree.delete()` required |
| Grammar source | `~/.cache/tree-sitter-language-pack` | `node_modules/tree-sitter-wasms` |

**Improvements:**
- `dispose()` function for explicit cleanup
- `ensureInitialized()` idempotent async-safe init
- `tree.delete()` in `try/finally` prevents WASM memory leaks
- `resetSession()` for testability

**Regressions:**
- All tree-sitter object types typed as `any` — no type safety
- Log output uses `console.log` instead of structured logger

### 5.5 Skills

**Improvements:**
- Zod schemas for runtime validation
- `skillToStorageDict()` / `skillFromStorageDict()` serialization
- Clean `loadSkills()`, `getSkill()`, `listSkills()`, `resetSkillRegistry()` API

**Regressions:**
- No `Skill.validate()` — no name pattern check or description length enforcement
- Unified `resources` array loses script/reference/asset type distinction
- No `requires` validation

### 5.6 Cross-Cutting

**Patterns gained:** Zod everywhere, shared IPC boundary, XState actor hierarchy, explicit memory management (dispose pattern).

**Cross-cutting regressions:**
1. **Embedding quality** — hash-based tokenizer (CRITICAL)
2. **Tool schema fidelity** — MCP schemas discarded
3. **No API-based embedding fallback**
4. **Numpy serialization** — custom `.npy` is fragile
5. **ID generation** — `Date.now()` is collision-prone
6. **Chain/state persistence** — no serialization for subagent records

---

## 6. Testing, Quality & Developer Experience

### 6.1 Test Coverage

| Metric | Python | TypeScript |
|--------|-------:|----------:|
| Test files | 61 | 32 |
| Total lines | 23,369 | 18,238 |
| Largest file | 3,284 lines (streaming) | 981 lines (skill-mcp-tools) |
| Median file size | ~250 lines | ~600 lines |

### 6.2 Test Organization

**Python (flat):**
- All 61 files at `tests/` root
- Mixed frameworks: `unittest.TestCase`, `unittest.IsolatedAsyncioTestCase`, bare pytest
- No conftest.py, no shared fixtures

**TypeScript (hierarchical):**
```
electron/tests/
  unit/          # 18 files — isolated tests
  integration/   # 7 files — component interactions
  parity/        # 5 files — migration completeness
```
- Single framework: vitest
- Clear 3-tier organization

### 6.3 Parity Tests (Novel)

| File | Lines | Entities | What it verifies |
|---|---|---|---|
| `tools.test.ts` | 428 | 27 tools | definition (name, description, inputSchema, category), handler function |
| `agents.test.ts` | 204 | 26 agents | name/type/tier/description, allowed tools, tier distribution |
| `commands.test.ts` | 96 | 12 commands | name/description/category/execute |
| `config.test.ts` | 184 | 22 fields | schema type, default values |
| `sessions.test.ts` | 322 | ~15 scenarios | CRUD, save/load round-trip, auto-naming |
| `skills.test.ts` | 178 | 15 skills | requires, description, location, resources |

**Verdict:** Structural inventories — verify entities exist with right shape, but NOT behavioral parity (don't compare outputs).

### 6.4 Coverage Gaps

**Tested in Python but NOT in TypeScript (regression risks):**

| Area | Python test files | Lines | Electron coverage |
|---|---|---|---|
| RAG internals | 6 files (store, indexer, robustness, incremental, chunker, embedder, tools) | 3,173 | Only `rag-pipeline.test.ts` (920 lines) |
| Streaming messages | `test_streaming_messages.py` | 3,284 | No equivalent |
| MCP lifecycle edge cases | 5 files (lifecycle, startup_timeout, schema, registry, resource) | 1,288 | Partial (`mcp-client.test.ts` 737 lines) |
| Background commands & PTY | 5 files (background_io, background_store, background_prompt, pty_support, exec) | 1,859 | Missing |
| UI widgets | 4 files (settings_screen, subagent_ui, sidebar_collapsible, sidebar_bg_commands) | 2,674 | Replaced by integration tests |

**Tested in TypeScript but NOT in Python (improvements):**

| Area | TS test files | Lines |
|---|---|---|
| XState state machines | `xstate-agents.test.ts` | 839 |
| LLM orchestrator | `llm-orchestrator.test.ts` | 820 |
| LLM middleware | `llm-middleware.test.ts` | 823 |
| Auto-update | `auto-update.test.ts` | 587 |
| OS keychain | `keychain.test.ts` | 587 |
| Architecture validation | `architecture-validation.test.ts` | 369 |
| UI integration | 7 integration tests | 3,933 |

### 6.5 Linting & Type Checking

| Aspect | Python | TypeScript |
|---|---|---|
| Linter | Ruff (fast, <1s) | ESLint (3-5s) |
| Type checker | Pyright `strict` mode | TS `strict: true` |
| CI | Ruff + Pyright run in parallel | Sequential (typecheck → lint → test) |
| Formatting | Ruff handles via isort | Prettier (separate tool) |

**Regression:** Python CI runs ruff and pyright in parallel. Electron bundles typecheck, lint, and test into a single sequential job.

**Improvement:** TypeScript's `strict: true` catches more type errors at compile time.

### 6.6 CI/CD

| Aspect | Python | TypeScript/Electron |
|---|---|---|
| CI files | 2 (test.yml, lint.yml) | 1 (electron-build.yml) |
| Matrix testing | Python 3.11/3.12/3.13 | macOS/Windows/Linux build (no test matrix) |
| Artifact output | None | DMG/EXE/AppImage/deb |
| Total CI time | ~3min (parallel) | ~15-30min (sequential) |

**Regression:** Python tests across 3 Python versions. Electron only tests on default Node.js.

**Improvement:** Electron CI produces distributable binaries as artifacts.

### 6.7 Developer Experience

**Python wins:**
- Simpler setup (~30s vs ~3min)
- Faster tests (2-5s vs 5-15s)
- Fewer dependencies (15 vs 60)
- No native module compilation

**TypeScript wins:**
- Parity tests (migration completeness inventory)
- State machine tests (XState lifecycle validation)
- UI integration tests
- Architecture validation tests
- Built-in coverage support
- Stricter type safety
- Structured test organization (unit/integration/parity)
- CI artifacts (distributable binaries)

---

## 7. Critical Items Summary

### Top 10 Items to Address

| # | Issue | Severity | Dimension | Details |
|---|-------|----------|-----------|---------|
| 1 | **Hash-based tokenizer in RAG embedder** | Critical | RAG | `embedder.ts:505-530` — `simpleTokenize()` produces different token IDs than BPE models expect, degrading retrieval quality. Replace with proper tokenizer (e.g., `@huggingface/tokenizers` or `tiktoken`). |
| 2 | **Provider coverage reduced** | High | LLM | 250+ litellm providers → 6 + openai-compatible. Loss of Bedrock, Vertex AI, Together AI, Ollama, and more. Consider expanding `providers-factory.ts` or adding provider adapters. |
| 3 | **Subagent tab UI missing** | High | UI | Python had dedicated per-subagent tab panes with live status (`subagent_ui.py`). Electron only has sidebar list indicators. |
| 4 | **Token usage not wired in renderer** | Medium | Architecture | `useChat.ts:64` TODO — no IPC event populates usage. Python has fingerprint-cached `_session_usage_totals()`. |
| 5 | **RAG test coverage gap** | Medium | Testing | 6 Python test files (3,173 lines) of RAG edge cases unported. Especially: robustness, incremental indexing, chunker boundaries, embedder dispatch. |
| 6 | **Streaming message test gap** | Medium | Testing | Python's largest test file (3,284 lines) covering stream event sequencing, error propagation, chunk handling has no Electron equivalent. |
| 7 | **Background commands & PTY test gap** | Medium | Testing | 5 Python test files (1,859 lines) covering PTY lifecycle, background store, prompt assembly unported. |
| 8 | **Model picker with auto-discovery** | Medium | Tools/Commands | Python's `/model` shows tabular display with token counts, vision support, and auto-discovery. Electron version is a stub. |
| 9 | **MCP tool schema fidelity** | Medium | MCP | Passthrough Zod discards JSON Schema detail that the LLM needs to understand tool parameters. |
| 10 | **Chain/state persistence in agents** | Medium | Agents | No `to_storage_dict`/`from_storage_dict` for subagent records. Sessions lose subagent history on restart. |

### Quick Wins (Low effort, high value)

| # | Item | Dimension |
|---|---|---|
| 1 | Wire token usage IPC event to renderer | Architecture |
| 2 | Add `file_pattern` parameter to `rag_search` | Tools |
| 3 | Add `flush_state_callbacks()` to `interrupt_subagents` | Tools |
| 4 | Add indexing concurrency guard to `/index-rag` and `/index-ast` | Commands |
| 5 | Add persistent file logging (`~/.orchid/logs/orchid.log`) | Architecture |
| 6 | Port `InputModal` for session rename | UI |
| 7 | Add working directory display to sidebar | UI |
| 8 | Add stream termination diagnostics | LLM |
