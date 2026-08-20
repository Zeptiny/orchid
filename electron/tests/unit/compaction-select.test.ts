import { describe, expect, it } from 'vitest';
import type { Message } from '../../src/shared/types/message';
import { MessageRole, MessageType } from '../../src/shared/types/message';
import { selectCut, analyzeToolGroups, isCleanToolGroupBoundary, resolvePreservePercent, resolveUserExemptIds, inferChainBoundaries } from '../../src/main/llm/compaction/select';
import type { ToolCall } from '../../src/shared/types/tool';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: overrides.id ?? `msg-${Math.random().toString(36).slice(2, 9)}`,
    role: overrides.role ?? MessageRole.USER,
    content: overrides.content ?? '',
    type: overrides.type ?? MessageType.TEXT,
    tool_calls: overrides.tool_calls ?? null,
    tool_call_id: overrides.tool_call_id ?? null,
    name: overrides.name ?? null,
    thinking: overrides.thinking ?? null,
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    usage: overrides.usage ?? null,
    hidden: overrides.hidden ?? false,
    excludeFromModel: overrides.excludeFromModel,
    compacted: overrides.compacted,
    tool_result: overrides.tool_result ?? null,
  } as Message;
}

function makeUser(id: string, content: string): Message {
  return makeMessage({ id, role: MessageRole.USER, content, type: MessageType.TEXT });
}

function makeAssistantText(id: string, content: string): Message {
  return makeMessage({ id, role: MessageRole.ASSISTANT, content, type: MessageType.TEXT });
}

function makeToolCallMsg(id: string, callId: string, name: string, args = '{}', content = ''): Message {
  const tc: ToolCall = { id: callId, type: 'function', function: { name, arguments: args } };
  return makeMessage({
    id,
    role: MessageRole.ASSISTANT,
    content,
    type: MessageType.TOOL_CALL,
    tool_calls: [tc],
    tool_call_id: callId,
    name,
  });
}

function makeToolResult(id: string, callId: string, name: string, content: string): Message {
  return makeMessage({
    id,
    role: MessageRole.TOOL,
    content,
    type: MessageType.TOOL_RESULT,
    tool_call_id: callId,
    name,
    tool_calls: null,
  });
}

function makeSummaryHead(id: string, content = 'summary handoff'): Message {
  return makeMessage({
    id,
    role: MessageRole.ASSISTANT,
    content,
    type: MessageType.TEXT,
    compacted: { rangeStart: 'msg-0', rangeEnd: 'msg-10', mode: 'simple' as const },
  });
}

