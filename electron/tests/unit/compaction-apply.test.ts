import { describe, expect, it, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Message } from '../../src/shared/types/message';
import { MessageRole, MessageType } from '../../src/shared/types/message';
import { ChainStatus, type Chain } from '../../src/shared/types/chain';
import { buildCompactionApply, validateCompactableRangeNotFlagged, buildMidTurnCheckpoint, buildReclaimOnlyApply, CompactionApplyError } from '../../src/main/llm/compaction/apply';
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
    // @ts-expect-error compacted optional
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

    const result = buildCompactionApply({ messages, chains, cutResult: cut, summaryText, mode: 'simple' });

    // flags + marker correct
    expect(result.flaggedIds.length).toBe(cut.compactableRange.end - cut.compactableRange.start);
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
    expect(result.updatedChains[0]!.messages[0]!.excludeFromModel).toBe(true);

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
    const reclaimedIds = [messages[0]!.id, messages[1]!.id]; // pretend two duplicates

    const result = buildCompactionApply({ messages, chains, cutResult: cut, summaryText: null, mode: 'simple', reclaimedIds });

    expect(result.summaryMessage).toBeNull();
    expect(result.newChain).toBeNull();
    expect(result.flaggedIds).toEqual(expect.arrayContaining(reclaimedIds));
    expect(result.updatedMessages.length).toBe(messages.length); // no insertion
    expect(result.updatedChains.length).toBe(chains.length); // no new chain
    for (const id of reclaimedIds) {
      expect(result.updatedMessages.find((m) => m.id === id)!.excludeFromModel).toBe(true);
    }
    // No compacted marker anywhere
    for (const m of result.updatedMessages) expect(m.compacted).toBeUndefined();
  });

  it('buildReclaimOnlyApply helper aliases reclaim path', () => {
    const { chains, messages, chainBoundaries } = buildSession(3);
    const cut = makeCut(messages, 1, chainBoundaries);
    const reclaimedIds = [messages[0]!.id];
    const result = buildReclaimOnlyApply(messages, chains, cut, reclaimedIds);
    expect(result.newChain).toBeNull();
    expect(result.flaggedIds).toContain(reclaimedIds[0]);
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

  it('validates compactable range is not already flagged', () => {
    const { chains, messages, chainBoundaries } = buildSession(3);
    const cut = makeCut(messages, 1, chainBoundaries);
    // Flag one message inside compactable range beforehand
    const flaggedMessages = messages.map((m, idx) => idx === 0 ? { ...m, excludeFromModel: true } : m);
    const { valid, alreadyFlaggedIds } = validateCompactableRangeNotFlagged(flaggedMessages, cut);
    expect(valid).toBe(false);
    expect(alreadyFlaggedIds).toContain(flaggedMessages[0]!.id);
    expect(() => buildCompactionApply({ messages: flaggedMessages, chains, cutResult: cut, summaryText: 'summary', mode: 'simple' })).toThrow(CompactionApplyError);
  });

  it('validateCompactableRangeNotFlagged passes when clean', () => {
    const { messages, chainBoundaries } = buildSession(3);
    const cut = makeCut(messages, 1, chainBoundaries);
    const { valid } = validateCompactableRangeNotFlagged(messages, cut);
    expect(valid).toBe(true);
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
    // Crash after: persisted state is compacted
    expect(persistedMessages.filter((m) => m.excludeFromModel).length).toBe(cut.compactableRange.end - cut.compactableRange.start);
    expect(persistedChains.some((c) => c.id === applyResult.newChain!.id)).toBe(true);
    // Summary head is its own chain, not merged into old
    const summaryChain = persistedChains.find((c) => c.id === applyResult.newChain!.id)!;
    expect(summaryChain.messages[0]!.compacted).toBeDefined();
    expect(summaryChain.messages[0]!.compacted!.mode).toBe('simple');
  });

  it('reclaim-only crash semantics same (flags atomically)', () => {
    const { chains, messages, chainBoundaries } = buildSession(3);
    const cut = makeCut(messages, 1, chainBoundaries);
    const reclaimedIds = [messages[0]!.id];
    const result = buildCompactionApply({ messages, chains, cutResult: cut, summaryText: null, mode: 'simple', reclaimedIds });
    // Before persist: nothing flagged
    expect(messages.find((m) => m.id === reclaimedIds[0])!.excludeFromModel).not.toBe(true);
    // After persist: flagged
    expect(result.updatedMessages.find((m) => m.id === reclaimedIds[0])!.excludeFromModel).toBe(true);
    expect(result.newChain).toBeNull();
  });
});

