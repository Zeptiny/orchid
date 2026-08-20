/**
 * Re-compaction regression (review #53).
 *
 * Production bug: after a first selective compaction applied, every later
 * compaction above threshold fired the compactor LLM but NEVER applied —
 * isPendingCutStillValid rejected the pending because selective runs left
 * multiple stacked summary heads inside the next compactable range, and
 * buildCompactionApply's double-compaction guard threw for the same shape.
 * The failure cascaded: one orphaned compactor run per step while usage kept
 * climbing past 2× the window.
 *
 * This exercises the pure pipeline both paths share: selectCut → selective
 * run (materialize) → buildSelectiveCompactionApply → re-select → re-prepare
 * (pending validation) → re-apply, over BOTH a legacy stacked-heads history
 * and the new single-coalesced-head history.
 */
import { describe, expect, it } from 'vitest';
import type { Message } from '../../src/shared/types/message';
import { MessageRole, MessageType } from '../../src/shared/types/message';
import type { Chain } from '../../src/shared/types/chain';
import { ChainStatus } from '../../src/shared/types/chain';
import { selectCut, resolveUserExemptIds } from '../../src/main/llm/compaction/select';
import { buildManifest } from '../../src/main/llm/compaction/selective/manifest';
import { runSelectiveCompaction } from '../../src/main/llm/compaction/selective/run';
import type { SelectiveOp } from '../../src/main/llm/compaction/selective/manifest';
import { buildSelectiveCompactionApply } from '../../src/main/llm/compaction/apply';
import { isPendingCutStillValid } from '../../src/main/llm/compaction/pending-store';

// ── Fixtures ─────────────────────────────────────────────────────────────────

function text(id: string, role: MessageRole, content: string, overrides: Partial<Message> = {}): Message {
  return {
    id,
    role,
    content,
    type: MessageType.TEXT,
    tool_calls: null,
    tool_call_id: null,
    name: null,
    thinking: null,
    timestamp: new Date().toISOString(),
    usage: null,
    hidden: false,
    tool_result: null,
    ...overrides,
  };
}

function userMsg(id: string, content: string): Message {
  return text(id, MessageRole.USER, content);
}

function assistantMsg(id: string, content: string): Message {
  return text(id, MessageRole.ASSISTANT, content);
}

function toolPair(i: number): Message[] {
  const callId = `call-${i}`;
  return [
    {
      id: `tc-${i}`,
      role: MessageRole.ASSISTANT,
      content: '',
      type: MessageType.TOOL_CALL,
      tool_calls: [{ id: callId, type: 'function' as const, function: { name: 'read', arguments: `{"n":${i}}` } }],
      tool_call_id: callId,
      name: 'read',
      thinking: null,
      timestamp: new Date().toISOString(),
      usage: null,
      hidden: false,
      tool_result: null,
    },
    {
      id: `tr-${i}`,
      role: MessageRole.TOOL,
      content: `x`.repeat(400),
      type: MessageType.TOOL_RESULT,
      tool_calls: null,
      tool_call_id: callId,
      name: 'read',
      thinking: null,
      timestamp: new Date().toISOString(),
      usage: null,
      hidden: false,
      tool_result: null,
    },
  ];
}

/** Long single-turn exploration history: user → many tool pairs + thoughts. */
function longHistory(turns: number): Message[] {
  const msgs: Message[] = [userMsg('u0', 'explore the compaction system implementation')];
  for (let i = 0; i < turns; i += 1) {
    msgs.push(text(`th-${i}`, MessageRole.ASSISTANT, `thinking ${i}`, { type: MessageType.THINKING }));
    msgs.push(...toolPair(i));
    msgs.push(assistantMsg(`a-${i}`, `assistant summary ${i}`));
  }
  return msgs;
}

function oneChain(messages: readonly Message[]): Chain[] {
  return [{
    id: 'chain-1',
    sessionId: 'session-1',
    messages: [...messages],
    status: ChainStatus.ACTIVE,
    selection: null,
    modelLabel: null,
    agentName: 'general',
    agentType: 'internal',
    agentTier: 'seed',
    subagentRecord: null,
    startTime: new Date().toISOString(),
    endTime: new Date().toISOString(),
    errorDetail: null,
    errorTitle: null,
  }];
}

const ESTIMATOR = (slice: readonly Message[]): number =>
  Math.max(slice.length, slice.reduce((n, m) => n + m.content.length, 0));

