import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Message } from '../../src/shared/types/message';
import { MessageRole, MessageType } from '../../src/shared/types/message';
import { ChainStatus, type Chain } from '../../src/shared/types/chain';
import { buildCompactionApply, validateCompactableRangeNotSummarized, CompactionApplyError, stampCompactionMetrics } from '../../src/main/llm/compaction/apply';
import type { CutResult } from '../../src/main/llm/compaction/select';

// Reuse MessageType / Role helpers
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

function makeUser(id: string, content = `user ${id}`): Message {
  return makeMessage({ id, role: MessageRole.USER, content, type: MessageType.TEXT });
}
function makeAssistant(id: string, content = `assistant ${id}`): Message {
  return makeMessage({ id, role: MessageRole.ASSISTANT, content, type: MessageType.TEXT });
}
function makeChain(id: string, sessionId: string, messages: Message[], status: Chain['status'] = ChainStatus.COMPLETED): Chain {
  return {
    id,
    sessionId,
    messages,
    status,
    selection: null,
    modelLabel: null,
    agentName: 'general',
    agentType: 'subagent',
    agentTier: 'bloom',
    subagentRecord: null,
    startTime: new Date().toISOString(),
    endTime: new Date().toISOString(),
    errorDetail: null,
    errorTitle: null,
  };
}

// Build sessions with N chains, each chain has 2 messages
function buildSession(chainCount: number, sessionId = randomUUID()): { sessionId: string; chains: Chain[]; messages: Message[]; chainBoundaries: number[] } {
  const chains: Chain[] = [];
  const messages: Message[] = [];
  const chainBoundaries: number[] = [];
  for (let c = 0; c < chainCount; c += 1) {
    chainBoundaries.push(messages.length);
    const u = makeUser(`u-${c}`, `user turn ${c} about project feature ${c}`);
    const a = makeAssistant(`a-${c}`, `assistant reply ${c} with details about implementation step ${c}`);
    messages.push(u, a);
    const chainId = `chain-${c}`;
    chains.push(makeChain(chainId, sessionId, [u, a], ChainStatus.COMPLETED));
  }
  return { sessionId, chains, messages, chainBoundaries };
}

function makeCut(messages: Message[], keepRecentChains: number, chainBoundaries: number[]): CutResult {
  // Simplified: cutIndex is start of last keepRecentChains chains
  const n = messages.length;
  if (keepRecentChains <= 0) return { cutIndex: n, compactableRange: { start: 0, end: n }, preservedCount: 0, openGroupStart: null, preservedRange: { start: n, end: n } };
  const k = Math.min(keepRecentChains, chainBoundaries.length);
  const cutIndex = chainBoundaries[chainBoundaries.length - k]!;
  return {
    cutIndex,
    compactableRange: { start: 0, end: cutIndex },
    preservedCount: k,
    openGroupStart: null,
    preservedRange: { start: cutIndex, end: n },
  };
}

