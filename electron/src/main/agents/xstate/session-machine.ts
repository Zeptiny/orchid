/**
 * Session machine — parent actor owning the active agent, background
 * commands, and session state.
 *
 * Responsibilities:
 * - Receives USER_INPUT, delegates to the active agent machine
 * - Spawns child subagent machines dynamically
 * - Manages session lifecycle (create, switch, save)
 * - Coordinates interrupt flow between agent and subagents
 *
 * The session machine is the root of the actor hierarchy:
 *   session
 *     ├── agent (active agent machine)
 *     ├── subagent-1 (child)
 *     ├── subagent-2 (child)
 *     └── ...
 *
 * Ported from Python `src/orchid/app.py` (Orchid app class).
 */

import { assign, setup, sendTo, type ActorRefFrom, type AnyActorRef } from 'xstate';
import { agentMachine, type StreamFn, type ExecuteFn } from './agent-machine';
import { subagentMachine, type SubagentStreamFn } from './subagent-machine';
import type {
  SessionEvent,
  UserInputEvent,
  SpawnSubagentEvent,
  SubagentCompleteEvent,
  SubagentFailedEvent,
} from './events';
import type { Agent } from '../../../shared/types/agent';

// ── Context ─────────────────────────────────────────────────────────────────

export interface SubagentEntry {
  id: string;
  label: string;
  task: string;
  agentType: string;
  state: 'pending' | 'running' | 'completed' | 'failed' | 'interrupted';
  result: string | null;
  error: string | null;
  startTime: number;
  endTime: number | null;
}

export interface SessionContext {
  /** Session identifier. */
  sessionId: string;
  /** The active agent configuration. */
  activeAgent: Agent;
  /** System prompt for the active agent. */
  systemPrompt: string;
  /** Reference to the active agent actor. */
  agentRef: AnyActorRef | null;
  /** Map of subagent ID → entry. */
  subagents: Map<string, SubagentEntry>;
  /** Interrupt state. */
  interruptState: 'idle' | 'confirmAgent' | 'confirmSubagents';
  /** Interrupt timeout timer ID. */
  interruptTimer: ReturnType<typeof setTimeout> | null;
  /** Stream function for agents. */
  streamFn: StreamFn;
  /** Stream function for subagents. */
  subagentStreamFn: SubagentStreamFn;
  /** Tool execution function. */
  executeFn: ExecuteFn;
}

// ── Machine ─────────────────────────────────────────────────────────────────

