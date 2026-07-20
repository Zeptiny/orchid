# Full Audit S4 — Agent Tools, AST, RAG & MCP

**Date:** 2026-07-16  
**Mode:** report-only (no fixes applied)  
**Intent:** Tool sandboxing, process/MCP blast radius, AST/RAG correctness, performance, agent tool surface.  
**Scope:**
- `electron/src/main/tools/**`
- `electron/src/main/ast/**`
- `electron/src/main/rag/**`
- `electron/src/main/mcp/**`
- `electron/src/main/project/**`
- `electron/src/main/skills/registry.ts`
- `electron/src/main/personality/**`
- `electron/src/shared/types/{tool,skill,todo}.ts`
- `electron/src/shared/mcp/**`

## Review team

| Reviewer | Role |
|----------|------|
| correctness | always |
| testing | always |
| maintainability / standards / agent-native / learnings | always (combined secondary) |
| security | conditional |
| reliability | conditional |
| performance | conditional |
| adversarial | conditional |
| kieran-typescript | conditional |

**Team size:** 8 specialized + 1 combined secondary

## Verdict

**Agent tools are full user-privilege FS + shell with no R20 sandbox.** Four **P0** security issues (path escape, unrestricted shell, web_fetch SSRF, project MCP auto-spawn). Reliability **P0**: quit does not reap background process groups; MCP startup timeout can close healthy servers while still marked connected. Correctness **P1** cluster: RAG partial reindex wipe, embedder mismatch at search, rename_symbol ignores file_path. Cross-ref S1/S2 on tool:execute and wait_for_subagent.

---

## P0 — Critical (8)

| # | Title | File:line | Reviewers | Confidence | Autofix |
|---|-------|-----------|-----------|------------|---------|
| 1 | Filesystem tools have no project path sandbox | `tools/types.ts:89` | security, adversarial | 95–100 | manual |
| 2 | `execute_command` unrestricted shell RCE as desktop user | `process/execute-command.ts:222` | security, adversarial | 95–100 | manual |
| 3 | `web_fetch` classic SSRF (no host/IP allowlist; redirects follow) | `tools/web/fetch.ts:87` | security, adversarial | 85–100 | manual |
| 4 | Project `.orchid.json` MCP servers auto-spawn arbitrary commands | `mcp/transport.ts` + project-registry + config merge | security, adversarial | 90 | manual |
| 5 | App quit never terminates background process groups | `main/index.ts:314` + background-store | reliability | 92 | gated_auto |
| 6 | MCP overall startup timeout tears down healthy servers but leaves status connected | `mcp/manager.ts:153` | reliability | 88 | gated_auto |
| 7 | Tool-dispatch timeout abandons detached shell process groups | `tool-dispatch` + execute-command | adversarial | 90 | gated_auto |
| 8 | Agent tool path never runs Zod validation before handlers | `llm/tool-dispatch.ts:144` | kieran-typescript | 88 | gated_auto |

*Note: #8 is type-safety/correctness at the agent tool boundary; elevated to P0 by kieran-ts for primary execution path.*

### Highlights

**1–2. Open agent boundary** — `resolveToolPath` keeps absolutes; shell=`true` by default; full `process.env`. Documented R20 deferral is live production risk under prompt injection.

**3–4. Network + config composition** — `web_fetch` + project-merged `mcp_servers` turn untrusted repos into local process spawn + SSRF.

**5–7. Orphan processes** — Detached groups survive quit and outer tool timeout; only some paths SIGKILL.

---

## P1 — High (24)