/** N text messages of exactly `chars` chars each (default estimator: ceil(chars/4) tokens each). */
function uniformMessages(count: number, chars: number): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push(i % 2 === 0
      ? makeUser(`u-${i}`, 'x'.repeat(chars))
      : makeAssistantText(`a-${i}`, 'x'.repeat(chars)));
  }
  return out;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('selectCut — suffix token walk (preserve budget)', () => {
  it('fills the preserve budget from the newest message backward', () => {
    // 6 messages × 25 tokens (100 chars each); budget 80 → suffix of 3 messages (75 tokens)
    const messages = uniformMessages(6, 100);
    const result = selectCut(messages, { preserveTokens: 80, chainBoundaries: [0] });
    expect(result.cutIndex).toBe(3);
    expect(result.preservedRange).toEqual({ start: 3, end: 6 });
    expect(result.compactableRange).toEqual({ start: 0, end: 3 });
  });

  it('returns empty compactable when the whole history fits the budget', () => {
    const messages = uniformMessages(4, 100);
    const result = selectCut(messages, { preserveTokens: 1000, chainBoundaries: [0] });
    expect(result.cutIndex).toBe(0);
    expect(result.compactableRange).toEqual({ start: 0, end: 0 });
  });

  it('cuts inside a single oversized chain instead of compacting the whole turn', () => {
    // Regression for the keep→0 tail loss: one huge turn + a tiny follow-up.
    // Old chain-count semantics compacted the ENTIRE oversized turn; the suffix
    // walk must preserve the most recent ~budget of it verbatim.
    const messages: Message[] = [
      makeUser('u0', 'huge exploration turn'),
      makeToolCallMsg('tc0', 'c0', 'read'),
      makeToolResult('tr0', 'c0', 'read', 'x'.repeat(200)),
      makeToolCallMsg('tc1', 'c1', 'read'),
      makeToolResult('tr1', 'c1', 'read', 'x'.repeat(200)),
      makeToolCallMsg('tc2', 'c2', 'read'),
      makeToolResult('tr2', 'c2', 'read', 'x'.repeat(200)),
      makeUser('u1', 'follow up'),
    ];
    // Budget sized to keep roughly the last group + follow-up.
    const result = selectCut(messages, { preserveTokens: 120, chainBoundaries: [0, 7] });
    expect(result.cutIndex).toBeGreaterThan(0);
    expect(result.cutIndex).toBeLessThan(7); // inside the oversized chain, not at its start
    expect(result.preservedRange.end).toBe(messages.length);
    expect(result.preservedRange).not.toEqual({ start: 7, end: messages.length }); // more than just the follow-up survives
    expect(isCleanToolGroupBoundary(messages, result.cutIndex)).toBe(true);
  });

  it('resolves preserve budget from preservePercent × contextTokens', () => {
    // 0.25 × 400 = 100 tokens; 5 × 25-token messages → 5th message exceeds, cut at 1
    const messages = uniformMessages(5, 100);
    const result = selectCut(messages, { preservePercent: 0.25, budget: { contextTokens: 400 }, chainBoundaries: [0] });
    expect(result.cutIndex).toBe(1);
  });

  it('resolves legacy threshold-derived budget when no preserve knob is set', () => {
    // threshold 0.5 × 400 = 200 tokens; 10 × 25-token messages → cut at 2
    const messages = uniformMessages(10, 100);
    const result = selectCut(messages, { budget: { contextTokens: 400, threshold: 0.5 }, chainBoundaries: [0] });
    expect(result.cutIndex).toBe(2);
  });

  it('honors maxPreserveTokens alias', () => {
    const messages = uniformMessages(4, 100);
    const result = selectCut(messages, { maxPreserveTokens: 30, chainBoundaries: [0] });
    expect(result.cutIndex).toBe(3); // one message (25 tokens) fits
  });

  it('returns empty compactable when no budget is provided', () => {
    const messages = uniformMessages(4, 100);
    const result = selectCut(messages, { chainBoundaries: [0] });
    expect(result.cutIndex).toBe(0);
    expect(result.compactableRange).toEqual({ start: 0, end: 0 });
    expect(result.preservedCount).toBe(1); // explicit [0] boundary → single chain preserved
  });

  it('uses the custom tokenEstimator when provided', () => {
    const messages = uniformMessages(4, 100);
    const estimator = (msgs: readonly Message[]) => msgs.length * 10;
    const result = selectCut(messages, { preserveTokens: 15, tokenEstimator: estimator, chainBoundaries: [0] });
    // One message = 10 tokens; two = 20 > 15 → single-message suffix.
    expect(result.preservedRange.end - result.preservedRange.start).toBe(1);
  });
});

describe('selectCut — tool-group atomicity (R5)', () => {
  it('never cuts inside a completed tool group', () => {
    const messages: Message[] = [
      makeUser('u0', 'turn 0'),
      makeAssistantText('a0', 'reply 0'),
      makeToolCallMsg('tcmsg-0', 'call-1', 'read'),
      makeToolResult('tr-1', 'call-1', 'read', 'file content'),
      makeUser('u1', 'turn 1'),
      makeAssistantText('a1', 'reply 1'),
    ];
    // Tiny budget → the walk stops before the trailing turn; the trailing
    // group [2,3] is compacted whole (call and result together) and the cut
    // is a clean boundary.
    const result = selectCut(messages, { preserveTokens: 5, chainBoundaries: [0, 4] });
    expect(isCleanToolGroupBoundary(messages, result.cutIndex)).toBe(true);
    expect(result.cutIndex).toBe(4);
    expect(result.compactableRange).toEqual({ start: 0, end: 4 });
  });

  it('cross-chain splits snap backward so call/result pairs stay together', () => {
    const messages: Message[] = [
      makeUser('u0', 'turn 0'),
      makeAssistantText('a0', 'reply 0'),
      makeToolCallMsg('tcmsg-0', 'call-1', 'read'),
      makeToolResult('tr-1', 'call-1', 'read', 'file content'),
      makeUser('u1', 'turn 1'),
      makeAssistantText('a1', 'reply 1'),
    ];
    // Budget 20 lands the raw walk at index 3 — inside group [2,3] — so the
    // cut must snap back to the group start (2).
    const result = selectCut(messages, { preserveTokens: 20, chainBoundaries: [0, 3] });
    expect(isCleanToolGroupBoundary(messages, result.cutIndex)).toBe(true);
    expect(result.cutIndex).toBe(2);
  });
});

