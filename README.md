# Orchid

**AI-powered desktop coding assistant with a multi-agent architecture.**

Orchid is a standalone Electron desktop app for macOS, Windows, and Linux that integrates the entire software engineering pipeline — strategy, planning, implementation, code review, versioning, and knowledge compounding — into a single interface.

> **Based on:** [Stupidex](https://github.com/Zeptiny/stupidex), originally developed as an academic project.

---

## The Problem

Developers face high cognitive load switching between tools, contexts, and stages of the development cycle. Knowledge gained solving one problem is often lost and must be rediscovered.

## The Solution

An integrated multi-agent assistant that unifies:

1. **Strategy & Planning** — define product direction, break tasks into actionable plans
2. **Implementation** — write and edit code with project awareness
3. **Code Review** — structured review with specialized agents (correctness, security, performance, maintainability, testing)
4. **Versioning** — commit and PR with descriptive messages
5. **Knowledge Compounding** — document solved problems to prevent rediscovery

With:
- **Local models** (Ollama) for offline operation
- **RAG** for semantic code search
- **MCP** (Model Context Protocol) for external tools
- **AST tools** for structural code manipulation

---

## Multi-Agent Architecture

Orchid implements a hierarchical agent architecture where a main agent orchestrates specialized subagents:

```
User → General Agent → Plan → Implementer → Code Review (parallel) → Commit → PR → Compound
```

### How It Works

1. **Main Agent** (`general`, tier `bloom`) — receives user requests, decides flow, delegates tasks
2. **Specialized Subagents** — execute specific tasks with tools and skills limited to their scope
3. **Skills** — reusable workflows that guide agents through complex tasks (e.g., `code-review` triggers 6+ reviewers in parallel)
4. **Review** — parallel review agents analyze produced code before commit

---

## Agents

### Core Agents

| Agent | Tier | Purpose |
|-------|------|---------|
| **general** | `bloom` | Main agent. Receives commands, orchestrates subagents |
| **explorer** | `seed` | Read-only code exploration: file reading, pattern search |
| **implementer** | `bloom` | Writes and edits code. Executes implementation plans |
| **reviewer** | `crown` | General code review: bugs, style, improvements |
| **web-fetch** | `seed` | Internal agent that summarizes web content (used by `web_fetch` tool) |

### Specialized Reviewers (used by `code-review` skill)

| Agent | Tier | Purpose |
|-------|------|---------|
| **correctness-reviewer** | `crown` | Logic errors, edge cases, state bugs |
| **security-reviewer** | `crown` | Vulnerabilities, injection, input validation |
| **performance-reviewer** | `crown` | Bottlenecks, N+1 queries, memory usage |
| **maintainability-reviewer** | `bloom` | Premature abstractions, dead code, coupling |
| **testing-reviewer** | `bloom` | Test coverage, weak assertions, brittle tests |
| **adversarial-reviewer** | `crown` | Failure scenarios to break the implementation |
| **reliability-reviewer** | `crown` | Error handling, retries, circuit breakers |
| **api-contract-reviewer** | `bloom` | API routes, request/response types |
| **data-integrity-guardian** | `crown` | Migrations, data models, persistent data safety |
| **code-simplicity-reviewer** | `bloom` | YAGNI violations, simplification opportunities |

### Research & Analysis Agents

| Agent | Tier | Purpose |
|-------|------|---------|
| **learnings-researcher** | `sprout` | Searches `docs/solutions/` for prior learnings |
| **web-researcher** | `sprout` | RAG-based code search and semantic analysis |
| **architecture-strategist** | `crown` | Architecture pattern compliance |
| **agent-native-reviewer** | `crown` | Agent-user parity verification |
| **spec-flow-analyzer** | `bloom` | User flow analysis and gap identification |

### Document Review Agents (used by `doc-review` skill)

| Agent | Tier | Purpose |
|-------|------|---------|
| **adversarial-document-reviewer** | `crown` | Challenges premises and unstated assumptions |
| **coherence-reviewer** | `bloom` | Internal document consistency |
| **feasibility-reviewer** | `bloom` | Proposed approach viability |
| **product-lens-reviewer** | `crown` | Product perspective review |
| **scope-guardian-reviewer** | `bloom` | Scope alignment, unjustified complexity |
| **pr-comment-resolver** | `bloom` | PR review thread resolution |

### System Tiers

| Tier | Intelligence | Speed | Use Case |
|------|-------------|-------|----------|
| **seed** | Low | Very fast | Mechanical tasks: list files, read, search |
| **sprout** | Medium | Fast | Exploration, grep, summarization |
| **bloom** | High | Normal | Implementation, refactoring, multi-file |
| **crown** | Very high | Slow | Architecture, complex debugging, code review |

Each tier can be mapped to different models in `config.json` to optimize cost and latency.

---

## Personalities

Orchid has a personality system that changes the agent's tone, style, and behavior. Personalities are defined in Markdown files and attached to the system prompt.

| Personality | Description |
|:---|:---|
| **default** | Concise, direct, friendly. Like a capable teammate passing work along. |
| **meow** | Fully competent coding agent that happens to be a cat. Meow vocabulary, feline behaviors. |
| **pirate** | Salty sailor. Code is "treasure", bugs are "confused sailors". Pirate dialect. |
| **socrates** | Socratic coding philosopher. Asks "why does this exist?" before "how does this work?". |
| **stupid** | Charmingly clueless but trying its best. Confident enthusiasm about things it doesn't fully understand. |
| **zen** | Calm, philosophical coding master. Nature metaphors. "Simplicity is the ultimate sophistication." |

Configure in `config.json`:
```json
{ "personality": "zen" }
```

---

## Tools

### File Tools

| Tool | Description |
|------|-------------|
| `read` | Read file contents with line numbers |
| `read_directory` | List directory contents (tree format) |
| `glob` | Search files by glob pattern |
| `edit` | Edit files by exact string replacement |
| `write` | Create/overwrite files (auto-creates directories) |
| `get_file_skeleton` | File structure (classes, functions with line ranges) |
| `get_function` | Extract specific function with imports and class context |
| `find_symbol_references` | Find symbol definitions and references |
| `replace_symbol` | Replace complete symbol definition (includes docstrings, decorators) |
| `rename_symbol` | Rename symbol across all files |

### Search Tools

| Tool | Description |
|------|-------------|
| `grep` | Regex search in file contents |
| `rag_search` | Semantic code search (RAG) |
| `rag_index` | Check status, reindex, or clear RAG index |

### Subagent Tools

| Tool | Description |
|------|-------------|
| `delegate_to_subagent` | Delegate task to a subagent with isolated context |
| `wait_for_subagent` | Wait for subagent results |
| `interrupt_subagents` | Cancel running subagents |

### Execution Tools

| Tool | Description |
|------|-------------|
| `execute_command` | Execute shell commands (foreground/background, PTY support) |
| `skill` | Load and execute a skill (also read resources via `skill/resource`) |

### Todo Tools

| Tool | Description |
|------|-------------|
| `todo_create` | Create task |
| `todo_update` | Update task status/details |
| `todo_list` | List tasks filtered by status or subagent |
| `todo_delete` | Delete task |

### MCP Tools

| Tool | Description |
|------|-------------|
| `read_mcp_resource` | Read resource from MCP server via URI |
| `mcp_*` | Tools registered dynamically by MCP servers (e.g., `mcp::context7::resolve-library-id`) |

### Web Tools

| Tool | Description |
|------|-------------|
| `web_fetch` | Fetch URL and extract information (summarize/raw modes) |

---

## MCP (Model Context Protocol)

MCP connects Orchid agents to external tool and resource servers, expanding capabilities without modifying agent code.

### How MCP Works

1. **Session management** — `MCPManager` manages full lifecycle: starts servers on app init, maintains active sessions, shuts down on exit
2. **Two transport types**:
   - **stdio** — server runs as subprocess, communicates via stdin/stdout
   - **HTTP/SSE** — remote server, communicates via Server-Sent Events
3. **Dynamic tool registration** — tools exposed by MCP servers are automatically registered with prefix `mcp::server::tool`
4. **Resource reading** — `read_mcp_resource` lets agents read resources exposed by MCP servers

### Default Servers

| Server | Description |
|--------|-------------|
| **context7** | Up-to-date library/framework documentation via `@upstash/context7-mcp` |

### Configuration

```json
{
  "mcp_servers": {
    "context7": {
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp"]
    }
  }
}
```

HTTP/SSE servers use `url` instead of `command`/`args`.

---

## RAG (Retrieval-Augmented Generation)

Orchid implements a complete RAG pipeline for semantic code search:

```
Project → Scanner → Chunker → Embedder → Vector Store → Query
```

### Pipeline

1. **File Discovery** — scans project respecting `ignored_dirs`, includes source code extensions, excludes binaries
2. **Smart Chunking** — splits files by lines, breaks at blank lines (respects natural code boundaries). Configurable `rag.chunk_size` (default: 2000) and `rag.chunk_overlap` (default: 200)
3. **Embedding** — each chunk converted to numeric vector via embedding model
4. **Storage** — vectors stored on disk with SQLite + numpy
5. **Similarity Search** — user text embedded with same model, K nearest neighbors by cosine similarity
6. **Results** — code snippets with file path, lines, and relevance score

### Extra Features

- **Auto-indexing** — files edited/created via `edit`/`write` tools are automatically reindexed
- **Sidebar status** — shows last index date and duration
- **Commands** — `/rag index` to reindex, `/rag clear` to clear

### Embedding Technology

- **Default model:** `BAAI/bge-small-en-v1.5` (384 dimensions, ~130MB)
- **Runtime:** ONNX Runtime via `onnxruntime-node` — local inference, no GPU or external API needed
- **Auto-download:** model downloaded on first RAG index from Hugging Face

### Vector Storage

| Component | Technology |
|-----------|-----------|
| **Vectors** | `.npy` files on disk |
| **Metadata** | SQLite (chunks, files, index status) |
| **Search** | Cosine similarity — simple KNN in memory |

Index location: `.orchid/rag/` in the project directory.

---

## Configuration

### Config File

`~/.orchid/config.json` supports the following fields (all optional — defaults used when absent):

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `default_model` | `string` | `"default/mimo-v2.5"` | Default model for the agent |
| `tier_models` | `dict` | all `default/mimo-v2.5` | Tier to model mapping |
| `providers` | `dict` | OpenCode.ai | LLM provider configuration |
| `mcp_servers` | `dict` | context7 | Configured MCP servers |
| `theme` | `string` | `"default"` | App visual theme |
| `personality` | `string` | `"default"` | Active agent personality |
| `command_timeout` | `int` | `30` | Shell command timeout (seconds) |
| `read_line_limit` | `int` | `1000` | Line limit for `read` tool |
| `grep_max_results` | `int` | `100` | Max results for `grep` tool |
| `directory_tree_depth` | `int` | `2` | Directory tree depth |
| `ast_max_file_size` | `int` | `1048576` | Max file size for AST parsing (bytes) |
| `mcp_startup_timeout` | `float` | `60.0` | MCP startup timeout (seconds) |
| `mcp_per_server_timeout` | `float` | `10.0` | Per-server MCP timeout |
| `llm_stream_idle_timeout` | `float` | `300.0` | LLM stream idle timeout |
| `llm_stream_retries` | `int` | `3` | LLM stream retry count |
| `ignored_dirs` | `list` | (see RAG section) | Directories ignored in indexing |
| `rag` | `object` | (see below) | RAG configuration |

#### RAG Config (nested)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `rag.chunk_size` | `int` | `2000` | Chunk size in characters |
| `rag.chunk_overlap` | `int` | `200` | Overlap between chunks |
| `rag.top_k` | `int` | `5` | Number of search results |
| `rag.max_file_size` | `int` | `512000` | Max file size for indexing (bytes) |
| `rag.embedding_model` | `string` | `"BAAI/bge-small-en-v1.5"` | Embedding model |

### Project Config

Create `.orchid.json` in the project root for per-project overrides. Deep-merged with global config.

### Environment Variables

All config options can be overridden via `ORCHID_`-prefixed environment variables:

| Variable | Config Field |
|----------|-------------|
| `ORCHID_DEFAULT_MODEL` | `default_model` |
| `ORCHID_THEME` | `theme` |
| `ORCHID_PERSONALITY` | `personality` |
| `ORCHID_COMMAND_TIMEOUT` | `command_timeout` |
| `ORCHID_READ_LINE_LIMIT` | `read_line_limit` |
| `ORCHID_GREP_MAX_RESULTS` | `grep_max_results` |
| `ORCHID_RAG_CHUNK_SIZE` | `rag.chunk_size` |
| `ORCHID_RAG_TOP_K` | `rag.top_k` |

### Settings UI

The `/settings` command opens a 5-tab preferences window:
- **Providers** — add/edit/remove LLM providers, configure models
- **MCP Servers** — add/edit/remove MCP servers
- **Tier Models** — map each agent tier to a specific model
- **RAG** — configure chunk size, overlap, top_k, embedding model
- **General** — default model, theme, personality, timeouts

---

## LLM Providers

### Default Provider

On first launch, Orchid connects to **OpenCode.ai** (OpenAI-compatible API) with MiMo V2.5:

```json
{
  "providers": {
    "default": {
      "base_url": "https://opencode.ai/zen/go/v1",
      "models": { "mimo-v2.5": {} }
    }
  },
  "default_model": "default/mimo-v2.5"
}
```

### Local Models (Ollama)

```json
{
  "providers": {
    "ollama": {
      "base_url": "http://localhost:11434/v1",
      "models": { "qwen3.6:35b-a3b": { "max_input_tokens": 262144 } }
    }
  },
  "default_model": "ollama/qwen3.6:35b-a3b",
  "tier_models": {
    "seed": "ollama/qwen3.6:35b-a3b",
    "sprout": "ollama/qwen3.6:35b-a3b",
    "bloom": "ollama/qwen3.6:35b-a3b",
    "crown": "ollama/qwen3.6:35b-a3b"
  }
}
```

### Supported Providers

The desktop app uses Vercel AI SDK with `@ai-sdk/openai` for OpenAI-compatible providers:

| Provider | Adapter |
|----------|---------|
| OpenAI-compatible (default) | `@ai-sdk/openai` with `compatibility: 'compatible'` |
| Anthropic | `@ai-sdk/anthropic` |
| Google/Gemini | `@ai-sdk/google` |
| Groq | `@ai-sdk/groq` |
| xAI | `@ai-sdk/xai` |

---

## Usage

### Command Palette (Cmd+K / Ctrl+K)

| Command | Description |
|---------|-------------|
| `/new` | New session |
| `/sessions` | Switch between sessions |
| `/rename` | Rename current session |
| `/delete` | Delete session |
| `/model` | Change session model |
| `/theme` | Change app theme |
| `/personality` | Change agent personality |
| `/settings` | Open preferences (5 tabs) |
| `/rag index` | Index project for semantic search |
| `/ast index` | Re-scan project for AST index |
| `/rag clear` | Clear RAG index |

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+K` / `Ctrl+K` | Open command palette |
| `Enter` / `Ctrl+S` | Send message |
| `Escape` | Cancel streaming / close modal |
| `Ctrl+B` | Toggle sidebar |

### Token Usage

Orchid displays token consumption in real-time:
- **Session footer** — total tokens for current session
- **Chain subtotal** — tokens per agent action chain
- **Subagent subtotal** — tokens per delegated subagent
- **Cached tokens** — cached input tokens tracked separately for cost analysis

Fields: `prompt_tokens`, `completion_tokens`, `total_tokens`, `cached_tokens`

### Themes

| Theme | Description |
|-------|-------------|
| `default` | Dark theme |
| `solarized-light` | Solarized light |
| `bluey` | Dark blue/purple |
| `windows_xp` | Classic light |
| `green_terminal` | Matrix-style terminal |

---

## Installation & Running

### Desktop App (Recommended)

```bash
git clone https://github.com/Zeptiny/orchid.git
cd orchid/electron
npm install
npm run dev          # Start with Vite dev server
```

### Development Commands

```bash
npm run dev          # Start Electron + Vite dev server
npm run typecheck    # Type-check (strict mode)
npm run test         # Run test suite (Vitest)
npm run build        # Build for production
npm run package      # Package for current platform (AppImage/deb/dmg/nsis)
```

### Requirements

- **Node.js 20+**
- **Ollama** (optional, for local models) — [ollama.com](https://ollama.com/)

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Runtime** | Electron + Node.js |
| **Frontend** | React + TypeScript |
| **State** | XState v5 (actor hierarchy) |
| **LLM** | Vercel AI SDK v5 (composable middleware) |
| **Validation** | Zod v3 (single source of truth) |
| **MCP** | @modelcontextprotocol/sdk (TypeScript) |
| **RAG** | onnxruntime-node + better-sqlite3 |
| **AST** | web-tree-sitter (WASM) |
| **Editor** | Monaco Editor (diff widget) |
| **Terminal** | xterm.js |
| **Build** | Vite + electron-builder |
| **Tests** | Vitest |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ Main Process (Node.js)                                          │
│                                                                 │
│  XState Actors  │  AI SDK Middleware  │  Tool Registry (27)     │
│  (session/agent │  (retry/throttle/   │  zod → TS types         │
│   /subagent/    │   error/quirks)     │  zod → JSON Schema      │
│   interrupt)    │                     │  zod → IPC validation   │
│                                                                 │
│  RAG Worker     │  AST Worker         │  Background Process     │
│  (onnxruntime   │  (tree-sitter       │  Store (PTY)            │
│   + SQLite)     │   + SQLite)         │                         │
│                                                                 │
│  Config         │  OS Keychain        │  MCP Manager            │
│  (3-layer       │  (safeStorage)      │  (@modelcontextprotocol)│
│   deep-merge)   │                     │                         │
└────────────────────────┬────────────────────────────────────────┘
                         │ IPC (contextBridge, zod-validated)
┌────────────────────────┴────────────────────────────────────────┐
│ Renderer Process (Chromium + React)                              │
│                                                                  │
│  Chat Stream  │  Sidebar          │  Command Palette (Cmd+K)     │
│                                                                  │
│  Tool Widgets Side Rail                                          │
│  Monaco Diff │ xterm.js │ FilePreview │ ResultsTable             │
│                                                                  │
│  Preferences (5 tabs) │ Onboarding (6 steps) │ 5 Themes          │
└──────────────────────────────────────────────────────────────────┘
```

---

## Project Structure

```
electron/
  src/
    main/                           # Electron main process
      index.ts                      # App entry, window management
      config/                       # Config system (loader, merge, validation, keychain)
      session/                      # Session persistence
      llm/                          # LLM streaming
        middleware/                  # AI SDK middleware (retry, throttle, error, quirks)
        orchestrator.ts             # Main stream orchestrator
      agents/                       # Agent system
        registry.ts                 # AGENT.md loading, tier resolution
        manager.ts                  # SubagentManager
        xstate/                     # XState machines
      tools/                        # Tool registry + 27 handlers
        filesystem/                 # read, edit, write, read_directory, glob
        search/                     # grep
        process/                    # execute_command, read_output, send_input, terminate
        todo/                       # todo_create, todo_update, todo_list, todo_delete
        web/                        # web_fetch
        rag/                        # rag_search, rag_index
        ast/                        # 5 AST tools
        subagent/                   # delegate_to_subagent, wait, interrupt
        skill/                      # skill (dynamic building, dependency resolution)
        mcp/                        # read_mcp_resource
      mcp/                          # MCP client
      rag/                          # RAG subsystem
      ast/                          # AST subsystem
      skills/                       # Skills system
      personality/                  # Personality system
      commands/                     # Command palette
    renderer/                       # React UI
      components/
        ChatStream.tsx
        Sidebar.tsx
        CommandPalette.tsx
        ToolWidgets/                # Monaco diff, xterm.js, file preview, results table
        Preferences/                # 5-tab preferences window
        Onboarding/                 # 6-step first-run onboarding
      hooks/                        # useChat, useSession, useSubagents, useTodos
      themes/                       # 5 CSS themes
    shared/                         # Shared types (IPC boundary contracts)
    preload/                        # contextBridge API
  tests/
    unit/                           # Unit tests
    integration/                    # Integration tests
    parity/                         # Parity tests (tool/agent/skill/config coverage)
```

---

## Knowledge Compounding

Orchid includes a knowledge compounding system to prevent solved problems from being rediscovered:

- **`docs/solutions/`** — Structured learnings with YAML frontmatter, organized by category
- **`learnings-researcher`** — Agent specialized in searching prior solutions
- **`compound`** — Skill for documenting new solutions
- **`compound-refresh`** — Skill for maintaining and updating existing documentation

---

## Review Findings

All P0 and P1 findings from the code review have been fixed. P2/P3 findings are documented in:
- `docs/plans/ts-electron-migration-review-findings-p2-p3.md`

Deferred features:
- **R19** — Agent graph as primary interface (deferred indefinitely)
- **R20** — Diff-gated approval / permission system (deferred)
- **R22** — Annotated diff code review (deferred, see `docs/plans/deferred-features-todo.md`)
