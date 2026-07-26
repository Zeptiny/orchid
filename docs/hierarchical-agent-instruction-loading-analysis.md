# Hierarchical Agent Instruction Loading

The implementation integrates instruction loading at the stream and central tool-dispatch boundaries—not inside individual `read`, `edit`, or mutation handlers.

Orchid loads root instructions at turn start, discovers nested instructions just-in-time from tool target paths, and defers the first mutation into a newly discovered scope until the model has received those instructions.

## Current architecture

Relevant findings:

- Every model tool call passes through `executeToolCall()` in `electron/src/main/llm/tool-dispatch.ts`, which validates input, checks permission, builds `ToolExecutionContext`, and invokes the handler.
- Paths are resolved against the frozen per-turn `cwd` by `resolveToolPath()` in `electron/src/main/tools/types.ts`.
- `read`, `glob`, `grep`, `get_file_skeleton`, and `replace_symbol` can run in workers. Worker tools receive only `{cwd, config}`, not session or agent state, as shown in `electron/src/main/tools/tool-worker.ts`. Therefore hierarchical loading inside handlers would be inconsistent.
- The system prompt is assembled once per stream in `streamChat()` in `electron/src/main/llm/orchestrator.ts`. It cannot be changed between later tool steps.
- Tool projections are persisted verbatim as conversation history by `makeToolResultMessage()` in `electron/src/main/llm/message-factories.ts`. Automatically injected instructions must therefore be transient or they will accumulate across turns.
- The project runtime is cached indefinitely until explicitly invalidated in `ProjectRuntimeRegistry` in `electron/src/main/project/runtime.ts`. Instruction content should not be stored there unless the invalidation model is expanded.

Orchid now has automatic workspace instruction loading through `ProjectInstructionContext` in `electron/src/main/project/instructions.ts`. A new context is created for every `streamChat()` invocation, which gives main agents and subagents isolated acknowledgement state even when they share a workspace.

## Delivered behavior

```text
Turn starts
    ↓
Load workspace-root instruction source
    ↓
Send it as ephemeral project/user instructions
    ↓
Tool call arrives
    ↓
Resolve all path intents centrally
    ↓
Discover instructions from workspace root → target directory
    ├─ Read operation: execute and attach newly discovered instructions
    └─ Mutation: if instructions are new, do not mutate; return them and request retry
```

The mutation deferral is important. By the time `edit` or `apply_patch` is executing, the model has already decided what to change. Appending previously unseen rules after modifying the file is too late.

On retry, the instructions are already acknowledged and the mutation can proceed normally through permission approval.

## Naming and precedence

Use an exact, configurable allowlist rather than matching arbitrary filenames such as `*AGENT*.md`. Wildcard discovery could accidentally ingest Orchid’s `AGENT.md` persona definitions or unrelated documentation.

Recommended same-directory precedence:

1. `AGENTS.override.md`
2. `AGENTS.md`
3. First existing configured fallback:
   - `CLAUDE.md`
   - `GEMINI.md`
   - Additional user-configured names

Only one alias-family document is selected per directory. For example, if both `AGENTS.md` and `CLAUDE.md` exist, Orchid loads only `AGENTS.md` and records that `CLAUDE.md` was shadowed.

`.github/copilot-instructions.md`, GitHub `NAME.instructions.md` files, and Claude `.claude/rules/*.md` path-glob rules are deliberately not aliases in this release.

This aligns with current conventions:

