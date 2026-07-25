---
date: 2026-07-08
topic: ts-electron-desktop-migration
---

# Orchid TypeScript + Electron Desktop Migration

## Summary

A full migration of Orchid from a Python Textual TUI to a TypeScript/Electron standalone desktop app for public release on macOS, Windows, and Linux. The migration reimplements the engine in fresh TypeScript (Python as spec, not translation target), validates the foundation architecture with a thin end-to-end spike, then ports all 27 tools, the agent hierarchy, skills, RAG, AST, MCP, and config to capability parity with a parity-matrix tracking system. Four interface-leverage features (agent graph, diff-gated approval, native tool-call widgets, annotated-diff code review) land in a second phase after engine parity.

---

## Problem Frame

Orchid today is a Python Textual TUI — a multi-agent AI coding assistant whose architecture (hierarchical tiered agents, parallel review skills, RAG, AST tools, MCP) is strong, but whose delivery medium is limiting. The TUI cannot render diffs, images, interactive terminals, or structured tool-call cards. It cannot run detached with OS notifications. It has persistent bugs (single-core subagent parallelism, context-not-updating, input-buffer-stuck, auto-scroll) rooted in hand-rolled orchestration over a text-grid rendering model. Its 1175-line LLM client and 1211-line entangled app.py are maintenance liabilities.

The migration is not a port of the TUI to a GUI — it is a reimplementation that preserves Orchid's capabilities while adopting a delivery medium (Electron + React) and language ecosystem (TypeScript + Vercel AI SDK + XState + zod) that structurally eliminate the TUI's constraints and enable interface features the terminal fundamentally cannot offer.

---

## Actors

- A1. **End user** — a developer using Orchid as a coding assistant on macOS, Windows, or Linux. Configures providers, MCP servers, and model tiers; runs sessions; delegates to subagents; reviews code; approves tool actions.
- A2. **General agent** — the root agent (`general`, tier `bloom`) that receives user input, decides the flow, and delegates to specialized subagents. The only agent that talks directly to the user.
- A3. **Subagents** — specialized agents spawned by the general agent for exploration, implementation, review, or research. Each has a model tier (seed/sprout/bloom/crown), allowed tools, and allowed skills.
- A4. **MCP servers** — external tool servers (stdio or HTTP/SSE) that register tools dynamically at startup and extend the agent's capabilities without code changes.

---

## Key Flows

- F1. **First-run onboarding**
  - **Trigger:** User installs and launches Orchid for the first time.
  - **Actors:** A1
  - **Steps:** App probes environment for installed providers (Ollama, API keys in env) → presents a confirmation screen with pre-filled config → user confirms or adjusts → app seeds default agents, skills, and personalities to user config dir → user lands in an empty session ready to chat.
  - **Error/exit branch:** If no providers discovered (no Ollama, no API keys), the onboarding screen guides the user to either install Ollama (with a link/instructions) or enter an API key inline, so the user is never stuck on a blank confirmation screen.
  - **Outcome:** User can send their first message without manually editing a config file.
  - **Covered by:** R1, R2, R8, R18