| # | Title | File:line | Reviewers | Confidence | Autofix |
|---|-------|-----------|-----------|------------|---------|
| 9 | MCP SSE arbitrary URLs + headers (SSRF) | `mcp/transport.ts:33` | security | 75 | manual |
| 10 | Child processes inherit full `process.env` (secret leak) | background-store / execute | security | 75 | gated_auto |
| 11 | Renderer `tool:execute` still unrestricted FS read (S1) | `ipc/tool.ts:36` | security | 75 | manual |
| 12 | AST `rename_symbol` requires `file_path` but never uses it | `ast/rename-symbol.ts:21` | correctness | 95 | gated_auto |
| 13 | RAG partial-path index deletes all other indexed files | `rag/indexer.ts:386` | correctness | 90 | gated_auto |
| 14 | `rag_search` always local ONNX; index may use API embedder | `tools/rag/search.ts:72` | correctness | 90 | gated_auto |
| 15 | `read_mcp_resource` treats MCP error strings as success | `tools/mcp/resource.ts:60` | correctness | 90 | gated_auto |
| 16 | MCP runner shutdown abandons hung `client.close` after 3s | `mcp/manager.ts:497` | reliability | 82 | gated_auto |
| 17 | HF model download fetch has no timeout | `rag/embedder.ts:572` | reliability | 95 | gated_auto |
| 18 | AST/RAG index workers no overall timeout/cancel | `ast/indexer.ts:376` | reliability | 85 | gated_auto |
| 19 | Foreground `waitForExit` unbounded after kill | `execute-command.ts:299` | reliability | 80 | gated_auto |
| 20 | RAG SQLite no `busy_timeout` (AST has 5000) | `rag/store.ts:244` | reliability | 78 | safe_auto |
| 21 | RAG holds full vector corpus as `number[][]` | indexer + store | performance | 90 | manual |
| 22 | `glob` fully sync + unbounded matches | `filesystem/glob.ts` | performance, adversarial | 92 | gated_auto |
| 23 | `grep` full-tree full-file load, no size bound | `search/grep.ts` | performance, adversarial | 88 | gated_auto |
| 24 | AST stores every reference; tools return unbounded | ast store + tools | performance | 85 | gated_auto |
| 25 | Main RAG search cache stale after worker reindex | `rag/store.ts` cache | adversarial | 80 | gated_auto |
| 26 | Concurrent AST rename partial multi-file write | `rename-symbol.ts` | adversarial | 75 | gated_auto |
| 27 | Explicit `any` in `zodToJsonSchema` conversion | `tools/registry.ts:84` | kieran-ts | 95 | gated_auto |
| 28 | Tree-sitter surface entirely `any`-typed | `ast/parser.ts:34` | kieran-ts | 92 | gated_auto |
| 29 | Fallback MCP manager partial object cast to full MCPManager | `tools/index.ts:67` | kieran-ts | 90 | gated_auto |
| 30 | MCP tool inputs passthrough Zod | `mcp/manager.ts:656` | kieran-ts, security | 50–85 | gated_auto |
| 31 | MCP config untyped Record cast at project boundary | `project-registry.ts:18` | kieran-ts | 82 | manual |
| 32 | Interactive PTY path untested | process tools | testing | 90 | manual |
| 33 | `rag_index` / `rag_search` handlers never executed in tests | tools/rag | testing | 93 | manual |
| 34 | AST indexing uses live `getConfig()`, not frozen project runtime | `ast/indexer.ts:217` | maintainability | 90 | gated_auto |
| 35 | `getBuiltinToolRegistryForRuntime` caches first options forever | `tools/index.ts:284` | maintainability | 80 | gated_auto |
| 36 | MCP allowlist naive regex vs minimatch for builtins | `orchestrator.ts:784` | standards | 85 | gated_auto |
| 37 | Empty `allowed_tools` semantics diverge main vs subagent | registry + subagent-runner | agent-native | 75 | gated_auto |
| 38 | No agent tool to list MCP resources | mcp/resource | agent-native | 80 | manual |

---

## P2 — Moderate (18)

