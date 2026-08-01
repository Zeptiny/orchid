export const SubagentState = {
  QUEUED: 'queued',
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  INTERRUPTED: 'interrupted',
} as const;

export type SubagentState = (typeof SubagentState)[keyof typeof SubagentState];

const TERMINAL_SUBAGENT_STATES = new Set<SubagentState>([
  SubagentState.COMPLETED,
  SubagentState.FAILED,
  SubagentState.INTERRUPTED,
]);

export function isTerminalSubagentState(state: SubagentState): boolean {
  return TERMINAL_SUBAGENT_STATES.has(state);
}
