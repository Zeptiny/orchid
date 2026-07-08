---
title: "Parity Matrix — TS/Electron Desktop Migration"
companion: 2026-07-08-001-feat-ts-electron-desktop-migration-plan.md
---

# Parity Matrix

Tracks every capability from the Python TUI against its TypeScript/Electron port status. Each row must reach "ported" and "parity-tested" before parity is declared complete.

Status values: `not-started` | `in-progress` | `ported` | `parity-tested` | `skipped`

---

## Tools (27)

| # | Tool | Python Source | TS Port | Status | Notes |
|---|------|--------------|---------|--------|-------|
| 1 | `read` | `tools/file_manipulation.py` | `tools/filesystem/read.ts` | not-started | |
| 2 | `edit` | `tools/file_manipulation.py` | `tools/filesystem/edit.ts` | not-started | Post-write callbacks (RAG + AST) |
| 3 | `read_directory` | `tools/file_manipulation.py` | `tools/filesystem/read-directory.ts` | not-started | |
| 4 | `glob` | `tools/file_manipulation.py` | `tools/filesystem/glob.ts` | not-started | |
| 5 | `write` | `tools/file_manipulation.py` | `tools/filesystem/write.ts` | not-started | Post-write callbacks |
| 6 | `grep` | `tools/search.py` | `tools/search/grep.ts` | not-started | Bounded concurrency, binary detection |
| 7 | `rag_search` | `tools/rag.py` | `tools/rag/search.ts` | not-started | |
| 8 | `rag_index` | `tools/rag.py` | `tools/rag/index.ts` | not-started | Status/index/clear actions |
| 9 | `todo_create` | `tools/todo.py` | `tools/todo/create.ts` | not-started | |
| 10 | `todo_update` | `tools/todo.py` | `tools/todo/update.ts` | not-started | State machine validation |
| 11 | `todo_list` | `tools/todo.py` | `tools/todo/list.ts` | not-started | |
| 12 | `todo_delete` | `tools/todo.py` | `tools/todo/delete.ts` | not-started | |
| 13 | `execute_command` | `tools/exec.py` | `tools/process/execute-command.ts` | not-started | Foreground + background + PTY |
| 14 | `web_fetch` | `tools/web_fetch.py` | `tools/web/fetch.ts` | not-started | Summarize + raw modes |
| 15 | `delegate_to_subagent` | `tools/subagent.py` | `tools/subagent/delegate.ts` | not-started | Dynamic tool (built at runtime) |
| 16 | `wait_for_subagent` | `tools/subagent.py` | `tools/subagent/wait.ts` | not-started | |
| 17 | `interrupt_subagents` | `tools/subagent.py` | `tools/subagent/interrupt.ts` | not-started | |
| 18 | `skill` | `tools/skill.py` | `tools/skill/skill.ts` | not-started | Dynamic tool, dependency resolution |
| 19 | `read_mcp_resource` | `tools/mcp_resource.py` | `tools/mcp/resource.ts` | not-started | |
| 20 | `get_file_skeleton` | `tools/ast.py` | `tools/ast/get-file-skeleton.ts` | not-started | |
| 21 | `get_function` | `tools/ast.py` | `tools/ast/get-function.ts` | not-started | FNV-1a change detection |
| 22 | `find_symbol_references` | `tools/ast.py` | `tools/ast/find-symbol-references.ts` | not-started | |
| 23 | `replace_symbol` | `tools/ast.py` | `tools/ast/replace-symbol.ts` | not-started | Ambiguity guard, decorators |
| 24 | `rename_symbol` | `tools/ast.py` | `tools/ast/rename-symbol.ts` | not-started | Word boundary, byte-to-char |
| 25 | `read_output` | `tools/background_io.py` | `tools/process/read-output.ts` | not-started | Long-poll, HeadTailBuffer |
| 26 | `send_input` | `tools/background_io.py` | `tools/process/send-input.ts` | not-started | PTY stdin |
| 27 | `terminate_command` | `tools/background_io.py` | `tools/process/terminate-command.ts` | not-started | SIGTERM then SIGKILL |

---

## Agents (26)

