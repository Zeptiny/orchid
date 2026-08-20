/**
 * Subagent selective-compaction SUCCESS path — R3 regression test.
 *
 * The selective branch must NEVER delete original messages from the subagent
 * chain: summarized/dropped/ranged-kept originals stay in the transcript with
 * excludeFromModel:true, a compacted-marker summary head is inserted at the
 * cut, and user messages are never flagged (R9/R31).
 *
 * Tested through buildSelectiveCompactionApply — the shared never-delete
 * selective-settle builder (R35) applySubagentPendingCompaction routes
 * selective success through, shared verbatim with the main scope.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Message } from '../../src/shared/types/message';
import { MessageRole, MessageType } from '../../src/shared/types/message';
import type { ToolCall } from '../../src/shared/types/tool';
import type { Chain } from '../../src/shared/types/chain';
import type { CutResult } from '../../src/main/llm/compaction/select';

// subagent-runner's static graph pulls provider/IPC-heavy leaves; stub them
// (same pattern as subagent-runner.test.ts). The compaction helpers under
// test (llm/compaction/*) load for real.
const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(() => ({ default_project_dir: null })),
  getSessionManager: vi.fn(() => ({
    getSession: vi.fn(() => ({ cwd: null })),
    getActive: vi.fn(() => ({ cwd: null })),
  })),
  providerRuntime: { resolveExecution: vi.fn(async () => ({})) },
}));

vi.mock('../../src/main/config/loader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/config/loader')>();
  return { ...actual, getConfig: mocks.getConfig };
});

vi.mock('../../src/main/session/singleton', () => ({
  getSessionManager: mocks.getSessionManager,
}));

vi.mock('../../src/main/project/runtime', () => ({
  getProjectRuntimeRegistry: () => ({ get: vi.fn() }),
}));

vi.mock('../../src/main/providers', () => ({
  getProviderRuntime: () => mocks.providerRuntime,
}));

vi.mock('../../src/main/providers/accounting/store', () => ({
  getProviderAccountingStore: () => ({}),
}));

vi.mock('../../src/main/providers/accounting/subagent-attribution-store', () => ({
  getSubagentAttributionStore: () => ({ insert: vi.fn(), finalize: vi.fn() }),
}));

vi.mock('../../src/main/llm/orchestrator', () => ({
  streamChat: vi.fn(),
}));

vi.mock('../../src/main/llm/build-prompt-context', () => ({
  buildSystemPromptContext: vi.fn(async () => ({})),
}));

vi.mock('../../src/main/mcp/project-registry', () => ({
  acquireProjectMCPManager: vi.fn(),
  releaseProjectMCPManager: vi.fn(),
}));

vi.mock('../../src/main/tools', () => ({
  getBuiltinToolRegistryForRuntime: vi.fn(),
}));

vi.mock('../../src/main/llm/message-factories', () => ({
  makeUserMessage: (content: string) => ({ role: 'user', content }),
}));

import { buildSelectiveCompactionApply } from '../../src/main/llm/compaction/apply';
import { applySubagentPendingCompaction } from '../../src/main/agents/subagent-compaction';
import type { SelectiveCompactionResult } from '../../src/main/llm/compaction/selective/run';
import type { CompactionPendingEntry } from '../../src/main/llm/compaction/pending-store';

// ── Fixture helpers ─────────────────────────────────────────────────────────

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
function makeAssistant(id: string, content: string): Message {
  return makeMessage({ id, role: MessageRole.ASSISTANT, content, type: MessageType.TEXT });
}
function makeToolCallMsg(id: string, callId: string, name: string, args = '{}'): Message {
  const tc: ToolCall = { id: callId, type: 'function', function: { name, arguments: args } };
  return makeMessage({
    id, role: MessageRole.ASSISTANT, content: '', type: MessageType.TOOL_CALL,
    tool_calls: [tc], tool_call_id: callId, name,
  });
}
function makeToolResult(id: string, callId: string, name: string, content: string): Message {
  return makeMessage({
    id, role: MessageRole.TOOL, content, type: MessageType.TOOL_RESULT,
    tool_call_id: callId, name,
  });
}
function makeSummaryPart(content: string): Message {
  return makeMessage({
    id: `summary-${Math.random().toString(36).slice(2, 9)}`,
    role: MessageRole.ASSISTANT, content, type: MessageType.TEXT,
    compacted: { rangeStart: 'unknown', rangeEnd: 'unknown', mode: 'selective' },
  });
}
function makeChain(id: string, messages: readonly Message[]): Chain {
  return {
    id,
    sessionId: 'session-sub',
    messages,
    status: 'active',
    selection: null,
    modelLabel: null,
    agentName: 'worker',
    agentType: 'subagent',
    agentTier: 'bloom',
    subagentRecord: null,
    startTime: new Date().toISOString(),
    endTime: null,
    errorDetail: null,
    errorTitle: null,
  };
}
type SelectiveSuccess = Extract<SelectiveCompactionResult, { kind: 'selective' }>;
function selectiveSuccess(input: {
  readonly flaggedIds: readonly string[];
  readonly summaryParts?: readonly string[];
}): SelectiveSuccess {
  const summaryMessages = (input.summaryParts ?? []).map((content) => makeSummaryPart(content));
  return {
    kind: 'selective',
    replayMessages: [],
    flaggedIds: [...input.flaggedIds],
    summaryMessages,
    summaryMessage: summaryMessages[0] ?? null,
    correctedOps: [],
    attempts: 1,
  };
}

/**
 * The subagent scope's route into the shared builder (R35): compose the
 * selective run's per-op summaries into one summary-head text, merge the
 * gate's reclaim ids, and settle — exactly what applySubagentPendingCompaction
 * does for a selective pending.
 */
