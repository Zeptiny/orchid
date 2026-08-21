/**
 * Turn-scoped implementation behind the chat:send IPC boundary.
 *
 * `chat.ts` validates the untrusted payload and delegates here. Keeping the
 * actor lifecycle in this module prevents IPC registration from also owning
 * projection, persistence, and resource cleanup policies.
 *
 * The main-session compaction engine (trigger/pending state, prepare/apply
 * orchestration, selective persistence) lives in `./compaction`; this module
 * only calls into it at the turn's compaction seams: turn-start pending
 * consumption, send-time synchronous compaction, mid-turn usage events, the
 * compaction pause/resume boundary, and the overflow retry.
 */
import type { LanguageModelV4 } from '@ai-sdk/provider';
import type { WebContents } from 'electron';
import { createActor } from 'xstate';
import { z } from 'zod';
import { agentMachine, type AgentContext } from '../../agents/xstate/agent-machine';
import { interruptMachine } from '../../agents/xstate/interrupt-machine';
import { appendRootAgentsMd, findRootAgentsMdEntry } from '../../project/agents-md';
import { appendProjectPersonality } from '../../project/personality';
import { getProviderRuntime } from '../../providers';
import { getProviderAccountingStore } from '../../providers/accounting/store';
import type { ProviderAttemptAccountingContext } from '../../providers/accounting/middleware';
import type { ReasoningProviderOptions } from '../../providers/drivers/types';
import {
  DEFAULT_THINKING_POLICY,
} from '../../providers/facets/thinking';
import type { ThinkingReplayContext } from '../../llm/history';
import type { CacheFacet, ThinkingPolicy } from '../../../shared/types/provider-facets';
import type { ProviderProtocol } from '../../../shared/types/provider';
import { resolveMainAgentTier } from '../../providers/facets/tiers';
import { assembleFacetProviderOptions } from '../../providers/facets/turn-options';
import { getSessionManager } from '../../session/singleton';
import { getBuiltinToolRegistryForRuntime, getSubagentManager } from '../../tools';
import type { ToolExecutionContext } from '../../tools/types';
import { awaitSessionSubagentHydration } from '../../tools/subagent/hydrate';
import { resolveMainAgentEffort } from '../../llm/reasoning-effort';
import {
  makeAssistantMessage,
  makeThinkingMessage,
  makeToolCallMessage,
  makeToolResultMessage,
  makeUserMessage,
} from '../../llm/message-factories';
import { acquireProjectMCPManager, releaseProjectMCPManager } from '../../mcp/project-registry';
import { IPC_CHANNELS } from '../../../shared/types/ipc';
import { ChainStatus } from '../../../shared/types/chain';
import { MessageType, type Message, type Usage } from '../../../shared/types/message';
import { getChatHistory, setChatHistory } from '../chat-history';
import { chatSendSchema } from '../payload-schemas';
import { clearNextRequestStop, clearCompactionPause, shouldPauseForCompaction } from '../next-request-stop';
import { MAIN_AGENT_SCOPE_ID } from '../../../shared/types/agent-scope';
import { completeSessionActivity, publishSessionActivity } from '../session-activity';
import { disposeActiveAgent, forceAbortSession } from './abort';
import { emitSessionUpdated, sendChatState, sendTurnEvent } from './events';
import {
  activeAgents,
  canEmitStreamEvents,
  clearSubagentCancelConfirm,
  isCurrentAgent,
  nextAgentGeneration,
  sessionOperationGateTail,
  sessionsStarting,
  type ActiveAgent,
} from './state';
import {
  attachUsageToLatestAssistant,
  checkpointActiveTurn,
  currentTurnSnapshot,
  flushPartialTurnContent,
  historyFromSession,
  persistTurnConversation,
  turnMessagesFromAgent,
} from './persist';
import {
  appendTextSegment,
  ensureToolSnapshot,
  textSegmentIdAtOffset,
  updateToolSnapshot,
} from './snapshot';
import { ensureActiveSessionSingleFlight } from './session';
import { classifyErrorKind, createProviderStreamFn } from './stream';
import { triggerSessionAutoName } from './title';
import { isContextLengthExceededError } from '../../llm/middleware/error-classification';
import {
  applyPendingCompactionIfAny,
  clearCompactionRetryTried,
  dedupeHistoryById,
  emitCompactionProgress,
  getCompactionTrigger,
  handleUsageCompaction,
  hasTriedCompactionRetry,
  hydrateTriggerCalibration,
  markCompactionRetryTried,
  tryCompactSynchronously,
} from './compaction';

export type ChatSendPayload = z.infer<typeof chatSendSchema>;

