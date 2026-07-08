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
import { listAgents, getAgent } from '../agents/registry';
import { resolveModelRef } from '../llm/providers';
import { createProviderModel } from '../llm/providers-factory';
import { MessageRole, MessageType } from '../../shared/types/message';
import type { Message } from '../../shared/types/message';

// ── Zod validation schemas ───────────────────────────────────────────────────

const chatSendSchema = z.object({
  message: z.string().min(1, 'Message must be non-empty'),
  sessionId: z.string().optional(),
});

// ── Active actor tracking ────────────────────────────────────────────────────

type ActiveAgent = {
  actor: ActorRefFrom<typeof agentMachine>;
  webContents: WebContents;
  abortController: AbortController;
  messages: Message[];
};

let activeAgents = new Map<string, ActiveAgent>();

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
    const modelInstance = createProviderModel(modelRef);

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
      const result = await tool.handler(parsedArgs);
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

    const { message, sessionId } = parsed.data;
    const config = getConfig();

    // Cancel any existing actor for this window
    const windowId = String(webContents.id);
    const existing = activeAgents.get(windowId);
    let existingMessages: Message[] = [];

    if (existing) {
      existingMessages = existing.messages;
      existing.abortController.abort();
      existing.actor.send({ type: 'CANCEL' });
      activeAgents.delete(windowId);
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
      allowed_tools: ['*'],
      allowed_skills: ['*'],
    };

    // Create the agent actor with message history
    const abortController = new AbortController();
    const actor = createActor(agentMachine, {
      input: {
        agent,
        systemPrompt: 'You are a helpful assistant.',
        streamFn: createStreamFn(config, messages),
        executeFn: createExecuteFn(),
      },
    });

    activeAgents.set(windowId, {
      actor,
      webContents,
      abortController,
      messages,
    });

    // Track response for incremental updates
    let lastSentLength = 0;

    // Subscribe to state changes and stream chunks to renderer
    actor.subscribe((snapshot) => {
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

      // Clean up on terminal states
      if (snapshot.value === 'idle' && lastSentLength > 0) {
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
          usage: null,
          hidden: false,
        };

        // Update the stored messages for this window
        const agentData = activeAgents.get(windowId);
        if (agentData) {
          agentData.messages = [...messages, assistantMessage];
        }

        webContents.send(IPC_CHANNELS.CHAT_DONE, {
          type: 'done',
          response: context.response,
        });
        // Don't delete the agent - keep it for message history
      }

      if (snapshot.value === 'error') {
        webContents.send(IPC_CHANNELS.CHAT_ERROR, {
          type: 'error',
          error: context.error ?? 'Unknown error',
        });
        activeAgents.delete(windowId);
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
      existing.abortController.abort();
      existing.actor.send({ type: 'CANCEL' });
      activeAgents.delete(windowId);
      return { status: 'cancelled' };
    }
    return { status: 'no_active_stream' };
  });
}

/**
 * Unregister chat IPC handlers (for cleanup/testing).
 */
export function unregisterChatIPC(): void {
  ipcMain.removeHandler(IPC_CHANNELS.CHAT_SEND);
  ipcMain.removeHandler(IPC_CHANNELS.CHAT_CANCEL);

  // Cancel all active agents
  for (const [, agent] of activeAgents) {
    agent.abortController.abort();
    agent.actor.send({ type: 'CANCEL' });
  }
  activeAgents.clear();
}
