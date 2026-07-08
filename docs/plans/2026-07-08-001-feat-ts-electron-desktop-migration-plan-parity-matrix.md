---
title: "Parity Matrix — TS/Electron Desktop Migration"
companion: 2026-07-08-001-feat-ts-electron-desktop-migration-plan.md
---

# Parity Matrix

Tracks every capability from the Python TUI against its TypeScript/Electron port status. Each row must reach "ported" and "parity-tested" before parity is declared complete.

Status values: `not-started` | `in-progress` | `ported` | `parity-tested` | `skipped` | `deferred`

---

## Tools (27)

| # | Tool | Python Source | TS Port | Status | Notes |
|---|------|--------------|---------|--------|-------|
| 1 | `read` | `tools/file_manipulation.py` | `tools/filesystem/read.ts` | ported | Binary detection, line limit from config |
| 2 | `edit` | `tools/file_manipulation.py` | `tools/filesystem/edit.ts` | ported | Post-write callbacks (RAG + AST) |
| 3 | `read_directory` | `tools/file_manipulation.py` | `tools/filesystem/read-directory.ts` | ported | ASCII tree output |
| 4 | `glob` | `tools/file_manipulation.py` | `tools/filesystem/glob.ts` | ported | Recursive ** and * patterns |
| 5 | `write` | `tools/file_manipulation.py` | `tools/filesystem/write.ts` | ported | Post-write callbacks, atomic write |
| 6 | `grep` | `tools/search.py` | `tools/search/grep.ts` | ported | Bounded concurrency (semaphore=32), binary detection |
| 7 | `rag_search` | `tools/rag.py` | `tools/rag/search.ts` | ported | Semantic search via embedder |
| 8 | `rag_index` | `tools/rag.py` | `tools/rag/index.ts` | ported | Status/index/clear actions |
| 9 | `todo_create` | `tools/todo.py` | `tools/todo/create.ts` | ported | Dynamic builder (TodoStore dependency) |
| 10 | `todo_update` | `tools/todo.py` | `tools/todo/update.ts` | ported | State machine validation (OPEN→IN_PROGRESS→DONE) |
| 11 | `todo_list` | `tools/todo.py` | `tools/todo/list.ts` | ported | Filter by status and/or subagent_id |
| 12 | `todo_delete` | `tools/todo.py` | `tools/todo/delete.ts` | ported | Dynamic builder |
| 13 | `execute_command` | `tools/exec.py` | `tools/process/execute-command.ts` | ported | Foreground + background + PTY |
| 14 | `web_fetch` | `tools/web_fetch.py` | `tools/web/fetch.ts` | ported | URL validation (SSRF protection), summarize + raw modes |
| 15 | `delegate_to_subagent` | `tools/subagent.py` | `tools/subagent/delegate.ts` | ported | Dynamic tool (built at runtime from agent registry) |
| 16 | `wait_for_subagent` | `tools/subagent.py` | `tools/subagent/wait.ts` | ported | Waits for terminal state |
| 17 | `interrupt_subagents` | `tools/subagent.py` | `tools/subagent/interrupt.ts` | ported | Empty list = cancel all running |
| 18 | `skill` | `tools/skill.py` | `tools/skill/skill.ts` | ported | Dynamic tool, dependency resolution, path traversal protection |
| 19 | `read_mcp_resource` | `tools/mcp_resource.py` | `tools/mcp/resource.ts` | ported | Dynamic builder (MCPManager dependency) |
| 20 | `get_file_skeleton` | `tools/ast.py` | `tools/ast/get-file-skeleton.ts` | ported | Tree-sitter parsing |
| 21 | `get_function` | `tools/ast.py` | `tools/ast/get-function.ts` | ported | FNV-1a change detection |
| 22 | `find_symbol_references` | `tools/ast.py` | `tools/ast/find-symbol-references.ts` | ported | AST symbol store queries |
| 23 | `replace_symbol` | `tools/ast.py` | `tools/ast/replace-symbol.ts` | ported | Ambiguity guard, decorators, atomic write |
| 24 | `rename_symbol` | `tools/ast.py` | `tools/ast/rename-symbol.ts` | ported | Word boundary guard, byte-to-char conversion |
| 25 | `read_output` | `tools/background_io.py` | `tools/process/read-output.ts` | ported | Long-poll, HeadTailBuffer |
| 26 | `send_input` | `tools/background_io.py` | `tools/process/send-input.ts` | ported | PTY stdin, interactive-only guard |
| 27 | `terminate_command` | `tools/background_io.py` | `tools/process/terminate-command.ts` | ported | SIGTERM then SIGKILL |

