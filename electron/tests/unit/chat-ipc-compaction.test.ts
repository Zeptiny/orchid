import { resetHarness, setupChatIpcTest } from './chat-ipc-harness';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../src/shared/types/ipc';
import type { Agent } from '../../src/shared/types/agent';
import { MessageRole, MessageType } from '../../src/shared/types/message';

const {
  mocks,
  successfulToolResult,
  doneEvents,
  channelEvents,
  waitForDoneCount,
  waitForChannelCount,
  makeSession,
} = setupChatIpcTest();

let chatIpc: typeof import('../../src/main/ipc/chat');

const selection = {
  connectionId: '11111111-1111-4111-8111-111111111111',
  modelId: 'vendor/path/model',
};

interface CompactionSuiteOptions {
  readonly mainMode?: 'simple' | 'selective';
  readonly agents?: Map<string, Agent>;
  readonly keepLastUserMessages?: number;
  readonly pinFirstUserMessage?: boolean;
  /** Queue the contextTokens=2000 execution resolution (default true). */
  readonly overrideExecution?: boolean;
}

/**
 * Shared suite setup: common runtime config (compaction knobs, session-title
 * wait, max tool steps) plus the once-execution override and handler
 * (re)registration every compaction suite needs. Suites pass only their
 * differences.
 */
function registerCompactionSuite(options: CompactionSuiteOptions = {}): void {
  beforeEach(async () => {
    resetHarness();
    const mainCompaction: Record<string, unknown> = {
      mode: options.mainMode ?? 'simple',
      threshold: 0.5,
      model: null,
      agent_name: 'compactor',
      preserve_percent: 0.25,
      min_compactable_tokens: 0,
      mechanical_reclaim: true,
      hysteresis_delta: 0.1,
    };
    if (options.keepLastUserMessages !== undefined) {
      mainCompaction.keep_last_user_messages = options.keepLastUserMessages;
    }
    if (options.pinFirstUserMessage !== undefined) {
      mainCompaction.pin_first_user_message = options.pinFirstUserMessage;
    }
    mocks.runtimeRegistry._set(mocks.workspace._testProjectDir, {
      config: {
        default_model: null,
        tier_models: { bloom: null },
        command_timeout: 30,
        llm_stream_idle_timeout: 60,
        llm_stream_retries: 0,
        session_title_max_wait_seconds: 0,
        max_tool_steps: 100,
        compaction: {
          main: mainCompaction,
          subagents: {
            mode: 'simple',
            threshold: 0.85,
            model: null,
            agent_name: 'compactor-subagent',
            preserve_percent: 0.25,
            min_compactable_tokens: 4000,
            mechanical_reclaim: true,
            hysteresis_delta: 0.1,
          },
        },
      },
      ...(options.agents ? { agents: options.agents } : {}),
    });
    if (options.overrideExecution !== false) {
      mocks.providerRuntime.resolveExecution.mockImplementationOnce(async () => ({
        modelInstance: mocks.modelInstance,
        connection: {},
        model: {
          id: 'vendor/path/model',
          capabilities: { reasoning: false },
          limits: { contextTokens: 2000 },
        },
        snapshot: {
          providerId: 'openai',
          providerDisplayName: 'OpenAI',
          connectionId: selection.connectionId,
          connectionName: 'Work',
          modelId: selection.modelId,
          protocol: 'openai-compatible',
          modelSource: 'catalog',
          catalogVersion: 1,
          catalogSource: 'bundled',
          catalogObservedAt: null,
          pricing: null,
          fieldProvenance: {},
          statusObservation: null,
        },
      }));
    }
    chatIpc = await import('../../src/main/ipc/chat');
    chatIpc.registerChatIPC();
  });

  afterEach(() => {
    chatIpc.unregisterChatIPC();
    mocks.handlers.clear();
    mocks.sessionManager._reset();
  });
}

function textOnlyStream() {
  return async function* () {
    yield { type: 'text', data: 'ok' };
    yield { type: 'finish', finishReason: 'stop' };
  };
}

