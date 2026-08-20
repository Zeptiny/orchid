# AGENTS.md — Orchid Electron

This is the Electron desktop client for Orchid, an AI-powered coding assistant.

## Project Overview

Orchid is a cross-platform (macOS, Windows, Linux) desktop application built with Electron 43 + React 19 + TypeScript 6. It provides an agentic chat interface where an LLM can read/edit files, execute commands, search code, and delegate to subagents — all via MCP-compatible tools.

The Electron application is Orchid's sole runtime. Its main-process architecture keeps the domain boundaries established during the retired Python prototype, while all maintained implementation lives under `electron/`.

## Repository Layout

The repo root holds documentation, design artifacts, and tooling caches. **The Electron application itself lives in `electron/`** — its own `package.json`, `src/`, `tests/`, `scripts/`, and TypeScript configs are all under that directory.

The repository-root path `docs/solutions/` is the searchable knowledge store for documented bugs, practices, and workflow patterns. Entries are organized by category with YAML frontmatter such as `module`, `tags`, and `problem_type`, and are relevant when implementing, debugging, or making decisions in documented areas.

The repository-root file `CONCEPTS.md` defines the project's shared domain vocabulary and is relevant when orienting to the codebase or discussing named entities, processes, and status concepts.

> **Path convention:** The explicitly identified repository-root paths above are exceptions. Unless otherwise stated, every other path in this document is relative to the Electron app root (`electron/`). For example, `src/main/index.ts` means `electron/src/main/index.ts`, and the `npm run …` commands below run from `electron/`.

## Tech Stack

- **Runtime**: Electron 43 (Chromium); Node engine `>=24.15.0 <25`
- **Main process**: TypeScript → CommonJS (compiled via `tsc -p tsconfig.node.json`)
- **Preload**: TypeScript → CommonJS (built via `scripts/build-preload.js` / esbuild)
- **Renderer**: React 19 + TypeScript → bundled by Vite 8
- **Styling**: Tailwind CSS 4 + Orchid primitive engine (`src/renderer/styles/primitives.css`)
- **State machines**: XState 5 (agent orchestration)
- **AI SDK**: Vercel AI SDK 7 (`ai` package) with `@ai-sdk/openai`, `@ai-sdk/openai-compatible`, `@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/xai`
- **Validation**: Zod 3 (all IPC payloads, config, tool inputs)
- **Testing**: Vitest 4 (unit + integration + parity + smoke tests)
- **Linting**: ESLint 10 + typescript-eslint

## Directory Structure

