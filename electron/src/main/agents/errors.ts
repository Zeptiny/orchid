import type { SubagentState } from './manager';
import type { SubagentAdmissionLimits } from './admission';

export class SubagentWaitTimeoutError extends Error {
  readonly timeoutMs: number;
  readonly statusSnapshot: string[];

  constructor(timeoutMs: number, statusSnapshot: string[]) {
    const seconds = Math.round(timeoutMs / 1000);
    super(
      `Wait timed out after ${seconds}s with no completion. ` +
        `Subagents are still running (${statusSnapshot.join('; ')}). ` +
        `Only the wait tool stopped waiting; they were not cancelled or interrupted. ` +
        `Call wait_for_subagent again or interrupt_subagents to stop them.`,
    );
    this.name = 'SubagentWaitTimeoutError';
    this.timeoutMs = timeoutMs;
    this.statusSnapshot = statusSnapshot;
  }
}

export class SubagentQueueFullError extends Error {
  readonly maxQueued: number;
  readonly maxActiveGlobal: number;
  readonly maxActivePerSession: number;

  constructor(limits: SubagentAdmissionLimits) {
    super(
      `Subagent queue is full (subagents.max_queued=${limits.maxQueued}): all active slots are taken ` +
        `(subagents.max_active_global=${limits.maxActiveGlobal}, ` +
        `subagents.max_active_per_session=${limits.maxActivePerSession}). ` +
        `Wait for running subagents to finish or interrupt them before delegating more.`,
    );
    this.name = 'SubagentQueueFullError';
    this.maxQueued = limits.maxQueued;
    this.maxActiveGlobal = limits.maxActiveGlobal;
    this.maxActivePerSession = limits.maxActivePerSession;
  }
}

export class SubagentNotTerminalError extends Error {
  readonly state: SubagentState;

  constructor(subagentId: string, state: SubagentState) {
    super(
      `Subagent '${subagentId}' is ${state}, not terminal. ` +
        `Only completed, failed, or interrupted subagents can be followed up. ` +
        `Call wait_for_subagent or interrupt_subagents first.`,
    );
    this.name = 'SubagentNotTerminalError';
    this.state = state;
  }
}

export class SubagentClosedError extends Error {
  constructor(subagentId: string) {
    super(`Subagent '${subagentId}' is closed and cannot be followed up.`);
    this.name = 'SubagentClosedError';
  }
}

export class SubagentEvictedError extends Error {
  constructor(subagentId: string) {
    super(
      `Subagent '${subagentId}' is an evicted summary; hydrate it before following up.`,
    );
    this.name = 'SubagentEvictedError';
  }
}

export class SubagentSummaryClosedError extends Error {
  constructor(subagentId: string) {
    super(
      `Subagent '${subagentId}' is an evicted summary; hydrate it before closing.`,
    );
    this.name = 'SubagentSummaryClosedError';
  }
}

export class SubagentStillSettlingError extends Error {
  constructor(subagentId: string) {
    super(
      `Subagent '${subagentId}' is still settling its previous run; retry the follow-up shortly.`,
    );
    this.name = 'SubagentStillSettlingError';
  }
}