describe('selectCut — floors (R6)', () => {
  it('always preserves the trailing open group even under a tiny budget', () => {
    const messages: Message[] = [
      makeUser('u0', 'turn0'),
      makeAssistantText('a0', 'x'.repeat(500)),
      makeUser('u1', 'turn1'),
      makeAssistantText('a1', 'x'.repeat(500)),
      makeUser('u2', 'turn2'),
      makeToolCallMsg('tc-open', 'open-id', 'read', JSON.stringify({ path: 'a' })),
    ];
    const result = selectCut(messages, { preserveTokens: 1, chainBoundaries: [0, 2, 4] });
    expect(result.openGroupStart).toBe(5);
    expect(result.cutIndex).toBeLessThanOrEqual(5);
    expect(result.compactableRange.end).toBeLessThanOrEqual(5);
    expect(result.preservedRange.start).toBeLessThanOrEqual(5);
    expect(result.preservedRange.end).toBe(messages.length);
  });

  it('preserves the most recent completed group verbatim when it alone exceeds the budget', () => {
    const messages: Message[] = [
      makeUser('u0', 'start'),
      makeToolCallMsg('tc0', 'c0', 'read'),
      makeToolResult('tr0', 'c0', 'read', 'out0'),
      makeUser('u1', 'next'),
      makeToolCallMsg('tc1', 'c1', 'read'),
      makeToolResult('tr1', 'c1', 'read', 'x'.repeat(400)),
    ];
    // Budget 50 — the trailing result alone is ~100 tokens. The last complete
    // exchange must still survive verbatim (best-effort over budget).
    const result = selectCut(messages, { preserveTokens: 50, chainBoundaries: [0, 3] });
    expect(result.cutIndex).toBe(4); // group [4,5] preserved whole
    expect(result.compactableRange).toEqual({ start: 0, end: 4 });
    expect(messages.slice(result.cutIndex).some((m) => m.tool_call_id === 'c1')).toBe(true);
  });

  it('single runaway chain with completed groups + open group cuts to the open group', () => {
    const messages: Message[] = [
      makeUser('u0', 'start'),
      makeToolCallMsg('tc0', 'c0', 'read'),
      makeToolResult('tr0', 'c0', 'read', 'out0'),
      makeToolCallMsg('tc1', 'c1', 'read'),
      makeToolResult('tr1', 'c1', 'read', 'out1'),
      makeToolCallMsg('tc2', 'c2', 'read'),
      makeToolResult('tr2', 'c2', 'read', 'out2'),
      makeToolCallMsg('tc-open', 'c-open', 'grep'),
    ];
    const result = selectCut(messages, { preserveTokens: 1, chainBoundaries: [0] });
    expect(result.openGroupStart).toBe(7);
    expect(result.cutIndex).toBe(7);
    expect(result.compactableRange).toEqual({ start: 0, end: 7 });
    expect(result.preservedRange).toEqual({ start: 7, end: messages.length });
    expect(isCleanToolGroupBoundary(messages, result.cutIndex)).toBe(true);
  });
});