- Codex loads `AGENTS.override.md`, `AGENTS.md`, and configured fallback filenames from broad to specific scopes. See [OpenAI’s Codex agent-loop description](https://openai.com/index/unrolling-the-codex-agent-loop/).
- Claude loads parent `CLAUDE.md` files at startup and nested ones on demand; it explicitly recommends a `CLAUDE.md` importing `AGENTS.md` to avoid duplicated instructions. See [Claude Code memory documentation](https://code.claude.com/docs/en/memory).
- Gemini supports configurable context filenames and just-in-time discovery when tools access nested paths. See [Gemini CLI context documentation](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/gemini-md.md).
- GitHub recognizes hierarchical `AGENTS.md`, root `CLAUDE.md`/`GEMINI.md`, and its own Copilot instruction formats. See [GitHub custom-instruction documentation](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/add-custom-instructions/add-repository-instructions).

## Hierarchy rules

The selected Orchid workspace should be the trust boundary. Do not walk above `ctx.cwd`, even if it is nested inside a larger Git repository.

For a target such as:

```text
workspace/
├── AGENTS.md
└── electron/
    ├── CLAUDE.md
    └── src/
        ├── AGENTS.override.md
        └── main/index.ts
```

Accessing `electron/src/main/index.ts` loads, in order:

1. `workspace/AGENTS.md`
2. `workspace/electron/CLAUDE.md`
3. `workspace/electron/src/AGENTS.override.md`

Broader instructions remain active; more specific instructions appear later and take precedence when they conflict.

For multiple targets such as `apply_patch`, Orchid computes the union of all ancestor chains. Scope metadata is retained so rules from `renderer/AGENTS.md` are not presented as applying to `main/` files.

Use canonical/effective paths—the same symlink-aware model already used by `resolveToolScope()` in `electron/src/main/permissions/resolver.ts`. Never automatically load instructions through a symlink that resolves outside the workspace.

## Preventing duplication

A turn-scoped resolver tracks:

- Canonical/real path of every loaded instruction file.
- Exact normalized content hash.
- Directories already scanned.
- Imports already expanded.
- Instruction files supplied in the root turn context.
- Documents discovered but not yet acknowledged by a subsequent model step.

Deduplicate in this order:

1. One selected alias-family file per directory.
2. Canonical realpath, preventing symlink/path-alias duplication.
3. Exact content hash, preventing copied files from consuming tokens twice.
4. Import graph identity, with cycle detection and a maximum depth.
5. Per-turn loaded state, preventing root instructions from being reattached on every read.

Do not perform fuzzy or semantic deduplication; similar-looking parent and child instructions can have intentionally different scope.

Shim files such as `CLAUDE.md` containing only `@AGENTS.md` are supported. The target must be an allowlisted instruction filename and stays in the selecting shim's directory scope. Full inline `@path` imports remain deferred. The implemented shim handling includes:

- Relative paths resolved from the containing instruction file.
- Workspace-containment enforcement.
- Realpath deduplication.
- Cycle detection.
- A small maximum depth, such as five.
- A total byte budget.

## Tool trigger policy

| Tool | Discovery behavior |
|---|---|
| `read`, `get_file_skeleton`, `get_function` | Load chain to the file’s directory |
| `read_directory` | Load chain to that directory only |
| `find_symbol_references` | Load only when an explicit `file_path` is supplied |
| `write`, `edit`, `replace_symbol` | Preflight target directory; defer first mutation if new instructions appear |
| `apply_patch` | Preflight every source, destination, add, delete, and move path |
| `rename_symbol` | Must preflight the actual planned affected files |
| `grep`, `glob`, `rag_search` | Do not activate nested instructions; they are broad discovery tools |
| `rag_index`, `ast_index` | No source-instruction activation; they mutate indexes |
| `execute_command`, MCP tools | Cannot be handled reliably without explicit path declarations |

Broad searches should not load instructions from every matching directory. That would flood the context simply because an exploratory grep crossed package boundaries.

### Symbol rename preview/apply

`plan_symbol_rename` now requires a definition-file anchor and performs the read-only, AST-indexed preview. It returns a self-contained manifest of canonical affected paths, source hashes, replacement counts, and a digest. `rename_symbol` accepts only that manifest, exposes every manifest path as a mutation intent, recomputes it before writing, and rejects stale or tampered manifests. This gives permission and instruction preflight the actual write set before mutation.

## Concrete wiring

The implementation contains:

- `electron/src/main/project/instructions.ts`
  - Filename selection
  - Hierarchical discovery
  - Import/shim expansion
  - Canonical-path and hash deduplication
  - Turn-scoped acknowledgement state
- `inputPathIntents` and optional `resultPathIntents` resolvers on `ToolDefinition`
  - Used by both permissions and instruction discovery
  - Removes the duplicated name-based parsing currently in `electron/src/main/permissions/resolver.ts`
- `instructionContext` on `ToolDispatchOptions`
  - Shared by all calls in one model stream
  - Consulted before the permission gate and before worker dispatch
- Root instruction preparation in the shared `streamChat()` setup. Both the main chat path and `createSubagentStreamRunner()` use that stream seam.

Each subagent needs an independent loaded set because it has an isolated model context. Sharing the main agent’s “already loaded” state would prevent the subagent from seeing those rules.

Root project instructions are prefixed to a provider-only user/task message below Orchid’s application instructions. Nested updates are appended only by `toModelOutput()` for the relevant tool call; raw execution output, canonical tool results, UI projection, and persisted history remain unchanged.

## Configuration and limits

`project_instruction_fallback_filenames` defaults to `CLAUDE.md` and `GEMINI.md`; it accepts only unique filename basenames and cannot replace `AGENTS.md` or `AGENTS.override.md`. The total rendered instruction payload has a default limit of 131,072 UTF-8 bytes per agent turn via `project_instruction_max_bytes`. `project_instruction_max_import_depth` independently defaults to five.

All three values are available in home and project config. Project values replace home values under normal merge precedence and may raise or lower them within absolute schema bounds. A source that exceeds the remaining budget is rejected whole and produces a diagnostic rather than being truncated. Configuration and directory scans are frozen per turn, so instruction changes made by a tool become visible only to the next turn.

## Important limitation

This guarantees preflight behavior for Orchid’s path-aware built-in tools with declared intents. It cannot guarantee that nested instructions are seen before:

- `execute_command` runs `sed`, `git apply`, scripts, or generators.
- An MCP tool mutates local files.
- A background process changes files.

A hard guarantee would require execution tools to declare intended filesystem paths, or a separate filesystem/sandbox hook that can stop unknown first-touch mutations. Shell-command parsing alone would not be reliable.

## Delivered test coverage

The resolver, dispatch, rename, parity, and integration suites cover:

- Root and nested instructions loading in broad-to-specific order.
- `AGENTS.override.md` precedence.
- `AGENTS.md` precedence over fallback names.
- Configured fallback ordering.
- Shim imports, import cycles, and import-depth limits.
- Symlink aliases and symlinks escaping the workspace.
- Exact-content deduplication.
- Per-turn and per-agent isolation.
- Concurrent tool calls discovering the same instructions.
- Reads injecting newly discovered instructions only once.
- Mutations leaving files unchanged on their first newly scoped call.
- Mutation retry after instruction acknowledgement.
- Multi-file `apply_patch` across separate scoped branches.
- `rename_symbol` planning all affected files before writes.
- Transient instruction updates not entering persisted tool history.
- Instruction file changes becoming active on the next turn, not midway through the current turn.
- Broad `grep`, `glob`, and RAG searches not activating unrelated nested instructions.