describe('compaction apply — pure build', () => {
  it('flags compactable range and inserts summary head as its own chain', () => {
    const { sessionId, chains, messages, chainBoundaries } = buildSession(4);
    const cut = makeCut(messages, 1, chainBoundaries); // preserve last chain, compact first 3
    const summaryText = '### Handoff summary\n- Goal: implement feature X\n- Files: a.txt, b.txt\n- Remaining: tests';

    const result = buildCompactionApply({ messages, chains, cutResult: cut, summaryText, mode: 'simple', sessionId });

    // R31: user messages are never flagged — only non-user range messages are.
    const rangeUserIds = messages
      .slice(cut.compactableRange.start, cut.compactableRange.end)
      .filter((m) => m.role === MessageRole.USER)
      .map((m) => m.id);
    const expectedFlagged = (cut.compactableRange.end - cut.compactableRange.start) - rangeUserIds.length;
    expect(result.flaggedIds.length).toBe(expectedFlagged);
    expect(result.flaggedIds).not.toContainEqual(expect.arrayContaining(rangeUserIds));
    expect(result.updatedMessages.length).toBe(messages.length + 1); // + summary head
    const flaggedInFlat = result.updatedMessages.filter((m) => m.excludeFromModel);
    expect(flaggedInFlat.length).toBe(result.flaggedIds.length);

    // summary head is its own chain (R20)
    expect(result.summaryMessage).not.toBeNull();
    expect(result.newChain).not.toBeNull();
    expect(result.newChain!.messages).toHaveLength(1);
    expect(result.newChain!.messages[0]!.id).toBe(result.summaryMessage!.id);
    expect(result.newChain!.status).toBe(ChainStatus.COMPLETED);
    expect(result.summaryMessage!.compacted).toBeDefined();
    expect(result.summaryMessage!.compacted!.mode).toBe('simple');
    expect(result.summaryMessage!.compacted!.rangeStart).toBe(messages[cut.compactableRange.start]!.id);
    expect(result.summaryMessage!.compacted!.rangeEnd).toBe(messages[cut.compactableRange.end - 1]!.id);
    expect(result.summaryMessage!.compacted!.summarizedCount).toBe(cut.compactableRange.end - cut.compactableRange.start);

    // summary head not in older chains
    for (const chain of chains) {
      expect(chain.messages.some((m) => m.id === result.summaryMessage!.id)).toBe(false);
    }

    // updatedChains contains new chain plus flagged clones (never mutates input)
    expect(result.updatedChains.length).toBe(chains.length + 1);
    expect(result.updatedChains.some((c) => c.id === result.newChain!.id)).toBe(true);
    // input chains not mutated
    expect(chains[0]!.messages[0]!.excludeFromModel).not.toBe(true);
    // R31: user messages in the range stay un-flagged; non-user are flagged
    expect(result.updatedChains[0]!.messages[0]!.excludeFromModel).not.toBe(true); // u-0 user
    expect(result.updatedChains[0]!.messages[1]!.excludeFromModel).toBe(true); // a-0 assistant

    // summary sits before preserved window in flat replay
    const summaryIdx = result.updatedMessages.findIndex((m) => m.id === result.summaryMessage!.id);
    expect(summaryIdx).toBe(cut.cutIndex); // inserted at cutIndex after flagging
    // Preserved messages after summary are not flagged
    for (let i = summaryIdx + 1; i < result.updatedMessages.length; i += 1) {
      if (result.updatedMessages[i]!.compacted) continue;
      expect(result.updatedMessages[i]!.excludeFromModel).not.toBe(true);
    }
  });

  it('reclaim-only apply persists without summary head (flags without marker)', () => {
    const { chains, messages, chainBoundaries } = buildSession(3);
    const cut = makeCut(messages, 1, chainBoundaries);
    const reclaimedIds = [messages[0]!.id, messages[1]!.id]; // u-0 (user), a-0 (assistant)

    const result = buildCompactionApply({ messages, chains, cutResult: cut, summaryText: null, mode: 'simple', reclaimedIds });

    expect(result.summaryMessage).toBeNull();
    expect(result.newChain).toBeNull();
    // R31: user messages are never flagged — only a-0 survives the settle.
    expect(result.flaggedIds).toEqual(['a-0']);
    expect(result.updatedMessages.length).toBe(messages.length); // no insertion
    expect(result.updatedChains.length).toBe(chains.length); // no new chain
    // R31: user message u-0 is NOT flagged (stays in model view); a-0 is.
    expect(result.updatedMessages.find((m) => m.id === 'u-0')!.excludeFromModel).not.toBe(true);
    expect(result.updatedMessages.find((m) => m.id === 'a-0')!.excludeFromModel).toBe(true);
    // No compacted marker anywhere
    for (const m of result.updatedMessages) expect(m.compacted).toBeUndefined();
  });

  it('never mutates input messages or chains in place', () => {
    const { chains, messages, chainBoundaries } = buildSession(2);
    const cut = makeCut(messages, 1, chainBoundaries);
    const beforeMessages = messages.map((m) => ({ ...m }));
    const beforeChains = chains.map((c) => ({ ...c, messages: [...c.messages] }));
    const result = buildCompactionApply({ messages, chains, cutResult: cut, summaryText: 'summary', mode: 'simple' });
    // inputs unchanged
    expect(messages).toEqual(beforeMessages);
    expect(chains).toEqual(beforeChains);
    // result chains are new objects
    expect(result.updatedChains[0]).not.toBe(chains[0]);
  });

  it('empty compactable range yields no-op (no flags, no summary head)', () => {
    const { chains, messages } = buildSession(1);
    const cut: CutResult = { cutIndex: 0, compactableRange: { start: 0, end: 0 }, preservedCount: 1, openGroupStart: null, preservedRange: { start: 0, end: messages.length } };
    const result = buildCompactionApply({ messages, chains, cutResult: cut, summaryText: 'should not insert', mode: 'simple' });
    expect(result.didApply).toBe(false);
    expect(result.newChain).toBeNull();
    expect(result.summaryMessage).toBeNull();
    expect(result.updatedMessages).toEqual(messages);
  });
});