```
electron/
├── src/
│   ├── main/                    # Electron main process
│   │   ├── index.ts             # App entry — window creation, lifecycle, shutdown
│   │   ├── startup.ts           # Startup snapshot store (phases: starting|ready|degraded|failed)
│   │   ├── startup-lifecycle.ts # runStartupLifecycle() — sequential startup steps
│   │   ├── agents/              # Agent definitions and subagent orchestration
│   │   │   ├── registry.ts      # Load agent definitions (~/.orchid/agents/ + seeded built-ins)
│   │   │   ├── defaults/        # Built-in agent definitions (subdirs with marker files)
│   │   │   ├── manager.ts       # SubagentManager — spawn/wait/interrupt subagents
│   │   │   ├── admission.ts     # Global/per-session admission limits + queue
│   │   │   ├── errors.ts        # Subagent error taxonomy
│   │   │   ├── types.ts         # Shared subagent types
│   │   │   ├── subagent-compaction.ts     # Subagent compaction prepare/apply + pause contracts
│   │   │   ├── subagent-compaction-controller.ts # Per-run compaction controller (gates, pause, overflow retry)
│   │   │   ├── subagent-runner.ts         # Run subagent turns against project runtime
│   │   │   ├── subagent-run.ts            # Single run lifecycle
│   │   │   ├── subagent-run-assembler.ts  # Assemble run context (prompt, tools, model)
│   │   │   ├── subagent-events.ts         # Live event batching knobs
│   │   │   ├── subagent-live-projection.ts # Live renderer projection of subagent streams
│   │   │   ├── subagent-persistence.ts    # Persist subagent chains (terminal wave batching)
│   │   │   ├── subagent-persistence-recovery.ts # Recover chains after crash/restart
│   │   │   ├── persist-subagent-chains.ts # Persist subagent chain messages
│   │   │   ├── wire-subagents.ts          # Wire subagent lifecycle into manager
│   │   │   └── xstate/          # XState machines
│   │   │       ├── agent-machine.ts      # Core agent loop (idle→streaming→toolExec→idle)
│   │   │       ├── events.ts             # Agent machine event types
│   │   │       └── interrupt-machine.ts  # Two-phase Esc cancellation
│   │   ├── agents-md/           # AGENTS.md discovery, injection, and write enforcement
│   │   │   ├── resolver.ts      # Governing-chain resolver (walk up to workspace root)
│   │   │   ├── config.ts        # Defaults + alias normalization
│   │   │   ├── inject.ts        # Read-path injection builder
│   │   │   └── enforce.ts       # Write-path enforcement evaluator
│   │   ├── permissions/         # Tool permission gate + approval flow
│   │   │   ├── gate.ts          # checkPermission() — fail-closed pre-handler gate
│   │   │   ├── resolver.ts      # Mode resolution: tool-default < project-config < session override
│   │   │   ├── evaluator.ts     # `decide-for-me` LLM evaluator (permission-evaluator agent)
│   │   │   ├── detection/       # Command risk detection engine
│   │   │   │   ├── engine.ts    # Shell-segment analysis, expansion/redirection flags
│   │   │   │   ├── packs/filesystem.ts # Destructive/safe filesystem patterns
│   │   │   │   └── packs/git.ts # Destructive/safe git patterns
│   │   │   ├── approval-store.ts    # Pending approvals, timeouts, owner-window routing
│   │   │   ├── session-overrides.ts # Per-session + pre-session draft permission modes
│   │   │   └── history.ts       # Recent tool-call history (in-memory, per session+scope)
│   │   ├── llm/                 # LLM integration
│   │   │   ├── orchestrator.ts  # streamChat() — async generator yielding StreamEvents
│   │   │   ├── stream/          # Per-attempt stream plumbing
│   │   │   │   ├── events.ts            # StreamEvent union (thinking/content/tool_*/usage/…)
│   │   │   │   ├── sdk-event-adapter.ts # Normalize AI SDK parts → StreamEvent
│   │   │   │   ├── attempt-controller.ts # Idle watchdog + combined abort signals
│   │   │   │   ├── eager-tool-bridge.ts # Feed streamed tool input into EagerToolExecutor
│   │   │   │   └── normalized-stream.ts # Unify fullStream/textStream + step-finish drain
│   │   │   ├── system-prompt.ts # buildSystemPrompt() — dynamic context injection
│   │   │   ├── build-prompt-context.ts # Assemble dynamic per-turn prompt context
│   │   │   ├── context-snapshot.ts     # Frozen per-turn context snapshot
│   │   │   ├── history.ts       # toApiMessages() — Message[] → AI SDK CoreMessage[]
│   │   │   ├── model-messages.ts # toModelMessages() — ApiMessage[] → ModelMessage[]
│   │   │   ├── message-factories.ts    # Build AI SDK message objects
│   │   │   ├── response-unwrap.ts      # Unwrap provider response shapes
│   │   │   ├── reasoning-effort.ts     # Resolve per-turn reasoning effort (session/tier/connection)
│   │   │   ├── tool-dispatch.ts # executeToolCall() — permission gate + timeout + output offloading
│   │   │   ├── eager-tool-executor.ts # EagerToolExecutor — start tools as their input streams
│   │   │   ├── tool-pool.ts     # Tool worker pool singleton (offloadable read-only tools)
│   │   │   ├── terminal-result.ts # Canonical error/cancelled tool results without a handler
│   │   │   ├── compaction/      # Session/subagent compaction engine (shared by both scopes)
│   │   │   │   ├── pipeline.ts  # Scope-parameterized gate pipeline
│   │   │   │   ├── pending-store.ts # Scope-keyed pending compactions + re-validation
│   │   │   │   ├── apply.ts     # buildCompactionApply/buildSelectiveCompactionApply (never-delete settle)
│   │   │   │   ├── message-chars.ts # Char estimation shared by gates/estimates
│   │   │   │   ├── reclaim.ts   # Mechanical reclaim estimates + re-arm line
│   │   │   │   ├── run-attempt.ts # Selective run orchestration (shared by both scopes)
│   │   │   │   ├── select.ts    # Cut selection (compactable range, preserved window)
│   │   │   │   ├── summarize.ts # Simple-mode summarizer LLM call
│   │   │   │   ├── trigger.ts   # Threshold/hysteresis/floor + prepare/apply trigger engine
│   │   │   │   └── selective/   # Selective mode (manifest, run loop, validation)
│   │   │   └── middleware/      # AI SDK middleware stack
│   │   │       ├── index.ts     # createMiddlewareStack() — retry (+accounting) + throttle
│   │   │       ├── retry.ts     # Exponential backoff retry
│   │   │       ├── throttle.ts  # Yield rate-limiting
│   │   │       ├── provider-quirks.ts  # Tool-output offload thresholds (constants)
│   │   │       └── error-classification.ts  # Error types and classification
│   │   ├── providers/           # Typed provider connections, drivers, and accounting
│   │   │   ├── index.ts         # ProviderRuntime — resolve typed selection + freeze request snapshot
│   │   │   ├── resolver.ts      # Resolve {connectionId, modelId} against connections/catalog
│   │   │   ├── connection-store.ts # Non-secret connection metadata
│   │   │   ├── runtime-context.ts  # Per-request provider runtime context
│   │   │   ├── drivers/         # Code-owned origins, auth, protocols, adapters, status parsing
│   │   │   │   ├── registry.ts  # Driver registry (origin → driver)
│   │   │   │   ├── native.ts    # Specialized provider drivers (owned origins)
│   │   │   │   ├── compatible.ts # OpenAI-/Anthropic-compatible custom endpoints
│   │   │   │   ├── lilac.ts / neuralwatt.ts / opencode-go.ts # Third-party drivers
│   │   │   │   └── types.ts     # Driver interfaces
│   │   │   ├── credentials/     # Encrypted vault for API-key secrets (vault.ts)
│   │   │   ├── catalog/         # Signed bundled/cached catalog, trust pinning, updater
│   │   │   ├── status/          # Provider status cache/service
│   │   │   └── accounting/      # SQLite attempt ledger + cost + analytics queries
│   │   │       ├── store.ts     # provider_attempts insert/finalize (fail-closed singleton)
│   │   │       ├── schema.ts    # Ledger tables (attempts, tool attempts, context snapshots, attribution)
│   │   │       ├── cost.ts      # Cost calculation (reported header → token/energy formula)
│   │   │       ├── middleware.ts # Attempt accounting middleware (between retry and throttle)
│   │   │       ├── tool-attempt-store.ts # Tool invocation telemetry
│   │   │       ├── subagent-attribution-store.ts # Subagent chain attribution
│   │   │       ├── context-snapshot-store.ts # Per-turn context window snapshots
│   │   │       └── analytics-queries.ts # Read-model queries backing the Analytics view
│   │   ├── tools/               # Tool registry and built-in tools
│   │   │   ├── index.ts         # registerBuiltinTools() — singleton registry setup
│   │   │   ├── registry.ts      # ToolRegistry class — register/filter/validate/toJsonSchema
│   │   │   ├── types.ts         # ToolDefinition, ToolHandler, RegisteredTool
│   │   │   ├── result.ts        # Tool result envelope helpers (AgentProjector)
│   │   │   ├── result-retrieval.ts # Retrieve offloaded tool results
│   │   │   ├── glob-pattern.ts  # Shared glob matching helper
│   │   │   ├── tool-worker.ts   # Worker-thread entry for offloadable tools
│   │   │   ├── worker-registry.ts # Registry of tools allowed to run in workers
│   │   │   ├── filesystem/      # read, edit, write, read-directory, glob, apply-patch
│   │   │   ├── search/          # grep (ripgrep-style)
│   │   │   ├── process/         # execute-command, read-output, send-input, terminate
│   │   │   │                    # + background-store.ts / foreground-live.ts / head-tail-buffer.ts
│   │   │   ├── ast/             # find-symbol-references, get-file-skeleton, get-function,
│   │   │   │                    # rename-symbol, replace-symbol, index-tool (+ workers)
│   │   │   ├── rag/             # rag-search, rag-index
│   │   │   ├── todo/            # create, update, list, delete
│   │   │   ├── web/             # fetch
│   │   │   ├── skill/           # skill loader
│   │   │   ├── mcp/             # MCP resource reader + resource listing
│   │   │   ├── ask-question/    # ask_question tool + QuestionStore (agent→user questions)
│   │   │   └── subagent/        # delegate, wait, interrupt, answer, close, follow-up, hydrate
│   │   ├── ipc/                 # IPC handlers (main process side)
│   │   │   ├── index.ts         # registerAllIPC() / unregisterAllIPC()
│   │   │   ├── payload-schemas.ts # Zod schemas for IPC payloads
│   │   │   ├── chat.ts          # Facade: chat:send/snapshot/stop/cancel/queue_next + bgcmd:*
│   │   │   ├── chat/            # Agentic loop internals
│   │   │   │   ├── send.ts      # startChatTurn — session single-flight, actors, event flush
│   │   │   │   ├── stream.ts    # createProviderStreamFn — freezes runtime snapshot per turn
│   │   │   │   ├── events.ts    # Sequenced turn/session event broadcast
│   │   │   │   ├── state.ts     # ActiveAgent registry (messages, tool calls, generations)
│   │   │   │   ├── snapshot.ts  # Live chat snapshot builder
│   │   │   │   ├── persist.ts   # Debounced checkpoints + turn persistence
│   │   │   │   ├── abort.ts     # Force-abort / dispose paths
│   │   │   │   ├── session.ts   # ensureActiveSession (workspace resolve + trust gate)
│   │   │   │   └── title.ts     # Auto-naming via internal session-namer
│   │   │   ├── next-request-stop.ts # Stop the next request at the next step boundary
│   │   │   ├── chat-history.ts  # chat history helpers
│   │   │   ├── config.ts        # config:get, config:save
│   │   │   ├── permission.ts    # Approval IPC + session permission mode
│   │   │   ├── ask-question.ts  # ask_question IPC (asked/answered/settled)
│   │   │   ├── trust.ts         # Trusted-project grant/revoke IPC
│   │   │   ├── startup.ts       # Startup snapshot IPC (startup:snapshot/changed/continueDegraded)
│   │   │   ├── analytics.ts     # Analytics read-model IPC (analytics:*)
│   │   │   ├── session.ts       # session CRUD / workspace bind / trust revocation
│   │   │   ├── session-activity.ts # session activity events
│   │   │   ├── session-working-set.ts # working-set IPC
│   │   │   ├── tool.ts          # tool:execute
│   │   │   ├── definitions.ts   # agents/skills/personalities listing
│   │   │   ├── subagents.ts     # subagent listing / detail IPC
│   │   │   ├── providers.ts     # provider connection CRUD / models / status
│   │   │   ├── mcp.ts           # mcp:status
│   │   │   ├── rag.ts           # rag:status, rag:index, rag:clear
│   │   │   └── ast.ts           # ast:status, ast:index
│   │   ├── config/              # Configuration system
│   │   │   ├── schema.ts        # Zod schemas — single source of truth for config fields
│   │   │   ├── index.ts         # Public config surface
│   │   │   ├── loader.ts        # ensureHomeConfig(), ConfigManager — ~/.orchid/ management
│   │   │   ├── merge.ts         # Deep merge for project + user configs
│   │   │   ├── validation.ts    # Config validation utilities
│   │   │   └── write-lock.ts    # Config write serialization
│   │   ├── session/             # Session persistence (SQLite)
│   │   │   ├── manager.ts       # SessionManager — CRUD, auto-naming
│   │   │   ├── db.ts            # ~/.orchid/sessions.db connection (WAL, corruption recovery)
│   │   │   ├── schema.ts        # sessions/chains/subagent_chains schema v2
│   │   │   ├── storage.ts       # Persistence operations against the session DB
│   │   │   ├── singleton.ts     # getSessionManager() + resolveWindowWorkspace
│   │   │   ├── draft-reasoning.ts # Pre-session reasoning-effort drafts (per window)
│   │   │   ├── activity.ts      # Session activity tracking
│   │   │   ├── agents-md-context.ts # Per-session AGENTS.md context tracker (in-memory)
│   │   │   └── working-set.ts   # Session working-set (open tabs) tracking
│   │   ├── project/             # Workspace binding (session cwd / sticky default)
│   │   │   ├── path.ts          # inspect/canonicalize absolute project directories
│   │   │   ├── workspace.ts     # draft cwd, sticky default_project_dir, resolveWorkspace*
│   │   │   ├── runtime.ts       # ProjectRuntime — config + agents/skills/personalities overlays
│   │   │   ├── agents-md.ts     # Root AGENTS.md injection + subagent root seeding
│   │   │   ├── personality.ts   # project personality helpers
│   │   │   └── trust.ts         # Trusted-project store + fingerprint drift detection
│   │   ├── mcp/                 # Model Context Protocol client
│   │   │   ├── manager.ts       # MCPManager — start/stop/call/list tools
│   │   │   ├── project-registry.ts # Leased per-project managers (trust-gated, lease-counted)
│   │   │   ├── schema.ts        # MCPServerConfig types
│   │   │   └── transport.ts     # StdioClientTransport wrapper
│   │   ├── rag/                 # Retrieval-Augmented Generation
│   │   │   ├── chunker.ts       # Text chunking with overlap
│   │   │   ├── embedder.ts      # ONNX-based local embedding (fastembed) or API embedder
│   │   │   ├── indexer.ts       # File indexing pipeline
│   │   │   ├── index-worker.ts  # Worker-thread indexing
│   │   │   └── store.ts         # SQLite-backed vector store
│   │   ├── ast/                 # Abstract Syntax Tree indexing
│   │   │   ├── indexer.ts       # Tree-sitter based code indexing
│   │   │   ├── index-worker.ts  # Worker-thread indexing
│   │   │   ├── parser.ts        # Tree-sitter parser management
│   │   │   ├── queries/         # Tree-sitter query files (.scm, copied by copy-defaults)
│   │   │   └── store.ts         # SQLite-backed symbol store
│   │   ├── defs/                # Definition file management (agents/skills/personalities)
│   │   │   ├── manage.ts        # Create/update/delete definition files
│   │   │   ├── paths.ts         # Resolve definition storage paths
│   │   │   └── reload.ts        # Reload definitions on change
│   │   ├── personality/         # Personality system
│   │   │   ├── registry.ts      # loadPersonalities()
│   │   │   └── defaults/        # Built-in personalities
│   │   ├── skills/              # Skill system
│   │   │   ├── registry.ts      # loadSkills() from ~/.orchid/skills/ (built-ins seeded)
│   │   │   └── defaults/        # Built-in skills (subdirs with SKILL.md markers)
│   │   ├── logging.ts           # FileLogger — ~/.orchid/logs/orchid.log
│   │   ├── updater.ts           # Auto-update via electron-updater (events: updater:status_update, updater:progress, updater:error)
│   │   └── utils/               # Shared helpers
│   │       ├── esm-import.ts    # importESM() — dynamic ESM import for CJS context
│   │       ├── sqlite.ts        # Shared SQLite open/WAL/corruption-recovery helper
│   │       ├── worker-pool.ts   # Two-lane (main/subagent) worker pool
│   │       ├── write-lock.ts    # Generic write-lock helper
│   │       ├── seed-defaults.ts # Seed built-in definition subdirs into ~/.orchid/
│   │       ├── async.ts / safe-fsync.ts / with-disposable.ts
│   ├── preload/
│   │   └── index.ts             # contextBridge API — window.orchid.* surface
│   ├── renderer/                # React UI (Vite-bundled)
│   │   ├── App.tsx              # Root — startup gate; renders StartupScreen until phase=ready
│   │   ├── AppReady.tsx         # Post-startup shell — config load, views, onboarding
│   │   ├── main.tsx             # ReactDOM.createRoot entry
│   │   ├── index.html           # HTML shell
│   │   ├── components/
│   │   │   ├── ChatView.tsx     # Main layout — SessionTabBar + LeftSidebar + chat + inspector
│   │   │   ├── LeftSidebar.tsx  # Workspace chip, search, project-grouped session list
│   │   │   ├── Sidebar.tsx      # Right inspector — Todos, Subagents, Commands, Context, Usage,
│   │   │   │                    # Workspace Index, MCP Servers
│   │   │   ├── SessionTabBar.tsx # Open-session tab strip (working-set backed)
│   │   │   ├── ChatStream.tsx   # Message list with smart auto-scroll
│   │   │   ├── InputArea.tsx    # Text input + send button
│   │   │   ├── MessageQueue.tsx # Queued follow-up messages (next-request / chain-end)
│   │   │   ├── Footer.tsx       # Model name + token usage + elapsed time
│   │   │   ├── MessageWidget.tsx # Individual message rendering
│   │   │   ├── MarkdownContent.tsx # Markdown rendering
│   │   │   ├── CommandPalette.tsx # Cmd+K command palette
│   │   │   ├── SlashCommandMenu.tsx # Inline slash-command menu
│   │   │   ├── ShortcutsHelp.tsx # Keyboard shortcut reference
│   │   │   ├── ContextGrid.tsx  # Context window usage visualization
│   │   │   ├── ConfigView.tsx   # Full-screen configuration UI
│   │   │   ├── ProjectConfigView.tsx # Project-level config editor (.orchid.json)
│   │   │   ├── AnalyticsView.tsx # Usage/cost analytics (tabs: Overview, Sessions,
│   │   │   │                    # Models & Providers, Tools, Subagents, Context)
│   │   │   ├── StartupScreen.tsx # Startup progress phases/steps
│   │   │   ├── ModelPicker.tsx  # Connection/model selection
│   │   │   ├── ReasoningSelector.tsx # Per-session reasoning effort picker
│   │   │   ├── PermissionApprovalPanel.tsx # Pending tool-approval UI
│   │   │   ├── PermissionSelector.tsx # Session permission mode selector
│   │   │   ├── AskQuestionOverlay.tsx # Agent ask_question UI
│   │   │   ├── TrustProjectDialog.tsx # Trust grant surface-diff report
│   │   │   ├── SubagentView.tsx / SubagentTranscript.tsx # Subagent detail views
│   │   │   ├── ToolResults/     # Tool result widgets by family (+ registry)
│   │   │   ├── ToolWidgets/     # Tool call activity widgets (live command output)
│   │   │   ├── ui/              # Typed primitives (Button, TextInput, Select, Tabs, …)
│   │   │   ├── Preferences/     # Settings tab panels (used by ConfigView)
│   │   │   ├── Providers/       # Connection list/wizard/models/status
│   │   │   └── Onboarding/      # First-run setup wizard
│   │   ├── hooks/
│   │   │   ├── useChat.ts       # Chat state machine (projection, streaming, send/cancel)
│   │   │   ├── useSession.ts    # Session CRUD operations
│   │   │   ├── useSessionTabs.ts # Working-set backed session tabs
│   │   │   ├── useSessionActivity.ts # Session activity state
│   │   │   ├── useSubagents.ts  # Subagent list/detail polling
│   │   │   ├── useTodos.ts      # Todo list state
│   │   │   ├── useProviders.ts  # Provider connections/models state
│   │   │   ├── useAnalytics.ts  # Analytics query state + time range
│   │   │   ├── useMessageQueue.ts / useQueueAutoFire.ts # Message queue + auto-fire
│   │   │   ├── usePermissionApproval.ts # Approval request state
│   │   │   ├── useAskQuestion.ts # ask_question state
│   │   │   ├── useBackgroundCommands.ts # Background command fleet state
│   │   │   ├── useLiveCommandOutput.ts # Foreground/background command output streaming
│   │   │   ├── useSmartAutoScroll.ts # Viewport pinning with scroll-away suspension
│   │   │   ├── use-responsive-shell.ts # Panel collapse state by width
│   │   │   └── useTrustPrompt.ts / useTimeRange.ts
│   │   ├── keyboard/            # Shortcut subsystem
│   │   │   ├── registry.ts      # SHORTCUTS source of truth + formatting helpers
│   │   │   ├── match.ts         # Chord matching (mod/shift/alt, editable-target awareness)
│   │   │   ├── types.ts         # KeyChord / ShortcutDef
│   │   │   ├── useGlobalShortcuts.ts # Single window keydown dispatcher
│   │   │   ├── useFocusTrap.ts  # Modal focus trap (stacked)
│   │   │   └── useRovingListIndex.ts # Arrow-key list navigation
│   │   ├── commands/
│   │   │   └── registry.ts      # Client-side slash commands
│   │   ├── themes/              # CSS theme files
│   │   │   ├── index.ts         # Theme registry and applyTheme()
│   │   │   ├── default.css      # Dark theme (default)
│   │   │   ├── light.css
│   │   │   ├── bluey.css
│   │   │   ├── green-terminal.css
│   │   │   ├── solarized-light.css
│   │   │   └── windows-xp.css
│   │   ├── styles/
│   │   │   ├── index.css        # Canonical import order + Tailwind + design tokens
│   │   │   ├── primitives.css   # Orchid primitive engine (component roots, theme tokens)
│   │   │   ├── components.css   # orchid-* composites (@layer orchid) — base
│   │   │   ├── components-chat.css / components-session.css / components-config.css
│   │   │   │                    # Surface-area splits of the composite layer
│   │   │   ├── shell.css        # App shell geometry
│   │   │   ├── motion.css       # Shared motion vocabulary (orchid-* transitions)
│   │   │   ├── markdown.css     # Markdown rendering styles
│   │   │   ├── exceptions.css   # Scoped style exceptions
│   │   │   └── README.md        # Styling contract documentation
│   │   └── utils/               # Presentation/state helpers (config drafts, grouping,
│   │                            # provider selection, stream building, subagent stream, …)
│   └── shared/                  # Shared types between main/preload/renderer
│       ├── types/
│       │   ├── ipc.ts           # IPC channel names, message types, OrchidAPI interface
│       │   ├── ipc-boundary.ts  # Config, Session, Model, MCP types shared across boundary
│       │   ├── ipc-schemas.ts   # Zod schemas for IPC payloads
│       │   ├── message.ts       # Message, Usage, MessageRole, MessageType
│       │   ├── session.ts       # Session, SessionSummary
│       │   ├── chain.ts         # Chain (conversation thread) types
│       │   ├── agent.ts         # Agent definition type
│       │   ├── agent-scope.ts   # Agent scope identity (main vs subagent)
│       │   ├── skill.ts         # Skill definition type
│       │   ├── tool.ts          # ToolCall type
│       │   ├── tool-result.ts   # Canonical tool result envelope types
│       │   ├── tool-result-filesystem.ts / tool-result-apply-patch.ts
│       │   ├── subagent.ts      # Subagent types
│       │   ├── todo.ts          # TodoItem, TodoStatus
│       │   ├── permission.ts    # Permission modes + risk classes
│       │   ├── provider.ts      # ModelSelection + provider connection types
│       │   ├── accounting.ts    # Attempt ledger types
│       │   ├── analytics.ts     # Analytics read-model types
│       │   ├── compaction-progress.ts # Compaction widget progress event types
│       │   └── definitions.ts   # Definition (agent/skill/personality) types
│       ├── chat/
│       │   └── turn-projection.ts # Pure reducer: IPC turn events → renderer projection
│       ├── mcp/
│       │   └── recommended-servers.ts # Recommended MCP servers (onboarding opt-in)
│       ├── serialization/
│       │   └── chain-subagent.ts # Chain/subagent serialization helpers
│       ├── commands.ts          # Shared command types + fuzzy-match utilities (definitions live in renderer)
│       ├── usage.ts             # Usage accounting helpers
│       └── utils/
│           └── frontmatter.ts   # YAML frontmatter parser for agent/skill files
├── tests/
├── scripts/
├── package.json
├── tsconfig.json
├── tsconfig.node.json
├── tsconfig.migration.json
├── vite.config.ts
├── eslint.config.mjs
├── electron-builder.yml
└── README.md
```