describe('chat compaction mid-turn pause', () => {
  registerCompactionSuite();

  function compactionStream() {
    return async function* () {
      yield {
        type: 'tool_call',
        toolCallId: 'tc-compact-1',
        toolName: 'read',
        args: '{"path":"README.md"}',
      };
      yield successfulToolResult('tc-compact-1', 'x'.repeat(2000));
      yield {
        type: 'tool_call',
        toolCallId: 'tc-compact-2',
        toolName: 'read',
        args: '{"path":"AGENTS.md"}',
      };
      yield successfulToolResult('tc-compact-2', 'y'.repeat(2000));
      yield {
        type: 'usage',
        usage: {
          prompt_tokens: 1800,
          completion_tokens: 40,
          total_tokens: 1840,
          cached_tokens: 0,
        },
      };
      yield { type: 'finish', finishReason: 'stop' };
    };
  }

  it('resumes with accumulated turn history when the summary cannot be applied', async () => {
    const sessionId = 'e0e0e0e0-e0e0-4e0e-8e0e-e0e0e0e0e0e0';
    mocks.sessionManager._setActive({
      ...makeSession(sessionId),
      model: selection.modelId,
      selection,
      modelLabel: selection.modelId,
    });
    mocks.summarizeCompactableRange.mockResolvedValueOnce(null);
    mocks.streamChat.mockImplementationOnce(compactionStream());

    const send = vi.fn();
    const chatSend = mocks.handlers.get(IPC_CHANNELS.CHAT_SEND)!;
    await chatSend({ sender: { id: 940, send } }, { message: 'Explore with tools' });
    await waitForDoneCount(send, 1);

    expect(mocks.streamChat).toHaveBeenCalledTimes(2);
    const resumedMessages = mocks.streamChat.mock.calls[1]![0]!.messages as Array<{
      role: string;
      tool_call_id?: string;
    }>;
    // The resumed replay must keep the turn's tool progress (the pre-fix code
    // restarted from the bare turn base, collapsing context usage to the
    // turn-start baseline with no compaction applied).
    expect(resumedMessages.filter((m) => m.role === MessageRole.USER)).toHaveLength(1);
    expect(resumedMessages.filter((m) => m.tool_call_id === 'tc-compact-1')).toHaveLength(2);
    expect(resumedMessages.filter((m) => m.tool_call_id === 'tc-compact-2')).toHaveLength(2);
    const compactionEvents = channelEvents(send, IPC_CHANNELS.CHAT_COMPACTION_PROGRESS)
      .map(([, payload]) => payload);
    expect(compactionEvents.length).toBeGreaterThanOrEqual(2);
    // The window is resolvable, so the preparing widget event lands first
    // (production always delivered it; the old fromId=null mock dropped it).
    expect(compactionEvents[0]).toMatchObject({ phase: 'preparing', agentScopeId: 'main' });
    expect(compactionEvents).toContainEqual(
      expect.objectContaining({ phase: 'compacting', agentScopeId: 'main' }),
    );
    expect(compactionEvents.at(-1)).toMatchObject({ phase: 'complete', agentScopeId: 'main' });
  });

  it('applies the pending summary mid-turn and replays the compacted history', async () => {
    const sessionId = 'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1';
    mocks.sessionManager._setActive({
      ...makeSession(sessionId),
      model: selection.modelId,
      selection,
      modelLabel: selection.modelId,
    });
    mocks.summarizeCompactableRange.mockResolvedValueOnce({
      text: 'SUMMARY: explored compaction module',
    });
    mocks.streamChat.mockImplementationOnce(compactionStream());

    const send = vi.fn();
    const chatSend = mocks.handlers.get(IPC_CHANNELS.CHAT_SEND)!;
    await chatSend({ sender: { id: 941, send } }, { message: 'Explore with tools' });
    await waitForDoneCount(send, 1);

    expect(mocks.streamChat).toHaveBeenCalledTimes(2);
    const resumedMessages = mocks.streamChat.mock.calls[1]![0]!.messages as Array<{
      role: string;
      content?: string;
      compacted?: unknown;
      excludeFromModel?: boolean;
    }>;
    const summary = resumedMessages.find((m) => m.compacted);
    expect(summary?.content).toBe('SUMMARY: explored compaction module');
    // Compacted range messages are excluded from replay but never deleted.
    expect(resumedMessages.some((m) => m.tool_call_id === 'tc-compact-1' && m.excludeFromModel)).toBe(true);
    // The durable targeted path is taken (never saveSession-from-view).
    expect(mocks.sessionManager.applyCompaction).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({
        flaggedMessageIds: expect.arrayContaining([expect.any(String)]),
        summaryChain: expect.objectContaining({ id: expect.any(String) }),
      }),
    );
    expect(mocks.saveSession).not.toHaveBeenCalled();
  });

  it('persists the full turn (user message + pre-pause + post-resume content) into the durable active chain (P1 #3)', async () => {
    const sessionId = 'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1f2';
    mocks.sessionManager._setActive({
      ...makeSession(sessionId),
      model: selection.modelId,
      selection,
      modelLabel: selection.modelId,
    });
    mocks.summarizeCompactableRange.mockResolvedValueOnce({
      text: 'SUMMARY: explored compaction module',
    });
    // The resumed (second) stream call reads from streamResponses.
    mocks.streamResponses.push('Resumed answer');
    mocks.streamChat.mockImplementationOnce(compactionStream());

    const send = vi.fn();
    const chatSend = mocks.handlers.get(IPC_CHANNELS.CHAT_SEND)!;
    await chatSend({ sender: { id: 942, send } }, { message: 'Explore with tools' });
    await waitForDoneCount(send, 1);

    expect(mocks.streamChat).toHaveBeenCalledTimes(2);
    const persisted = mocks.sessionManager.persistTurn.mock.calls.at(-1)?.[0] as {
      messages: Array<Record<string, unknown>>;
      status?: string;
    };
    expect(persisted.status).toBe('completed');
    // The durable active chain keeps the FULL turn: the user message, the
    // pre-pause tool progress, the inline summary head, and the post-resume
    // assistant content (compaction inserts heads INLINE and only flags the
    // prefix — one turn stays one chain row).
    expect(persisted.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: MessageRole.USER, content: 'Explore with tools' }),
      expect.objectContaining({ type: MessageType.TOOL_CALL, tool_call_id: 'tc-compact-1' }),
      expect.objectContaining({ role: MessageRole.ASSISTANT, content: 'Resumed answer' }),
    ]));
    // R31: simple-mode compaction never excludes user messages from the model
    // replay (universal settle). The user message stays in the transcript,
    // visible, and NOT flagged — the summary head stands in for the compacted
    // non-user range, but the user intent survives verbatim.
    const persistedUser = persisted.messages.find(
      (m) => m.role === MessageRole.USER && m.content === 'Explore with tools',
    )!;
    expect(persistedUser.hidden).toBe(false);
    expect(persistedUser.excludeFromModel).not.toBe(true);
    expect(persisted.messages.some((m) => m.compacted)).toBe(true);
    const done = doneEvents(send).at(-1)?.[1] as { messages: Array<Record<string, unknown>> };
    expect(done.messages).toEqual(persisted.messages);
  });

  it('retries exactly once with compacted messages on a context-length error, then fails terminally (P1 #14)', async () => {
    const sessionId = 'e6e6e6e6-e6e6-4e6e-8e6e-e6e6e6e6e6e6';
    // R31: a user message alone is never compactable (pinned) — the retry
    // path needs compactable assistant history to summarize.
    mocks.sessionManager._setActive({
      ...makeSession(sessionId),
      model: selection.modelId,
      selection,
      modelLabel: selection.modelId,
      chains: [
        {
          id: 'chain-old',
          messages: [
            { id: 'a-old', role: 'assistant', content: 'y'.repeat(4000), type: 'text' },
          ],
        } as never,
      ] as never,
    });
    mocks.sessionManager._setModelHistory([
      { id: 'a-old', role: 'assistant', content: 'y'.repeat(4000), type: 'text' },
    ]);
    mocks.summarizeCompactableRange.mockResolvedValueOnce({ text: 'SUMMARY: retry compaction' });
    // First attempt: provider reports a context-window overflow.
    mocks.streamChat.mockImplementationOnce(async function* () {
      yield {
        type: 'error',
        title: 'Stream Error',
        detail: 'This model maximum context length is 2000 tokens; your input is too long',
      };
    });
    // Retry attempt: overflow again — must terminate FAILED without a third call.
    mocks.streamEventSequences.push([
      {
        type: 'error',
        title: 'Stream Error',
        detail: 'context_length_exceeded: input still too long after compaction',
      },
    ]);

    const send = vi.fn();
    const chatSend = mocks.handlers.get(IPC_CHANNELS.CHAT_SEND)!;
    await chatSend({ sender: { id: 943, send } }, { message: 'x'.repeat(4000) });
    await waitForChannelCount(send, IPC_CHANNELS.CHAT_ERROR, 1);

    // Exactly one retry (two streamChat calls) — never a third attempt.
    expect(mocks.streamChat).toHaveBeenCalledTimes(2);
    const retryMessages = mocks.streamChat.mock.calls[1]![0]!.messages as Array<{
      content?: string;
      compacted?: unknown;
      excludeFromModel?: boolean;
    }>;
    // The retry request carries the compacted base: a summary head, the
    // flagged assistant original (excluded from the model, never deleted), and
    // the turn's user message — R31's universal settle keeps the user message
    // in the model view, unflagged.
    const summary = retryMessages.find((m) => m.compacted);
    expect(summary?.content).toBe('SUMMARY: retry compaction');
    expect(retryMessages.some((m) => m.content === 'y'.repeat(4000) && m.excludeFromModel)).toBe(true);
    expect(retryMessages.some((m) => m.content === 'x'.repeat(4000) && !m.excludeFromModel)).toBe(true);

    const failed = mocks.sessionManager.persistTurn.mock.calls.at(-1)?.[0] as {
      messages: Array<Record<string, unknown>>;
      status?: string;
    };
    expect(failed.status).toBe('failed');
    // The failed turn anchors at the user message — R31 keeps it unflagged in
    // the model view. The compacted base (flagged assistant original + summary
    // head) lives in its own durable chains via the targeted applyCompaction
    // write, never inside the turn slice.
    expect(failed.messages.some((m) => m.role === MessageRole.USER && m.content === 'x'.repeat(4000) && !m.excludeFromModel)).toBe(true);
    expect(failed.messages.some((m) => (m as { compacted?: unknown }).compacted)).toBe(false);
    const error = channelEvents(send, IPC_CHANNELS.CHAT_ERROR).at(-1)?.[1] as {
      kind?: string;
      messages: Array<Record<string, unknown>>;
    };
    expect(error.kind).toBe('context_length_exceeded');
    expect(error.messages).toEqual(failed.messages);
    expect(mocks.sessionManager.applyCompaction).toHaveBeenCalledTimes(1);
  });
});

