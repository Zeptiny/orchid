---
title: Tool Permission System
date: 2026-07-22
type: requirements
status: confirmed
---

# Tool Permission System

## Summary

A permission middleware layer that gates every tool call before execution. Each tool carries a permission mode (allow, ask, decide-for-me, ask-when-flagged) with defaults by risk class. A three-tier hierarchy resolves the effective mode: tool default, project config, session selector. File tools use scope-aware permissions: paths inside the working directory resolve against an `inside` slot, paths outside resolve against an `outside` slot — both independently configurable. Shell commands are gated by permissions but not path-scoped. Two intelligent modes delegate judgment: "decide for me" asks a seed-tier permission-evaluator agent with conversation context; "ask when flagged" runs destructive-command pattern matching and only prompts on a match.

---

## Problem Frame

Every tool executes immediately when the LLM calls it. There is no approval gate, no destructive-command analysis, and no path containment (except `apply_patch`, which has an ad-hoc `isPathContainedIn` check). An agent can write to `/etc/passwd`, run `rm -rf /`, or delete a database — all without the user seeing a prompt.

The user bears full responsibility for what agents do on their machine, but currently has no mechanism to review, approve, or deny individual tool calls. The only mitigation is not using the tool.

---

## Requirements

**Permission model**

- R1. Every tool has a permission attribute with one of four modes: `allow`, `ask`, `decide-for-me`, `ask-when-flagged`.
- R2. Tools carry a default permission by risk class:
  - Read-only tools default to `allow`: `read`, `grep`, `glob`, `rag_search`, `read_directory`, `read_output`, `get_file_skeleton`, `get_function`, `find_symbol_references`, `list_mcp_resources`, `read_mcp_resource`, `todo_list`, `wait_for_subagent`, `skill`, `ask_question`.
  - Mutation tools default to `ask`: `write`, `edit`, `apply_patch`, `replace_symbol`, `rename_symbol`, `todo_create`, `todo_update`, `todo_delete`, `rag_index`, `ast_index`.
  - Execution tools default to `ask`: `execute_command`, `send_input`, `terminate_command`.
  - Delegation tools default to `ask`: `delegate_to_subagent`, `interrupt_subagents`, `answer_subagent`.
  - Network tools default to `ask`: `web_fetch`.
  - MCP tools (`mcp__*`) default to `ask`.
- R3. Each tool's permission is independently configurable in the UI, including MCP tools.

**Permission hierarchy**

- R4. Effective permission resolves through three tiers: tool default → project config → session selector. The highest tier that sets a value wins.
- R5. Project-level permission overrides live in a dedicated `permissions` section of the existing project config (`.orchid.json`).
- R6. The session selector sets a single mode that applies to all tools for the current session.

**Risk-class floor**

- R7. In `decide-for-me` mode, only tools whose effective permission (after tool default and project config) is `ask` or stricter are sent to the seed agent. Tools that resolve to `allow` execute without a seed agent call.
- R8. In `always-ask` mode (session selector set to `ask`), all tools are gated regardless of risk class, including read-only tools.
- R9. In `ask-when-flagged` mode, only tools whose effective permission is `ask` or stricter are evaluated by the detection engine. Tools that resolve to `allow` execute without evaluation.

**Scope-aware path permissions**

- R10. File tools (`read`, `write`, `edit`, `apply_patch`, `glob`, `read_directory`, `get_file_skeleton`, `get_function`, `find_symbol_references`, `replace_symbol`, `rename_symbol`) resolve all paths against the working directory to determine scope: `inside` (path is within the working directory) or `outside` (path escapes it). This generalizes the existing `isPathContainedIn` check from `apply_patch` to all file tools.
- R11. Each file tool carries two permission slots: `inside` and `outside`. The applicable slot is selected by scope resolution (R10), then the normal permission hierarchy (R4) applies to that slot.
  - Defaults for read file tools: `inside` = `allow`, `outside` = `ask`.
  - Defaults for write file tools: `inside` = `ask`, `outside` = `ask`.
- R12. Both slots accept any of the four permission modes and are independently configurable per tool — in the Permissions tab, in project config, and overridable by the session selector.
- R13. Shell commands (`execute_command`) are not path-scoped. They are gated solely by the permission system. In `allow` mode, shell commands run without restriction.

**Approval interaction**

- R14. When a tool call requires approval, the user sees the tool name, full arguments, and three actions: Approve, Deny, Deny with reason (free text).
- R15. The user cannot edit tool call arguments before approving.
- R16. Denial (with or without reason) is returned to the agent as a tool result, allowing the agent to adapt its approach.
- R17. No approval memory in v1. Every gated call prompts, even if the same tool with similar arguments was approved earlier in the session.

