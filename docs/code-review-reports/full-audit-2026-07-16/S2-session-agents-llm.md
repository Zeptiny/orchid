# Full Audit S2 — Session, Agents & LLM Runtime

**Date:** 2026-07-16  
**Mode:** report-only (no fixes applied)  
**Intent:** Session lifecycle, XState agent orchestration, LLM streaming, subagent runner, interrupt/abort, history/working-set correctness and reliability.  
**Scope:**
- `electron/src/main/session/**`
- `electron/src/main/agents/**`
- `electron/src/main/llm/**`
- `electron/src/main/tools/subagent/**`
- `electron/src/shared/types/{session,message,chain,subagent,agent,agent-scope}.ts`

## Review team

| Reviewer | Role |
|----------|------|
| correctness | always |
| testing / maintainability / standards / agent-native / learnings | always (combined) |
| reliability | conditional |
| performance | conditional |
| api-contract | conditional |
| kieran-typescript | conditional |
| adversarial | conditional |

**Team size:** 11 equivalent lenses

## Verdict

**Core runtime has multiple turn-breaking and hang paths.** Three **P0** issues: unbounded `wait_for_subagent` (freezes parent turn), Esc-timeout orphaning subagents, and cross-session `flushStateCallbacks` unblocking peer waits. Strong **P1** cluster around tool cancel, history corruption, dual SubagentRecord models, and unbounded history/persist cost.

---

## P0 — Critical (3)

| # | Title | File:line | Reviewers | Confidence | Autofix |
|---|-------|-----------|-----------|------------|---------|
| 1 | `wait_for_subagent` can hang the agent turn forever | `agents/manager.ts:264` + `tool-dispatch.ts` + `wait.ts` | reliability, adversarial | 100 | gated_auto |
| 2 | Esc-cancel + interrupt timeout orphans running subagents | `ipc/chat.ts` + interrupt-machine | adversarial (corr P2 related) | 92 | gated_auto |
| 3 | `interrupt_subagents` `flushStateCallbacks` unblocks peer-session `wait_for_subagent` | `tools/subagent/interrupt.ts` + `manager.ts` | adversarial | 90 | manual |

### 1. Unbounded wait_for_subagent

**Why:** Tool is exempt from timeout; idle watchdog paused during tools; hung child freezes parent in streaming forever (token burn, slot held).

**Fix:** Config-backed wait deadline + AbortSignal; fail tool with `isError`; never unbounded.

### 2. Esc path orphans subagents

**Why:** Second Esc finalizes main INTERRUPTED without `cancelRunning`; 5s timeout disposes main only. Children keep tools/LLM/persist. `forceStop` cancels children — Esc path inconsistent.

**Fix:** On agent cancel / dispose-after-`agentCancelled`, always `cancelRunning(sessionId)`.

### 3. Cross-session waiter flush

**Why:** Session B `interrupt_subagents` → `flushStateCallbacks()` resolves **all** process-wide waiters, including session A still-running subagents → parent A continues on empty/incomplete results.

**Fix:** Only flush waiters for records just made terminal / same `sessionId`.

---

## P1 — High (22)