describe('chat compaction selective pending (P1 #5)', () => {
  // Substantive handoff texts (>= MIN_HANDOFF_SUMMARY_CHARS with real words) —
  // the selective validator rejects degenerate activity-log texts for spans
  // covering >= 1000 chars of source content.
  const SELECTIVE_OLD_TURN_SUMMARY =
    'SUMMARY: selective over old turn — the summarized assistant reply carried the findings, exact file paths, and decisions needed to continue; the next step flows into the preserved follow-up window without re-reading the old turn.';
  const SELECTIVE_MID_TURN_SUMMARY =
    'SUMMARY: selective mid-turn findings handoff — the summarized tool group preserved exact file paths, outcomes, and errors for the resumed stream; the next step continues the in-flight turn directly from the preserved window and open tool group.';
  const compactorSelectiveAgent = {
    name: 'compactor-selective',
    type: 'internal' as const,
    tier: 'seed' as const,
    description: 'Selective compactor',
    system_prompt: 'Return the selective ops JSON array.',
    allowed_tools: [],
    allowed_skills: [],
  } satisfies Agent;

  registerCompactionSuite({
    mainMode: 'selective',
    agents: new Map<string, Agent>([
      ['general', mocks.generalAgent],
      ['session-namer', mocks.sessionNamerAgent],
      ['compactor-selective', compactorSelectiveAgent],
    ]),
  });

  it('re-anchors the prepare-time selective replay so the next turn reaches the model intact', async () => {
    const sessionId = 'e7e7e7e7-e7e7-4e7e-8e7e-e7e7e7e7e7e7';
    // No `usage` on the fixture messages: a persisted usage would hydrate the
    // trigger calibration and fire compaction SYNCHRONOUSLY at turn-1 send,
    // which is the send-time path — not the pending this test exercises. The
    // mid-turn usage event below is what prepares the selective pending.
    mocks.sessionManager._setActive({
      ...makeSession(sessionId),
      model: selection.modelId,
      selection,
      modelLabel: selection.modelId,
      chains: [
        {
          id: 'chain-old',
          messages: [
            { id: 'u-old', role: 'user', content: 'x'.repeat(4000), type: 'text' },
            { id: 'a-old', role: 'assistant', content: 'y'.repeat(4000), type: 'text' },
          ],
        } as never,
      ] as never,
    });
    mocks.sessionManager._setModelHistory([
      { id: 'u-old', role: 'user', content: 'x'.repeat(4000), type: 'text' },
      { id: 'a-old', role: 'assistant', content: 'y'.repeat(4000), type: 'text' },
    ]);
    // The selective compactor keeps the user message verbatim and summarizes
    // the assistant reply — ops derived from the manifest in the prompt. The
    // summary text is a substantive handoff (the validator rejects activity
    // logs for spans with >= 1000 chars of source).
    mocks.aiGenerateText.mockImplementationOnce(async ({ messages }: { messages: Array<{ content: string }> }) => {
      const prompt = String(messages[0]?.content ?? '');
      const ids = [...prompt.matchAll(/^(\S+) \[/gm)].map((m) => m[1]!);
      return {
        text: JSON.stringify([
          ...ids.filter((id) => id.startsWith('u-')).map((id) => ({ type: 'keep', id })),
          { type: 'summarize', ids: ids.filter((id) => !id.startsWith('u-')), text: SELECTIVE_OLD_TURN_SUMMARY },
        ]),
      };
    });
    // Turn 1: the usage event prepares a selective pending; the provider error
    // ends the turn before the pause can apply, so the pending survives to the
    // next send (between-turns consumption).
    mocks.streamChat.mockImplementationOnce(async function* () {
      yield {
        type: 'usage',
        usage: { prompt_tokens: 1500, completion_tokens: 10, total_tokens: 1510, cached_tokens: 0 },
      };
      yield { type: 'error', title: 'Stream Error', detail: 'Provider disconnected' };
    });
    // Turn 2's stream reads from streamResponses.
    mocks.streamResponses.push('Follow-up answer');

    const send = vi.fn();
    const chatSend = mocks.handlers.get(IPC_CHANNELS.CHAT_SEND)!;
    await chatSend({ sender: { id: 944, send } }, { message: 'First request' });
    await waitForChannelCount(send, IPC_CHANNELS.CHAT_ERROR, 1);
    await chatSend({ sender: { id: 944, send } }, { message: 'Follow up' });
    await waitForDoneCount(send, 1);

    // Turn 2's model request: the selective prefix (kept user message +
    // synthetic summary) re-anchored onto the CURRENT history — the new user
    // message and the previous turn's user message both reach the model. The
    // pre-fix code spliced the prepare-time replay wholesale, so the new user
    // message never reached the model and existingMessages stripped the
    // previous user message instead.
    const secondMessages = mocks.streamChat.mock.calls[1]![0]!.messages as Array<{
      id?: string;
      content?: string;
      compacted?: unknown;
    }>;
    expect(secondMessages.some((m) => m.role === MessageRole.USER && m.content === 'Follow up')).toBe(true);
    expect(secondMessages.some((m) => m.role === MessageRole.USER && m.content === 'First request')).toBe(true);
    expect(secondMessages.some((m) => m.compacted && m.content === SELECTIVE_OLD_TURN_SUMMARY)).toBe(true);
    expect(secondMessages.some((m) => m.id === 'u-old')).toBe(true);
    // The summarized original is flagged durable-side and dropped from replay.
    expect(secondMessages.some((m) => m.id === 'a-old')).toBe(false);

    // Durable targeted write: the summarized original is flagged, the summary
    // row inserted before the preserved window — never saveSession-from-view.
    expect(mocks.sessionManager.applyCompaction).toHaveBeenCalledTimes(1);
    expect(mocks.sessionManager.applyCompaction).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({
        flaggedMessageIds: ['a-old'],
        // Unification #11b: synthesized compactor chains use one id scheme —
        // randomUUID() — for both scopes (the main path previously synthesized
        // `selective-${Date.now()}-…` ids here).
        summaryChain: expect.objectContaining({
          id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
        }),
        insertBeforeMessageId: expect.any(String),
      }),
    );
    expect(mocks.saveSession).not.toHaveBeenCalled();

    // The turn-2 durable active chain keeps the full turn.
    const persisted = mocks.sessionManager.persistTurn.mock.calls.at(-1)?.[0] as {
      messages: Array<Record<string, unknown>>;
      status?: string;
    };
    expect(persisted.status).toBe('completed');
    expect(persisted.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: MessageRole.USER, content: 'Follow up' }),
      expect.objectContaining({ role: MessageRole.ASSISTANT, content: 'Follow-up answer' }),
    ]));
  });

  it('mid-turn selective apply keeps flagged originals + inline head in the durable turn row (review #54)', async () => {
    const sessionId = 'e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e5e5';
    mocks.sessionManager._setActive({
      ...makeSession(sessionId),
      model: selection.modelId,
      selection,
      modelLabel: selection.modelId,
    });
    // Selective ops from the manifest: keep user + thinking verbatim,
    // summarize every other span in one op.
    mocks.aiGenerateText.mockImplementationOnce(async ({ messages }: { messages: Array<{ content: string }> }) => {
      const prompt = String(messages[0]?.content ?? '');
      const entries = [...prompt.matchAll(/^(\S+) \[([\w-]+)\]/gm)].map((m) => ({
        id: m[1]!,
        kind: m[2]!,
      }));
      return {
        text: JSON.stringify([
          ...entries.filter((e) => e.kind === 'user' || e.kind === 'thinking')
            .map((e) => ({ type: 'keep', id: e.id })),
          {
            type: 'summarize',
            ids: entries.filter((e) => e.kind !== 'user' && e.kind !== 'thinking').map((e) => e.id),
            text: SELECTIVE_MID_TURN_SUMMARY,
          },
        ]),
      };
    });
    // First stream: two tool groups + usage over threshold → selective pending
    // prepares; the turn pauses, applies, and resumes. The resume generator
    // below HOLDS until the 300ms checkpoint debounce scheduled by the
    // triggering usage event has actually fired post-apply — exactly the
    // stale-capture race window (review #55).
    mocks.streamChat.mockImplementationOnce(async function* () {
      yield {
        type: 'tool_call',
        toolCallId: 'tc-sel-1',
        toolName: 'read',
        args: '{"path":"README.md"}',
      };
      yield successfulToolResult('tc-sel-1', 'x'.repeat(2000));
      yield {
        type: 'tool_call',
        toolCallId: 'tc-sel-2',
        toolName: 'read',
        args: '{"path":"AGENTS.md"}',
      };
      yield successfulToolResult('tc-sel-2', 'y'.repeat(2000));
      yield {
        type: 'usage',
        usage: { prompt_tokens: 1800, completion_tokens: 40, total_tokens: 1840, cached_tokens: 0 },
      };
      yield { type: 'finish', finishReason: 'stop' };
    });
    mocks.streamChat.mockImplementationOnce(async function* () {
      // Deterministic handshake instead of a fixed sleep: wait until a
      // checkpoint write (updateActiveChainMessages) has fired AFTER the
      // compaction apply — the debounced checkpoint landing mid-resume —
      // bounded by an explicit timeout budget.
      const applyOrders = mocks.sessionManager.applyCompaction.mock.invocationCallOrder;
      const updateOrders = mocks.sessionManager.updateActiveChainMessages.mock.invocationCallOrder;
      const checkpointFiredPostApply = () => {
        const applyOrder = applyOrders[0];
        return applyOrder !== undefined && updateOrders.some((order) => order > applyOrder);
      };
      const deadline = Date.now() + 1000;
      while (!checkpointFiredPostApply() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      yield { type: 'content', text: 'Resumed answer' };
      yield { type: 'finish', finishReason: 'stop' };
    });

    const send = vi.fn();
    const chatSend = mocks.handlers.get(IPC_CHANNELS.CHAT_SEND)!;
    await chatSend({ sender: { id: 945, send } }, { message: 'Explore with tools' });
    await waitForDoneCount(send, 1);

    expect(mocks.streamChat).toHaveBeenCalledTimes(2);
    expect(mocks.sessionManager.applyCompaction).toHaveBeenCalledTimes(1);

    // The resumed model view is the reanchored REPLAY: the head reaches the
    // model, the flagged original does not.
    const resumedMessages = mocks.streamChat.mock.calls[1]![0]!.messages as Array<{
      content?: string;
      compacted?: unknown;
      excludeFromModel?: boolean;
      tool_call_id?: string;
    }>;
    expect(resumedMessages.some((m) => m.compacted && m.content === SELECTIVE_MID_TURN_SUMMARY)).toBe(true);
    expect(resumedMessages.some((m) => m.tool_call_id === 'tc-sel-1' && m.excludeFromModel)).toBe(false);

    // The durable turn row (finalize rewrite input) is TRANSCRIPT-complete:
    // user message unflagged, the flagged ORIGINAL tool pair preserved with
    // excludeFromModel, the inline summary head, and the post-resume content.
    // The pre-fix code rewrote the row from the model-view replay and
    // durably erased the flagged originals + head (review #54).
    const persisted = mocks.sessionManager.persistTurn.mock.calls.at(-1)?.[0] as {
      messages: Array<Record<string, unknown>>;
      status?: string;
    };
    expect(persisted.status).toBe('completed');
    const persistedUser = persisted.messages.find(
      (m) => m.role === MessageRole.USER && m.content === 'Explore with tools',
    )!;
    expect(persistedUser.excludeFromModel).not.toBe(true);
    expect(persisted.messages.some((m) => m.tool_call_id === 'tc-sel-1' && m.excludeFromModel === true)).toBe(true);
    expect(persisted.messages.some((m) => m.compacted && (m as { content?: string }).content === SELECTIVE_MID_TURN_SUMMARY)).toBe(true);
    expect(persisted.messages.some((m) => m.role === MessageRole.ASSISTANT && m.content === 'Resumed answer')).toBe(true);

    // Stale-checkpoint race (review #55): a checkpoint scheduled by the same
    // usage event that triggered the compaction fires after the apply — its
    // write must reflect the compacted transcript (re-derived at fire time),
    // never the pre-compaction snapshot captured at schedule time.
    const applyOrder = mocks.sessionManager.applyCompaction.mock.invocationCallOrder[0]!;
    const updateMock = mocks.sessionManager.updateActiveChainMessages;
    const postApplyIndexes = updateMock.mock.invocationCallOrder
      .map((order, index) => (order > applyOrder ? index : -1))
      .filter((index) => index >= 0);
    // The race is only exercised when a checkpoint write actually fired after
    // the apply — fail loudly instead of passing vacuously when none did.
    expect(postApplyIndexes.length).toBeGreaterThan(0);
    for (const index of postApplyIndexes) {
      const written = updateMock.mock.calls[index]![0] as Array<{
        tool_call_id?: string;
        excludeFromModel?: boolean;
      }>;
      expect(written.some((m) => m.tool_call_id === 'tc-sel-1' && m.excludeFromModel === true)).toBe(true);
    }
  });
});