**Decide-for-me mode**

- R18. In `decide-for-me` mode, gated tool calls are sent to the `permission-evaluator` agent (a seed-tier internal agent) for an approve/deny decision.
- R19. The `permission-evaluator` agent is defined as an internal agent type at `electron/src/main/agents/defaults/permission-evaluator/AGENT.md` with `tier: seed`, following the same pattern as `explorer`, `session-namer`, and `web-fetch`. Its system prompt is the AGENT.md body.
- R20. The permission-evaluator receives: tool name, risk class, full tool arguments, working directory, the user's triggering message, and the last N tool calls (name + args summary, truncated to ~200 chars each). The context packet is sent as the user message; the system prompt is the AGENT.md body.
- R21. N is configurable via `permission_history_size` in the config schema (default: 10, range: 0–50). A value of 0 disables history — the evaluator receives only the current call and triggering message.
- R22. The permission-evaluator returns approve or deny with an optional reason. Denial feeds back to the calling agent as a tool result.

**Ask-when-flagged mode**

- R23. In `ask-when-flagged` mode, gated tool calls are analyzed by a destructive-command detection engine before prompting. Only flagged calls prompt the user; unflagged calls execute.
- R24. The detection engine is structured as a pack registry. Each pack contains safe patterns (checked first, match = allow) and destructive patterns (checked second, match = flag). No match on either = allow. Core packs:
  - Filesystem pack — safe: `rm` in temp dirs (`/tmp`, `/var/tmp`, `node_modules/.cache`), `git checkout -b`, `git restore --staged`, `git clean -n`/`--dry-run`, `git push --force-with-lease`. Destructive: `rm -r`/`rm -rf`/`rm --recursive` outside temp dirs, `find ... -delete`/`-exec rm`, `truncate`, `shred`, `unlink` on non-temp paths, `mkfs`, `dd of=/dev/`.
  - Git pack — destructive: `reset --hard`, `checkout -- <path>`, `restore <path>` (without `--staged`), `clean -f`, `push --force`/`-f`, `branch -D`, `stash drop`, `stash clear`.
- R25. The pack registry is extensible. Additional packs (docker, kubernetes, cloud CLIs, databases) can be added without restructuring the engine.
- R26. MCP tools in `ask-when-flagged` mode are always treated as flagged. Unknown tool behavior is treated as dangerous by default.
- R27. File tools within the working directory pass through in `ask-when-flagged` mode (scope is `inside`, which defaults to `allow` for reads and is already gated for writes). File tools outside the working directory are evaluated by the detection engine like any other gated call.

**Session selector**

- R28. The session-level permission selector lives in the input area footer as the leftmost item in the footer-end group (before ReasoningSelector), following the existing `ReasoningSelector` interaction pattern: a compact ghost button (`size="xs"`) with a shield icon, current mode label, and chevron, opening a popover with the four modes and a "Reset to default" option.
- R29. The selector shows the effective mode and whether it is a session override or inherited from config.
- R30. The selector is NOT disabled during streaming. Permission mode changes take effect on the next tool call. This allows the user to tighten permissions mid-stream if the agent heads somewhere unexpected.

**Subagent behavior**

- R31. Subagent tool calls go through the same permission gate as the parent agent. The session selector applies uniformly.

**Permission configuration UI**

- R32. Per-tool permission configuration lives in a new "Permissions" tab in ConfigView (alongside General, Providers, MCP, Tier Models, RAG, Skills, Agents, Personalities).
- R33. Tools are grouped by risk class (Read-only, Mutation, Execution, Delegation, Network, MCP). Each tool row shows: name, risk badge, and mode selector. File tools show both `inside` and `outside` slot selectors.
- R34. MCP tools are grouped under their server name in collapsible sections.
- R35. The tab respects the existing ScopeToggle (Global / Project) pattern. A "Reset all to defaults" button lives in the tab header.

---

## Key Decisions

- **Risk-class floor for decide-for-me.** Without it, every read call would trigger a seed agent evaluation — wasteful in latency and cost. The tool's own default permission acts as the floor; "decide for me" is a resolution strategy for `ask`, not a blanket override.

- **Scope-aware permissions instead of hard containment.** File tools use two permission slots (`inside`/`outside`) rather than a hard boundary. This allows legitimate use cases (reading `/etc/nginx/nginx.conf`, writing to temp) while defaulting outside access to `ask`. The user retains full control — setting `outside` to `allow` is an explicit, visible opt-in rather than an implicit side effect. The scope check determines *which* permission applies, not whether the tool can run at all.

