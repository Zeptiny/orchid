# Orchid Full Code Audit — Synthesis

**Date:** 2026-07-16  
**Branch context:** `feat/ts-electron-migration` (tree audit, not single PR diff)  
**Mode:** report-only — **no fixes applied**  
**Method:** 6 sequential multi-agent sections → merge

## Reports

| Section | File | Focus |
|---------|------|--------|
| S1 | [S1-process-shell-ipc.md](./S1-process-shell-ipc.md) | Main/preload/IPC trust boundary |
| S2 | [S2-session-agents-llm.md](./S2-session-agents-llm.md) | Session, agents, LLM, subagents |
| S3 | [S3-providers-config.md](./S3-providers-config.md) | Providers, vault, config, accounting |
| S4 | [S4-tools-ast-rag-mcp.md](./S4-tools-ast-rag-mcp.md) | Tools, AST, RAG, MCP, project |
| S5 | [S5-renderer-ui.md](./S5-renderer-ui.md) | Renderer UI, races, perf |
| S6 | [S6-agent-native.md](./S6-agent-native.md) | Agent–user parity |
| **Master** | [FINDINGS-MASTER.md](./FINDINGS-MASTER.md) | **All 282 cross-section-deduped findings** |

---

## Executive verdict

Orchid’s **Electron multi-agent coding core is feature-rich and partially hardened** (credential vault redaction, catalog signing, accounting freeze, strong coding tools). It is **not yet a hardened desktop trust boundary** and **not yet agent-native for product management**.

| Area | Verdict |
|------|---------|
| IPC trust (renderer → main) | **Fail closed incomplete** — P0 RCE/exfil paths |
| Agent tools (coding) | **Powerful by design** — P0 open FS/shell until R20 |
| Session / LLM runtime | **Hang + orphan risks** — P0 wait/Esc/cross-session flush |
| Providers / secrets | **Good design, broken end-to-end flags + races** |
| Renderer UX | **P0 dual session state** under Settings |
| Agent-native product shell | **~54% high-priority outcomes** — shell orphaned |

**Ship readiness:** Do not treat current IPC + tool surfaces as multi-tenant or hostile-renderer safe. For a single-user desktop coding agent, prioritize P0 hang/orphan/RCE and dual-session UI before polish.

---

## Top ship-blockers (cross-section, deduplicated)

### Tier 0 — Security / trust (must address for any “secure agent” claim)

| ID | Issue | Sections | Severity |
|----|--------|----------|----------|
| T0-1 | `config:save` → MCP stdio **RCE** (arbitrary command) | S1, S3, S4 | P0 |
| T0-2 | Project `.orchid.json` **auto-starts** untrusted MCP servers | S4 | P0 |
| T0-3 | Filesystem tools **no path sandbox** (absolute + `..`) | S1, S4 | P0 |
| T0-4 | `tool:execute` (renderer) unrestricted absolute reads | S1, S4 | P0 |
| T0-5 | `execute_command` unrestricted shell + full env | S4 | P0 |
| T0-6 | `web_fetch` SSRF (localhost/metadata/redirects) | S4 | P0 |
| T0-7 | Env-auth + generic endpoint can **exfiltrate process.env** | S3 | P0 |
| T0-8 | HTTPS custom endpoints no destination allowlist | S3 | P1 |

### Tier 1 — Runtime correctness / hangs

| ID | Issue | Sections | Severity |
|----|--------|----------|----------|
| T1-1 | `wait_for_subagent` **unbounded**; idle watchdog paused | S2, S4 | P0 |
| T1-2 | Esc cancel + timeout **orphans subagents** | S1, S2 | P0 |
| T1-3 | `interrupt_subagents` **flushStateCallbacks** unblocks peer waits | S2 | P0 |
| T1-4 | Tool timeout / cancel **does not abort** underlying work | S2, S4 | P1 |
| T1-5 | History `JSON.parse` tool args can **crash entire turn** | S2 | P1 |
| T1-6 | RAG partial reindex **wipes rest of index** | S4 | P1 |
| T1-7 | `rag_search` embedder may **mismatch** API-indexed vectors | S4 | P1 |
| T1-8 | App quit **does not reap** detached background process groups | S4, S1 | P0 |
| T1-9 | MCP startup timeout closes healthy servers but leaves **connected** | S4 | P0 |
| T1-10 | `allowInsecureHttp` dropped on resolve/request path | S3 | P0 |

### Tier 2 — Multi-store / lifecycle races

| ID | Issue | Sections | Severity |
|----|--------|----------|----------|
| T2-1 | Concurrent submit_api_key + disconnect leaves live key | S3 | P0 |
| T2-2 | validateConnection can re-enable disabled/disconnected | S3 | P0 |
| T2-3 | Vault + connection multi-step without joint lock | S3 | P1 |
| T2-4 | MCP lease not released on `unregisterChatIPC` | S1, S2 | P1 |
| T2-5 | before-quit no re-entrancy / logger close timeout | S1 | P1 |
| T2-6 | bgcmd:snapshot unscoped cross-session | S1 | P1 |
| T2-7 | Session rename/change_model **false success** when not selected | S1 | P1 |

### Tier 3 — Product UX / agent-native