describe('compaction apply — pre-flagged inner messages are tolerated (FIX #4)', () => {
  it('apply succeeds over a range containing an inner flagged (cancelled-result) message; it stays flagged and a summary head is produced', () => {
    const { sessionId, chains, messages, chainBoundaries } = buildSession(3);
    // Cancelled tool result: flagged at creation (send.ts), persisted into the chain.
    // Sits INSIDE the compactable range [0,4) — not part of a contiguous prefix.
    const cancelledIdx = 2;
    const cancelled: Message = {
      ...messages[cancelledIdx]!,
      role: MessageRole.TOOL,
      type: MessageType.TOOL_RESULT,
      tool_call_id: 'call-cancelled',
      excludeFromModel: true,
    };
    messages[cancelledIdx] = cancelled;
    chains[1] = { ...chains[1]!, messages: [cancelled, messages[3]!] };

    const cut = makeCut(messages, 1, chainBoundaries); // range [0,4), cutIndex 4

    // Not fatal: pre-flagged messages are treated as already-excluded
    const { valid } = validateCompactableRangeNotSummarized(messages, cut);
    expect(valid).toBe(true);

    const result = buildCompactionApply({
      messages,
      chains,
      cutResult: cut,
      summaryText: 'summary over partially flagged range',
      mode: 'simple',
      sessionId,
    });

    expect(result.didApply).toBe(true);
    expect(result.summaryMessage).not.toBeNull();
    expect(result.newChain).not.toBeNull();

    // The cancelled message is skipped (already flagged, no double-processing)
    expect(result.flaggedIds).not.toContain(cancelled.id);
    // R31: user messages are never flagged — u-0 is excluded from flaggedIds.
    // The flagged set contains the non-user range messages (a-0, a-1).
    expect(result.flaggedIds).toEqual(expect.arrayContaining([messages[1]!.id, messages[3]!.id]));
    expect(result.flaggedIds).not.toContain(messages[0]!.id); // u-0 user
    // It keeps its existing flag in the flat replay and inside its chain
    expect(result.updatedMessages.find((m) => m.id === cancelled.id)!.excludeFromModel).toBe(true);
    const cancelledChain = result.updatedChains.find((c) => c.messages.some((m) => m.id === cancelled.id))!;
    expect(cancelledChain.messages.find((m) => m.id === cancelled.id)!.excludeFromModel).toBe(true);

    // R31: user message u-0 stays un-flagged; cancelled + a-0 + a-1 are flagged (3)
    expect(result.updatedMessages.filter((m) => m.excludeFromModel)).toHaveLength(3);
    const summaryIdx = result.updatedMessages.findIndex((m) => m.id === result.summaryMessage!.id);
    expect(summaryIdx).toBe(cut.cutIndex);
    // Preserved window after the summary stays replayable
    for (const m of result.updatedMessages.slice(summaryIdx + 1)) {
      expect(m.excludeFromModel).not.toBe(true);
    }
    // Marker anchors span the whole range, flagged-or-not
    expect(result.summaryMessage!.compacted!.rangeStart).toBe(messages[0]!.id);
    expect(result.summaryMessage!.compacted!.rangeEnd).toBe(messages[3]!.id);
  });

  it('allows a compacted summary head AT the range start (superseded head) and flags it like other range messages (P1 #5)', () => {
    const { sessionId, chains, messages, chainBoundaries } = buildSession(3);
    // A prior compaction's summary head sits at index 0 === compactableRange.start:
    // select.ts deliberately lands compactableStart ON the old head so a
    // re-compaction re-summarizes it under the new head.
    const priorSummary: Message = {
      ...makeMessage({ id: 'prior-summary-head', role: MessageRole.ASSISTANT, content: 'earlier handoff summary' }),
      compacted: { rangeStart: 'older-start', rangeEnd: 'older-end', mode: 'simple' },
    };
    messages[0] = priorSummary;
    chains[0] = { ...chains[0]!, messages: [priorSummary, messages[1]!] };

    const cut = makeCut(messages, 1, chainBoundaries); // range [0,4), head at index 0 === start

    const { valid, summaryHeadIds } = validateCompactableRangeNotSummarized(messages, cut);
    expect(valid).toBe(true);
    expect(summaryHeadIds).toEqual([]);

    const result = buildCompactionApply({
      messages,
      chains,
      cutResult: cut,
      summaryText: 'superseding summary',
      mode: 'simple',
      sessionId,
    });

    expect(result.didApply).toBe(true);
    expect(result.summaryMessage).not.toBeNull();
    // The superseded head is flagged like every other range message…
    expect(result.flaggedIds).toContain(priorSummary.id);
    expect(result.updatedMessages.find((m) => m.id === priorSummary.id)!.excludeFromModel).toBe(true);
    // …and the NEW head replaces it at the cut, unflagged and replayable.
    const newHeadIdx = result.updatedMessages.findIndex((m) => m.id === result.summaryMessage!.id);
    expect(newHeadIdx).toBe(cut.cutIndex);
    expect(result.summaryMessage!.excludeFromModel).toBe(false);
    for (const m of result.updatedMessages.slice(newHeadIdx + 1)) {
      expect(m.excludeFromModel).not.toBe(true);
    }
  });

  it('still throws CompactionApplyError when the range contains a compacted summary head (double compaction)', () => {
    const { chains, messages, chainBoundaries } = buildSession(3);
    // A prior compaction's summary head now inside the compactable range
    const priorSummary: Message = {
      ...makeMessage({ id: 'prior-summary-head', role: MessageRole.ASSISTANT, content: 'earlier handoff summary' }),
      compacted: { rangeStart: 'older-start', rangeEnd: 'older-end', mode: 'simple' },
    };
    messages[2] = priorSummary;
    chains[1] = { ...chains[1]!, messages: [priorSummary, messages[3]!] };

    const cut = makeCut(messages, 1, chainBoundaries); // range [0,4)

    const { valid, summaryHeadIds } = validateCompactableRangeNotSummarized(messages, cut);
    expect(valid).toBe(false);
    expect(summaryHeadIds).toContain(priorSummary.id);

    expect(() =>
      buildCompactionApply({ messages, chains, cutResult: cut, summaryText: 'second summary', mode: 'simple' }),
    ).toThrow(CompactionApplyError);
  });

  it('reclaim-only path never throws over a flagged or summarized range (unchanged behavior)', () => {
    const { chains, messages, chainBoundaries } = buildSession(3);
    const flagged: Message = { ...messages[2]!, excludeFromModel: true };
    messages[2] = flagged;
    chains[1] = { ...chains[1]!, messages: [flagged, messages[3]!] };
    const cut = makeCut(messages, 1, chainBoundaries);

    const result = buildCompactionApply({
      messages,
      chains,
      cutResult: cut,
      summaryText: null,
      mode: 'simple',
      // R31: use a non-user id (a-0) so reclaim actually flags something.
      reclaimedIds: [messages[1]!.id],
    });
    expect(result.didApply).toBe(true);
    expect(result.newChain).toBeNull();
    expect(result.summaryMessage).toBeNull();
    expect(result.updatedMessages.find((m) => m.id === messages[1]!.id)!.excludeFromModel).toBe(true);
  });

  it('validateCompactableRangeNotSummarized passes when the range is clean', () => {
    const { messages, chainBoundaries } = buildSession(3);
    const cut = makeCut(messages, 1, chainBoundaries);
    const { valid, summaryHeadIds } = validateCompactableRangeNotSummarized(messages, cut);
    expect(valid).toBe(true);
    expect(summaryHeadIds).toEqual([]);
  });
});

