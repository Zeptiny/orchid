/**
 * Turn-scoped implementation behind the chat:send IPC boundary.
 *
 * `chat.ts` validates the untrusted payload and delegates here. Keeping the
 * actor lifecycle in this module prevents IPC registration from also owning
 * projection, persistence, and resource cleanup policies.
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
import { getSessionManager } from '../../session/singleton';
import { getBuiltinToolRegistryForRuntime } from '../../tools';
import type { ToolExecutionContext } from '../../tools/types';
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
import { getChatHistory } from '../chat-history';
import { chatSendSchema } from '../payload-schemas';
import { clearNextRequestStop } from '../next-request-stop';
import { completeSessionActivity, publishSessionActivity } from '../session-activity';
import { disposeActiveAgent, forceAbortSession } from './abort';
import { emitSessionUpdated, sendChatState, sendSessionEvent, sendTurnEvent } from './events';
import {
  activeAgents,
  canEmitStreamEvents,
  isCurrentAgent,
  nextAgentGeneration,
  sessionsStarting,
  type ActiveAgent,
} from './state';
import {
  attachUsageToLatestAssistant,
  checkpointActiveTurn,
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
import { createGenerateTitleCallback } from './title';

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
  if (sessionsStarting.has(sessionId)) {
    return { status: 'error', error: 'A turn is already starting for this session.', kind: 'session_busy' };
  }
  sessionsStarting.add(sessionId);
  const existing = activeAgents.get(sessionId);
  const runtime = sessionGate.runtime;
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

  let modelInstance: LanguageModelV4;
  let providerSnapshot: ProviderAttemptAccountingContext['snapshot'];
  let providerOptions: ReasoningProviderOptions | undefined;
  let accountingStore: ReturnType<typeof getProviderAccountingStore>;
  try {
    accountingStore = getProviderAccountingStore();
    const execution = await getProviderRuntime().resolveExecution(turnSelection);
    modelInstance = execution.modelInstance;
    providerSnapshot = execution.snapshot;
    const effort = resolveMainAgentEffort(
      sessionGate.session, execution.connection, turnSelection.modelId,
      execution.model.capabilities?.reasoning === true,
    );
    providerOptions = effort === undefined ? undefined : execution.buildReasoningOptions?.(effort);
  } catch (error) {
    sessionsStarting.delete(sessionId);
    completeSessionActivity(sessionId, false);
    return {
      status: 'error', error: error instanceof Error ? error.message : String(error),
      kind: 'provider_unavailable',
    };
  }

  const agents = [...runtime.agents.values()];
  const existingMessages: Message[] = getChatHistory(sessionId) ?? historyFromSession(sessionId);
  const userMessage = makeUserMessage(message);
  const priorMessageCount = existingMessages.length;
  const messages = [...existingMessages, userMessage];
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
   attemptIdHolder: { value: null },
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
          mcpManager, providerOptions,
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
  let subscription: { unsubscribe: () => void } | null = null;
  let interruptSubscription: { unsubscribe: () => void } | null = null;
  let lastUsage: Usage | null = null;
  let interruptResetTimer: ReturnType<typeof setTimeout> | null = null;
  let lastStreamingToolCallId: string | null = null;
  const lastStreamingToolArgLength = new Map<string, number>();
  let lastToolUpdateSequence = 0;
  let lastActivityKey = 'streaming:agent:Generating response';
  const generation = nextAgentGeneration(sessionId);
  const activeAgent: ActiveAgent = {
    sessionId, windowId, turnId, cwd: turnCtx.cwd, startedAt: Date.now(), actor, interruptActor,
    abortController, messages, priorMessageCount, turnMessages: [], responseCommittedLength: 0,
    thinkingCommittedLength: 0, agent, selection: turnSelection, agentCancelled: false,
    finalized: false, generation, eventSequence: 0, lastChatState: null, toolCalls: new Map(),
    streamSegments: [], unsubscribe: () => subscription?.unsubscribe(),
    interruptUnsubscribe: () => interruptSubscription?.unsubscribe(), interruptResetTimer: null,
    releaseResources,
  };
  activeAgents.set(sessionId, activeAgent);
  sessionsStarting.delete(sessionId);

  const flushResponseSegment = (fullResponse: string, attachUsage: Usage | null = null) => {
    if (fullResponse.length <= activeAgent.responseCommittedLength) return;
    const segment = fullResponse.slice(activeAgent.responseCommittedLength);
    const segmentId = textSegmentIdAtOffset(activeAgent, 'text', activeAgent.responseCommittedLength);
    activeAgent.responseCommittedLength = fullResponse.length;
    if (!segment.trim() && !attachUsage) return;
    activeAgent.turnMessages.push(makeAssistantMessage(segment, attachUsage, segmentId));
  };
  const flushThinkingSegment = (fullThinking: string) => {
    if (fullThinking.length <= activeAgent.thinkingCommittedLength) return;
    const segment = fullThinking.slice(activeAgent.thinkingCommittedLength);
    const segmentId = textSegmentIdAtOffset(activeAgent, 'thinking', activeAgent.thinkingCommittedLength);
    activeAgent.thinkingCommittedLength = fullThinking.length;
    if (!segment.trim()) return;
    activeAgent.turnMessages.push(makeThinkingMessage(segment, segmentId));
  };
  const finalizeTurn = (opts: { response: string; usage: Usage | null; interrupted: boolean; sendDone: boolean }) => {
    if (activeAgent.finalized) return;
    activeAgent.finalized = true;
    completed = true;
    flushThinkingSegment((activeAgent.actor.getSnapshot().context as AgentContext).thinking ?? '');
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
    const fullHistory = [...messages, ...turnExtras];
    persistTurnConversation(
      sessionId, fullHistory, turnMessagesFromAgent(activeAgent),
      opts.interrupted ? ChainStatus.INTERRUPTED : ChainStatus.COMPLETED,
      agent, activeAgent.selection, webContents,
    );
    activeAgent.messages = fullHistory;
    completeSessionActivity(sessionId, getSessionManager().getActive(windowId)?.id !== sessionId);
    if (opts.sendDone) {
      sendTurnEvent(webContents, activeAgent, IPC_CHANNELS.CHAT_DONE, {
        type: 'done', response: opts.response, messages: fullHistory,
        interrupted: opts.interrupted, usage: opts.usage,
      });
    }
    if (!opts.interrupted) {
      const generateTitle = createGenerateTitleCallback({
        runtime, messages: fullHistory, fallbackSelection: activeAgent.selection,
        accounting: { store: accountingStore, sessionId, chainId, turnId },
      });
      sessionManager.autoName(sessionId, generateTitle).then((updated) => {
        if (updated) sendSessionEvent(webContents, sessionId, IPC_CHANNELS.SESSION_RENAMED, {
          id: updated.id, name: updated.name,
        });
      }).catch((error) => console.warn('Auto-naming failed (non-fatal):', error));
    }
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
          flushThinkingSegment(context.thinking ?? '');
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
          flushThinkingSegment(context.thinking ?? '');
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
    if (snapshot.value === 'idle' && context.currentInput && !completed && !activeAgent.agentCancelled) {
      finalizeTurn({ response: context.response, usage: context.usage ?? null, interrupted: false, sendDone: true });
      queueMicrotask(() => disposeActiveAgent(sessionId, activeAgent));
    }
    if (snapshot.value === 'error') {
      completed = true;
      activeAgent.finalized = true;
      const detail = context.error ?? 'Unknown error';
      const title = context.errorTitle ?? 'Stream Error';
      publishSessionActivity(sessionId, {
        cwd: turnCtx.cwd, state: 'needs_attention', phase: 'agent', detail: title || detail, canCancel: false,
      });
      flushPartialTurnContent(activeAgent, context);
      const fullHistory = [...messages, ...activeAgent.turnMessages];
      persistTurnConversation(
        sessionId, fullHistory, turnMessagesFromAgent(activeAgent), ChainStatus.FAILED,
        agent, activeAgent.selection, webContents,
      );
      activeAgent.messages = fullHistory;
      sendTurnEvent(webContents, activeAgent, IPC_CHANNELS.CHAT_ERROR, {
        type: 'error', error: detail, messages: fullHistory, title, kind: classifyErrorKind(title, detail),
      });
      queueMicrotask(() => disposeActiveAgent(sessionId, activeAgent));
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
