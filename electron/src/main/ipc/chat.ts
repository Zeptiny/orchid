/**
 * Chat IPC handlers — chat:send, chat:cancel.
 *
 * Uses the orchestrator from U9 and XState agent machine from U10.
 * Streams responses back to the renderer via webContents.send.
 *
 * The chat handler manages an active agent actor per session and
 * forwards StreamEvents as IPC events to the renderer.
 */
import { ipcMain, type WebContents } from 'electron';
import type { ReasoningProviderOptions } from '../providers/drivers/types';
import { createActor } from 'xstate';
import { z } from 'zod';
import { agentMachine, type AgentContext } from '../agents/xstate/agent-machine';
import { interruptMachine } from '../agents/xstate/interrupt-machine';
import { resolveMainAgentEffort } from '../llm/reasoning-effort';
import { IPC_CHANNELS, type ChatSessionSnapshot } from '../../shared/types/ipc';
import { MessageType } from '../../shared/types/message';
import type { Message, Usage } from '../../shared/types/message';
import { ChainStatus } from '../../shared/types/chain';
import { flattenSessionMessages } from '../../shared/types/session';
import { getSessionManager } from '../session/singleton';
import { getBackgroundStore } from '../tools/process/background-store';
import { getBuiltinToolRegistryForRuntime, getSubagentManager } from '../tools';
import { clearAllChatHistory, getChatHistory } from './chat-history';
import {
  makeAssistantMessage,
  makeThinkingMessage,
  makeToolCallMessage,
  makeToolResultMessage,
  makeUserMessage,
} from '../llm/message-factories';
import type { ToolExecutionContext } from '../tools/types';
import {
  completeSessionActivity,
  publishSessionActivity,
} from './session-activity';
import { appendProjectPersonality } from '../project/personality';
import { appendRootAgentsMd, findRootAgentsMdEntry } from '../project/agents-md';
import {
  acquireProjectMCPManager,
  releaseProjectMCPManager,
} from '../mcp/project-registry';
import { getProviderRuntime } from '../providers';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import { getProviderAccountingStore } from '../providers/accounting/store';
import type { ProviderAttemptAccountingContext } from '../providers/accounting/middleware';
import {
  chatCancelSchema,
  chatQueueNextSchema,
  chatSendSchema,
  chatSnapshotSchema,
  chatStopSchema,
} from './payload-schemas';
import {
  clearNextRequestStop,
  requestNextRequestStop,
} from './next-request-stop';
import {
  activeAgents,
  agentGenerations,
  canEmitStreamEvents,
  draftEnsureByWindow,
  isCurrentAgent,
  nextAgentGeneration,
  sessionsStarting,
  type ActiveAgent,
} from './chat/state';
import {
  emitSessionUpdated,
  sendSessionEvent,
  sendChatState,
  sendTurnEvent,
  webContentsForWindowId,
} from './chat/events';
import {
  appendTextSegment,
  ensureToolSnapshot,
  snapshotForAgent,
  textSegmentIdAtOffset,
  updateToolSnapshot,
} from './chat/snapshot';
import {
  appendLiveTailMessages,
  attachUsageToLatestAssistant,
  checkpointActiveTurn,
  flushPartialTurnContent,
  historyFromSession,
  persistTurnConversation,
  turnMessagesFromAgent,
} from './chat/persist';
import {
  disposeActiveAgent,
  forceAbortSession,
  forceStopSession,
} from './chat/abort';
import { ensureActiveSessionSingleFlight } from './chat/session';
import { classifyErrorKind, createProviderStreamFn } from './chat/stream';
import { createGenerateTitleCallback } from './chat/title';

export { getActiveMainTurnWindowId, getLiveChatSnapshot } from './chat/snapshot';
export {
  activeSessionsForProviderConnection,
  forceAbortChat,
  forceAbortMainTurn,
  stopActiveProviderConnectionTurns,
} from './chat/abort';
export type { ForceAbortMainTurnOptions } from './chat/abort';
export { ensureActiveSession } from './chat/session';
export { forceAbortSession, forceStopSession, webContentsForWindowId };

/** Upper bound for bgcmd:snapshot lastN (prevents unbounded payload reads). */
const BG_CMD_SNAPSHOT_MAX_LAST_N = 1000;

const bgCommandSnapshotSchema = z.object({
  commandId: z.number().int().positive(),
  lastN: z.number().int().positive().max(BG_CMD_SNAPSHOT_MAX_LAST_N).optional(),
  /** Owning session; when omitted, resolved from the calling window's active session. */
  sessionId: z.string().uuid().optional(),
});

// ── IPC registration ─────────────────────────────────────────────────────────