describe('compaction apply — intra-chain split keeps the original id on the preserved half (FIX #7)', () => {
  it('after-half retains the original chain id; flagged prefix gets a fresh id; summary head sits between them', () => {
    const { sessionId, chains, messages } = buildSession(3);
    // Make the split chain the session's ACTIVE chain (external activeChainId points at it)
    const originalId = chains[1]!.id;
    const activeSplitChain = { ...chains[1]!, status: ChainStatus.ACTIVE as const };
    const allChains = [chains[0]!, activeSplitChain, chains[2]!];
    // Cut strictly inside chain 1 (flat messages idx 2..3): [u-0,a-0,u-1) | [a-1,u-2,a-2]
    const cut: CutResult = {
      cutIndex: 3,
      compactableRange: { start: 0, end: 3 },
      preservedCount: 2,
      openGroupStart: null,
      preservedRange: { start: 3, end: messages.length },
    };

    const result = buildCompactionApply({
      messages,
      chains: allChains,
      cutResult: cut,
      summaryText: 'split summary',
      mode: 'simple',
      sessionId,
    });

    // The preserved after-half keeps the ORIGINAL id — exactly one chain has it
    const afterHalf = result.updatedChains.find((c) => c.id === originalId);
    expect(afterHalf).toBeDefined();
    expect(result.updatedChains.filter((c) => c.id === originalId)).toHaveLength(1);
    expect(afterHalf!.messages.map((m) => m.id)).toEqual([messages[3]!.id]);
    expect(afterHalf!.messages.every((m) => !m.excludeFromModel)).toBe(true);
    expect(afterHalf!.status).toBe(ChainStatus.ACTIVE); // status preserved on continuing half

    // The flagged prefix half gets a NEW id (frozen history). R31: messages[2]
    // is u-1 (a user message) — it stays un-flagged in the prefix half.
    const prefixHalf = result.updatedChains.find(
      (c) => c.id !== originalId && c.messages.some((m) => m.id === messages[2]!.id),
    );
    expect(prefixHalf).toBeDefined();
    expect(prefixHalf!.id).not.toBe(originalId);
    expect(prefixHalf!.messages.map((m) => m.id)).toEqual([messages[2]!.id]);
    expect(prefixHalf!.messages[0]!.excludeFromModel).not.toBe(true); // R31: user un-flagged
    expect(prefixHalf!.status).toBe(ChainStatus.ACTIVE); // statuses preserved on both halves

    // Replay order in updatedChains: prefix (new id) → summary head → after-half (original id)
    const prefixIdx = result.updatedChains.indexOf(prefixHalf!);
    const summaryChainIdx = result.updatedChains.findIndex((c) => c.id === result.newChain!.id);
    const afterIdx = result.updatedChains.indexOf(afterHalf!);
    expect(summaryChainIdx).toBe(prefixIdx + 1);
    expect(afterIdx).toBe(summaryChainIdx + 1);

    // Flat replay: summary head at cutIndex; non-user range messages flagged,
    // user messages un-flagged (R31), preserved tail un-flagged.
    const summaryIdx = result.updatedMessages.findIndex((m) => m.id === result.summaryMessage!.id);
    expect(summaryIdx).toBe(cut.cutIndex);
    expect(result.updatedMessages.slice(summaryIdx + 1).every((m) => !m.excludeFromModel)).toBe(true);
  });
});