## Build & Development

All commands run from the `electron/` directory.

```bash
# Development (compiles main, builds preload, starts Vite + Electron)
npm run dev

# Renderer-only dev server (Vite, no Electron)
npm run dev:renderer

# Build main process (TypeScript → CommonJS) + copy default definitions
npm run build:main

# Build renderer (Vite bundle)
npm run build:renderer

# Full build (main + defaults + preload + renderer)
npm run build

# Type-check (no emit)
npm run typecheck
npm run typecheck:migration   # migration tsconfig

# Lint
npm run lint

# Runtime dependency cycle check
npm run check:runtime-cycles

# Run tests
npm run test

# Live provider smoke test (requires credentials)
npm run test:providers:live

# Provider catalog tooling
npm run catalog:seed       # Seed dev model catalog
npm run catalog:validate   # Validate catalog
npm run catalog:sign       # Sign catalog

# Native module rebuild (better-sqlite3, node-pty, onnxruntime)
npm run rebuild:native

# Package for distribution (build + native rebuild + electron-builder)
npm run package        # Current platform
npm run package:mac
npm run package:win
npm run package:linux
npm run package:all    # mac + win + linux
```

**Dev server**: Vite runs on `localhost:5173` (strict port). Electron loads this URL in dev mode.

**Build pipeline** (`npm run build`):
1. `tsc -p tsconfig.node.json` → `dist/main/` + `dist/preload/` + `dist/shared/` (CJS)
2. `node scripts/copy-defaults.js` → copy built-in agent/skill/personality definitions and AST query files into `dist/`
3. `node scripts/build-preload.js` → preload bundle (esbuild, CJS)
4. `vite build` → `dist/renderer/` (bundled HTML/JS/CSS)