export function registerChatIPC(): void {
  // chat:send — start a new agent conversation turn
  ipcMain.handle(IPC_CHANNELS.CHAT_SEND, async (event, payload: unknown) => {
    const webContents: WebContents = event.sender;

    // Validate input with zod
    const parsed = chatSendSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid chat:send payload: ${parsed.error.message}`);
    }

    const {
      message,
      model: preferredModel,
      sessionId: requestedSessionId,
    } = parsed.data;

    // Cancel any existing actor for this window
    const windowId = String(webContents.id);
    // Lazy session create + workspace gate (R2/R3): require valid workspace;
    // create with that cwd; if unbound, fail without streaming.
    // Resolves the session and captures its project runtime before actor setup.
    // Draft first-send uses window single-flight so concurrent sends do not
    // create duplicate sessions.
    const sessionGate = await Promise.resolve(
      ensureActiveSessionSingleFlight(
        webContents,
        preferredModel,
        requestedSessionId,
        parsed.data.draftGeneration,
      ),
    );
    if (!sessionGate.ok) {
      return sessionGate.result;
    }
    const sessionId = sessionGate.session.id;
    // Reset any stale early-stop signal so this turn (e.g. an auto-fired
    // next-request chain) is not stopped at its first step boundary.
    clearNextRequestStop(sessionId);
    if (sessionsStarting.has(sessionId)) {
      return {
        status: 'error',
        error: 'A turn is already starting for this session.',
        kind: 'session_busy',
      };
    }
    sessionsStarting.add(sessionId);
    const existing = activeAgents.get(sessionId);

    // Freeze all project-bound definitions for the turn. Other windows may
    // navigate to different projects while this actor is still streaming.
    const runtime = sessionGate.runtime;
    if (existing) {
      forceAbortSession(sessionId);
    }
    publishSessionActivity(sessionId, {
      cwd: sessionGate.cwd,
      state: 'working',
      phase: 'agent',
      detail: 'Generating response',
      startedAt: Date.now(),
      completedAt: null,
      unread: false,
      canCancel: true,
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
        sessionGate.session,
        execution.connection,
        turnSelection.modelId,
        execution.model.capabilities?.reasoning === true,
      );
      providerOptions =
        effort === undefined ? undefined : execution.buildReasoningOptions?.(effort);
    } catch (error) {
      sessionsStarting.delete(sessionId);
      completeSessionActivity(sessionId, false);
      return {
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        kind: 'provider_unavailable',
      };
    }
    const agents = [...runtime.agents.values()];
    // Prefer live window history; fall back to flattened session chains.
    // If a prior agent is still streaming, forceAbort persists its partial
    // turn as INTERRUPTED (turn-local) before we open a new chain — never
    // dispose without persist (multi-chain orphan user-only INTERRUPTED).
    const existingMessages: Message[] =
      getChatHistory(sessionId) ?? historyFromSession(sessionId);

    // Build message history: existing messages + new user message
    const userMessage = makeUserMessage(message);
    const priorMessageCount = existingMessages.length;
    const messages = [...existingMessages, userMessage];

    // Get or create agent (default to "general" agent)
    const agent = agents.find((a) => a.name === 'general') ?? agents[0] ?? {
      name: 'general',
      type: 'subagent' as const,
      tier: 'bloom' as const,
      description: 'General-purpose agent',
      system_prompt: 'You are a helpful assistant.',
      allowed_tools: ['*'],
      allowed_skills: ['*'],
    };

    // Freeze turn tool/prompt context + model at send time (R6): mid-turn
    // session switch must not rebind tools, model, or working_directory.
    const sessionManager = getSessionManager();
    const turnCtx: ToolExecutionContext = {
      cwd: sessionGate.cwd,
      sessionId,
      windowId,
      projectRuntime: runtime,
      agentScopeId: 'main',
      selection: turnSelection,
    };

    // Multi-chain: open a new ACTIVE chain for this user turn (Python `_start_chain`).
    // Subagent parent_chain_index attributes to this chain while it is active.
    let turnId: string = crypto.randomUUID();
    let chainId: string | null = null;
    try {
      const chain = sessionManager.startChain({
        selection: turnSelection,
        modelLabel: turnSelection.modelId,
        agentName: agent.name,
        agentType: agent.type,
        agentTier: agent.tier,
        messages: [userMessage],
      }, sessionId);
      chainId = chain?.id ?? null;
      turnId = chain?.id ?? turnId;
      emitSessionUpdated(webContents, sessionId);
    } catch (err) {
      console.debug('startChain failed (non-fatal):', err);
    }

    // Create the agent actor with message history.
    // Personality is read from the captured project snapshot, never the
    // mutable global registry used by the settings surface.
    const abortController = new AbortController();
    const baseSystemPrompt = agent.system_prompt || 'You are a helpful assistant.';

    // Seed the per-session tracker with the root instruction file (R13) so the
    // nested read-path mechanism never re-injects it (R4). Main agent scope →
    // omit agentScopeId (it normalizes to main). Non-fatal: a seeding failure
    // must never break the turn.
    try {
      const rootAgentsMdEntry = findRootAgentsMdEntry(runtime.projectDir, runtime.config);
      if (rootAgentsMdEntry) {
        sessionManager.getAgentsMdContextStore(sessionId).seedRoot(rootAgentsMdEntry);
      }
    } catch (err) {
      console.debug('seedRoot AGENTS.md context failed (non-fatal):', err);
    }
    const accounting: ProviderAttemptAccountingContext = {
      store: accountingStore,
      sessionId,
      chainId,
      turnId,
      snapshot: providerSnapshot,
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
        agents: new Map(runtime.agents),
        skills: new Map(runtime.skills),
        mcpManager,
      });
      // Root AGENTS.md injection is non-fatal: an fs/config failure falls back
      // to the un-augmented prompt rather than failing the whole turn (the
      // adjacent tracker seeding is already non-fatal).
      const personalityPrompt = appendProjectPersonality(baseSystemPrompt, runtime);
      let fullSystemPrompt = personalityPrompt;
      try {
        fullSystemPrompt = appendRootAgentsMd(personalityPrompt, runtime);
      } catch (err) {
        console.debug('root AGENTS.md injection failed (non-fatal):', err);
      }
      actor = createActor(agentMachine, {
        input: {
          agent,
          systemPrompt: fullSystemPrompt,
          streamFn: createProviderStreamFn({
            messages,
            runtime,
            sessionId,
            windowId,
            modelInstance,
            accounting,
            registry: turnRegistry,
            mcpManager,
            providerOptions,
          }),
        },
      });
      interruptActor = createActor(interruptMachine);
    } catch (error) {
      releaseResources();
      sessionsStarting.delete(sessionId);
      completeSessionActivity(sessionId, false);
      return {
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        kind: 'runtime_hydration_failed',
      };
    }

    // Track response for incremental updates
    let lastSentLength = 0;
    let lastThinkingLength = 0;
    let completed = false;
    let subscription: { unsubscribe: () => void } | null = null;
    let interruptSubscription: { unsubscribe: () => void } | null = null;
    let lastUsage: import('../../shared/types/message').Usage | null = null;
    let interruptResetTimer: ReturnType<typeof setTimeout> | null = null;
    let lastStreamingToolCallId: string | null = null;
    const lastStreamingToolArgLength = new Map<string, number>();
    let lastToolUpdateSequence = 0;
    let lastActivityKey = 'streaming:agent:Generating response';
    const generation = nextAgentGeneration(sessionId);
    const activeAgent: ActiveAgent = {
      sessionId,
      windowId,
      turnId,
      cwd: turnCtx.cwd,
      startedAt: Date.now(),
      actor,
      interruptActor,
      abortController,
      messages,
      priorMessageCount,
      turnMessages: [],
      // How much of context.response has already been snapshotted into turnMessages
      // as intermediate assistant text (so tools can interleave: text → tool → text).
      responseCommittedLength: 0,
      thinkingCommittedLength: 0,
      agent,
      selection: turnSelection,
      agentCancelled: false,
      finalized: false,
      generation,
      eventSequence: 0,
      lastChatState: null,
      toolCalls: new Map(),
      streamSegments: [],
      unsubscribe: () => subscription?.unsubscribe(),
      interruptUnsubscribe: () => interruptSubscription?.unsubscribe(),
      interruptResetTimer: null,
      releaseResources,
    };
    activeAgents.set(sessionId, activeAgent);
    sessionsStarting.delete(sessionId);

    /** Snapshot any response text that arrived before the next tool into turnMessages. */
    const flushResponseSegment = (fullResponse: string, attachUsage: Usage | null = null) => {
      if (fullResponse.length <= activeAgent.responseCommittedLength) return;
      const segment = fullResponse.slice(activeAgent.responseCommittedLength);
      const segmentId = textSegmentIdAtOffset(
        activeAgent,
        'text',
        activeAgent.responseCommittedLength,
      );
      activeAgent.responseCommittedLength = fullResponse.length;
      if (!segment.trim() && !attachUsage) return;
      activeAgent.turnMessages.push(makeAssistantMessage(segment, attachUsage, segmentId));
    };

    /** Snapshot reasoning/thinking text into turnMessages (before tools / final text). */
    const flushThinkingSegment = (fullThinking: string) => {
      if (fullThinking.length <= activeAgent.thinkingCommittedLength) return;
      const segment = fullThinking.slice(activeAgent.thinkingCommittedLength);
      const segmentId = textSegmentIdAtOffset(
        activeAgent,
        'thinking',
        activeAgent.thinkingCommittedLength,
      );
      activeAgent.thinkingCommittedLength = fullThinking.length;
      if (!segment.trim()) return;
      activeAgent.turnMessages.push(makeThinkingMessage(segment, segmentId));
    };

    const finalizeTurn = (opts: {
      response: string;
      usage: Usage | null;
      interrupted: boolean;
      sendDone: boolean;
    }) => {
      if (activeAgent.finalized) return;
      activeAgent.finalized = true;
      completed = true;

      // Flush any remaining thinking before the final assistant bubble.
      const ctxThinking =
        (activeAgent.actor.getSnapshot().context as AgentContext).thinking ?? '';
      flushThinkingSegment(ctxThinking);

      // Remaining text after the last tool (or the whole response if no tools).
      const remaining = opts.response.slice(activeAgent.responseCommittedLength);
      if (remaining || (opts.interrupted && activeAgent.responseCommittedLength === 0 && !opts.response)) {
        // Attach usage to the final assistant bubble when present.
        if (remaining || opts.interrupted) {
          activeAgent.turnMessages.push(
            makeAssistantMessage(
              remaining || opts.response || '',
              opts.usage,
              textSegmentIdAtOffset(
                activeAgent,
                'text',
                activeAgent.responseCommittedLength,
              ),
            ),
          );
          activeAgent.responseCommittedLength = opts.response.length;
        }
      } else if (opts.usage) {
        // No remaining text — attach usage to prior text, or persist a hidden carrier.
        if (!attachUsageToLatestAssistant(activeAgent.turnMessages, opts.usage)) {
          activeAgent.turnMessages.push({
            ...makeAssistantMessage('', opts.usage),
            hidden: true,
          });
        }
      }

      const turnExtras = [...activeAgent.turnMessages];
      const fullHistory = [...messages, ...turnExtras];
      persistTurnConversation(
        sessionId,
        fullHistory,
        turnMessagesFromAgent(activeAgent),
        opts.interrupted ? ChainStatus.INTERRUPTED : ChainStatus.COMPLETED,
        agent,
        activeAgent.selection,
        webContents,
      );
      activeAgent.messages = fullHistory;
      completeSessionActivity(
        sessionId,
        getSessionManager().getActive(windowId)?.id !== sessionId,
      );

      if (opts.sendDone) {
        sendTurnEvent(webContents, activeAgent, IPC_CHANNELS.CHAT_DONE, {
          type: 'done',
          response: opts.response,
          interrupted: opts.interrupted,
          usage: opts.usage,
        });
      }

      if (!opts.interrupted) {
        // Auto-name after first successful exchange (non-blocking)
        const sessionManager = getSessionManager();
        const generateTitle = createGenerateTitleCallback({
          runtime,
          messages: fullHistory,
          fallbackSelection: activeAgent.selection,
          accounting: {
            store: accountingStore,
            sessionId,
            chainId,
            turnId,
          },
        });
        sessionManager
          .autoName(sessionId, generateTitle)
          .then((updated) => {
            if (updated) {
              sendSessionEvent(webContents, sessionId, IPC_CHANNELS.SESSION_RENAMED, {
                id: updated.id,
                name: updated.name,
              });
            }
          })
          .catch((err) => {
            console.warn('Auto-naming failed (non-fatal):', err);
          });
      }
    };

    // Track interrupt machine state changes and forward to renderer
    interruptSubscription = interruptActor.subscribe((interruptSnapshot) => {
      // Drop events from replaced/aborted agents (session switch, newer turn).
      if (!isCurrentAgent(sessionId, activeAgent)) {
        return;
      }

      const interruptState = interruptSnapshot.value as
        | 'idle'
        | 'confirmAgent'
        | 'confirmSubagents';

      // Clear any existing auto-reset timer
      if (interruptResetTimer) {
        clearTimeout(interruptResetTimer);
        interruptResetTimer = null;
        activeAgent.interruptResetTimer = null;
      }

      // Auto-reset interrupt to idle after 5s (matching Python timeout)
      if (interruptState !== 'idle') {
        interruptResetTimer = setTimeout(() => {
          interruptActor.send({ type: 'INTERRUPT_TIMEOUT' });
        }, 5000);
        activeAgent.interruptResetTimer = interruptResetTimer;
      } else if (activeAgent.agentCancelled) {
        // Interrupt TIMEOUT after Esc2 (main cancelled): dispose the main
        // agent but let subagents keep running — the user did not confirm
        // Esc3, so subagent cancellation was not requested.
        queueMicrotask(() => {
          if (activeAgents.get(sessionId) === activeAgent) {
            disposeActiveAgent(sessionId, activeAgent);
          }
        });
      }

      // Re-send CHAT_STATE with updated interrupt state
      const context = actor.getSnapshot().context as AgentContext;
      sendChatState(webContents, activeAgent, {
        state: String(actor.getSnapshot().value),
        error: context.error,
        interruptState,
        cwd: turnCtx.cwd,
      });
    });

    // Subscribe to state changes and stream chunks to renderer
    subscription = actor.subscribe((snapshot) => {
      // Drop late events from cancelled, finalized, or generation-stale agents so
      // CHAT_CHUNK cannot leak across session switches / overlapping turns.
      if (!canEmitStreamEvents(sessionId, activeAgent)) {
        return;
      }

      const context = snapshot.context as AgentContext;
      const activityPhase = 'agent' as const;
      const activityDetail = context.streamingToolCall?.toolName
        ? `Preparing ${context.streamingToolCall.toolName}`
        : 'Generating response';
      const activityKey = `${String(snapshot.value)}:${activityPhase}:${activityDetail}`;
      if (activityKey !== lastActivityKey) {
        lastActivityKey = activityKey;
        publishSessionActivity(sessionId, {
          cwd: turnCtx.cwd,
          state: 'working',
          phase: activityPhase,
          detail: activityDetail,
          canCancel: true,
        });
      }

      // Send incremental text updates
      if (context.response.length > lastSentLength) {
        const newContent = context.response.slice(lastSentLength);
        lastSentLength = context.response.length;
        const segmentId = appendTextSegment(activeAgent, 'text', newContent);
        sendTurnEvent(webContents, activeAgent, IPC_CHANNELS.CHAT_CHUNK, {
            type: 'chunk',
            data: newContent,
            segmentId,
        });
      }

      // Send incremental reasoning/thinking updates → Thought widgets
      const thinking = context.thinking ?? '';
      if (thinking.length > lastThinkingLength) {
        const newThinking = thinking.slice(lastThinkingLength);
        lastThinkingLength = thinking.length;
        const segmentId = appendTextSegment(activeAgent, 'thinking', newThinking);
        sendTurnEvent(webContents, activeAgent, IPC_CHANNELS.CHAT_THINKING, {
            type: 'thinking',
            data: newThinking,
            segmentId,
        });
      }

      // Send state transitions (includes interrupt machine state)
      const interruptState = interruptActor.getSnapshot().value as
        | 'idle'
        | 'confirmAgent'
        | 'confirmSubagents';
      sendChatState(webContents, activeAgent, {
        state: String(snapshot.value),
        error: context.error,
        interruptState,
        cwd: turnCtx.cwd,
      });

      // Forward usage data to renderer when it changes
      if (context.usage && context.usage !== lastUsage) {
        lastUsage = context.usage;
        sendTurnEvent(webContents, activeAgent, IPC_CHANNELS.CHAT_USAGE, {
            type: 'usage',
            usage: context.usage,
        });
        checkpointActiveTurn(activeAgent, context);
      }

      // Forward tool call streaming events to renderer
      if (context.streamingToolCall) {
        const stc = context.streamingToolCall;
        if (stc.toolCallId !== lastStreamingToolCallId) {
          // New tool call started streaming
          lastStreamingToolCallId = stc.toolCallId;
          lastStreamingToolArgLength.set(stc.toolCallId, 0);
          ensureToolSnapshot(activeAgent, stc.toolCallId, stc.toolName);
          sendTurnEvent(webContents, activeAgent, IPC_CHANNELS.CHAT_TOOL_CALL_START, {
              type: 'tool_call_start',
              toolCallId: stc.toolCallId,
              toolName: stc.toolName,
          });
        }
        // Send only the new delta. The machine stores accumulated args.
        const previousLength = lastStreamingToolArgLength.get(stc.toolCallId) ?? 0;
        const argsDelta = stc.partialArgs.slice(previousLength);
        if (argsDelta) {
          lastStreamingToolArgLength.set(stc.toolCallId, stc.partialArgs.length);
          const current = ensureToolSnapshot(activeAgent, stc.toolCallId, stc.toolName);
          updateToolSnapshot(activeAgent, stc.toolCallId, stc.toolName, {
            partialArgs: current.partialArgs + argsDelta,
          });
          sendTurnEvent(webContents, activeAgent, IPC_CHANNELS.CHAT_TOOL_CALL_DELTA, {
            type: 'tool_call_delta',
            toolCallId: stc.toolCallId,
            argsDelta,
          });
        }
      } else if (lastStreamingToolCallId) {
        // Tool call streaming ended (transitioned to executing or completed)
        lastStreamingToolCallId = null;
      }

      // Forward tool lifecycle status updates to renderer + persist tool messages
      if (
        context.toolLifecycleUpdate &&
        context.toolLifecycleUpdate.sequence !== lastToolUpdateSequence
      ) {
        const update = context.toolLifecycleUpdate;
        lastToolUpdateSequence = update.sequence;

        updateToolSnapshot(activeAgent, update.toolCallId, update.toolName ?? 'unknown', {
          toolName: update.toolName ?? 'unknown',
          status: update.status,
          args: update.args ?? '',
          content: update.content ?? null,
          toolResult: update.toolResult ?? null,
          finishedAt: update.status === 'running' ? null : new Date().toISOString(),
        });
        sendTurnEvent(webContents, activeAgent, IPC_CHANNELS.CHAT_TOOL_CALL_UPDATE, {
          type: 'tool_call_update',
          toolCallId: update.toolCallId,
          toolName: update.toolName,
            status: update.status,
            args: update.args,
            content: update.content,
            toolResult: update.toolResult,
        });

        // Record tool call/result messages once per lifecycle event.
        // Flush any assistant text that streamed *before* this tool so history
        // stays chronological: text → tool → text → tool → …
        if (update.status === 'running' && update.args != null) {
          const already = activeAgent.turnMessages.some(
            (m) =>
              m.type === MessageType.TOOL_CALL &&
              m.tool_call_id === update.toolCallId,
          );
          if (!already) {
            flushThinkingSegment(context.thinking ?? '');
            flushResponseSegment(context.response);
            activeAgent.turnMessages.push(
              makeToolCallMessage(
                update.toolCallId,
                update.toolName ?? 'unknown',
                update.args,
              ),
            );
          }
        }

        if (update.status !== 'running') {
          // Ensure tool-call message exists (fallback path without streaming start)
          const hasCall = activeAgent.turnMessages.some(
            (m) =>
              m.type === MessageType.TOOL_CALL &&
              m.tool_call_id === update.toolCallId,
          );
          if (!hasCall) {
            flushThinkingSegment(context.thinking ?? '');
            flushResponseSegment(context.response);
            activeAgent.turnMessages.push(
              makeToolCallMessage(
                update.toolCallId,
                update.toolName ?? 'unknown',
                update.args ?? '{}',
              ),
            );
          }

          const hasResult = activeAgent.turnMessages.some(
            (m) =>
              m.type === MessageType.TOOL_RESULT &&
              m.tool_call_id === update.toolCallId,
          );
          if (!hasResult) {
            const toolResultMsg = makeToolResultMessage(
              update.toolCallId,
              update.toolName ?? 'unknown',
              update.content ?? '',
              update.toolResult!,
            );
            activeAgent.turnMessages.push(
              update.toolResult?.status === 'cancelled'
                ? { ...toolResultMsg, excludeFromModel: true }
                : toolResultMsg,
            );
          }
        }
      }

      // Clean up on successful terminal idle
      if (
        snapshot.value === 'idle' &&
        context.currentInput &&
        !completed &&
        !activeAgent.agentCancelled
      ) {
        finalizeTurn({
          response: context.response,
          usage: context.usage ?? null,
          interrupted: false,
          sendDone: true,
        });
        queueMicrotask(() => {
          disposeActiveAgent(sessionId, activeAgent);
        });
      }

      if (snapshot.value === 'error') {
        completed = true;
        activeAgent.finalized = true;
        const detail = context.error ?? 'Unknown error';
        const title = context.errorTitle ?? 'Stream Error';
        sendTurnEvent(webContents, activeAgent, IPC_CHANNELS.CHAT_ERROR, {
          type: 'error',
          error: detail,
          title,
          kind: classifyErrorKind(title, detail),
        });
        publishSessionActivity(sessionId, {
          cwd: turnCtx.cwd,
          state: 'needs_attention',
          phase: 'agent',
          detail: title || detail,
          canCancel: false,
        });
        // Persist turn so far: only uncommitted assistant text (same as cancel/finalize).
        flushPartialTurnContent(activeAgent, context);
        const fullHistory = [...messages, ...activeAgent.turnMessages];
        persistTurnConversation(
          sessionId,
          fullHistory,
          turnMessagesFromAgent(activeAgent),
          ChainStatus.FAILED,
          agent,
          activeAgent.selection,
          webContents,
        );
        queueMicrotask(() => {
          disposeActiveAgent(sessionId, activeAgent);
        });
      }
    });

    try {
      // Start the actor and send user input
      actor.start();
      interruptActor.start();

      // Immediate state so the renderer gets cwd/model chrome before first chunk
      sendChatState(webContents, activeAgent, {
        state: 'streaming',
        error: null,
        interruptState: 'idle',
        cwd: turnCtx.cwd,
      });

      actor.send({ type: 'USER_INPUT', message });
    } catch (error) {
      disposeActiveAgent(sessionId, activeAgent);
      completeSessionActivity(sessionId, false);
      return {
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        kind: 'runtime_hydration_failed',
      };
    }

    return { status: 'started', sessionId, turnId };
  });

  // chat:snapshot — atomically hydrate a renderer that returns to a running session.
  // This is deliberately read-only: it never changes the sender window's selection.
  ipcMain.handle(
    IPC_CHANNELS.CHAT_SNAPSHOT,
    async (event, payload: unknown): Promise<ChatSessionSnapshot | null> => {
      const parsed = chatSnapshotSchema.safeParse(payload ?? {});
      if (!parsed.success) {
        throw new Error(`Invalid chat:snapshot payload: ${parsed.error.message}`);
      }
      const windowId = String(event.sender.id);
      const sessionId =
        parsed.data.sessionId ?? getSessionManager().getActive(windowId)?.id;
      if (!sessionId) return null;
      const session = getSessionManager().getSession(sessionId);
      if (!session) return null;
      const liveAgent = activeAgents.get(sessionId);
      const live = liveAgent && !liveAgent.finalized
        ? snapshotForAgent(liveAgent)
        : null;
      return {
        sessionId,
        // The active chain may contain a durable step checkpoint. Keep the
        // renderer's history base at turn start while `live` supplies the same
        // tool/text tail, avoiding duplicate bubbles and cumulative usage.
        messages: liveAgent && live ? [...liveAgent.messages] : flattenSessionMessages(session),
        live,
      };
    },
  );

  // chat:stop — immediate targeted cancellation from the global Activity list.
  ipcMain.handle(IPC_CHANNELS.CHAT_STOP, async (_event, payload: unknown) => {
    const parsed = chatStopSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid chat:stop payload: ${parsed.error.message}`);
    }
    return {
      status: forceStopSession(parsed.data.sessionId)
        ? 'stopped'
        : 'no_active_stream',
    };
  });

  // chat:queue_next — stop the current chain at the next step boundary so a
  // queued "next-request" message can start a fresh chain. Fire-and-forget.
  ipcMain.handle(IPC_CHANNELS.CHAT_QUEUE_NEXT, async (_event, payload: unknown) => {
    const parsed = chatQueueNextSchema.safeParse(payload ?? {});
    if (!parsed.success) {
      throw new Error(`Invalid chat:queue_next payload: ${parsed.error.message}`);
    }
    requestNextRequestStop(parsed.data.sessionId);
  });

  // chat:cancel — three-phase Esc: hint → cancel agent → cancel subagents
  ipcMain.handle(IPC_CHANNELS.CHAT_CANCEL, async (event, payload: unknown) => {
    const webContents: WebContents = event.sender;
    const windowId = String(webContents.id);
    const parsed = chatCancelSchema.safeParse(payload ?? {});
    if (!parsed.success) {
      throw new Error(`Invalid chat:cancel payload: ${parsed.error.message}`);
    }
    const sessionId =
      parsed.data.sessionId ?? getSessionManager().getActive(windowId)?.id;
    if (!sessionId) return { status: 'no_active_stream' };
    const existing = activeAgents.get(sessionId);

    if (!existing) {
      return { status: 'no_active_stream' };
    }

    // A global activity row may stop work owned by another window. Route turn
    // events back to that session's renderer so the requester never receives
    // a different session's chunks, completion, or interrupt state.
    const streamWebContents =
      webContentsForWindowId(existing.windowId) ?? webContents;

    const interruptSnapshot = existing.interruptActor.getSnapshot();
    const interruptState = interruptSnapshot.value as
      | 'idle'
      | 'confirmAgent'
      | 'confirmSubagents';

    // First Esc while streaming → show interrupt hint (don't cancel yet)
    if (interruptState === 'idle') {
      existing.interruptActor.send({ type: 'INTERRUPT' });
      return { status: 'confirming' };
    }

    // Second Esc while confirming agent → cancel the stream and persist partial.
    if (interruptState === 'confirmAgent') {
      getBackgroundStore().terminateSession(sessionId);
      existing.agentCancelled = true;
      const context = existing.actor.getSnapshot().context as AgentContext;
      existing.actor.send({ type: 'CANCEL' });

      // Finalize immediately with partial content (no "[Interrupted by user]" suffix).
      // Only append text not already flushed into turnMessages before tools.
      if (!existing.finalized) {
        existing.finalized = true;
        const partial = context.response ?? '';
        const thinking = context.thinking ?? '';
        const usage = context.usage ?? null;
        appendLiveTailMessages(existing.turnMessages, existing, context, { placeholderWhenEmpty: true });
        if (thinking.length > existing.thinkingCommittedLength) {
          existing.thinkingCommittedLength = thinking.length;
        }
        if (partial.length > existing.responseCommittedLength) {
          existing.responseCommittedLength = partial.length;
        }
        // existing.messages already includes the user message for this turn
        const fullHistory = [...existing.messages, ...existing.turnMessages];
        persistTurnConversation(
          sessionId,
          fullHistory,
          turnMessagesFromAgent(existing),
          ChainStatus.INTERRUPTED,
          existing.agent,
          existing.selection,
          streamWebContents,
        );
        completeSessionActivity(
          sessionId,
          getSessionManager().getActive(existing.windowId)?.id !== sessionId,
        );

        sendTurnEvent(streamWebContents, existing, IPC_CHANNELS.CHAT_DONE, {
          type: 'done',
          response: partial,
          interrupted: true,
          usage,
        });
        sendChatState(streamWebContents, existing, {
          state: 'idle',
          error: null,
          interruptState: 'confirmSubagents',
          cwd: existing.cwd,
        });
      }

      // Future: detect running subagents. For now always expose the phase briefly
      // then allow a third Esc (or timeout dispose) to finish cleanup.
      existing.interruptActor.send({ type: 'INTERRUPT' });

      // If no subagents are tracked, complete cancel immediately so the
      // renderer gets a clean `cancelled` status after confirming_subagents.
      // Keep the actor briefly so the interrupt UI can show the third phase.
      return { status: 'confirming_subagents' };
    }

    // Third Esc while confirming subagents → cancel subagents and dispose
    if (interruptState === 'confirmSubagents') {
      getBackgroundStore().terminateSession(sessionId);
      getSubagentManager().cancelRunning(sessionId);
      disposeActiveAgent(sessionId, existing);
      sendChatState(streamWebContents, existing, {
          state: 'idle',
          error: null,
          interruptState: 'idle',
          cwd: existing.cwd,
      });
      return { status: 'cancelled' };
    }

    return { status: 'no_active_stream' };
  });

  // bgcmd:snapshot — get background command output snapshot (session-scoped)
  ipcMain.handle(IPC_CHANNELS.BG_CMD_SNAPSHOT, async (event, payload: unknown) => {
    const parsed = bgCommandSnapshotSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid bgcmd:snapshot payload: ${parsed.error.message}`);
    }

    const { commandId, lastN, sessionId: requestedSessionId } = parsed.data;
    const windowId = String(event.sender.id);
    const sessionId =
      requestedSessionId ?? getSessionManager().getActive(windowId)?.id ?? null;
    if (!sessionId) {
      return { found: false };
    }

    const store = getBackgroundStore();
    // Session ownership only — include main and subagent-scoped bgcmds.
    const snap = store.snapshotForSession(commandId, lastN ?? 50, sessionId);
    if (!snap) {
      return { found: false };
    }

    return { found: true, ...snap };
  });
}

/**
 * Unregister chat IPC handlers (for cleanup/testing).
 */
export function unregisterChatIPC(): void {
  ipcMain.removeHandler(IPC_CHANNELS.CHAT_SEND);
  ipcMain.removeHandler(IPC_CHANNELS.CHAT_CANCEL);
  ipcMain.removeHandler(IPC_CHANNELS.CHAT_QUEUE_NEXT);
  ipcMain.removeHandler(IPC_CHANNELS.CHAT_STOP);
  ipcMain.removeHandler(IPC_CHANNELS.CHAT_SNAPSHOT);
  ipcMain.removeHandler(IPC_CHANNELS.BG_CMD_SNAPSHOT);

  // Tear down active agents via dispose so MCP project leases are released.
  for (const [sessionId, agent] of [...activeAgents.entries()]) {
    agent.agentCancelled = true;
    agent.finalized = true;
    disposeActiveAgent(sessionId, agent);
  }
  activeAgents.clear();
  sessionsStarting.clear();
  draftEnsureByWindow.clear();
  agentGenerations.clear();
  clearAllChatHistory();
}
