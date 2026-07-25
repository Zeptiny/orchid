# Project Concepts

Shared domain vocabulary for the orchid project. This file defines terms used across skills, agents, and documentation to ensure consistent understanding.

## Agent System

- **Agent** — A configured LLM persona with a system prompt, allowed tools, and a model tier. Defined in `AGENT.md` files.
- **Internal Agent** — The root agent (`general`) that handles direct user conversation. Cannot be delegated to.
- **Subagent** — A specialized agent spawned by the internal agent for focused tasks (exploration, implementation, review).
- **Model Tier** — Intelligence/speed tradeoff level: `seed` (fastest/cheapest), `sprout`, `bloom`, `crown` (slowest/most capable).
- **Personality** — A tone/style overlay applied to the agent's communication (default, zen, stupid, pirate).

## Skill System

- **Skill** — A reusable workflow template that guides the agent through complex multi-step tasks. Defined in `SKILL.md` files.
- **Skill Dependency** — A skill that must be loaded before another skill runs (declared in `requires:` frontmatter).
- **Skill Resource** — Supporting files under a skill directory: `references/`, `scripts/`, `assets/`.

## Tools

- **Tool** — A discrete capability available to agents (read, edit, execute_command, delegate_to_subagent, etc.).
- **Canonical Tool Result** — The authoritative typed outcome of a tool execution from which audience-specific representations are derived.
- **Agent Projection** — A reasoning-oriented representation of a canonical tool result prepared for model context, including completeness and recovery information when content is omitted.
- **User Projection** — A human-oriented representation rendered from a canonical tool result for live or persisted replay through generic or specialized tool widgets; it is not a second stored source of facts.
- **RAG Search** — Semantic code search using embeddings and cosine similarity over indexed project files.
- **RAG Index** — The vector store (SQLite + numpy) built by indexing and chunking project files.

## Permission System

- **Permission Mode** — The gating behavior for a tool call: `allow` (execute immediately), `ask` (prompt the user), `decide-for-me` (delegate to a seed-tier agent), or `ask-when-flagged` (prompt only when a detection engine flags the call).
- **Risk Class** — A tool's default permission level based on its behavior: read-only tools default to `allow`, mutation/execution/delegation/network/MCP tools default to `ask`.
- **Risk-Class Floor** — In `decide-for-me` and `ask-when-flagged` modes, tools whose effective permission resolves to `allow` execute without evaluation. The floor prevents wasteful seed agent calls on read-only tools.
- **Permission Hierarchy** — The three-tier resolution order for effective permission: tool default → project config → session selector. The highest tier that sets a value wins.
- **Session Selector** — A compact footer control (following the `ReasoningSelector` pattern) that sets a single permission mode for all tools in the current session.
- **Path Containment** — Scope-aware permission resolution for file tools. Paths are resolved against the working directory; the applicable permission is selected from the tool's `inside` or `outside` slot based on containment. The `outside` slot defaults to `ask`. Shell commands are exempt; they are gated by permissions only.
- **Destructive Command Detection** — Pattern-based analysis (modeled on `destructive_command_guard`) that flags dangerous shell commands in `ask-when-flagged` mode. Safe patterns are checked first (allow), then destructive patterns (flag).

## AST Tools

- **Symbol Index** — A standalone SQLite database (`.orchid/ast/symbols.db`) that stores parsed symbol definitions and references across the project, enabling cross-file queries and renames.
- **Tree-sitter** — The incremental parser library used to build concrete syntax trees for source files. Provides error-tolerant parsing and S-expression query matching.
- **AST range** — The byte-offset span of a syntax node within a file, expressed as `(start_line, start_column, end_line, end_column, char_start, char_end)`.
- **Extended range** — An AST range expanded to include preceding comments, docstrings, decorators, and export keywords. Used by `replace_symbol` to replace entire definitions including metadata.
- **FNV-1a** — A fast non-cryptographic hash function used for per-function content change detection in `get_function`. Reports "no changes" when the hash matches the last-sent value.

## Knowledge Management

- **Solution Doc** — A documented problem/solution in `docs/solutions/` with YAML frontmatter for searchability.
- **Concepts File** — `CONCEPTS.md` at repo root — shared vocabulary that grounds all agents in the project's domain language.
- **Compounding** — The process of documenting solved problems so future work avoids re-discovering known solutions.

## Message Queue

- **Message Queue** — An ephemeral, per-session list of user-composed messages waiting to be sent while the agent is working. Rendered above the input field. Strict FIFO processing.
- **Queue Trigger** — The condition that determines when a queued message fires. Two types: "with next request" (stops the current chain at the next AI-SDK step boundary via the orchestrator `stopWhen`, then the queued message starts a fresh chain there — batched with consecutive next-request messages) and "after chain ends" (fires when the chain terminates for any reason). Because the stop is evaluated at a step boundary, a long in-flight tool completes before the stop takes effect; both triggers ultimately fire on the `streaming → idle` transition.

## Workflow Terms

- **Brainstorm** — Requirements exploration through collaborative dialogue. Produces a requirements doc.
- **Plan** — Structured implementation plan with units, dependencies, and test scenarios.
- **Work** — Execution of a plan through task lists, incremental commits, and continuous testing.
- **Code Review** — Structured review using specialized reviewer personas (correctness, security, performance, etc.).
- **Compound** — Documenting a recently solved problem to compound team knowledge.

## Provider System

- **Provider Definition** — Trusted Orchid-owned description of a provider's protocols, authentication methods, models, metadata, pricing dimensions, and optional status capabilities. It contains no user credentials.
- **Provider Connection** — One user-configured account or endpoint attached to a provider definition, with its own credentials, settings, models, and usage attribution. Multiple connections may use the same provider definition.
- **Pricing Snapshot** — The immutable pricing inputs and provenance frozen when a provider request starts and retained with its accounting record.
- **Request Cost Record** — Immutable usage and billing evidence for one attributable provider request. Chain and session costs are derived from these records.
