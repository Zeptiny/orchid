/**
 * Interrupt state machine — nested inside agent's `streaming` state.
 *
 * Manages the Esc → confirm → cancel flow:
 *   IDLE → CONFIRM_AGENT (first Esc: "Cancel agent?")
 *   CONFIRM_AGENT → IDLE (second Esc: cancel stream, resets)
 *   CONFIRM_SUBAGENTS → IDLE (third Esc: cancel subagents, resets)
 *
 * Auto-resets after 5 seconds of inactivity.
 *
 * Ported from Python `src/orchid/app.py` (InterruptState, action_interrupt).
 */

import { setup, assign } from 'xstate';
import type { InterruptMachineEvent } from './events';

// ── Context ─────────────────────────────────────────────────────────────────

export interface InterruptContext {
  /** Timestamp of the last interrupt press (for timeout tracking). */
  lastPressTime: number;
}

// ── Machine ─────────────────────────────────────────────────────────────────

/**
 * Interrupt machine — manages the multi-step Esc confirmation flow.
 *
 * States:
 * - `idle`: No interrupt pending. First Esc → `confirmAgent`.
 * - `confirmAgent`: Agent cancel confirmed. Second Esc → cancels stream.
 *   If subagents are running, transitions to `confirmSubagents`.
 * - `confirmSubagents`: Subagent cancel confirmed. Third Esc → cancels subagents.
 *
 * Auto-reset: After 5s with no action, returns to `idle`.
 *
 * Parent (agent machine) should:
 * 1. On entry to `confirmAgent`: display "Cancel agent?" prompt
 * 2. On `confirmAgent` → `idle` (via second Esc): cancel the stream
 * 3. On entry to `confirmSubagents`: display "Cancel subagents?" prompt
 * 4. On `confirmSubagents` → `idle` (via third Esc): cancel subagents
 */
export const interruptMachine = setup({
  types: {
    context: {} as InterruptContext,
    events: {} as InterruptMachineEvent,
  },
}).createMachine({
  id: 'interrupt',
  initial: 'idle',
  context: {
    lastPressTime: 0,
  },
  states: {
    idle: {
      on: {
        INTERRUPT: {
          target: 'confirmAgent',
          actions: assign({
            lastPressTime: () => Date.now(),
          }),
        },
      },
    },

    confirmAgent: {
      on: {
        // Second Esc while confirming agent → cancel stream, reset
        INTERRUPT: {
          target: 'idle',
          actions: assign({
            lastPressTime: () => Date.now(),
          }),
        },
        // Timeout → auto-reset
        INTERRUPT_TIMEOUT: {
          target: 'idle',
          actions: assign({
            lastPressTime: () => 0,
          }),
        },
      },
    },

    confirmSubagents: {
      on: {
        // Third Esc while confirming subagents → cancel subagents, reset
        INTERRUPT: {
          target: 'idle',
          actions: assign({
            lastPressTime: () => Date.now(),
          }),
        },
        // Timeout → auto-reset
        INTERRUPT_TIMEOUT: {
          target: 'idle',
          actions: assign({
            lastPressTime: () => 0,
          }),
        },
      },
    },
  },
});
