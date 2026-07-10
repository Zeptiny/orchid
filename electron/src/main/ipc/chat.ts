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
import { createActor, type ActorRefFrom } from 'xstate';
import { z } from 'zod';
import { agentMachine, type AgentContext } from '../agents/xstate/agent-machine';
import { interruptMachine } from '../agents/xstate/interrupt-machine';
import type { StreamEvent } from '../llm/orchestrator';
import type { Agent } from '../../shared/types/agent';
import type { Config } from '../config/schema';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import { getConfig } from '../config/loader';
import { listAgents } from '../agents/registry';
import { appendPersonality } from '../personality/registry';
import { resolveModelRef } from '../llm/providers';
import { createProviderModel } from '../llm/providers-factory';
import { MessageRole, MessageType } from '../../shared/types/message';
import type { Message, Usage } from '../../shared/types/message';
import { ChainStatus } from '../../shared/types/chain';
import type { GenerateTitleCallback } from '../session/manager';
import { getSessionManager } from './session';
import { importESM } from '../utils/esm-import';
import { getBackgroundStore } from '../tools/process/background-store';
import { getMCPManagerRef } from './mcp';
import { getSubagentManager } from '../tools';
import type { ChatErrorKind, ChatSendResult } from '../../shared/types/ipc';
import {
  clearAllChatHistory,
  getChatHistory,
  setChatHistory,
} from './chat-history';
import {
  makeAssistantMessage,
  makeThinkingMessage,
  makeToolCallMessage,
  makeToolResultMessage,
  makeUserMessage,
} from '../llm/message-factories';
import {
  clearDraftCwd,
  isWorkspaceBound,
  resolveWorkspace,
} from '../project/workspace';
// ── Zod validation schemas ───────────────────────────────────────────────────

const chatSendSchema = z.object({
  message: z.string().min(1, 'Message must be non-empty'),
  sessionId: z.string().optional(),
  /** Preferred model when lazy-creating a session from draft mode. */
  model: z.string().optional(),
});

const bgCommandSnapshotSchema = z.object({
  commandId: z.number().int().positive(),
  lastN: z.number().int().positive().optional(),
});

// ── Active actor tracking ────────────────────────────────────────────────────

type ActiveAgent = {
  actor: ActorRefFrom<typeof agentMachine>;
  interruptActor: ActorRefFrom<typeof interruptMachine>;
  abortController: AbortController;
  /** Full conversation history at the start of this turn (includes prior turns). */
  messages: Message[];
  /** Messages produced during this turn (tool calls/results + assistant). */
  turnMessages: Message[];
  /** Length of context.response already snapshotted into turnMessages as text. */
  responseCommittedLength: number;
  /** Length of context.thinking already snapshotted into turnMessages. */
  thinkingCommittedLength: number;
  agent: Agent;
  agentCancelled: boolean;
  finalized: boolean;
  /** Monotonic generation for this window; stale agents must not emit IPC. */
  generation: number;
  unsubscribe: () => void;
  interruptUnsubscribe: () => void;
  interruptResetTimer: ReturnType<typeof setTimeout> | null;
};

const activeAgents = new Map<string, ActiveAgent>();

/**
 * Per-window generation counter. Incremented on every new chat:send and on
 * forceAbort so stale actor/interrupt subscriptions can drop events even if
 * they fire after the agent was replaced or torn down.
 */
const agentGenerations = new Map<string, number>();

function nextAgentGeneration(windowId: string): number {
  const gen = (agentGenerations.get(windowId) ?? 0) + 1;
  agentGenerations.set(windowId, gen);
  return gen;
}

function disposeActiveAgent(windowId: string, active: ActiveAgent): void {
  // Only clear the map slot if we still own it (a newer agent may have replaced us).
  if (activeAgents.get(windowId) === active) {
    activeAgents.delete(windowId);
  }
  active.unsubscribe();
  active.interruptUnsubscribe();
  if (active.interruptResetTimer) {
    clearTimeout(active.interruptResetTimer);
    active.interruptResetTimer = null;
  }
  active.abortController.abort();
  active.actor.stop();
  active.interruptActor.stop();
}