/**
 * Fake selective caller: keeps user messages and thinking verbatim (R24);
 * summarizes each turn's [tool_call, tool_result, assistant] as its own op —
 * MANY summarize ops (old materialization emitted one synthetic per op), with
 * call/result pairs never split across ops.
 */
function perTurnSectionCaller(): (input: { manifest: ReturnType<typeof buildManifest> }) => Promise<SelectiveOp[]> {
  return async ({ manifest }) => {
    const ops: SelectiveOp[] = [];
    let pending: string[] = [];
    const flush = () => {
      if (pending.length === 0) return;
      // Substantive handoff-shaped text (the new validator rejects activity
      // logs for spans with >= 1000 chars of source — the fixture must model
      // the contract, not the old degenerate output).
      ops.push({
        type: 'summarize',
        ids: [...pending],
        text: `Section for ${pending.length} messages: explored the compaction engine files and recorded the trigger, select, and apply findings needed to continue; exact file paths, key decisions, and errors are preserved in this handoff; next step is applying the remaining compaction pipeline stages.`,
      });
      pending = [];
    };
    for (const entry of manifest.entries) {
      if (entry.kind === 'user' || entry.type === MessageType.THINKING) {
        flush();
        ops.push({ type: 'keep', id: entry.id });
      } else {
        pending.push(entry.id);
      }
    }
    flush();
    return ops;
  };
}

