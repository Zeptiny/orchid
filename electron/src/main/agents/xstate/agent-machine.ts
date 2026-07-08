/**
 * Agent machine — the core state machine for LLM-driven agent orchestration.
 *
 * State flow:
 *   idle → streaming → toolExecuting → streaming → idle → interrupted
 *
 * Transitions:
 * - idle → streaming: on USER_INPUT
 * - streaming → toolExecuting: on TOOL_CALL (invoke tool via fromPromise)
 * - streaming → idle: on STREAM_END (no tool calls)
 * - toolExecuting → streaming: on TOOL_RESULT (feed result back)
 * - toolExecuting → error: on TOOL_ERROR
 * - streaming → interrupted: on CANCEL (cancels in-flight invoke)
 * - interrupted → idle: on timeout or user confirmation
 * - error → idle: on USER_INPUT (retry)
 *
 * The streaming state uses `fromCallback` for the LLM stream (push-based
 * chunks to parent). Tool execution uses `fromPromise`.
 *
 * Integrates with `streamChat` from U9 (electron/src/main/llm/orchestrator.ts).
 *
 * Ported from Python `src/orchid/agents/manager.py` and `src/orchid/app.py`.
 */

import { assign, setup, fromCallback, fromPromise, type ActorRefFrom } from 'xstate';
import type { StreamEvent } from '../../llm/orchestrator';
import type { AgentEvent } from './events';
import type { Agent } from '../../../shared/types/agent';

// ── Context ─────────────────────────────────────────────────────────────────

export interface AgentContext {
  /** Accumulated assistant response text for the current turn. */
  response: string;
  /** User input that triggered the current stream. */
  currentInput: string;
  /** Current tool call being executed. */
  currentToolCall: {
    toolCallId: string;
    toolName: string;
    args: string;
  } | null;
  /** Error message if in error state. */
  error: string | null;
  /** The agent configuration. */
  agent: Agent;
  /** System prompt for the agent. */
  systemPrompt: string;
  /** Abort controller for cancelling in-flight streams. */
  abortController: AbortController | null;
  /** Auto-reset timeout for interrupted state (ms). */
  interruptResetMs: number;
  /**
   * Stream function — an async generator that yields StreamEvents.
   * This is the `streamChat` function from U9, or a mock for testing.
   */
  streamFn: StreamFn;
  /**
   * Tool execution function.
   * In production, this dispatches to the tool registry.
   */
  executeFn: ExecuteFn;
}

// ── Function types ──────────────────────────────────────────────────────────

/** Function signature for the LLM stream provider. */
export type StreamFn = (params: {
  message: string;
  agent: Agent;
  systemPrompt: string;
  abortSignal: AbortSignal;
}) => AsyncGenerator<StreamEvent>;

/** Function signature for tool execution. */
export type ExecuteFn = (
  toolName: string,
  args: string,
) => Promise<{ content: string; isError: boolean }>;

// ── Stream callback input ───────────────────────────────────────────────────

export interface StreamCallbackInput {
  /** The user message to send. */
  message: string;
  /** Agent configuration. */
  agent: Agent;
  /** System prompt. */
  systemPrompt: string;
  /** Abort controller for cancellation. */
  abortController: AbortController;
  /** Stream function. */
  streamFn: StreamFn;
}

// ── Tool execution input ────────────────────────────────────────────────────

export interface ToolExecInput {
  toolCallId: string;
  toolName: string;
  args: string;
  /** Tool execution function. */
  executeFn: ExecuteFn;
}

// ── Stream callback (fromCallback) ──────────────────────────────────────────

/**
 * fromCallback actor that drives the LLM stream.
 *
 * Receives StreamEvents from the async generator and translates them
 * into agent machine events (CHUNK, TOOL_CALL, STREAM_END, ERROR).
 *
 * On receiving a CANCEL event from the parent, aborts the stream.
 */