| ID | Issue | Sections | Severity |
|----|--------|----------|----------|
| T3-1 | Dual `useSession()` Config vs Chat (settings desync) | S5 | P0 |
| T3-2 | Composer send lock sticks after silent gates | S5 | P1 |
| T3-3 | Skill seed incomplete (no scripts/refs/assets) | S4, S6 | P0 |
| T3-4 | Empty `allowed_tools` semantics diverge | S4, S6 | P0 |
| T3-5 | Product shell orphaned (session/model/config/providers) | S3, S6 | P0 |
| T3-6 | MCP resources not listable; read not on general | S6 | P0 |
| T3-7 | No `ast_index` tool (RAG has `rag_index`) | S6 | P0 |
| T3-8 | Unbounded history + full session JSON rewrite | S2 | P1 |
| T3-9 | Stream UI thrash (100ms rebuild, unbatched tokens) | S5 | P1 |

---

## Counts by section (deduped within section; cross-section overlaps intentional)

| Section | P0 | P1 | P2+ | Notes |
|---------|----|----|-----|--------|
| S1 IPC | 2 | ~25 | ~30 | Trust boundary |
| S2 Runtime | 3 | ~22 | ~20 | Hang/orphan core |
| S3 Providers | 4 | ~18 | ~25 | Vault races + flags |
| S4 Tools | 8 | ~24 | ~25 | R20 + process/MCP |
| S5 Renderer | 1 | ~14 | ~18 | Dual session |
| S6 Agent-native | 6–8 | ~12 | ~14 | Parity |

*Do not sum raw P0s as unique issues — see Top ship-blockers for unique IDs (~25–30 distinct critical themes).*

---

## Architecture themes

1. **Trust model is single-user desktop, coded as if renderer is trusted.** Many “P0s” are intentional agent power (shell/FS). Still, **IPC must not amplify** a compromised renderer into host RCE without gates (MCP config, tool:execute, set_workspace).

2. **Multi-store mutations without joint locks** (vault/connection, chat/MCP leases, subagent global map) create races under concurrent IPC.

3. **Frozen ProjectRuntime is incomplete** — AST/RAG/config paths still call live `getConfig()` in places.

4. **Agent-native split personality** — excellent coding toolkit; product management stays UI/IPC-only; general agent prompt still says “terminal.”

5. **Institutional learnings gap** — `docs/solutions/` is essentially one stale Python MCP note; S1–S6 findings are not compounded.

---

## Recommended fix waves (no work done in this audit)

### Wave A — Trust boundary (1–2 weeks focus)

1. MCP config: privileged channel + confirm + command allowlist; no auto-start project MCP without trust UI  
2. Path sandbox on all FS/search/AST/process cwd (R20) + renderer tool:execute confinement  
3. web_fetch private-IP/redirect guards  
4. Env-auth allowlist + generic endpoint SSRF policy  
5. bgcmd:snapshot session visibility  

### Wave B — Runtime safety

1. wait_for_subagent deadline + AbortSignal  
2. Esc/dispose always cancelRunning; fix flushStateCallbacks session scope  
3. AbortSignal through tools; kill detached groups on timeout + before-quit  
4. Safe history JSON.parse; tool_call id matching  
5. RAG partial reindex + embedder consistency  

### Wave C — Providers lifecycle

1. Thread allowInsecureHttp end-to-end  
2. Per-connection joint lock; conditional health updates  
3. Soft-recover bad config at startup  

### Wave D — UI + agent-native

1. Single session store  
2. InputArea send lock + failure hygiene  
3. Recursive skill seed; unify allowed_tools empty; list MCP resources; ast_index; session/model tools  
4. Stream perf coalesce  

### Wave E — Debt / tests

1. Split chat.ts / providers IPC; break main/index cycles  
2. Export Zod schemas for contract tests  
3. Compound learnings into `docs/solutions/`  

---

## Explicit non-goals of this audit

- No code fixes (report-only)  
- No dependency CVE scan (`npm audit` separate)  
- No packaging/signing deep dive (optional S7)  
- No re-review of protected docs as deletion targets  
- Bulk skill/agent markdown prose quality (only registry/seed wiring)

---

## How to re-run

```text
# Per section: multi-agent report-only with path-scoped intent
# Output: docs/code-review-reports/full-audit-YYYY-MM-DD/S{n}-*.md
# Then merge P0/P1 into SYNTHESIS.md (this file)
```

Specialized reviewers used across the audit:

| Always-on | Conditional (by section) |
|-----------|---------------------------|
| correctness, testing, maintainability, project-standards, agent-native, learnings | security, reliability, performance, api-contract, adversarial, kieran-typescript, julik-frontend-races |

Approximate agent spawns: **~55–65** across S1–S6.

---

## Bottom line

1. **Security:** Treat MCP config + unrestricted tool FS/shell + web_fetch as the critical attack surface.  
2. **Stability:** Fix unbounded waits, orphan subagents/processes, and provider health races before more features.  
3. **UX:** Fix dual session state under Settings.  
4. **Product vision:** Agent-native coding works; agent-native **app control** does not — close that gap deliberately (or document isolation).  

All detailed findings with evidence and suggested fixes live in the section reports above.
