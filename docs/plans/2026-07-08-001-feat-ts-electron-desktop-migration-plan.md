---
title: "feat: TypeScript/Electron Desktop App Migration"
type: feat
status: active
date: 2026-07-08
origin: docs/brainstorms/ts-electron-desktop-migration-requirements.md
---

# TypeScript/Electron Desktop App Migration

## Summary

Full migration of Orchid from a Python Textual TUI to a standalone TypeScript/Electron desktop app for public release on macOS, Windows, and Linux. The migration reimplements the engine in fresh TypeScript (Python as spec, not translation target), validates the foundation architecture with a thin end-to-end spike, then ports all 27 tools, the agent hierarchy, 15 skills, RAG, AST, MCP, config, sessions, personalities, themes, background commands, and the command palette to full capability parity. Native tool-call widgets (R21) and annotated-diff code review (R22) are included in Phase 1 as desktop-native differentiators. Agent graph (R19) and diff-gated approval / permission system (R20) are deferred to future planning cycles. A parity matrix and parity tests verify completeness and fidelity before declaring parity complete.

Companion documents:
- [Implementation Units](2026-07-08-001-feat-ts-electron-desktop-migration-plan-implementation-units.md) — all 29 implementation units with full detail
- [Parity Matrix](2026-07-08-001-feat-ts-electron-desktop-migration-plan-parity-matrix.md) — every tool/agent/skill/config field mapped to its TS port status

---

## Problem Frame

Orchid today is a Python Textual TUI whose delivery medium is limiting. The TUI cannot render diffs, images, interactive terminals, or structured tool-call cards. It cannot run detached with OS notifications. It has persistent bugs (single-core subagent parallelism, context-not-updating, input-buffer-stuck, auto-scroll) rooted in hand-rolled orchestration over a text-grid rendering model. Its 1175-line LLM client and 1211-line entangled `app.py` are maintenance liabilities.

The migration is not a port of the TUI to a GUI — it is a reimplementation that preserves Orchid's capabilities while adopting a delivery medium (Electron + React) and language ecosystem (TypeScript + Vercel AI SDK + XState + zod) that structurally eliminate the TUI's constraints and enable interface features the terminal fundamentally cannot offer.

See [origin document](../brainstorms/ts-electron-desktop-migration-requirements.md) for full problem frame, actors, key flows (F1-F4), and acceptance examples (AE1-AE7).

---

## Requirements

**Foundation patterns (baked in during the port)**

- R1. XState actors for agent orchestration; worker_threads for CPU-bound parallelism.
- R2. AI SDK composable middleware for streaming, retries, tool calling, error classification, throttling.
- R3. Zod schemas as single source of truth for tool input/output, IPC validation, TypeScript types, JSON Schema for MCP, and React rendering.

**Capability parity**

- R4. All 27 tools ported.
- R5. Hierarchical agent system (26 agents, 4 tiers, AGENT.md loading).
- R6. Skills system (15 skills, SKILL.md loading, dependencies, resources).
- R7. RAG pipeline (chunker, embeddings, vector store, search, auto re-index).
- R8. Config system (deep-merge, env overrides, 22 fields, native preferences window).
- R9. Session management (create/switch/rename/delete, persistence, auto-naming, restore).
- R10. MCP client (stdio + SSE, dynamic tool registration, lifecycle, `read_mcp_resource`).
- R11. Background command execution (detached processes, streaming output, interactive input, PTY, OS notifications).
- R12. Personalities (loading, PERSONALITY.md, system prompt injection).
- R13. Themes (CSS-based, 5 defaults, live switching).
- R14. Command palette (Cmd+K, fuzzy search, 12 slash commands).
- R15. AST tools (tree-sitter, symbol index, 5 tools, language set from `ast/queries/`).

**Phase 1 interface**

- R15b. Chat stream + collapsible right sidebar (sessions, subagents, todos, MCP status, index status).
- R15c. Four interaction states (loading, empty, error, partial) for all interactive surfaces.

**Cross-platform public release**

- R16. macOS dmg, Windows nsis, Linux AppImage/deb.
- R17. Auto-update (gated to signed releases).
- R18. First-run onboarding (provider detection, config seeding).
- R18b. OS keychain for API key storage, redaction in logs/sessions.

**Desktop-native features (new capabilities, included in Phase 1)**

- R21. Native tool-call widgets in side rail (Monaco diff for edits, xterm.js for commands, file-preview for reads, results table for grep). Each tool call is a structured persisted event.

