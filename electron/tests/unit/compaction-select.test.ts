import { describe, expect, it } from 'vitest';
import type { Message } from '../../src/shared/types/message';
import { MessageRole, MessageType } from '../../src/shared/types/message';
import { selectCut, analyzeToolGroups, isCleanToolGroupBoundary } from '../../src/main/llm/compaction/select';
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
    // @ts-expect-error compacted is optional
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

function makeParallelToolCallsMsg(id: string, calls: Array<{ callId: string; name: string; args?: string }>): Message {
  const tcs: ToolCall[] = calls.map((c) => ({
    id: c.callId,
    type: 'function',
    function: { name: c.name, arguments: c.args ?? '{}' },
  }));
  return makeMessage({
    id,
    role: MessageRole.ASSISTANT,
    content: '',
    type: MessageType.TOOL_CALL,
    tool_calls: tcs,
    tool_call_id: calls[0]?.callId ?? null,
    name: calls[0]?.name ?? null,
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
    // @ts-expect-error compacted marker
    compacted: { rangeStart: 'msg-0', rangeEnd: 'msg-10', mode: 'simple' as const },
  });
}

// Build a history of N chains, each chain is: user -> assistant text -> maybe tool group
function buildChainMessages(chainCount: number, opts?: { withSummaryHead?: boolean }): { messages: Message[]; chainBoundaries: number[] } {
  const messages: Message[] = [];
  const boundaries: number[] = [];
  let idx = 0;
  if (opts?.withSummaryHead) {
    messages.push(makeSummaryHead(`summary-${idx++}`));
    boundaries.push(0);
  }
  for (let c = 0; c < chainCount; c += 1) {
    boundaries.push(messages.length);
    messages.push(makeUser(`u-${c}`, `user turn ${c}`));
    messages.push(makeAssistantText(`a-${c}`, `assistant reply ${c}`));
    // Add a tool group on even chains to exercise tool atomicity inside chain
    if (c % 2 === 0) {
      const callId = `tc-${c}`;
      messages.push(makeToolCallMsg(`tcmsg-${c}`, callId, 'read', JSON.stringify({ path: `file${c}.txt` })));
      messages.push(makeToolResult(`tr-${c}`, callId, 'read', `content ${c}`));
    }
  }
  return { messages, chainBoundaries: boundaries };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('selectCut — cut never splits a tool_call/result group (R5)', () => {
  it('does not cut inside a completed tool group', () => {
    // History: chain0 [user, assistant, tool_call(tc-1)], chain1 [tool_result, user...]
    // But chain boundary after tool_call, so tool group spans the chain boundary.
    // The cut honoring preserve-N=1 would be at chain1 start (between call and result) — must snap earlier.
    const messages: Message[] = [
      makeUser('u0', 'turn 0'),
      makeAssistantText('a0', 'reply 0'),
      makeToolCallMsg('tcmsg-0', 'call-1', 'read'),
      // chain boundary here would split group
      makeToolResult('tr-1', 'call-1', 'read', 'file content'),
      makeUser('u1', 'turn 1'),
      makeAssistantText('a1', 'reply 1'),
    ];
    // Two chains: chain0 = [u0,a0,tcmsg-0], chain1 = [tr-1,u1,a1]
    const chainBoundaries = [0, 3];
    const result = selectCut(messages, { keepRecentChains: 1, chainBoundaries });
    // Preserve last 1 chain => ideal cut at 3, but that splits tool group [2,3]
    // So cut must be at 2 (before the call) rather than 3
    expect(result.cutIndex).toBe(2);
    expect(result.compactableRange).toEqual({ start: 0, end: 2 });
    expect(isCleanToolGroupBoundary(messages, result.cutIndex)).toBe(true);
    // Verify compactable does not end inside group
    expect(isCleanToolGroupBoundary(messages, 3)).toBe(false);
  });

  it('preserves trailing open tool group entirely (no result yet)', () => {
    const messages: Message[] = [
      makeUser('u0', 'turn 0'),
      makeAssistantText('a0', 'reply 0'),
      makeUser('u1', 'turn 1'),
      makeToolCallMsg('tcmsg-1', 'open-1', 'grep', '{"pattern":"foo"}'),
      // No tool result — open group at tail
    ];
    const chainBoundaries = [0, 2];
    const result = selectCut(messages, { keepRecentChains: 1, chainBoundaries });
    expect(result.openGroupStart).toBe(3);
    // Cut must be <= openGroupStart
    expect(result.cutIndex).toBeLessThanOrEqual(3);
    // Preserve window includes open group
    expect(result.preservedRange.start).toBeLessThanOrEqual(3);
    expect(result.preservedRange.end).toBe(messages.length);
    // Compactable must not include open call
    expect(result.compactableRange.end).toBeLessThanOrEqual(3);
  });

  it('coalesced consecutive tool calls are treated as one atomic group', () => {
    const messages: Message[] = [
      makeUser('u0', 'initial'),
      makeParallelToolCallsMsg('tc-combined-should-be-split-but-coalesced', [
        { callId: 'c1', name: 'read' },
      ]),
      // hidden intermediate that history coalesces over
      makeMessage({ id: 'err', role: MessageRole.ASSISTANT, content: 'hidden error', type: MessageType.ERROR, hidden: true }),
      makeToolCallMsg('tc2', 'c2', 'grep'),
      makeToolResult('tr1', 'c1', 'read', 'file a'),
      makeToolResult('tr2', 'c2', 'grep', 'results'),
      makeUser('u1', 'next turn'),
      makeAssistantText('a1', 'done'),
    ];
    // This history has coalesced group starting at index1 (tc c1) through hidden error at 2 to tc c2 at 3, results at 4,5
    // So completed interval should be [1,5]
    const analysis = analyzeToolGroups(messages);
    expect(analysis.completedIntervals).toEqual(expect.arrayContaining([[1, 5]]));
    // Any cut inside [1,5] should be considered unclean
    expect(isCleanToolGroupBoundary(messages, 2)).toBe(false);
    expect(isCleanToolGroupBoundary(messages, 4)).toBe(false);
    expect(isCleanToolGroupBoundary(messages, 1)).toBe(true);
    expect(isCleanToolGroupBoundary(messages, 6)).toBe(true);

    // selectCut with keep=1 should not cut inside coalesced group
    const chainBoundaries = [0, 6];
    const result = selectCut(messages, { keepRecentChains: 1, chainBoundaries });
    // preserve last chain [6,8) => cut at 6 which is after group, safe
    expect(isCleanToolGroupBoundary(messages, result.cutIndex)).toBe(true);
  });

  it('cut inside a tool group is auto-snapped to group start', () => {
    const messages: Message[] = [
      makeUser('u0', 'a'),
      makeToolCallMsg('tc0', 'c-a', 'read'),
      makeToolResult('tr0', 'c-a', 'read', 'out a'),
      makeUser('u1', 'b'),
      makeToolCallMsg('tc1', 'c-b', 'read'),
      makeToolResult('tr1', 'c-b', 'read', 'out b'),
      makeUser('u2', 'c'),
      makeToolCallMsg('tc2', 'c-c', 'read'),
      makeToolResult('tr2', 'c-c', 'read', 'out c'),
    ];
    // Chain per user: boundaries [0,3,6]
    // Tool groups: [1,2], [4,5], [7,8]
    // keep 1 would like cut at 6, which is user message, safe (not inside group)
    const r1 = selectCut(messages, { keepRecentChains: 1, chainBoundaries: [0, 3, 6] });
    expect(r1.cutIndex).toBe(6);
    expect(isCleanToolGroupBoundary(messages, r1.cutIndex)).toBe(true);

    // Artificially request a cut that would be at 5 (inside group [4,5]) by setting keep=1 but crafting boundaries at 5
    // Simulate by providing boundaries that force inside: boundaries [0,3,5] where chain1 starts at 5 = tool result, splitting group [4,5]
    const r2 = selectCut(messages, { keepRecentChains: 1, chainBoundaries: [0, 3, 5] });
    // Ideal cut 5 is inside group [4,5], should snap to 4
    expect(r2.cutIndex).toBe(4);
    expect(isCleanToolGroupBoundary(messages, r2.cutIndex)).toBe(true);
  });
});

describe('selectCut — preserve-N honored (R6)', () => {
  it('honors keep_recent_chains over multiple chains', () => {
    const { messages, chainBoundaries } = buildChainMessages(5);
    // 5 chains, keep 2 => preserve last 2 chains
    const result = selectCut(messages, { keepRecentChains: 2, chainBoundaries });
    expect(result.preservedCount).toBe(2);
    // Preserved range should start at chain 3 (index 3)
    const expectedStart = chainBoundaries[chainBoundaries.length - 2]!;
    expect(result.cutIndex).toBe(expectedStart);
    expect(result.compactableRange.end).toBe(expectedStart);
    expect(result.openGroupStart).toBeNull(); // all groups completed
  });

  it('keep=0 preserves only open group (or nothing if no open)', () => {
    const { messages, chainBoundaries } = buildChainMessages(3);
    const resultNoOpen = selectCut(messages, { keepRecentChains: 0, chainBoundaries });
    expect(resultNoOpen.openGroupStart).toBeNull();
    expect(resultNoOpen.cutIndex).toBe(messages.length);
    expect(resultNoOpen.compactableRange).toEqual({ start: 0, end: messages.length });
    expect(resultNoOpen.preservedCount).toBe(0);

    // With open group, keep=0 still preserves open group
    const withOpen: Message[] = [
      makeUser('u0', 'a'),
      makeAssistantText('a0', 'reply'),
      makeUser('u1', 'b'),
      makeToolCallMsg('tc-open', 'call-open', 'read'),
    ];
    const boundaries2 = [0, 2];
    const resultOpen = selectCut(withOpen, { keepRecentChains: 0, chainBoundaries: boundaries2 });
    expect(resultOpen.openGroupStart).toBe(3);
    expect(resultOpen.cutIndex).toBe(3);
    expect(resultOpen.compactableRange).toEqual({ start: 0, end: 3 });
  });

  it('preserve window always includes trailing open group even when keep counts chains', () => {
    const messages: Message[] = [
      makeUser('u0', 'turn0'),
      makeAssistantText('a0', 'reply0'),
      makeUser('u1', 'turn1'),
      makeAssistantText('a1', 'reply1'),
      makeUser('u2', 'turn2'),
      makeToolCallMsg('tc-open', 'open-call', 'execute'),
      // open group at tail, no result
    ];
    const chainBoundaries = [0, 2, 4];
    // keep 1 would preserve last chain [4,6) which starts at 4, includes open call at 5 => already includes open
    const r1 = selectCut(messages, { keepRecentChains: 1, chainBoundaries });
    expect(r1.openGroupStart).toBe(5);
    expect(r1.cutIndex).toBe(4);
    expect(r1.preservedRange.start).toBe(4);
    // keep 2 would preserve [2,6) also includes open
    const r2 = selectCut(messages, { keepRecentChains: 2, chainBoundaries });
    expect(r2.cutIndex).toBe(2);
  });
});

describe('selectCut — preserve window shrinks under budget pressure to floor of open group', () => {
  it('shrinks keep count when preserve window exceeds budget', () => {
    // 4 chains with sizeable content; keep=3 would be large, but budget small
    const { messages, chainBoundaries } = buildChainMessages(4);
    // Make messages large to trigger budget
    const largeMessages = messages.map((m) => makeMessage({ ...m, content: m.content + ' x'.repeat(200) }));

    const keep3NoBudget = selectCut(largeMessages, { keepRecentChains: 3, chainBoundaries });
    expect(keep3NoBudget.preservedCount).toBe(3);
    expect(keep3NoBudget.cutIndex).toBe(chainBoundaries[1]);

    // Now with tight budget: maxPreserveTokens tiny, should shrink
    const tight = selectCut(largeMessages, {
      keepRecentChains: 3,
      chainBoundaries,
      maxPreserveTokens: 50, // very small, forces shrink
    });
    // Should have shrunk to fewer than 3
    expect(tight.preservedCount).toBeLessThan(3);
    // Still no open group, minimal is 0 chains when budget tiny
    expect(tight.preservedCount).toBeGreaterThanOrEqual(0);
    // Cut moved earlier? Actually shrinking reduces preserve window, so cut moves right (later)
    expect(tight.cutIndex).toBeGreaterThan(keep3NoBudget.cutIndex);
  });

  it('shrinks to floor of open group and never compacts the open group', () => {
    const messages: Message[] = [
      makeUser('u0', 'turn0'),
      makeAssistantText('a0', 'x'.repeat(500)),
      makeUser('u1', 'turn1'),
      makeAssistantText('a1', 'x'.repeat(500)),
      makeUser('u2', 'turn2'),
      makeToolCallMsg('tc-open', 'open-id', 'read', JSON.stringify({ path: 'a' })),
      // open at tail, no result
    ];
    const chainBoundaries = [0, 2, 4];
    // keep 2 would want to preserve 2 chains [2,6) huge, but budget tiny
    const result = selectCut(messages, {
      keepRecentChains: 2,
      chainBoundaries,
      maxPreserveTokens: 10, // forces shrink to open group only
    });
    expect(result.openGroupStart).toBe(5);
    expect(result.cutIndex).toBe(5);
    expect(result.preservedCount).toBe(1); // the last chain that contains the open group still counted, but shrunk from 2 to 1
    // Ensure open group not compacted
    expect(result.compactableRange.end).toBeLessThanOrEqual(5);
  });

  it('supports budget via contextTokens * threshold', () => {
    const { messages, chainBoundaries } = buildChainMessages(3);
    const large = messages.map((m) => makeMessage({ ...m, content: m.content + ' x'.repeat(300) }));

    const withBudget = selectCut(large, {
      keepRecentChains: 3,
      chainBoundaries,
      budget: { contextTokens: 100, threshold: 0.5 }, // max 50 tokens
    });
    // Should have shrunk
    expect(withBudget.preservedCount).toBeLessThan(3);
  });

  it('uses custom tokenEstimator when provided', () => {
    const { messages, chainBoundaries } = buildChainMessages(3);
    // Custom estimator counts messages, not chars
    const estimator = (msgs: readonly Message[]) => msgs.length * 10;
    const result = selectCut(messages, {
      keepRecentChains: 3,
      chainBoundaries,
      maxPreserveTokens: 15, // allow only ~1 message
      tokenEstimator: estimator,
    });
    expect(result.preservedCount).toBeLessThan(3);
    // With estimator, preserve slice length *10 must be <=15, so at most 1 message preserved
    expect(result.preservedRange.end - result.preservedRange.start).toBeLessThanOrEqual(2);
  });
});

describe('selectCut — summary head not counted', () => {
  it('excludes summary head from preserve count', () => {
    const { messages, chainBoundaries } = buildChainMessages(4, { withSummaryHead: true });
    // messages: [summaryHead, chain0, chain1, chain2, chain3]
    // chainBoundaries includes summary head as first chain [0,1)
    // realChains = 4 (excluding summary)
    const result = selectCut(messages, { keepRecentChains: 2, chainBoundaries });
    // Should preserve last 2 real chains, not counting summary
    expect(result.preservedCount).toBe(2);
    // Preserved start should be at chain 2 (third real chain), not counting summary
    // chainBoundaries: [0,1,3,6,9] approx depending on tool groups; preserve last 2 => start at boundaries[3] (chain2)
    const realStart = chainBoundaries[chainBoundaries.length - 2]!;
    expect(result.cutIndex).toBe(realStart);
    // Summary head at 0 is compactable (or stays), but not counted as preserved
    expect(result.compactableRange.start).toBe(0);
    expect(messages[0]!.compacted).toBeDefined();
  });

  it('single summary head plus one real chain still counts as single chain (empty compactable still holds)', () => {
    const messages: Message[] = [
      makeSummaryHead('summ', 'prev summary'),
      makeUser('u0', 'hello'),
      makeAssistantText('a0', 'hi'),
    ];
    const chainBoundaries = [0, 1];
    const result = selectCut(messages, { keepRecentChains: 2, chainBoundaries });
    // realChains = 1 => single-only-chain => empty compactable
    expect(result.compactableRange).toEqual({ start: 0, end: 0 });
    expect(result.cutIndex).toBe(0);
  });
});

describe('selectCut — single-only-chain yields empty compactable range', () => {
  it('returns empty compactable when only one chain exists', () => {
    const messages: Message[] = [
      makeUser('u0', 'hello'),
      makeAssistantText('a0', 'world'),
      makeToolCallMsg('tc0', 'call-1', 'read'),
      makeToolResult('tr0', 'call-1', 'read', 'out'),
    ];
    const result = selectCut(messages, { keepRecentChains: 3, chainBoundaries: [0] });
    expect(result.compactableRange).toEqual({ start: 0, end: 0 });
    expect(result.cutIndex).toBe(0);
    expect(result.preservedCount).toBe(1);
    expect(result.preservedRange).toEqual({ start: 0, end: messages.length });
  });

  it('single chain with explicit boundaries length 1 is empty even with keep=0', () => {
    const messages: Message[] = [makeUser('u0', 'hello'), makeAssistantText('a0', 'hi')];
    const result = selectCut(messages, { keepRecentChains: 0, chainBoundaries: [0] });
    expect(result.compactableRange.end).toBe(0);
    expect(result.cutIndex).toBe(0);
  });

  it('two chains yields non-empty compactable', () => {
    const { messages, chainBoundaries } = buildChainMessages(2);
    const result = selectCut(messages, { keepRecentChains: 1, chainBoundaries });
    expect(result.compactableRange.end).toBeGreaterThan(0);
    expect(result.compactableRange.start).toBe(0);
    expect(result.preservedCount).toBe(1);
  });
});

describe('selectCut — infer chain boundaries when not provided', () => {
  it('infers boundaries from USER messages', () => {
    const messages: Message[] = [
      makeUser('u0', 'a'),
      makeAssistantText('a0', 'reply a'),
      makeUser('u1', 'b'),
      makeAssistantText('a1', 'reply b'),
      makeUser('u2', 'c'),
      makeAssistantText('a2', 'reply c'),
    ];
    const result = selectCut(messages, { keepRecentChains: 1 });
    // Without boundaries, should infer 3 chains and preserve last 1 => cut at u2 (index 4)
    expect(result.preservedCount).toBe(1);
    expect(result.cutIndex).toBe(4);
  });
});

describe('selectCut — edge cases', () => {
  it('handles empty history', () => {
    const result = selectCut([], { keepRecentChains: 3 });
    expect(result).toEqual({
      cutIndex: 0,
      compactableRange: { start: 0, end: 0 },
      preservedCount: 0,
      openGroupStart: null,
      preservedRange: { start: 0, end: 0 },
    });
  });

  it('handles all-hidden or excluded messages', () => {
    const messages: Message[] = [
      makeMessage({ id: 'h1', role: MessageRole.ASSISTANT, content: 'hidden', hidden: true }),
      makeMessage({ id: 'h2', role: MessageRole.TOOL, content: 'hidden tool', hidden: true, tool_call_id: 'x' }),
    ];
    const result = selectCut(messages, { keepRecentChains: 1, chainBoundaries: [0] });
    // Single chain even though hidden, still empty compactable per single-chain rule? realChains count is 1 (chain with hidden msgs still counts as chain)
    expect(result.compactableRange).toEqual({ start: 0, end: 0 });
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