function subagentSelectiveApply(params: {
  readonly messages: readonly Message[];
  readonly chains: readonly Chain[];
  readonly cutResult: CutResult;
  readonly selectiveResult: SelectiveSuccess;
  readonly reclaimedIds?: readonly string[];
  readonly sessionId?: string;
}) {
  const { selectiveResult } = params;
  const summaryParts = selectiveResult.summaryMessages.length > 0
    ? selectiveResult.summaryMessages.map((m) => m.content)
    : (selectiveResult.summaryMessage ? [selectiveResult.summaryMessage.content] : []);
  const summaryText = summaryParts.join('\n\n---\n\n').trim();
  return buildSelectiveCompactionApply({
    messages: params.messages,
    chains: params.chains,
    cutResult: params.cutResult,
    flaggedIds: selectiveResult.flaggedIds,
    summaryText: summaryText.length > 0 ? summaryText : null,
    ...(params.reclaimedIds ? { reclaimedIds: params.reclaimedIds } : {}),
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
  });
}

/** Chain of 6: compactable range [0,4), preserved window [4,6). */
const CUT: CutResult = {
  cutIndex: 4,
  compactableRange: { start: 0, end: 4 },
  preservedCount: 1,
  openGroupStart: null,
  preservedRange: { start: 4, end: 6 },
};
function baseMessages(): Message[] {
  return [
    makeUser('u1', 'explore the repo'),
    makeAssistant('a1', 'I will read the config files.'),
    makeToolCallMsg('tc1', 'call-1', 'read_file'),
    makeToolResult('tr1', 'call-1', 'read_file', 'file contents'),
    makeAssistant('a2', 'done reading'),
    makeUser('u2', 'follow up'),
  ];
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('buildSelectiveCompactionApply — subagent scope (R3: replacement never deletion)', () => {
  it('keeps every original message, flags only covered ids, inserts a compacted summary head at the cut', () => {
    const messages = baseMessages();
    const chains = [makeChain('chain-1', messages)];
    const selective = selectiveSuccess({
      flaggedIds: ['a1', 'tc1', 'tr1'], // summarize/drop/keep_range originals
      summaryParts: ['Summarized exploration work.'],
    });

    const result = subagentSelectiveApply({
      messages, chains, cutResult: CUT, selectiveResult: selective, sessionId: 'session-sub',
    });

    expect(result).not.toBeNull();
    expect(result!.didApply).toBe(true);

    // Every original survives — originals + exactly one inserted summary head.
    expect(result!.updatedMessages).toHaveLength(messages.length + 1);
    const byId = new Map(result!.updatedMessages.map((m) => [m.id, m] as const));
    for (const original of messages) {
      expect(byId.has(original.id), `original ${original.id} must survive compaction`).toBe(true);
    }

    // Summarized/dropped/ranged-kept ids leave only the model view.
    expect(byId.get('a1')?.excludeFromModel).toBe(true);
    expect(byId.get('tc1')?.excludeFromModel).toBe(true);
    expect(byId.get('tr1')?.excludeFromModel).toBe(true);
    // Kept verbatim + preserved window stay visible.
    expect(byId.get('u1')?.excludeFromModel).not.toBe(true);
    expect(byId.get('a2')?.excludeFromModel).not.toBe(true);
    expect(byId.get('u2')?.excludeFromModel).not.toBe(true);

    // Summary head carries the compacted marker and sits at the cut index.
    const head = result!.summaryMessage;
    expect(head).not.toBeNull();
    expect(head!.compacted?.mode).toBe('selective');
    expect(head!.content).toContain('Summarized exploration work.');
    expect(result!.compactedMarker?.mode).toBe('selective');
    expect(result!.updatedMessages[4]?.id).toBe(head!.id);

    // Returned flags cover the summarized ids and exclude users/suffix.
    expect([...result!.flaggedIds].sort()).toEqual(['a1', 'tc1', 'tr1']);

    // Model view (excludeFromModel filtered) = keep + summary + preserved tail.
    const modelView = result!.updatedMessages.filter((m) => !m.excludeFromModel);
    expect(modelView.map((m) => m.id)).toEqual(['u1', head!.id, 'a2', 'u2']);

    // Input chain and messages are never mutated.
    expect(messages.find((m) => m.id === 'a1')?.excludeFromModel).toBeUndefined();
    expect(chains[0]!.messages.find((m) => m.id === 'tr1')?.excludeFromModel).toBeUndefined();

    // Chains carry the same originals with the same flags.
    const chainMessages = result!.updatedChains.flatMap((c) => [...c.messages]);
    expect(chainMessages).toHaveLength(messages.length + 1);
    for (const original of messages) {
      expect(chainMessages.some((m) => m.id === original.id)).toBe(true);
    }
    expect(chainMessages.find((m) => m.id === 'tr1')?.excludeFromModel).toBe(true);
    expect(chainMessages.find((m) => m.id === 'u1')?.excludeFromModel).not.toBe(true);
    expect(chainMessages.some((m) => m.id === head!.id)).toBe(true);
  });

  it('never flags user messages even when the selective result lists them', () => {
    const messages = baseMessages();
    const selective = selectiveSuccess({
      flaggedIds: ['u1', 'a1'], // selective tried to drop the user message u1
      summaryParts: ['Summarized.'],
    });

    const result = subagentSelectiveApply({
      messages, chains: [makeChain('chain-1', messages)], cutResult: CUT, selectiveResult: selective,
    });

    expect(result).not.toBeNull();
    expect(result!.flaggedIds).toEqual(['a1']);
    const u1 = result!.updatedMessages.find((m) => m.id === 'u1');
    expect(u1?.excludeFromModel).not.toBe(true);
    // The non-user flagged id is still excluded from the model view.
    expect(result!.updatedMessages.find((m) => m.id === 'a1')?.excludeFromModel).toBe(true);
  });

  it('pure drop/ranged-keep (no summaries) applies reclaim-only flags and still preserves originals', () => {
    const messages = baseMessages();
    const selective = selectiveSuccess({ flaggedIds: ['a1', 'tr1'] });

    const result = subagentSelectiveApply({
      messages, chains: [makeChain('chain-1', messages)], cutResult: CUT, selectiveResult: selective,
    });

    expect(result).not.toBeNull();
    expect(result!.didApply).toBe(true);
    // Reclaim-only shape: flags without a summary head.
    expect(result!.summaryMessage).toBeNull();
    expect(result!.compactedMarker).toBeNull();
    expect(result!.updatedMessages).toHaveLength(messages.length);
    for (const original of messages) {
      expect(result!.updatedMessages.some((m) => m.id === original.id)).toBe(true);
    }
    expect(result!.updatedMessages.find((m) => m.id === 'a1')?.excludeFromModel).toBe(true);
    expect(result!.updatedMessages.find((m) => m.id === 'tr1')?.excludeFromModel).toBe(true);
    expect(result!.updatedMessages.find((m) => m.id === 'u1')?.excludeFromModel).not.toBe(true);
  });

  it('returns null (no-op) when the selective result kept everything', () => {
    const messages = baseMessages();
    const selective = selectiveSuccess({ flaggedIds: [] });

    const result = subagentSelectiveApply({
      messages, chains: [makeChain('chain-1', messages)], cutResult: CUT, selectiveResult: selective,
    });

    expect(result).toBeNull();
  });

  it('leaves pre-existing flags outside the covered range untouched', () => {
    const messages = baseMessages();
    messages[4] = { ...messages[4]!, excludeFromModel: true }; // a2 flagged earlier
    const selective = selectiveSuccess({ flaggedIds: ['a1'], summaryParts: ['Summarized.'] });

    const result = subagentSelectiveApply({
      messages, chains: [makeChain('chain-1', messages)], cutResult: CUT, selectiveResult: selective,
    });

    expect(result).not.toBeNull();
    // Preserved-window flag from an earlier compaction survives as-is.
    expect(result!.updatedMessages.find((m) => m.id === 'a2')?.excludeFromModel).toBe(true);
    expect(result!.updatedMessages.find((m) => m.id === 'a1')?.excludeFromModel).toBe(true);
    expect(result!.updatedMessages.find((m) => m.id === 'u2')?.excludeFromModel).not.toBe(true);
  });

  it('preserves a pre-existing exclusion inside the compactable range when this run did not flag it', () => {
    const messages = baseMessages();
    messages[2] = { ...messages[2]!, excludeFromModel: true }; // tc1 excluded by an earlier compaction
    const selective = selectiveSuccess({ flaggedIds: ['a1'], summaryParts: ['Summarized.'] });

    const result = subagentSelectiveApply({
      messages, chains: [makeChain('chain-1', messages)], cutResult: CUT, selectiveResult: selective,
    });

    expect(result).not.toBeNull();
    // In-range but not re-flagged by this run: the earlier exclusion survives.
    expect(result!.updatedMessages.find((m) => m.id === 'tc1')?.excludeFromModel).toBe(true);
    expect(result!.updatedMessages.find((m) => m.id === 'a1')?.excludeFromModel).toBe(true);
    expect(result!.updatedMessages.find((m) => m.id === 'tr1')?.excludeFromModel).not.toBe(true);
  });

  it('applySubagentPendingCompaction routes selective success through the shared builder (R35)', async () => {
    const messages = baseMessages();
    const chains = [makeChain('chain-1', messages)];
    const selective = selectiveSuccess({
      flaggedIds: ['a1', 'tc1', 'tr1'],
      summaryParts: ['Summarized exploration work.'],
    });
    const expected = subagentSelectiveApply({
      messages, chains, cutResult: CUT, selectiveResult: selective, reclaimedIds: [], sessionId: 'session-sub',
    });
    expect(expected).not.toBeNull();

    const pending: CompactionPendingEntry = {
      cut: CUT,
      flaggedIds: [],
      expectedIds: ['u1', 'a1', 'tc1', 'tr1'],
      estimatedInput: 800,
      contextTokens: 1000,
      mode: 'selective',
      selectivePromise: Promise.resolve({ kind: 'ran' as const, result: selective }),
    };

    const routed = await applySubagentPendingCompaction({
      pending,
      messages,
      chains,
      sessionId: 'session-sub',
    });

    // The runtime route (pause boundary / overflow retry) produces exactly the
    // shared builder's apply — one never-delete selective-settle for the scope.
    // (Summary-head ids are generated per invocation; compare positions and
    // flags instead of raw ids.)
    const shape = (apply: NonNullable<ReturnType<typeof subagentSelectiveApply>>) => {
      const headId = apply.summaryMessage?.id ?? null;
      return apply.updatedMessages.map((m) => [
        headId != null && m.id === headId ? '<head>' : m.id,
        m.excludeFromModel,
      ]);
    };
    expect(routed).not.toBeNull();
    expect(routed!.flaggedIds).toEqual(expected!.flaggedIds);
    expect(shape(routed!)).toEqual(shape(expected!));
    expect(routed!.summaryMessage?.content).toBe(expected!.summaryMessage?.content);
  });

  it('identical inputs produce identical applies across scopes (R35): main flag computation = subagent settle', () => {
    const messages = baseMessages();
    const chains = [makeChain('chain-1', messages)];
    const selective = selectiveSuccess({
      flaggedIds: ['a1', 'tc1', 'tr1'],
      summaryParts: ['Summarized exploration work.'],
    });

    // Subagent scope: full never-delete apply (flags + summary head).
    const subagentApply = subagentSelectiveApply({
      messages, chains, cutResult: CUT, selectiveResult: selective, sessionId: 'session-sub',
    });
    // Main scope: the same builder invoked the way persistSelectiveCompaction
    // does — replay-only (null summary text) — for the settled durable flags.
    const mainFlags = buildSelectiveCompactionApply({
      messages,
      chains,
      cutResult: CUT,
      flaggedIds: selective.flaggedIds,
      summaryText: null,
      sessionId: 'session-sub',
    });

    expect(subagentApply).not.toBeNull();
    expect(mainFlags).not.toBeNull();
    // The ids main writes durably are exactly the ids the subagent apply
    // excludes from the model view: one shared computation, two consumers.
    expect(mainFlags!.flaggedIds).toEqual(subagentApply!.flaggedIds);
    expect([...mainFlags!.flaggedIds].sort()).toEqual(['a1', 'tc1', 'tr1']);
  });
});
