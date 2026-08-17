/**
 * Agent machine — the core state machine for LLM-driven agent orchestration.
 *
 * State flow:
 *   idle → streaming → idle → interrupted
 *
 * Transitions:
 * - idle → streaming: on USER_INPUT
 * - streaming → idle: on STREAM_END (no tool calls)
 * - streaming → interrupted: on CANCEL (cancels in-flight invoke)
 * - interrupted → idle: on timeout or user confirmation
 * - error → idle: on USER_INPUT (retry)
 *
 * The streaming state uses `fromCallback` for the LLM stream (push-based
 * chunks to parent). Tool calls are handled inside the provider stream.
 *
 * Integrates with `streamChat` from U9 (electron/src/main/llm/orchestrator.ts).
 */

import { assign, setup, fromCallback, type ActorRefFrom } from 'xstate';
import type { StreamEvent } from '../../llm/orchestrator';
import type { AgentEvent } from './events';
import type { Agent } from '../../../shared/types/agent';
import type { ThinkingReplayPayload, Usage } from '../../../shared/types/message';
import { addStepUsage } from '../../../shared/usage';
import type {
  CanonicalToolResult,
  TerminalToolResultStatus,
} from '../../../shared/types/tool-result';

// ── Context ─────────────────────────────────────────────────────────────────

export interface AgentContext {
  /** Accumulated assistant response text for the current turn. */
  response: string;
  /** Accumulated reasoning/thinking text for the current turn. */
  thinking: string;
  /**
   * Thinking replay artifacts keyed by the text offset at which their segment
   * ends. Persisted onto THINKING messages when segments flush.
   */
  thinkingPayloads: Record<number, ThinkingReplayPayload>;
  /** Artifacts with no displayable text, flushed as their own THINKING messages. */
  thinkingArtifacts: ThinkingReplayPayload[];
  /** User input that triggered the current stream. */
  currentInput: string;
  /** Current tool call being streamed (generating state). */
  streamingToolCall: {
    toolCallId: string;
    toolName: string;
    partialArgs: string;
  } | null;
  /** Tool names keyed by tool call ID, used to enrich result updates. */
  toolCallNames: Record<string, string>;
  /** Last tool lifecycle update for IPC subscribers. */
  toolLifecycleUpdate: {
    sequence: number;
    toolCallId: string;
    toolName?: string;
    status: 'running' | TerminalToolResultStatus;
    args?: string;
    content?: string;
    toolResult?: CanonicalToolResult;
  } | null;
  /** Monotonic sequence number for tool lifecycle updates. */
  toolUpdateSequence: number;
  /** Error message if in error state. */
  error: string | null;
  /** Optional compaction step-boundary hook — idle boundary for R16. */
  onStepBoundary?: (info: { stepIndex: number; finishReason: string }) => void | Promise<void>;
  /** Last step boundary seen (for diagnostics / partial-report stoppedAt). */
  lastStepBoundary: { stepIndex: number; finishReason: string } | null;
  /** Short error title for UI banners (auth/rate-limit/timeout/etc). */
  errorTitle: string | null;
  /** Whether the latest turn was interrupted by the user. */
  wasInterrupted: boolean;
  /** Token usage data from the most recent stream. */
  usage: Usage | null;
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
}

// ── Function types ──────────────────────────────────────────────────────────

/** Function signature for the LLM stream provider. */
export type StreamFn = (params: {
  message: string;
  agent: Agent;
  systemPrompt: string;
  abortSignal: AbortSignal;
}) => AsyncGenerator<StreamEvent>;

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
  /** Optional compaction step-boundary hook — forwarded from context. */
  onStepBoundary?: (info: { stepIndex: number; finishReason: string }) => void | Promise<void>;
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
            case 'thinking':
              sendBack({ type: 'THINKING', data: event.text });
              break;
            case 'thinking_artifact':
              sendBack({ type: 'THINKING_ARTIFACT', payload: event.payload, hasText: event.hasText });
              break;
            case 'tool_call':
              sendBack({
                type: 'TOOL_CALL',
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                args: event.args,
              });
              break;
            case 'tool_call_start':
              sendBack({
                type: 'TOOL_CALL_START',
                toolCallId: event.toolCallId,
                toolName: event.toolName,
              });
              break;
            case 'tool_call_delta':
              sendBack({
                type: 'TOOL_CALL_DELTA',
                toolCallId: event.toolCallId,
                argsDelta: event.argsDelta,
              });
              break;
            case 'tool_result':
              {
                const execution = event.execution;
              sendBack({
                type: 'TOOL_RESULT',
                toolCallId: event.toolCallId,
                execution,
              });
              }
              break;
            case 'finish':
              sendBack({ type: 'STREAM_END', finishReason: event.finishReason });
              break;
            case 'error':
              sendBack({
                type: 'ERROR',
                error: event.detail,
                title: event.title,
              });
              break;
            case 'usage':
              sendBack({ type: 'USAGE', usage: event.usage });
              break;
            case 'step_finish':
              sendBack({ type: 'STEP_FINISH', stepIndex: event.stepIndex, finishReason: event.finishReason });
              break;
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

