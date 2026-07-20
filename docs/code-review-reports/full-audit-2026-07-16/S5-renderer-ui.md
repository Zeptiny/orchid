# Full Audit S5 — Renderer UI & Async Races

**Date:** 2026-07-16  
**Mode:** report-only (no fixes applied)  
**Intent:** Session tabs, chat stream, hooks, preferences, keyboard — correctness, races, perf, types, tests.  
**Scope:** `electron/src/renderer/**` (+ related shared IPC consumer types)

## Review team

| Reviewer | Role |
|----------|------|
| correctness | always |
| testing | always |
| maintainability | always |
| julik-frontend-races | conditional |
| kieran-typescript | conditional |
| performance | conditional |

**Team size:** 6 specialized agents

## Verdict

**Highest-impact UI bug: dual `useSession()`** — ConfigView and ChatView each own independent session state while App keeps ChatView mounted under Settings. Session select/delete/draft from Config does not update the chat pane. Composer **send lock sticks** after silent gate failures. Stream path is **correctness-OK but performance-hostile** (100ms full history rebuild, unbatched per-token updates, full markdown reparse).

---

## P0 — Critical (1)

| # | Title | File:line | Reviewers | Confidence | Autofix |
|---|-------|-----------|-----------|------------|---------|
| 1 | ConfigView + ChatView each own separate `useSession()` — settings mutations never update chat pane | `ConfigView.tsx:53` + `ChatView.tsx` + `useSession.ts` | correctness, maintainability | 90–92 | manual |

**Why:** App keeps ChatView mounted (`hidden`) while ConfigView mounts a second `useSession()`. Select/create/delete/rebind in Config only mutates Config’s local state; ChatView continues on stale/deleted session until full reload.

**Fix:** Shared session store (like `useProviders`) or forward all Config session actions into ChatView’s handlers. Never dual-mount `useSession()` for navigation.

---

## P1 — High (12)

| # | Title | File:line | Reviewers | Confidence | Autofix |
|---|-------|-----------|-----------|------------|---------|
| 2 | Composer `isSendingRef` sticks after silent send gates | `InputArea.tsx:383` | julik-frontend-races | 100 | gated_auto |
| 3 | Esc/cancel has no mutual exclusion across stages | `useChat.ts:757` | julik-frontend-races | 75 | gated_auto |
| 4 | `chat.send` catch leaves optimistic bubble + half-stream state | `useChat.ts:748` | correctness, races | 75–78 | gated_auto |
| 5 | GeneralTab cannot set `llm_stream_retries` to 0 | `GeneralTab.tsx:64` | correctness | 95 | safe_auto |
| 6 | RAGTab cannot set `chunk_overlap` to 0 | `RAGTab.tsx:80` | correctness | 93 | safe_auto |
| 7 | Config draft is untyped `Record` with cast-to-Config | `ConfigView.tsx:65` | kieran-typescript | 90 | gated_auto |
| 8 | `orchid:config-updated` treats `default_model` as ModelSelection without narrowing | `ChatView.tsx:181` | kieran-typescript | 82 | gated_auto |
| 9 | 100ms elapsed ticker rebuilds full chat history every tick | `useChat.ts:317` + ChatStream | performance | 95 | gated_auto |
| 10 | Unbatched per-token stream updates thrash ChatView tree | `useChat.ts:342` | performance | 92 | gated_auto |
| 11 | Streaming assistant fully re-parses markdown every chunk | `MarkdownContent.tsx:91` | performance | 90 | gated_auto |
| 12 | Command palette navigation dispatches dead `orchid:navigate` | `CommandPalette.tsx:345` | maintainability | 100 | gated_auto |
| 13 | Domain hook `useChat` imports UI `ContextGrid` for pure math | `useChat.ts:29` | maintainability | 88 | gated_auto |
| 14 | `useChat` / `useSession` / `useSessionTabs` behavioral surface almost untested | hooks + tests | testing | 85–90 | manual |
| 15 | Preferences/onboarding tests assert mocks/booleans, not ConfigView | `preferences-onboarding.test.ts` | testing | 95 | manual |