/**
 * Whether this agent may still stream IPC to the renderer.
 * Drops events from cancelled, finalized, replaced, or generation-stale agents.
 */
function canEmitStreamEvents(windowId: string, active: ActiveAgent): boolean {
  return (
    !active.agentCancelled &&
    !active.finalized &&
    activeAgents.get(windowId) === active &&
    agentGenerations.get(windowId) === active.generation
  );
}

/** True when this agent still occupies the window's active slot (may be cancelled). */
function isCurrentAgent(windowId: string, active: ActiveAgent): boolean {
  return (
    activeAgents.get(windowId) === active &&
    agentGenerations.get(windowId) === active.generation
  );
}

/**
 * Silently abort any in-flight chat for a window (e.g. on session switch).
 * Does not emit CHAT_DONE — the renderer is about to replace its message list.
 *
 * Dispose is synchronous: a deferred microtask left a window where the old
 * subscription could still emit CHAT_CHUNK after session:load swapped UI state
 * (or after a new chat:send started). Flags + generation bump drop any late
 * callbacks that race with stop/unsubscribe.
 *
 * Before discarding, we attempt to persist any partial turn (user message +
 * tool calls + assistant text produced so far) as INTERRUPTED so the user does
 * not lose context when switching sessions mid-stream (P2-9).
 */
export function forceAbortChat(windowId: string): void {
  const existing = activeAgents.get(windowId);
  if (!existing) return;

  try {
    const snapshot = existing.actor.getSnapshot();
    const context = snapshot?.context as AgentContext | undefined;
    const partialResponse = context?.response ?? '';
    const thinking = context?.thinking ?? '';
    const usage = (context?.usage as Usage | null) ?? null;

    if (thinking && thinking.length > existing.thinkingCommittedLength) {
      const seg = thinking.slice(existing.thinkingCommittedLength);
      if (seg.trim()) {
        existing.turnMessages.push(makeThinkingMessage(seg));
      }
      existing.thinkingCommittedLength = thinking.length;
    }

    const remaining = partialResponse.slice(existing.responseCommittedLength);
    if (remaining) {
      existing.turnMessages.push(makeAssistantMessage(remaining, usage));
      existing.responseCommittedLength = partialResponse.length;
    } else if (usage && existing.turnMessages.length > 0) {
      const last = existing.turnMessages[existing.turnMessages.length - 1];
      if (
        last &&
        last.role === MessageRole.ASSISTANT &&
        last.type === MessageType.TEXT
      ) {
        existing.turnMessages[existing.turnMessages.length - 1] = {
          ...last,
          usage,
        };
      }
    }

    if (existing.messages.length > 0 || existing.turnMessages.length > 0) {
      const fullHistory = [...existing.messages, ...existing.turnMessages];
      if (fullHistory.length > 0) {
        try {
          const sessionManager = getSessionManager();
          sessionManager.syncActiveChain({
            messages: fullHistory,
            status: ChainStatus.INTERRUPTED,
            agentName: existing.agent.name,
            agentType: existing.agent.type,
            agentTier: existing.agent.tier,
          });
        } catch (err) {
          console.debug(
            'Failed to persist partial chat on forceAbort (non-fatal):',
            err,
          );
        }
        try {
          setChatHistory(windowId, fullHistory);
        } catch {
          // ignore
        }
      }
    }
  } catch (err) {
    console.debug(
      'forceAbortChat persistence attempt failed (non-fatal):',
      err,
    );
  }

  existing.agentCancelled = true;
  existing.finalized = true;
  nextAgentGeneration(windowId);
  disposeActiveAgent(windowId, existing);
}