describe('chat compaction disabled without a model context limit', () => {
  // The default resolveExecution mock returns no model.limits → contextTokens
  // null, so no execution override is queued for this suite.
  registerCompactionSuite({ overrideExecution: false });

  function hugeHistoryStream() {
    return async function* () {
      yield {
        type: 'tool_call',
        toolCallId: 'tc-nolimit-1',
        toolName: 'read',
        args: '{"path":"README.md"}',
      };
      yield successfulToolResult('tc-nolimit-1', 'x'.repeat(500_000));
      yield {
        type: 'usage',
        usage: {
          prompt_tokens: 120_000,
          completion_tokens: 40,
          total_tokens: 120_040,
          cached_tokens: 0,
        },
      };
      yield { type: 'finish', finishReason: 'stop' };
    };
  }

  it('never compacts on send when the model has no configured context window', async () => {
    const sessionId = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2e2';
    mocks.sessionManager._setActive({
      ...makeSession(sessionId),
      model: selection.modelId,
      selection,
      modelLabel: selection.modelId,
    });
    mocks.streamChat.mockImplementationOnce(hugeHistoryStream());

    const send = vi.fn();
    const chatSend = mocks.handlers.get(IPC_CHANNELS.CHAT_SEND)!;
    await chatSend({ sender: { id: 950, send } }, { message: 'Explore with tools' });
    await waitForDoneCount(send, 1);

    await chatSend({ sender: { id: 950, send } }, { message: 'Follow up' });
    await waitForDoneCount(send, 2);

    // The pre-fix send-time path substituted an assumed 128k window for the
    // null limit and compacted this history; compaction must stay disabled.
    expect(mocks.summarizeCompactableRange).not.toHaveBeenCalled();
    expect(mocks.streamChat).toHaveBeenCalledTimes(2);
    const secondMessages = mocks.streamChat.mock.calls[1]![0]!.messages as Array<{
      content?: string;
      compacted?: unknown;
      excludeFromModel?: boolean;
    }>;
    expect(secondMessages.some((m) => m.compacted)).toBe(false);
    expect(secondMessages.some((m) => m.excludeFromModel)).toBe(false);
    // The oversized tool result is replayed verbatim — no reclaim offload.
    expect(secondMessages.some((m) => typeof m.content === 'string' && m.content.length > 400_000)).toBe(true);
  });
});

