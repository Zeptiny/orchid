# Code Review: Uncommitted Changes on `feat/ts-electron-migration`

**Date:** 2026-07-09  
**Scope:** 60+ modified files, ~16K lines of diff  
**Intent:** Iteration 012 interface rework — theme redesign, new IPC tool-call events, command renaming, interrupt flow changes, subagent improvements, and migration regression fixes.

## Review Team
- correctness (always)
- testing (always)
- maintainability (always)
- api-contract — IPC types significantly changed
- reliability — error handling, interrupt flow, timeouts
- kieran-typescript — TypeScript type safety
- julik-frontend-races — async UI, xstate machines, interrupt flow

---

## P0 — Critical (0 remaining)

All P0 findings resolved.

---

## P1 — High (8 remaining)

| # | Title | File | Reviewer |
|---|-------|------|----------|
| 1 | `thinkingCommittedLength` never reset on stream end | `chat.ts` | correctness |
| 2 | Orchestrator `fullStream` chunk cast to `Record<string, unknown>` bypasses AI SDK types | `orchestrator.ts:244` | kieran-typescript |
| 3 | `onStepFinish` callback casts toolCalls/toolResults with unsafe assertions | `orchestrator.ts:282` | kieran-typescript |
| 4 | Message factory functions duplicated across 3 files | `chat.ts`, `manager.ts`, `useChat.ts` | maintainability |
| 5 | Circular dependency between `session.ts` and `chat.ts` via `require()` hack | `session.ts:25` | maintainability |
| 6 | No tests for THINKING event handling in agent machine | `xstate-agents.test.ts` | testing |
| 7 | No tests for `classifyErrorKind()` | `chat-ipc.test.ts` | testing |
| 8 | No tests for orchestrator fullStream processing | `llm-orchestrator.test.ts` | testing |
| 9 | No tests for `forceAbortChat()` | `chat-ipc.test.ts` | testing |

---

## P2 — Moderate (18 remaining)

| # | Title | File | Reviewer |
|---|-------|------|----------|
| 10 | Interrupt third-phase is a flash (dispose via microtask) | `interrupt-machine.ts` | correctness |
| 11 | `markFailed` uses `ChainStatus.INTERRUPTED` for errors | `manager.ts` | correctness |
| 12 | `useChat` optional chaining silently degrades if preload out of sync | `useChat.ts` | correctness |
| 13 | Agent machine ERROR handler nulls `abortController` — can't abort after error | `agent-machine.ts:466` | reliability |
| 14 | `fullStream` fallback to `textStream` may conflict on shared stream | `orchestrator.ts:297` | reliability |
| 15 | `ChatDoneEvent` redefines inline Usage shape instead of importing shared type | `ipc.ts:62` | kieran-typescript |
| 16 | `CommandContext.onGetRAGStatus` removed (breaking) | `ipc-boundary.ts` | api-contract |
| 17 | `CommandContext` expanded with 3 new required methods | `ipc-boundary.ts` | api-contract |
| 18 | `SubagentRecord` requires new `parentChainIndex` field | `subagent.ts` | api-contract |
| 19 | Vacuous interrupt assertion — test provides false confidence | `chat-sidebar.test.ts` | testing |
| 20 | No test for 3rd Esc returning 'cancelled' status | `chat-ipc.test.ts` | testing |
| 21 | No test for tool error path in agent machine | `xstate-agents.test.ts` | testing |
| 22 | No tests for stable message ID persistence | `domain.test.ts` | testing |
| 23 | No test for `/rag index` error handling paths | `command-palette.test.ts` | testing |
| 24 | Near-identical `filterResults` duplicated in CommandPalette and InputArea | `InputArea.tsx` | maintainability |
| 25 | `buildStreamItems` is 300+ lines with high cyclomatic complexity | `ChatStream.tsx` | maintainability |
| 26 | `chat.ts` is 900+ lines mixing IPC, factories, error classification, persistence | `chat.ts` | maintainability |
| 27 | Renderer can send new message during `confirmSubagents` while old actor alive | `useChat.ts:680` | julik-frontend-races |

---

## P3 — Low (8 remaining)

| # | Title | File | Reviewer |
|---|-------|------|----------|
| 28 | `_notify` silently swallows listener errors | `chat.ts` | correctness |
| 29 | `classifyErrorKind` matches '429' loosely | `chat.ts` | correctness |
| 30 | Orchestrator fullStream partial iteration loses pending tool calls on re-throw | `orchestrator.ts` | correctness |
| 31 | Stale TODO comment claims usage IPC not wired | `useChat.ts:153` | maintainability |
| 32 | Repeated context reset pattern across 4 state transitions | `agent-machine.ts` | maintainability |
| 33 | `config.providers` cast to `Record<string, Record<string, unknown>>` | `ChatView.tsx` | kieran-typescript |
| 34 | `classifyErrorKind` uses fragile substring matching | `chat.ts:2640` | reliability |
| 35 | `ChatStream` `buildStreamItems` recomputes on every streamed character | `ChatStream.tsx` | julik-frontend-races |

---

## Testing Gaps

1. **Zero coverage for orchestrator fullStream event processing** — tool-input-start, tool-input-delta, reasoning-delta, textStream fallback
2. **Vacuous interrupt assertion** — assigns local variable and asserts equality to itself
3. **No test for `forceAbortChat()`** — exported function used for session switching
4. **No integration test for 3-esc interrupt flow** with timing verification
5. **No test for `classifyErrorKind()`** — only 'auth' path tested
6. **No test for message ID persistence round-trip**

## Residual Risks

- **AI SDK 7 fullStream part shapes untyped** — future SDK updates could silently break the orchestrator
- **Message factory duplication** — schema changes require 3+ coordinated edits
- **`require('./chat')` circular dependency** — will break under strict ESM resolution
- **Interrupt flow 3-phase coordination** — renderer and main process track state independently via IPC; out-of-order events could show inconsistent UI

---

## Address Soon (P2)

- Extract message factories to shared module
- Break circular dependency in `session.ts`
- Add missing test coverage for new functionality