---

## Agents (26)

| # | Agent | Type | Tier | Status | Notes |
|---|-------|------|------|--------|-------|
| 1 | `general` | internal | bloom | ported | Full tool set + MCP + skill + subagent |
| 2 | `web-fetch` | internal | seed | ported | Summarize mode for web_fetch tool |
| 3 | `implementer` | subagent | bloom | ported | Read/edit/exec + AST + work/plan/commit/debug skills |
| 4 | `explorer` | subagent | seed | ported | Read/grep/glob/exec |
| 5 | `reviewer` | subagent | crown | ported | Fast single-pass review |
| 6 | `correctness-reviewer` | subagent | crown | ported | Always-on code review persona |
| 7 | `security-reviewer` | subagent | crown | ported | Conditional on auth/permissions |
| 8 | `performance-reviewer` | subagent | crown | ported | Conditional on DB/transforms/caching |
| 9 | `maintainability-reviewer` | subagent | bloom | ported | Always-on code review persona |
| 10 | `testing-reviewer` | subagent | bloom | ported | Always-on code review persona |
| 11 | `adversarial-reviewer` | subagent | crown | ported | Conditional on large/risky diffs |
| 12 | `reliability-reviewer` | subagent | crown | ported | Conditional on error handling |
| 13 | `api-contract-reviewer` | subagent | bloom | ported | Conditional on API routes |
| 14 | `coherence-reviewer` | subagent | bloom | ported | Doc review persona |
| 15 | `agent-native-reviewer` | subagent | crown | ported | Always-on code review persona |
| 16 | `architecture-strategist` | subagent | crown | ported | Architecture review |
| 17 | `data-integrity-guardian` | subagent | crown | ported | Data integrity review |
| 18 | `feasibility-reviewer` | subagent | bloom | ported | Doc review persona |
| 19 | `spec-flow-analyzer` | subagent | bloom | ported | Spec analysis |
| 20 | `product-lens-reviewer` | subagent | crown | ported | Doc review persona |
| 21 | `code-simplicity-reviewer` | subagent | bloom | ported | Simplicity review |
| 22 | `scope-guardian-reviewer` | subagent | bloom | ported | Doc review persona |
| 23 | `pr-comment-resolver` | subagent | bloom | ported | PR feedback resolution |
| 24 | `web-researcher` | subagent | sprout | ported | Web + RAG research |
| 25 | `learnings-researcher` | subagent | sprout | ported | Learning doc research |
| 26 | `adversarial-document-reviewer` | subagent | crown | ported | Doc review persona |

Note: Agents referenced in code-review SKILL.md but missing AGENT.md defaults: `project-standards-reviewer`, `deployment-verification-agent`, `previous-comments-reviewer`, `julik-frontend-races-reviewer`, `swift-ios-reviewer`. These are expected to be defined at project level (`.orchid/agents/`). Not all need AGENT.md defaults — users who want these personas must provide their own definitions.

---

## Skills (15)