Packaging additionally runs `scripts/ensure-native-runtime.mjs` to rebuild native modules against Electron's Node ABI before `electron-builder`.

## Key Architecture Patterns

### Startup lifecycle
- `main/startup.ts` holds a revisioned `StartupSnapshot` with phases `starting|ready|degraded|failed` and steps `opening_window`, `settings_providers`, `agents_tools`, `tool_workers`, `preparing_interface` (each `pending|active|complete|skipped|warning|failed`).
- `main/startup-lifecycle.ts` runs steps sequentially (`activate → yieldForPresentation → work → complete`); tool-worker pool unavailability degrades to `warning`, never blocks startup.
- IPC: `startup:snapshot`, `startup:continueDegraded`, event `startup:changed`. The renderer shows `StartupScreen` until phase `ready`, then mounts `AppReady` (config load, theme, onboarding gate).

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

### Stream pipeline (per attempt)
`orchestrator.ts:streamChat()` builds the system prompt + core messages (`model-messages.ts`), wraps the model with the middleware stack, then per attempt wires: `EagerToolExecutor → EagerToolBridge → StreamAttemptController → NormalizedStream(SdkEventAdapter)` around AI SDK `streamText`.
- `stream/attempt-controller.ts` owns the idle watchdog (`llm_stream_idle_timeout`) and combines user/idle abort signals; fresh instance per retry.
- `stream/eager-tool-bridge.ts` accumulates streamed `tool-input-*` deltas and launches eager execution exactly once per tool call.
- `stream/normalized-stream.ts` prefers `fullStream`, falls back to `textStream` + `onStepFinish` when `fullStream` errors without user abort/idle.
- `stream/sdk-event-adapter.ts` normalizes AI SDK parts into the `StreamEvent` union (`stream/events.ts`) and builds provider-safe MCP tool aliases.
- `ipc/next-request-stop.ts`: `chat:queue_next` arms a per-session stop that ends the current `maxSteps` loop at the next step boundary (`shouldStopNextRequest` feeds `stopWhen`).

### Tool System
- Tools are Zod-validated definitions + async handlers
- Each main-agent and subagent turn builds a registry from its frozen project runtime; the process singleton remains only for non-turn compatibility surfaces
- Built-in tool families: filesystem (incl. apply-patch), search, process, AST, RAG, todo, web, skill, MCP, ask-question, subagent
- MCP tools are merged from the leased project-owned `MCPManager` (`mcp/project-registry.ts`, lease-counted, trust-gated) at stream time; leases keep superseded managers alive until their turns finish
- **Eager execution** (`llm/eager-tool-executor.ts`, bridged by `llm/stream/eager-tool-bridge.ts`): a tool starts executing as soon as its input is streamed — reconstructed from `tool-input-start/delta/end` parts because the AI SDK defers `execute` to `model-call-end`. Every launch routes through the unchanged `executeToolCall`, so permission gating, AGENTS.md enforcement, timeouts, and output offloading apply identically; the SDK's deferred `execute` awaits the same memoized promise (exactly-once).
- **Worker pool** (`utils/worker-pool.ts` + `tools/tool-worker.ts`): offloadable read-only tools (`read`, `glob`, `grep`, `rag_search`, `get_file_skeleton`, `replace_symbol` — `tools/worker-registry.ts`) run in a `tool_worker_pool_size` worker pool. Two dispatch lanes reserve `tool_worker_pool_main_agent_reserved` slots for the main agent (configured 0 floors to 1; pool clamps to `[0, size-1]`) so neither lane can starve the other; `size <= 0` disables the pool and everything runs inline.
- Tool results pass through two layers before reaching the LLM:
  1. **Agent projection** (`result.ts`): each tool family has an `AgentProjector` that transforms canonical result data into the LLM-visible XML. Projectors must not truncate — they send full content and rely on the offloading layer for size control.
  2. **Output offloading** (`tool-dispatch.ts`): if the projected content exceeds `tool_output_inline_threshold` (config, default 20 KB) and the tool is not in `TOOLS_WITHOUT_OUTPUT_OFFLOAD` (`provider-quirks.ts`), the content is written to a per-session cache file and replaced with a compact pointer. When no session is active (e.g., subagent context), content is hard-truncated to the threshold with a warning instead.
  - `TOOLS_WITHOUT_OUTPUT_OFFLOAD` exempts self-limiting tools (read, grep, glob, etc.) whose projections already bound their output. Do not add projection-level truncation to individual tools — size control belongs in the offloading layer so behavior stays uniform across all tools.