describe('chat compaction send-time calibration', () => {
  registerCompactionSuite();

  it('skips send-time compaction when uncalibrated, even over threshold (hard rule: no chars/4)', async () => {
    const sessionId = 'e3e3e3e3-e3e3-4e3e-8e3e-e3e3e3e3e3e3';
    mocks.sessionManager._setActive({
      ...makeSession(sessionId),
      model: selection.modelId,
      selection,
      modelLabel: selection.modelId,
    });
    // Large prior history, but NO usage observation anywhere: no context
    // snapshots (store unavailable in tests) and no chain message usages.
    mocks.sessionManager._setModelHistory([
      { id: 'u-old', role: 'user', content: 'x'.repeat(4000), type: 'text' },
    ]);
    mocks.streamChat.mockImplementationOnce(textOnlyStream());

    const send = vi.fn();
    const chatSend = mocks.handlers.get(IPC_CHANNELS.CHAT_SEND)!;
    await chatSend({ sender: { id: 960, send } }, { message: 'Follow up' });
    await waitForDoneCount(send, 1);

    // chars/4 would estimate ~1000 tokens = threshold(0.5) × 2000 and fire;
    // the hard rule keeps the estimate unknown and skips proactive compaction.
    expect(mocks.summarizeCompactableRange).not.toHaveBeenCalled();
    expect(mocks.streamChat).toHaveBeenCalledTimes(1);
    const sentMessages = mocks.streamChat.mock.calls[0]![0]!.messages as Array<{
      content?: string;
      compacted?: unknown;
    }>;
    expect(sentMessages.some((m) => m.compacted)).toBe(false);
    expect(sentMessages.some((m) => m.content === 'x'.repeat(4000))).toBe(true);
  });

  it('hydrates calibration from persisted chain usage and compacts within the preserve budget', async () => {
    const sessionId = 'e4e4e4e4-e4e4-4e4e-8e4e-e4e4e4e4e4e4';
    mocks.sessionManager._setActive({
      ...makeSession(sessionId),
      model: selection.modelId,
      selection,
      modelLabel: selection.modelId,
      chains: [
        {
          id: 'chain-old',
          messages: [
            // R31: the pinned user message survives every compaction verbatim;
            // the oversized assistant reply is the compactable range.
            { id: 'u-old', role: 'user', content: 'x'.repeat(4000), type: 'text', usage: { prompt_tokens: 1500 } },
            { id: 'a-old', role: 'assistant', content: 'y'.repeat(4000), type: 'text' },
          ],
        },
      ] as never,
    });
    mocks.sessionManager._setModelHistory([
      { id: 'u-old', role: 'user', content: 'x'.repeat(4000), type: 'text' },
      { id: 'a-old', role: 'assistant', content: 'y'.repeat(4000), type: 'text' },
    ]);
    mocks.summarizeCompactableRange.mockResolvedValueOnce({ text: 'SUMMARY: prior turn' });
    mocks.streamChat.mockImplementationOnce(textOnlyStream());

    const send = vi.fn();
    const chatSend = mocks.handlers.get(IPC_CHANNELS.CHAT_SEND)!;
    await chatSend({ sender: { id: 961, send } }, { message: 'Follow up' });
    await waitForDoneCount(send, 1);

    // Hydrated lastObserved=1500 → ratio ≈ 0.37 → estimate 1500 = 0.75 of the
    // 2000 window ≥ 0.5 threshold → fires with preserve budget 500 tokens.
    expect(mocks.summarizeCompactableRange).toHaveBeenCalledTimes(1);
    expect(mocks.streamChat).toHaveBeenCalledTimes(1);
    const sentMessages = mocks.streamChat.mock.calls[0]![0]!.messages as Array<{
      content?: string;
      compacted?: unknown;
      excludeFromModel?: boolean;
    }>;
    const summary = sentMessages.find((m) => m.compacted);
    expect(summary?.content).toBe('SUMMARY: prior turn');
    // R31: the oversized prior message is a user message, so it stays in the
    // model view verbatim — never flagged, never deleted. The summary head
    // stands in for the compacted range, not for the user's intent.
    const oldMessage = sentMessages.find((m) => m.content === 'x'.repeat(4000));
    expect(oldMessage).toBeDefined();
    expect(oldMessage?.excludeFromModel).not.toBe(true);
    // The summarized assistant original is excluded from replay, never deleted.
    expect(sentMessages.some((m) => m.content === 'y'.repeat(4000) && m.excludeFromModel)).toBe(true);
    // The durable targeted path is taken (never saveSession-from-view). R31's
    // universal settle filters user ids from the flagged set.
    expect(mocks.sessionManager.applyCompaction).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({
        flaggedMessageIds: ['a-old'],
        summaryChain: expect.objectContaining({ id: expect.any(String) }),
      }),
    );
    expect(mocks.saveSession).not.toHaveBeenCalled();
  });
});