| # | Agent | Type | Tier | Status | Notes |
|---|-------|------|------|--------|-------|
| 1 | `general` | internal | bloom | not-started | Full tool set + MCP + skill + subagent |
| 2 | `web-fetch` | internal | seed | not-started | Summarize mode for web_fetch tool |
| 3 | `implementer` | subagent | bloom | not-started | Read/edit/exec + AST + work/plan/commit/debug skills |
| 4 | `explorer` | subagent | seed | not-started | Read/grep/glob/exec |
| 5 | `reviewer` | subagent | crown | not-started | Fast single-pass review |
| 6 | `correctness-reviewer` | subagent | crown | not-started | Always-on code review persona |
| 7 | `security-reviewer` | subagent | crown | not-started | Conditional on auth/permissions |
| 8 | `performance-reviewer` | subagent | crown | not-started | Conditional on DB/transforms/caching |
| 9 | `maintainability-reviewer` | subagent | bloom | not-started | Always-on code review persona |
| 10 | `testing-reviewer` | subagent | bloom | not-started | Always-on code review persona |
| 11 | `adversarial-reviewer` | subagent | crown | not-started | Conditional on large/risky diffs |
| 12 | `reliability-reviewer` | subagent | crown | not-started | Conditional on error handling |
| 13 | `api-contract-reviewer` | subagent | bloom | not-started | Conditional on API routes |
| 14 | `coherence-reviewer` | subagent | bloom | not-started | Doc review persona |
| 15 | `agent-native-reviewer` | subagent | crown | not-started | Always-on code review persona |
| 16 | `architecture-strategist` | subagent | crown | not-started | Architecture review |
| 17 | `data-integrity-guardian` | subagent | crown | not-started | Data integrity review |
| 18 | `feasibility-reviewer` | subagent | bloom | not-started | Doc review persona |
| 19 | `spec-flow-analyzer` | subagent | bloom | not-started | Spec analysis |
| 20 | `product-lens-reviewer` | subagent | crown | not-started | Doc review persona |
| 21 | `code-simplicity-reviewer` | subagent | bloom | not-started | Simplicity review |
| 22 | `scope-guardian-reviewer` | subagent | bloom | not-started | Doc review persona |
| 23 | `pr-comment-resolver` | subagent | bloom | not-started | PR feedback resolution |
| 24 | `web-researcher` | subagent | sprout | not-started | Web + RAG research |
| 25 | `learnings-researcher` | subagent | sprout | not-started | Learning doc research |
| 26 | `adversarial-document-reviewer` | subagent | crown | not-started | Doc review persona |

Note: Agents referenced in code-review SKILL.md but missing AGENT.md defaults: `project-standards-reviewer`, `deployment-verification-agent`, `previous-comments-reviewer`, `julik-frontend-races-reviewer`, `swift-ios-reviewer`. These are expected to be defined at project level (`.orchid/agents/`). Not all need AGENT.md defaults — users who want these personas must provide their own definitions.

---

## Skills (15)

| # | Skill | Has requires | Resources | Status | Notes |
|---|-------|-------------|-----------|--------|-------|
| 1 | `brainstorm` | No | 5 references | not-started | |
| 2 | `code-review` | No | 6 references | not-started | 6+ parallel reviewers, merge pipeline |
| 3 | `commit` | No | None | not-started | |
| 4 | `commit-push-pr` | No | 2 references | not-started | |
| 5 | `compound` | No | 1 asset, 4 refs, 1 script | not-started | |
| 6 | `compound-refresh` | No | 1 asset, 4 refs, 1 script | not-started | |
| 7 | `debug` | No | 3 references | not-started | |
| 8 | `doc-review` | No | 6 references | not-started | |
| 9 | `ideate` | No | 6 references | not-started | |
| 10 | `lfg` | No | 2 references | not-started | Full autonomous pipeline |
| 11 | `plan` | No | 6 references | not-started | |
| 12 | `resolve-pr-feedback` | No | 2 refs, 4 scripts | not-started | |
| 13 | `simplify-code` | No | None | not-started | |
| 14 | `strategy` | No | 2 references | not-started | |
| 15 | `work` | `[commit]` | 4 references | not-started | Depends on commit skill |

---

## Config Fields (22)

| # | Field | Type | Default | Env Override | Status |
|---|-------|------|---------|-------------|--------|
| 1 | `default_model` | string | `"default/mimo-v2.5"` | `ORCHID_DEFAULT_MODEL` | not-started |
| 2 | `tier_models` | dict | All tiers: mimo-v2.5 | - | not-started |
| 3 | `ignored_dirs` | list | 20 defaults | `ORCHID_IGNORED_DIRS` | not-started |
| 4 | `command_timeout` | int | 30 | `ORCHID_COMMAND_TIMEOUT` | not-started |
| 5 | `read_line_limit` | int | 1000 | `ORCHID_READ_LINE_LIMIT` | not-started |
| 6 | `grep_max_results` | int | 100 | `ORCHID_GREP_MAX_RESULTS` | not-started |
| 7 | `directory_tree_depth` | int | 2 | `ORCHID_DIRECTORY_TREE_DEPTH` | not-started |
| 8 | `theme` | string | `"default"` | `ORCHID_THEME` | not-started |
| 9 | `personality` | string | `"default"` | `ORCHID_PERSONALITY` | not-started |
| 10 | `rag.chunk_size` | int | 2000 | `ORCHID_RAG_CHUNK_SIZE` | not-started |
| 11 | `rag.chunk_overlap` | int | 200 | `ORCHID_RAG_CHUNK_OVERLAP` | not-started |
| 12 | `rag.top_k` | int | 5 | `ORCHID_RAG_TOP_K` | not-started |
| 13 | `rag.max_file_size` | int | 512000 | `ORCHID_RAG_MAX_FILE_SIZE` | not-started |
| 14 | `rag.embedding_model` | string | `"fastembed/BAAI/bge-small-en-v1.5"` | `ORCHID_RAG_EMBEDDING_MODEL` | not-started |
| 15 | `ast_max_file_size` | int | 1048576 | `ORCHID_AST_MAX_FILE_SIZE` | not-started |
| 16 | `mcp_startup_timeout` | float | 60.0 | `ORCHID_MCP_STARTUP_TIMEOUT` | not-started |
| 17 | `mcp_per_server_timeout` | float | 10.0 | `ORCHID_MCP_PER_SERVER_TIMEOUT` | not-started |
| 18 | `mcp_servers` | dict | context7 (npx) | - | not-started |
| 19 | `providers` | dict | default (opencode.ai) | - | not-started |
| 20 | `llm_stream_idle_timeout` | float | 300.0 | `ORCHID_LLM_STREAM_IDLE_TIMEOUT` | not-started |
| 21 | `llm_stream_retries` | int | 3 | `ORCHID_LLM_STREAM_RETRIES` | not-started |
| 22 | `background_command_idle_timeout` | float | 900.0 | `ORCHID_BG_CMD_IDLE_TIMEOUT` | not-started |

