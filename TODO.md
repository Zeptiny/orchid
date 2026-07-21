# TODO

Internal backlog for Orchid. User-facing summary lives in the [README known limitations](README.md#known-limitations) section. Remove or archive items as they ship.

---

## Bugs

- Scrolling up in chat is impossible
- RAG onnxruntime may not be being shipped correctly

## Agent quality

- LLM can deviate from the intended architecture
  - `AGENT.md` and docs should constrain this
- LLM can produce dead code, incomplete implementations, or ignore the plan
  - Reviewers should catch this — investigate why they don’t always
  - Subagents should make it easier to follow plans end-to-end
- Skills and agents are not fully updated for the current harness capabilities

## Interface

- Verify every tool has generating and running states
  - `edit` / `write` appear to lack them
- Execute-command widget should show the command **description** in the title, with the raw command in the dropdown / body
- Allow viewing background commands and sending input when needed
- Errors are not returned / surfaced correctly in the UI
  - Check that subagent errors propagate properly
  - Example: API returned 429 but no message appeared in the interface
- Add dedicated UI handling instead of the generic structured viewer for:
  - RAG: `rag_search`, `rag_index`
  - Process: `read_output`, `send_input`, `terminate_command`
  - AST: `ast_index`, `get_file_skeleton`, `get_function`, `find_symbol_references`, `replace_symbol`, `rename_symbol`
  - Todo: `todo_create`, `todo_update`, `todo_list`, `todo_delete`
  - Web / subagents / skills: `web_fetch`, `delegate_to_subagent`, `wait_for_subagent`, `interrupt_subagents`, `skill`
  - MCP: `read_mcp_resource`, `list_mcp_resources`, and dynamically registered MCP tools

## General backlog

- **P0: Realpath-based path sandboxing for all filesystem tools** — `resolveToolPath` is lexical-only; symlinks inside the project can escape the working directory. `apply_patch` has a lexical containment check but it is bypassable via directory symlinks. `write` / `edit` have no containment at all. Reuse `assertPathInScopeRoot` from `defs/paths.ts` (realpath root + parent + leaf). Apply uniformly to all mutating filesystem tools. (code review 2026-07-19, P0)
- **P1: `apply_patch` sync matching can block the event loop** — `seekSequence` is O(n×m×4) synchronous. Large file + non-matching pattern blocks the main process indefinitely; `Promise.race` timeout cannot fire. Add a line-count guard in `applyChunksToContent` and `.max()` on the patch Zod schema. (code review 2026-07-19, P1)
- **P1: `apply_patch` agent projector emits redundant full diffs** — full `<old_string>` / `<new_string>` per file can exceed the 20KB offload threshold, stripping per-file error info the agent needs. Make the projector compact: per-file status + errors only; omit diffs (UI renderer keeps them). (code review 2026-07-19, P1)
- Tools should start executing as soon as their generation is complete, even if the model is still generating output for other tool calls
- RAG/AST post-write callback + automatic reindex when changes are detected (also support reindex via commands / manual triggers that the post-write path does not cover)
- `wait_for_subagent` can send duplicated information
- Remaining work from `docs/code-review-reports/2026-07-15-electron-simplification-review.md`
- Verify remote embedding models work correctly
- Subagent viewing / live output polish
- Do not re-parse markdown on every stream update
- Concurrency control for file locking
- LSP integration
- SSH / remote connection support
- `AGENTS.md` handling
  - Also an `/init` command for it
  - When the `read` tool opens a file, rules from `AGENTS.md` in that directory (and ancestors) should be applied
- User message queue (queue follow-ups while the agent is busy)
- Session compaction / compression (summarize or drop older turns so long sessions stay within context limits)
- Thinking-level selection
  - Harder than it looks: providers differ on supported levels and whether they honor them
  - User should be able to configure thinking variants per model
  - Agents/subagents should be able to pin a specific level
    - Possible encoding: `<provider>/<model>/<thinking_level>` (using `:` conflicts with OpenRouter; `-` can collide with model names)
    - Default: per-model vs global — still undecided
- Analytics dashboard

## Compound system improvements

- **Do not change this until the design is clearer**
- Multiple primary agent types (general, plan, etc.) that can be switched mid-conversation

## `ask_question` tool

- Support multiple multiple-choice questions
  - Each with a title and description
- Always allow a free-text answer option
- Allow several questions in one tool call
  - e.g. two 4-option questions plus one 2-option question
- Under consideration: let subagents use this tool to ask the main agent / user
  - Main agent must notice immediately (status update + leave `wait_for_subagent` if any subagent has a question)
  - Main agent must be able to decline answering (e.g. research-only, or forward to the user)

## Approval / permission system

- Evaluate integrating checks from [destructive_command_guard](https://github.com/Dicklesworthstone/destructive_command_guard)
- Tools would gain a permission attribute, with modes such as:
  - Always ask
  - Allow everything / yolo
  - Decide for me (seed-tier agent decides per call)
    - Claude Code has a similar system worth studying
  - Ask when flagged
    - Only when `destructive_command_guard` (or equivalent) flags the action
- Resolve paths in tools so agents cannot read/write outside the working directory by path tricks
  - Shell commands can still escape; with permissions and user approval of every command, responsibility stays with the user
- Also recognize which directories a command/tool will touch
  - Ask before editing / viewing files outside the current project dir
  - Skipped in yolo mode

## Subagents

- Side / “BTW” agent (ask a question without interrupting the main flow)
  - Best UI placement still TBD
  - Read-only tools only
  - Multi-turn? Still under consideration
  - Useful for clarifications without stopping work
    - e.g. “How does function X interact with system Y?”

## Needs improvement

- Fuzzy matching in the `edit` tool
  - e.g. OpenCode has multiple fuzzy-match strategies

## Configuration UI

- Adding a provider currently allows API key and env auth at the same time
  - Show only one method at a time, selected by toggle
- Adding an MCP server currently allows command and URL at the same time
  - Show only one transport at a time, selected by toggle
  - No way to set an auth token yet

## Considerations

- Should the `read` tool work on directories as well?
