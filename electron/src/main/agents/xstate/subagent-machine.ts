/**
 * Subagent machine — child actor for delegated tasks.
 *
 * State flow:
 *   pending → running → completed | failed | interrupted
 *
 * Final states are `type: 'final'` — the parent session machine observes
 * state transitions via subscription rather than sendParent, which avoids
 * coupling and allows standalone testing.
 *
 * Runs an isolated chain (own messages, model, system prompt).
 * Cannot create sub-subagents (enforced by tool filtering in U9).
 *
 * Ported from Python `src/orchid/agents/manager.py` (SubagentRecord, _run).
 */

import { assign, setup, fromCallback, type ActorRefFrom } from 'xstate';
import type { StreamEvent } from '../../llm/orchestrator';
import type { SubagentEvent } from './events';
import type { Agent } from '../../../shared/types/agent';

// ── Context ─────────────────────────────────────────────────────────────────

export interface SubagentContext {
  /** Unique subagent identifier. */
  id: string;
  /** Display label for the subagent. */
  label: string;
  /** The task description given to the subagent. */
  task: string;
  /** The agent configuration. */
  agent: Agent;
  /** System prompt for the subagent. */
  systemPrompt: string;
  /** Model to use (may differ from parent). */
  model: string | null;
  /** Accumulated response text. */
  response: string;
  /** Error message if failed. */
  error: string | null;
  /** Abort controller for cancellation. */
  abortController: AbortController | null;
  /**
   * Stream function — same as agent machine's streamFn.
   * Subagents use the same LLM stream mechanism.
   */
  streamFn: SubagentStreamFn;
}

// ── Function types ──────────────────────────────────────────────────────────

/** Function signature for the LLM stream provider. */
export type SubagentStreamFn = (params: {
  message: string;
  agent: Agent;
  systemPrompt: string;
  abortSignal: AbortSignal;
  model?: string | null;
}) => AsyncGenerator<StreamEvent>;

// ── Stream callback input ───────────────────────────────────────────────────

interface SubagentStreamInput {
  task: string;
  agent: Agent;
  systemPrompt: string;
  model: string | null;
  abortController: AbortController;
  streamFn: SubagentStreamFn;
}

// ── Stream callback (fromCallback) ──────────────────────────────────────────

/**
 * fromCallback actor that drives the subagent's LLM stream.
 *
 * Similar to the agent machine's stream callback, but tailored for
 * subagent lifecycle (reports to parent on completion).
 */
const subagentStreamCallback = fromCallback(
  ({
    sendBack,
    receive,
    input,
  }: {
    sendBack: (event: SubagentEvent) => void;
    receive: (callback: (event: SubagentEvent) => void) => void;
    input: SubagentStreamInput;
  }) => {
    const { task, agent, systemPrompt, model, abortController, streamFn } = input;
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
          message: task,
          agent,
          systemPrompt,
          abortSignal: abortController.signal,
          model,
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
                args: '',
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

    // Cleanup function
    return () => {
      cancelled = true;
      abortController.abort();
    };
  },
);

// ── Machine definition ──────────────────────────────────────────────────────

export const subagentMachine = setup({
  types: {
    context: {} as SubagentContext,
    events: {} as SubagentEvent,
    input: {} as {
      id: string;
      label: string;
      task: string;
      agent: Agent;
      systemPrompt: string;
      model?: string | null;
      streamFn: SubagentStreamFn;
    },
  },
  actors: {
    subagentStream: subagentStreamCallback,
  },
}).createMachine({
  id: 'subagent',
  initial: 'pending',
  context: ({ input }) => ({
    id: input.id,
    label: input.label,
    task: input.task,
    agent: input.agent,
    systemPrompt: input.systemPrompt,
    model: input.model ?? null,
    response: '',
    error: null,
    abortController: null,
    streamFn: input.streamFn,
  }),
  states: {
    pending: {
      // Auto-transition to running on entry
      always: {
        target: 'running',
        actions: assign({
          abortController: () => new AbortController(),
        }),
      },
    },

    running: {
      invoke: {
        src: 'subagentStream',
        input: ({ context }) => ({
          task: context.task,
          agent: context.agent,
          systemPrompt: context.systemPrompt,
          model: context.model,
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
        STREAM_END: {
          target: 'completed',
          actions: assign({
            abortController: () => null,
          }),
        },
        ERROR: {
          target: 'failed',
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
        // Tool calls within subagents are handled by the stream internally
        // (AI SDK's streamText with maxSteps handles the tool loop).
        // We track them for UI display but don't need separate state transitions.
        TOOL_CALL: {
          // No state transition — tool calls are handled by AI SDK internally
        },
        TOOL_RESULT: {
          // No state transition — tool results are handled by AI SDK internally
        },
      },
    },

    completed: {
      type: 'final',
    },

    failed: {
      type: 'final',
    },

    interrupted: {
      type: 'final',
    },
  },
});

// ── Type exports ────────────────────────────────────────────────────────────

export type SubagentActor = ActorRefFrom<typeof subagentMachine>;
