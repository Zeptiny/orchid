# CLAUDE.md — Orchid Electron

This is the Electron desktop client for Orchid, an AI-powered coding assistant.

## Project Overview

Orchid is a cross-platform (macOS, Windows, Linux) desktop application built with Electron 33 + React 19 + TypeScript 5.7. It provides an agentic chat interface where an LLM can read/edit files, execute commands, search code, and delegate to subagents — all via MCP-compatible tools.

The project was ported from a Python codebase (`src/orchid/`) and mirrors its architecture.

## Tech Stack

- **Runtime**: Electron 33 (Chromium)
- **Main process**: TypeScript → CommonJS (compiled via `tsc -p tsconfig.node.json`)
- **Preload**: TypeScript → CommonJS (built via `scripts/build-preload.js` / esbuild)
- **Renderer**: React 19 + TypeScript → bundled by Vite 6
- **Styling**: Tailwind CSS 4 + DaisyUI 5
- **State machines**: XState 5 (agent orchestration)
- **AI SDK**: Vercel AI SDK 7 (`ai` package) with `@ai-sdk/openai`, `@ai-sdk/openai-compatible`
- **Validation**: Zod 3 (all IPC payloads, config, tool inputs)
- **Testing**: Vitest 3 (unit + integration + parity tests)
- **Linting**: ESLint 9 + typescript-eslint

## Directory Structure