function canSend(webContents: WebContents): boolean {
  return typeof webContents.isDestroyed !== 'function' || !webContents.isDestroyed();
}

/**
 * Ensure there is an active session before streaming/persisting.
 * Draft mode leaves no active session until the first chat:send — create
 * lazily here and notify the renderer so the sidebar gains a list entry.
 *
 * Requires a valid workspace (draft → session → sticky default). Never uses
 * process.cwd() as the product default. If unbound, does not create a session.
 *
 * @returns ok + session cwd, or a structured failure for the send gate
 */
function ensureActiveSession(
  webContents: WebContents,
  preferredModel?: string,
): { ok: true; cwd: string } | { ok: false; result: ChatSendResult } {
  const windowId = String(webContents.id);
  const manager = getSessionManager();
  const active = manager.getActive();
  const workspace = resolveWorkspace(windowId, {
    sessionCwd: active?.cwd ?? null,
    stickyDefault: getConfig().default_project_dir,
  });

  if (!isWorkspaceBound(workspace) || workspace.cwd == null) {
    return {
      ok: false,
      result: {
        status: 'error',
        error:
          'No project folder selected. Choose a folder before sending a message.',
        kind: 'unbound_workspace',
      },
    };
  }

  if (active) {
    return { ok: true, cwd: workspace.cwd };
  }

  const config = getConfig();
  const model =
    (preferredModel && preferredModel.trim()) ||
    config.default_model ||
    '';
  const session = manager.create(model, { cwd: workspace.cwd });
  // Draft was promoted into the new session.
  clearDraftCwd(windowId);
  if (canSend(webContents)) {
    webContents.send(IPC_CHANNELS.SESSION_CREATED, { session });
  }
  return { ok: true, cwd: workspace.cwd };
}

function classifyErrorKind(title: string | null | undefined, detail: string): ChatErrorKind {
  const haystack = `${title ?? ''} ${detail}`.toLowerCase();
  if (haystack.includes('rate limit') || haystack.includes('429') || haystack.includes('usage limit')) {
    return 'rate-limit';
  }
  if (
    haystack.includes('auth') ||
    haystack.includes('401') ||
    haystack.includes('403') ||
    haystack.includes('api key')
  ) {
    return 'auth';
  }
  if (
    haystack.includes('timeout') ||
    haystack.includes('timed out') ||
    haystack.includes('network') ||
    haystack.includes('connection')
  ) {
    return 'stream';
  }
  return 'generic';
}

function persistConversation(
  windowId: string,
  messages: Message[],
  status: ChainStatus,
  agent: Agent,
  model?: string,
): void {
  setChatHistory(windowId, messages);
  try {
    const sessionManager = getSessionManager();
    sessionManager.syncActiveChain({
      messages,
      status,
      model,
      agentName: agent.name,
      agentType: agent.type,
      agentTier: agent.tier,
    });
  } catch (err) {
    console.debug('Failed to persist chat chain (non-fatal):', err);
  }
}

function historyFromActiveSession(): Message[] {
  try {
    const session = getSessionManager().getActive();
    if (!session) return [];
    const chain =
      session.chains.find((c) => c.id === session.activeChainId) ??
      session.chains[session.chains.length - 1];
    return chain ? [...chain.messages] : [];
  } catch {
    return [];
  }
}

// ── Stream function (wraps the orchestrator) ─────────────────────────────────

/**
 * Creates a StreamFn compatible with the agent machine.
 * In production, this wraps the streamChat orchestrator from U9.
 */
