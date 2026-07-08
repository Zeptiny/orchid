/**
 * Spike: XState v5 agent machine for U2 foundation patterns validation.
 *
 * State flow: idle → streaming → idle (with error state)
 * - idle → streaming: on USER_INPUT event
 * - streaming → idle: on STREAM_END (no tool calls needed — AI SDK handles them)
 * - streaming → error: on ERROR
 * - any → idle: on CANCEL (cancels in-flight stream)
 *
 * The streaming state uses `fromCallback` for the LLM stream:
 * - sendBack: CHUNK | TOOL_CALL | STREAM_END | ERROR
 * - receive: CANCEL → abort stream
 *
 * AI SDK's `streamText` with `maxSteps` handles the multi-step tool loop
 * internally. XState manages the high-level agent lifecycle.
 *
 * This is throwaway code — real agent hierarchy comes in U10.
 */
import { assign, setup, fromCallback, type ActorRefFrom } from 'xstate';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import { listFilesTool } from '../../tools/spike-tool';
import { createRetryMiddleware } from '../../llm/middleware/retry';

// ─── Event types ─────────────────────────────────────────────────────────────

export type SpikeAgentEvent =
  | { type: 'USER_INPUT'; message: string }
  | { type: 'CHUNK'; data: string }
  | { type: 'TOOL_CALL'; toolName: string; args: string }
  | { type: 'TOOL_RESULT'; toolName: string; result: string }
  | { type: 'STREAM_END' }
  | { type: 'ERROR'; error: string }
  | { type: 'CANCEL' };

// ─── Context ─────────────────────────────────────────────────────────────────

export interface SpikeAgentContext {
  /** Accumulated assistant response text */
  response: string;
  /** User input that triggered the current stream */
  currentInput: string;
  /** Error message if in error state */
  error: string | null;
  /** Model reference for LLM calls */
  model: LanguageModelV4;
  /** System prompt for the agent */
  systemPrompt: string;
}

// ─── Stream callback input ───────────────────────────────────────────────────

interface StreamCallbackInput {
  message: string;
  model: LanguageModelV4;
  systemPrompt: string;
  abortController: AbortController;
}

// ─── Stream callback (fromCallback) ──────────────────────────────────────────

const streamCallback = fromCallback(
  ({
    sendBack,
    receive,
    input,
  }: {
    sendBack: (event: SpikeAgentEvent) => void;
    receive: (callback: (event: SpikeAgentEvent) => void) => void;
    input: StreamCallbackInput;
  }) => {
    const { message, model, systemPrompt, abortController } = input;
    let cancelled = false;

    // Listen for CANCEL events from parent
    receive((event) => {
      if (event.type === 'CANCEL') {
        cancelled = true;
        abortController.abort();
      }
    });

    // Run the async stream
    const runStream = async () => {
      try {
        // Dynamic import — `ai` is ESM-only but Electron main compiles to CJS
        const { streamText, wrapLanguageModel, isStepCount } = await import('ai');

        // Wrap model with retry middleware
        const wrappedModel = wrapLanguageModel({
          model,
          middleware: createRetryMiddleware({ maxRetries: 3 }),
        });

        const result = streamText({
          model: wrappedModel,
          system: systemPrompt,
          messages: [{ role: 'user', content: message }],
          tools: {
            list_files: listFilesTool,
          },
          stopWhen: isStepCount(5),
          abortSignal: abortController.signal,
        });

        // Process the text stream
        for await (const chunk of result.textStream) {
          if (cancelled) break;
          sendBack({ type: 'CHUNK', data: chunk });
        }

        if (!cancelled) {
          sendBack({ type: 'STREAM_END' });
        }
      } catch (error) {
        if (!cancelled) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          sendBack({ type: 'ERROR', error: errorMessage });
        }
      }
    };

    runStream();

    // Cleanup function
    return () => {
      cancelled = true;
      abortController.abort();
    };
  },
);

// ─── Machine definition ──────────────────────────────────────────────────────

export const spikeAgentMachine = setup({
  types: {
    context: {} as SpikeAgentContext,
    events: {} as SpikeAgentEvent,
    input: {} as {
model: LanguageModelV4;
      systemPrompt?: string;
    },
  },
  actors: {
    streamActor: streamCallback,
  },
}).createMachine({
  id: 'spikeAgent',
  initial: 'idle',
  context: ({ input }) => ({
    response: '',
    currentInput: '',
    error: null,
    model: input.model,
    systemPrompt: input.systemPrompt ?? 'You are a helpful assistant.',
  }),
  states: {
    idle: {
      on: {
        USER_INPUT: {
          target: 'streaming',
          actions: assign({
            currentInput: ({ event }) => event.message,
            response: '',
            error: null,
          }),
        },
      },
    },

    streaming: {
      invoke: {
        src: 'streamActor',
        input: ({ context }) => ({
          message: context.currentInput,
          model: context.model,
          systemPrompt: context.systemPrompt,
          abortController: new AbortController(),
        }),
      },
      on: {
        CHUNK: {
          actions: assign({
            response: ({ context, event }) => context.response + event.data,
          }),
        },
        TOOL_CALL: {
          // Tool calls are handled internally by AI SDK's streamText.
          // This event is informational only (for UI logging).
        },
        STREAM_END: {
          target: 'idle',
        },
        ERROR: {
          target: 'error',
          actions: assign({
            error: ({ event }) => event.error,
          }),
        },
        CANCEL: {
          target: 'idle',
        },
      },
    },

    error: {
      on: {
        USER_INPUT: {
          target: 'streaming',
          actions: assign({
            currentInput: ({ event }) => event.message,
            response: '',
            error: null,
          }),
        },
      },
    },
  },
});

// ─── Type exports ────────────────────────────────────────────────────────────

export type SpikeAgentActor = ActorRefFrom<typeof spikeAgentMachine>;