---

## P2 — Moderate (14)

| # | Title | File:line | Reviewers | Confidence |
|---|-------|-----------|-----------|------------|
| 16 | `hydrateSnapshot` drops buffered events when `live` is null | `useChat.ts:917` | correctness | 72 |
| 17 | Config session delete/create does not refresh ChatView list | ConfigView | correctness | 80 |
| 18 | New stream always yanks scroll to bottom | `ChatStream.tsx:184` | races | 75 |
| 19 | MCP server config stays `Record` with unchecked casts | MCPServersTab | kieran-ts | 80 |
| 20 | RAG number handler casts onto every RAGConfig field | RAGTab | kieran-ts | 78 |
| 21 | `chat.cancel` status open string | useChat + OrchidAPI | kieran-ts | 76 |
| 22 | OrchidAPI required on Window but renderer uses optional everywhere | hooks | kieran-ts | 74 |
| 23 | Message list fully mounted; no virtualization/memo | ChatStream | performance | 82 |
| 24 | smooth `scrollIntoView` every streamingContent change | ChatStream | performance | 85 |
| 25 | `toolBlocks` in history deps forces O(n) rebuild on tool churn | ChatStream | performance | 80 |
| 26 | Slash menu + palette duplicate selection/filter pipelines | InputArea + CommandPalette | maintainability | 92 |
| 27 | ChatView monolithic orchestrator (~1.1k LOC) | ChatView | maintainability | 80 |
| 28 | `orchid:theme-applied` dispatched with no product listeners | themes/index.ts | maintainability | 95 |
| 29 | `useGlobalShortcuts` / ChatView orchestration / focus trap gaps | keyboard + ChatView | testing | 75–85 |
| 30 | Roving-list test reimplements clamp math instead of hook | roving-list-index.test.ts | testing | 80 |

---

## P3 — Low (4)

| # | Title | File:line | Reviewers | Confidence |
|---|-------|-----------|-----------|------------|
| 31 | `acceptChatEvent` can latch streamSessionId on first draft event | useChat | correctness | 55 |
| 32 | GeneralTab number handler ignores invalid/zero (UX snap-back) | GeneralTab | correctness | 70 |
| 33 | Custom DOM events use unchecked CustomEvent casts | App.tsx | kieran-ts | 72 |
| 34 | `filter(Boolean) as Command[]` | CommandPalette | kieran-ts | 68 |
| 35 | Vacuous keyboard shortcut tests (literal equality) | command-palette.test.ts | testing | 100 |

---

## Residual risks

1. Multi-chain footer attribution by content fingerprint can mis-attribute subagent usage.
2. `useSubagents` refresh without sessionId filter on events (over-fetch).
3. `pickProjectDir` concurrent tab switch during await.
4. Cancel no-ops while `isSwitchingSession`.
5. No React Testing Library harness — most “coverage” is source-structure.

---

## Testing gaps (union)

- Config open while ChatView mounted: select/delete/draft updates ChatView
- Number handlers accept schema zeros
- useChat send IPC throw rollback; hydrate live=null flush buffer
- InputArea recovers after silent early-return / status error
- Double-Esc interrupt phase ordering
- ChatStream hydrate does not force scroll when user scrolled up
- useSession load races / draftGeneration
- useSessionTabs epoch races
- ConfigView dirty/save/MCP restart/requestTab
- useGlobalShortcuts gates; real useRovingListIndex; focus trap Tab wrap

---

## Coverage

| Item | Value |
|------|--------|
| Agents | 6/6 |
| Fixes applied | **none** |

---

## Suggested fix priority (later)

1. P0: single session store  
2. P1: InputArea send lock + send failure hygiene + cancel serialization  
3. P1: preferences zero-handling; Config draft typing  
4. P1: stream perf (rAF coalesce, elapsed out of history deps, streaming markdown throttle)  
5. P1: wire or remove `orchid:navigate`; real ConfigView/useChat tests  