- F2. **Agent conversation with tool delegation**
  - **Trigger:** User sends a message in the chat input.
  - **Actors:** A1, A2, A3, A4
  - **Steps:** General agent receives the message → streams a response via AI SDK → if a tool call is emitted, the tool executes (file read, edit, grep, exec, AST op, RAG search, MCP tool, or subagent delegation) → result feeds back into the agent loop → agent continues until no more tool calls → final response rendered in the chat surface.
  - **Error/exit branch:** If the stream stalls (no tokens for the configured idle timeout), the UI shows a "stream stalled" state with retry and abort options. If a tool call errors, the error renders inline with a retry option. If the user presses Escape, the interrupt state machine offers to cancel the agent or subagents (mirroring the TUI's two-stage interrupt).
  - **Outcome:** User sees the agent's response and every tool action it took, in a legible desktop-native surface.
  - **Covered by:** R3, R4, R5, R6, R7, R9, R15c

- F3. **Code review skill execution**
  - **Trigger:** User asks the agent to review changes.
  - **Actors:** A1, A2, A3
  - **Steps:** General agent loads the `code-review` skill → skill spawns 6 parallel reviewer subagents (correctness, security, performance, maintainability, testing, adversarial) → each reviewer runs independently with its own tier and allowed tools → results consolidated → rendered as an annotated diff (Phase 2) or consolidated report (Phase 1 parity).
  - **Error/exit branch:** If one or more reviewers fail (model error, timeout), the review completes with partial results and a visible "N of 6 reviewers completed" indicator. Failed reviewers show their error state with a retry button.
  - **Outcome:** User receives structured code review feedback.
  - **Covered by:** R5, R6, R10, R15c

- F4. **Background command execution**
  - **Trigger:** Agent calls `execute_command` for a long-running process.
  - **Actors:** A2
  - **Steps:** Command launches in a detached process → output streams to an inline terminal surface → user can interact (send input) if the command is interactive → user can minimize the app → OS notification fires on completion or failure → agent receives the final exit code and output.
  - **Error/exit branch:** If the command produces output exceeding a configurable threshold, the terminal surface truncates with a "show more" control. If the command hangs (no output for a configurable timeout), the UI offers to terminate. The user can manually terminate any background command via the terminal surface at any time.
  - **Outcome:** Long-running commands don't tether the user to the window.
  - **Covered by:** R9, R11, R15c

---

## Requirements

**Foundation patterns (baked in during the port)**

- R1. The agent orchestration loop must be modeled as explicit state machines (XState actors), not hand-rolled enums and timers. The general agent, each subagent, and the interrupt states are nested actors with typed events. XState handles orchestration logic (state transitions, typed events, hierarchy). For CPU-bound subagent workloads, subagents may run in isolated Node `worker_threads` or child processes for true parallelism — XState actors provide logical concurrency, not CPU parallelism. This replaces the `InterruptState` enum, `SubagentState` enum, and ad-hoc timer/callback orchestration in the Python `app.py` and `agents/manager.py`.
- R2. LLM streaming, retries, tool calling, error classification, and throttling must be composable middleware on top of a minimal `streamText` call — not a monolithic client. Different agent tiers compose different middleware stacks. This replaces the 1175-line `llm/client.py`.
- R3. Every tool's input and output must be defined by a single schema (zod) that validates IPC, generates TypeScript types for the agent's tool-call parameters, produces JSON Schema for automatic MCP exposure, and drives React rendering of tool results. This replaces the runtime-dict tool registry in `tools/__init__.py`.

**Capability parity (all TUI capabilities must have desktop equivalents)**

- R4. All 27 tools from the Python tool registry must be ported with equivalent behavior: `read`, `edit`, `read_directory`, `glob`, `write`, `grep`, `rag_search`, `rag_index`, `todo_create`, `todo_update`, `todo_list`, `todo_delete`, `execute_command`, `web_fetch`, `delegate_to_subagent`, `wait_for_subagent`, `interrupt_subagents`, `skill`, `read_mcp_resource`, `get_file_skeleton`, `get_function`, `find_symbol_references`, `replace_symbol`, `rename_symbol`, `read_output`, `send_input`, `terminate_command`.
- R5. The hierarchical agent system must be ported: the general agent, all specialized subagents (explorer, implementer, reviewer, web-fetch, and the 10+ code-review/doc-review/research personas), tiered models (seed/sprout/bloom/crown), agent loading from user and project directories, and `AGENT.md` frontmatter parsing.
- R6. The skills system must be ported: skill loading from user and project directories, `SKILL.md` frontmatter parsing, skill dependencies, skill resources (references, scripts, assets), and all default skills including `code-review` (6 parallel reviewers), `compound`, `compound-refresh`, `brainstorm`, `plan`, `work`, and others.
- R7. The RAG pipeline must be ported: file discovery with ignored-dir respect, intelligent chunking, local embeddings, vector storage (SQLite + typed arrays), cosine-similarity search, automatic re-indexing on file edit/write, and configurable chunk size/overlap/top-k/embedding model. The default embedding runtime should be `onnxruntime-node` (native ONNX) to preserve current fastembed performance; `transformers.js` (WASM) is a fallback if native addons prove impractical. The spike must benchmark batch embedding of ≥1000 chunks to validate real-time auto re-indexing is non-intrusive.
- R8. Configuration must be ported with deep-merge of global (`~/.orchid/config.json`) and project (`.orchid.json`) configs, environment variable overrides (`ORCHID_` prefix), and all config fields: providers, tier_models, mcp_servers, theme, personality, command_timeout, read_line_limit, grep_max_results, directory_tree_depth, ast_max_file_size, mcp timeouts, llm stream settings, ignored_dirs, and nested rag config. A native preferences window replaces the TUI's 5-tab settings screen.
- R9. Session management must be ported: session creation, switching, renaming, deletion, persistence to disk, auto-naming after first exchange, and session restore on relaunch. Sessions contain chains (turns), messages, subagent records, todos, and token usage.
- R10. MCP client must be ported: stdio and HTTP/SSE transports, server lifecycle management (start on app launch, shutdown on exit), dynamic tool registration with `mcp::{server_name}::{tool_name}` namespacing (matching the Python source's double-colon separator to avoid collisions), and `read_mcp_resource` for resource URIs. Per-server startup timeout and graceful degradation when a server fails.
- R11. Background command execution must be ported with detached process management, streaming output, interactive input (`send_input`), output reading (`read_output`), termination (`terminate_command`), idle-ownership auto-release, and OS-native notifications on completion/failure.
- R12. Personalities must be ported: loading from `~/.orchid/personalities/` and project directories, `PERSONALITY.md` parsing, appending personality to the agent system prompt, and a UI to switch personality mid-session without restart.
- R13. Themes must be ported as CSS-based desktop themes (not Textual themes). All default themes (default/dark, solarized-light, bluey, windows_xp, green_terminal) must have desktop equivalents. Theme switching is live, no restart.
- R14. The command palette must be ported as a Cmd+K / Ctrl+K palette with fuzzy search across commands, sessions, settings, and navigation targets. All TUI slash-commands (`/new`, `/sessions`, `/rename`, `/delete`, `/model`, `/theme`, `/personality`, `/settings`, `/index-rag`, `/index-ast`, `/rag status`, `/rag clear`) must have palette equivalents.
- R15. AST tools must be ported: tree-sitter parsing (WASM grammars), symbol indexing (SQLite), `get_file_skeleton`, `get_function`, `find_symbol_references`, `replace_symbol`, `rename_symbol`, with support for the languages the Python TUI currently supports. The exact language set must be enumerated in the parity matrix by auditing `src/orchid/ast/queries/` — the set is closed (capability parity, not expansion). Lazy-loading grammars per detected language is acceptable to bound app size.

**Phase 1 interface**

- R15b. The Phase 1 primary interface is a chat stream with a collapsible right sidebar (sessions, subagents, todos, MCP status, index status). This is the capability-parity surface — desktop-native but minimal. R19 (agent graph as primary interface) replaces the sidebar in Phase 2. The sidebar's content sections in Phase 1 mirror the TUI sidebar's capabilities but render as native desktop widgets, not Textual widgets.

- R15c. Every interactive surface (chat, tool widgets, diff panel, command palette, background terminal, preferences) must define four interaction states: loading (streaming in progress), empty (no content yet), error (tool failure or stream stall), and partial (incomplete or truncated output). Each state has consistent messaging and a recovery action (retry, dismiss, or context-appropriate guidance). This is a cross-cutting requirement applied to all Phase 1 surfaces.

**Cross-platform public release**

- R16. The app must ship as a distributable package on macOS (dmg, notarized), Windows (installer or portable, code-signed), and Linux (AppImage and/or deb/rpm).
- R17. Auto-update must be supported so users receive updates without manual reinstall. Auto-update is gated to the signed public release; the unsigned beta phase distributes manually (electron-updater on macOS requires code signing — Gatekeeper blocks unsigned auto-updated apps).
- R18. First-run onboarding must auto-discover available providers (detect Ollama, scan for API keys in environment) and present a confirmation screen — not a blank config file.
- R18b. API keys must be stored via the OS credential store (macOS Keychain, Windows Credential Manager, Linux libsecret) rather than plaintext in `config.json`. Config serialization must redact secrets. Onboarding, session persistence, and log surfaces must mask key material by default (show only last 4 characters).

**Desktop-native interface (Phase 1, alongside engine parity)**

- R21. Tool calls must render as native widgets in a side rail, not text in the chat stream: Monaco diff for edits, inline terminal (xterm.js) for commands, file-preview for reads, results table for grep. Each tool call is a structured persisted event, making sessions replayable timelines.
- R22. Code review must render as a navigable annotated diff where each finding is a marker on the exact line(s) it references — color-coded by reviewer persona, filterable by severity, with reasoning on hover. This replaces the consolidated text report.

**Deferred (future exploration, not in this planning cycle)**

- R19. The agent hierarchy must be renderable as a live node graph (react-flow or equivalent) where each node represents an agent (general or subagent) showing status, tier, active tool, and token spend; edges show delegation and context flow. This is the flagship interface differentiator — the graph is the primary surface, not a sidebar. Deferred indefinitely — the interface will change significantly before this can be added.
- R20. Any `edit`, `write`, or `execute_command` tool call must render a diff-gated approval panel showing the target, exact diff or command, predicted side effects, and rollback plan. The user can approve granularly (per-file, per-command) with three modes: always-prompt, yolo (auto-approve), decide-for-me. Deferred — permission/approval system will be designed and added later.

---

## Acceptance Examples

- AE1. **Covers R1, R4.** Given the general agent is streaming a response and calls `delegate_to_subagent` to spawn an explorer subagent, when the subagent calls `read` and `grep` tools, then both the general agent and the subagent are visible as separate nodes in the XState actor hierarchy, the subagent's tool calls are typed events (not text), and interrupting the subagent does not affect the general agent's state.
- AE2. **Covers R2, R4.** Given a `seed`-tier subagent makes an LLM call that hits a rate limit, when the AI SDK middleware retries, then the retry is transparent (no user-visible error), the throttle middleware prevents immediate re-hit, and the retry count is observable in telemetry — all without touching the streaming logic.
- AE3. **Covers R3, R4.** Given a new `database_query` tool is added with a zod schema defining `query: string` and `connection_id: string` inputs, when the tool is registered, then it is automatically: validated on IPC, type-checked in the agent's tool-call code, exposed as JSON Schema for MCP, and rendered by a default React result component — with zero hand-written serialization or registration code.
- AE4. **Covers R7, R8.** Given a user opens a project for the first time and the RAG index does not exist, when the agent calls `rag_search`, then the system automatically indexes the project (respecting `ignored_dirs` and `rag.max_file_size` from config), the index is stored in `.orchid/rag/` within the project, and subsequent `rag_search` calls use the cached index with incremental re-indexing on file edits.
- AE5. **Covers R11.** Given the agent runs `npm test` as a background command and the user minimizes the window, when the test suite finishes (pass or fail), then an OS notification fires with the exit code, and the user can click the notification to focus the app and see the full output in the inline terminal surface.
- AE6. **Covers R16, R17.** Given a user installed v1.0.0 on macOS, when v1.1.0 is released, then the app auto-downloads the update, notifies the user, and applies it on next restart — without requiring the user to manually download or reinstall.
- AE7. **Covers R21.** Given the agent calls `edit` to modify `src/server.ts`, when the edit completes, then a Monaco diff widget renders the before/after with syntax highlighting in the tool-call side rail, the tool call is persisted as a structured event in the session timeline, and reopening the session replays the diff widget.

---

## Success Criteria

- A user on any of the three platforms can install, configure (with auto-discovered providers), and send their first message to the agent within 5 minutes of first launch.
- Every capability available in the Python TUI is available in the desktop app — verified by a parity matrix where each row is a tool, agent, skill, config field, or command, and each is marked "ported" and "parity-tested."
- The TUI's known bugs (single-core subagent parallelism, context-not-updating, input-buffer-stuck, auto-scroll) do not exist in the desktop app — verified by reproducing the conditions that triggered them in the TUI and confirming the desktop app behaves correctly.
- The three foundation patterns (XState, AI SDK middleware, zod) are demonstrably in use — not retrofitted — meaning the agent loop, streaming, and tool registry are built on them from the first commit.
- A downstream planner (`ce-plan`) can structure the implementation without inventing product behavior, scope boundaries, or success criteria.

---

## Scope Boundaries

### Deferred for later

- Agent graph (R19) — deferred indefinitely; interface will change significantly before this can be added.
- Diff-gated approval (R20) and the broader permission/approval system — deferred; will be designed and added later.
- Multimodal input (paste/drag images, screenshot ingestion) — table-stakes capability but not migration leverage; can be added any time post-parity.
- Embedded LSP diagnostics fed into agent context — feature, not migration foundation.
- Fuzzy matching in edit tool (9 ways, as in opencode) — feature refinement, not migration leverage. Note: this refers to the edit tool's fuzzy string matching for finding replacement targets, NOT the Cmd+K palette's fuzzy search which is in-scope via R14.
- `ask_question` tool for agents to query users with multiple-choice — feature spec, not migration foundation.
- Lateral/BTW subagent (ask without interrupting main flow) — feature spec, not migration foundation.
- Permission/approval system (including R20 diff-gated approval, path sandboxing, yolo-mode session config) — deferred; will be designed and added later in a future planning cycle.
- Visible skill stepper (workflow as live checklist) — depends on R19 (agent graph) being settled first.
- Per-action tier choice with visible cost/speed — feature on top of the XState actor hierarchy, not a migration foundation.
- Session-as-workspace (embedded Monaco editor + file tree + diff panel as the session view, not just chat) — depends on R21 (native widgets); future evolution of the session surface.

### Outside this product's identity

- Editor extension or LSP-server exposure — Orchid is a standalone desktop app, not an editor plugin. The user's editor stays separate; Orchid is its own surface.
- Agent-as-MCP-Server (exposing Orchid's subagents as callable tools for other agents) — ecosystem play, orthogonal to the migration.
- Tools/skills as installable npm packages with a community marketplace — ecosystem strategy, future work.
- Collaborative persistent sessions (real-time multiplayer, Figma-for-agents) — future product surface.
- Autonomous headless mode (GitHub App, CI groundskeeper, auto-fixes issues) — future product surface.
- Token market economy (swarm self-allocates budget via bidding) — research project, not a product feature.

---

## Key Decisions

- **Standalone Electron app, not an editor extension:** The user ruled out non-standalone shapes. Orchid is its own window with its own surfaces. The user's editor stays separate.
- **Fresh TS reimplementation, Python as spec:** The Python codebase is the reference for *what* each subsystem does, not *how* it's written. TS-native patterns (AI SDK, XState, zod) lead. No line-by-line translation.
- **Full engine parity with native tool widgets:** All 27 tools, agents, skills, RAG, AST, MCP, config, sessions, personalities, themes, commands, and background commands port alongside the desktop-native tool-call widgets (R21) and annotated-diff code review (R22). Agent graph (R19) and diff-gated approval (R20) are deferred to a future planning cycle — the interface will change significantly before the graph can be designed, and the permission system needs holistic design. This de-risks the rewrite by separating "does it work" from the more speculative interface surfaces.
- **Capability parity, not behavioral parity:** Every TUI feature gets a desktop-native equivalent, but the UX can change. Settings becomes a native preferences window; themes become CSS; command palette becomes Cmd+K. The TUI layout is not ported 1:1.
- **Approach C (architecture spike + real UI shell):** A thin end-to-end slice (one message → AI SDK stream → one tool call → result rendered) validates the three foundation patterns compose before committing to the full port. The spike's UI becomes the seed of the real shell. Then horizontal porting with a capability inventory + parity tests guarantees completeness and fidelity.
- **Three foundation patterns baked in during the port:** XState actors, AI SDK middleware, zod tool contracts. These are the architecture, not features — adopting them during the rewrite is cheaper than retrofitting after.
- **All three platforms from v1:** macOS, Windows, and Linux. Electron makes cross-platform cheap, but packaging/signing/notarization and UI testing are first-class concerns for a public release.
- **TUI bugs expected to dissolve via TS architecture:** The single-core subagent bug requires `worker_threads`/`child_process` for true CPU parallelism (XState provides logical concurrency, not CPU parallelism). Context-not-updating dissolves via reactive stores. Input-buffer-stuck and auto-scroll dissolve via DOM rendering. If any persist, they become bugs in the new codebase, not carried known-issues.

---

## Dependencies / Assumptions

- **Vercel AI SDK** provides streaming, tool calling, retries, and composable middleware sufficient to replace the generic orchestration portions of the 1175-line `llm/client.py`. However, ~80 lines of `client.py` are litellm-specific bug workarounds (MidStreamFallbackError, empty-choices bug, stream-leak fixes, CustomStreamWrapper.raise_on_model_repetition) that are inapplicable to AI SDK's different streaming internals and must be re-derived against AI SDK's actual failure modes. The spike must validate at least one non-OpenAI provider end-to-end through streaming, not just the happy path.
- **XState actor model** supports nested machines spawning child machines with typed events, sufficient to model the general→subagent hierarchy and the interrupt state machine. The actor granularity (per-subagent, not per-tool-call) is a planning decision.
- **transformers.js** (or equivalent WASM embedding runtime) can run the BGE embedding model in-process with acceptable performance for codebase-scale indexing. If WASM performance is insufficient, the embedding step can run in a Node worker thread or native addon.
- **tree-sitter WASM grammars** are available for all currently-supported languages (Python, JavaScript, TypeScript, TSX, and others). Lazy-loading grammars per detected language is acceptable to bound app size.
- **@modelcontextprotocol/sdk (TypeScript)** is feature-equivalent to the Python `mcp` package for stdio and HTTP/SSE transports, dynamic tool registration, and resource reading.
- **litellm provider breadth** is not fully replicated by AI SDK's built-in providers (~10 official vs litellm's 100+). Orchid primarily targets OpenAI-compatible APIs and Ollama, so the core gap is narrow. However, non-OpenAI-compatible providers (Anthropic, Bedrock, Vertex, etc.) will require custom adapter middleware whose scope must be enumerated during planning by auditing `llm/providers.py` and test coverage. This is potentially a large work item — plan should size it explicitly.
- **Electron auto-update** (electron-updater) supports delta updates and cross-platform distribution via GitHub releases or a compatible update server.

---

## Outstanding Questions

### Resolve Before Planning

*(All blocking questions resolved during brainstorm.)*

- *[Affects R16]* **Signing/notarization infrastructure:** Resolved — unsigned distributions are acceptable initially. Signing/notarization is acquired before public release; unsigned builds are acceptable for dev/beta phases. R16 is met in two stages: unsigned for dev/beta, signed for public release.

### Deferred to Planning

- *[Affects R1]* **XState actor granularity:** Is each tool invocation a child actor (fine-grained, more event traffic) or only each subagent (coarse, simpler charts)? Answer during planning when the event-volume tradeoff is concrete.
- *[Affects R2]* **Middleware vs XState boundary:** Is "interrupted by user" a middleware short-circuit or a state transition that middleware observes? Resolve during planning when both layers are scaffolded.
- *[Affects R3]* **Tool schema co-location:** Are zod schemas co-located with tool handlers (package-per-tool) or centralized in a shared `schemas/` package? Planning decides based on the tool directory structure.
- *[Affects R7]* **Embeddings runtime location:** Do embeddings run in the renderer (transformers.js WASM, no IPC latency, potential UI jank) or in the main process (Node worker thread, proven performance, IPC round-trip for user search)? Benchmark during planning.
- *[Affects R15]* **Tree-sitter grammar bundling:** Bundle all grammars upfront (larger app) or lazy-load per detected language on first use (smaller initial download, first-use latency)? Planning decides based on app-size budget.
- *[Affects R19]* **Graph-as-primary-surface scope:** Does the first version of the agent graph show all nodes at once (full DAG) or focus on the active chain with expandable history? Resolve during Phase 2 planning when the graph feature is designed.

- *[Affects R1, R2]* **Spike gate — XState/AI SDK composition:** If the architecture spike cannot demonstrate a clean XState/AI SDK composition (the streaming model and event model don't conflict over control flow) with one tool executing end-to-end, then R1 and R2 are reopened before the requirements are finalized. This is not a planning detail but a go/no-go validation for the entire foundation.
- *[Needs research]* **Vercel AI SDK provider coverage:** Which of litellm's 100+ providers have direct AI SDK equivalents, and which need custom adapter middleware? Research during planning to scope the provider abstraction layer.
- *[Affects R19-R22 sequencing]* **Intermediate milestone before full parity:** The "full parity first" decision gates the migration's differentiating value (R19-R22) behind the largest risk (porting 27 tools + RAG + AST + MCP + 3 platforms). Should an intermediate shippable milestone (e.g., diff-gated approval on core tools) validate the desktop medium's value before full parity is sunk-cost-committed? Resolve during planning when the tool-port timeline is concrete.