| # | Title | File:line | Reviewers | Confidence | Autofix |
|---|-------|-----------|-----------|------------|---------|
| 4 | `JSON.parse` on history tool_calls can crash entire stream turn | `llm/orchestrator.ts:249` | correctness, adversarial, testing | 100 | safe_auto |
| 5 | Subagent final result ignores tool-only work (empty wait payload) | `agents/manager.ts:463` | correctness | 100 | gated_auto |
| 6 | Interrupted subagent drops in-flight partial assistant text | `agents/manager.ts:533` | correctness | 75 | gated_auto |
| 7 | `toApiMessages` match-set keeps filtered-out tool_call ids | `llm/history.ts:167` | correctness | 75 | gated_auto |
| 8 | Tool timeout does not cancel underlying work | `llm/tool-dispatch.ts:270` | reliability, adversarial | 100 | gated_auto |
| 9 | Retry backoff sleep ignores abort/cancel | `llm/middleware/retry.ts:43` | reliability | 100 | gated_auto |
| 10 | Retry only covers `doStream()` setup, not mid-stream drops | `llm/middleware/retry.ts:86` | reliability | 75 | manual |
| 11 | Conversation history unbounded; full re-send every turn | session + history + orchestrator + chat | performance, adversarial | 88–90 | manual |
| 12 | Every chain/subagent persist rewrites full pretty-printed session JSON + fsync | `session/storage.ts` + manager | performance | 85 | manual |
| 13 | SubagentManager never prunes records (process lifetime) | `agents/manager.ts` | performance, adversarial, maintainability | 85–93 | gated_auto |
| 14 | Subagent tool events → debounced full-session rewrites of all chains | wire-subagents + persist | performance | 80 | gated_auto |
| 15 | Subagent `Chain.sessionId` is subagent id, not session UUID | `agents/manager.ts:656` | api-contract | 90 | gated_auto |
| 16 | Asymmetric restore: subagents → INTERRUPTED; chains keep ACTIVE | `shared/types/chain.ts` | api-contract | 85 | gated_auto |
| 17 | Dual SubagentRecord / status enums + third `SubagentState` prompt DTO | manager + subagent.ts + system-prompt | api-contract, kieran-ts, maintainability | 85–90 | manual |
| 18 | Explicit `any` tool map disables type checking at LLM tool boundary | `orchestrator.ts:726` | kieran-typescript | 92 | gated_auto |
| 19 | Tool dispatch never validates Zod; handlers cast `unknown` | `tool-dispatch.ts:144` | kieran-typescript | 85 | gated_auto |
| 20 | Unsafe double cast Zod→AI SDK in context-snapshot | `context-snapshot.ts:32` | kieran-typescript | 88 | gated_auto |
| 21 | `fullStream` / `onStepFinish` cast away SDK discriminants | `orchestrator.ts:411` | kieran-typescript | 80 | gated_auto |
| 22 | Cancelled turns leave in-flight tools running (no abortSignal) | tool-dispatch + orchestrator | adversarial | 85 | gated_auto |
| 23 | CLAUDE.md documents non-existent agent modules | `electron/CLAUDE.md` | standards | 100 | safe_auto |
| 24 | Tier override affects model selection but not `Agent.tier` on record | `tools/subagent/delegate.ts:107` | agent-native | 75 | gated_auto |
| 25 | Unscoped subagent persist falls back to active session | `persist-subagent-chains.ts:47` | agent-native | 75 | gated_auto |

### Detail highlights

**4. History JSON.parse crash** — tool-dispatch guards parse; orchestrator history replay does not. One bad `arguments` string poisons session forever until manual repair.

**7. Dangling tool results** — `lastAssistantToolCallIds` from unfiltered calls after filtering → provider 400 risk.

**8–10. Cancel/retry reliability** — timeout is Promise.race only; backoff not abortable; mid-stream drops skip middleware retry.

**11–14. Scale** — linear history + full JSON rewrite + never-evicted subagents + 250ms persist storm.

**15–17. Contracts** — wrong `chain.sessionId`, restore asymmetry, dual DTOs.

**18–21. Type safety** — `any` tool map, unvalidated dispatch, stream casts.

---

## P2 — Moderate (16)

| # | Title | File:line | Reviewers | Confidence |
|---|-------|-----------|-----------|------------|
| 26 | `ActiveAgent.abortController` never wired to stream AbortController | `ipc/chat.ts:1035` | correctness | 75 |
| 27 | Esc phase 2 does not cancel subagents until third Esc (by design but orphaning) | `chat.ts:1638` | correctness | 75 |
| 28 | Agent machine ERROR nulls abortController while invoke races | `agent-machine.ts:394` | correctness | 50 |
| 29 | Provider-quirks mid-stream suppression cannot see stream errors | `provider-quirks.ts:99` | reliability | 75 |
| 30 | Throttle timer can fire after stream teardown | `throttle.ts:80` | reliability | 75 |
| 31 | Chat IPC unregister skips `releaseResources` (also S1) | `chat.ts:1755` | reliability | 100 |
| 32 | `toolsInFlight` can stick if tool-result never arrives | `orchestrator.ts:346` | reliability | 75 |
| 33 | No concurrency/spawn-rate limit on `delegate_to_subagent` | delegate + manager | performance, adversarial | 78–80 |
| 34 | `wait_for_subagent` injects full result without offload | `wait.ts` | performance | 72 |
| 35 | Historical THINKING fully replayed every request | `history.ts` | performance | 70 |
| 36 | Two public SubagentRecord shapes (runtime vs domain) | manager vs shared | api-contract | 80 |
| 37 | Domain SubagentRecord mixes snake_case and camelCase | `subagent.ts:29` | api-contract | 75 |
| 38 | `subagentRecordSchema` incomplete vs type | `subagent.ts:61` | api-contract, kieran-ts | 70 |
| 39 | Domain agent type/tier plain `string` | `subagent.ts:32` | kieran-ts | 82 |
| 40 | Enum narrowing via Set + assertion | `registry.ts:96` | kieran-ts | 78 |
| 41 | Session load trusts `JSON.parse` cast | `storage.ts:224` | kieran-ts | 72 |
| 42 | Mid-turn cancel: tool_call without tool_result until filter drops | chat + history | adversarial | 78 |
| 43 | Overlapping chat:send after hydrate can abort just-started peer turn | `chat.ts` | adversarial | 72 |
| 44 | God-modules: orchestrator ~930 + session/agent managers | multi | maintainability | 75 |
| 45 | Tool handlers type assertions vs Zod parse | subagent tools | standards | 65 |