| # | Skill | Has requires | Resources | Status | Notes |
|---|-------|-------------|-----------|--------|-------|
| 1 | `brainstorm` | No | 5 references | ported | |
| 2 | `code-review` | No | 6 references | ported | 6+ parallel reviewers, merge pipeline |
| 3 | `commit` | No | None | ported | |
| 4 | `commit-push-pr` | No | 2 references | ported | |
| 5 | `compound` | No | 1 asset, 4 refs, 1 script | ported | |
| 6 | `compound-refresh` | No | 1 asset, 4 refs, 1 script | ported | |
| 7 | `debug` | No | 3 references | ported | |
| 8 | `doc-review` | No | 6 references | ported | |
| 9 | `ideate` | No | 6 references | ported | |
| 10 | `lfg` | No | 2 references | ported | Full autonomous pipeline |
| 11 | `plan` | No | 6 references | ported | |
| 12 | `resolve-pr-feedback` | No | 2 refs, 4 scripts | ported | |
| 13 | `simplify-code` | No | None | ported | |
| 14 | `strategy` | No | 2 references | ported | |
| 15 | `work` | `[commit]` | 4 references | ported | Depends on commit skill |

---

## Config Fields (22)

| # | Field | Type | Default | Env Override | Status |
|---|-------|------|---------|-------------|--------|
| 1 | `default_model` | string | `"default/mimo-v2.5"` | `ORCHID_DEFAULT_MODEL` | ported |
| 2 | `tier_models` | dict | All tiers: mimo-v2.5 | - | ported |
| 3 | `ignored_dirs` | list | 20 defaults | `ORCHID_IGNORED_DIRS` | ported |
| 4 | `command_timeout` | int | 30 | `ORCHID_COMMAND_TIMEOUT` | ported |
| 5 | `read_line_limit` | int | 1000 | `ORCHID_READ_LINE_LIMIT` | ported |
| 6 | `grep_max_results` | int | 100 | `ORCHID_GREP_MAX_RESULTS` | ported |
| 7 | `directory_tree_depth` | int | 2 | `ORCHID_DIRECTORY_TREE_DEPTH` | ported |
| 8 | `theme` | string | `"default"` | `ORCHID_THEME` | ported |
| 9 | `personality` | string | `"default"` | `ORCHID_PERSONALITY` | ported |
| 10 | `rag.chunk_size` | int | 2000 | `ORCHID_RAG_CHUNK_SIZE` | ported |
| 11 | `rag.chunk_overlap` | int | 200 | `ORCHID_RAG_CHUNK_OVERLAP` | ported |
| 12 | `rag.top_k` | int | 5 | `ORCHID_RAG_TOP_K` | ported |
| 13 | `rag.max_file_size` | int | 512000 | `ORCHID_RAG_MAX_FILE_SIZE` | ported |
| 14 | `rag.embedding_model` | string | `"fastembed/BAAI/bge-small-en-v1.5"` | `ORCHID_RAG_EMBEDDING_MODEL` | ported |
| 15 | `ast_max_file_size` | int | 1048576 | `ORCHID_AST_MAX_FILE_SIZE` | ported |
| 16 | `mcp_startup_timeout` | float | 60.0 | `ORCHID_MCP_STARTUP_TIMEOUT` | ported |
| 17 | `mcp_per_server_timeout` | float | 10.0 | `ORCHID_MCP_PER_SERVER_TIMEOUT` | ported |
| 18 | `mcp_servers` | dict | context7 (npx) | - | ported |
| 19 | `providers` | dict | default (opencode.ai) | - | ported |
| 20 | `llm_stream_idle_timeout` | float | 300.0 | `ORCHID_LLM_STREAM_IDLE_TIMEOUT` | ported |
| 21 | `llm_stream_retries` | int | 3 | `ORCHID_LLM_STREAM_RETRIES` | ported |
| 22 | `background_command_idle_timeout` | float | 900.0 | `ORCHID_BG_CMD_IDLE_TIMEOUT` | ported |

---

## Commands (12)

