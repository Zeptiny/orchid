---
title: "Mid-turn compaction apply always fails on duplicated user message, resetting model context to the turn baseline"
date: 2026-08-18
category: logic-errors
module: chat compaction (electron/src/main/ipc/chat/send.ts)
problem_type: logic_error
component: development_workflow
severity: high
symptoms:
  - Compaction never visibly applies mid-turn (no summary message appears in the transcript)
  - Context usage repeatedly climbs to the threshold, then drops back to the exact turn-start input size with no compaction applied
  - Model re-explores from scratch after each drop; compactor LLM calls burn tokens whose summaries are discarded
  - Loop repeats until the user interrupts; chain status ends "interrupted" with no compacted markers
root_cause: state_divergence
resolution_type: code_fix
tags:
  - compaction
  - chat-send
  - turn-messages
  - dedupe
related_files:
  - electron/src/main/ipc/chat/send.ts
  - electron/src/main/ipc/chat/persist.ts
  - electron/src/main/llm/compaction/apply.ts
---

## Problem

A long single-turn session (one agentic turn with many tool calls) crossing the
compaction threshold never had its pending compaction applied. After each
compactor run, the next provider attempt's input reset to *exactly* the first
attempt's value — visible as context increasing and decreasing with no
compaction summary ever appearing.

## Root cause

`handleUsageCompaction` computes the cut and `expectedIds` over a **deduped**
history (`dedupeHistoryById`), because its input
`[...messages, ...turnMessagesFromAgent(agent)]` contains the triggering user
message twice (`turnMessagesFromAgent` prepends the turn base, which already
ends with that user message).

The mid-turn idle-boundary pause path passed the **raw** (non-deduped)
history to `applyPendingCompactionIfAny`, so `isPendingCutStillValid`'s
index-anchored `expectedIds` check failed at the duplicated message position —
for a first-turn session at index 1. Every mid-turn apply was rejected, the
pending compaction was dropped, and the "resume after unapplied compaction"
branch re-sent `USER_INPUT`, restarting the stream from the turn-start
`messages` closure — silently discarding all in-turn tool progress.

Secondary leak: the reclaim-only fall-through in `applyPendingCompactionIfAny`
returned without `abortPrepare()`, leaving `pendingPrepare` stuck `true` and
permanently silencing the trigger for the session.

## Fix

1. `applyPendingCompactionIfAny` dedupes its input once
   (`dedupeHistoryById`) and uses that array for validation, `buildCompactionApply`,
   and the post-compaction token math — matching exactly what the cut was computed over.
2. The unapplied-compaction resume now merges
   `dedupeHistoryById([...messages, ...turnMessagesFromAgent(activeAgent)])`
   into the stream's message base (with turn-state counter resets) so the model
   keeps its in-turn progress instead of restarting from the turn baseline.
3. Reclaim-only fall-through clears the prepare (`abortPrepare` +
   `completeCompactionWidget`) so a failed apply cannot disable future fires.
   Update (2026-08-20): "re-arm on failure" without a cooldown turned out to
   be exploitable — a *persistent* apply failure re-fires a fresh compactor
   LLM run on every usage step (the orphan cascade documented in
   selective-compaction-stacked-summary-heads-rejected.md in this directory).
   Discards now also arm a 30s apply-failure backoff and new prepares are
   blocked while a prior selective run is still unsettled. Re-arm means
   "retry later", never "retry on every event".
4. `priorMessageCount` is kept coherent after both resume paths.

## Diagnosis tricks

- `~/.orchid/accounting.db` `provider_attempts` (agent_name='compactor',
  usage_json inputTokens) vs `context_snapshots` per session: repeated resets
  to an identical input value next to successful compactor attempts = apply
  rejected + turn restart.
- `sessions.db` chains with 0 `compacted` markers while compactor attempts
  exist = compaction ran but never applied.
- Regression tests: `tests/unit/chat-ipc-compaction.test.ts`
  `describe('chat compaction mid-turn pause')` — both fail on the pre-fix code.