function createStreamFn(config: Config, messages: Message[]) {
  return async function* (params: {
    message: string;
    agent: Agent;
    systemPrompt: string;
    abortSignal: AbortSignal;
  }): AsyncGenerator<StreamEvent> {
    // Dynamic import to avoid circular dependency issues
    const { streamChat } = await import('../llm/orchestrator');

    // Resolve the model for this agent:
    // session model (from /model) → tier model → global default.
    const sessionModel = getSessionManager().getActive()?.model;
    const modelRef = resolveModelRef(
      sessionModel ||
        config.tier_models[params.agent.tier] ||
        config.default_model,
      config,
    );
    const modelInstance = await createProviderModel(modelRef);

    // Build system prompt context
    const context = {
      cwd: process.cwd(),
      osInfo: `${process.platform} ${process.arch}`,
      time: new Date().toISOString(),
      subagentStates: [],
      todos: [],
      backgroundCommands: [],
    };

    // Use the orchestrator to stream with full message history
    const stream = streamChat({
      messages,
      agent: params.agent,
      systemPrompt: params.systemPrompt,
      context,
      config,
      registry: (await import('../tools')).toolRegistry,
      mcpManager: getMCPManagerRef(),
      sessionId: getSessionManager().getActive()?.id,
      abortSignal: params.abortSignal,
      modelInstance,
    });

    yield* stream;
  };
}

// ── Tool execution function ──────────────────────────────────────────────────

/**
 * Creates an ExecuteFn compatible with the agent machine.
 * Dispatches to the tool registry.
 */
function createExecuteFn() {
  return async (toolName: string, args: string) => {
    const { toolRegistry } = await import('../tools');
    const { normalizeToolHandlerResult } = await import('../tools/result');
    const tool = toolRegistry.get(toolName);
    if (!tool) {
      return { content: `Tool '${toolName}' not found`, isError: true };
    }

    try {
      const parsedArgs = JSON.parse(args);

      // Validate args against the tool's Zod schema before execution
      const validation = toolRegistry.validate(toolName, parsedArgs);
      if (!validation.ok) {
        return { content: validation.error, isError: true };
      }

      const result = await tool.handler(validation.data);
      return normalizeToolHandlerResult(result);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      return { content: `Tool execution failed: ${errorMessage}`, isError: true };
    }
  };
}

// ── Auto-naming callback factory ─────────────────────────────────────────────

/**
 * Creates a GenerateTitleCallback that uses the seed-tier model to produce
 * a short descriptive title from the first user/assistant exchange.
 *
 * Non-fatal on failure — returns null so the session keeps its default name.
 */