describe('selectCut — summary heads', () => {
  it('summary head is re-summarized (compactable), never preserved or counted', () => {
    const messages: Message[] = [
      makeSummaryHead('summ', 'prev summary'),
      makeUser('u0', 'x'.repeat(100)),
      makeAssistantText('a0', 'x'.repeat(100)),
      makeUser('u1', 'y'.repeat(100)),
      makeAssistantText('a1', 'y'.repeat(100)),
    ];
    // Budget 60: walk keeps a1+u1 (50); adding a0 → 75 > 60 → cut at 3.
    const result = selectCut(messages, { preserveTokens: 60, chainBoundaries: [0, 1, 3] });
    expect(result.cutIndex).toBe(3);
    expect(result.compactableRange).toEqual({ start: 0, end: 3 });
    expect(result.compactableRange.end > 0).toBe(true);
    expect(messages[0]!.compacted).toBeDefined();
    expect(result.preservedCount).toBe(1); // only the last real chain
  });

  it('summary head plus tiny real chain with a generous budget keeps everything', () => {
    const messages: Message[] = [
      makeSummaryHead('summ', 'prev summary'),
      makeUser('u0', 'hello'),
      makeAssistantText('a0', 'hi'),
    ];
    const result = selectCut(messages, { preserveTokens: 500, chainBoundaries: [0, 1] });
    expect(result.cutIndex).toBe(0);
    expect(result.compactableRange).toEqual({ start: 0, end: 0 });
  });

  it('only summary heads → nothing to compact', () => {
    const messages: Message[] = [makeSummaryHead('summ', 'only summary')];
    const result = selectCut(messages, { preserveTokens: 50, chainBoundaries: [0] });
    expect(result.compactableRange).toEqual({ start: 0, end: 0 });
  });

  // Regression: session "Refining Unity Compaction Code" — one user message,
  // a long single turn, one mid-turn compaction applied (prefix flagged, head
  // planted mid-history), usage far over the window. The inferred-boundaries
  // path saw one summary-only chain → realChains empty → compactable range
  // {0,0} forever, so no second compaction ever fired.
  it('mid-turn summary head does not empty realChains in a single-turn history (re-compaction regression)', () => {
    const messages: Message[] = [
      // 0: the turn's user message — flagged by the first compaction
      makeUser('u0', 'x'.repeat(1000)),
      // 1..5: flagged pre-compaction turn content
      makeToolCallMsg('tc0', 'c1', 'read'),
      makeToolResult('tr0', 'c1', 'read', 'x'.repeat(1000)),
      makeToolCallMsg('tc1', 'c2', 'read'),
      makeToolResult('tr1', 'c2', 'read', 'x'.repeat(1000)),
      makeAssistantText('a0', 'x'.repeat(1000)),
    ].map((m) => ({ ...m, excludeFromModel: true }));
    // 6: summary head (unflagged — it replays)
    messages.push(makeSummaryHead('summ', 'compaction handoff'));
    // 7..12: post-compaction accrual, same turn (no new user message)
    messages.push(makeToolCallMsg('tc2', 'c3', 'read'));
    messages.push(makeToolResult('tr2', 'c3', 'read', 'x'.repeat(1000)));
    messages.push(makeToolCallMsg('tc3', 'c4', 'read'));
    messages.push(makeToolResult('tr3', 'c4', 'read', 'x'.repeat(1000)));
    messages.push(makeToolCallMsg('tc4', 'c5', 'read'));
    messages.push(makeToolResult('tr4', 'c5', 'read', 'x'.repeat(1000)));

    // Inferred boundaries must split: [pre-head real) [head) [post-head real)
    expect(inferChainBoundaries(messages)).toEqual([0, 6, 7]);

    // Small preserve budget: the trailing tool group is preserved; everything
    // before it is compactable and the range must START ON the head (index 6)
    // so it is re-summarized, not skipped.
    const result = selectCut(messages, { preserveTokens: 60 });
    expect(result.compactableRange.end).toBeGreaterThan(result.compactableRange.start);
    expect(result.compactableRange.start).toBe(6);
    expect(result.cutIndex).toBeGreaterThanOrEqual(7);
  });
});

describe('selectCut — chain accounting', () => {
  it('infers boundaries from USER messages when not provided', () => {
    const messages: Message[] = [
      makeUser('u0', 'x'.repeat(100)),
      makeAssistantText('a0', 'x'.repeat(100)),
      makeUser('u1', 'x'.repeat(100)),
      makeAssistantText('a1', 'x'.repeat(100)),
      makeUser('u2', 'x'.repeat(100)),
      makeAssistantText('a2', 'x'.repeat(100)),
    ];
    // 25 tokens/message; budget 60 → keeps [4,6) (50 tokens), adding the
    // third-newest message exceeds → cut at 4, i.e. the u2 chain start.
    const result = selectCut(messages, { preserveTokens: 60 });
    expect(result.cutIndex).toBe(4);
    expect(result.preservedCount).toBe(1); // chain starting at u2 only
  });

  it('skips hidden/excluded prefix when reporting the compactable range', () => {
    const messages: Message[] = [
      makeMessage({ id: 'h1', role: MessageRole.ASSISTANT, content: 'x'.repeat(100), hidden: true }),
      makeUser('u0', 'x'.repeat(100)),
      makeAssistantText('a0', 'x'.repeat(100)),
    ];
    const result = selectCut(messages, { preserveTokens: 30, chainBoundaries: [0] });
    // Walk: a0 25, u0 50 > 30 → cut 2; compactable prefix skips the hidden message.
    expect(result.cutIndex).toBe(2);
    expect(result.compactableRange).toEqual({ start: 1, end: 2 });
  });

  it('handles empty history', () => {
    const result = selectCut([], { preserveTokens: 100 });
    expect(result).toEqual({
      cutIndex: 0,
      compactableRange: { start: 0, end: 0 },
      preservedCount: 0,
      openGroupStart: null,
      preservedRange: { start: 0, end: 0 },
    });
  });
});