function compact(messages: readonly Message[], preserveTokens: number) {
  const exempt = resolveUserExemptIds(messages, { keepLast: 10, pinFirst: true });
  const cut = selectCut(messages, { preserveTokens, tokenEstimator: ESTIMATOR, exemptIds: exempt });
  const manifest = buildManifest(messages, cut.compactableRange);
  return { cut, manifest, exempt };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('selective re-compaction pipeline (review #53 regression)', () => {
  it('first compaction materializes ONE coalesced head and applies; the pending stays valid for apply', async () => {
    const history = longHistory(8);
    const { cut, manifest, exempt } = compact(history, 600);

    const result = await runSelectiveCompaction({
      messages: history,
      compactableRange: cut.compactableRange,
      manifest,
      selectiveCaller: perTurnSectionCaller(),
    });
    expect(result.kind).toBe('selective');

    // ONE synthetic head even though the caller emitted one summarize op per turn.
    const heads = result.replayMessages.filter((m) => m.compacted);
    expect(heads).toHaveLength(1);
    expect((heads[0]!.content.match(/Section for/g) ?? []).length).toBeGreaterThan(1);

    const apply = buildSelectiveCompactionApply({
      messages: history,
      chains: oneChain(history),
      cutResult: cut,
      flaggedIds: result.flaggedIds,
      exemptIds: exempt,
      summaryText: null,
      sessionId: 'session-1',
    });
    expect(apply).not.toBeNull();
    expect(apply!.didApply).toBe(true);

    // The pending registered at prepare time is still valid over the live
    // history at apply time (index-anchored; heads in range are fine).
    const expectedIds = history.slice(cut.compactableRange.start, cut.compactableRange.end).map((m) => m.id);
    const pending = { cut, flaggedIds: result.flaggedIds, expectedIds };
    expect(isPendingCutStillValid(pending, history)).toBe(true);
  });

  it('re-compaction over the FIRST compaction output applies (second compaction is not a deadlock)', async () => {
    const original = longHistory(8);
    const { cut: cut1, manifest: m1, exempt } = compact(original, 600);
    const first = await runSelectiveCompaction({
      messages: original,
      compactableRange: cut1.compactableRange,
      manifest: m1,
      selectiveCaller: perTurnSectionCaller(),
    });
    expect(first.kind).toBe('selective');
    const firstApply = buildSelectiveCompactionApply({
      messages: original,
      chains: oneChain(original),
      cutResult: cut1,
      flaggedIds: first.flaggedIds,
      exemptIds: exempt,
      summaryText: null,
      sessionId: 'session-1',
    });
    expect(firstApply!.didApply).toBe(true);

    // Post-compaction history: settled originals + the ONE summary head the
    // run materialized (from result.summaryMessage — the replay-only apply
    // with summaryText null inserts no head of its own) spliced at the cut,
    // the main adapter's reanchored replay shape, then new content appended
    // until the window fills again.
    const head = first.summaryMessage;
    expect(head).not.toBeNull();
    const post = [...firstApply!.updatedMessages];
    const withHead = head
      ? [...post.slice(0, cut1.cutIndex), head, ...post.slice(cut1.cutIndex)]
      : post;
    const grown = [...withHead, ...toolPair(900), ...toolPair(901), assistantMsg('a-new', 'new findings')];

    // Second fire: cut must find a non-empty compactable range containing the head…
    const { cut: cut2, manifest: m2 } = compact(grown, 400);
    expect(cut2.compactableRange.end).toBeGreaterThan(cut2.compactableRange.start);
    const rangeIds2 = grown.slice(cut2.compactableRange.start, cut2.compactableRange.end).map((m) => m.id);
    expect(rangeIds2).toContain(head!.id);

    const second = await runSelectiveCompaction({
      messages: grown,
      compactableRange: cut2.compactableRange,
      manifest: m2,
      selectiveCaller: perTurnSectionCaller(),
    });
    expect(second.kind).toBe('selective');

    // …the pending over the stacked shape validates at apply time…
    const expectedIds2 = grown.slice(cut2.compactableRange.start, cut2.compactableRange.end).map((m) => m.id);
    const pending2 = { cut: cut2, flaggedIds: second.flaggedIds, expectedIds: expectedIds2 };
    expect(isPendingCutStillValid(pending2, grown)).toBe(true);

    // …and the apply SUPERSEDES the old head instead of refusing.
    const secondApply = buildSelectiveCompactionApply({
      messages: grown,
      chains: oneChain(grown),
      cutResult: cut2,
      flaggedIds: second.flaggedIds,
      exemptIds: exempt,
      summaryText: null,
      sessionId: 'session-1',
    });
    expect(secondApply).not.toBeNull();
    expect(secondApply!.didApply).toBe(true);
    expect(secondApply!.flaggedIds).toContain(head!.id);
    expect(secondApply!.updatedMessages.find((m) => m.id === head!.id)!.excludeFromModel).toBe(true);
  });

  it('re-compaction applies over a LEGACY stacked-heads history (the exact production shape)', async () => {
    // The user's session persisted SIX back-to-back selective heads from one
    // compaction (per-op synthetics), unflagged originals, then new content.
    const legacy: Message[] = [userMsg('u0', 'explore')];
    const marker = (i: number) => ({
      rangeStart: `s${i}-start`,
      rangeEnd: `s${i}-end`,
      mode: 'selective' as const,
      summarizedCount: 2,
    });
    for (let i = 0; i < 6; i += 1) {
      legacy.push(text(`head-${i}`, MessageRole.ASSISTANT, `Summary section ${i}.`, { compacted: marker(i) }));
    }
    legacy.push(...longHistory(4).slice(1));

    const { cut, manifest } = compact(legacy, 100);
    expect(cut.compactableRange.end).toBeGreaterThan(cut.compactableRange.start);
    // Heads sit INSIDE the range at depth > 0 (index 1.., after the pinned
    // user message) — the exact case the old validity check rejected and the
    // old apply guard threw on.
    expect(cut.compactableRange.start).toBe(1);

    const result = await runSelectiveCompaction({
      messages: legacy,
      compactableRange: cut.compactableRange,
      manifest,
      selectiveCaller: perTurnSectionCaller(),
    });
    expect(result.kind).toBe('selective');

    const expectedIds = legacy.slice(cut.compactableRange.start, cut.compactableRange.end).map((m) => m.id);
    const pending = { cut, flaggedIds: result.flaggedIds, expectedIds };
    expect(isPendingCutStillValid(pending, legacy)).toBe(true);

    const apply = buildSelectiveCompactionApply({
      messages: legacy,
      chains: oneChain(legacy),
      cutResult: cut,
      flaggedIds: result.flaggedIds,
      exemptIds: resolveUserExemptIds(legacy, { keepLast: 10, pinFirst: true }),
      summaryText: null,
      sessionId: 'session-1',
    });
    expect(apply).not.toBeNull();
    expect(apply!.didApply).toBe(true);
    for (let i = 0; i < 6; i += 1) {
      expect(apply!.updatedMessages.find((m) => m.id === `head-${i}`)!.excludeFromModel).toBe(true);
    }
    // Exactly ONE replayable head remains: the new coalesced one in the
    // materialized replay (the main scope persists it as the summary chain).
    const replayableHeads = result.replayMessages.filter((m) => m.compacted);
    expect(replayableHeads).toHaveLength(1);
    expect(replayableHeads[0]!.id).not.toBe('head-0');
  });
});