describe('compaction apply — crash before/after (R22)', () => {
  it('crash before apply leaves old history; crash after leaves compacted', () => {
    const { chains, messages, chainBoundaries } = buildSession(4);
    const cut = makeCut(messages, 1, chainBoundaries);
    const summaryText = 'summary after crash';

    // Before: persist not yet called → old history
    const oldHistory = [...messages];
    const oldChains = [...chains];

    // Apply (pure) but don't persist yet → crash before leaves old
    const applyResult = buildCompactionApply({ messages, chains, cutResult: cut, summaryText, mode: 'simple' });
    // Simulate "crash before": we discard applyResult, reload old
    expect(oldHistory.every((m) => !m.excludeFromModel)).toBe(true);
    expect(oldChains.length).toBe(chains.length);

    // Simulate persist atomically (mock session manager)
    const persistedChains = applyResult.updatedChains;
    const persistedMessages = applyResult.updatedMessages;
    // Crash after: persisted state is compacted — R31: non-user range messages
    // are flagged, user range messages stay un-flagged in the model view.
    const rangeMessages = messages.slice(cut.compactableRange.start, cut.compactableRange.end);
    const nonUserRange = rangeMessages.filter((m) => m.role !== MessageRole.USER);
    const userRange = rangeMessages.filter((m) => m.role === MessageRole.USER);
    expect(persistedMessages.filter((m) => m.excludeFromModel)).toHaveLength(nonUserRange.length);
    expect(nonUserRange.every((m) => persistedMessages.find((x) => x.id === m.id)!.excludeFromModel)).toBe(true);
    expect(userRange.every((m) => !persistedMessages.find((x) => x.id === m.id)!.excludeFromModel)).toBe(true);
    expect(persistedChains.some((c) => c.id === applyResult.newChain!.id)).toBe(true);
    // Summary head is its own chain, not merged into old
    const summaryChain = persistedChains.find((c) => c.id === applyResult.newChain!.id)!;
    expect(summaryChain.messages[0]!.compacted).toBeDefined();
    expect(summaryChain.messages[0]!.compacted!.mode).toBe('simple');
  });

  it('reclaim-only crash semantics same (flags atomically)', () => {
    const { chains, messages, chainBoundaries } = buildSession(3);
    const cut = makeCut(messages, 1, chainBoundaries);
    // R31: reclaim a non-user id (a-0) — user ids are settled out of the
    // flagged set and could never flip to flagged.
    const reclaimedIds = [messages[1]!.id];
    const result = buildCompactionApply({ messages, chains, cutResult: cut, summaryText: null, mode: 'simple', reclaimedIds });
    // Before persist: nothing flagged
    expect(messages.find((m) => m.id === reclaimedIds[0])!.excludeFromModel).not.toBe(true);
    // After persist: flagged
    expect(result.updatedMessages.find((m) => m.id === reclaimedIds[0])!.excludeFromModel).toBe(true);
    expect(result.newChain).toBeNull();
  });
});