- **`ToolExecutionContext`**: frozen `{ cwd, sessionId? }` captured at turn start; every tool handler receives it (never re-reads live session/process.cwd mid-turn)
- **`tool:execute` IPC**: allowlisted read-only tools only; args validated via `toolRegistry.validate` before the handler

### Permissions & Tool Approval
Every tool dispatch passes `permissions/gate.ts:checkPermission()` before the handler (`llm/tool-dispatch.ts`). The gate is fail-closed: an unclassified risk class yields a `permission_gate_error` denial.
- **Modes** (`shared/types/permission.ts`): `allow | ask | decide-for-me | ask-when-flagged`. A rule is either a mode or `{ inside, outside }` for workspace-scoped file tools.
- **Resolution order**: tool-default (`RISK_CLASS_DEFAULTS`/`FILE_TOOL_DEFAULTS`) < project config (`permissions: Record<tool, rule>`, supports `mcp::server::*` wildcards) < session override (`permissions/session-overrides.ts`, hydrated from the persisted session). `resolver.ts` applies a risk-class floor (`passRiskClassFloor`) so `allow` suppresses flag-driven asks.
- **`ask-when-flagged` policy** (`gate.ts`): `send_input`/MCP tools always ask; `execute_command` runs the detection engine; file tools ask only when the resolved path escapes the workspace (`resolver.ts:resolveToolScope`, symlink/canonical-safe); other execution/mutation risk classes always ask.
- **Detection engine** (`permissions/detection/`): splits shell segments on `;|&|()`, flags expansion/redirection metacharacters (`unsupported-shell-syntax`), flags interpreter `-c`/`-eval` execution, then applies packs: `packs/filesystem.ts` (destructive `rm -rf`, `find -delete/-exec`, `chmod/chown -R`, `truncate -s0`, `shred`, `mkfs`, `dd of=/dev/`; safe `/tmp`/cache removals) and `packs/git.ts` (destructive `reset --hard`, `push --force`, `branch -D`, `clean -f`, `stash drop/clear`; safe `--force-with-lease`, `checkout -b`, …).
- **`decide-for-me`** (`evaluator.ts`): an internal `permission-evaluator` tier-model call (30s timeout) receives tool/risk/args (≤2 KB)/cwd/triggering message + recent call history and returns `{"decision":"approve"|"deny"}`; anything else falls back to `ask`.
- **Approval flow** (`approval-store.ts` + `ipc/permission.ts`): `create()` emits `permission:approval_requested` only to the window owning the active main turn (`getActiveMainTurnWindowId`), awaits answer with `approval_timeout` (0 = infinite), and settles via `permission:approval_settled`. Undeliverable requests cancel the store entry and force-abort the main turn. Session-wide mode: `permission:set_session_mode` / `permission:get_session_mode`; per-scope config via `config:permission_scopes` / `config:save_permission_scope`.
- **History** (`history.ts`): in-memory per `sessionId::agentScope` tool-call history (args summarized ≤200 B, capped at 50 entries), fed to the evaluator and surfaced via `permission_history_size`.

### Agent Questions (ask_question)
`tools/ask-question/ask-question.ts` lets the agent pause its turn and ask the user single/multi-choice questions. Main-agent questions await via `QuestionStore` (events `question-asked`/`question-settled`, owner-window routing identical to approvals; undeliverable → cancel + force-abort). Subagent questions mark the scope question-pending in `SubagentManager`. IPC: `ask_question:snapshot`, `ask_question:answer`, `ask_question:cancel`; renderer overlay `AskQuestionOverlay.tsx`.

### Background Commands (visibility & user control)
- Background `execute_command` processes live in the in-memory `BackgroundProcessStore` (`tools/process/background-store.ts`): head-tail buffers, LRU cap, `owner: 'AGENT' | 'USER'`, and session/scope metadata. Foreground runs additionally mirror output into `ForegroundLiveRegistry` (`tools/process/foreground-live.ts`) keyed by `toolCallId`; the mirror is display-only — the bounded collector stays the canonical result authority.
- **User IPC surface** (`ipc/chat.ts` facade, preload `bgCmd`): `bgcmd:snapshot` accepts exactly one of `commandId` (background store) or `toolCallId` (foreground registry) and returns the tail plus `running/interactive/owner/command/description/agentScopeId` metadata; `bgcmd:list` returns the session's background fleet across all agent scopes (running-first, subagent display names joined from `SubagentManager`); `bgcmd:send_input`, `bgcmd:terminate`, and `bgcmd:release_input` are the user controls; `bgcmd:changed` push-broadcasts fleet changes. Every payload is Zod-validated and channel-allowlisted.
- **Session-privileged vs scope-gated**: user control handlers match `entry.sessionId` only, so users reach any agent scope in their session; agent tools (`send_input`, `terminate_command`, `read_output`) stay scope-gated via `getVisible`. Successful user input flips `owner` to `'USER'`, which makes the agent `send_input` reject (`control: USER`) until `bgcmd:release_input` or the `background_command_idle_timeout` auto-release.
- **Command kill matrix**:

| Trigger | Effect |
|---|---|
| User Stop (`bgcmd:terminate`) | Single command, any scope in the session |
| Subagent terminal transition | Owned scope's commands (`terminateScope`) |
| Esc phase 2 / `chat:stop` / rebind / trust revoke | All session commands (`terminateSession`) |
| LRU eviction at `max_background_processes` | Oldest evictable entries |
| App quit | `terminateAll` |

### AGENTS.md Context Handling
Instruction files (`AGENTS.md` and the configured `agents_md.filenames` aliases) are discovered and surfaced automatically — the agent never loads them manually.
- **Discovery** (`agents-md/resolver.ts`): for any touched path, walk up from its directory to the workspace root, taking the first matching alias per directory. Symlinks that escape the workspace are ignored and filenames match case-insensitively. The workspace-root file is the `root` tier; the rest are `nested`.
- **Root injection** (`project/agents-md.ts`, wired in `ipc/chat/send.ts` and `agents/subagent-runner.ts`): the root file is appended once to the static system instructions (after personality) and seeded into the per-session tracker, so it is never re-injected. Subagents get the root the same way.
- **Read-path injection** (`agents-md/inject.ts`, in `llm/tool-dispatch.ts`): single-path read tools (`read`, `read_directory`, `get_file_skeleton`, `get_function`, `find_symbol_references`) append the byte-capped content of every not-yet-seen governing file to their result as an `<agents_md>` block, then mark it seen. `grep`/`glob`/`rag_search` fan-out is deliberately skipped.
- **Write-path enforcement** (`agents-md/enforce.ts`, in `llm/tool-dispatch.ts`): the five file mutators (`edit`, `write`, `apply_patch`, `rename_symbol`, `replace_symbol`) are gated by `agents_md.enforce_on_write` — `block` denies the mutation until the governing files are read, `warn` appends a warning, `inject` appends the content and marks it seen, `off` disables. `apply_patch` reports every unseen file at once; editing an instruction file is exempt and refreshes its tracker entry.
- **Tracker** (`session/agents-md-context.ts`): an ephemeral, in-memory, per-session set of seen canonical paths, keyed by `sessionId::agentScope` so each subagent starts fresh (root only) rather than inheriting the parent's seen-set. With no session there is no injection/enforcement and never a block; the renderer `tool:execute` path opts out via `agentsMdDisabled`.

### Workspace / Session Cwd
- Each `Session` has `cwd: string | null` (absolute project dir; null = unbound / legacy)
- Resolution order: draft cwd → active `session.cwd` → sticky `default_project_dir` → unbound
- `resolveWindowWorkspace(windowId)` (`session/singleton.ts`) and pure `resolveWorkspaceFromParts` (project/) — never `process.cwd()` as product default
- Intentional rebind (pick/set/change_cwd) aborts in-flight chat and reloads project config layers

### Trusted Projects
Project-supplied content (`.orchid.json`, `.orchid/` definitions, root AGENTS.md aliases, MCP servers) only runs after the user grants trust. Bind-then-gate: binding any directory succeeds, and every execution path enforces trust.
- **Store** (`project/trust.ts`): `~/.orchid/trusted_projects.json`, keyed by canonical path. Trust state is `trusted | untrusted | changed`; a sha256 fingerprint over the security surface (`.orchid.json` + `.orchid/{agents,skills,personalities}` + root instruction files, size/count-capped) flips a grant to `changed` when it drifts. Bare projects (no surface) auto-trust without a store entry.
- **Resolution**: `resolveWorkspaceFromParts` attaches `trust` to every usable `WorkspaceInfo` (`status`/`isWorkspaceBound` unchanged). Trust is fail-closed — un-canonicalizable paths read `untrusted`.
- **Gate matrix** (while trust ≠ `trusted`): `chat:send` rejects `untrusted_project`; the MCP registry returns a dormant manager (no `startAll`); `tool:execute`, RAG/AST indexing, and `session:create` reject; `definitions:list` returns home-only. Subagent turns inherit the parent's captured runtime (no separate prompt).
- **Revocation** (`ipc/session.ts` `revokeProjectTrustForDir`, exposed via `ipc/trust.ts`): drops the record, invalidates the runtime registry + MCP managers (lease-aware), and force-stops sessions bound to the dir. Grant invalidates runtime/MCP caches so services pick up trust immediately.
- **Renderer**: `TrustProjectDialog` shows the surface-diff report; opened by bind results, `untrusted_project` send failures, and the workspace-chip badge — never auto-opened at startup. Settings → Trusted Projects lists/revokes entries.