**Deferred (future exploration, not in this planning cycle)**

- R19. Agent graph as primary interface — deferred indefinitely; interface will change significantly before this can be added.
- R20. Diff-gated approval panel / permission system — deferred; will be designed and added later.
- R22. Annotated diff code review (navigable diff with line-level finding markers, color-coded by persona, filterable by severity, reasoning on hover) — deferred; added to todo for later implementation.

**Origin actors:** A1 (End user), A2 (General agent), A3 (Subagents), A4 (MCP servers)
**Origin flows:** F1 (First-run onboarding), F2 (Agent conversation with tool delegation), F3 (Code review skill execution), F4 (Background command execution)
**Origin acceptance examples:** AE1 (Covers R1, R4), AE2 (Covers R2, R4), AE3 (Covers R3, R4), AE4 (Covers R7, R8), AE5 (Covers R11), AE6 (Covers R16, R17), AE7 (Covers R21)

---

## Scope Boundaries

### Deferred for later

- Agent graph (R19) — deferred indefinitely; interface will change significantly before this can be added.
- Diff-gated approval (R20) and the broader permission/approval system — deferred; will be designed and added later.
- Multimodal input (paste/drag images, screenshot ingestion) — can be added post-parity.
- Embedded LSP diagnostics fed into agent context — feature, not migration foundation.
- Fuzzy matching in edit tool (not the Cmd+K palette's fuzzy search) — feature refinement.
- `ask_question` tool for agents to query users with multiple-choice — feature spec.
- Lateral/BTW subagent (ask without interrupting main flow) — feature spec.
- Visible skill stepper (workflow as live checklist) — depends on R19 being settled.
- Per-action tier choice with visible cost/speed — feature on top of XState hierarchy.
- Session-as-workspace (embedded Monaco editor + file tree + diff panel) — future evolution.

### Outside this product's identity

- Editor extension or LSP-server exposure.
- Agent-as-MCP-Server (exposing Orchid subagents as callable tools).
- Tools/skills as installable npm packages with a community marketplace.
- Collaborative persistent sessions (real-time multiplayer).
- Autonomous headless mode (GitHub App, CI groundskeeper).
- Token market economy (swarm self-allocates budget via bidding).

---

## Context & Research

### Relevant Code and Patterns

The Python codebase (spec for the port) is cleanly separated:

**Framework-agnostic domain layer** (can be ported as types, no logic change):
- `src/orchid/domain/` — Session, Chain, Message, Agent, Tool, Todo, Skill, SubagentRecord, SubagentManager

**Subsystem layer** (logic to reimplement in TS):
- `src/orchid/config.py` (532 lines) — Config dataclass with 22 fields, 3-layer deep-merge, env overrides, validation, seeding
- `src/orchid/tools/` — 27 tool implementations across 10 modules; lazy registry with `{"tool": Tool, "executor": callable}` entries
- `src/orchid/llm/client.py` (1175 lines) — monolith to be replaced by AI SDK middleware; ~80 lines of litellm-specific workarounds to re-derive against AI SDK failure modes
- `src/orchid/llm/providers.py` (247 lines) — model ref resolution, metadata hydration, model discovery
- `src/orchid/agents/` — 26 agent definitions (AGENT.md frontmatter), tier system, SubagentManager (469 lines)
- `src/orchid/skills/` — 15 skill definitions (SKILL.md frontmatter), dependency resolution, resource loading
- `src/orchid/rag/` — chunker, embedder (fastembed), vector store (numpy+SQLite), indexer, auto re-index via post-write callbacks
- `src/orchid/ast/` — tree-sitter parser, symbol index (SQLite), 5 AST tools
- `src/orchid/mcp/` — MCPManager with dedicated runner task, stdio/SSE transports, dynamic tool registration
- `src/orchid/tools/background_store.py` (596 lines) — BackgroundProcessStore with PTY, HeadTailBuffer, ownership model

**UI layer** (to be replaced entirely by React/Electron):
- `src/orchid/app.py` (1211 lines) — Orchid Textual App, InterruptState enum, chain management, timer/callback system
- `src/orchid/screens/` — Picker, SettingsScreen (1369 lines)
- `src/orchid/widgets/` — Sidebar, message widgets, smart scroll, subagent UI, live command widget

### Key Gotchas from Codebase Exploration

1. **tool_call/tool_result pairing invariant** (`client.py:310-399`): Bidirectional — orphaned results dropped, dangling tool_calls filtered. Must enforce on save AND restore. `_reconcile_orphan_tool_results()` runs on every chain restore.
2. **"No retry after content delivered" guard** (`client.py:1146-1171`): Retries suppressed once any token has been streamed to the user. Must replicate in AI SDK middleware.
3. **Benign mid-stream error handling** (`client.py:185-215, 547-578`): Empty-choices usage-only chunks must continue, not terminate. Behavioral contract: distinguish benign events from genuine content loss.
4. **Subagent restore migration** (`manager.py:193-204`): PENDING/RUNNING subagents become INTERRUPTED on restore; chain status reconciled with `finalize_chain_on_restore()`.
5. **MCP reconfiguration**: Python uses `os.execv` for restart. Electron will prompt for app restart on MCP config change (user decision).
6. **Session switching with in-flight work**: Running subagents are NOT cancelled on switch. Background commands are session-scoped.
7. **Post-write callbacks**: RAG and AST tools register callbacks that trigger re-indexing on file edit/write. Same pattern needed in TS.

### External References

- **XState v5**: `setup()` for typed machines, `fromPromise`/`fromCallback` for async, `sendTo`/`sendParent` for actor communication, `assign` + `spawn` for child actors. Nested states, parallel states, automatic child cancellation on state exit.
- **Vercel AI SDK v5**: `streamText` with composable middleware (`wrapLanguageModel`), `inputSchema` (zod) for tools, `stopWhen` for multi-step loops, `@ai-sdk/openai-compatible` for custom providers.
- **@modelcontextprotocol/sdk (TypeScript)**: Feature-equivalent to Python `mcp` package for stdio/SSE transports, dynamic tool registration, resource reading.
- **Electron**: `contextBridge` + `ipcMain.handle`/`invoke` for IPC, `safeStorage` for keychain, `electron-builder` for packaging, `electron-updater` for auto-update.
- **web-tree-sitter**: WASM-based parser, lazy grammar loading (100-300KB each), Query API with captures/matches. Node native bindings (`node-tree-sitter`) are faster for bulk parsing.
- **onnxruntime-node**: Native ONNX Runtime, `InferenceSession.create` + `Tensor` + `session.run`. BGE models available in ONNX format. Run in `worker_threads` for batch performance.
- **better-sqlite3**: Synchronous SQLite, WAL mode, transaction modes, `worker_threads` pattern for off-main-thread access.
- **zod v4**: `z.toJSONSchema()` built-in (no third-party package), `z.infer` for TypeScript types, `safeParse` for IPC validation.

---

## Key Technical Decisions

- **XState actor granularity**: Hybrid — per-agent/session entity actors spawn per-operation child actors (per-stream, per-tool-call). Parent holds session state; children are short-lived, cancellable via state exit. XState handles orchestration logic (state transitions, typed events, hierarchy); worker_threads handle CPU-bound work (embeddings, AST parsing).
- **Middleware vs XState boundary**: AI SDK middleware owns transport concerns (retry, throttle, error classification, provider quirks). XState owns agent lifecycle (streaming state, interrupt, subagent orchestration). A "cancelled" signal flows from XState to middleware (middleware observes, does not short-circuit independently).
- **Tool schema co-location**: Each tool directory contains `schema.ts` (zod input/output schemas), `handler.ts` (executor function), and `index.ts` (registration metadata). Single source of truth for TypeScript types, IPC validation, JSON Schema generation (via `z.toJSONSchema()`), and MCP exposure. Auto-registration via module exports.
- **Embeddings runtime**: `onnxruntime-node` in Electron main-process `worker_threads`. Research confirms best batch performance for 1000+ chunks. IPC round-trip for user search is acceptable. `transformers.js` (WASM) is a fallback if native addons prove impractical.
- **Tree-sitter grammar bundling**: Lazy-load WASM grammars per detected language on first use. Each grammar is 100-300KB, bundled in `app.asar`. Use `web-tree-sitter` in renderer for preview, `node-tree-sitter` in main for bulk indexing.
- **MCP reconfiguration**: Prompt for app restart (user decision). Simpler than live tear-down/recreate within the running app.
- **IPC validation**: Every IPC message validated at the main-process boundary with zod schemas. Never trust renderer input. Typed channels via `contextBridge.exposeInMainWorld`.
- **SQLite access**: `better-sqlite3` in a `worker_threads` worker in the main process. WAL mode for concurrent read/write. Transaction batching for bulk operations (RAG index, AST index).
- **Session persistence**: JSON files at `~/.orchid/sessions/<uuid>.json` (version 1 format). Atomic writes via temp + `fsync` + `os.replace`. Tool_call/tool_result pairing invariant enforced on save and restore.
- **Provider resolution**: `@ai-sdk/openai-compatible` handles the primary case (OpenAI-compatible + Ollama). Custom adapter middleware for non-OpenAI-compatible providers. Spike validates at least one non-OpenAI provider end-to-end.

---

## Open Questions

### Resolved During Planning

- **XState actor granularity**: Per-subagent with per-operation child actors. Resolved via research (hybrid pattern recommended).
- **Middleware vs XState boundary**: Middleware owns transport, XState owns lifecycle. Resolved by design.
- **Tool schema co-location**: Co-located with tool handlers (package-per-tool). Resolved by zod-idiomatic pattern.
- **Embeddings runtime location**: Main process worker_thread. Resolved via performance research.
- **Tree-sitter grammar bundling**: Lazy-load per detected language. Resolved via app-size analysis.
- **AI SDK provider coverage**: `@ai-sdk/openai-compatible` for primary case; custom adapters for non-OpenAI providers. Resolved via research.
- **Intermediate milestone**: Full parity first, no intermediate shippable. User decision.
- **MCP reconfiguration**: Prompt for app restart. User decision.

### Deferred to Implementation

- **AI SDK failure modes**: The ~80 lines of litellm workarounds must be re-derived against AI SDK's actual streaming failure modes. The spike validates the happy path; the full port discovers edge cases during U8-U9.
- **onnxruntime-node warmup**: First `session.run()` is very slow. Need warmup pattern during U16 (RAG pipeline).
- **web-tree-sitter memory management**: WASM uses native memory; must call `tree.delete()`, `parser.delete()`, `query.delete()` when done. U17 (AST pipeline) handles this.
- **Session format compatibility**: If the TS app needs to read Python TUI session files, `from_storage_dict()` logic must be replicated. If not (fresh install only), the format can evolve.

---

## Output Structure

```
electron/
  package.json                      # Root package (electron main + renderer + shared)
  tsconfig.json                     # TypeScript configuration
  electron-builder.yml              # Packaging config
  vite.config.ts                    # Build tooling (Vite for renderer)
  src/
    main/                           # Electron main process
      index.ts                      # App entry, window management
      ipc/                          # IPC handlers (zod-validated)
      config/                       # Config system (loader, merge, validation)
      session/                      # Session persistence (storage, manager)
      llm/                          # LLM streaming
        middleware/                  # AI SDK middleware (retry, throttle, error, quirks)
        stream.ts                   # streamText wrapper
        providers.ts                # Provider resolution
        history.ts                  # History conversion (tool_call/tool_result pairing)
      agents/                       # Agent system
        registry.ts                 # AGENT.md loading, tier resolution
        manager.ts                  # SubagentManager
        xstate/                     # XState machines
          session-machine.ts
          agent-machine.ts
          interrupt-machine.ts
      tools/                        # Tool registry + all 27 handlers
        registry.ts                 # Zod tool registry framework
        filesystem/                 # read, edit, write, read_directory, glob
        search/                     # grep
        process/                    # execute_command, read_output, send_input, terminate_command
          background-store.ts       # BackgroundProcessStore (PTY, HeadTailBuffer)
        todo/                       # todo_create, todo_update, todo_list, todo_delete
        web/                        # web_fetch
        rag/                        # rag_search, rag_index (+ chunker, embedder, store)
        ast/                        # 5 AST tools (+ parser, indexer, store)
        subagent/                   # delegate_to_subagent, wait_for_subagent, interrupt_subagents
        skill/                      # skill (dynamic building, dependency resolution)
        mcp/                        # read_mcp_resource
      mcp/                          # MCP client (@modelcontextprotocol/sdk)
        manager.ts                  # Lifecycle management
        transport.ts                # stdio + SSE transports
      rag/                          # RAG subsystem
        chunker.ts
        embedder.ts
        indexer.ts
        store.ts
      ast/                          # AST subsystem
        parser.ts
        indexer.ts
        store.ts
        queries/                    # tree-sitter .scm query files
      skills/                       # Skills system (loading, registry)
      personality/                  # Personality system (loading, registry)
      commands/                     # Command palette (registry, slash commands)
    renderer/                       # Electron renderer (React)
      App.tsx
      components/
        ChatStream.tsx
        Sidebar.tsx
        MessageWidget.tsx
        ToolWidgets/                # R21: Native tool-call widgets
          DiffWidget.tsx            # Monaco diff for edits
          TerminalWidget.tsx        # xterm.js for commands
          FilePreview.tsx           # File preview for reads
          ResultsTable.tsx          # Results table for grep
        AnnotatedDiff.tsx           # R22: Navigable annotated diff for code review
        CommandPalette.tsx
        Preferences/
        Onboarding/
    shared/                         # Shared between main and renderer
      types/                        # TypeScript type definitions
      schemas/                      # Zod schemas for IPC, tool input
    preload/                        # Preload script (contextBridge)
      index.ts
  tests/
    unit/                           # Unit tests per module
    integration/                    # Integration tests per subsystem
    parity/                         # Parity tests (one per tool, agent, skill, config field)
```

---

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

### Process Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│ Main Process (Node.js)                                              │
│                                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │
│  │ XState Actor  │  │ AI SDK       │  │ Tool Registry            │  │
│  │ Hierarchy     │  │ Middleware   │  │ (27 tools + MCP tools)   │  │
│  │               │  │              │  │                          │  │
│  │  Session      │──│  streamText  │──│  zod schemas → TS types  │  │
│  │  Agent        │  │  retry       │  │  zod → JSON Schema (MCP) │  │
│  │  Stream       │  │  throttle    │  │  zod → IPC validation    │  │
│  │  Subagent     │  │  error-class │  │  zod → React rendering   │  │
│  │  Interrupt    │  │  provider-q  │  │                          │  │
│  └──────┬───────┘  └──────┬───────┘  └──────────────────────────┘  │
│         │                 │                                         │
│  ┌──────┴───────┐  ┌──────┴───────┐  ┌──────────────────────────┐  │
│  │ Session Mgr  │  │ Provider     │  │ MCP Manager              │  │
│  │ (JSON disk)  │  │ Resolution   │  │ (@modelcontextprotocol)  │  │
│  └──────────────┘  └──────────────┘  └──────────────────────────┘  │
│                                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │
│  │ RAG Worker   │  │ AST Worker   │  │ Background Process Store │  │
│  │ (onnxruntime │  │ (tree-sitter │  │ (PTY, HeadTailBuffer)    │  │
│  │  in worker_t)│  │  in worker_t)│  │                          │  │
│  │  SQLite+WAL  │  │  SQLite+WAL  │  │                          │  │
│  └──────────────┘  └──────────────┘  └──────────────────────────┘  │
│                                                                     │
│  ┌──────────────┐  ┌──────────────┐                                │
│  │ Config       │  │ OS Keychain  │                                │
│  │ (3-layer     │  │ (safeStorage)│                                │
│  │  deep-merge) │  │              │                                │
│  └──────────────┘  └──────────────┘                                │
└─────────────────────────────┬───────────────────────────────────────┘
                              │ IPC (contextBridge + ipcMain.handle)
                              │ zod-validated payloads
┌─────────────────────────────┴───────────────────────────────────────┐
│ Renderer Process (Chromium + React)                                  │
│                                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐   │
│  │ Chat Stream  │  │ Sidebar      │  │ Command Palette (Cmd+K)  │   │
│  │ (messages,   │  │ (sessions,   │  │ (fuzzy search across     │   │
│  │  streaming)  │  │  subagents,  │  │  commands, sessions,     │   │
│  │              │  │  todos, MCP, │  │  settings, navigation)   │   │
│  │              │  │  index)      │  │                          │   │
│  └──────────────┘  └──────────────┘  └──────────────────────────┘   │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ Tool Widgets Side Rail (R21)                                  │   │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐    │   │
│  │  │ Monaco   │ │ xterm.js │ │ File     │ │ Results      │    │   │
│  │  │ Diff     │ │ Terminal │ │ Preview  │ │ Table        │    │   │
│  │  │ (edits)  │ │ (cmds)   │ │ (reads)  │ │ (grep)       │    │   │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────────┘    │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ Annotated Diff (R22) — Code Review                           │   │
│  │  Navigable diff with line-level finding markers              │   │
│  │  Color-coded by persona, filterable by severity              │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌──────────────┐  ┌──────────────┐                                │
│  │ Preferences  │  │ Onboarding   │                                │
│  │ (5-tab       │  │ (provider    │                                │
│  │  native)     │  │  detection)  │                                │
│  └──────────────┘  └──────────────┘                                │
└──────────────────────────────────────────────────────────────────────┘
```

### XState Actor Hierarchy

```
App Actor (root)
│
├── Config Actor
│   └── Loads, validates, watches config changes
│
├── MCP Lifecycle Actor
│   ├── Server Actor (context7)
│   ├── Server Actor (server2)
│   └── Tool Registry Actor (MCP tools merged)
│
└── Session Actor (one per active session)
    │
    ├── Agent Actor (general, bloom tier)
    │   │   States: idle → streaming → tool_executing → streaming → idle
    │   │            → interrupted
    │   │
    │   ├── Stream Actor (one per LLM call, fromCallback)
    │   │   └── Processes chunks, yields Messages to parent
    │   │
    │   ├── Tool Executor Actor (one per tool call, fromPromise)
    │   │   └── Executes tool, feeds result back to Stream Actor
    │   │
    │   └── Subagent Actors (spawned dynamically)
    │       │   States: pending → running → completed | failed | interrupted
    │       │
    │       ├── Stream Actor
    │       └── Tool Executor Actor
    │
    └── Background Command Actors (spawned by execute_command)
        │   States: running → completed | failed | terminated
        │
        └── Drain Actor (reads stdout+stderr, manages HeadTailBuffer)
```

### AI SDK Middleware Composition

```
wrapLanguageModel({
  model: providerModel,   // from @ai-sdk/openai or @ai-sdk/openai-compatible
  middleware: [
    providerQuirksMiddleware(),      // replaces ~80 lines of litellm patches
    retryMiddleware(maxRetries,      // exponential backoff with jitter
                    backoff,
                    contentDeliveredSignal),  // no retry after first token
    throttleMiddleware(minInterval), // replaces _YIELD_THROTTLE
    errorClassificationMiddleware(), // maps exceptions to user-facing (title, detail)
  ],
})

streamText({
  model: wrappedModel,
  messages: apiMessages,
  system: staticPrompt + dynamicPrompt,
  tools: filteredZodTools,       // auto-registered from zod schemas
  stopWhen: isStepCount(maxSteps),
})
```

---

## Renderer Layout & Information Architecture

> *Directional guidance for implementers. The layout evolves in Phase 2 when R19 (agent graph) replaces the sidebar.*

### Spatial Model

```
┌──────────────────────────────────────────────────────────────┐
│ Title Bar (macOS: traffic lights + title | Win/Linux: custom)│
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌────────────────────────────┐  ┌────────────────────────┐  │
│  │                            │  │                        │  │
│  │      Chat Stream           │  │    Sidebar (R15b)      │  │
│  │      (primary surface)     │  │    Collapsible right   │  │
│  │                            │  │                        │  │
│  │  ┌──────────────────────┐  │  │  Sessions              │  │
│  │  │ Messages             │  │  │  Subagents             │  │
│  │  │ (scrollable)         │  │  │  Todos                 │  │
│  │  │                      │  │  │  MCP Status            │  │
│  │  │                      │  │  │  Index Status          │  │
│  │  └──────────────────────┘  │  │                        │  │
│  │  ┌──────────────────────┐  │  └────────────────────────┘  │
│  │  │ Input Area           │  │                              │
│  │  │ (textarea + submit)  │  │                              │
│  │  └──────────────────────┘  │                              │
│  │  ┌──────────────────────┐  │                              │
│  │  │ Footer               │  │                              │
│  │  │ (model, usage, time) │  │                              │
│  │  └──────────────────────┘  │                              │
│  └────────────────────────────┘                              │
│                                                              │
│  Tool Widgets Side Rail (R21) — appears between Chat and     │
│  Sidebar when a tool call is active. Collapsible.            │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│ (Reserved: Phase 2 — R19 agent graph replaces sidebar)       │
└──────────────────────────────────────────────────────────────┘
```

### Panel Classification

| Panel | Type | Trigger | Dismiss |
|-------|------|---------|---------|
| Chat Stream | Inline (always visible) | App launch | Never |
| Sidebar | Inline (collapsible) | Toggle button or Ctrl+B | Toggle button or Ctrl+B |
| Tool Widgets (R21) | Inline (collapsible side rail) | Auto-opens on tool call | Collapse button |
| Annotated Diff (R22) | Inline (replaces tool rail) | Code review completes | Back button |
| Command Palette | Overlay (modal) | Cmd+K / Ctrl+K | Esc or click outside |
| Preferences | Overlay (modal) | `/settings` command | Esc or close button |
| Onboarding | Overlay (fullscreen) | First launch only | Complete or skip |

### Z-Index Layering

| Layer | Components |
|-------|-----------|
| Base | Chat Stream, Sidebar |
| Side Rail | Tool Widgets, AnnotatedDiff |
| Modal | Preferences, Onboarding |
| Overlay | Command Palette (highest — always on top of modals) |

### Cold Launch State

On first launch (no sessions exist):
1. Onboarding overlay appears (fullscreen)
2. After onboarding completes: empty ChatStream with empty-state placeholder ("Send a message to get started")
3. Sidebar collapsed by default (expand on user action)

On subsequent launches:
1. Fresh ChatStream (new session created automatically)
2. Sidebar collapsed by default
3. No tool widgets visible

### Interaction States (R15c)

Every interactive surface defines four states. Implementers must use these specifications, not invent their own.

| Surface | Loading | Empty | Error | Partial |
|---------|---------|-------|-------|---------|
| **ChatStream** | Skeleton messages (3 gray bars with pulse animation) | "Send a message to get started" with input focus | "Something went wrong" + retry button + error detail collapsible | Streaming indicator at bottom, "..." bubble while agent thinks |
| **Sidebar — Sessions** | Spinner in section header | "No sessions yet" | "Failed to load sessions" + retry | — (no partial state) |
| **Sidebar — Subagents** | Spinner in section header | "No active subagents" | "Subagent failed" with error badge | "N of M completed" progress indicator |
| **Sidebar — Todos** | Spinner in section header | "No tasks" | — (no error state) | — (no partial state) |
| **Sidebar — MCP** | Spinner in section header | "No MCP servers configured" | "Server failed: {name}" with retry | "N of M servers connected" |
| **Sidebar — Index** | Spinner in section header | "No index" with "Index now" button | "Indexing failed" + retry | "Indexing: N/M files" progress bar |
| **Tool Widget** | Skeleton of widget type | "No tool calls yet" | "Tool failed: {error}" + retry button | Streaming output (for TerminalWidget) |
| **AnnotatedDiff** | Skeleton diff view | "No code review findings" | "Review failed" + retry | "N of M reviewers complete" |
| **CommandPalette** | — (instant) | "No results" with suggestion | — (no error state) | — (no partial state) |
| **Preferences** | Spinner while loading config | — (always has content) | "Failed to save" + retry | "Unsaved changes" indicator |
| **Onboarding** | Spinner during provider detection | — (always has content) | "Detection failed" + manual entry | Step progress indicator |

Each state includes: (1) visual treatment (skeleton/spinner/message), (2) available actions (retry/dismiss/guidance), (3) recovery path.

### Accessibility

- Minimum window size: 800x600. No maximum (responsive layout).
- Keyboard navigation: Tab order follows visual layout. Focus traps for modals (CommandPalette, Onboarding, Preferences). Esc closes topmost modal.
- ARIA roles: `role="log"` for chat messages, `role="status"` for streaming indicators, `role="dialog"` for modals, `role="navigation"` for sidebar.
- High-contrast theme: `green_terminal` theme serves as high-contrast option. Consider adding a dedicated a11y theme in a future iteration.
- Screen reader: Tool results announced via `aria-live="polite"`. Error states announced via `aria-live="assertive"`.

---

## System-Wide Impact

- **Interaction graph:** XState actors spawn child actors for subagents and tool calls; AI SDK middleware wraps the model call; tool results feed back into the stream loop via typed events; IPC bridges main↔renderer for live updates.
- **Error propagation:** Tool errors → Tool Executor Actor → Stream Actor (retry or surface to user). Stream errors → retry middleware → Agent Actor (fail or retry). All errors classified via `classify_error()` middleware.
- **State lifecycle risks:** Partial writes on crash (mitigated by atomic JSON writes). Subagent restore migration (PENDING/RUNNING → INTERRUPTED). Chain orphan reconciliation on load. MCP transport cleanup on shutdown.
- **API surface parity:** The parity matrix (companion doc) tracks every tool, agent, skill, config field, and command against its TS port status.
- **Integration coverage:** tool_call/tool_result pairing invariant spans stream orchestration + session persistence. Post-write callbacks span edit/write tools + RAG/AST indexers. Subagent lifecycle spans XState actors + session persistence + sidebar UI.
- **Unchanged invariants:** Agent loading from AGENT.md frontmatter. Skill loading from SKILL.md frontmatter. Config deep-merge semantics. Theme switching without restart.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| AI SDK lacks a capability that litellm provides (e.g., specific provider quirk) | Architecture spike validates at least one non-OpenAI provider end-to-end. Custom middleware for any gaps. |
| onnxruntime-node performance insufficient for real-time auto re-indexing | Benchmark ≥1000 chunks during U16. Fall back to `transformers.js` (WASM) or lazy re-indexing. |
| web-tree-sitter memory leaks from unreleased WASM objects | Establish `parser.delete()`, `tree.delete()`, `query.delete()` patterns early in U17. |
| XState/AI SDK composition conflict (streaming model vs event model control flow) | Architecture spike (U2) is the go/no-go gate. If they conflict, reopen R1/R2. |
| Session format incompatibility between Python TUI and TS app | If needed, replicate `from_storage_dict()` logic for legacy session import. If not (fresh install), format can evolve. |
| Cross-platform native module compilation (better-sqlite3, onnxruntime-node) | Use `@electron/rebuild` in CI. Test on all three platforms in U26. |
| Large bundle size from bundled WASM grammars + ONNX models | Lazy-load grammars per language. ONNX model downloaded on first RAG index, not bundled. |
| Zod v4 z.toJSONSchema() may have edge cases or API instability (beta) | Pin specific Zod v4 beta version. Spike (U2) validates z.toJSONSchema() for complex tool schemas. Fallback: zod v3 + zod-to-json-schema. |

---

## Phased Delivery

### Phase A: Foundation (U1-U2)
Spike validates XState + AI SDK + zod composition. Go/no-go gate before any horizontal porting.

### Phase B: Core Infrastructure (U3-U7)
Domain models, config, persistence, agent/skill loading, tool registry framework. These are the structural foundations that every subsequent unit depends on.

### Phase C: LLM & Agent Orchestration (U8-U12)
AI SDK middleware, stream orchestration, XState actor hierarchy, subagent tools, MCP client. This is the brain of the system.

### Phase D: Tool Port (U13-U18)
All 27 tools ported horizontally across filesystem, search, process, todo, web, RAG, AST, skill, MCP categories.

### Phase E: UI Shell (U19-U24)
Electron app shell, chat + sidebar, command palette, native tool widgets (R21), preferences, onboarding, themes, personalities. (R22 annotated diff deferred — see `deferred-features-todo.md`.)

### Phase F: Cross-Platform & Parity (U25-U29)
OS keychain, packaging, auto-update, parity matrix, parity tests, TUI bug verification.

---

## Documentation Plan

- Parity matrix (companion doc) tracks every tool, agent, skill, config field, and command.
- Each implementation unit includes its own test scenarios (per-unit test file paths in `**Files:**`).
- Post-migration: capture learnings in `docs/solutions/` via `ce-compound` for the key architectural decisions (XState actor patterns, AI SDK middleware patterns, zod tool contracts).

---

## Sources & References

- **Origin document:** [docs/brainstorms/ts-electron-desktop-migration-requirements.md](../brainstorms/ts-electron-desktop-migration-requirements.md)
- **Key source files:** `src/orchid/app.py`, `src/orchid/llm/client.py`, `src/orchid/agents/manager.py`, `src/orchid/config.py`, `src/orchid/storage.py`, `src/orchid/tools/`, `src/orchid/rag/`, `src/orchid/ast/`, `src/orchid/mcp/`, `src/orchid/domain/`
- **External docs:** XState v5, Vercel AI SDK v5, @modelcontextprotocol/sdk, Electron, electron-builder, web-tree-sitter, onnxruntime-node, better-sqlite3, zod v4

---

## Assumptions

*This plan was authored with synchronous user confirmation for key decisions (MCP reconfiguration, intermediate milestone, R19/R20 deferral). Remaining items below are agent inferences validated by research.*

- `@ai-sdk/openai-compatible` handles Orchid's primary provider pattern (OpenAI-compatible base URLs). The default provider (`opencode.ai/zen/go/v1`) works with this adapter. If not, custom middleware is scoped during U8.
- The Python TUI's session format (version 1 JSON) does not need backward compatibility — the TS app is a fresh product with its own session directory. If legacy import is needed, a migration utility can be added post-parity.
- The `safeStorage` API (Electron) is sufficient for API key storage on all three platforms. Linux libsecret may fall back to plaintext if unavailable — document this in U25.
- Code signing/notarization infrastructure is acquired before public release but not required for the unsigned beta phase (per origin document).