```
src/
├── main/                    # Electron main process
│   ├── index.ts             # App entry — window creation, lifecycle, shutdown
│   ├── agents/              # Agent definitions and state machines
│   │   ├── registry.ts      # Load agent YAML/JSON from ~/.orchid/agents/
│   │   ├── manager.ts       # SubagentManager — spawn/wait/interrupt subagents
│   │   ├── defaults/        # Built-in agent definitions
│   │   └── xstate/          # XState machines
│   │       ├── agent-machine.ts      # Core agent loop (idle→streaming→toolExec→idle)
│   │       ├── subagent-machine.ts   # Subagent lifecycle
│   │       ├── session-machine.ts    # Session-level orchestration
│   │       └── interrupt-machine.ts  # Two-phase Esc cancellation
│   ├── llm/                 # LLM integration
│   │   ├── orchestrator.ts  # streamChat() — async generator yielding StreamEvents
│   │   ├── providers.ts     # resolveModelRef() — alias/model → AI SDK provider
│   │   ├── providers-factory.ts  # createProviderModel() — instantiate AI SDK models
│   │   ├── system-prompt.ts # buildSystemPrompt() — dynamic context injection
│   │   ├── history.ts       # toApiMessages() — Message[] → AI SDK CoreMessage[]
│   │   ├── tool-dispatch.ts # executeToolCall() — timeout + output offloading
│   │   ├── model-metadata.ts # Per-model token limits and capabilities
│   │   ├── cleanup.ts       # Stream cleanup utilities
│   │   └── middleware/      # AI SDK middleware stack
│   │       ├── index.ts     # createMiddlewareStack() — retry + quirks + throttle
│   │       ├── retry.ts     # Exponential backoff retry
│   │       ├── throttle.ts  # Yield rate-limiting
│   │       ├── provider-quirks.ts  # Provider-specific edge case handling
│   │       └── error-classification.ts  # Error types and classification
│   ├── tools/               # Tool registry and built-in tools
│   │   ├── index.ts         # registerBuiltinTools() — singleton registry setup
│   │   ├── registry.ts      # ToolRegistry class — register/filter/validate/toJsonSchema
│   │   ├── types.ts         # ToolDefinition, ToolHandler, RegisteredTool
│   │   ├── filesystem/      # read, edit, write, read-directory, glob
│   │   ├── search/          # grep (ripgrep-style)
│   │   ├── process/         # execute-command, read-output, send-input, terminate
│   │   ├── ast/             # find-symbol-references, get-file-skeleton, get-function, rename/replace-symbol
│   │   ├── rag/             # rag-search, rag-index
│   │   ├── todo/            # create, update, list, delete
│   │   ├── web/             # fetch
│   │   ├── skill/           # skill loader
│   │   ├── mcp/             # MCP resource reader
│   │   └── subagent/        # delegate, wait, interrupt
│   ├── ipc/                 # IPC handlers (main process side)
│   │   ├── index.ts         # registerAllIPC() / unregisterAllIPC()
│   │   ├── chat.ts          # chat:send, chat:cancel — main agentic loop entry
│   │   ├── config.ts        # config:get, config:save
│   │   ├── session.ts       # session CRUD
│   │   ├── tool.ts          # tool:execute
│   │   ├── agent.ts         # agent:list, agent:spawn
│   │   ├── mcp.ts           # mcp:status
│   │   ├── rag.ts           # rag:status, rag:index, rag:clear
│   │   ├── ast.ts           # ast:status, ast:index
│   │   └── updater.ts       # updater:check, updater:install
│   ├── config/              # Configuration system
│   │   ├── schema.ts        # Zod schemas — single source of truth for 22 config fields
│   │   ├── loader.ts        # ensureHomeConfig(), ConfigManager — ~/.orchid/ management
│   │   ├── merge.ts         # Deep merge for project + user configs
│   │   ├── validation.ts    # Config validation utilities
│   │   └── keychain.ts      # OS keychain integration for API keys
│   ├── session/             # Session persistence
│   │   ├── index.ts         # Session initialization
│   │   ├── manager.ts       # SessionManager — CRUD, auto-naming
│   │   └── storage.ts       # JSON file storage in ~/.orchid/sessions/
│   ├── project/             # Workspace binding (session cwd / sticky default)
│   │   ├── path.ts          # inspect/canonicalize absolute project directories
│   │   ├── workspace.ts     # draft cwd, sticky default_project_dir, resolveWorkspace*
│   │   ├── layers.ts        # apply project .orchid.json + agents/skills overlays
│   │   └── index.ts         # public re-exports
│   ├── mcp/                 # Model Context Protocol client
│   │   ├── index.ts         # MCPManager export
│   │   ├── manager.ts       # MCPManager — start/stop/call/list tools
│   │   ├── schema.ts        # MCPServerConfig types
│   │   └── transport.ts     # StdioClientTransport wrapper
│   ├── rag/                 # Retrieval-Augmented Generation
│   │   ├── chunker.ts       # Text chunking with overlap
│   │   ├── embedder.ts      # ONNX-based local embedding (fastembed)
│   │   ├── indexer.ts       # File indexing pipeline
│   │   └── store.ts         # SQLite-backed vector store
│   ├── ast/                 # Abstract Syntax Tree indexing
│   │   ├── indexer.ts       # Tree-sitter based code indexing
│   │   ├── parser.ts        # Tree-sitter parser management
│   │   └── store.ts         # SQLite-backed symbol store
│   ├── skills/              # Skill system
│   │   ├── registry.ts      # loadSkills() from ~/.orchid/skills/
│   │   └── defaults/        # Built-in skills
│   ├── commands/            # Command registry
│   │   └── registry.ts      # Slash commands (/settings, /clear, etc.)
│   ├── logging.ts           # FileLogger — ~/.orchid/logs/orchid.log
│   ├── updater.ts           # Auto-update via electron-updater
│   └── utils/
│       └── esm-import.ts    # importESM() — dynamic ESM import for CJS context
├── preload/
│   └── index.ts             # contextBridge API — window.orchid.* surface
├── renderer/                # React UI (Vite-bundled)
│   ├── App.tsx              # Root — theme provider + ChatView + Preferences + Onboarding
│   ├── main.tsx             # ReactDOM.createRoot entry
│   ├── index.html           # HTML shell
│   ├── components/
│   │   ├── ChatView.tsx     # Main layout — ChatStream + InputArea + Footer + Sidebar
│   │   ├── ChatStream.tsx   # Message list with auto-scroll
│   │   ├── InputArea.tsx    # Text input + send button
│   │   ├── Footer.tsx       # Model name + token usage + elapsed time
│   │   ├── Sidebar.tsx      # Sessions, Subagents, Todos, MCP, Index, Context, Usage
│   │   ├── MessageWidget.tsx # Individual message rendering
│   │   ├── MarkdownContent.tsx # Markdown rendering
│   │   ├── CommandPalette.tsx # Cmd+K command palette
│   │   ├── ContextGrid.tsx  # Context window usage visualization
│   │   ├── ConfigView.tsx   # Full-screen configuration UI
│   │   ├── ToolWidgets/     # Tool call/result UI widgets
│   │   ├── Preferences/     # Settings tab panels (used by ConfigView)
│   │   └── Onboarding/      # First-run setup wizard
│   ├── hooks/
│   │   ├── useChat.ts       # Chat state machine (messages, streaming, send/cancel)
│   │   ├── useSession.ts    # Session CRUD operations
│   │   ├── useSubagents.ts  # Subagent list/detail polling
│   │   ├── useTodos.ts      # Todo list state
│   │   ├── useToolRail.ts   # Tool call activity rail
│   │   └── useLiveCommandOutput.ts # Background command output streaming
│   ├── commands/
│   │   └── registry.ts      # Client-side slash commands
│   ├── themes/              # CSS theme files
│   │   ├── index.ts         # Theme registry and applyTheme()
│   │   ├── default.css      # Dark theme (default)
│   │   ├── bluey.css
│   │   ├── green-terminal.css
│   │   ├── solarized-light.css
│   │   └── windows-xp.css
│   └── styles/
│       ├── index.css        # Global styles + Tailwind imports
│       └── chat.css         # Chat-specific styles
└── shared/                  # Shared types between main/preload/renderer
    ├── types/
    │   ├── ipc.ts           # IPC channel names, message types, OrchidAPI interface
    │   ├── ipc-boundary.ts  # Config, Session, Model, MCP types shared across boundary
    │   ├── message.ts       # Message, Usage, MessageRole, MessageType
    │   ├── session.ts       # Session, Chain, SessionSummary
    │   ├── agent.ts         # Agent definition type
    │   ├── skill.ts         # Skill definition type
    │   ├── tool.ts          # ToolCall type
    │   ├── subagent.ts      # Subagent types
    │   ├── todo.ts          # TodoItem, TodoStatus
    │   ├── chain.ts         # Chain (conversation thread) types
    │   └── index.ts         # Barrel re-exports
    ├── commands.ts          # Shared command definitions
    └── utils/
        └── frontmatter.ts   # YAML frontmatter parser for agent/skill files
```