describe('compaction apply — mid-turn compaction survives simulated crash', () => {
  it('mid-turn checkpoint contains compacted flags + summary head is separate chain', () => {
    const sessionId = randomUUID();
    // Simulate flat history: 4 chains (8 messages), prior = first 6 messages (3 chains), active = last 2 messages (chain 3)
    const { chains, messages } = buildSession(4, sessionId);
    // Make active chain ACTIVE
    const activeChain = { ...chains[3]!, status: ChainStatus.ACTIVE as const };
    const priorChains = chains.slice(0, 3);
    const allChains = [...priorChains, activeChain];
    const priorMessageCount = 6; // first 3 chains *2
    const cut = { cutIndex: 4, compactableRange: { start: 0, end: 4 }, preservedCount: 1, openGroupStart: null, preservedRange: { start: 4, end: messages.length } } satisfies CutResult;

    const summaryText = 'mid-turn summary';
    const applyResult = buildCompactionApply({ messages, chains: allChains, cutResult: cut, summaryText, mode: 'simple', sessionId });

    // Build mid-turn checkpoint payload
    const mid = buildMidTurnCheckpoint(
      { messages, chains: allChains, cutResult: cut, summaryText, mode: 'simple', sessionId },
      applyResult,
      { sessionId, activeChainId: activeChain.id, priorMessageCount, activeChainMessages: activeChain.messages },
    );

    // Summary head is its own chain (not inside active checkpoint)
    expect(mid.summaryMessage).not.toBeNull();
    expect(mid.newChain).not.toBeNull();
    expect(mid.newChain!.messages[0]!.compacted).toBeDefined();

    // Checkpoint messages are the preserved tail after compaction (active chain slice)
    // In this setup cut=4, priorCount=6, so cut <= priorCount, summary inserted before active window,
    // so checkpoint should be the active chain's messages (preserved, not flagged)
    expect(mid.checkpointMessages.length).toBe(activeChain.messages.length);
    expect(mid.checkpointMessages.every((m) => !m.excludeFromModel)).toBe(true);

    // Simulate crash: durable state after checkpoint would be prior chains flagged + summary chain + checkpoint active chain
    // Verify that flagged messages exist in updatedFlatMessages
    const flaggedInFlat = mid.updatedFlatMessages.filter((m) => m.excludeFromModel);
    expect(flaggedInFlat.length).toBe(cut.compactableRange.end - cut.compactableRange.start);

    // Simulate that after crash, reloading session returns compacted view: flagged + summary + preserved
    const flatIds = mid.updatedFlatMessages.map((m) => m.id);
    expect(flatIds).toContain(mid.summaryMessage!.id);
    // The summary's compacted marker records correct range
    expect(mid.summaryMessage!.compacted!.rangeStart).toBe(messages[cut.compactableRange.start]!.id);
    expect(mid.summaryMessage!.compacted!.rangeEnd).toBe(messages[cut.compactableRange.end - 1]!.id);
  });

  it('mid-turn reclaim-only checkpoint flags only reclaim ids', () => {
    const sessionId = randomUUID();
    const { chains, messages } = buildSession(3, sessionId);
    const activeChain = { ...chains[2]!, status: ChainStatus.ACTIVE as const };
    const allChains = [...chains.slice(0, 2), activeChain];
    const priorMessageCount = 4;
    const cut = { cutIndex: 2, compactableRange: { start: 0, end: 2 }, preservedCount: 1, openGroupStart: null, preservedRange: { start: 2, end: messages.length } } satisfies CutResult;
    const reclaimedIds = [messages[0]!.id];

    const applyResult = buildCompactionApply({ messages, chains: allChains, cutResult: cut, summaryText: null, mode: 'simple', reclaimedIds, sessionId });
    const mid = buildMidTurnCheckpoint(
      { messages, chains: allChains, cutResult: cut, summaryText: null, mode: 'simple', reclaimedIds, sessionId },
      applyResult,
      { sessionId, activeChainId: activeChain.id, priorMessageCount, activeChainMessages: activeChain.messages },
    );

    expect(mid.summaryMessage).toBeNull();
    expect(mid.newChain).toBeNull();
    expect(mid.flaggedIds).toContain(reclaimedIds[0]);
    expect(mid.updatedFlatMessages.find((m) => m.id === reclaimedIds[0])!.excludeFromModel).toBe(true);
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

describe('compaction apply — integration with mocked session manager', () => {
  it('atomic persist mock: before persists old, after persists compacted', async () => {
    const { chains, messages, chainBoundaries, sessionId } = buildSession(4);
    const cut = makeCut(messages, 1, chainBoundaries);
    const summaryText = 'integrated summary';
    const applyResult = buildCompactionApply({ messages, chains, cutResult: cut, summaryText, mode: 'simple', sessionId });

    // Mock manager holds chains
    let persistedChains: Chain[] = [...chains];
    const mockManager = {
      getSession: (id: string) => (id === sessionId ? { id: sessionId, chains: persistedChains } : null),
    };
    const { persistCompactionBetweenTurns } = await import('../../src/main/llm/compaction/apply');
    // Before persist, mock still old
    expect(persistedChains.length).toBe(chains.length);
    // Simulate atomicWriter that updates persistedChains atomically
    const atomicWriter = async (sid: string, updatedChains: Chain[], newChain: Chain | null) => {
      expect(sid).toBe(sessionId);
      persistedChains = updatedChains;
      return true;
    };
    await persistCompactionBetweenTurns(sessionId, applyResult, { sessionManager: mockManager, atomicWriter });
    expect(persistedChains.length).toBe(chains.length + 1);
    expect(persistedChains.some((c) => c.id === applyResult.newChain!.id)).toBe(true);
    // Flagged
    const flaggedId = messages[0]!.id;
    const flaggedChain = persistedChains.find((c) => c.messages.some((m) => m.id === flaggedId))!;
    expect(flaggedChain.messages.find((m) => m.id === flaggedId)!.excludeFromModel).toBe(true);
  });
});