| # | Title | File:line | Reviewers | Confidence |
|---|-------|-----------|-----------|------------|
| 39 | Skill resource path no realpath (symlink escape) | `skill/skill.ts:202` | security, adversarial | 50–75 |
| 40 | AST rename write without containment | `rename-symbol.ts:111` | security | 50 |
| 41 | web_fetch unescaped URL/title in XML | `fetch.ts:341` | security | 50 |
| 42 | Glob/grep from `/` when absolute directory_path | multi | security | 75 |
| 43 | ensureIndexed waiters after failed concurrent index | `ast/indexer.ts:123` | correctness | 88 |
| 44 | Sticky `default_project_dir` memory vs disk abort | `workspace.ts:89` | correctness | 85 |
| 45 | RAG `readAndHash` ignores frozen config for max_file_size | `indexer.ts:597` | correctness | 82 |
| 46 | AST `initializedProjects` never re-indexes if DB cleared | `indexer.ts:156` | correctness | 80 |
| 47 | grep concurrent can exceed max_results | `grep.ts:261` | correctness | 78 |
| 48 | background_command_idle_timeout never kills idle processes | background-store | reliability | 72 |
| 49 | wait_for_subagent unbounded (S2 P0) | wait.ts | reliability | 70 |
| 50 | HeadTailBuffer Buffer.concat every append | head-tail-buffer | performance | 82 |
| 51 | RAG/AST discovery Promise.all fan-out | indexers | performance | 78 |
| 52 | MCP sequential server startup | manager.ts | performance | 76 |
| 53 | writeTool timeout does not cancel server work | manager.ts | adversarial | 75 |
| 54 | write/edit full content / LCS blowup | write/edit | adversarial | 80 |
| 55 | atomicWrite temp name collision concurrent writers | ast/utils | adversarial | 70 |
| 56 | Background process union not discriminated | background-store | kieran-ts | 80 |
| 57 | Todo storage unchecked casts | shared/todo.ts | kieran-ts | 78 |
| 58 | send_input / wait_ms / agentScope visibility gaps | testing | 85–92 |
| 59 | CLAUDE.md documents non-existent `layers.ts` | CLAUDE.md | standards | 100 |
| 60 | seedDefaults copies only SKILL.md not resources | skills/registry | agent-native | 85 |
| 61 | loadSkills mutates process-wide registry | skills/registry | maintainability | 80 |
| 62 | No agent-facing AST index management tool | tools/ast | agent-native | 75 |
| 63 | Stale Python MCP learning only | docs/solutions | learnings | 90 |

---

## P3 — Low (6)

| # | Title | File:line | Reviewers | Confidence |
|---|-------|-----------|-----------|------------|
| 64 | Interactive PTY uses user SHELL with full env | background-store | security | 50 |
| 65 | MCP error prefix-based detection fragile | manager.ts | correctness | 75 |
| 66 | drainAbort controllers unused | background-store | reliability | 65 |
| 67 | Runtime registry keyed by untyped `object` | tools/index.ts | kieran-ts | 80 |
| 68 | Embedder non-null tensor assertions | embedder.ts | kieran-ts | 72 |
| 69 | Skill catalog embedded in Zod `.describe()` | skill.ts | agent-native | 65 |
| 70 | Todo notify createRequire electron | tools/index.ts | maintainability | 70 |
| 71 | MCP string `Error:` protocol vs structured isError | manager + orchestrator | standards | 75 |

---

## Deduplication notes

| Merged from | Into |
|-------------|------|
| security + adversarial path sandbox | #1 |
| security + adversarial shell RCE | #2 |
| security + adversarial web_fetch SSRF | #3 |
| security + adversarial project MCP | #4 |
| kieran + S2 tool-dispatch no Zod | #8 |
| performance + adversarial glob/grep | #22–23 |
| S1 tool:execute | #11 |
| S2 wait unbounded | #49 |

---

## Residual risks

1. Product intentionally grants coding agent local shell + FS until R20.
2. User-approved MCP servers are full host trust.
3. ONNX/tree-sitter supply chain out of tool-layer scope.
4. Background store process-global with partial session/agentScope isolation.
5. Windows process-group kill unproven.
6. AST/RAG workers fall back to main-thread if worker JS missing (UI freeze).

---

## Testing gaps (union)

- Path containment for `../` and absolute paths (once sandbox lands)
- SSRF: localhost, metadata, redirect-to-private
- Project mcp_servers no auto-start without consent
- Child env excludes credential vars
- Symlink escape skill + FS
- Tool timeout kills detached process groups
- Quit reaps background groups
- MCP startup timeout leaves usable or clean-all-down state
- rename_symbol file_path scoping
- Partial RAG reindex preserves other files
- API embed index + local search mismatch
- read_mcp_resource isError on Error: strings
- Interactive PTY + send_input + wait_ms
- agentScopeId process isolation
- rag_* handler-level tests
- ensureIndexed after worker failure
- Main RAG cache invalidation after worker index

---

## Coverage

| Item | Value |
|------|--------|
| Specialized agents | 8 + 1 secondary |
| Fixes applied | **none** |
| Cross-refs | S1 #1–2, S2 wait/tool abort |

---

## Suggested fix priority (later)

1. P0: path sandbox (R20) + env scrub + web_fetch SSRF + project MCP trust gate  
2. P0: quit/timeout reaps detached process groups; MCP startup timeout semantics  
3. P0: Zod validate on agent tool path  
4. P1: RAG partial reindex + embedder consistency + rename_symbol scoping  
5. P1: glob/grep caps; vector memory; index cancel  
6. P1: list MCP resources; frozen config through AST/RAG  