const streamCallback = fromCallback(
  ({
    sendBack,
    receive,
    input,
  }: {
    sendBack: (event: AgentEvent) => void;
    receive: (callback: (event: AgentEvent) => void) => void;
    input: StreamCallbackInput;
  }) => {
    const { message, agent, systemPrompt, abortController, streamFn } = input;
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
        const stream = streamFn({
          message,
          agent,
          systemPrompt,
          abortSignal: abortController.signal,
        });

        for await (const event of stream) {
          if (cancelled) break;

          switch (event.type) {
            case 'content':
              sendBack({ type: 'CHUNK', data: event.text });
              break;
            case 'tool_call':
              sendBack({
                type: 'TOOL_CALL',
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                args: '', // args come from the fullStream chunk, not from the event
              });
              break;
            case 'tool_result':
              sendBack({
                type: 'TOOL_RESULT',
                toolCallId: event.toolCallId,
                content: event.content,
                isError: event.isError,
              });
              break;
            case 'finish':
              sendBack({ type: 'STREAM_END', finishReason: event.finishReason });
              break;
            case 'error':
              sendBack({ type: 'ERROR', error: event.detail, title: event.title });
              break;
            // thinking, usage, step_finish are ignored by the agent machine
            default:
              break;
          }
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

    // Cleanup function — called when the actor is stopped
    return () => {
      cancelled = true;
      abortController.abort();
    };
  },
);

// ── Tool execution actor (fromPromise) ──────────────────────────────────────

/**
 * fromPromise actor that executes a single tool call.
 *
 * Resolves with a TOOL_RESULT event, or rejects with a TOOL_ERROR event.
 */
const toolExecActor = fromPromise(
  async ({ input }: { input: ToolExecInput }): Promise<AgentEvent> => {
    try {
      const result = await input.executeFn(input.toolName, input.args);
      return {
        type: 'TOOL_RESULT',
        toolCallId: input.toolCallId,
        content: result.content,
        isError: result.isError,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      // Return a TOOL_RESULT with isError instead of throwing,
      // so the machine can handle it gracefully.
      return {
        type: 'TOOL_RESULT',
        toolCallId: input.toolCallId,
        content: `Tool execution failed: ${errorMessage}`,
        isError: true,
      };
    }
  },
);

// ── Machine definition ──────────────────────────────────────────────────────

export const agentMachine = setup({
  types: {
    context: {} as AgentContext,
    events: {} as AgentEvent,
    input: {} as {
      agent: Agent;
      systemPrompt: string;
      streamFn: StreamFn;
      executeFn: ExecuteFn;
      /** Auto-reset timeout for interrupted state (ms). Default: 5000. */
      interruptResetMs?: number;
    },
  },
  actors: {
    streamActor: streamCallback,
    toolExecActor: toolExecActor,
  },
  delays: {
    INTERRUPT_RESET: ({ context }) => context.interruptResetMs,
  },
}).createMachine({
  id: 'agent',
  initial: 'idle',
  context: ({ input }) => ({
    response: '',
    currentInput: '',
    currentToolCall: null,
    error: null,
    agent: input.agent,
    systemPrompt: input.systemPrompt,
    abortController: null,
    streamFn: input.streamFn,
    executeFn: input.executeFn,
    interruptResetMs: input.interruptResetMs ?? 5000,
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
            currentToolCall: null,
            abortController: () => new AbortController(),
          }),
        },
      },
    },

    streaming: {
      invoke: {
        src: 'streamActor',
        input: ({ context }) => ({
          message: context.currentInput,
          agent: context.agent,
          systemPrompt: context.systemPrompt,
          abortController: context.abortController ?? new AbortController(),
          streamFn: context.streamFn,
        }),
      },
      on: {
        CHUNK: {
          actions: assign({
            response: ({ context, event }) => context.response + event.data,
          }),
        },
        TOOL_CALL: {
          // Tool calls are handled internally by AI SDK's streamText with maxSteps.
          // This event is informational only (for UI display).
          // No state transition — the stream continues.
        },
        TOOL_RESULT: {
          // Tool results are also handled internally by AI SDK.
          // This event is informational only (for UI display).
        },
        STREAM_END: {
          target: 'idle',
          actions: assign({
            abortController: () => null,
          }),
        },
        ERROR: {
          target: 'error',
          actions: assign({
            error: ({ event }) => event.error,
            abortController: () => null,
          }),
        },
        CANCEL: {
          target: 'interrupted',
          actions: assign({
            abortController: ({ context }) => {
              context.abortController?.abort();
              return null;
            },
          }),
        },
      },
    },

    toolExecuting: {
      invoke: {
        src: 'toolExecActor',
        input: ({ context }) => {
          if (!context.currentToolCall) {
            throw new Error('No tool call in context');
          }
          return {
            ...context.currentToolCall,
            executeFn: context.executeFn,
          };
        },
        onDone: {
          target: 'streaming',
          actions: assign({
            currentToolCall: () => null,
          }),
        },
        onError: {
          target: 'error',
          actions: assign({
            error: ({ event }) => {
              const err = event.error;
              return err instanceof Error ? err.message : String(err);
            },
            currentToolCall: () => null,
          }),
        },
      },
      on: {
        CANCEL: {
          target: 'interrupted',
          actions: assign({
            abortController: ({ context }) => {
              context.abortController?.abort();
              return null;
            },
            currentToolCall: () => null,
          }),
        },
      },
    },

    interrupted: {
      after: {
        // Auto-reset to idle after configurable timeout
        INTERRUPT_RESET: {
          target: 'idle',
          actions: assign({
            response: '',
            error: null,
            currentToolCall: null,
            abortController: () => null,
          }),
        },
      },
      on: {
        // User can also explicitly confirm cancellation
        CANCEL: {
          target: 'idle',
          actions: assign({
            response: '',
            error: null,
            currentToolCall: null,
            abortController: () => null,
          }),
        },
        // Or provide new input to start fresh
        USER_INPUT: {
          target: 'streaming',
          actions: assign({
            currentInput: ({ event }) => event.message,
            response: '',
            error: null,
            currentToolCall: null,
            abortController: () => new AbortController(),
          }),
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
            currentToolCall: null,
            abortController: () => new AbortController(),
          }),
        },
      },
    },
  },
});

// ── Type exports ────────────────────────────────────────────────────────────

export type AgentActor = ActorRefFrom<typeof agentMachine>;