describe('chat compaction scoped user settle (keep_last_user_messages)', () => {
  registerCompactionSuite({
    keepLastUserMessages: 10,
    pinFirstUserMessage: false,
  });

  it('flags the 11th-oldest user message (keep_last=10): out of the model view, carried only by the summary', async () => {
    const sessionId = 'e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e5e5';
    // Ten user/assistant fixture turns; the sent follow-up makes eleven user
    // messages. keep_last=10 + pin_first=false → only the ten newest users
    // are exempt, so u-0 can leave the model view for the first time.
    const fixtureMessages: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 10; i += 1) {
      fixtureMessages.push({ id: `u-${i}`, role: 'user', content: 'u'.repeat(200), type: 'text' });
      fixtureMessages.push({ id: `a-${i}`, role: 'assistant', content: 'a'.repeat(400), type: 'text' });
    }
    fixtureMessages.at(-1)!.usage = { prompt_tokens: 3000 };
    mocks.sessionManager._setActive({
      ...makeSession(sessionId),
      model: selection.modelId,
      selection,
      modelLabel: selection.modelId,
      chains: [{ id: 'chain-old', messages: fixtureMessages } as never] as never,
    });
    mocks.sessionManager._setModelHistory(fixtureMessages);
    mocks.summarizeCompactableRange.mockResolvedValueOnce({ text: 'SUMMARY: scoped settle over eleven user turns' });
    mocks.streamChat.mockImplementationOnce(textOnlyStream());

    const send = vi.fn();
    const chatSend = mocks.handlers.get(IPC_CHANNELS.CHAT_SEND)!;
    await chatSend({ sender: { id: 970, send } }, { message: 'Follow up' });
    await waitForDoneCount(send, 1);

    // The send-time compaction fired and the summarizer covered the oldest
    // user message — its only surviving representation is the summary head.
    expect(mocks.summarizeCompactableRange).toHaveBeenCalledTimes(1);
    const slice = mocks.summarizeCompactableRange.mock.calls[0]![0]!.messages as Array<{ id?: string }>;
    expect(slice.some((m) => m.id === 'u-0')).toBe(true);

    expect(mocks.streamChat).toHaveBeenCalledTimes(1);
    const sentMessages = mocks.streamChat.mock.calls[0]![0]!.messages as Array<{
      id?: string;
      role?: string;
      content?: string;
      excludeFromModel?: boolean;
      compacted?: unknown;
    }>;
    // Single representation: u-0 stays in the transcript but leaves the model
    // view — no verbatim + summary double representation.
    expect(sentMessages.find((m) => m.id === 'u-0')!.excludeFromModel).toBe(true);
    // The ten newest user messages (plus the turn's own) survive verbatim.
    for (let i = 1; i < 10; i += 1) {
      expect(sentMessages.find((m) => m.id === `u-${i}`)!.excludeFromModel).not.toBe(true);
    }
    expect(sentMessages.some((m) => m.role === MessageRole.USER && m.content === 'Follow up' && !m.excludeFromModel)).toBe(true);
    expect(sentMessages.some((m) => m.compacted && m.content === 'SUMMARY: scoped settle over eleven user turns')).toBe(true);

    // Durable flags: u-0 and the in-range assistants flagged; exempt users not.
    expect(mocks.sessionManager.applyCompaction).toHaveBeenCalledTimes(1);
    const flaggedMessageIds = (mocks.sessionManager.applyCompaction.mock.calls[0]![1] as {
      flaggedMessageIds: string[];
    }).flaggedMessageIds;
    expect(flaggedMessageIds).toContain('u-0');
    expect(flaggedMessageIds).toContain('a-0');
    for (let i = 1; i < 10; i += 1) {
      expect(flaggedMessageIds).not.toContain(`u-${i}`);
    }
    expect(mocks.saveSession).not.toHaveBeenCalled();
  });
});