### LLM Provider Resolution
- Model identity is always a typed `{ connectionId, modelId }`; slash-delimited model IDs remain opaque and are never parsed as provider aliases
- Connections store non-secret provider/auth/protocol metadata in `~/.orchid/providers.json`; secrets stay behind opaque handles in the encrypted credential vault (`providers/credentials/vault.ts`)
- `ProviderRuntime.resolveExecution()` resolves one catalog snapshot, validates the credential binding, constructs the code-owned driver adapter, and freezes accounting/provenance for the request
- Remote catalogs may describe models and pricing but cannot supply executable modules, origins, auth rules, headers, or credential routing
- Generic OpenAI- and Anthropic-compatible connections are explicit custom-endpoint drivers; specialized drivers own their origins in code

### Reasoning Effort
Controls provider reasoning/thinking budget for models that support it (`llm/reasoning-effort.ts`); value is a string level (e.g. `low|medium|high`) or a numeric token budget.
- **Main turn**: `session.reasoningEffortOverride` → connection `reasoningConfig[modelId].default` → unset.
- **Subagent turn**: agent `reasoning_effort` → config `tier_reasoning_effort[tier]` → connection default → unset.
- Pre-session drafts live in a per-window map (`session/draft-reasoning.ts`) and are taken on session promotion. Renderer: `ReasoningSelector.tsx` (footer, `null` = inherit) and `Preferences/TierModelsTab.tsx` (tier defaults).

### Middleware Stack
Applied via `wrapLanguageModel()`:
1. **Retry** (outermost) — exponential backoff for transient errors (`llm_retry_backoff_base`, `llm_retry_max_delay`)
2. **Accounting** (optional, between retry and throttle) — records the attempt in the ledger
3. **Throttle** — rate-limits thinking content yields
(Empty-choices handling is owned by the AI SDK; tool-output offload thresholds are config-driven via `tool_output_inline_threshold` with fallback defaults in `provider-quirks.ts`.)

### Accounting & Analytics
- **Ledger** (`providers/accounting/`): SQLite `~/.orchid/accounting.db` — `provider_attempts`, `tool_attempts`, `context_snapshots`, `subagent_attribution`. Each attempt freezes a `FrozenProviderRequestSnapshot` (provider/connection/model/pricing) and records outcome (`pending|succeeded|failed|interrupted`) + normalized usage; `insertPending()` before I/O, idempotent `finalize()`, crash recovery for pendings.
- **Cost** (`cost.ts`): prefers the `x-request-cost-usd` response header (`provider-reported`), else token/energy formulas from frozen pricing (`Decimal.js`); `unknown` when ambiguous. Billing estimates never influence recorded cost.
- **Analytics IPC** (`ipc/analytics.ts`): `analytics:overview`, `analytics:sessions`, `analytics:session_detail`, `analytics:models`, `analytics:tools`, `analytics:subagents`, `analytics:context` — all accept an optional Zod-validated `{startDate?, endDate?}` time range; queries in `analytics-queries.ts`.
- **Renderer**: `AnalyticsView.tsx` with tabs Overview (totals + time series + breakdowns), Sessions (per-session aggregates + detail), Models & Providers, Tools (invocations/durations/offload rate), Subagents (by name/type/tier), Context (token breakdown + top sessions). `TimeRangeSelector` provides preset + custom ranges (`useTimeRange`).

### RAG Pipeline
- ONNX-based local embeddings (`fastembed/BAAI/bge-small-en-v1.5`) or an optional API embedder bound to the chat connection (`rag.embedding_api_model`)
- SQLite vector store with cosine similarity search
- Configurable chunk size (default: 2000) and overlap (default: 200)
- Semantic search via `rag_search` tool; indexing runs in a worker (`index-worker.ts`)

### AST Indexing
- Tree-sitter based code analysis (queries in `ast/queries/`)
- Symbol extraction, reference finding, file skeleton generation
- SQLite-backed symbol store; indexing runs in a worker (`index-worker.ts`)

### Session Persistence
- SQLite database `~/.orchid/sessions.db` (WAL mode, foreign keys, `busy_timeout=5000`, corruption-recovery rebuild — `utils/sqlite.ts`)
- Schema v2 (`session/schema.ts`): `sessions`, `chains` (messages JSON per chain, FK CASCADE), `subagent_chains`, `schema_meta`; sessions also persist `reasoning_effort_override` and `permission_mode`
- `session/manager.ts` does CRUD + auto-naming; `session/singleton.ts` owns the lazy `getSessionManager()`
- Auto-naming: internal `session-namer` agent generates titles from first exchange (`ipc/chat/title.ts`, deadline `session_title_max_wait_seconds`)

### Renderer Shell
- **Layout** (`ChatView.tsx`): top `SessionTabBar`, left `LeftSidebar` (workspace chip + project-grouped sessions), center chat (`ChatStream` + `MessageQueue` + `InputArea` + `Footer`), right inspector `Sidebar` (collapsible Todos/Subagents/Commands/Context/Usage/Index/MCP blocks). Topology is frozen by the styling contract — restyle in place only (`styles/README.md`).
- **Turn projection**: `shared/chat/turn-projection.ts` is a pure reducer folding sequenced IPC `ChatTurnEvent`s into the renderer projection (segments, tool calls, usage) without materializing durable messages; `useChat.ts` consumes it.
- **Message queue** (`MessageQueue.tsx` + `useMessageQueue.ts`): ephemeral in-memory FIFO of `{trigger: 'next-request'|'chain-end'}` messages, editable/reorderable above the composer. `useQueueAutoFire.ts` fires the front batch when the turn goes idle (`next-request` messages call `chat:queue_next` during streaming to stop the current step loop at the next boundary).
- **Session tabs** (`SessionTabBar.tsx` + `useSessionTabs.ts`): backed by the main-process working set (`session-working-set.ts` IPC) — no localStorage; supports focus, close, inline rename, wheel scroll.
- **Keyboard** (`renderer/keyboard/`): `registry.ts` is the shortcut source of truth; `match.ts` handles chord matching with editable-target awareness; `useGlobalShortcuts.ts` dispatches; `useFocusTrap.ts`/`useRovingListIndex.ts` support overlays and lists.

## Configuration

### Config Schema
Defined in `src/main/config/schema.ts` — single source of truth (strict schema, deep-partial merge):