## Build & Development

```bash
# Development (starts Vite dev server + Electron)
npm run dev

# Build main process (TypeScript → CommonJS)
npm run build:main

# Build renderer (Vite bundle)
npm run build:renderer

# Full build
npm run build

# Type-check (no emit)
npm run typecheck

# Lint
npm run lint

# Run tests
npm run test

# Package for distribution
npm run package        # All platforms
npm run package:mac
npm run package:win
npm run package:linux
```

**Dev server**: Vite runs on `localhost:5173` (strict port). Electron loads this URL in dev mode.

**Build pipeline**:
1. `tsc -p tsconfig.node.json` → `dist/main/` + `dist/preload/` + `dist/shared/` (CJS)
2. `node scripts/build-preload.js` → preload bundle (esbuild, CJS)
3. `vite build` → `dist/renderer/` (bundled HTML/JS/CSS)

## Key Architecture Patterns

### IPC Security Model
- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
- Preload exposes `window.orchid` via `contextBridge.exposeInMainWorld`
- Strict channel allowlists: `ALLOWED_INVOKE_CHANNELS` and `ALLOWED_EVENT_CHANNELS`
- All payloads validated with Zod at the main-process boundary

### Agent Loop (XState)
The core agent loop is an XState 5 machine (`agent-machine.ts`):
```
idle → [USER_INPUT] → streaming → [TOOL_CALL] → toolExecuting → [TOOL_RESULT] → streaming → [STREAM_END] → idle
```
- `streaming` uses `fromCallback` to drive the LLM async generator
- `toolExecuting` uses `fromPromise` for tool execution
- `interrupted` state with auto-reset timeout for two-phase Esc cancellation