function createGenerateTitleCallback(
  config: Config,
  messages: Message[],
): GenerateTitleCallback {
  return async (_session) => {
    try {
      // Extract first user and assistant text messages
      const userMsg = messages.find((m) => m.role === MessageRole.USER);
      const assistantMsg = messages.find((m) => m.role === MessageRole.ASSISTANT);

      if (!userMsg || !assistantMsg) {
        return null;
      }

      // Resolve the seed-tier model for title generation
      const modelRef = resolveModelRef(
        config.tier_models['seed'] || config.default_model,
        config,
      );
      const modelInstance = await createProviderModel(modelRef);

      // Use AI SDK generateText for a simple one-shot title
      const { generateText } = await importESM<typeof import('ai')>('ai');

      // AI SDK 7: system text must use `instructions` (not role:'system' in messages)
      const result = await generateText({
        model: modelInstance,
        instructions:
          'Generate a short, descriptive title (3-6 words) for this conversation. ' +
          'Only output the title, nothing else. No quotes, no punctuation at the end.',
        messages: [
          {
            role: 'user',
            content:
              `User: ${userMsg.content.slice(0, 500)}\n\n` +
              `Assistant: ${assistantMsg.content.slice(0, 500)}`,
          },
        ],
      });

      // Extract the first line, trim, and sanitize
      const title = result.text.trim().split('\n')[0]?.trim();
      if (!title || title.length === 0) {
        return null;
      }

      return title;
    } catch (err) {
      // Non-fatal — log and keep default name
      console.debug('Auto-naming callback failed:', err);
      return null;
    }
  };
}

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

    const { message, model: preferredModel } = parsed.data;
    const config = getConfig();

    // Cancel any existing actor for this window
    const windowId = String(webContents.id);
    const existing = activeAgents.get(windowId);

    // Lazy session create + workspace gate (R2/R3): require valid workspace;
    // create with that cwd; if unbound, fail without streaming.
    const sessionGate = ensureActiveSession(webContents, preferredModel);
    if (!sessionGate.ok) {
      return sessionGate.result;
    }

    // Prefer live window history; fall back to active session chain on cold start.
    let existingMessages: Message[] =
      getChatHistory(windowId) ?? historyFromActiveSession();

    if (existing) {
      // Keep prior completed turns only (drop in-progress turn state)
      existingMessages =
        getChatHistory(windowId) ??
        existing.messages.filter(
          (m) =>
            m.role === MessageRole.USER ||
            m.role === MessageRole.ASSISTANT ||
            m.role === MessageRole.TOOL,
        );
      disposeActiveAgent(windowId, existing);
    }

    // Build message history: existing messages + new user message
    const userMessage = makeUserMessage(message);

    const messages = [...existingMessages, userMessage];

    // Get or create agent (default to "general" agent)
    const agents = listAgents();
    const agent = agents.find((a) => a.name === 'general') ?? agents[0] ?? {
      name: 'general',
      type: 'subagent' as const,
      tier: 'bloom' as const,
      description: 'General-purpose agent',
      system_prompt: 'You are a helpful assistant.',
      allowed_tools: ['*'],
      allowed_skills: ['*'],
    };

    // Create the agent actor with message history.
    // Append the configured personality (from ~/.orchid/personalities/) like Python.
    const abortController = new AbortController();
    const baseSystemPrompt = agent.system_prompt || 'You are a helpful assistant.';
    const actor = createActor(agentMachine, {
      input: {
        agent,
        systemPrompt: appendPersonality(baseSystemPrompt, config.personality),
        streamFn: createStreamFn(config, messages),
        executeFn: createExecuteFn(),
      },
    });

    // Create the interrupt machine actor for two-phase Esc confirmation
    const interruptActor = createActor(interruptMachine);

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
    const generation = nextAgentGeneration(windowId);
    const activeAgent: ActiveAgent = {
      actor,
      interruptActor,
      abortController,
      messages,
      turnMessages: [],
      // How much of context.response has already been snapshotted into turnMessages
      // as intermediate assistant text (so tools can interleave: text → tool → text).
      responseCommittedLength: 0,
      thinkingCommittedLength: 0,
      agent,
      agentCancelled: false,
      finalized: false,
      generation,
      unsubscribe: () => subscription?.unsubscribe(),
      interruptUnsubscribe: () => interruptSubscription?.unsubscribe(),
      interruptResetTimer: null,
    };
    activeAgents.set(windowId, activeAgent);

    /** Snapshot any response text that arrived before the next tool into turnMessages. */
    const flushResponseSegment = (fullResponse: string, attachUsage: Usage | null = null) => {
      if (fullResponse.length <= activeAgent.responseCommittedLength) return;
      const segment = fullResponse.slice(activeAgent.responseCommittedLength);
      activeAgent.responseCommittedLength = fullResponse.length;
      if (!segment.trim() && !attachUsage) return;
      activeAgent.turnMessages.push(makeAssistantMessage(segment, attachUsage));
    };

    /** Snapshot reasoning/thinking text into turnMessages (before tools / final text). */
    const flushThinkingSegment = (fullThinking: string) => {
      if (fullThinking.length <= activeAgent.thinkingCommittedLength) return;
      const segment = fullThinking.slice(activeAgent.thinkingCommittedLength);
      activeAgent.thinkingCommittedLength = fullThinking.length;
      if (!segment.trim()) return;
      activeAgent.turnMessages.push(makeThinkingMessage(segment));
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
            makeAssistantMessage(remaining || opts.response || '', opts.usage),
          );
          activeAgent.responseCommittedLength = opts.response.length;
        }
      } else if (opts.usage) {
        // No remaining text — attach usage to the last assistant message if any.
        const last = activeAgent.turnMessages[activeAgent.turnMessages.length - 1];
        if (last && last.role === MessageRole.ASSISTANT && last.type === MessageType.TEXT) {
          activeAgent.turnMessages[activeAgent.turnMessages.length - 1] = {
            ...last,
            usage: opts.usage,
          };
        } else if (opts.interrupted) {
          activeAgent.turnMessages.push(makeAssistantMessage('', opts.usage));
        }
      }

      const turnExtras = [...activeAgent.turnMessages];
      const fullHistory = [...messages, ...turnExtras];
      persistConversation(
        windowId,
        fullHistory,
        opts.interrupted ? ChainStatus.INTERRUPTED : ChainStatus.COMPLETED,
        agent,
        config.default_model,
      );
      activeAgent.messages = fullHistory;

      if (opts.sendDone && canSend(webContents)) {
        webContents.send(IPC_CHANNELS.CHAT_DONE, {
          type: 'done',
          response: opts.response,
          interrupted: opts.interrupted,
          usage: opts.usage,
        });
      }

      if (!opts.interrupted) {
        // Auto-name after first successful exchange (non-blocking)
        const sessionManager = getSessionManager();
        const generateTitle = createGenerateTitleCallback(config, fullHistory);
        sessionManager
          .autoNameActive(generateTitle)
          .then((updated) => {
            if (updated && canSend(webContents)) {
              webContents.send(IPC_CHANNELS.SESSION_RENAMED, {
                id: updated.id,
                name: updated.name,
              });
            }
          })
          .catch((err) => {
            console.debug('Auto-naming failed (non-fatal):', err);
          });
      }
    };

    // Track interrupt machine state changes and forward to renderer
    interruptSubscription = interruptActor.subscribe((interruptSnapshot) => {
      // Drop events from replaced/aborted agents (session switch, newer turn).
      if (!isCurrentAgent(windowId, activeAgent)) {
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
        queueMicrotask(() => {
          if (activeAgents.get(windowId) === activeAgent) {
            disposeActiveAgent(windowId, activeAgent);
          }
        });
      }

      // Re-send CHAT_STATE with updated interrupt state
      const context = actor.getSnapshot().context as AgentContext;
      if (canSend(webContents)) {
        webContents.send(IPC_CHANNELS.CHAT_STATE, {
          state: actor.getSnapshot().value,
          response: context.response,
          error: context.error,
          interruptState,
          cwd: process.cwd(),
        });
      }
    });

    // Subscribe to state changes and stream chunks to renderer
    subscription = actor.subscribe((snapshot) => {
      // Drop late events from cancelled, finalized, or generation-stale agents so
      // CHAT_CHUNK cannot leak across session switches / overlapping turns.
      if (!canEmitStreamEvents(windowId, activeAgent)) {
        return;
      }

      const context = snapshot.context as AgentContext;

      // Send incremental text updates
      if (context.response.length > lastSentLength) {
        const newContent = context.response.slice(lastSentLength);
        lastSentLength = context.response.length;
        if (canSend(webContents)) {
          webContents.send(IPC_CHANNELS.CHAT_CHUNK, {
            type: 'chunk',
            data: newContent,
          });
        }
      }

      // Send incremental reasoning/thinking updates → Thought widgets
      const thinking = context.thinking ?? '';
      if (thinking.length > lastThinkingLength) {
        const newThinking = thinking.slice(lastThinkingLength);
        lastThinkingLength = thinking.length;
        if (canSend(webContents)) {
          webContents.send(IPC_CHANNELS.CHAT_THINKING, {
            type: 'thinking',
            data: newThinking,
          });
        }
      }

      // Send state transitions (includes interrupt machine state)
      const interruptState = interruptActor.getSnapshot().value as
        | 'idle'
        | 'confirmAgent'
        | 'confirmSubagents';
      if (canSend(webContents)) {
        webContents.send(IPC_CHANNELS.CHAT_STATE, {
          state: snapshot.value,
          response: context.response,
          error: context.error,
          interruptState,
          cwd: process.cwd(),
        });
      }

      // Forward usage data to renderer when it changes
      if (context.usage && context.usage !== lastUsage) {
        lastUsage = context.usage;
        if (canSend(webContents)) {
          webContents.send(IPC_CHANNELS.CHAT_USAGE, {
            type: 'usage',
            usage: context.usage,
          });
        }
      }

      // Forward tool call streaming events to renderer
      if (context.streamingToolCall) {
        const stc = context.streamingToolCall;
        if (stc.toolCallId !== lastStreamingToolCallId) {
          // New tool call started streaming
          lastStreamingToolCallId = stc.toolCallId;
          lastStreamingToolArgLength.set(stc.toolCallId, 0);
          if (canSend(webContents)) {
            webContents.send(IPC_CHANNELS.CHAT_TOOL_CALL_START, {
              type: 'tool_call_start',
              toolCallId: stc.toolCallId,
              toolName: stc.toolName,
            });
          }
        }
        // Send only the new delta. The machine stores accumulated args.
        const previousLength = lastStreamingToolArgLength.get(stc.toolCallId) ?? 0;
        const argsDelta = stc.partialArgs.slice(previousLength);
        if (argsDelta && canSend(webContents)) {
          lastStreamingToolArgLength.set(stc.toolCallId, stc.partialArgs.length);
          webContents.send(IPC_CHANNELS.CHAT_TOOL_CALL_DELTA, {
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

        if (canSend(webContents)) {
          webContents.send(IPC_CHANNELS.CHAT_TOOL_CALL_UPDATE, {
            type: 'tool_call_update',
            toolCallId: update.toolCallId,
            toolName: update.toolName,
            status: update.status,
            args: update.args,
            result: update.result,
            error: update.error,
          });
        }

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

        if (update.status === 'completed' || update.status === 'failed') {
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
            activeAgent.turnMessages.push(
              makeToolResultMessage(
                update.toolCallId,
                update.toolName ?? 'unknown',
                update.status === 'failed'
                  ? (update.error ?? 'Tool failed')
                  : (update.result ?? ''),
                update.status === 'failed',
              ),
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
          disposeActiveAgent(windowId, activeAgent);
        });
      }

      if (snapshot.value === 'error') {
        completed = true;
        activeAgent.finalized = true;
        const detail = context.error ?? 'Unknown error';
        const title = context.errorTitle ?? 'Stream Error';
        if (canSend(webContents)) {
          webContents.send(IPC_CHANNELS.CHAT_ERROR, {
            type: 'error',
            error: detail,
            title,
            kind: classifyErrorKind(title, detail),
          });
        }
        // Persist conversation so far (user + tools) without a partial assistant if empty
        const fullHistory = [...messages, ...activeAgent.turnMessages];
        if (context.response) {
          fullHistory.push(makeAssistantMessage(context.response, context.usage ?? null));
        }
        persistConversation(windowId, fullHistory, ChainStatus.COMPLETED, agent, config.default_model);
        queueMicrotask(() => {
          disposeActiveAgent(windowId, activeAgent);
        });
      }
    });

    // Start the actor and send user input
    actor.start();
    interruptActor.start();

    // Immediate state so the renderer gets cwd/model chrome before first chunk
    if (canSend(webContents)) {
      webContents.send(IPC_CHANNELS.CHAT_STATE, {
        state: 'streaming',
        response: '',
        error: null,
        interruptState: 'idle',
        cwd: process.cwd(),
      });
    }

    actor.send({ type: 'USER_INPUT', message });

    return { status: 'started' };
  });

  // chat:cancel — three-phase Esc: hint → cancel agent → cancel subagents
  ipcMain.handle(IPC_CHANNELS.CHAT_CANCEL, async (event) => {
    const webContents: WebContents = event.sender;
    const windowId = String(webContents.id);
    const existing = activeAgents.get(windowId);

    if (!existing) {
      return { status: 'no_active_stream' };
    }

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
        // Flush reasoning before final text
        if (thinking.length > existing.thinkingCommittedLength) {
          const thinkSeg = thinking.slice(existing.thinkingCommittedLength);
          existing.thinkingCommittedLength = thinking.length;
          if (thinkSeg.trim()) {
            existing.turnMessages.push(makeThinkingMessage(thinkSeg));
          }
        }
        const remaining = partial.slice(existing.responseCommittedLength);
        if (remaining || existing.turnMessages.length === 0) {
          existing.turnMessages.push(
            makeAssistantMessage(remaining || partial, usage),
          );
          existing.responseCommittedLength = partial.length;
        } else if (usage) {
          const last = existing.turnMessages[existing.turnMessages.length - 1];
          if (last && last.role === MessageRole.ASSISTANT && last.type === MessageType.TEXT) {
            existing.turnMessages[existing.turnMessages.length - 1] = {
              ...last,
              usage,
            };
          }
        }
        // existing.messages already includes the user message for this turn
        const fullHistory = [...existing.messages, ...existing.turnMessages];
        persistConversation(
          windowId,
          fullHistory,
          ChainStatus.INTERRUPTED,
          existing.agent,
        );

        if (canSend(webContents)) {
          webContents.send(IPC_CHANNELS.CHAT_DONE, {
            type: 'done',
            response: partial,
            interrupted: true,
            usage,
          });
          webContents.send(IPC_CHANNELS.CHAT_STATE, {
            state: 'idle',
            response: partial,
            error: null,
            interruptState: 'confirmSubagents',
            cwd: process.cwd(),
          });
        }
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
      getSubagentManager().cancelRunning();
      disposeActiveAgent(windowId, existing);
      if (canSend(webContents)) {
        webContents.send(IPC_CHANNELS.CHAT_STATE, {
          state: 'idle',
          response: '',
          error: null,
          interruptState: 'idle',
          cwd: process.cwd(),
        });
      }
      return { status: 'cancelled' };
    }

    return { status: 'no_active_stream' };
  });

  // bgcmd:snapshot — get background command output snapshot
  ipcMain.handle(IPC_CHANNELS.BG_CMD_SNAPSHOT, async (_event, payload: unknown) => {
    const parsed = bgCommandSnapshotSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid bgcmd:snapshot payload: ${parsed.error.message}`);
    }

    const { commandId, lastN } = parsed.data;
    const store = getBackgroundStore();
    const snap = store.snapshot(commandId, lastN ?? 50);

    if (!snap) {
      return { tail: '', exitCode: null };
    }

    return snap;
  });
}

/**
 * Unregister chat IPC handlers (for cleanup/testing).
 */
export function unregisterChatIPC(): void {
  ipcMain.removeHandler(IPC_CHANNELS.CHAT_SEND);
  ipcMain.removeHandler(IPC_CHANNELS.CHAT_CANCEL);
  ipcMain.removeHandler(IPC_CHANNELS.BG_CMD_SNAPSHOT);

  // Cancel all active agents
  for (const [, agent] of activeAgents) {
    agent.agentCancelled = true;
    agent.finalized = true;
    agent.unsubscribe();
    agent.interruptUnsubscribe();
    if (agent.interruptResetTimer) {
      clearTimeout(agent.interruptResetTimer);
    }
    agent.abortController.abort();
    agent.actor.stop();
    agent.interruptActor.stop();
  }
  activeAgents.clear();
  agentGenerations.clear();
  clearAllChatHistory();
}
