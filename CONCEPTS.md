# Project Concepts

Shared domain vocabulary for the orchid project. This file defines terms used across skills, agents, and documentation to ensure consistent understanding.

## Agent System

- **Agent** — A configured LLM persona with a system prompt, allowed tools, and a model tier. Defined in `AGENT.md` files.
- **Internal Agent** — The root agent (`general`) that handles direct user conversation. Cannot be delegated to.
- **Subagent** — A specialized agent spawned by the internal agent for focused tasks (exploration, implementation, review).
- **Model Tier** — Intelligence/speed tradeoff level: `seed` (fastest/cheapest), `sprout`, `bloom`, `crown` (slowest/most capable).
- **Personality** — A tone/style overlay applied to the agent's communication (default, zen, stupid, pirate).

## Subagent Live Protocol

- **Live Delta Event** — A typed incremental update from a subagent run (`SubagentDeltaEvent`: `spawned`, `text_delta`, `thinking_delta`, `tool_start`, `tool_args_delta`, `tool_result`, `usage`, `terminal`), replacing full-projection broadcasts. Every delta carries `sessionId`, `subagentId`, `runId`, `sequence`, and `sessionRevision`; deltas are batched into one `SubagentEvent` envelope per IPC flush.
- **Session Revision** — A per-session monotonic counter stamped on every subagent live event and snapshot. The renderer uses it to reject stale snapshots and as the floor when reseeding after hydration-buffer overflow.
- **Durable Handoff** — The transfer of subagent output from ephemeral live state to the persisted `SubagentRecord`. On the live-event path the renderer receives the durable record exactly twice — as a seed at spawn and authoritatively at terminal settlement — never per delta. Snapshots, reseeding after hydration-buffer overflow, and lazy hydration may additionally deliver the record outside that path.
- **Queued State** — A first-class runtime state (`queued`) for a subagent spawn or resume that exceeds the admission limits (`subagents.max_active_global`, `subagents.max_active_per_session`). Queued records park in a bounded FIFO queue (`subagents.max_queued`) and are admitted on terminal transitions with per-session round-robin fairness. The state is ephemeral like `pending`: visible end-to-end (runtime, IPC, delegate result, UI) but never persisted for fresh spawns — a durable row is written only at admission, and a crash loses queued work. Exception: a resume-queued record (one parked by `follow_up_subagent`) keeps its existing durable row via the runtime `_resumeQueued` marker, so the reopened chain and follow-up message survive a crash while queued; cancelling a resume-queued record persists the interrupted state through the normal terminal-wave path instead of being evicted in place.
- **Closed Subagent** — A terminal subagent marked hidden from the dynamic system prompt (`closed` flag, persisted with the durable row) without deleting its session record, chain, or UI entry. Closing frees prompt space once the result is incorporated; closed records cannot be resumed by `follow_up_subagent`.
- **Lazy Hydration** — On-demand materialization of a durable subagent record back into the runtime manager: evicted lean summaries (chain emptied by retention) and records persisted before the current app launch are rebuilt from the session's stored `subagentChains` when a lifecycle tool targets them. The stored row stays the authoritative complete copy; hydration untracks the retention FIFO and resets the persisted-revision entry so re-materialized records are neither deleted mid-use nor skipped by revision-gated checkpoints.

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
- **Provider Facet** — An optional, code-owned driver capability (quota, currency, dynamic pricing, caching, thinking, tiers) with typed metadata consumed generically by UI and accounting. Remote and user data may select among declared options but never construct requests or introduce behavior.
- **Pricing Ladder** — Cost resolution order: API-reported cost wins, then API-reported usage priced by rates resolved provider pricing API → user-set rates → catalog rates. Every resolved cost carries provenance of the rung that produced it.
- **Thinking Policy** — A per-driver/model declaration of reasoning handling: exposure (`readable`, `summary`, `opaque`, `none`), replay rule (`mandatory-in-tool-loop`, `recommended`, `impossible`), and provider request knobs. Replay artifacts are persisted with the chain and stripped on provider/model switch.
- **Service Tier Mechanism** — Provider tiering expressed either as a request parameter (e.g. OpenRouter `service_tier`) or model-name variants (e.g. Neuralwatt `-flex`/`-fast`/`-short`). Variant tiers are grouped under one base model entry with no duplicate rows; selection is per-model with session override.
- **Unified Model Listing** — The single per-connection model list that treats catalog, live-discovered, and user-custom models identically (enable/disable, pricing override, reasoning levels, tier selection), distinguished only by a provenance badge.

## Trusted Projects

- **Trust State** — The posture of a bound project directory: `trusted` (granted and fingerprint-current, or a bare project auto-trusted), `untrusted` (has a project surface with no grant), or `changed` (previously trusted but the surface fingerprint drifted).
- **Project Surface** — Anything a project supplies that Orchid would execute or inject: `.orchid.json`, `.orchid/{agents,skills,personalities}` definitions, root AGENTS.md alias files, and configured MCP servers. A directory with no surface is trusted automatically without prompting.
- **Trust Fingerprint** — A sha256 over the security surface (`.orchid.json` bytes, definition-file listing/hashes, root instruction files; size- and count-capped) recorded at grant time. A mismatch moves the project to `changed` and requires re-confirmation.
- **Trust Report** — The surface diff between a project and the home/global configuration (added/overridden MCP servers, permission rules, AGENTS.md policy changes, model and config overrides, project definitions, instruction files) shown in the trust dialog.
- **Bind-then-Gate** — The trust model: binding any directory succeeds, and every execution path (`chat:send`, MCP start, renderer tools, indexing, session create) independently enforces trust rather than refusing the bind.