---

## Commands (12)

| # | Command | Status | Notes |
|---|---------|--------|-------|
| 1 | `/new` | not-started | |
| 2 | `/sessions` | not-started | Date-grouped picker |
| 3 | `/rename` | not-started | |
| 4 | `/delete` | not-started | |
| 5 | `/model` | not-started | Tabular model picker with discovery |
| 6 | `/theme` | not-started | 5 themes |
| 7 | `/personality` | not-started | 6 personalities |
| 8 | `/settings` | not-started | Preferences window (5 tabs) |
| 9 | `/index-rag` | not-started | Background indexing with progress |
| 10 | `/index-ast` | not-started | Background indexing with progress |
| 11 | `/rag status` | not-started | |
| 12 | `/rag clear` | not-started | |

---

## Personalities (6)

| # | Personality | Status | Notes |
|---|-------------|--------|-------|
| 1 | `default` | not-started | Concise, direct, friendly |
| 2 | `zen` | not-started | Calm, philosophical |
| 3 | `socrates` | not-started | Socratic inquirer |
| 4 | `pirate` | not-started | Salty sea dog |
| 5 | `stupid` | not-started | Lovably clueless |
| 6 | `meow` | not-started | A cat with root access |

---

## Themes (5)

| # | Theme | Status | Notes |
|---|-------|--------|-------|
| 1 | `default` (dark) | not-started | CSS-based |
| 2 | `solarized-light` | not-started | CSS-based |
| 3 | `bluey` | not-started | Dark blue/purple |
| 4 | `windows_xp` | not-started | Classic light |
| 5 | `green_terminal` | not-started | Matrix-style |

---

## Phase 1 Interface Features

| # | Feature | Req | Status | Notes |
|---|---------|-----|--------|-------|
| 1 | Chat stream + sidebar | R15b | not-started | Collapsible right sidebar |
| 2 | Interaction states | R15c | not-started | Loading/empty/error/partial on all surfaces |
| 3 | Monaco diff widget | R21 | not-started | For edit/write/replace_symbol/rename_symbol |
| 4 | xterm.js terminal widget | R21 | not-started | For execute_command (background) |
| 5 | File preview widget | R21 | not-started | For read tool |
| 6 | Results table widget | R21 | not-started | For grep tool |
| 7 | Annotated diff code review | R22 | **deferred** | Deferred — see deferred-features-todo.md |

---

## Cross-Platform

| # | Capability | Status | Notes |
|---|-----------|--------|-------|
| 1 | macOS dmg (unsigned beta) | not-started | |
| 2 | Windows nsis (unsigned beta) | not-started | |
| 3 | Linux AppImage | not-started | |
| 4 | Linux deb | not-started | |
| 5 | Auto-update (signed release) | not-started | electron-updater |
| 6 | OS keychain (safeStorage) | not-started | macOS Keychain, Win DPAPI, Linux libsecret |
| 7 | Native module rebuild | not-started | better-sqlite3, onnxruntime-node |

---

## TUI Bug Verification

| # | Bug | Trigger Condition | Desktop App Expected Behavior | Status |
|---|-----|-------------------|------------------------------|--------|
| 1 | Single-core subagent parallelism | Spawn 4 subagents | All run in parallel via worker_threads | not-started |
| 2 | Context-not-updating | Stream with tool calls | Context (dynamic system prompt) updates between calls | not-started |
| 3 | Input-buffer-stuck | Rapid input during stream | Input not stuck after stream completes | not-started |
| 4 | Auto-scroll | Long conversation | Correct auto-scroll (no scroll-up when user scrolled up) | not-started |
