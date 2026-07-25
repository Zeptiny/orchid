# Full Audit S6 — Agent-Native Product Surface

**Date:** 2026-07-16  
**Mode:** report-only (no fixes applied)  
**Intent:** Agent–user parity: tools, skills, agents, commands, system prompt, registry wiring.  
**Scope:**
- `electron/src/main/tools/**` (registration surface)
- `electron/src/main/agents/registry.ts` + defaults (wiring)
- `electron/src/main/skills/registry.ts`
- `electron/src/renderer/commands/**`
- `electron/src/shared/commands.ts`
- `electron/src/main/llm/system-prompt.ts`
- Cross-refs S1–S5 orphan features

## Review team

| Reviewer | Role |
|----------|------|
| agent-native | always (primary) |
| testing | always |
| correctness / api-contract / standards / learnings | combined |

**Team size:** 3 spawn groups (agent-native + testing + combined)

## Verdict

**Coding core is strong (~90%); product shell is orphaned (~10%).** Overall high-priority UI outcomes agent-accessible **~54%**. **P0:** incomplete skill seed (no scripts/refs/assets), empty `allowed_tools` semantics split, MCP resource list + allowlist holes, AST index tool missing, session/model/config/providers UI-only. General agent still describes itself as a **terminal** agent.

---

## Score summary (agent-native)

| Principle | Score | Status |
|-----------|-------|--------|
| Action parity (UI ↔ agent) | 28 / 52 high-priority | ⚠️ 54% |
| Tools as primitives | 24 / 27 | ✅ 89% |
| Context injection | 5 / 12 types | ❌ 42% |
| Shared workspace (code) | 6 / 7 | ✅ |
| CRUD completeness (entities) | 3 / 10 | ❌ 30% |
| Capability discovery | 3 / 7 | ❌ |
| **Overall (coding + shell)** | **~62%** | **NEEDS WORK** |

---

## P0 — Critical (6)

| # | Title | File:line | Reviewers | Confidence | Autofix |
|---|-------|-----------|-----------|------------|---------|
| 1 | `seedDefaults` copies only SKILL.md/AGENT.md — omits scripts/references/assets | `skills/registry.ts:190` (+ agents) | correctness-api, S4 | 100 | gated_auto |
| 2 | `allowed_tools: []` semantics split — registry denies all; subagent-runner rewrites to `*` | `tools/registry.ts:49` | correctness-api, S4 | 100 | gated_auto |
| 3 | No `list_mcp_resources`; `_uriMap` private | mcp tools | agent-native | 100 | manual |
| 4 | `read_mcp_resource` registered but **not** in general `allowed_tools` | `general/AGENT.md` | agent-native, correctness-api | 90 | safe_auto |
| 5 | No AST index management tool (UI has `/ast index`; RAG has `rag_index`) | tools/ast | agent-native | 100 | manual |
| 6 | Session lifecycle + model change fully UI-only | commands + session IPC | agent-native | 100 | manual |

### Additional P0 product orphans (from agent-native map)

| # | Title | Notes |
|---|-------|-------|
| 7 | Config get/save + providers CRUD agent-orphaned | S3 confirmed 0%; raw FS ≠ parity |
| 8 | (Related) Dynamic prompt has no product context | model, MCP, indexes, personality |

---

## P1 — High (12)

| # | Title | File:line | Reviewers | Confidence | Autofix |
|---|-------|-----------|-----------|------------|---------|
| 9 | Omitted `allowed_skills` defaults to `['*']` — several default agents inherit full skills | `agents/registry.ts:87` | correctness-api | 100 | gated_auto |
| 10 | Skill discovery claimed in system prompt but prompt injects no skill inventory | system-prompt + skill.ts | correctness-api | 100 | gated_auto |
| 11 | general AGENT.md identity: “terminal-based coding agent” in Electron desktop | `general/AGENT.md:39` | correctness-api | 100 | safe_auto |
| 12 | Command palette actions without agent tools (/cd, /model, /sessions, /settings, …) | `renderer/commands/registry.ts` | agent-native, correctness-api | 85 | manual |
| 13 | Workspace rebind (`/cd`) no agent equivalent | session IPC | agent-native | 100 | manual |
| 14 | Personality switch UI-only | commands | agent-native | 100 | manual |
| 15 | Definition CRUD (agents/skills/personalities) UI-only | defs IPC | agent-native | 100 | manual |
| 16 | Dynamic system prompt starves product context | system-prompt.ts | agent-native | 100 | gated_auto |
| 17 | Updater UI-only (S1) | updater | agent-native | 100 | manual |
| 18 | General MCP allowlist hard-coded to context7/example | general AGENT.md | agent-native | 75 | gated_auto |
| 19 | system-prompt branches largely untested | system-prompt.ts | testing | 100 | manual |
| 20 | web-fetch summarizer production wiring untested | tools/index.ts | testing | 75 | manual |

