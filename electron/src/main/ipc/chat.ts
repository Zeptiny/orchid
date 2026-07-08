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
import type { StreamEvent } from '../llm/orchestrator';
import type { Agent } from '../../shared/types/agent';
import type { Config } from '../config/schema';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import { getConfig } from '../config/loader';
import { listAgents } from '../agents/registry';
import { resolveModelRef } from '../llm/providers';
import { createProviderModel } from '../llm/providers-factory';
import { MessageRole, MessageType } from '../../shared/types/message';
import type { Message } from '../../shared/types/message';
import type { GenerateTitleCallback } from '../session/manager';
import { getSessionManager } from './session';
import { importESM } from '../utils/esm-import';
import { getBackgroundStore } from '../tools/process/background-store';

// ── Zod validation schemas ───────────────────────────────────────────────────

const chatSendSchema = z.object({
  message: z.string().min(1, 'Message must be non-empty'),
  sessionId: z.string().optional(),
});

const bgCommandSnapshotSchema = z.object({
  commandId: z.number().int().positive(),
  lastN: z.number().int().positive().optional(),
});

// ── Active actor tracking ────────────────────────────────────────────────────

type ActiveAgent = {
  actor: ActorRefFrom<typeof agentMachine>;
  abortController: AbortController;
  messages: Message[];
  unsubscribe: () => void;
};

const activeAgents = new Map<string, ActiveAgent>();
const messageHistory = new Map<string, Message[]>();

function disposeActiveAgent(windowId: string, active: ActiveAgent): void {
  activeAgents.delete(windowId);
  active.unsubscribe();
  active.abortController.abort();
  active.actor.stop();
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

    // Resolve the model for this agent
    const modelRef = resolveModelRef(
      config.tier_models[params.agent.tier] || config.default_model,
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
      mcpManager: null, // MCP manager is injected at app startup
      sessionId: undefined,
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
      return {
        content: typeof result === 'string' ? result : JSON.stringify(result),
        isError: false,
      };
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

      const result = await generateText({
        model: modelInstance,
        messages: [
          {
            role: 'system',
            content:
              'Generate a short, descriptive title (3-6 words) for this conversation. ' +
              'Only output the title, nothing else. No quotes, no punctuation at the end.',
          },
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

    const { message } = parsed.data;
    const config = getConfig();

    // Cancel any existing actor for this window
    const windowId = String(webContents.id);
    const existing = activeAgents.get(windowId);
    let existingMessages: Message[] = messageHistory.get(windowId) ?? [];

    if (existing) {
      existingMessages = existing.messages;
      disposeActiveAgent(windowId, existing);
    }

    // Build message history: existing messages + new user message
    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: MessageRole.USER,
      content: message,
      type: MessageType.TEXT,
      tool_calls: null,
      tool_call_id: null,
      name: null,
      thinking: null,
      timestamp: new Date().toISOString(),
      usage: null,
      hidden: false,
    };

    const messages = [...existingMessages, userMessage];

    // Get or create agent (default to "general" agent)
    const agents = listAgents();
    const agent = agents.find((a) => a.name === 'general') ?? agents[0] ?? {
      name: 'general',
      type: 'subagent',
      tier: 'bloom',
      description: 'General-purpose agent',
      system_prompt: 'You are a helpful assistant.',
      allowed_tools: ['*'],
      allowed_skills: ['*'],
    };

    // Create the agent actor with message history
    const abortController = new AbortController();
    const actor = createActor(agentMachine, {
      input: {
        agent,
        systemPrompt: agent.system_prompt || 'You are a helpful assistant.',
        streamFn: createStreamFn(config, messages),
        executeFn: createExecuteFn(),
      },
    });

    // Track response for incremental updates
    let lastSentLength = 0;
    let completed = false;
    let subscription: { unsubscribe: () => void } | null = null;
    let lastUsage: import('../../shared/types/message').Usage | null = null;

    const activeAgent: ActiveAgent = {
      actor,
      abortController,
      messages,
      unsubscribe: () => subscription?.unsubscribe(),
    };
    activeAgents.set(windowId, activeAgent);

    // Subscribe to state changes and stream chunks to renderer
    subscription = actor.subscribe((snapshot) => {
      const context = snapshot.context as AgentContext;

      // Send incremental text updates
      if (context.response.length > lastSentLength) {
        const newContent = context.response.slice(lastSentLength);
        lastSentLength = context.response.length;
        webContents.send(IPC_CHANNELS.CHAT_CHUNK, {
          type: 'chunk',
          data: newContent,
        });
      }

      // Send state transitions
      webContents.send(IPC_CHANNELS.CHAT_STATE, {
        state: snapshot.value,
        response: context.response,
        error: context.error,
      });

      // Forward usage data to renderer when it changes
      if (context.usage && context.usage !== lastUsage) {
        lastUsage = context.usage;
        webContents.send(IPC_CHANNELS.CHAT_USAGE, {
          type: 'usage',
          usage: context.usage,
        });
      }

      // Clean up on terminal states
      if (snapshot.value === 'idle' && lastSentLength > 0 && !completed) {
        completed = true;
        // Add assistant response to message history
        const assistantMessage: Message = {
          id: crypto.randomUUID(),
          role: MessageRole.ASSISTANT,
          content: context.response,
          type: MessageType.TEXT,
          tool_calls: null,
          tool_call_id: null,
          name: null,
          thinking: null,
          timestamp: new Date().toISOString(),
          usage: context.usage ?? null,
          hidden: false,
        };

        messageHistory.set(windowId, [...messages, assistantMessage]);
        activeAgents.delete(windowId);

        webContents.send(IPC_CHANNELS.CHAT_DONE, {
          type: 'done',
          response: context.response,
        });

        // Auto-name session after first exchange (non-blocking, non-fatal)
        const allMessages = [...messages, assistantMessage];
        const sessionManager = getSessionManager();
        const generateTitle = createGenerateTitleCallback(config, allMessages);
        sessionManager.autoNameActive(generateTitle).then((updated) => {
          if (updated && updated.name !== messages[0]?.content?.slice(0, 20) && !webContents.isDestroyed()) {
            // Notify renderer of the rename so sidebar updates
            webContents.send(IPC_CHANNELS.SESSION_RENAMED, {
              id: updated.id,
              name: updated.name,
            });
          }
        }).catch((err) => {
          console.debug('Auto-naming failed (non-fatal):', err);
        });

        queueMicrotask(() => {
          subscription?.unsubscribe();
          actor.stop();
        });
      }

      if (snapshot.value === 'error') {
        completed = true;
        webContents.send(IPC_CHANNELS.CHAT_ERROR, {
          type: 'error',
          error: context.error ?? 'Unknown error',
        });
        activeAgents.delete(windowId);
        queueMicrotask(() => {
          subscription?.unsubscribe();
          actor.stop();
        });
      }
    });

    // Start the actor and send user input
    actor.start();
    actor.send({ type: 'USER_INPUT', message });

    return { status: 'started' };
  });

  // chat:cancel — abort the active stream
  ipcMain.handle(IPC_CHANNELS.CHAT_CANCEL, async (event) => {
    const webContents: WebContents = event.sender;
    const windowId = String(webContents.id);
    const existing = activeAgents.get(windowId);

    if (existing) {
      disposeActiveAgent(windowId, existing);
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
    agent.unsubscribe();
    agent.abortController.abort();
    agent.actor.stop();
  }
  activeAgents.clear();
  messageHistory.clear();
}