describe('resolvePreservePercent — hysteresis guard', () => {
  it('keeps configured percent when below the re-arm cap', () => {
    expect(resolvePreservePercent({ threshold: 0.8, hysteresis_delta: 0.1, preserve_percent: 0.25 })).toBe(0.25);
  });

  it('caps preserve percent below the re-arm line', () => {
    // 0.8 - 0.1 - 0.05 = 0.65
    expect(resolvePreservePercent({ threshold: 0.8, hysteresis_delta: 0.1, preserve_percent: 0.9 })).toBe(0.65);
  });

  it('floors at 0.05 when the cap collapses', () => {
    expect(resolvePreservePercent({ threshold: 0.3, hysteresis_delta: 0.2, preserve_percent: 0.5 })).toBe(0.05);
  });

  it('defaults hysteresis delta to 0.1', () => {
    expect(resolvePreservePercent({ threshold: 0.5, preserve_percent: 0.9 })).toBeCloseTo(0.35, 10);
  });
});

describe('isCleanToolGroupBoundary', () => {
  it('reports true for clean boundaries and false inside groups', () => {
    const messages: Message[] = [
      makeUser('u0', 'a'),
      makeToolCallMsg('tc0', 'c1', 'read'),
      makeToolResult('tr0', 'c1', 'read', 'out'),
      makeUser('u1', 'b'),
      makeAssistantText('a1', 'text'),
    ];
    expect(isCleanToolGroupBoundary(messages, 0)).toBe(true);
    expect(isCleanToolGroupBoundary(messages, 1)).toBe(true); // before call
    expect(isCleanToolGroupBoundary(messages, 2)).toBe(false); // inside [1,2]
    expect(isCleanToolGroupBoundary(messages, 3)).toBe(true); // after group
  });
});

describe('analyzeToolGroups — unchanged primitives', () => {
  it('finds completed intervals and the open group', () => {
    const messages: Message[] = [
      makeUser('u0', 'a'),
      makeToolCallMsg('tc0', 'c1', 'read'),
      makeToolResult('tr0', 'c1', 'read', 'out'),
      makeToolCallMsg('tc1', 'c2', 'read'),
    ];
    const { completedIntervals, openGroupStart } = analyzeToolGroups(messages);
    expect(completedIntervals).toEqual([[1, 2]]);
    expect(openGroupStart).toBe(3);
  });
});

// ── R31: exempt ids (pinned user messages) ──────────────────────────────────