### Tool System
- Tools are Zod-validated definitions + async handlers
- `ToolRegistry` singleton: register, filter by glob patterns, validate args, generate JSON Schema
- Built-in tools: filesystem, search, process, AST, RAG, todo, web, skill, MCP, subagent
- MCP tools are merged from `MCPManager` at stream time
- Tool output offloading: large outputs stored in session files, summary sent to LLM
- **`ToolExecutionContext`**: frozen `{ cwd, sessionId? }` captured at turn start; every tool handler receives it (never re-reads live session/process.cwd mid-turn)
- **`tool:execute` IPC**: allowlisted read-only tools only; args validated via `toolRegistry.validate` before the handler

### Workspace / Session Cwd
- Each `Session` has `cwd: string | null` (absolute project dir; null = unbound / legacy)
- Resolution order: draft cwd → active `session.cwd` → sticky `default_project_dir` → unbound
- `resolveWindowWorkspace(windowId)` (session IPC) and pure `resolveWorkspaceFromParts` (project/) — never `process.cwd()` as product default
- Intentional rebind (pick/set/change_cwd) aborts in-flight chat and reloads project config layers

### LLM Provider Resolution
- Config format: `alias/model` (e.g., `default/mimo-v2.5`, `openai/gpt-4o`)
- Provider inference from explicit field, `litellm_provider`, or URL pattern matching
- Supports: OpenAI, Anthropic, Google/Gemini, Groq, xAI, and any OpenAI-compatible endpoint
- API key resolution: literal `api_key` → env var via `api_key_env` → AI SDK default

### Middleware Stack
Applied via `wrapLanguageModel()`:
1. **Retry** (outermost) — exponential backoff for transient errors
2. **Provider quirks** — handles empty choices, mid-stream errors
3. **Throttle** — rate-limits thinking content yields

### RAG Pipeline
- ONNX-based local embeddings (`fastembed/BAAI/bge-small-en-v1.5`)
- SQLite vector store with cosine similarity search
- Configurable chunk size (default: 2000) and overlap (default: 200)
- Semantic search via `rag_search` tool

### AST Indexing
- Tree-sitter based code analysis
- Symbol extraction, reference finding, file skeleton generation
- SQLite-backed symbol store

### Session Persistence
- JSON files in `~/.orchid/sessions/`
- Sessions contain chains (conversation threads) with message history
- Each session persists `cwd` (absolute project directory or null)
- Auto-naming: seed-tier model generates titles from first exchange

## Configuration

### Config Schema (23 fields)
Defined in `src/main/config/schema.ts` — single source of truth:

| Field | Default | Description |
|-------|---------|-------------|
| `default_model` | `default/mimo-v2.5` | Default `alias/model` |
| `tier_models` | `{seed, sprout, bloom, crown}: mimo-v2.5` | Model per agent tier |
| `ignored_dirs` | `.git, node_modules, dist, ...` | Directories to skip |
| `command_timeout` | 30s | Tool execution timeout |
| `read_line_limit` | 1000 | Max lines for file read |
| `grep_max_results` | 100 | Max grep matches |
| `directory_tree_depth` | 2 | read_directory depth |
| `theme` | `default` | UI theme name |
| `personality` | `default` | Agent personality preset |
| `rag.chunk_size` | 2000 | RAG chunk size |
| `rag.chunk_overlap` | 200 | RAG overlap |
| `rag.top_k` | 5 | RAG result count |
| `rag.max_file_size` | 512000 | Max file size for RAG |
| `rag.embedding_model` | `fastembed/BAAI/bge-small-en-v1.5` | Embedding model |
| `ast_max_file_size` | 1MB | Max file for AST indexing |
| `mcp_startup_timeout` | 60s | MCP server startup timeout |
| `mcp_per_server_timeout` | 10s | Per-MCP-server timeout |
| `mcp_servers` | `{context7: ...}` | MCP server configs |
| `providers` | `{default: opencode.ai}` | Provider aliases |
| `llm_stream_idle_timeout` | 300s | Stream idle timeout |
| `llm_stream_retries` | 3 | LLM retry count |
| `background_command_idle_timeout` | 900s | Background cmd timeout |
| `default_project_dir` | `null` | Sticky absolute project dir for new sessions / draft workspace |

