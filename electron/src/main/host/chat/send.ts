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
import { createActor, type ActorRefFrom } from 'xstate';
import { z } from 'zod';
import { agentMachine, type AgentContext } from '../../agents/xstate/agent-machine';
import { interruptMachine } from '../../agents/xstate/interrupt-machine';
import { appendRootAgentsMd, findRootAgentsMdEntry } from '../../project/agents-md';
import { appendProjectPersonality } from '../../project/personality';
import { appendSharedRules } from '../../project/shared-prompts';
import { getProviderRuntime } from '../../providers';
import { getProviderAccountingStore } from '../../providers/accounting/store';
import type { ProviderAttemptAccountingContext } from '../../providers/accounting/middleware';
import type { ReasoningProviderOptions } from '../../providers/drivers/types';
import {
  DEFAULT_THINKING_POLICY,
} from '../../providers/facets/thinking';
import type { ThinkingReplayContext } from '../../llm/history';
import type { CacheFacet, ThinkingPolicy } from '../../../shared/types/provider-facets';
import type { ModelSelection, ProviderProtocol } from '../../../shared/types/provider';
import type { Session } from '../../../shared/types/session';
import type { Agent } from '../../../shared/types/agent';
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
import { IPC_CHANNELS, type ChatSendResult } from '../../../shared/types/ipc';
import { ChainStatus } from '../../../shared/types/chain';
import { MessageType, type Message, type Usage } from '../../../shared/types/message';
import { getChatHistory, setChatHistory } from './history';
import { chatSendSchema } from '../../../shared/types/ipc-schemas';
import { clearNextRequestStop, clearCompactionPause, shouldPauseForCompaction } from '../../agents/next-request-stop';
import { MAIN_AGENT_SCOPE_ID } from '../../../shared/types/agent-scope';
import { completeSessionActivity, publishSessionActivity } from '../../session/activity-live';
import type { ProjectRuntime } from '../../project/runtime';
import { disposeActiveAgent, forceAbortSession } from './abort';
import { emitSessionUpdated, sendChatState, sendTurnEvent, type HostClientId } from './events';
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
  thinkingDurationMsForRange,
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

type AgentActor = ActorRefFrom<typeof agentMachine>;
type InterruptActor = ActorRefFrom<typeof interruptMachine>;
type AgentSnapshot = ReturnType<AgentActor['getSnapshot']>;
type ToolLifecycleUpdate = NonNullable<AgentContext['toolLifecycleUpdate']>;

const SESSION_BUSY_ERROR = 'A turn is already starting for this session.';

const FALLBACK_TURN_AGENT: Agent = {
  name: 'general', type: 'subagent', tier: 'bloom',
  description: 'General-purpose agent', system_prompt: 'You are a helpful assistant.',
  allowed_tools: ['*'], allowed_skills: ['*'],
};

function resolveTurnAgent(runtime: ProjectRuntime): Agent {
  const agents = [...runtime.agents.values()];
  return agents.find((candidate) => candidate.name === 'general') ?? agents[0] ?? FALLBACK_TURN_AGENT;
}

/**
 * Provider-resolved turn inputs frozen before the actor starts streaming.
 */
interface TurnProviderSetup {
  modelInstance: LanguageModelV4;
  providerSnapshot: ProviderAttemptAccountingContext['snapshot'];
  providerOptions: ReasoningProviderOptions | undefined;
  pricingFacet: ProviderAttemptAccountingContext['pricingFacet'];
  thinkingPolicy: ThinkingPolicy | undefined;
  cacheFacet: CacheFacet | undefined;
  cacheTtl: string | undefined;
  cacheSessionKey: string | undefined;
  tierMechanism: ProviderAttemptAccountingContext['tierMechanism'];
  accountingStore: ReturnType<typeof getProviderAccountingStore>;
  contextTokens: number | null;
}

type TurnProviderResolution =
  | { ok: true; setup: TurnProviderSetup }
  | { ok: false; error: string };