- **Permission selector active during streaming.** Unlike ReasoningSelector (which affects the current generation), the permission mode applies to the *next* tool call. Disabling it during streaming would prevent the user from tightening permissions when they see the agent heading somewhere risky — the exact moment they need it most.

- **Permission-evaluator as internal agent.** Defined as an AGENT.md file alongside other internal agents, not a hardcoded prompt string. This makes it configurable, testable, and consistent with the existing agent infrastructure. The seed tier keeps evaluation fast and cheap.

- **Configurable history size.** The `permission_history_size` config (default 10) balances context quality against seed-tier model capacity. 10 covers a typical intent cycle (read files → search → write). Users on lighter models can reduce it; users wanting richer context can increase it.

- **No approval memory in v1.** Every gated call prompts. This keeps the first iteration simple and avoids the complexity of pattern-based session memory ("allow `npm *` for this session"). Memory is a natural follow-up.

- **MCP tools always flagged in ask-when-flagged.** MCP tools are external and their behavior is unknown. Treating unknown as flagged is the safe default. Users who trust a specific MCP server can override per-tool to `allow`.

- **Seed agent gets conversation context.** Without the user's triggering message and recent tool history, the seed agent can only do generic safety checks — barely smarter than pattern matching. Conversation context enables intent-aware judgment ("user asked to refactor auth, so writing `src/auth/login.ts` is expected").

- **Detection engine as pack registry.** Structured for extensibility. Core packs (filesystem + git) ship in v1. Extended packs (docker, k8s, cloud CLIs, databases) are additive without restructuring.

- **Permission gate in `executeToolCall`.** The gate lives in `tool-dispatch.ts:executeToolCall` — the single choke-point through which every built-in, skill, and MCP tool passes. No XState state changes needed; the AI SDK's `execute` Promise simply doesn't resolve until approval is granted. The XState machine stays in `streaming` state throughout.

---

## Key Flows

- F1. Permission resolution
  - **Trigger:** Any tool call arrives for execution.
  - **Steps:** Resolve effective permission (tool default → project config → session selector). If `allow`, execute. If `ask`, prompt user (F3). If `decide-for-me`, check risk-class floor — if tool resolves to `allow`, execute; else send to permission-evaluator agent (F4). If `ask-when-flagged`, check risk-class floor — if tool resolves to `allow`, execute; else run detection engine (F5).
  - **Covered by:** R1, R4, R6, R7, R9

- F2. Scope-aware path resolution
  - **Trigger:** A file tool call with a path argument.
  - **Steps:** Resolve path against working directory. Determine scope: `inside` (within working directory) or `outside` (escapes it). Select the applicable permission slot (`inside` or `outside`) for the tool. Proceed to permission resolution (F1) using that slot's configured mode.
  - **Covered by:** R10, R11, R12, R13

- F3. User approval
  - **Trigger:** Permission resolution determines `ask`.
  - **Steps:** Display tool name, arguments, and three actions (Approve / Deny / Deny with reason). On Approve, execute. On Deny or Deny with reason, return denial as tool result to the agent.
  - **Covered by:** R14, R15, R16, R17

- F4. Permission-evaluator agent
  - **Trigger:** Permission resolution determines `decide-for-me` and tool passes risk-class floor.
  - **Steps:** Assemble context packet (tool name, risk class, args, working directory, triggering message, last N tool calls with truncated args). Send to `permission-evaluator` agent (seed tier) via existing subagent infrastructure. Evaluator returns approve or deny with optional reason. On approve, execute. On deny, return denial as tool result.
  - **Covered by:** R18, R19, R20, R21, R22

- F5. Destructive command detection
  - **Trigger:** Permission resolution determines `ask-when-flagged` and tool passes risk-class floor.
  - **Steps:** For shell commands, run detection engine (safe patterns first, then destructive patterns). For MCP tools, always flag. For file tools with `inside` scope, pass through. For file tools with `outside` scope, evaluate via detection engine. If flagged, prompt user (F3). If not flagged, execute.
  - **Covered by:** R23, R24, R25, R26, R27

---

## Acceptance Examples

- AE1. Read inside project in default mode
  - **Given:** Session selector is unset (inheriting defaults).
  - **When:** Agent calls `read("src/main.ts")`.
  - **Then:** Scope: inside. Inside slot defaults to `allow`. Executes immediately. No prompt.