export async function startChatTurn(
  webContents: WebContents,
  { message, model: preferredModel, sessionId: requestedSessionId, draftGeneration }: ChatSendPayload,
) {
  const windowId = String(webContents.id);
  const sessionGate = await Promise.resolve(
    ensureActiveSessionSingleFlight(webContents, preferredModel, requestedSessionId, draftGeneration),
  );
  if (!sessionGate.ok) return sessionGate.result;

  const sessionId = sessionGate.session.id;
  clearNextRequestStop(sessionId);
  clearCompactionPause(sessionId, MAIN_AGENT_SCOPE_ID);
  if (sessionsStarting.has(sessionId)) {
    return { status: 'error', error: 'A turn is already starting for this session.', kind: 'session_busy' };
  }
  // A manual compaction (/compact) may still be persisting on this idle
  // session — its entry busy check ran before this send claimed the
  // turn-start slot. Wait the operation gate out (no yield when nothing is
  // gated), then re-check: another send may have claimed the slot while we
  // waited.
  const operationGate = sessionOperationGateTail(sessionId);
  if (operationGate) {
    await operationGate;
    if (sessionsStarting.has(sessionId)) {
      return { status: 'error', error: 'A turn is already starting for this session.', kind: 'session_busy' };
    }
  }
  sessionsStarting.add(sessionId);
  const existing = activeAgents.get(sessionId);
  const runtime = sessionGate.runtime;
  try {
    await awaitSessionSubagentHydration(getSubagentManager(), sessionId, {
      projectRuntime: runtime,
      windowId,
      cwd: sessionGate.cwd,
    });
  } catch (error) {
    sessionsStarting.delete(sessionId);
    return {
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
      kind: 'runtime_hydration_failed',
    };
  }
  if (existing) forceAbortSession(sessionId);
  publishSessionActivity(sessionId, {
    cwd: sessionGate.cwd, state: 'working', phase: 'agent', detail: 'Generating response',
    startedAt: Date.now(), completedAt: null, unread: false, canCancel: true,
  });
  const turnSelection = sessionGate.session.selection;
  if (turnSelection == null) {
    sessionsStarting.delete(sessionId);
    completeSessionActivity(sessionId, false);
    return {
      status: 'error',
      error: 'A provider connection and model are required before sending a message.',
      kind: 'provider_required',
    };
  }

  let existingMessages: Message[];
  try {
    existingMessages = getChatHistory(sessionId) ?? historyFromSession(sessionId);
  } catch (error) {
    sessionsStarting.delete(sessionId);
    completeSessionActivity(sessionId, false);
    return {
      status: 'error',
      error: `Could not load complete conversation history: ${
        error instanceof Error ? error.message : String(error)
      }`,
      kind: 'history_load_failed',
    };
  }

  let modelInstance: LanguageModelV4;
  let providerSnapshot: ProviderAttemptAccountingContext['snapshot'];
  let providerOptions: ReasoningProviderOptions | undefined;
  let pricingFacet: ProviderAttemptAccountingContext['pricingFacet'];
  let thinkingPolicy: ThinkingPolicy | undefined;
  let cacheFacet: CacheFacet | undefined;
  let cacheTtl: string | undefined;
  let cacheSessionKey: string | undefined;
  let tierMechanism: ProviderAttemptAccountingContext['tierMechanism'];
  let accountingStore: ReturnType<typeof getProviderAccountingStore>;
  let contextTokens: number | null = null;
  try {
    accountingStore = getProviderAccountingStore();
    // Resolve the effective tier before model construction so the variant
    // mapping and the frozen snapshot both observe the same selection (R21).
    const tierContext = await getProviderRuntime().resolveTierContext(turnSelection);
    const effectiveTier = resolveMainAgentTier(
      sessionGate.session,
      tierContext.connection,
      turnSelection.modelId,
      tierContext.tierMechanism,
    );
    const execution = await getProviderRuntime().resolveExecution(
      turnSelection,
      effectiveTier !== undefined ? { tier: effectiveTier } : {},
    );
    tierMechanism = execution.tierMechanism;
    modelInstance = execution.modelInstance;
    providerSnapshot = execution.snapshot;
    pricingFacet = execution.pricingFacet;
    thinkingPolicy = execution.thinkingPolicy;
    cacheFacet = execution.cacheFacet;
    contextTokens = execution.model.limits?.contextTokens ?? null;
    const effort = resolveMainAgentEffort(
      sessionGate.session, execution.connection, turnSelection.modelId,
      execution.model.capabilities?.reasoning === true,
    );
    providerOptions = effort === undefined ? undefined : execution.buildReasoningOptions?.(effort);
    const facetOptions = assembleFacetProviderOptions({
      providerOptions,
      thinkingPolicy,
      providerId: execution.snapshot.providerId,
      tierId: resolveMainAgentTier(
        sessionGate.session, execution.connection, turnSelection.modelId, execution.tierMechanism,
      ),
      tierMechanism: execution.tierMechanism,
      cacheFacet,
      cacheTtlSelection: execution.connection.cacheTtl,
      sessionId,
    });
    providerOptions = facetOptions.providerOptions;
    cacheSessionKey = facetOptions.cacheSessionKey;
    cacheTtl = facetOptions.cacheTtl;
  } catch (error) {
    sessionsStarting.delete(sessionId);
    completeSessionActivity(sessionId, false);
    return {
      status: 'error', error: error instanceof Error ? error.message : String(error),
      kind: 'provider_unavailable',
    };
  }

  const agents = [...runtime.agents.values()];
  const userMessage = makeUserMessage(message);
  let messages: Message[] = [...existingMessages, userMessage];
  const thinkingReplay: ThinkingReplayContext = {
    policy: thinkingPolicy ?? DEFAULT_THINKING_POLICY,
    selection: { providerId: providerSnapshot.providerId, modelId: turnSelection.modelId },
    protocol: providerSnapshot.protocol as ProviderProtocol,
  };
  const agent = agents.find((candidate) => candidate.name === 'general') ?? agents[0] ?? {
    name: 'general', type: 'subagent' as const, tier: 'bloom' as const,
    description: 'General-purpose agent', system_prompt: 'You are a helpful assistant.',
    allowed_tools: ['*'], allowed_skills: ['*'],
  };
  const sessionManager = getSessionManager();
  const turnCtx: ToolExecutionContext = {
    cwd: sessionGate.cwd, sessionId, windowId, projectRuntime: runtime,
    agentScopeId: 'main', selection: turnSelection,
  };
  let turnId: string = crypto.randomUUID();
  let chainId: string | null = null;

  // Finalize the chain/turn identity BEFORE any compaction attempt runs, so
  // every compactor LLM attempt is attributed to the active chain and turn
  // rather than to a pre-chain placeholder id.
  try {
    const chain = sessionManager.startChain({
      selection: turnSelection, modelLabel: turnSelection.modelId, agentName: agent.name,
      agentType: agent.type, agentTier: agent.tier, messages: [userMessage],
    }, sessionId);
    chainId = chain?.id ?? null;
    turnId = chain?.id ?? turnId;
    emitSessionUpdated(webContents, sessionId);
  } catch (error) {
    console.debug('startChain failed (non-fatal):', error);
  }

  {
    await hydrateTriggerCalibration(sessionId);
    const pendingApplied = await applyPendingCompactionIfAny(sessionId, messages, runtime);
    if (pendingApplied.applied && pendingApplied.updatedMessages) {
      const updated = pendingApplied.updatedMessages;
      // Defensive: the applied replay must carry the just-appended user message
      // into the model request — if a stale prepare-time snapshot lost it,
      // re-append rather than silently dropping the turn (P1 #5).
      if (!updated.some((m) => m.id === userMessage.id)) {
        updated.push(userMessage);
        setChatHistory(sessionId, [...updated]);
      }
      messages = updated;
    }
    const syncResult = await tryCompactSynchronously(sessionId, messages, runtime, turnSelection, contextTokens, accountingStore!, chainId, turnId);
    if (syncResult.didApply && syncResult.updatedMessages) {
      messages = syncResult.updatedMessages;
    }
  }

  const abortController = new AbortController();
  const baseSystemPrompt = agent.system_prompt || 'You are a helpful assistant.';
  try {
    const rootAgentsMdEntry = findRootAgentsMdEntry(runtime.projectDir, runtime.config);
    if (rootAgentsMdEntry) sessionManager.getAgentsMdContextStore(sessionId).seedRoot(rootAgentsMdEntry);
  } catch (error) {
    console.debug('seedRoot AGENTS.md context failed (non-fatal):', error);
  }
  const accounting: ProviderAttemptAccountingContext = {
    store: accountingStore, sessionId, chainId, turnId, snapshot: providerSnapshot,
    agentScope: 'main', agentName: agent.name, agentType: agent.type, agentTier: agent.tier,
   attemptIdHolder: { value: null }, pricingFacet, tierMechanism,
  };
  const mcpManager = acquireProjectMCPManager(runtime);
  let resourcesReleased = false;
  const releaseResources = () => {
    if (resourcesReleased) return;
    resourcesReleased = true;
    releaseProjectMCPManager(runtime);
  };
  let actor: ReturnType<typeof createActor<typeof agentMachine>>;
  let interruptActor: ReturnType<typeof createActor<typeof interruptMachine>>;
  try {
    const turnRegistry = getBuiltinToolRegistryForRuntime(runtime, {
      agents: new Map(runtime.agents), skills: new Map(runtime.skills), mcpManager,
    });
    const personalityPrompt = appendProjectPersonality(baseSystemPrompt, runtime);
    let fullSystemPrompt = personalityPrompt;
    try {
      fullSystemPrompt = appendRootAgentsMd(personalityPrompt, runtime);
    } catch (error) {
      console.debug('root AGENTS.md injection failed (non-fatal):', error);
    }
    actor = createActor(agentMachine, {
      input: {
        agent, systemPrompt: fullSystemPrompt,
        streamFn: createProviderStreamFn({
          messages, runtime, sessionId, windowId, modelInstance, accounting, registry: turnRegistry,
          mcpManager, providerOptions, thinkingReplay,
          cachePlacement: cacheFacet
            ? { facet: cacheFacet, ttl: cacheTtl, sessionKey: cacheSessionKey }
            : undefined,
        }),
      },
    });
    interruptActor = createActor(interruptMachine);
  } catch (error) {
    releaseResources();
    sessionsStarting.delete(sessionId);
    completeSessionActivity(sessionId, false);
    return {
      status: 'error', error: error instanceof Error ? error.message : String(error),
      kind: 'runtime_hydration_failed',
    };
  }

  let lastSentLength = 0;
  let lastThinkingLength = 0;
  let completed = false;
  let overflowRetryInFlight = false;
  let subscription: { unsubscribe: () => void } | null = null;
  let interruptSubscription: { unsubscribe: () => void } | null = null;
  let lastUsage: Usage | null = null;
  let interruptResetTimer: ReturnType<typeof setTimeout> | null = null;
  let lastStreamingToolCallId: string | null = null;
  const lastStreamingToolArgLength = new Map<string, number>();
  let lastToolUpdateSequence = 0;
  let lastActivityKey = 'streaming:agent:Generating response';
  const generation = nextAgentGeneration(sessionId);
  // Anchor the durable turn slice at the turn's user message (same invariant as
  // the mid-turn resume paths): priorMessageCount must index the user message
  // inside `messages` so turnMessagesFromAgent yields the FULL turn, never only
  // a post-compaction tail.
  const turnUserIndex = (() => {
    const index = messages.findIndex((m) => m.id === userMessage.id);
    return index >= 0 ? index : messages.length - 1;
  })();
  const activeAgent: ActiveAgent = {
    sessionId, windowId, turnId, cwd: turnCtx.cwd, startedAt: Date.now(), actor, interruptActor,
    abortController, messages, priorMessageCount: turnUserIndex, turnMessages: [], responseCommittedLength: 0,
    thinkingCommittedLength: 0, thinkingArtifactsCommitted: 0, agent, selection: turnSelection,
    thinkingReplay, agentCancelled: false,
    finalized: false, generation, eventSequence: 0, lastChatState: null, toolCalls: new Map(),
    streamSegments: [], unsubscribe: () => subscription?.unsubscribe(),
    interruptUnsubscribe: () => interruptSubscription?.unsubscribe(), interruptResetTimer: null,
    sessionTitleTimer: null, runtime, chainId,
    releaseResources,
  };
  const setTurnBase = (nextMessages: Message[], transcriptOverride?: readonly Message[]): void => {
    messages.splice(0, messages.length, ...nextMessages);
    activeAgent.messages.splice(0, activeAgent.messages.length, ...nextMessages);
    // The durable turn slice follows the transcript source: the compaction
    // resume's model-view replay must never become the durable row (it drops
    // flagged originals + superseded heads), so checkpoints and the finalize
    // rewrite read the transcript-complete override when one exists.
    const transcriptSource = transcriptOverride ?? nextMessages;
    const tAnchor = transcriptSource.findIndex((m) => m.id === userMessage.id);
    activeAgent.transcriptBase = tAnchor >= 0
      ? [...transcriptSource.slice(tAnchor)]
      : [...transcriptSource];
  };
  activeAgents.set(sessionId, activeAgent);
  sessionsStarting.delete(sessionId);
  // A live main-agent turn owns the Esc phases again; drop any staged
  // standalone subagent-cancel confirmation from a previously disposed turn.
  clearSubagentCancelConfirm(sessionId);

  // A long-running first turn must not leave the session unnamed forever:
  // after the configured wait, name from the current in-flight history even
  // while the agent keeps working. 0 disables the deadline.
  const titleWaitSeconds = runtime.config.session_title_max_wait_seconds;
  if (titleWaitSeconds > 0 && sessionGate.session.name.startsWith('Session ')) {
    const titleTimer = setTimeout(() => {
      activeAgent.sessionTitleTimer = null;
      if (!isCurrentAgent(sessionId, activeAgent)) return;
      if (activeAgent.finalized || activeAgent.agentCancelled) return;
      const current = sessionManager.getSession(sessionId);
      if (!current || !current.name.startsWith('Session ')) return;
      triggerSessionAutoName({
        sessionId,
        runtime,
        webContents,
        messages: currentTurnSnapshot(activeAgent, actor.getSnapshot().context as AgentContext),
        fallbackSelection: activeAgent.selection,
        accounting: { store: accountingStore, sessionId, chainId, turnId },
      });
    }, Math.round(titleWaitSeconds * 1000));
    activeAgent.sessionTitleTimer = titleTimer;
  }

  const flushResponseSegment = (fullResponse: string, attachUsage: Usage | null = null) => {
    if (fullResponse.length <= activeAgent.responseCommittedLength) return;
    const segment = fullResponse.slice(activeAgent.responseCommittedLength);
    const segmentId = textSegmentIdAtOffset(activeAgent, 'text', activeAgent.responseCommittedLength);
    activeAgent.responseCommittedLength = fullResponse.length;
    if (!segment.trim() && !attachUsage) return;
    activeAgent.turnMessages.push(makeAssistantMessage(segment, attachUsage, segmentId));
  };
  const flushThinkingSegment = (
    context: Pick<AgentContext, 'thinking' | 'thinkingPayloads' | 'thinkingArtifacts'>,
  ) => {
    const fullThinking = context.thinking ?? '';
    if (fullThinking.length > activeAgent.thinkingCommittedLength) {
      const segment = fullThinking.slice(activeAgent.thinkingCommittedLength);
      const segmentId = textSegmentIdAtOffset(activeAgent, 'thinking', activeAgent.thinkingCommittedLength);
      const payload = context.thinkingPayloads?.[fullThinking.length];
      activeAgent.thinkingCommittedLength = fullThinking.length;
      if (segment.trim()) {
        activeAgent.turnMessages.push(makeThinkingMessage(segment, segmentId, payload));
      }
    }
    const artifacts = context.thinkingArtifacts ?? [];
    for (let index = activeAgent.thinkingArtifactsCommitted; index < artifacts.length; index += 1) {
      activeAgent.turnMessages.push(makeThinkingMessage('', undefined, artifacts[index]));
    }
    activeAgent.thinkingArtifactsCommitted = artifacts.length;
  };
  // Opaque thinking renders as an indicator with a token count (R17); the
  // provider reports reasoning tokens per step, so only a single text-less
  // artifact can be stamped unambiguously.
  const stampOpaqueThinkingTokenCount = (usage: Usage | null) => {
    const reasoningTokens = usage?.reasoning_tokens;
    if (!reasoningTokens) return;
    const candidates = activeAgent.turnMessages.filter((message) =>
      message.type === MessageType.THINKING
      && !message.content
      && message.thinking_payload
      && message.thinking_payload.reasoningTokenCount === undefined);
    if (candidates.length !== 1) return;
    const target = candidates[0];
    const index = activeAgent.turnMessages.indexOf(target);
    activeAgent.turnMessages[index] = {
      ...target,
      thinking_payload: { ...target.thinking_payload!, reasoningTokenCount: reasoningTokens },
    };
  };
  const finalizeTurn = (opts: { response: string; usage: Usage | null; interrupted: boolean; sendDone: boolean }) => {
    if (activeAgent.finalized) return;
    activeAgent.finalized = true;
    completed = true;
    if (activeAgent.sessionTitleTimer) {
      clearTimeout(activeAgent.sessionTitleTimer);
      activeAgent.sessionTitleTimer = null;
    }
    flushThinkingSegment(activeAgent.actor.getSnapshot().context as AgentContext);
    stampOpaqueThinkingTokenCount(opts.usage);
    const remaining = opts.response.slice(activeAgent.responseCommittedLength);
    if (remaining || (opts.interrupted && activeAgent.responseCommittedLength === 0 && !opts.response)) {
      activeAgent.turnMessages.push(makeAssistantMessage(
        remaining || opts.response || '', opts.usage,
        textSegmentIdAtOffset(activeAgent, 'text', activeAgent.responseCommittedLength),
      ));
      activeAgent.responseCommittedLength = opts.response.length;
    } else if (opts.usage && !attachUsageToLatestAssistant(activeAgent.turnMessages, opts.usage)) {
      activeAgent.turnMessages.push({ ...makeAssistantMessage('', opts.usage), hidden: true });
    }
    const turnExtras = [...activeAgent.turnMessages];
    const terminalMessages = turnMessagesFromAgent(activeAgent);
    const fullHistory = [...messages, ...turnExtras];
    // keep hysteresis calibrated with final usage
    if (opts.usage && contextTokens != null) {
      const inputTokens = opts.usage.context?.input_tokens ?? opts.usage.prompt_tokens;
      const trig = getCompactionTrigger(sessionId);
      trig.observeUsage(inputTokens, fullHistory);
      trig.onUsage(inputTokens, contextTokens, runtime.config.compaction.main.threshold, runtime.config.compaction.main.hysteresis_delta);
    }
    persistTurnConversation(
      sessionId, fullHistory, terminalMessages,
      opts.interrupted ? ChainStatus.INTERRUPTED : ChainStatus.COMPLETED,
      agent, activeAgent.selection, webContents,
    );
    activeAgent.messages = fullHistory;
    completeSessionActivity(sessionId, getSessionManager().getActive(windowId)?.id !== sessionId);
    if (opts.sendDone) {
      sendTurnEvent(webContents, activeAgent, IPC_CHANNELS.CHAT_DONE, {
        type: 'done', response: opts.response, messages: terminalMessages,
        interrupted: opts.interrupted, usage: opts.usage,
      });
    }
    // Interrupted turns name too: the user's request is already on record and
    // an abandoned first turn should not stay "Session …" forever. The trigger
    // dedupes against a mid-turn deadline attempt already in flight.
    triggerSessionAutoName({
      sessionId,
      runtime,
      webContents,
      messages: fullHistory,
      fallbackSelection: activeAgent.selection,
      accounting: { store: accountingStore, sessionId, chainId, turnId },
    });
    clearCompactionRetryTried(sessionId, turnId);
  };

  interruptSubscription = interruptActor.subscribe((interruptSnapshot) => {
    if (!isCurrentAgent(sessionId, activeAgent)) return;
    const interruptState = interruptSnapshot.value as 'idle' | 'confirmAgent' | 'confirmSubagents';
    if (interruptResetTimer) {
      clearTimeout(interruptResetTimer);
      interruptResetTimer = null;
      activeAgent.interruptResetTimer = null;
    }
    if (interruptState !== 'idle') {
      interruptResetTimer = setTimeout(() => interruptActor.send({ type: 'INTERRUPT_TIMEOUT' }), 5000);
      activeAgent.interruptResetTimer = interruptResetTimer;
    } else if (activeAgent.agentCancelled) {
      queueMicrotask(() => {
        if (activeAgents.get(sessionId) === activeAgent) disposeActiveAgent(sessionId, activeAgent);
      });
    }
    const context = actor.getSnapshot().context as AgentContext;
    sendChatState(webContents, activeAgent, {
      state: String(actor.getSnapshot().value), error: context.error, interruptState, cwd: turnCtx.cwd,
    });
  });

  subscription = actor.subscribe((snapshot) => {
    if (!canEmitStreamEvents(sessionId, activeAgent)) return;
    const context = snapshot.context as AgentContext;
    const activityDetail = context.streamingToolCall?.toolName
      ? `Preparing ${context.streamingToolCall.toolName}`
      : 'Generating response';
    const activityKey = `${String(snapshot.value)}:agent:${activityDetail}`;
    if (activityKey !== lastActivityKey) {
      lastActivityKey = activityKey;
      publishSessionActivity(sessionId, {
        cwd: turnCtx.cwd, state: 'working', phase: 'agent', detail: activityDetail, canCancel: true,
      });
    }
    if (context.response.length > lastSentLength) {
      const newContent = context.response.slice(lastSentLength);
      lastSentLength = context.response.length;
      const segmentId = appendTextSegment(activeAgent, 'text', newContent);
      sendTurnEvent(webContents, activeAgent, IPC_CHANNELS.CHAT_CHUNK, { type: 'chunk', data: newContent, segmentId });
    }
    const thinking = context.thinking ?? '';
    if (thinking.length > lastThinkingLength) {
      const newThinking = thinking.slice(lastThinkingLength);
      lastThinkingLength = thinking.length;
      const segmentId = appendTextSegment(activeAgent, 'thinking', newThinking);
      sendTurnEvent(webContents, activeAgent, IPC_CHANNELS.CHAT_THINKING, { type: 'thinking', data: newThinking, segmentId });
    }
    const interruptState = interruptActor.getSnapshot().value as 'idle' | 'confirmAgent' | 'confirmSubagents';
    sendChatState(webContents, activeAgent, {
      state: String(snapshot.value), error: context.error, interruptState, cwd: turnCtx.cwd,
    });
    if (context.usage && context.usage !== lastUsage) {
      lastUsage = context.usage;
      sendTurnEvent(webContents, activeAgent, IPC_CHANNELS.CHAT_USAGE, { type: 'usage', usage: context.usage });
      checkpointActiveTurn(activeAgent, context);
      if (contextTokens != null) {
        const inputTokens = context.usage.context?.input_tokens ?? context.usage.prompt_tokens;
        const fullHistory = [...messages, ...turnMessagesFromAgent(activeAgent)];
        handleUsageCompaction(sessionId, fullHistory, inputTokens, contextTokens, runtime, turnSelection, accountingStore!, chainId, turnId);
      }
    }
    if (context.streamingToolCall) {
      const stc = context.streamingToolCall;
      if (stc.toolCallId !== lastStreamingToolCallId) {
        lastStreamingToolCallId = stc.toolCallId;
        lastStreamingToolArgLength.set(stc.toolCallId, 0);
        ensureToolSnapshot(activeAgent, stc.toolCallId, stc.toolName);
        sendTurnEvent(webContents, activeAgent, IPC_CHANNELS.CHAT_TOOL_CALL_START, {
          type: 'tool_call_start', toolCallId: stc.toolCallId, toolName: stc.toolName,
        });
      }
      const previousLength = lastStreamingToolArgLength.get(stc.toolCallId) ?? 0;
      const argsDelta = stc.partialArgs.slice(previousLength);
      if (argsDelta) {
        lastStreamingToolArgLength.set(stc.toolCallId, stc.partialArgs.length);
        const current = ensureToolSnapshot(activeAgent, stc.toolCallId, stc.toolName);
        updateToolSnapshot(activeAgent, stc.toolCallId, stc.toolName, { partialArgs: current.partialArgs + argsDelta });
        sendTurnEvent(webContents, activeAgent, IPC_CHANNELS.CHAT_TOOL_CALL_DELTA, {
          type: 'tool_call_delta', toolCallId: stc.toolCallId, argsDelta,
        });
      }
    } else if (lastStreamingToolCallId) {
      lastStreamingToolCallId = null;
    }
    if (context.toolLifecycleUpdate && context.toolLifecycleUpdate.sequence !== lastToolUpdateSequence) {
      const update = context.toolLifecycleUpdate;
      lastToolUpdateSequence = update.sequence;
      updateToolSnapshot(activeAgent, update.toolCallId, update.toolName ?? 'unknown', {
        toolName: update.toolName ?? 'unknown', status: update.status, args: update.args ?? '',
        content: update.content ?? null, toolResult: update.toolResult ?? null,
        finishedAt: update.status === 'running' ? null : new Date().toISOString(),
      });
      sendTurnEvent(webContents, activeAgent, IPC_CHANNELS.CHAT_TOOL_CALL_UPDATE, {
        type: 'tool_call_update', toolCallId: update.toolCallId, toolName: update.toolName,
        status: update.status, args: update.args, content: update.content, toolResult: update.toolResult,
      });
      if (update.status === 'running' && update.args != null) {
        const already = activeAgent.turnMessages.some((entry) =>
          entry.type === MessageType.TOOL_CALL && entry.tool_call_id === update.toolCallId,
        );
        if (!already) {
          flushThinkingSegment(context);
          flushResponseSegment(context.response);
          activeAgent.turnMessages.push(makeToolCallMessage(
            update.toolCallId, update.toolName ?? 'unknown', update.args,
          ));
        }
      }
      if (update.status !== 'running') {
        const hasCall = activeAgent.turnMessages.some((entry) =>
          entry.type === MessageType.TOOL_CALL && entry.tool_call_id === update.toolCallId,
        );
        if (!hasCall) {
          flushThinkingSegment(context);
          flushResponseSegment(context.response);
          activeAgent.turnMessages.push(makeToolCallMessage(
            update.toolCallId, update.toolName ?? 'unknown', update.args ?? '{}',
          ));
        }
        const hasResult = activeAgent.turnMessages.some((entry) =>
          entry.type === MessageType.TOOL_RESULT && entry.tool_call_id === update.toolCallId,
        );
        if (!hasResult) {
          const toolResultMessage = makeToolResultMessage(
            update.toolCallId, update.toolName ?? 'unknown', update.content ?? '', update.toolResult!,
          );
          activeAgent.turnMessages.push(
            update.toolResult?.status === 'cancelled'
              ? { ...toolResultMessage, excludeFromModel: true }
              : toolResultMessage,
          );
        }
      }
    }
    /**
     * Re-anchor the durable turn slice at the turn's user message inside the
     * compacted/remerged history (P1 #3) and clear every per-turn accumulation
     * so the replay restarts clean. The durable row holds the whole turn
     * (compaction inserts summary heads INLINE and only flags the prefix —
     * never splits rows), so the user-anchored full-turn rewrite preserves the
     * flagged prefix and the heads in place. `transcriptOverride` carries the
     * transcript-complete view for selective applies whose model-view replay
     * omits flagged originals (review #54).
     */
    const resetTurnForCompactionResume = (nextMessages: Message[], transcriptOverride?: readonly Message[]): void => {
      const anchorIndex = nextMessages.findIndex((m) => m.id === userMessage.id);
      if (anchorIndex < 0) {
        // Defensive: a history that lost the turn's user message must never
        // truncate the durable turn — re-append it.
        nextMessages.push(userMessage);
      }
      setTurnBase(nextMessages, transcriptOverride);
      activeAgent.priorMessageCount = anchorIndex >= 0 ? anchorIndex : nextMessages.length - 1;
      activeAgent.turnMessages = [];
      activeAgent.responseCommittedLength = 0;
      activeAgent.thinkingCommittedLength = 0;
      activeAgent.thinkingArtifactsCommitted = 0;
      lastSentLength = 0;
      lastThinkingLength = 0;
      lastUsage = null;
    };
    if (snapshot.value === 'idle' && context.currentInput && !completed && !activeAgent.agentCancelled) {
      if (shouldPauseForCompaction(sessionId, MAIN_AGENT_SCOPE_ID)) {
        clearCompactionPause(sessionId, MAIN_AGENT_SCOPE_ID);
        const fullHistoryForPause = [...messages, ...turnMessagesFromAgent(activeAgent)];
        publishSessionActivity(sessionId, { cwd: turnCtx.cwd, state: 'working', phase: 'agent', detail: 'Compacting context — applying summary…', canCancel: true });
        emitCompactionProgress(sessionId, 'compacting', 'Applying summary', { webContents });
        (async () => {
          try {
            let applied = false;
            let updated: Message[] | undefined;
            const pendingRes = await applyPendingCompactionIfAny(sessionId, fullHistoryForPause, runtime);
            if (pendingRes.applied && pendingRes.updatedMessages) {
              applied = true;
              updated = pendingRes.updatedMessages;
            }
            if (applied && updated) {
              // The compacted replay keeps the full model history; the reset
              // anchors the durable turn slice at the user message so the
              // finalized persistTurn REPLACES the active chain with the FULL
              // turn (user + flagged prefix + summary head + window + new
              // content), never only the post-resume tail (P1 #3). The
              // transcript override keeps the durable row complete when the
              // model-view replay dropped flagged originals (selective).
              resetTurnForCompactionResume(updated, pendingRes.transcriptMessages);
              // The applied path also drops the pre-pause stream segments (the
              // overflow-retry path below intentionally keeps them). Tool
              // snapshots go with them: every pre-compaction tool is either
              // flagged (collapsed into the compacted stub) or preserved
              // (committed to chains), so the live snapshot and any later
              // hydration must not resurrect them into the live tail.
              activeAgent.streamSegments = [];
              activeAgent.toolCalls.clear();
              try {
                actor.send({ type: 'USER_INPUT', message });
                publishSessionActivity(sessionId, { cwd: turnCtx.cwd, state: 'working', phase: 'agent', detail: 'Resuming after compaction', canCancel: true });
                emitCompactionProgress(sessionId, 'complete', 'Context compacted — resuming', { webContents });
                return;
              } catch (e) {
                console.debug('[compaction] mid-turn resume failed:', e);
              }
            }
          } catch (e) {
            console.debug('[compaction] mid-turn pause handling failed:', e);
          }
          {
            emitCompactionProgress(sessionId, 'complete', undefined, { webContents });
          }
          clearCompactionPause(sessionId, MAIN_AGENT_SCOPE_ID);
          try {
            const snap = activeAgent.actor.getSnapshot();
            const ctxSnap = snap.context as AgentContext;
            if (snap.value === 'idle' && ctxSnap.currentInput && !activeAgent.finalized && !activeAgent.agentCancelled) {
              try {
                // Compaction did not apply: resume from the full accumulated
                // history (turn base + turn messages), never the bare turn
                // base — restarting from the turn start silently discards all
                // in-turn tool progress and makes context usage collapse.
                const merged = dedupeHistoryById([...messages, ...turnMessagesFromAgent(activeAgent)]);
                resetTurnForCompactionResume(merged);
                activeAgent.streamSegments = [];
                activeAgent.actor.send({ type: 'USER_INPUT', message: ctxSnap.currentInput });
                publishSessionActivity(sessionId, { cwd: turnCtx.cwd, state: 'working', phase: 'agent', detail: 'Resuming after compaction', canCancel: true });
                return;
              } catch (e) {
                console.debug('[compaction] resume after unapplied compaction failed:', e);
              }
            }
          } catch {
            // resume-after-compaction is best-effort; fall through to finalize
          }
          finalizeTurn({ response: context.response, usage: context.usage ?? null, interrupted: false, sendDone: true });
          queueMicrotask(() => disposeActiveAgent(sessionId, activeAgent));
        })();
        return;
      }
      finalizeTurn({ response: context.response, usage: context.usage ?? null, interrupted: false, sendDone: true });
      queueMicrotask(() => disposeActiveAgent(sessionId, activeAgent));
    }
    if (snapshot.value === 'error') {
      const detail = context.error ?? 'Unknown error';
      const title = context.errorTitle ?? 'Stream Error';
      const isOverflow = isContextLengthExceededError(`${title} ${detail}`);
      if (isOverflow && !hasTriedCompactionRetry(sessionId, turnId) && contextTokens != null) {
        if (overflowRetryInFlight) return;
        markCompactionRetryTried(sessionId, turnId);
        overflowRetryInFlight = true;
        // One compaction-and-retry (R15). Compact the prefix (messages) and retry once before declaring failed.
        const historyForRetry = [...messages];
        (async () => {
          try {
            try {
              // A context-length error proves input >= contextTokens — record
              // that measured lower bound so the retry's token estimate is
              // grounded in observation instead of a heuristic ratio.
              const retryTrigger = getCompactionTrigger(sessionId);
              if (retryTrigger.state.tokensPerChar == null) {
                retryTrigger.state.lastObservedInputTokens = contextTokens;
              }
              const retryResult = await tryCompactSynchronously(sessionId, historyForRetry, runtime, turnSelection, contextTokens, accountingStore!, chainId, turnId);
              if (retryResult.didApply && retryResult.updatedMessages) {
                // The compacted retry base anchors the durable turn slice at
                // the user message so a later finalize REPLACES the active
                // chain with the full turn, never only the post-retry tail
                // (same invariant as P1 #3). streamSegments is intentionally
                // NOT cleared on the retry path. The transcript override keeps
                // the durable row complete for selective applies (review #54).
                resetTurnForCompactionResume(retryResult.updatedMessages, retryResult.transcriptMessages);
                try {
                  actor.send({ type: 'USER_INPUT', message });
                  publishSessionActivity(sessionId, {
                    cwd: turnCtx.cwd, state: 'working', phase: 'agent', detail: 'Retrying after compaction', canCancel: true,
                  });
                  return;
                } catch (e) {
                  console.debug('[compaction] retry USER_INPUT failed:', e);
                }
              }
            } catch (e) {
            console.debug('[compaction] overflow retry compaction failed:', e);
          }
          completed = true;
          activeAgent.finalized = true;
          publishSessionActivity(sessionId, {
            cwd: turnCtx.cwd, state: 'needs_attention', phase: 'agent', detail: title || detail, canCancel: false,
          });
          flushPartialTurnContent(activeAgent, context);
          const terminalMessages = turnMessagesFromAgent(activeAgent);
          const fullHistory = [...messages, ...activeAgent.turnMessages];
          persistTurnConversation(
            sessionId, fullHistory, terminalMessages, ChainStatus.FAILED,
            agent, activeAgent.selection, webContents,
            detail, title,
          );
          activeAgent.messages = fullHistory;
          sendTurnEvent(webContents, activeAgent, IPC_CHANNELS.CHAT_ERROR, {
            type: 'error', error: detail, messages: terminalMessages, title, kind: classifyErrorKind(title, detail),
          });
          queueMicrotask(() => disposeActiveAgent(sessionId, activeAgent));
          clearCompactionRetryTried(sessionId, turnId);
          } finally {
            overflowRetryInFlight = false;
          }
        })();
        return;
      }
      if (overflowRetryInFlight) return;
      completed = true;
      activeAgent.finalized = true;
      publishSessionActivity(sessionId, {
        cwd: turnCtx.cwd, state: 'needs_attention', phase: 'agent', detail: title || detail, canCancel: false,
      });
      flushPartialTurnContent(activeAgent, context);
      const terminalMessages = turnMessagesFromAgent(activeAgent);
      const fullHistory = [...messages, ...activeAgent.turnMessages];
      persistTurnConversation(
        sessionId, fullHistory, terminalMessages, ChainStatus.FAILED,
        agent, activeAgent.selection, webContents,
        detail, title,
      );
      activeAgent.messages = fullHistory;
      sendTurnEvent(webContents, activeAgent, IPC_CHANNELS.CHAT_ERROR, {
        type: 'error', error: detail, messages: terminalMessages, title, kind: classifyErrorKind(title, detail),
      });
      queueMicrotask(() => disposeActiveAgent(sessionId, activeAgent));
      clearCompactionRetryTried(sessionId, turnId);
    }
  });
  try {
    actor.start();
    interruptActor.start();
    sendChatState(webContents, activeAgent, {
      state: 'streaming', error: null, interruptState: 'idle', cwd: turnCtx.cwd,
    });
    actor.send({ type: 'USER_INPUT', message });
  } catch (error) {
    disposeActiveAgent(sessionId, activeAgent);
    completeSessionActivity(sessionId, false);
    return {
      status: 'error', error: error instanceof Error ? error.message : String(error),
      kind: 'runtime_hydration_failed',
    };
  }
  return { status: 'started', sessionId, turnId };
}