| Field | Default | Description |
|-------|---------|-------------|
| `default_model` | `null` | Default typed `{connectionId, modelId}` selection |
| `tier_models` | `{seed, sprout, bloom, crown}: null` | Optional typed selection per agent tier; delegated turns inherit their parent selection |
| `tier_reasoning_effort` | `{seed, sprout, bloom, crown}: null` | Optional reasoning effort (string level or int budget) per tier; `null` = inherit |
| `ignored_dirs` | `.git, node_modules, dist, …` | Directories to skip |
| `command_timeout` | 30s | Tool execution timeout |
| `read_line_limit` | 1000 | Max lines for file read |
| `grep_max_results` | 100 | Max grep matches |
| `grep_per_file_timeout` | 10s | Per-file grep timeout |
| `directory_tree_depth` | 2 | read_directory depth |
| `tool_worker_pool_size` | 2 | Worker count for offloadable tools (0 = pool disabled, max 8) |
| `tool_worker_pool_main_agent_reserved` | 1 | Worker slots reserved for main-agent tools so background subagents cannot starve the visible agent; configured 0 floors to 1, pool clamps to `[0, tool_worker_pool_size - 1]` |
| `theme` | `default` | UI theme name |
| `personality` | `default` | Agent personality preset |
| `rag.chunk_size` | 2000 | RAG chunk size |
| `rag.chunk_overlap` | 200 | RAG overlap |
| `rag.top_k` | 5 | RAG result count |
| `rag.max_file_size` | 512000 | Max file size for RAG |
| `rag.embedding_model` | `fastembed/BAAI/bge-small-en-v1.5` | Embedding model |
| `rag.embedding_threads` | 2 | ONNX embedding worker threads (1–64) |
| `rag.embedding_batch_size` | 16 | ONNX embedding batch size (1–256) |
| `rag.embedding_api_timeout` | 30s | API embedder request timeout |
| `rag.embedding_api_retries` | 3 | API embedder retry count (0–10) |
| `rag.model_download_inactivity_timeout` | 30s | Abort a stalled embedding-model download |
| `rag.model_download_total_timeout` | 900s | Hard cap for one model-file download |
| `rag.embedding_api_model` | `null` | Optional API embedder, bound to chat connection/model |
| `agents_md.enabled` | `true` | Master switch for AGENTS.md discovery, injection, and write enforcement |
| `agents_md.filenames` | `AGENTS.md, CLAUDE.md` | Ordered instruction-file aliases; first present per directory wins |
| `agents_md.max_file_bytes` | 32768 | Byte cap for injected instruction-file content (head + read pointer) |
| `agents_md.max_chain_depth` | 8 | Max directories walked upward when resolving the governing chain |
| `agents_md.enforce_on_write` | `warn` | Mutation policy for unseen governing files: `block` \| `inject` \| `warn` \| `off` |
| `agents_md.inject_on_read` | `true` | Inject unseen governing files into single-path read-tool results |
| `agents_md.include_local` | `false` | Also consider `AGENTS.local.md` (appended as the lowest-precedence alias) |
| `subagents.event_max_per_flush` | 200 | Max delta events delivered in one batched flush across all subagents |
| `subagents.event_byte_budget_kb` | 64 | Soft byte budget (KB) per batched flush; overflow non-terminal deltas defer to the next flush |
| `subagents.usage_event_interval_ms` | 1000 | Min interval between per-subagent `usage` deltas; 0 emits every usage event |
| `subagents.hydration_buffer_kb` | 256 | Renderer hydration event buffer cap (KB) before revision-floor reseed |
| `subagents.terminal_wave_ms` | 250 | Window batching near-simultaneous terminal persistence flushes |
| `subagents.max_active_global` | 8 | Max concurrently running subagents across all sessions |
| `subagents.max_active_per_session` | 4 | Max concurrently running subagents within one session |
| `subagents.max_queued` | 32 | Max queued (admitted-but-not-started) subagents before rejection |
| `subagents.terminal_retention` | 25 | Recent terminal summaries retained after runtime eviction |
| `subagents.prompt_recent_terminal` | 5 | Recent terminal summaries included in the dynamic system prompt |
| `subagents.prompt_task_max_chars` | 200 | Task-text cap (chars) for terminal summaries rendered into the prompt |
| `ast_max_file_size` | 1MB | Max file for AST indexing |
| `mcp_startup_timeout` | 60s | MCP server startup timeout |
| `mcp_per_server_timeout` | 10s | Per-MCP-server timeout |
| `mcp_servers` | `{}` | MCP server configs (recommended servers opt-in during onboarding) |
| `mcp_result_max_bytes` | 5MB | Max MCP tool-result payload |
| `llm_stream_idle_timeout` | 300s | Stream idle timeout |
| `llm_stream_retries` | 3 | LLM retry count |
| `llm_retry_backoff_base` | 0.2s | Retry exponential-backoff base delay |
| `llm_retry_max_delay` | 30s | Retry backoff cap |
| `background_command_idle_timeout` | 900s | Background cmd idle timeout / auto-release |
| `max_background_processes` | 64 | LRU cap for background commands |
| `bg_output_head_bytes` / `bg_output_tail_bytes` | 512KB each | Head/tail buffer caps per background command |
| `bg_prompt_max_entries` | 5 | Background-command entries injected into prompt |
| `bg_prompt_tail_lines` | 8 | Tail lines per prompt entry |
| `bg_prompt_tail_chars` | 500 | Tail char cap per prompt entry |
| `command_max_output_bytes` | 1MB | Max captured foreground command output |
| `read_output_long_poll_max` | 60s | Max long-poll wait for `read_output` |
| `tool_output_inline_threshold` | 20000 bytes | Inline/offload threshold for projected tool output |
| `approval_timeout` | 600s | Seconds before a pending tool approval auto-denies (0 = infinite) |
| `subagent_wait_timeout` | 300s | Max wait for `wait_for_subagent` |
| `web_fetch_timeout` | 30s | web fetch request timeout |
| `web_fetch_max_body_bytes` | 10MB | web fetch body cap |
| `web_fetch_user_agent` | `Orchid/1.0 web-fetch (Electron)` | web fetch User-Agent |
| `permissions` | `{}` | Per-tool permission rules: mode or `{inside, outside}`; supports `mcp::server::*` wildcards |
| `permission_history_size` | 10 | Recent tool calls (0–50) fed to the `decide-for-me` evaluator |
| `session_title_max_wait_seconds` | 15 | Max wait before auto-naming a default session from the still in-flight turn history; `0` disables the deadline (naming then only on turn complete/interrupt) |
| `max_tool_steps` | 100 | Max multi-step tool-loop iterations per stream (AI SDK `stopWhen`) |
| `always_expand_tool_groups` | `false` | Open chat tool-activity groups by default |
| `default_project_dir` | `null` | Sticky absolute project dir for new sessions / draft workspace |
| `has_completed_onboarding` | `false` | First-run wizard completed/skipped; existing installs missing the key load as `true` |

### Config Locations
- User config: `~/.orchid/config.json`
- Project config: `.orchid.json` (in project root)
- Provider connections (non-secret): `~/.orchid/providers.json`
- Trusted projects: `~/.orchid/trusted_projects.json` (canonical path → grant + fingerprint)
- Sessions: `~/.orchid/sessions.db` (SQLite, WAL)
- Accounting ledger: `~/.orchid/accounting.db` (SQLite)
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

The renderer uses a **primitives-as-API, primitives.css-as-engine** model (DaisyUI was removed; `styles/primitives.css` owns every component root and is driven entirely by theme tokens). Full contract in `src/renderer/styles/README.md`; enforced by `tests/integration/renderer-style-contract.test.ts`. Layout topology is frozen (left session nav, session tabs, chat/composer center, right inspector) — restyle in place only.

**Primitive-first rule.** Feature JSX (anything outside `src/renderer/components/ui/`) must not name component roots (`btn`, `input`, `select`, `alert`, `badge`, `card`, `tabs`, `modal`, `loading`, `checkbox`, `dropdown`, etc.) directly in `className` strings. Use a primitive from `components/ui/` instead. If a matching primitive doesn't exist, create one. New files start at zero baseline — the drift scanner rejects any new component root in a file not already in the baseline.

**No class-string variables outside `ui/`.** className values in feature files must be inline string literals or template literals in the JSX — never hoisted to a module-scope `const`. If you want to DRY up a repeated className, extract a primitive or an `orchid-*` composite, not a local constant. The drift scanner only inspects `className=` attribute values; hoisted constants bypass it.

**Extend the primitive, don't override via className.** If you need a new visual variant, add it to the primitive's variant type and `Record<Union, string>` class map. Don't write `variant="ghost" className="text-error hover:bg-error/10"` — that creates two sources of truth for one control's visual semantics. className on a primitive is for layout utilities only (`flex`, `gap-2`, `w-full`, `mt-3`).

**chat.css was deleted.** Do not reintroduce it — `tests/integration/app-shell.test.ts` asserts the file stays absent and un-imported. New CSS rules belong in the `orchid-*` composite layer: `components.css` (base composites, `@layer orchid`) or the matching surface split — `components-chat.css`, `components-session.css`, `components-config.css` — plus `motion.css` for shared state-transition behavior and `markdown.css` for markdown rendering.

**components.css splits.** The composite layer is split by surface area: `components.css` (base, ~1,020 lines), `components-chat.css` (~730), `components-config.css` (~430), `components-session.css` (~130). Add new rules to the file matching their surface; prefer a primitive or Tailwind utility when either can express the same result.

**Baseline trimming protocol.** Every PR that migrates call sites must trim the corresponding `BASELINE_COMPONENT_ROOT_HITS` entries in the contract test. Stale entries mask real regressions. The total-token-count check (baseline 66) catches same-root growth within baselined files.

**Non-token colors.** Do not introduce raw `oklch(...)`, `#hex`, `rgb(...)`, or `hsl(...)` in `styles/*.css` or feature `className` strings. Only `index.css` `:root` fallback tokens and `themes/*.css` may use raw color values. The non-token color baseline is zero — the contract test rejects any new occurrence.

**CSS cascade awareness.** Rules in `@layer orchid` are weaker than unlayered rules of equal specificity. When moving CSS into the composite layer, verify that the primitive engine's own component-layer rules don't win over the migrated rules. If they do, increase specificity (e.g., a parent selector) or scope out the engine rule.

