---
title: "Null-limit models compacted via assumed 128k window, chars/4 estimates inflated 3x, and keep_recent_chains lost the whole preserved tail on oversized turns"
date: 2026-08-18
category: design-flaws
module: chat compaction (electron/src/main/llm/compaction/*, electron/src/main/ipc/chat/send.ts)
problem_type: design_flaw
component: development_workflow
severity: high
symptoms:
  - Session compacts immediately on message-send even though the model has no configured context limit
  - Send blocks ~30s on an inline summarizer for a history that never crossed any real threshold
  - Post-compaction context collapses to summary + one short user message; all tool progress of a long turn is lost
  - Compactor call consumes more input tokens than the main model had
root_cause: inconsistent_fallback_semantics
resolution_type: code_fix
tags:
  - compaction
  - trigger
  - select-cut
  - calibration
  - config-schema
related_files:
  - electron/src/main/ipc/chat/send.ts
  - electron/src/main/llm/compaction/select.ts
  - electron/src/main/llm/compaction/trigger.ts
  - electron/src/main/config/schema.ts
  - electron/src/main/agents/subagent-runner.ts
  - electron/src/main/agents/manager.ts
  - electron/src/main/providers/accounting/context-snapshot-store.ts
---

## Problem

Three compounding design flaws in proactive compaction, found while
investigating why a GLM 5.3 session (custom model, `contextTokens: null`)
compacted on send:

1. **Fallback asymmetry.** The mid-turn usage path required a real
   `contextTokens` (`contextTokens != null` guard), but the send-time path
   substituted `FALLBACK_CONTEXT_TOKENS = 128_000` for a null limit. A model
   with no configured window therefore compacted at send with a fabricated
   budget — and the summarizer is awaited inline, so the send stalled ~33s.
2. **Heuristic estimation.** When `TriggerState.tokensPerChar` was missing
   (never persisted, so always after a restart), the send-time estimate fell
   back to chars/4. For tool-heavy histories the real ratio was 0.088
   tokens/char — a ~3x inflation that manufactured threshold crossings.
3. **Chain-unit preservation.** `selectCut` shrank `keep_recent_chains` only;
   chains were atomic preservation units. One chain larger than the budget
   forced keep→0/keep→1, so the entire oversized turn was summarized and the
   preserved tail was a 13-char user message. Chain-of-custody for recent
   diffs/tool outputs — the content that summarizes worst — was lost.

## Resolution

**Unknown window → compaction disabled everywhere.** Removed
`FALLBACK_CONTEXT_TOKENS`; `tryCompactSynchronously` takes
`contextTokens: number | null` and returns early on null/0, matching the
mid-turn and subagent paths. (Subagents already had the correct behavior.)

**Calibrate-or-skip (hard rule: never chars/4).**
`FALLBACK_TOKENS_PER_CHAR` deleted; `estimateNextInputTokens` returns only the
reported base when uncalibrated. Send-time compaction skips when no calibrated
ratio exists. Calibration survives restarts via
`hydrateTriggerCalibration`: seeds `lastObservedInputTokens` from the
accounting DB (`context_snapshots`, main-agent scope, newest first — new
`latestMainInputTokens` query) with session-chain message usages as a
secondary source. The overflow-retry path records `contextTokens` as a
measured lower bound (a context-length error proves input ≥ window) before
retrying, so even the first-turn overflow backstop never estimates blind.

**preserve_percent replaces keep_recent_chains.** `selectCut` now walks the
newest suffix backward, accumulating per-message token estimates until the
preserve budget (`preserve_percent × contextTokens`, default 0.25, clamped
below the hysteresis re-arm line via `resolvePreservePercent`) is exceeded.
Chain boundaries are opportunistic, not atomic units, so a single oversized
turn keeps its most recent `preserve_percent` verbatim and only the head is
summarized. Two floors guarantee invariants: the trailing open tool group is
always preserved, and when the newest completed tool group alone exceeds the
budget it survives whole (best-effort, bounded by one group). Tool-group
atomicity (never split a call/result pair) is kept via the existing
safe-boundary adjustment.

Config: `preserve_percent` (0.05–0.9, default 0.25) in both scopes;
`keep_recent_chains` parses for migration with a load-time deprecation
warning and is ignored. UI (CompactionTab, ProjectConfigView) and the IPC
boundary type updated.

## Evidence

Post-fix behavior on the original incident session shape (274-message turn +
short follow-up, 25% of a 128k window = 32k budget): the cut lands *inside*
the oversized turn at a tool-group boundary; the summary covers the head and
the last ~32k of messages (final diffs, commit output) replay verbatim.

## Pitfall

Importing `context-snapshot-store` at module top level in `chat/send.ts`
broke `bg-command-ipc` tests: the store imports `HOME_CONFIG_DIR` from
`config/loader`, which those tests mock. The hydrate helper uses a dynamic
`await import(...)` instead — keep that pattern for anything reaching into
the accounting stores from the chat module graph.
