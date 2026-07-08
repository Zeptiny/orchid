/**
 * Spike: IPC handlers for chat:send and chat:cancel for U2.
 *
 * Handles:
 * - chat:send: Creates XState agent, sends input, streams responses to renderer
 * - chat:cancel: Sends CANCEL to the active agent actor
 *
 * This is throwaway code — full IPC layer comes in U19.
 */
import { ipcMain, type WebContents } from 'electron';
import { createActor, type ActorRefFrom } from 'xstate';
import { createOpenAI } from '@ai-sdk/openai';
import { spikeAgentMachine, type SpikeAgentContext } from '../agents/xstate/spike-agent-machine';

// ─── Configuration ───────────────────────────────────────────────────────────

interface LLMConfig {
  baseURL: string;
  apiKey: string;
  modelId: string;
}

function getLLMConfig(): LLMConfig {
  return {
    baseURL: process.env.LLM_BASE_URL ?? 'https://api.openai.com/v1',
    apiKey: process.env.LLM_API_KEY ?? '',
    modelId: process.env.LLM_MODEL_ID ?? 'gpt-4o-mini',
  };
}

// ─── Active actor tracking ───────────────────────────────────────────────────

let activeActor: ActorRefFrom<typeof spikeAgentMachine> | null = null;

// ─── IPC registration ────────────────────────────────────────────────────────

export function registerSpikeChatIPC(): void {
  // chat:send — start a new agent conversation turn
  ipcMain.handle('chat:send', async (event, message: unknown) => {
    const webContents: WebContents = event.sender;

    // Validate input
    if (typeof message !== 'string' || message.trim().length === 0) {
      throw new Error('Message must be a non-empty string');
    }

    // Cancel any existing actor
    if (activeActor) {
      activeActor.send({ type: 'CANCEL' });
      activeActor = null;
    }

    // Create provider and model
    const config = getLLMConfig();
    const provider = createOpenAI({
      baseURL: config.baseURL,
      apiKey: config.apiKey,
    });
    const model = provider.chat(config.modelId);

    // Create and start the agent actor
    const actor = createActor(spikeAgentMachine, {
      input: {
        model,
        systemPrompt: 'You are a helpful assistant. Use the list_files tool when the user asks about files or directories.',
      },
    });
    activeActor = actor;

    // Track response for incremental updates
    let lastSentLength = 0;

    // Subscribe to state changes and stream chunks to renderer
    actor.subscribe((snapshot) => {
      const context = snapshot.context as SpikeAgentContext;

      // Send incremental text updates
      if (context.response.length > lastSentLength) {
        const newContent = context.response.slice(lastSentLength);
        lastSentLength = context.response.length;
        webContents.send('chat:chunk', {
          type: 'chunk',
          data: newContent,
        });
      }

      // Send state transitions
      webContents.send('chat:state', {
        state: snapshot.value,
        response: context.response,
        error: context.error,
      });

      // Clean up on terminal states
      if (snapshot.value === 'idle' && lastSentLength > 0) {
        webContents.send('chat:done', {
          type: 'done',
          response: context.response,
        });
        activeActor = null;
      }

      if (snapshot.value === 'error') {
        webContents.send('chat:error', {
          type: 'error',
          error: context.error ?? 'Unknown error',
        });
        activeActor = null;
      }
    });

    // Start the actor and send user input
    actor.start();
    actor.send({ type: 'USER_INPUT', message: message.trim() });

    return { status: 'started' };
  });

  // chat:cancel — abort the active stream
  ipcMain.handle('chat:cancel', async () => {
    if (activeActor) {
      activeActor.send({ type: 'CANCEL' });
      activeActor = null;
      return { status: 'cancelled' };
    }
    return { status: 'no_active_stream' };
  });
}

/**
 * Unregister IPC handlers (for cleanup/testing).
 */
export function unregisterSpikeChatIPC(): void {
  ipcMain.removeHandler('chat:send');
  ipcMain.removeHandler('chat:cancel');
  if (activeActor) {
    activeActor.send({ type: 'CANCEL' });
    activeActor = null;
  }
}