- AE2. Read outside project in default mode
  - **Given:** Session selector is unset (inheriting defaults).
  - **When:** Agent calls `read("/etc/nginx/nginx.conf")`.
  - **Then:** Scope: outside. Outside slot defaults to `ask`. User sees approval dialog. User approves. File is read.

- AE3. Write inside project in default mode
  - **Given:** Session selector is unset (inheriting defaults).
  - **When:** Agent calls `write("src/main.ts", content)`.
  - **Then:** Scope: inside. Inside slot defaults to `ask`. User sees approval dialog.

- AE4. Write outside project in allow mode
  - **Given:** Session selector is set to `allow`.
  - **When:** Agent calls `write("/tmp/scratch.json", content)`.
  - **Then:** Session selector overrides all slots to `allow`. Executes immediately. No prompt.

- AE5. Write outside project in default mode
  - **Given:** Session selector is unset (inheriting defaults).
  - **When:** Agent calls `write("/etc/passwd", content)`.
  - **Then:** Scope: outside. Outside slot defaults to `ask`. User sees approval dialog. User denies with reason "never touch system files." Agent receives denial + reason as tool result.

- AE6. Shell command flagged in ask-when-flagged mode
  - **Given:** Session selector is set to `ask-when-flagged`.
  - **When:** Agent calls `execute_command("rm -rf /")`.
  - **Then:** Detection engine flags the command. User sees approval dialog. User denies with reason "never delete root." Agent receives denial + reason as tool result.

- AE7. Safe shell command in ask-when-flagged mode
  - **Given:** Session selector is set to `ask-when-flagged`.
  - **When:** Agent calls `execute_command("npm test")`.
  - **Then:** Detection engine does not flag. Executes immediately. No prompt.

- AE8. Read inside project in decide-for-me mode
  - **Given:** Session selector is set to `decide-for-me`.
  - **When:** Agent calls `read("src/main.ts")`.
  - **Then:** Risk-class floor: read inside defaults to `allow`. Executes immediately. No evaluator call.

- AE9. Write inside project in decide-for-me mode
  - **Given:** Session selector is set to `decide-for-me`.
  - **When:** Agent calls `write("src/main.ts", content)`.
  - **Then:** Risk-class floor: write inside defaults to `ask`. Permission-evaluator evaluates with conversation context and approves. Executes.

- AE10. MCP tool in ask-when-flagged mode
  - **Given:** Session selector is set to `ask-when-flagged`.
  - **When:** Agent calls an MCP tool.
  - **Then:** MCP tools are always flagged. User sees approval dialog.

- AE11. Write to temp in ask-when-flagged mode
  - **Given:** Session selector is set to `ask-when-flagged`. Write outside slot is `ask`.
  - **When:** Agent calls `write("/tmp/build-output.json", content)`.
  - **Then:** Scope: outside. Outside slot is `ask`. Detection engine evaluates — file write to temp is not a destructive shell pattern. Not flagged. Executes immediately.

- AE12. Permission change mid-stream
  - **Given:** Session selector is `allow`. Agent is streaming.
  - **When:** User changes session selector to `ask` mid-stream.
  - **Then:** The next tool call in the stream is gated. Previous calls are unaffected.

---

## Scope Boundaries

**In scope:**
- Permission middleware for all tools (built-in and MCP)
- Four permission modes with risk-class defaults
- Three-tier permission hierarchy (tool → project → session)
- Scope-aware path permissions for file tools (inside/outside slots)
- Approval UX (approve / deny / deny with reason)
- Decide-for-me mode with permission-evaluator agent and conversation context
- Ask-when-flagged mode with destructive-command pattern matching (filesystem + git packs)
- Session selector UI in the input footer (active during streaming)
- Per-tool permission configuration UI (new Permissions tab in ConfigView)
- Project-level permission config section in `.orchid.json`
- Configurable `permission_history_size`

**Out of scope (deferred to future iterations):**
- Approval memory / remember system ("allow this for the session")
- Per-pattern session memory ("allow `npm *`")
- Tool call editing before approval
- Network-level containment (domain restrictions for `web_fetch`)
- Shell sandboxing (containers, VMs, namespaces)
- Audit logging of permission decisions
- Per-directory permission rules within the working directory
- Graduated response / confidence scoring (as in `destructive_command_guard`)
- Extended detection packs (docker, kubernetes, cloud CLIs, databases, terraform, CI/CD)

---

## Dependencies and Assumptions