async function resolveTurnProviderSetup(
  session: Session,
  turnSelection: ModelSelection,
  sessionId: string,
): Promise<TurnProviderResolution> {
  try {
    const accountingStore = getProviderAccountingStore();
    // Resolve the effective tier before model construction so the variant
    // mapping and the frozen snapshot both observe the same selection (R21).
    const tierContext = await getProviderRuntime().resolveTierContext(turnSelection);
    const effectiveTier = resolveMainAgentTier(
      session,
      tierContext.connection,
      turnSelection.modelId,
      tierContext.tierMechanism,
    );
    const execution = await getProviderRuntime().resolveExecution(
      turnSelection,
      effectiveTier !== undefined ? { tier: effectiveTier } : {},
    );
    const effort = resolveMainAgentEffort(
      session, execution.connection, turnSelection.modelId,
      execution.model.capabilities?.reasoning === true,
    );
    const reasoningOptions = effort === undefined ? undefined : execution.buildReasoningOptions?.(effort);
    const facetOptions = assembleFacetProviderOptions({
      providerOptions: reasoningOptions,
      thinkingPolicy: execution.thinkingPolicy,
      providerId: execution.snapshot.providerId,
      tierId: resolveMainAgentTier(
        session, execution.connection, turnSelection.modelId, execution.tierMechanism,
      ),
      tierMechanism: execution.tierMechanism,
      cacheFacet: execution.cacheFacet,
      cacheTtlSelection: execution.connection.cacheTtl,
      sessionId,
    });
    return {
      ok: true,
      setup: {
        accountingStore,
        modelInstance: execution.modelInstance,
        providerSnapshot: execution.snapshot,
        pricingFacet: execution.pricingFacet,
        thinkingPolicy: execution.thinkingPolicy,
        cacheFacet: execution.cacheFacet,
        contextTokens: execution.model.limits?.contextTokens ?? null,
        providerOptions: facetOptions.providerOptions,
        cacheSessionKey: facetOptions.cacheSessionKey,
        cacheTtl: facetOptions.cacheTtl,
        tierMechanism: execution.tierMechanism,
      },
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Claim the per-session turn-start slot. Returns the busy error string, or
 * null once this send owns the slot.
 */
async function claimTurnStartSlot(sessionId: string): Promise<string | null> {
  if (sessionsStarting.has(sessionId)) return SESSION_BUSY_ERROR;
  // A manual compaction (/compact) may still be persisting on this idle
  // session — its entry busy check ran before this send claimed the
  // turn-start slot. Wait the operation gate out (no yield when nothing is
  // gated), then re-check: another send may have claimed the slot while we
  // waited.
  const operationGate = sessionOperationGateTail(sessionId);
  if (operationGate) {
    await operationGate;
    if (sessionsStarting.has(sessionId)) return SESSION_BUSY_ERROR;
  }
  sessionsStarting.add(sessionId);
  return null;
}

/**
 * Hydrate the session's subagent runtime before the turn claims it. Returns
 * the error message, or null on success.
 */
async function hydrateTurnRuntime(
  sessionId: string,
  runtime: ProjectRuntime,
  windowId: HostClientId,
  cwd: string,
): Promise<string | null> {
  try {
    await awaitSessionSubagentHydration(getSubagentManager(), sessionId, {
      projectRuntime: runtime,
      windowId,
      cwd,
    });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Run the turn-start compaction seams: consume an armed pending apply, then
 * attempt one synchronous compaction. Returns the (possibly rewritten) turn
 * base.
 */
async function applySendTimeCompaction(
  sessionId: string,
  messages: Message[],
  userMessage: Message,
  deps: {
    runtime: ProjectRuntime;
    selection: ModelSelection;
    contextTokens: number | null;
    accountingStore: TurnProviderSetup['accountingStore'];
    chainId: string | null;
    turnId: string;
  },
): Promise<Message[]> {
  await hydrateTriggerCalibration(sessionId);
  const pendingApplied = await applyPendingCompactionIfAny(sessionId, messages, deps.runtime);
  let next = messages;
  if (pendingApplied.applied && pendingApplied.updatedMessages) {
    const updated = pendingApplied.updatedMessages;
    // Defensive: the applied replay must carry the just-appended user message
    // into the model request — if a stale prepare-time snapshot lost it,
    // re-append rather than silently dropping the turn (P1 #5).
    if (!updated.some((m) => m.id === userMessage.id)) {
      updated.push(userMessage);
      setChatHistory(sessionId, [...updated]);
    }
    next = updated;
  }
  const syncResult = await tryCompactSynchronously({
    sessionId, messages: next, runtime: deps.runtime, selection: deps.selection,
    contextTokens: deps.contextTokens, accountingStore: deps.accountingStore,
    chainId: deps.chainId, turnId: deps.turnId,
  });
  if (syncResult.didApply && syncResult.updatedMessages) {
    next = syncResult.updatedMessages;
  }
  return next;
}

/** Mutable per-turn stream-projection state shared across subscription handlers. */
interface TurnStreamTracker {
  activityKey: string;
  sentLength: number;
  thinkingLength: number;
  usage: Usage | null;
  streamingToolCallId: string | null;
  streamingToolArgLengths: Map<string, number>;
  toolUpdateSequence: number;
  completed: boolean;
  overflowRetryInFlight: boolean;
}

/**
 * Inputs for wiring the actor subscriptions that project a live turn onto
 * IPC events, snapshots, and persistence.
 */
interface TurnProjectionDeps {
  sessionId: string;
  windowId: HostClientId;
  cwd: string;
  activeAgent: ActiveAgent;
  actor: AgentActor;
  interruptActor: InterruptActor;
  runtime: ProjectRuntime;
  agent: Agent;
  selection: ModelSelection;
  accountingStore: TurnProviderSetup['accountingStore'];
  chainId: string | null;
  turnId: string;
  contextTokens: number | null;
  userMessage: Message;
  message: string;
  /** Shared mutable turn base — rewritten in place by compaction resumes. */
  messages: Message[];
}

/**
 * Subscribe the agent and interrupt actors, then return the unsubscribe
 * handles for the active agent. Every live-projection concern (chunks,
 * thinking, tool lifecycle, usage, terminal states, compaction pauses and
 * the overflow retry) lives here as one named handler per concern.
 */
function wireTurnProjection(deps: TurnProjectionDeps): {
  unsubscribe: () => void;
  interruptUnsubscribe: () => void;
} {
  const {
    sessionId, windowId, cwd, activeAgent, actor, interruptActor, runtime, agent,
    selection, accountingStore, chainId, turnId, contextTokens, userMessage, message, messages,
  } = deps;
  const tracker: TurnStreamTracker = {
    activityKey: 'streaming:agent:Generating response',
    sentLength: 0,
    thinkingLength: 0,
    usage: null,
    streamingToolCallId: null,
    streamingToolArgLengths: new Map(),
    toolUpdateSequence: 0,
    completed: false,
    overflowRetryInFlight: false,
  };
  let interruptResetTimer: ReturnType<typeof setTimeout> | null = null;

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
      const durationMs = thinkingDurationMsForRange(activeAgent, activeAgent.thinkingCommittedLength, fullThinking.length);
      activeAgent.thinkingCommittedLength = fullThinking.length;
      if (segment.trim()) {
        activeAgent.turnMessages.push(makeThinkingMessage(segment, segmentId, payload, durationMs));
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
    const candidates = activeAgent.turnMessages.filter((entry) =>
      entry.type === MessageType.THINKING
      && !entry.content
      && entry.thinking_payload
      && entry.thinking_payload.reasoningTokenCount === undefined);
    if (candidates.length !== 1) return;
    const target = candidates[0];
    const index = activeAgent.turnMessages.indexOf(target);
    activeAgent.turnMessages[index] = {
      ...target,
      thinking_payload: { ...target.thinking_payload!, reasoningTokenCount: reasoningTokens },
    };
  };

  const calibrateTriggerWithFinalUsage = (usage: Usage, fullHistory: Message[]): void => {
    if (contextTokens == null) return;
    const inputTokens = usage.context?.input_tokens ?? usage.prompt_tokens;
    const trig = getCompactionTrigger(sessionId);
    trig.observeUsage(inputTokens, fullHistory);
    trig.onUsage(inputTokens, contextTokens, runtime.config.compaction.main.threshold, runtime.config.compaction.main.hysteresis_delta);
  };
  const interruptedWithoutAnyContent = (opts: { response: string; interrupted: boolean }): boolean =>
    opts.interrupted
    && activeAgent.responseCommittedLength === 0
    && !opts.response;
  const commitFinalResponse = (opts: { response: string; usage: Usage | null; interrupted: boolean }): void => {
    const remaining = opts.response.slice(activeAgent.responseCommittedLength);
    const finalSegment = remaining || opts.response || '';
    if (remaining || interruptedWithoutAnyContent(opts)) {
      activeAgent.turnMessages.push(makeAssistantMessage(
        finalSegment, opts.usage,
        textSegmentIdAtOffset(activeAgent, 'text', activeAgent.responseCommittedLength),
      ));
      activeAgent.responseCommittedLength = opts.response.length;
      return;
    }
    if (opts.usage && !attachUsageToLatestAssistant(activeAgent.turnMessages, opts.usage)) {
      activeAgent.turnMessages.push({ ...makeAssistantMessage('', opts.usage), hidden: true });
    }
  };
  const finalizeTurn = (opts: { response: string; usage: Usage | null; interrupted: boolean; sendDone: boolean }) => {
    if (activeAgent.finalized) return;
    activeAgent.finalized = true;
    tracker.completed = true;
    if (activeAgent.sessionTitleTimer) {
      clearTimeout(activeAgent.sessionTitleTimer);
      activeAgent.sessionTitleTimer = null;
    }
    flushThinkingSegment(activeAgent.actor.getSnapshot().context as AgentContext);
    stampOpaqueThinkingTokenCount(opts.usage);
    commitFinalResponse(opts);
    const turnExtras = [...activeAgent.turnMessages];
    const terminalMessages = turnMessagesFromAgent(activeAgent);
    const fullHistory = [...messages, ...turnExtras];
    // keep hysteresis calibrated with final usage
    if (opts.usage) calibrateTriggerWithFinalUsage(opts.usage, fullHistory);
    persistTurnConversation(
      sessionId, fullHistory, terminalMessages,
      opts.interrupted ? ChainStatus.INTERRUPTED : ChainStatus.COMPLETED,
      agent, activeAgent.selection, windowId,
    );
    activeAgent.messages = fullHistory;
    completeSessionActivity(sessionId, getSessionManager().getActive(windowId)?.id !== sessionId);
    if (opts.sendDone) {
      sendTurnEvent(windowId, activeAgent, IPC_CHANNELS.CHAT_DONE, {
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
      clientId: windowId,
      messages: fullHistory,
      fallbackSelection: activeAgent.selection,
      accounting: { store: accountingStore, sessionId, chainId, turnId },
    });
    clearCompactionRetryTried(sessionId, turnId);
  };
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
    tracker.sentLength = 0;
    tracker.thinkingLength = 0;
    tracker.usage = null;
  };

  // ── Live stream projection (one handler per concern) ────────────────────────

  const publishStreamActivity = (snapshot: AgentSnapshot, context: AgentContext): void => {
    const activityDetail = context.streamingToolCall?.toolName
      ? `Preparing ${context.streamingToolCall.toolName}`
      : 'Generating response';
    const activityKey = `${String(snapshot.value)}:agent:${activityDetail}`;
    if (activityKey === tracker.activityKey) return;
    tracker.activityKey = activityKey;
    publishSessionActivity(sessionId, {
      cwd, state: 'working', phase: 'agent', detail: activityDetail, canCancel: true,
    });
  };
  const streamResponseChunk = (context: AgentContext): void => {
    if (context.response.length <= tracker.sentLength) return;
    const newContent = context.response.slice(tracker.sentLength);
    tracker.sentLength = context.response.length;
    const segmentId = appendTextSegment(activeAgent, 'text', newContent);
    sendTurnEvent(windowId, activeAgent, IPC_CHANNELS.CHAT_CHUNK, { type: 'chunk', data: newContent, segmentId });
  };
  const streamThinkingChunk = (context: AgentContext): void => {
    const thinking = context.thinking ?? '';
    if (thinking.length <= tracker.thinkingLength) return;
    const newThinking = thinking.slice(tracker.thinkingLength);
    tracker.thinkingLength = thinking.length;
    const segmentId = appendTextSegment(activeAgent, 'thinking', newThinking);
    sendTurnEvent(windowId, activeAgent, IPC_CHANNELS.CHAT_THINKING, { type: 'thinking', data: newThinking, segmentId });
  };
  const emitChatState = (snapshot: AgentSnapshot, context: AgentContext): void => {
    const interruptState = interruptActor.getSnapshot().value as 'idle' | 'confirmAgent' | 'confirmSubagents';
    sendChatState(windowId, activeAgent, {
      state: String(snapshot.value), error: context.error, interruptState, cwd,
    });
  };
  const handleUsageEvent = (context: AgentContext): void => {
    const usage = context.usage;
    if (!usage || usage === tracker.usage) return;
    tracker.usage = usage;
    sendTurnEvent(windowId, activeAgent, IPC_CHANNELS.CHAT_USAGE, { type: 'usage', usage });
    checkpointActiveTurn(activeAgent, context);
    if (contextTokens == null) return;
    const inputTokens = usage.context?.input_tokens ?? usage.prompt_tokens;
    const fullHistory = [...messages, ...turnMessagesFromAgent(activeAgent)];
    handleUsageCompaction(sessionId, fullHistory, inputTokens, contextTokens, runtime, selection, accountingStore, chainId, turnId);
  };
  const handleStreamingToolCall = (context: AgentContext): void => {
    const stc = context.streamingToolCall;
    if (!stc) {
      tracker.streamingToolCallId = null;
      return;
    }
    if (stc.toolCallId !== tracker.streamingToolCallId) {
      tracker.streamingToolCallId = stc.toolCallId;
      tracker.streamingToolArgLengths.set(stc.toolCallId, 0);
      ensureToolSnapshot(activeAgent, stc.toolCallId, stc.toolName);
      sendTurnEvent(windowId, activeAgent, IPC_CHANNELS.CHAT_TOOL_CALL_START, {
        type: 'tool_call_start', toolCallId: stc.toolCallId, toolName: stc.toolName,
      });
    }
    const previousLength = tracker.streamingToolArgLengths.get(stc.toolCallId) ?? 0;
    const argsDelta = stc.partialArgs.slice(previousLength);
    if (!argsDelta) return;
    tracker.streamingToolArgLengths.set(stc.toolCallId, stc.partialArgs.length);
    const current = ensureToolSnapshot(activeAgent, stc.toolCallId, stc.toolName);
    updateToolSnapshot(activeAgent, stc.toolCallId, stc.toolName, { partialArgs: current.partialArgs + argsDelta });
    sendTurnEvent(windowId, activeAgent, IPC_CHANNELS.CHAT_TOOL_CALL_DELTA, {
      type: 'tool_call_delta', toolCallId: stc.toolCallId, argsDelta,
    });
  };
  const hasTurnMessageForTool = (type: MessageType, toolCallId: string): boolean =>
    activeAgent.turnMessages.some((entry) => entry.type === type && entry.tool_call_id === toolCallId);
  const appendToolCallToTurn = (context: AgentContext, toolCallId: string, toolName: string, args: string): void => {
    if (hasTurnMessageForTool(MessageType.TOOL_CALL, toolCallId)) return;
    flushThinkingSegment(context);
    flushResponseSegment(context.response);
    activeAgent.turnMessages.push(makeToolCallMessage(toolCallId, toolName, args));
  };
  const appendToolResultToTurn = (update: ToolLifecycleUpdate, toolName: string): void => {
    if (hasTurnMessageForTool(MessageType.TOOL_RESULT, update.toolCallId)) return;
    const toolResultMessage = makeToolResultMessage(
      update.toolCallId, toolName, update.content ?? '', update.toolResult!,
    );
    activeAgent.turnMessages.push(
      update.toolResult?.status === 'cancelled'
        ? { ...toolResultMessage, excludeFromModel: true }
        : toolResultMessage,
    );
  };
  const handleToolLifecycleUpdate = (context: AgentContext): void => {
    const update = context.toolLifecycleUpdate;
    if (!update || update.sequence === tracker.toolUpdateSequence) return;
    tracker.toolUpdateSequence = update.sequence;
    const toolName = update.toolName ?? 'unknown';
    updateToolSnapshot(activeAgent, update.toolCallId, toolName, {
      toolName, status: update.status, args: update.args ?? '',
      content: update.content ?? null, toolResult: update.toolResult ?? null,
      finishedAt: update.status === 'running' ? null : new Date().toISOString(),
    });
    sendTurnEvent(windowId, activeAgent, IPC_CHANNELS.CHAT_TOOL_CALL_UPDATE, {
      type: 'tool_call_update', toolCallId: update.toolCallId, toolName: update.toolName,
      status: update.status, args: update.args, content: update.content, toolResult: update.toolResult,
    });
    if (update.status === 'running') {
      if (update.args == null) return;
      appendToolCallToTurn(context, update.toolCallId, toolName, update.args);
      return;
    }
    appendToolCallToTurn(context, update.toolCallId, toolName, update.args ?? '{}');
    appendToolResultToTurn(update, toolName);
  };

  // ── Idle / error terminal handling ──────────────────────────────────────────

  /** True when the actor still owes a resume from its currentInput. */
  const actorAwaitingResume = (snap: AgentSnapshot): boolean => {
    if (snap.value !== 'idle') return false;
    const ctxSnap = snap.context as AgentContext;
    if (!ctxSnap.currentInput) return false;
    if (activeAgent.finalized) return false;
    return !activeAgent.agentCancelled;
  };
  const turnAwaitingCompletion = (snapshot: AgentSnapshot, context: AgentContext): boolean => {
    if (snapshot.value !== 'idle') return false;
    if (!context.currentInput) return false;
    if (tracker.completed) return false;
    return !activeAgent.agentCancelled;
  };
  const resumeAfterUnappliedCompaction = (): boolean => {
    try {
      const snap = activeAgent.actor.getSnapshot();
      if (!actorAwaitingResume(snap)) return false;
      const ctxSnap = snap.context as AgentContext;
      try {
        // Compaction did not apply: resume from the full accumulated
        // history (turn base + turn messages), never the bare turn
        // base — restarting from the turn start silently discards all
        // in-turn tool progress and makes context usage collapse.
        const merged = dedupeHistoryById([...messages, ...turnMessagesFromAgent(activeAgent)]);
        resetTurnForCompactionResume(merged);
        activeAgent.streamSegments = [];
        activeAgent.actor.send({ type: 'USER_INPUT', message: ctxSnap.currentInput });
        publishSessionActivity(sessionId, { cwd, state: 'working', phase: 'agent', detail: 'Resuming after compaction', canCancel: true });
        return true;
      } catch (e) {
        console.debug('[compaction] resume after unapplied compaction failed:', e);
      }
    } catch {
      // resume-after-compaction is best-effort; fall through to finalize
    }
    return false;
  };
  const runMidTurnCompactionPause = async (context: AgentContext): Promise<void> => {
    clearCompactionPause(sessionId, MAIN_AGENT_SCOPE_ID);
    const fullHistoryForPause = [...messages, ...turnMessagesFromAgent(activeAgent)];
    publishSessionActivity(sessionId, { cwd, state: 'working', phase: 'agent', detail: 'Compacting context — applying summary…', canCancel: true });
    emitCompactionProgress(sessionId, 'compacting', 'Applying summary', { clientId: windowId });
    try {
      const pendingRes = await applyPendingCompactionIfAny(sessionId, fullHistoryForPause, runtime);
      if (pendingRes.applied && pendingRes.updatedMessages) {
        // The compacted replay keeps the full model history; the reset
        // anchors the durable turn slice at the user message so the
        // finalized persistTurn REPLACES the active chain with the FULL
        // turn (user + flagged prefix + summary head + window + new
        // content), never only the post-resume tail (P1 #3). The
        // transcript override keeps the durable row complete when the
        // model-view replay dropped flagged originals (selective).
        resetTurnForCompactionResume(pendingRes.updatedMessages, pendingRes.transcriptMessages);
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
          publishSessionActivity(sessionId, { cwd, state: 'working', phase: 'agent', detail: 'Resuming after compaction', canCancel: true });
          emitCompactionProgress(sessionId, 'complete', 'Context compacted — resuming', { clientId: windowId });
          return;
        } catch (e) {
          console.debug('[compaction] mid-turn resume failed:', e);
        }
      }
    } catch (e) {
      console.debug('[compaction] mid-turn pause handling failed:', e);
    }
    emitCompactionProgress(sessionId, 'complete', undefined, { clientId: windowId });
    clearCompactionPause(sessionId, MAIN_AGENT_SCOPE_ID);
    if (resumeAfterUnappliedCompaction()) return;
    finalizeTurn({ response: context.response, usage: context.usage ?? null, interrupted: false, sendDone: true });
    queueMicrotask(() => disposeActiveAgent(sessionId, activeAgent));
  };
  const handleIdleState = (snapshot: AgentSnapshot, context: AgentContext): void => {
    if (!turnAwaitingCompletion(snapshot, context)) return;
    if (!shouldPauseForCompaction(sessionId, MAIN_AGENT_SCOPE_ID)) {
      finalizeTurn({ response: context.response, usage: context.usage ?? null, interrupted: false, sendDone: true });
      queueMicrotask(() => disposeActiveAgent(sessionId, activeAgent));
      return;
    }
    void runMidTurnCompactionPause(context);
  };
  const failTurn = (context: AgentContext, detail: string, title: string): void => {
    tracker.completed = true;
    activeAgent.finalized = true;
    publishSessionActivity(sessionId, {
      cwd, state: 'needs_attention', phase: 'agent', detail: title || detail, canCancel: false,
    });
    flushPartialTurnContent(activeAgent, context);
    const terminalMessages = turnMessagesFromAgent(activeAgent);
    const fullHistory = [...messages, ...activeAgent.turnMessages];
    persistTurnConversation(
      sessionId, fullHistory, terminalMessages, ChainStatus.FAILED,
      agent, activeAgent.selection, windowId,
      detail, title,
    );
    activeAgent.messages = fullHistory;
    sendTurnEvent(windowId, activeAgent, IPC_CHANNELS.CHAT_ERROR, {
      type: 'error', error: detail, messages: terminalMessages, title, kind: classifyErrorKind(title, detail),
    });
    queueMicrotask(() => disposeActiveAgent(sessionId, activeAgent));
    clearCompactionRetryTried(sessionId, turnId);
  };
  const runOverflowRetry = async (
    context: AgentContext, detail: string, title: string, retryContextTokens: number,
  ): Promise<void> => {
    const historyForRetry = [...messages];
    try {
      try {
        // A context-length error proves input >= contextTokens — record
        // that measured lower bound so the retry's token estimate is
        // grounded in observation instead of a heuristic ratio.
        const retryTrigger = getCompactionTrigger(sessionId);
        if (retryTrigger.state.tokensPerChar == null) {
          retryTrigger.state.lastObservedInputTokens = retryContextTokens;
        }
        const retryResult = await tryCompactSynchronously({
          sessionId, messages: historyForRetry, runtime, selection, contextTokens: retryContextTokens,
          accountingStore, chainId, turnId,
        });
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
              cwd, state: 'working', phase: 'agent', detail: 'Retrying after compaction', canCancel: true,
            });
            return;
          } catch (e) {
            console.debug('[compaction] retry USER_INPUT failed:', e);
          }
        }
      } catch (e) {
        console.debug('[compaction] overflow retry compaction failed:', e);
      }
      failTurn(context, detail, title);
    } finally {
      tracker.overflowRetryInFlight = false;
    }
  };
  /**
   * The context window for one compaction-and-retry, or null when the error
   * is not an overflow, the window is unknown, or the retry was already used.
   */
  const overflowRetryWindowTokens = (isOverflow: boolean): number | null => {
    if (!isOverflow) return null;
    if (contextTokens == null) return null;
    if (hasTriedCompactionRetry(sessionId, turnId)) return null;
    return contextTokens;
  };
  const handleErrorState = (snapshot: AgentSnapshot, context: AgentContext): void => {
    if (snapshot.value !== 'error') return;
    const detail = context.error ?? 'Unknown error';
    const title = context.errorTitle ?? 'Stream Error';
    const isOverflow = isContextLengthExceededError(`${title} ${detail}`);
    const retryWindowTokens = overflowRetryWindowTokens(isOverflow);
    if (retryWindowTokens != null) {
      if (tracker.overflowRetryInFlight) return;
      markCompactionRetryTried(sessionId, turnId);
      tracker.overflowRetryInFlight = true;
      // One compaction-and-retry (R15). Compact the prefix (messages) and retry once before declaring failed.
      void runOverflowRetry(context, detail, title, retryWindowTokens);
      return;
    }
    if (tracker.overflowRetryInFlight) return;
    failTurn(context, detail, title);
  };

  const interruptSubscription = interruptActor.subscribe((interruptSnapshot) => {
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
    sendChatState(windowId, activeAgent, {
      state: String(actor.getSnapshot().value), error: context.error, interruptState, cwd,
    });
  });

  const subscription = actor.subscribe((snapshot) => {
    if (!canEmitStreamEvents(sessionId, activeAgent)) return;
    const context = snapshot.context as AgentContext;
    publishStreamActivity(snapshot, context);
    streamResponseChunk(context);
    streamThinkingChunk(context);
    emitChatState(snapshot, context);
    handleUsageEvent(context);
    handleStreamingToolCall(context);
    handleToolLifecycleUpdate(context);
    handleIdleState(snapshot, context);
    handleErrorState(snapshot, context);
  });

  return {
    unsubscribe: () => subscription.unsubscribe(),
    interruptUnsubscribe: () => interruptSubscription.unsubscribe(),
  };
}

