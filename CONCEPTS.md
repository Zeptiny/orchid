# Project Concepts

Shared domain vocabulary for the stupidex project. This file defines terms used across skills, agents, and documentation to ensure consistent understanding.

## Agent System

- **Agent** — A configured LLM persona with a system prompt, allowed tools, and a model tier. Defined in `AGENT.md` files.
- **Internal Agent** — The root agent (`general`) that handles direct user conversation. Cannot be delegated to.
- **Subagent** — A specialized agent spawned by the internal agent for focused tasks (exploration, implementation, review).
- **Model Tier** — Intelligence/speed tradeoff level: `tolo` (fastest/cheapest), `tainha`, `papudo`, `papaca` (slowest/most capable).
- **Personality** — A tone/style overlay applied to the agent's communication (default, zen, stupid, pirate).

## Skill System

- **Skill** — A reusable workflow template that guides the agent through complex multi-step tasks. Defined in `SKILL.md` files.
- **Skill Dependency** — A skill that must be loaded before another skill runs (declared in `requires:` frontmatter).
- **Skill Resource** — Supporting files under a skill directory: `references/`, `scripts/`, `assets/`.

## Tools

- **Tool** — A discrete capability available to agents (read, edit, execute_command, delegate_to_subagent, etc.).
- **RAG Search** — Semantic code search using embeddings and cosine similarity over indexed project files.
- **RAG Index** — The vector store (SQLite + numpy) built by indexing and chunking project files.

## AST Tools

- **Symbol Index** — A standalone SQLite database (`.stupidex/ast/symbols.db`) that stores parsed symbol definitions and references across the project, enabling cross-file queries and renames.
- **Tree-sitter** — The incremental parser library used to build concrete syntax trees for source files. Provides error-tolerant parsing and S-expression query matching.
- **AST range** — The byte-offset span of a syntax node within a file, expressed as `(start_line, start_column, end_line, end_column, char_start, char_end)`.
- **Extended range** — An AST range expanded to include preceding comments, docstrings, decorators, and export keywords. Used by `replace_symbol` to replace entire definitions including metadata.
- **FNV-1a** — A fast non-cryptographic hash function used for per-function content change detection in `get_function`. Reports "no changes" when the hash matches the last-sent value.

## Knowledge Management

- **Solution Doc** — A documented problem/solution in `docs/solutions/` with YAML frontmatter for searchability.
- **Concepts File** — `CONCEPTS.md` at repo root — shared vocabulary that grounds all agents in the project's domain language.
- **Compounding** — The process of documenting solved problems so future work avoids re-discovering known solutions.

## Workflow Terms

- **Brainstorm** — Requirements exploration through collaborative dialogue. Produces a requirements doc.
- **Plan** — Structured implementation plan with units, dependencies, and test scenarios.
- **Work** — Execution of a plan through task lists, incremental commits, and continuous testing.
- **Code Review** — Structured review using specialized reviewer personas (correctness, security, performance, etc.).
- **Compound** — Documenting a recently solved problem to compound team knowledge.