- The existing `isPathContainedIn` logic in `apply_patch` (`electron/src/main/tools/filesystem/apply-patch.ts`) is the reference implementation for scope resolution. It is generalized to all file tools, not reimplemented from scratch.
- The `ReasoningSelector` component (`electron/src/renderer/components/ReasoningSelector.tsx`) is the reference for the session selector interaction pattern (popover, controlled/uncontrolled open state, outside-click + Escape close).
- The permission-evaluator agent uses the existing internal agent infrastructure (`electron/src/main/agents/defaults/`, AGENT.md with `tier: seed` frontmatter, subagent runner).
- The destructive-command detection engine is a TypeScript implementation modeled on `destructive_command_guard`'s core patterns (filesystem + git). It does not shell out to the Rust binary.
- The permission gate integrates at `executeToolCall` in `electron/src/main/llm/tool-dispatch.ts` — the single dispatch choke-point for all tools. No XState state changes are required; the AI SDK's `execute` Promise awaits the approval round-trip. A new IPC channel (`tool:approval-request` / `tool:approval-response`) carries the approval dialog between main and renderer. A `TOOL_AWAITING_APPROVAL` event type is added for UI state.
- The Permissions tab follows the existing ConfigView tab architecture (`renderTab()` switch, draft/save flow, ScopeToggle for Global/Project scope).
- Project-level permission config lives in the `permissions` key of `.orchid.json`, merged via the existing config layer system (defaults → home → project → env).

---

## Resolved Questions

Previously deferred to planning, resolved during review:

- **Approval pause + XState/AI SDK integration.** The gate lives in `executeToolCall` (tool-dispatch.ts), after Zod validation and before handler execution. The AI SDK's `execute` Promise awaits an IPC round-trip to the renderer for user approval. No XState state changes needed — the machine stays in `streaming` state. New IPC channels: `tool:approval-request` / `tool:approval-response`. New event type: `TOOL_AWAITING_APPROVAL`.

- **Detection engine pattern set.** Two core packs (filesystem + git) with safe-pattern-first evaluation. Structured as an extensible pack registry. Specific patterns enumerated in R24.

- **Per-tool permission config UI.** New "Permissions" tab in ConfigView. Tools grouped by risk class. File tools show inside/outside slot selectors. MCP tools grouped under server name in collapsible sections. ScopeToggle for Global/Project scope.

- **Permission selector in footer.** Leftmost item in footer-end group, before ReasoningSelector. Shield icon + mode label + chevron. Same popover pattern as ReasoningSelector. NOT disabled during streaming — changes take effect on the next tool call.

- **Permission-evaluator agent.** Defined as `electron/src/main/agents/defaults/permission-evaluator/AGENT.md` with `tier: seed`. System prompt is the AGENT.md body. Context packet sent as user message. Follows the same pattern as `explorer`, `session-namer`, `web-fetch`.

- **History size N.** Configurable via `permission_history_size` in config schema. Default: 10. Range: 0–50. Args truncated to ~200 chars each.

---

## Sources and Research

- [destructive_command_guard](https://github.com/Dicklesworthstone/destructive_command_guard) — Rust-based hook for AI coding agents that blocks destructive commands before execution. Uses a pack-based pattern system with safe-pattern-first evaluation, regex matching with severity levels, and context-aware classification. Core packs cover filesystem (`rm -rf`, `find -delete`, `truncate`) and git (`reset --hard`, `checkout --`, `push --force`, `branch -D`, `stash drop/clear`). Extended packs cover databases, Kubernetes, Docker, cloud CLIs, Terraform, CI/CD, and more. The evaluation pipeline (config overrides → heredoc scanning → quick rejection → context sanitization → normalization → pack registry) informs the ask-when-flagged detection engine design.
- Existing `apply_patch` path containment (`electron/src/main/tools/filesystem/apply-patch.ts`, `isPathContainedIn`) — the only tool with directory boundary checking. Reference for generalization.
- Existing `ReasoningSelector` (`electron/src/renderer/components/ReasoningSelector.tsx`) — compact footer popover with session override. Reference for the permission selector UI pattern.
- Existing internal agents (`electron/src/main/agents/defaults/`) — `explorer`, `session-namer`, `web-fetch` defined as AGENT.md files with tier frontmatter. Reference for the permission-evaluator agent definition.
- Existing ConfigView tab architecture (`electron/src/renderer/components/ConfigView.tsx`) — 8-tab horizontal boxed tab bar with draft/save flow and ScopeToggle. Reference for the Permissions tab.
- Tool dispatch choke-point (`electron/src/main/llm/tool-dispatch.ts`, `executeToolCall`) — single dispatch point for all tools. Integration point for the permission gate.