---

## P2 — Moderate (10)

| # | Title | File:line | Reviewers | Confidence |
|---|-------|-----------|-----------|------------|
| 21 | CLAUDE.md invents wrong agent/command paths and formats | electron/CLAUDE.md | standards | 100 |
| 22 | loadAgents/loadSkills mutate process-wide tool singleton | registries | correctness-api | 75 |
| 23 | docs/solutions Python-only; Electron agent surface unrepresented | docs/solutions | learnings | 90 |
| 24 | MCP allowlist minimatch vs ad-hoc regex | orchestrator.ts | correctness-api, S4 | 75 |
| 25 | Runtime tool registry WeakMap cache untested | tools/index.ts | testing | 75 |
| 26 | Agent invalid-tier skip untested | agents/registry | testing | 100 |
| 27 | Reserved internal agents only partially guarded in tests | agents/registry | testing | 75 |
| 28 | buildModelResults/buildSessionResults untested | commands/registry | testing | 100 |
| 29 | Command execute error paths untested | commands/registry | testing | 75 |
| 30 | File delete no first-class tool (shell only) | tools | agent-native | 75 |
| 31 | `rag_index` Decision-enum mild anti-pattern | tools/rag | agent-native | 70 |

---

## P3 — Low (4)

| # | Title | File:line | Reviewers | Confidence |
|---|-------|-----------|-----------|------------|
| 32 | Silent agent skip on invalid frontmatter (no log) | agents/registry | correctness-api | 85 |
| 33 | shared/commands.ts overclaimed as command inventory | CLAUDE.md | standards | 100 |
| 34 | Vacuous keyboard tests in command-palette suite | tests | testing | 100 |
| 35 | Theme / working-set / activity chrome | — | agent-native | intentional |

---

## Capability map (abbreviated)

| Domain | Agent-accessible? |
|--------|-------------------|
| File edit / grep / shell / AST symbols / RAG search+index / todos / subagents / skills / web_fetch / MCP tools | ✅ Strong |
| MCP resource list + read on general | ❌ / ⚠️ |
| AST index status/clear/force | ❌ |
| Sessions CRUD + model change + /cd | ❌ |
| Config + providers + tier models | ❌ |
| Definition manage (agent/skill/personality) | ❌ |
| Updater | ❌ |
| Theme / onboarding / API key paste | ⚪ Human OK |

---

## What's working well

1. Coding-domain tool set (27 builtins + dynamic MCP tools)
2. Todo full CRUD + UI events (model pattern for other entities)
3. Dynamic context: cwd, tree, todos, subagents, bg commands
4. Prompt-native skills/subagents via SKILL.md/AGENT.md
5. Shared project workspace (no agent_output sandbox)
6. Correct human-gating of API keys and updater install

---

## Residual risks

1. Users who already seeded have incomplete `~/.orchid/skills/*` trees — re-seed must not clobber edited SKILL.md
2. Dual registry (process singleton vs ProjectRuntime) footgun for new IPC
3. Fallback agent with `allowed_tools: '*'` if general missing
4. Skill catalog in Zod describe → token bloat

---

## Testing gaps

- Seed temp home → resources exist → skill tool reads refs
- Empty `allowed_tools` same on main stream vs subagent
- Explicit `allowed_skills` on every default agent
- COMMANDS[] → tool or documented UI-only map
- system-prompt static/dynamic/XML escape suite
- getBuiltinToolRegistryForRuntime cache identity
- buildModelResults/buildSessionResults empty states

---

## Coverage

| Item | Value |
|------|--------|
| Agents | agent-native + testing + combined |
| Fixes applied | **none** |
| Cross-refs | S1 updater, S3 providers/config, S4 MCP/AST tools, S5 command palette |

---

## Suggested fix priority (later)

1. P0: recursive skill/agent seed; unify empty allowed_tools  
2. P0: list_mcp_resources + allow read_mcp_resource on general; ast_index tool  
3. P0: session + model tools (same SessionManager as UI)  
4. P1: safe config_get/update + providers_list; prompt product context  
5. P1: rewrite general identity for Electron; fix CLAUDE.md paths  
6. P1: explicit allowed_skills on all defaults; tests for seed/allowlist/prompt  