### Config Locations
- User config: `~/.orchid/config.json`
- Project config: `.orchid/config.json` (in project root)
- Merged: project overrides user, deep-merged

## Coding Conventions

### TypeScript
- **Strict mode** enabled
- **ESNext** target for renderer, **CommonJS** for main/preload (Electron requirement)
- **Path alias**: `@shared/*` → `src/shared/*`
- **No barrel imports** for deeply nested modules — prefer direct imports
- **Zod validation** at all IPC boundaries (preload → main)
- **ESM dynamic imports** in main process: `importESM()` wrapper for `ai` package (ESM-only in CJS context)

### React
- **Functional components** only (no class components)
- **Hooks** for state management (no Redux/Zustand)
- **DaisyUI** classes for styling (no inline styles, no CSS modules)
- **Tailwind CSS 4** utility classes

### Naming
- **Files**: `kebab-case.ts` / `kebab-case.tsx`
- **Types/Interfaces**: `PascalCase`
- **Functions**: `camelCase`
- **Constants**: `UPPER_SNAKE_CASE` for true constants, `camelCase` for config values
- **IPC channels**: `namespace:action` (e.g., `chat:send`, `config:get`)
- **Zod schemas**: `camelCase` + `Schema` suffix (e.g., `chatSendSchema`, `configSchema`)

### Error Handling
- All IPC handlers validate with Zod and throw descriptive errors
- Tool execution catches and returns `{ content: string, isError: boolean }`
- Stream errors classified by type (timeout, rate limit, auth, generic)
- Non-fatal errors logged but don't crash the app
- Graceful shutdown: `before-quit` event → cleanup MCP, IPC, config, logging

### Testing
- **Vitest** with `tests/**/*.test.ts` pattern
- Unit tests: `tests/unit/` — individual modules
- Integration tests: `tests/integration/` — component/UI flows
- Parity tests: `tests/parity/` — verify TS matches Python behavior
- Mock `window.orchid` for renderer tests
- Use `vi.mock()` for module mocking

### File Conventions
- **Docstrings**: JSDoc `/** */` on exports, not on every internal function
- **No comments** in code unless explaining non-obvious logic
- **Section headers**: `// ── Section Name ──────` with Unicode box-drawing chars
- **Imports**: grouped (external, internal, types) with blank line separators

## Key Files for Common Tasks

| Task | Files |
|------|-------|
| Add a new tool | `src/main/tools/registry.ts`, `src/main/tools/index.ts`, new file in `src/main/tools/<category>/` |
| Add IPC channel | `src/shared/types/ipc.ts` (channels + types), `src/main/ipc/<module>.ts`, `src/preload/index.ts` |
| Modify chat flow | `src/main/ipc/chat.ts`, `src/main/agents/xstate/agent-machine.ts`, `src/renderer/hooks/useChat.ts` |
| Change config | `src/main/config/schema.ts`, `src/main/config/loader.ts`, `src/shared/types/ipc-boundary.ts` |
| Workspace / session cwd | `src/main/project/*`, `src/main/ipc/session.ts`, `src/shared/types/session.ts` |
| Add React component | `src/renderer/components/`, import in parent |
| Modify themes | `src/renderer/themes/`, CSS files + `index.ts` |
| Agent definitions | `src/main/agents/defaults/` (YAML/JSON), `src/main/agents/registry.ts` |
| MCP integration | `src/main/mcp/manager.ts`, `src/main/mcp/transport.ts` |
| LLM provider changes | `src/main/llm/providers.ts`, `src/main/llm/providers-factory.ts` |
| Middleware | `src/main/llm/middleware/` |

## Security Considerations

- Never expose Node.js APIs to renderer
- All IPC channels are allowlisted — new channels must be added to both `ALLOWED_INVOKE_CHANNELS` and `ALLOWED_EVENT_CHANNELS`
- API keys stored via OS keychain when possible, env vars as fallback
- `contextIsolation: true` and `sandbox: true` enforced in BrowserWindow
- Tool execution runs in main process with timeout guards
- RAG/AST indexes use SQLite (no network access for local embeddings)
