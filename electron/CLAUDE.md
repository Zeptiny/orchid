# CLAUDE.md — Orchid Electron

This is the Electron desktop client for Orchid, an AI-powered coding assistant.

## Project Overview

Orchid is a cross-platform (macOS, Windows, Linux) desktop application built with Electron 33 + React 19 + TypeScript 5.7. It provides an agentic chat interface where an LLM can read/edit files, execute commands, search code, and delegate to subagents — all via MCP-compatible tools.

The Electron application is Orchid's sole runtime. Its main-process architecture keeps the domain boundaries established during the retired Python prototype, while all maintained implementation lives under this directory.

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
│   │   ├── subagent-runner.ts        # Run subagent turns against project runtime
│   │   ├── wire-subagents.ts         # Wire subagent lifecycle into manager
│   │   ├── persist-subagent-chains.ts # Persist subagent chain messages
│   │   ├── defaults/        # Built-in agent definitions
│   │   └── xstate/          # XState machines
│   │       ├── agent-machine.ts      # Core agent loop (idle→streaming→toolExec→idle)
│   │       ├── events.ts             # Agent machine event types
│   │       └── interrupt-machine.ts  # Two-phase Esc cancellation
│   ├── llm/                 # LLM integration
│   │   ├── orchestrator.ts  # streamChat() — async generator yielding StreamEvents
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
│   ├── providers/           # Typed provider connections, drivers, and accounting
│   │   ├── index.ts         # ProviderRuntime — resolve typed selection + freeze request snapshot
│   │   ├── resolver.ts      # Resolve {connectionId, modelId} against connections/catalog
│   │   ├── connection-store.ts # Non-secret connection metadata
│   │   ├── drivers/         # Code-owned origins, auth, protocols, adapters, status parsing
│   │   ├── credentials/     # Encrypted vault for API-key secrets
│   │   ├── catalog/         # Signed bundled/cached catalog and updater
│   │   ├── status/          # Provider status cache/service
│   │   └── accounting/      # Append-only attempt ledger and cost calculation
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
│   │   ├── chat-history.ts  # chat history helpers
│   │   ├── config.ts        # config:get, config:save
│   │   ├── session.ts       # session CRUD / workspace bind
│   │   ├── session-activity.ts # session activity events
│   │   ├── session-working-set.ts # working-set IPC
│   │   ├── tool.ts          # tool:execute
│   │   ├── definitions.ts   # agents/skills/personalities listing
│   │   ├── providers.ts     # provider connection CRUD / models / status
│   │   ├── mcp.ts           # mcp:status
│   │   ├── rag.ts           # rag:status, rag:index, rag:clear
│   │   └── ast.ts           # ast:status, ast:index
│   ├── config/              # Configuration system
│   │   ├── schema.ts        # Zod schemas — single source of truth for config fields
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
│   │   ├── runtime.ts       # ProjectRuntime — config + agents/skills/personalities overlays
│   │   └── personality.ts   # project personality helpers
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
│   ├── logging.ts           # FileLogger — ~/.orchid/logs/orchid.log
│   ├── updater.ts           # Auto-update via electron-updater (events: updater:status_update, updater:progress, updater:error)
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
    ├── commands.ts          # Shared command types + fuzzy-match utilities (definitions live in renderer)
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
- Each main-agent and subagent turn builds a registry from its frozen project runtime; the process singleton remains only for non-turn compatibility surfaces
- Built-in tools: filesystem, search, process, AST, RAG, todo, web, skill, MCP, subagent
- MCP tools are merged from the leased project-owned `MCPManager` at stream time; leases keep superseded managers alive until their turns finish
- Tool output offloading: large outputs stored in session files, summary sent to LLM
- **`ToolExecutionContext`**: frozen `{ cwd, sessionId? }` captured at turn start; every tool handler receives it (never re-reads live session/process.cwd mid-turn)
- **`tool:execute` IPC**: allowlisted read-only tools only; args validated via `toolRegistry.validate` before the handler

### Workspace / Session Cwd
- Each `Session` has `cwd: string | null` (absolute project dir; null = unbound / legacy)
- Resolution order: draft cwd → active `session.cwd` → sticky `default_project_dir` → unbound
- `resolveWindowWorkspace(windowId)` (session IPC) and pure `resolveWorkspaceFromParts` (project/) — never `process.cwd()` as product default
- Intentional rebind (pick/set/change_cwd) aborts in-flight chat and reloads project config layers

### LLM Provider Resolution
- Model identity is always a typed `{ connectionId, modelId }`; slash-delimited model IDs remain opaque and are never parsed as provider aliases
- Connections store non-secret provider/auth/protocol metadata in `~/.orchid/providers.json`; secrets stay behind opaque handles in the encrypted credential vault
- `ProviderRuntime.resolveExecution()` resolves one catalog snapshot, validates the credential binding, constructs the code-owned driver adapter, and freezes accounting/provenance for the request
- Remote catalogs may describe models and pricing but cannot supply executable modules, origins, auth rules, headers, or credential routing
- Generic OpenAI- and Anthropic-compatible connections are explicit custom-endpoint drivers; specialized drivers own their origins in code

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

### Config Schema
Defined in `src/main/config/schema.ts` — single source of truth:

| Field | Default | Description |
|-------|---------|-------------|
| `default_model` | `null` | Default typed `{connectionId, modelId}` selection |
| `tier_models` | `{seed, sprout, bloom, crown}: null` | Optional typed selection per agent tier; delegated turns inherit their parent selection |
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
| `mcp_servers` | `{}` | MCP server configs (recommended servers opt-in during onboarding) |
| `has_completed_onboarding` | `false` | First-run wizard completed/skipped; existing installs missing the key load as `true` |
| `providers` | `{}` | Deprecated compatibility field; must remain empty because connections live in their own store |
| `llm_stream_idle_timeout` | 300s | Stream idle timeout |
| `llm_stream_retries` | 3 | LLM retry count |
| `background_command_idle_timeout` | 900s | Background cmd timeout |
| `default_project_dir` | `null` | Sticky absolute project dir for new sessions / draft workspace |

### Config Locations
- User config: `~/.orchid/config.json`
- Project config: `.orchid.json` (in project root)
- Provider connections (non-secret): `~/.orchid/providers.json`
- Merged: defaults → home → project → env overrides (deep-merged)

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
- **Tailwind CSS 4** utility classes for layout

### Styling — UI primitive standardization

The renderer uses a **primitives-as-API, DaisyUI-as-engine** model. Full contract in `src/renderer/styles/README.md`; enforced by `tests/integration/renderer-style-contract.test.ts`.

**Primitive-first rule.** Feature JSX (anything outside `src/renderer/components/ui/`) must not name DaisyUI component roots (`btn`, `input`, `select`, `alert`, `badge`, `card`, `tabs`, `modal`, `loading`, `checkbox`, `dropdown`, etc.) directly in `className` strings. Use a primitive from `components/ui/` instead. If a matching primitive doesn't exist, create one. New files start at zero baseline — the drift scanner rejects any new DaisyUI root in a file not already in the baseline.

**No class-string variables outside `ui/`.** className values in feature files must be inline string literals or template literals in the JSX — never hoisted to a module-scope `const`. If you want to DRY up a repeated className, extract a primitive or an `orchid-*` composite, not a local constant. The drift scanner only inspects `className=` attribute values; hoisted constants bypass it.

**Extend the primitive, don't override via className.** If you need a new visual variant, add it to the primitive's variant type and `Record<Union, string>` class map. Don't write `variant="ghost" className="text-error hover:bg-error/10"` — that creates two sources of truth for one control's visual semantics. className on a primitive is for layout utilities only (`flex`, `gap-2`, `w-full`, `mt-3`).

**chat.css is dead.** It is header-only (10 lines, no CSS rules). Any new CSS rule belongs in `components.css` `@layer components` (for product composites) or `markdown.css` (for markdown rendering). The growth guard fails on any increase.

**components.css growth.** components.css is at ~1,789 lines. Prefer splitting by surface area (onboarding, config, session, chat) if it crosses ~2,000 lines. Avoid adding new rules when a primitive or Tailwind utility can express the same result.

**Baseline trimming protocol.** Every PR that migrates call sites must trim the corresponding `BASELINE_DAISYUI_HITS` entries in the contract test. Stale entries mask real regressions. The total-token-count check (baseline 65) catches same-root growth within baselined files.

**Non-token colors.** Do not introduce raw `oklch(...)`, `#hex`, `rgb(...)`, or `hsl(...)` in `styles/*.css` or feature `className` strings. Only `index.css` `:root` fallback tokens and `themes/*.css` may use raw color values. The remaining 6 `#000` `color-mix()` fallbacks in components.css should trend to zero.

**CSS cascade awareness.** Rules in `@layer components` are weaker than unlayered rules of equal specificity. When moving CSS into `@layer components`, verify that DaisyUI's own component-layer rules don't win over the migrated rules. If they do, increase specificity (e.g., a parent selector) or scope out the DaisyUI rule.

**Visual smoke per migration batch.** The contract tests are source-level grep — they verify class strings exist in files, not that rendered output looks right. After every batch of primitive migrations, run the app across all 5 themes and visually confirm at minimum: buttons, alerts, inputs, tabs, cards, badges.

**New primitive checklist.** Every new `.tsx` file in `components/ui/` must: (1) export a typed component with `PascalCase` name, (2) use `Record<Union, string>` class maps for variants (not inline ternaries), (3) apply `.trim().replace(/\s+/g, ' ')` on className templates, (4) include a JSDoc docstring, (5) use `forwardRef` for interactive elements (button, input, select), (6) pass the "primitive purity" test (no domain imports). Add unit tests in `tests/unit/renderer-ui-primitives.test.ts` using the existing `renderToStaticMarkup` pattern.

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
- Contract tests: `tests/parity/` — protect the migrated tool, agent, skill, command, and configuration inventories
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
| Provider resolution / drivers | `src/main/providers/index.ts`, `src/main/providers/resolver.ts`, `src/main/providers/drivers/` |
| Provider IPC / shared contracts | `src/main/ipc/providers.ts`, `src/shared/types/provider.ts`, `src/shared/types/ipc.ts` |
| Middleware | `src/main/llm/middleware/` |

## Security Considerations

- Never expose Node.js APIs to renderer
- All IPC channels are allowlisted — new channels must be added to both `ALLOWED_INVOKE_CHANNELS` and `ALLOWED_EVENT_CHANNELS`
- API keys never cross into the renderer except as a one-shot write-only submission; encrypted vault handles or explicitly named environment variables bind credentials to connection, driver, auth method, and origin
- `contextIsolation: true` and `sandbox: true` enforced in BrowserWindow
- Tool execution runs in main process with timeout guards
- RAG/AST indexes use SQLite (no network access for local embeddings)