describe('compaction apply — mid-turn (active chain) outputs', () => {
  it('summary head is its own chain; preserved active tail stays unflagged and keeps its id', () => {
    const sessionId = randomUUID();
    // Simulate flat history: 4 chains (8 messages), prior = first 6 messages (3 chains), active = last 2 messages (chain 3)
    const { chains, messages } = buildSession(4, sessionId);
    // Make active chain ACTIVE
    const activeChain = { ...chains[3]!, status: ChainStatus.ACTIVE as const };
    const allChains = [...chains.slice(0, 3), activeChain];
    const cut = { cutIndex: 4, compactableRange: { start: 0, end: 4 }, preservedCount: 1, openGroupStart: null, preservedRange: { start: 4, end: messages.length } } satisfies CutResult;

    const result = buildCompactionApply({ messages, chains: allChains, cutResult: cut, summaryText: 'mid-turn summary', mode: 'simple', sessionId });

    // Summary head is its own chain (not inside the active chain)
    expect(result.summaryMessage).not.toBeNull();
    expect(result.newChain).not.toBeNull();
    expect(result.newChain!.messages[0]!.compacted).toBeDefined();

    // Flat replay: non-user range messages flagged, user range messages
    // un-flagged (R31), summary head at cut, preserved tail unflagged
    expect(result.updatedMessages).toHaveLength(messages.length + 1);
    const summaryIdx = result.updatedMessages.findIndex((m) => m.id === result.summaryMessage!.id);
    expect(summaryIdx).toBe(cut.cutIndex);
    const preSummary = result.updatedMessages.slice(0, summaryIdx);
    expect(preSummary.filter((m) => m.role !== MessageRole.USER).every((m) => m.excludeFromModel)).toBe(true);
    expect(preSummary.filter((m) => m.role === MessageRole.USER).every((m) => !m.excludeFromModel)).toBe(true);
    expect(result.updatedMessages.slice(summaryIdx + 1).every((m) => !m.excludeFromModel)).toBe(true);

    // The ACTIVE chain keeps its id and holds the preserved (unflagged) tail —
    // resumed-turn writes keep landing in the live chain
    const activeAfter = result.updatedChains.find((c) => c.id === activeChain.id);
    expect(activeAfter).toBeDefined();
    expect(activeAfter!.messages).toHaveLength(activeChain.messages.length);
    expect(activeAfter!.messages.every((m) => !m.excludeFromModel)).toBe(true);
    expect(activeAfter!.status).toBe(ChainStatus.ACTIVE);

    // The summary's compacted marker records the correct range
    expect(result.summaryMessage!.compacted!.rangeStart).toBe(messages[cut.compactableRange.start]!.id);
    expect(result.summaryMessage!.compacted!.rangeEnd).toBe(messages[cut.compactableRange.end - 1]!.id);
  });

  it('mid-turn reclaim-only flags only reclaim ids and creates no summary chain', () => {
    const sessionId = randomUUID();
    const { chains, messages } = buildSession(3, sessionId);
    const activeChain = { ...chains[2]!, status: ChainStatus.ACTIVE as const };
    const allChains = [...chains.slice(0, 2), activeChain];
    const cut = { cutIndex: 2, compactableRange: { start: 0, end: 2 }, preservedCount: 1, openGroupStart: null, preservedRange: { start: 2, end: messages.length } } satisfies CutResult;
    // R31: reclaim a non-user id (a-0) — user ids never enter the flagged set.
    const reclaimedIds = [messages[1]!.id];

    const result = buildCompactionApply({ messages, chains: allChains, cutResult: cut, summaryText: null, mode: 'simple', reclaimedIds, sessionId });

    expect(result.summaryMessage).toBeNull();
    expect(result.newChain).toBeNull();
    expect(result.flaggedIds).toContain(reclaimedIds[0]);
    expect(result.updatedMessages.find((m) => m.id === reclaimedIds[0])!.excludeFromModel).toBe(true);
    // Active chain keeps its id, unflagged
    const activeAfter = result.updatedChains.find((c) => c.id === activeChain.id);
    expect(activeAfter!.messages.every((m) => !m.excludeFromModel)).toBe(true);
  });
});