| # | Command | Status | Notes |
|---|---------|--------|-------|
| 1 | `/new` | ported | |
| 2 | `/sessions` | ported | Date-grouped picker |
| 3 | `/rename` | ported | |
| 4 | `/delete` | ported | |
| 5 | `/model` | ported | Tabular model picker with discovery |
| 6 | `/theme` | ported | 5 themes |
| 7 | `/personality` | ported | 6 personalities |
| 8 | `/settings` | ported | Preferences window (5 tabs) |
| 9 | `/index-rag` | ported | Background indexing with progress |
| 10 | `/index-ast` | ported | Background indexing with progress |
| 11 | `/rag status` | ported | |
| 12 | `/rag clear` | ported | |

---

## Personalities (6)

| # | Personality | Status | Notes |
|---|-------------|--------|-------|
| 1 | `default` | ported | Concise, direct, friendly |
| 2 | `zen` | ported | Calm, philosophical |
| 3 | `socrates` | ported | Socratic inquirer |
| 4 | `pirate` | ported | Salty sea dog |
| 5 | `stupid` | ported | Lovably clueless |
| 6 | `meow` | ported | A cat with root access |

---

## Themes (5)

| # | Theme | Status | Notes |
|---|-------|--------|-------|
| 1 | `default` (dark) | ported | CSS-based |
| 2 | `solarized-light` | ported | CSS-based |
| 3 | `bluey` | ported | Dark blue/purple |
| 4 | `windows_xp` | ported | Classic light |
| 5 | `green_terminal` | ported | Matrix-style |

---

## Phase 1 Interface Features

| # | Feature | Req | Status | Notes |
|---|---------|-----|--------|-------|
| 1 | Chat stream + sidebar | R15b | ported | Collapsible right sidebar |
| 2 | Interaction states | R15c | ported | Loading/empty/error/partial on all surfaces |
| 3 | Monaco diff widget | R21 | ported | For edit/write/replace_symbol/rename_symbol |
| 4 | xterm.js terminal widget | R21 | ported | For execute_command (background) |
| 5 | File preview widget | R21 | ported | For read tool |
| 6 | Results table widget | R21 | ported | For grep tool |
| 7 | Annotated diff code review | R22 | **deferred** | Deferred — see deferred-features-todo.md |

---

## Deferred Features

| # | Feature | Req | Status | Notes |
|---|---------|-----|--------|-------|
| 1 | Agent Graph as Primary Interface | R19 | **deferred** | Deferred indefinitely — interface will change significantly |
| 2 | Diff-Gated Approval / Permission System | R20 | **deferred** | Deferred — requires holistic security design |
| 3 | Annotated Diff Code Review | R22 | **deferred** | Deferred — see deferred-features-todo.md |

---

## Cross-Platform

| # | Capability | Status | Notes |
|---|-----------|--------|-------|
| 1 | macOS dmg (unsigned beta) | ported | electron-builder config |
| 2 | Windows nsis (unsigned beta) | ported | electron-builder config |
| 3 | Linux AppImage | ported | electron-builder config |
| 4 | Linux deb | ported | electron-builder config |
| 5 | Auto-update (signed release) | ported | electron-updater |
| 6 | OS keychain (safeStorage) | ported | macOS Keychain, Win DPAPI, Linux libsecret |
| 7 | Native module rebuild | ported | better-sqlite3, onnxruntime-node |

---

## TUI Bug Verification

| # | Bug | Trigger Condition | Desktop App Expected Behavior | Status |
|---|-----|-------------------|------------------------------|--------|
| 1 | Single-core subagent parallelism | Spawn 4 subagents | All run in parallel via worker_threads | ported |
| 2 | Context-not-updating | Stream with tool calls | Context (dynamic system prompt) updates between calls | ported |
| 3 | Input-buffer-stuck | Rapid input during stream | Input not stuck after stream completes | ported |
| 4 | Auto-scroll | Long conversation | Correct auto-scroll (no scroll-up when user scrolled up) | ported |