/**
 * Pre-turn gate: claim the session's turn-start slot, hydrate its runtime,
 * and freeze the provider setup. Returns the turn's frozen start context, or
 * the structured gate failure for the send boundary.
 */
type TurnStartContext =
  | {
      ok: true;
      sessionId: string;
      cwd: string;
      session: Session;
      runtime: ProjectRuntime;
      turnSelection: ModelSelection;
      existingMessages: Message[];
      setup: TurnProviderSetup;
    }
  | { ok: false; result: ChatSendResult };

async function claimTurnStart(
  clientId: HostClientId,
  preferredModel: ChatSendPayload['model'],
  requestedSessionId: string | undefined,
  draftGeneration: number | undefined,
): Promise<TurnStartContext> {
  const windowId = clientId;
  const sessionGate = await Promise.resolve(
    ensureActiveSessionSingleFlight(clientId, preferredModel, requestedSessionId, draftGeneration),
  );
  if (!sessionGate.ok) return { ok: false, result: sessionGate.result };

  const sessionId = sessionGate.session.id;
  clearNextRequestStop(sessionId);
  clearCompactionPause(sessionId, MAIN_AGENT_SCOPE_ID);
  const busyError = await claimTurnStartSlot(sessionId);
  if (busyError) {
    return { ok: false, result: { status: 'error', error: busyError, kind: 'session_busy' } };
  }
  const existing = activeAgents.get(sessionId);
  const runtime = sessionGate.runtime;
  const hydrationError = await hydrateTurnRuntime(sessionId, runtime, windowId, sessionGate.cwd);
  if (hydrationError) {
    sessionsStarting.delete(sessionId);
    return { ok: false, result: {
      status: 'error',
      error: hydrationError,
      kind: 'runtime_hydration_failed',
    } };
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
    return { ok: false, result: {
      status: 'error',
      error: 'A provider connection and model are required before sending a message.',
      kind: 'provider_required',
    } };
  }

  let existingMessages: Message[];
  try {
    existingMessages = getChatHistory(sessionId) ?? historyFromSession(sessionId);
  } catch (error) {
    sessionsStarting.delete(sessionId);
    completeSessionActivity(sessionId, false);
    return { ok: false, result: {
      status: 'error',
      error: `Could not load complete conversation history: ${
        error instanceof Error ? error.message : String(error)
      }`,
      kind: 'history_load_failed',
    } };
  }

  const provider = await resolveTurnProviderSetup(sessionGate.session, turnSelection, sessionId);
  if (!provider.ok) {
    sessionsStarting.delete(sessionId);
    completeSessionActivity(sessionId, false);
    return { ok: false, result: { status: 'error', error: provider.error, kind: 'provider_unavailable' } };
  }
  return {
    ok: true,
    sessionId,
    cwd: sessionGate.cwd,
    session: sessionGate.session,
    runtime,
    turnSelection,
    existingMessages,
    setup: provider.setup,
  };
}