describe('compaction apply — flags + marker correct', () => {
  it('compacted marker has rangeStart, rangeEnd, mode, summarizedCount', () => {
    const { chains, messages, chainBoundaries } = buildSession(5);
    const cut = makeCut(messages, 2, chainBoundaries);
    const result = buildCompactionApply({ messages, chains, cutResult: cut, summaryText: 'handoff', mode: 'selective' });
    expect(result.summaryMessage!.compacted).toEqual({
      rangeStart: messages[cut.compactableRange.start]!.id,
      rangeEnd: messages[cut.compactableRange.end - 1]!.id,
      mode: 'selective',
      summarizedCount: cut.compactableRange.end - cut.compactableRange.start,
    });
  });

  it('summary head message is assistant TEXT with compacted marker and not excluded', () => {
    const { chains, messages, chainBoundaries } = buildSession(3);
    const cut = makeCut(messages, 1, chainBoundaries);
    const result = buildCompactionApply({ messages, chains, cutResult: cut, summaryText: 'summary text', mode: 'simple' });
    expect(result.summaryMessage!.role).toBe(MessageRole.ASSISTANT);
    expect(result.summaryMessage!.type).toBe(MessageType.TEXT);
    expect(result.summaryMessage!.content).toBe('summary text');
    expect(result.summaryMessage!.excludeFromModel).toBe(false);
    expect(result.summaryMessage!.hidden).toBe(false);
    expect(result.summaryMessage!.compacted).toBeDefined();
  });

  it('flagged messages remain visible (hidden false) but excluded from model', () => {
    const { chains, messages, chainBoundaries } = buildSession(3);
    const cut = makeCut(messages, 1, chainBoundaries);
    const result = buildCompactionApply({ messages, chains, cutResult: cut, summaryText: 'summary', mode: 'simple' });
    for (const id of result.flaggedIds) {
      const m = result.updatedMessages.find((x) => x.id === id)!;
      expect(m.hidden).toBe(false);
      expect(m.excludeFromModel).toBe(true);
    }
  });
});