// ── Machine definition ──────────────────────────────────────────────────────

export const agentMachine = setup({
  types: {
    context: {} as AgentContext,
    events: {} as AgentEvent,
    input: {} as {
      agent: Agent;
      systemPrompt: string;
      streamFn: StreamFn;
      /** Auto-reset timeout for interrupted state (ms). Default: 5000. */
      interruptResetMs?: number;
      onStepBoundary?: (info: { stepIndex: number; finishReason: string }) => void | Promise<void>;
    },
  },
  actors: {
    streamActor: streamCallback,
  },
  delays: {
    INTERRUPT_RESET: ({ context }) => context.interruptResetMs,
  },
}).createMachine({
  id: 'agent',
  initial: 'idle',
  context: ({ input }) => ({
    response: '',
    thinking: '',
    thinkingPayloads: {},
    thinkingArtifacts: [],
    currentInput: '',
    streamingToolCall: null,
    toolCallNames: {},
    toolLifecycleUpdate: null,
    toolUpdateSequence: 0,
    error: null,
    errorTitle: null,
    wasInterrupted: false,
    usage: null,
    agent: input.agent,
    systemPrompt: input.systemPrompt,
    abortController: null,
    streamFn: input.streamFn,
    interruptResetMs: input.interruptResetMs ?? 5000,
    onStepBoundary: input.onStepBoundary,
    lastStepBoundary: null,
  }),
  states: {
    idle: {
      on: {
        USER_INPUT: {
          target: 'streaming',
          actions: assign({
            currentInput: ({ event }) => event.message,
            response: '',
            thinking: '',
            thinkingPayloads: () => ({}),
            thinkingArtifacts: () => [],
            error: null,
            errorTitle: null,
            wasInterrupted: false,
            streamingToolCall: () => null,
            toolCallNames: () => ({}),
            toolLifecycleUpdate: () => null,
            toolUpdateSequence: () => 0,
            usage: () => null,
            abortController: () => new AbortController(),
          }),
        },
        USAGE: {
          actions: assign({
            usage: ({ context, event }) => addStepUsage(context.usage, event.usage),
          }),
        },
        STEP_FINISH: {
          actions: assign({
            lastStepBoundary: ({ event }) => ({ stepIndex: (event as unknown as { stepIndex: number }).stepIndex, finishReason: (event as unknown as { finishReason: string }).finishReason }),
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
          onStepBoundary: context.onStepBoundary,
        }),
      },
      on: {
        CHUNK: {
          actions: assign({
            response: ({ context, event }) => context.response + event.data,
          }),
        },
        THINKING: {
          actions: assign({
            thinking: ({ context, event }) => context.thinking + event.data,
          }),
        },
        THINKING_ARTIFACT: {
          actions: assign({
            thinkingPayloads: ({ context, event }) => {
              if (!event.hasText) return context.thinkingPayloads;
              return { ...context.thinkingPayloads, [context.thinking.length]: event.payload };
            },
            thinkingArtifacts: ({ context, event }) =>
              event.hasText ? context.thinkingArtifacts : [...context.thinkingArtifacts, event.payload],
          }),
        },
        TOOL_CALL: {
          // Tool calls are handled internally by AI SDK's streamText with maxSteps.
          // This event is informational only (for UI display).
          // No state transition — the stream continues.
          actions: assign({
            streamingToolCall: () => null,
            toolCallNames: ({ context, event }) => ({
              ...context.toolCallNames,
              [event.toolCallId]: event.toolName,
            }),
            toolUpdateSequence: ({ context }) => context.toolUpdateSequence + 1,
            toolLifecycleUpdate: ({ context, event }) => {
              const sequence = context.toolUpdateSequence + 1;
              return {
                sequence,
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                status: 'running',
                args: event.args,
              };
            },
          }),
        },
        TOOL_CALL_START: {
          // Tool call streaming start — track for UI generating state.
          actions: assign({
            streamingToolCall: ({ event }) => ({
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              partialArgs: '',
            }),
            toolCallNames: ({ context, event }) => ({
              ...context.toolCallNames,
              [event.toolCallId]: event.toolName,
            }),
          }),
        },
        TOOL_CALL_DELTA: {
          // Tool call args delta — accumulate partial args.
          actions: assign({
            streamingToolCall: ({ context, event }) => {
              if (!context.streamingToolCall) return null;
              return {
                ...context.streamingToolCall,
                partialArgs: context.streamingToolCall.partialArgs + event.argsDelta,
              };
            },
          }),
        },
        TOOL_RESULT: {
          // Tool results are also handled internally by AI SDK.
          // This event is informational only (for UI display).
          actions: assign({
            toolUpdateSequence: ({ context }) => context.toolUpdateSequence + 1,
            toolLifecycleUpdate: ({ context, event }) => {
              const sequence = context.toolUpdateSequence + 1;
              const toolName = context.toolCallNames[event.toolCallId];
              const execution = event.execution;
              return {
                sequence,
                toolCallId: event.toolCallId,
                toolName,
                status: execution.canonical.status,
                content: execution.agentProjection.content,
                toolResult: execution.canonical,
              };
            },
          }),
        },
        STREAM_END: {
          target: 'idle',
          actions: assign({
            abortController: () => null,
            streamingToolCall: () => null,
          }),
        },
        USAGE: {
          actions: assign({
            usage: ({ context, event }) => addStepUsage(context.usage, event.usage),
          }),
        },
        STEP_FINISH: {
          actions: assign({
            lastStepBoundary: ({ context, event }) => {
              const info = { stepIndex: (event as unknown as { stepIndex: number }).stepIndex, finishReason: (event as unknown as { finishReason: string }).finishReason };
              try {
                const hook = (context as unknown as { onStepBoundary?: (info: { stepIndex: number; finishReason: string }) => void }).onStepBoundary;
                if (hook) void Promise.resolve(hook(info)).catch(() => {});
              } catch {}
              return info;
            },
          }),
        },
        ERROR: {
          target: 'error',
          actions: assign({
            error: ({ event }) => event.error,
            errorTitle: ({ event }) => event.title ?? 'Stream Error',
            abortController: () => null,
            streamingToolCall: () => null,
          }),
        },
        CANCEL: {
          target: 'interrupted',
          actions: assign({
            wasInterrupted: true,
            abortController: ({ context }) => {
              context.abortController?.abort();
              return null;
            },
            streamingToolCall: () => null,
          }),
        },
      },
    },

    interrupted: {
      // Stay interrupted until chat IPC finalizes the turn and disposes
      // the actor. Preserve `response` so partial content can be saved.
      after: {
        INTERRUPT_RESET: {
          target: 'idle',
          actions: assign({
            wasInterrupted: false,
            error: null,
            errorTitle: null,
            streamingToolCall: () => null,
            abortController: () => null,
          }),
        },
      },
      on: {
        CANCEL: {
          target: 'idle',
          actions: assign({
            wasInterrupted: false,
            error: null,
            errorTitle: null,
            streamingToolCall: () => null,
            abortController: () => null,
          }),
        },
        USER_INPUT: {
          target: 'streaming',
          actions: assign({
            currentInput: ({ event }) => event.message,
            response: '',
            thinking: '',
            thinkingPayloads: () => ({}),
            thinkingArtifacts: () => [],
            error: null,
            errorTitle: null,
            wasInterrupted: false,
            streamingToolCall: () => null,
            toolCallNames: () => ({}),
            toolLifecycleUpdate: () => null,
            toolUpdateSequence: () => 0,
            usage: () => null,
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
            thinking: '',
            thinkingPayloads: () => ({}),
            thinkingArtifacts: () => [],
            error: null,
            errorTitle: null,
            wasInterrupted: false,
            streamingToolCall: () => null,
            toolCallNames: () => ({}),
            toolLifecycleUpdate: () => null,
            toolUpdateSequence: () => 0,
            usage: () => null,
            abortController: () => new AbortController(),
          }),
        },
      },
    },
  },
});

// ── Type exports ────────────────────────────────────────────────────────────

export type AgentActor = ActorRefFrom<typeof agentMachine>;

/**
 * Helper to read last step boundary from context (diagnostics / stoppedAt for partial reports).
 */
export function getLastStepBoundary(context: AgentContext): { stepIndex: number; finishReason: string } | null {
  return context.lastStepBoundary;
}