export async function startChatTurn(
  clientId: HostClientId,
  { message, model: preferredModel, sessionId: requestedSessionId, draftGeneration }: ChatSendPayload,
) {
  const windowId = clientId;
  const start = await claimTurnStart(clientId, preferredModel, requestedSessionId, draftGeneration);
  if (!start.ok) return start.result;
  const { session, sessionId, cwd, runtime, turnSelection, existingMessages } = start;
  const {
    modelInstance, providerSnapshot, providerOptions, pricingFacet, thinkingPolicy,
    cacheFacet, cacheTtl, cacheSessionKey, tierMechanism, accountingStore, contextTokens,
  } = start.setup;

  const agent = resolveTurnAgent(runtime);
  const userMessage = makeUserMessage(message);
  let messages: Message[] = [...existingMessages, userMessage];
  const thinkingReplay: ThinkingReplayContext = {
    policy: thinkingPolicy ?? DEFAULT_THINKING_POLICY,
    selection: { providerId: providerSnapshot.providerId, modelId: turnSelection.modelId },
    protocol: providerSnapshot.protocol as ProviderProtocol,
  };
  const sessionManager = getSessionManager();
  const turnCtx: ToolExecutionContext = {
    cwd, sessionId, windowId, projectRuntime: runtime,
    agentScopeId: 'main', selection: turnSelection,
  };
  let turnId: string = crypto.randomUUID();
  let chainId: string | null = null;

  const startTurnChain = (): void => {
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
      emitSessionUpdated(windowId, sessionId);
    } catch (error) {
      console.debug('startChain failed (non-fatal):', error);
    }
  };
  startTurnChain();

  messages = await applySendTimeCompaction(sessionId, messages, userMessage, {
    runtime, selection: turnSelection, contextTokens, accountingStore, chainId, turnId,
  });

  const abortController = new AbortController();
  const baseSystemPrompt = agent.system_prompt || 'You are a helpful assistant.';
  const seedRootAgentsMdContext = (): void => {
    try {
      const rootAgentsMdEntry = findRootAgentsMdEntry(runtime.projectDir, runtime.config);
      if (rootAgentsMdEntry) sessionManager.getAgentsMdContextStore(sessionId).seedRoot(rootAgentsMdEntry);
    } catch (error) {
      console.debug('seedRoot AGENTS.md context failed (non-fatal):', error);
    }
  };
  seedRootAgentsMdContext();
  const accounting: ProviderAttemptAccountingContext = {
    store: accountingStore, sessionId, chainId, turnId, snapshot: providerSnapshot,
    agentScope: 'main', agentName: agent.name, agentType: agent.type, agentTier: agent.tier,
   attemptIdHolder: { value: null }, pricingFacet, tierMechanism,
    debugCapture: runtime.config.debug_capture_requests,
  };
  const mcpManager = acquireProjectMCPManager(runtime);
  let resourcesReleased = false;
  const releaseResources = () => {
    if (resourcesReleased) return;
    resourcesReleased = true;
    releaseProjectMCPManager(runtime);
  };
  const createTurnActors = (): { actor: AgentActor; interruptActor: InterruptActor } => {
    const turnRegistry = getBuiltinToolRegistryForRuntime(runtime, {
      agents: new Map(runtime.agents), skills: new Map(runtime.skills), mcpManager,
    });
    const sharedRulesPrompt = appendSharedRules(baseSystemPrompt, runtime);
    const personalityPrompt = appendProjectPersonality(sharedRulesPrompt, runtime);
    let fullSystemPrompt = personalityPrompt;
    try {
      fullSystemPrompt = appendRootAgentsMd(personalityPrompt, runtime);
    } catch (error) {
      console.debug('root AGENTS.md injection failed (non-fatal):', error);
    }
    return {
      actor: createActor(agentMachine, {
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
      }),
      interruptActor: createActor(interruptMachine),
    };
  };
  let actor: AgentActor;
  let interruptActor: InterruptActor;
  try {
    ({ actor, interruptActor } = createTurnActors());
  } catch (error) {
    releaseResources();
    sessionsStarting.delete(sessionId);
    completeSessionActivity(sessionId, false);
    return {
      status: 'error', error: error instanceof Error ? error.message : String(error),
      kind: 'runtime_hydration_failed',
    };
  }

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
    streamSegments: [], unsubscribe: () => {},
    interruptUnsubscribe: () => {}, interruptResetTimer: null,
    sessionTitleTimer: null, runtime, chainId,
    releaseResources,
  };
  activeAgents.set(sessionId, activeAgent);
  sessionsStarting.delete(sessionId);
  // A live main-agent turn owns the Esc phases again; drop any staged
  // standalone subagent-cancel confirmation from a previously disposed turn.
  clearSubagentCancelConfirm(sessionId);

  // A long-running first turn must not leave the session unnamed forever:
  // after the configured wait, name from the current in-flight history even
  // while the agent keeps working. 0 disables the deadline.
  const armSessionTitleDeadline = (): void => {
    const titleWaitSeconds = runtime.config.session_title_max_wait_seconds;
    if (titleWaitSeconds <= 0) return;
    if (!session.name.startsWith('Session ')) return;
    const titleTimer = setTimeout(() => {
      activeAgent.sessionTitleTimer = null;
      if (!isCurrentAgent(sessionId, activeAgent)) return;
      if (activeAgent.finalized || activeAgent.agentCancelled) return;
      const current = sessionManager.getSession(sessionId);
      if (!current || !current.name.startsWith('Session ')) return;
      triggerSessionAutoName({
        sessionId,
        runtime,
        clientId: windowId,
        messages: currentTurnSnapshot(activeAgent, actor.getSnapshot().context as AgentContext),
        fallbackSelection: activeAgent.selection,
        accounting: { store: accountingStore, sessionId, chainId, turnId },
      });
    }, Math.round(titleWaitSeconds * 1000));
    activeAgent.sessionTitleTimer = titleTimer;
  };
  armSessionTitleDeadline();

  const projection = wireTurnProjection({
    sessionId, windowId, cwd: turnCtx.cwd, activeAgent, actor, interruptActor, runtime, agent,
    selection: turnSelection, accountingStore, chainId, turnId, contextTokens,
    userMessage, message, messages,
  });
  activeAgent.unsubscribe = projection.unsubscribe;
  activeAgent.interruptUnsubscribe = projection.interruptUnsubscribe;

  try {
    actor.start();
    interruptActor.start();
    sendChatState(windowId, activeAgent, {
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