---

## P3 — Low (5)

| # | Title | File:line | Reviewers | Confidence |
|---|-------|-----------|-----------|------------|
| 46 | Message factories omit `MessageType.ERROR` | `message-factories.ts` | api-contract | 65 |
| 47 | `ApiMessage` untyped role/content unions | `message.ts:121` | kieran-ts | 65 |
| 48 | Duplicate `toApiMessages edge cases` describe block in tests | `llm-orchestrator.test.ts` | testing | 75 |
| 49 | `wait_for_subagent` under-signals ownership/not-found (`isError`) | `wait.ts:70` | agent-native | 65 |
| 50 | XState is thin stream shell; docs imply full agentic loop | agent-machine + CLAUDE | standards | 75 |
| 51 | docs/solutions empty for session/agent/llm domain | `docs/solutions/` | learnings | 75 |

---

## Deduplication notes

| Merged from | Into |
|-------------|------|
| reliability + adversarial unbounded wait | #1 |
| adversarial Esc orphan + correctness Esc phase 2 | #2 (P0) / #27 (design note) |
| correctness + adversarial + testing JSON.parse | #4 |
| reliability + adversarial tool timeout/no abort | #8, #22 |
| performance + adversarial history/subagent map | #11–13 |
| api-contract + kieran + maintainability dual records | #17 |
| S1 MCP unregister (reconfirmed) | #31 (cross-ref S1#6) |

---

## Residual risks

1. Dual abort ownership (`ActiveAgent` vs machine vs stream) — easy to break in refactors.
2. Retry + idle retry compound without single wall-clock turn budget.
3. `isTransientError` string matching can false-positive retries.
4. Subagent `resultText` concatenates all content deltas (not final answer only).
5. Multi-owner SessionManager “switch does not cancel work” misused by new callers of `getActive()`.
6. Prior `markFailed`/`INTERRUPTED` confusion appears fixed; cancel uses INTERRUPTED intentionally.

---

## Testing gaps (union)

- `wait_for_subagent` / `SubagentManager.wait` timeout + AbortSignal
- Tool timeout aborts underlying process/MCP work
- Retry aborts during backoff
- Mid-stream drop reconnect behavior
- Esc×2 + 5s timeout leaves (or cancels) subagents
- Cross-session interrupt does not flush peer waiters
- Malformed `tool_calls.arguments` does not throw in `streamChat`
- Tool-only subagent still yields useful wait result
- cancelOne preserves partial assistant text
- `toApiMessages` surviving tool_call id set matches emitted results
- Nested `chain.sessionId` equals parent session UUID after round-trip
- Chains ACTIVE→frozen on cold load like subagents
- Subagent map size bounded after N completes / session delete
- Concurrent subagent cap
- Tier override domain vs selection consistency
- `wait` isError for not-owned/missing IDs
- CLAUDE.md listed modules exist (or docs fixed)

---

## Coverage

| Item | Value |
|------|--------|
| Paths | session, agents, llm, subagent tools, shared types |
| Reviewers returned | 7/7 |
| Fixes applied | **none** |
| Cross-refs | S1 #6 MCP leases, S1 interrupt timeout |

---

## Suggested fix priority (later)

1. P0: wait timeout, Esc cancel children, flushStateCallbacks session scope  
2. P1: safe history JSON.parse + tool_call id matching  
3. P1: abortSignal through tools; abortable retry sleep  
4. P1: context budget + prune SubagentManager + persist policy  
5. P1: unify SubagentRecord / fix chain.sessionId / restore ACTIVE chains  
6. P1: typed tool map + Zod validate in executeToolCall  