export const sessionMachine = setup({
  types: {
    context: {} as SessionContext,
    events: {} as SessionEvent,
    input: {} as {
      sessionId: string;
      activeAgent: Agent;
      systemPrompt: string;
      streamFn: StreamFn;
      subagentStreamFn: SubagentStreamFn;
      executeFn: ExecuteFn;
    },
  },
  actors: {
    agentMachine: agentMachine,
    subagentMachine: subagentMachine,
  },
}).createMachine({
  id: 'session',
  initial: 'idle',
  context: ({ input }) => ({
    sessionId: input.sessionId,
    activeAgent: input.activeAgent,
    systemPrompt: input.systemPrompt,
    agentRef: null,
    subagents: new Map(),
    interruptState: 'idle',
    interruptTimer: null,
    streamFn: input.streamFn,
    subagentStreamFn: input.subagentStreamFn,
    executeFn: input.executeFn,
  }),
  states: {
    idle: {
      on: {
        USER_INPUT: {
          target: 'active',
          actions: [
            // Spawn the agent actor if not already spawned
            assign({
              agentRef: ({ context, spawn }) => {
                if (context.agentRef) return context.agentRef;
                return spawn('agentMachine', {
                  id: 'active-agent',
                  input: {
                    agent: context.activeAgent,
                    systemPrompt: context.systemPrompt,
                    streamFn: context.streamFn,
                    executeFn: context.executeFn,
                  },
                });
              },
            }),
            // Forward the user input to the agent
            sendTo(
              ({ context }) => context.agentRef!,
              ({ event }) => ({
                type: 'USER_INPUT' as const,
                message: (event as UserInputEvent).message,
              }),
            ),
          ],
        },
      },
    },

    active: {
      on: {
        USER_INPUT: {
          // Forward to the agent actor
          actions: sendTo(
            ({ context }) => context.agentRef!,
            ({ event }) => ({
              type: 'USER_INPUT' as const,
              message: (event as UserInputEvent).message,
            }),
          ),
        },

        CANCEL: {
          // Forward cancel to agent
          actions: sendTo(
            ({ context }) => context.agentRef!,
            { type: 'CANCEL' as const },
          ),
        },

        SPAWN_SUBAGENT: {
          actions: assign({
            subagents: ({ context, event, spawn }) => {
              const e = event as SpawnSubagentEvent;
              const subagentId = `subagent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

              // Spawn the subagent actor
              spawn('subagentMachine', {
                id: subagentId,
                input: {
                  id: subagentId,
                  label: e.name,
                  task: e.task,
                  agent: context.activeAgent, // Subagent uses parent's agent config
                  systemPrompt: context.systemPrompt,
                  selection: e.selection,
                  streamFn: context.subagentStreamFn,
                },
              });

              const newSubagents = new Map(context.subagents);
              newSubagents.set(subagentId, {
                id: subagentId,
                label: e.name,
                task: e.task,
                agentType: e.agentType,
                state: 'pending',
                result: null,
                error: null,
                startTime: Date.now(),
                endTime: null,
              });
              return newSubagents;
            },
          }),
        },

        SUBAGENT_COMPLETE: {
          actions: assign({
            subagents: ({ context, event }) => {
              const e = event as SubagentCompleteEvent;
              const newSubagents = new Map(context.subagents);
              const entry = newSubagents.get(e.subagentId);
              if (entry) {
                newSubagents.set(e.subagentId, {
                  ...entry,
                  state: 'completed',
                  result: e.result,
                  endTime: Date.now(),
                });
              }
              return newSubagents;
            },
          }),
        },

        SUBAGENT_FAILED: {
          actions: assign({
            subagents: ({ context, event }) => {
              const e = event as SubagentFailedEvent;
              const newSubagents = new Map(context.subagents);
              const entry = newSubagents.get(e.subagentId);
              if (entry) {
                newSubagents.set(e.subagentId, {
                  ...entry,
                  state: entry.state === 'interrupted' ? 'interrupted' : 'failed',
                  error: e.error,
                  endTime: Date.now(),
                });
              }
              return newSubagents;
            },
          }),
        },

        INTERRUPT: {
          actions: [
            assign({
              interruptState: ({ context }) => {
                if (context.interruptState === 'idle') {
                  return 'confirmAgent' as const;
                }
                if (context.interruptState === 'confirmAgent') {
                  // Second Esc → cancel agent stream
                  return 'confirmSubagents' as const;
                }
                // Third Esc → cancel subagents
                return 'idle' as const;
              },
            }),
            // Side effects based on interrupt transition.
            // At this point context.interruptState holds the NEW state (post-assign).
            // The mapping from old→new tells us which escalation just happened:
            //   old 'confirmAgent'    → new 'confirmSubagents' → cancel agent stream
            //   old 'confirmSubagents' → new 'idle'            → cancel subagents
            ({ context, self }) => {
              if (context.interruptState === 'confirmSubagents') {
                // Just escalated from confirmAgent → cancel the agent stream
                if (context.agentRef) {
                  self.send({ type: 'CANCEL' });
                }
              } else if (context.interruptState === 'idle') {
                // Just escalated from confirmSubagents → cancel all running subagents
                for (const [_id, entry] of context.subagents) {
                  if (entry.state === 'running' || entry.state === 'pending') {
                    // The subagent actor will be stopped by the machine
                    // We update the entry state directly
                  }
                }
              }
            },
          ],
        },

        INTERRUPT_TIMEOUT: {
          actions: assign({
            interruptState: () => 'idle' as const,
            interruptTimer: () => null,
          }),
        },
      },
    },
  },
});

// ── Type exports ────────────────────────────────────────────────────────────

export type SessionActor = ActorRefFrom<typeof sessionMachine>;