describe('compaction apply — persisted-shape outputs (pure build)', () => {
  it('produces flagged chains plus a summary chain ready for one atomic write', () => {
    const { chains, messages, chainBoundaries, sessionId } = buildSession(4);
    const cut = makeCut(messages, 1, chainBoundaries);
    const applyResult = buildCompactionApply({ messages, chains, cutResult: cut, summaryText: 'integrated summary', mode: 'simple', sessionId });

    // One extra chain (the summary head); every original chain id survives exactly once
    expect(applyResult.updatedChains).toHaveLength(chains.length + 1);
    expect(applyResult.updatedChains.some((c) => c.id === applyResult.newChain!.id)).toBe(true);
    for (const c of chains) {
      expect(applyResult.updatedChains.filter((x) => x.id === c.id)).toHaveLength(1);
    }

    // Flagged message is flagged inside its (cloned) chain — R31: use a
    // non-user id (a-0); user range messages stay un-flagged.
    const flaggedId = messages[1]!.id;
    const flaggedChain = applyResult.updatedChains.find((c) => c.messages.some((m) => m.id === flaggedId))!;
    expect(flaggedChain.messages.find((m) => m.id === flaggedId)!.excludeFromModel).toBe(true);

    // Preserved chain keeps its id and stays replayable
    const preserved = applyResult.updatedChains.find((c) => c.id === chains[3]!.id)!;
    expect(preserved.messages.every((m) => !m.excludeFromModel)).toBe(true);

    // Flat replay: summary head lands between the flagged range and the preserved window
    const summaryIdx = applyResult.updatedMessages.findIndex((m) => m.id === applyResult.summaryMessage!.id);
    expect(summaryIdx).toBe(cut.cutIndex);
    const preSummary = applyResult.updatedMessages.slice(0, summaryIdx);
    expect(preSummary.filter((m) => m.role !== MessageRole.USER).every((m) => m.excludeFromModel)).toBe(true);
    expect(preSummary.filter((m) => m.role === MessageRole.USER).every((m) => !m.excludeFromModel)).toBe(true);
  });
});

describe('stampCompactionMetrics', () => {
  function buildApplied() {
    const { chains, messages, chainBoundaries, sessionId } = buildSession(3);
    const cut = makeCut(messages, 1, chainBoundaries);
    return buildCompactionApply({
      messages,
      chains,
      cutResult: cut,
      summaryText: 'handoff summary',
      mode: 'simple',
      sessionId,
    });
  }

  it('stamps tokensFreed and compactorTokens on every summary-head reference', () => {
    const applied = buildApplied();
    const stamped = stampCompactionMetrics(applied, {
      tokensFreed: 42_500,
      compactorTokens: { inputTokens: 5_800, outputTokens: 895 },
    });

    expect(stamped).not.toBe(applied);
    expect(stamped.summaryMessage?.compacted?.tokensFreed).toBe(42_500);
    expect(stamped.summaryMessage?.compacted?.compactorTokens).toEqual({
      inputTokens: 5_800,
      outputTokens: 895,
    });
    // updatedMessages and newChain hold the SAME stamped instance
    const inFlat = stamped.updatedMessages.find((m) => m.id === stamped.summaryMessage!.id);
    expect(inFlat).toBe(stamped.summaryMessage);
    expect(stamped.newChain!.messages[0]).toBe(stamped.summaryMessage);
    // Base marker fields survive
    expect(stamped.summaryMessage?.compacted?.mode).toBe('simple');
    expect(stamped.compactedMarker?.tokensFreed).toBe(42_500);
  });

  it('clamps negative tokensFreed to zero and floors fractions', () => {
    const stamped = stampCompactionMetrics(buildApplied(), { tokensFreed: -10.7 });
    expect(stamped.summaryMessage?.compacted?.tokensFreed).toBe(0);
    const floored = stampCompactionMetrics(buildApplied(), { tokensFreed: 12.9 });
    expect(floored.summaryMessage?.compacted?.tokensFreed).toBe(12);
  });

  it('passes through unchanged without metrics or without a summary head', () => {
    const applied = buildApplied();
    expect(stampCompactionMetrics(applied, {})).toBe(applied);
    expect(
      stampCompactionMetrics({ ...applied, summaryMessage: null, newChain: null }, { tokensFreed: 10 }),
    ).toEqual({ ...applied, summaryMessage: null, newChain: null });
  });
});