describe('selectCut — exempt ids (R31: pinned user messages)', () => {
  it('excludes exempt ids from the compactable range', () => {
    // 6 messages × 25 tokens each; budget 50 → suffix of 2 (50 tokens).
    // u0 (index 0) is exempt (pinned first user). Without exemption the cut
    // would land at 4 (suffix [4,6)). With u0 exempt, the cut is unaffected
    // (u0 sits before it) but the range's leading edge skips u0 — it never
    // enters the compactable range and is never flagged downstream.
    const messages = uniformMessages(6, 100);
    const exempt = new Set(['u-0']);
    const result = selectCut(messages, { preserveTokens: 50, chainBoundaries: [0], exemptIds: exempt });
    expect(result.cutIndex).toBe(4);
    expect(result.compactableRange).toEqual({ start: 1, end: 4 });
  });

  it('exempt ids in the suffix do not consume the preserve budget', () => {
    // 4 messages × 25 tokens each; budget 25 → suffix of 1 (25 tokens).
    // u-2 (index 2, a user message) is exempt. The suffix [3,4) fits 25 tokens.
    // If u-2 consumed budget, the suffix containing it would exceed — but u-2
    // is at index 2, not in [3,4). Instead make u-3 (index 3) exempt: the
    // suffix [3,4) contains u-3 which is exempt, so the budget for the
    // non-exempt content is 0 → cut could go further back. With u-3 exempt,
    // the suffix [3,4) has 0 non-exempt tokens → the walk keeps more.
    const messages = uniformMessages(4, 100); // u-0, a-1, u-2, a-3
    const exempt = new Set(['u-2']); // exempt user at index 2
    const result = selectCut(messages, { preserveTokens: 25, chainBoundaries: [0], exemptIds: exempt });
    // u-2 is exempt. The suffix walk filters u-2 from the estimate. With
    // budget 25: suffix [2,4) = {u-2(exempt), a-3} → non-exempt estimate 25 →
    // fits. So cut lands at 2 (or earlier if a-1 also fits). a-1 alone = 25
    // → [1,4) non-exempt = {a-1, a-3} = 50 > 25. So cut = 2.
    expect(result.cutIndex).toBe(2);
    // u-2 (exempt) is in the preserved window, not the compactable range.
    expect(result.preservedRange).toEqual({ start: 2, end: 4 });
    expect(result.compactableRange).toEqual({ start: 0, end: 2 });
  });

  it('extends the cut back across budget-free exempt ids in the suffix', () => {
    // 4 messages × 25 tokens; budget 50. u-2 (index 2) is exempt.
    // Without exemption the suffix walk stops at 2 ([2,4) = 50 tokens) and
    // u-2 costs budget. With u-2 budget-free the suffix [1,4) estimates only
    // {a-1, a-3} = 50 ≤ 50 → the walk extends back past u-2, landing it in
    // the preserved window (never in the compactable range).
    const messages = uniformMessages(4, 100); // u-0, a-1, u-2, a-3
    const exempt = new Set(['u-2']);
    const result = selectCut(messages, { preserveTokens: 50, chainBoundaries: [0], exemptIds: exempt });
    expect(result.cutIndex).toBe(1);
    expect(result.compactableRange).toEqual({ start: 0, end: 1 });
  });

  it('resolveUserExemptIds pins the last K user messages', () => {
    const messages: Message[] = [
      makeUser('u0', 'turn0'),
      makeAssistantText('a0', 'reply0'),
      makeUser('u1', 'turn1'),
      makeAssistantText('a1', 'reply1'),
      makeUser('u2', 'turn2'),
      makeAssistantText('a2', 'reply2'),
    ];
    const exempt = resolveUserExemptIds(messages, { keepLast: 2, pinFirst: false });
    expect(exempt.has('u0')).toBe(false);
    expect(exempt.has('u1')).toBe(true);
    expect(exempt.has('u2')).toBe(true);
  });

  it('resolveUserExemptIds pins the first user message when pinFirst is true', () => {
    const messages: Message[] = [
      makeUser('u0', 'turn0'),
      makeAssistantText('a0', 'reply0'),
      makeUser('u1', 'turn1'),
      makeAssistantText('a1', 'reply1'),
    ];
    const exempt = resolveUserExemptIds(messages, { keepLast: 1, pinFirst: true });
    // keepLast=1 → u1; pinFirst → u0. Both pinned.
    expect(exempt.has('u0')).toBe(true);
    expect(exempt.has('u1')).toBe(true);
  });

  it('resolveUserExemptIds with null keepLast pins ALL user messages (subagent R32)', () => {
    const messages: Message[] = [
      makeUser('u0', 'task head'),
      makeAssistantText('a0', 'reply0'),
      makeUser('u1', 'follow up'),
      makeAssistantText('a1', 'reply1'),
    ];
    const exempt = resolveUserExemptIds(messages, { keepLast: null, pinFirst: true });
    expect(exempt.has('u0')).toBe(true);
    expect(exempt.has('u1')).toBe(true);
    expect(exempt.size).toBe(2);
  });

  it('subagent scope (all user messages exempt) keeps user messages out of the compactable range', () => {
    // Simulate a subagent chain: task head (user) + tool-heavy turn.
    // With ALL user messages exempt, the task head never enters the
    // compactable range even under a tiny budget.
    const messages: Message[] = [
      makeUser('u0', 'task head'), // exempt
      makeToolCallMsg('tc0', 'c0', 'read'),
      makeToolResult('tr0', 'c0', 'read', 'x'.repeat(400)),
      makeToolCallMsg('tc1', 'c1', 'read'),
      makeToolResult('tr1', 'c1', 'read', 'x'.repeat(400)),
    ];
    const exempt = resolveUserExemptIds(messages, { keepLast: null, pinFirst: true });
    const result = selectCut(messages, { preserveTokens: 1, chainBoundaries: [0], exemptIds: exempt });
    // u0 is exempt: the range's leading edge skips index 0 entirely, and the
    // trailing tool group floors the cut at its start (nothing fits a
    // 1-token budget, so only the group floor keeps a preserved window).
    expect(result.compactableRange).toEqual({ start: 1, end: 3 });
    expect(result.preservedRange).toEqual({ start: 3, end: 5 });
    // u0's index (0) is never inside the compactable range.
    expect(result.compactableRange.start).toBeGreaterThan(0);
  });
});