**Visual smoke per migration batch.** The contract tests are source-level grep — they verify class strings exist in files, not that rendered output looks right. After every batch of primitive migrations, run the app across all 6 themes and visually confirm at minimum: buttons, alerts, inputs, tabs, cards, badges.

**New primitive checklist.** Every new `.tsx` file in `components/ui/` must: (1) export a typed component with a `PascalCase` name, (2) use `Record<Union, string>` class maps for variants (not inline ternaries), (3) apply `.trim().replace(/\s+/g, ' ')` on className templates, (4) include a JSDoc docstring, (5) use `forwardRef` for interactive elements (button, input, select), (6) pass the "primitive purity" test (no domain imports). Add unit tests in `tests/unit/renderer-ui-primitives.test.ts` using the existing `renderToStaticMarkup` pattern.

### Motion and state transitions

Motion is a shared interaction contract, not local decoration. Use it to explain continuity (panel resize, disclosure expansion, list insertion, view replacement) or confirm meaningful state changes (idle/running/confirm, send/queue/cancel, tool lifecycle, transient feedback).

- Use the theme-owned `--transition-fast`, `--transition-normal`, and `--transition-slow` tokens. Controls and chevrons use `fast`, status/popover/view entrances use `normal`, and shell geometry uses `slow`; do not introduce one-off duration/easing literals when a token fits.
- Reuse the `orchid-*` vocabulary in `styles/motion.css`. Stateful disclosures must use `CollapsibleRegion` so content remains mounted while height and opacity settle; the trigger continues to own `aria-expanded` and `aria-controls`.
- Prefer opacity and transform for frequent motion. Grid-track animation is approved for mounted disclosures, and width/grid-column animation is approved for the existing shell. Do not animate layout broadly.
- Key mutually exclusive status/action wrappers so their entrance motion replays when semantic state changes. Give inserted list items and mounted settings/onboarding/subagent views stable React keys.
- Never animate streaming text, live token or elapsed counters, terminal output, cursor updates, or high-frequency progress text. Progress geometry may transition through the primitive engine.
- Overlays and popovers use the shared fade/pop vocabulary. Avoid bespoke keyframes in feature stylesheets.
- Every motion path must remain usable under `prefers-reduced-motion`; the global exception rule short-circuits animations and transitions. New motion CSS must not bypass it.
- Validate motion changes with primitive/unit and source-contract tests (`tests/integration/renderer-motion-contract.test.ts`). Visual smoke remains required when browser inspection is allowed by the task.

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
- Integration tests: `tests/integration/` — component/UI flows + architecture contracts (style, motion, app-shell, provider, trust, accounting)
- Contract tests: `tests/parity/` — protect the migrated tool, agent, skill, command, session, and configuration inventories
- Smoke tests: `tests/smoke/` — live provider smoke (`npm run test:providers:live`)
- Fixtures: `tests/fixtures/` — shared test data
- Mock `window.orchid` for renderer tests
- Use `vi.mock()` for module mocking

### File Conventions
- **Docstrings**: JSDoc `/** */` on exports, not on every internal function
- **No comments** in code unless explaining non-obvious logic
- **Section headers**: `// ── Section Name ──────` with Unicode box-drawing chars
- **Imports**: grouped (external, internal, types) with blank line separators

## Key Files for Common Tasks

> **Note:** All paths in the table below are relative to the Electron app root (`electron/`). For example, `src/main/...` means `electron/src/main/...`.

| Task | Files |
|------|-------|
| Add a new tool | `src/main/tools/registry.ts`, `src/main/tools/index.ts`, new file in `src/main/tools/<category>/`; risk class + permission defaults in `src/shared/types/permission.ts` |
| Add IPC channel | `src/shared/types/ipc.ts` (channels + types), `src/main/ipc/<module>.ts`, `src/preload/index.ts` |
| Modify chat flow | `src/main/ipc/chat/send.ts`, `src/main/ipc/chat/stream.ts`, `src/main/agents/xstate/agent-machine.ts`, `src/renderer/hooks/useChat.ts` |
| Change config | `src/main/config/schema.ts`, `src/main/config/loader.ts`, `src/shared/types/ipc-boundary.ts` |
| Permission modes / approval UI | `src/main/permissions/` (gate/resolver/evaluator/detection), `src/main/ipc/permission.ts`, `src/renderer/components/PermissionApprovalPanel.tsx`, `src/shared/types/permission.ts` |
| Analytics | `src/main/ipc/analytics.ts`, `src/main/providers/accounting/analytics-queries.ts`, `src/renderer/components/AnalyticsView.tsx`, `src/shared/types/analytics.ts` |
| Reasoning effort | `src/main/llm/reasoning-effort.ts`, `src/renderer/components/ReasoningSelector.tsx`, `src/main/session/draft-reasoning.ts` |
| AGENTS.md context handling | `src/main/agents-md/` (resolver/inject/enforce/config), `src/main/session/agents-md-context.ts`, `src/main/project/agents-md.ts` |
| Workspace / session cwd | `src/main/project/*`, `src/main/ipc/session.ts`, `src/shared/types/session.ts` |
| Session persistence | `src/main/session/db.ts`, `src/main/session/schema.ts`, `src/main/session/storage.ts`, `src/main/session/manager.ts` |
| Add React component | `src/renderer/components/` (primitives in `components/ui/`), import in parent |
| Modify themes | `src/renderer/themes/`, CSS files + `index.ts` |
| Agent definitions | `src/main/agents/defaults/` (built-in subdirs), `src/main/agents/registry.ts`, seeded into `~/.orchid/agents/` |
| MCP integration | `src/main/mcp/manager.ts`, `src/main/mcp/project-registry.ts`, `src/main/mcp/transport.ts` |
| Provider resolution / drivers | `src/main/providers/index.ts`, `src/main/providers/resolver.ts`, `src/main/providers/drivers/` |
| Provider IPC / shared contracts | `src/main/ipc/providers.ts`, `src/shared/types/provider.ts`, `src/shared/types/ipc.ts` |
| Middleware | `src/main/llm/middleware/` |
| Shortcuts | `src/renderer/keyboard/registry.ts` (definitions), `useGlobalShortcuts.ts` (dispatch) |

## Security Considerations

- Never expose Node.js APIs to renderer
- All IPC channels are allowlisted — new channels must be added to both `ALLOWED_INVOKE_CHANNELS` and `ALLOWED_EVENT_CHANNELS`
- API keys never cross into the renderer except as a one-shot write-only submission; encrypted vault handles or explicitly named environment variables bind credentials to connection, driver, auth method, and origin
- `contextIsolation: true` and `sandbox: true` enforced in BrowserWindow
- Tool execution runs in main process with timeout guards and a fail-closed permission gate (`permissions/gate.ts`); approval requests are delivered only to the window owning the active main turn
- RAG/AST indexes use SQLite (no network access for local embeddings)

## Tool output contract

Agent-facing tool results use the convention documented below.

Every result is framed by one XML envelope:

```xml
<tool_result name="exact_tool_name" status="complete">
  <!-- tool-specific payload -->
</tool_result>
```

`status` is `complete`, `partial`, `empty`, `error`, or `cancelled`. XML is
the framing and metadata format; compact line-oriented text is preferred for
homogeneous lists. Use ordinary XML text and escape `&` and `<` as
`&amp;` and `&lt;`.

The compact result formats are:

- `edit`: `<old_string>`, `<new_string>`, `replace_all`, and replacement count.
  With `replace_all=false`, multiple matches are an error. With
  `replace_all=true`, every match is replaced and counted.
- `get_file_skeleton`: one `line | name | line_count` row per definition.
- `glob`: the query followed by one matching path per line.
- `grep`: the query followed by one `path | line | content` row per match.
  The first two separators are structural; the remainder is content.
- `read_directory`: an ASCII tree using `├──`, `└──`, `│`, and indentation.
  The tree starts immediately after the opening `<tree>` tag.
- `read`: one `line | content` row per source line. Do not trim, normalize,
  or re-indent the source content.
- `replace_symbol`: one `<replacement>` with `<old_string>` and
  `<new_string>` for each replaced definition.
- `send_input`: the exact input sent to stdin, including whitespace and
  newlines.

All other built-in and dynamic results still use the same XML envelope, with
tool-specific XML payloads or compact text blocks where repeating tags would
cost tokens. External or untrusted content must be escaped as text.

### MCP tool names

The `name` attribute is always the exact registered/internal tool name.
Built-in names are used as registered. MCP names use:

```text
mcp::<server_name>::<tool_name>
```

An MCP `ToolDefinition.name` is this internal name and must be present for
every dynamic tool. A provider-safe alias may be used only as the LLM
function-map key; never put that alias, `mcp`, `dynamic`, or a generic
placeholder in the result `name` attribute.
