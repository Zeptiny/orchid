export const SubagentState = {
  QUEUED: 'queued',
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  INTERRUPTED: 'interrupted',
} as const;

export type SubagentState = (typeof SubagentState)[keyof typeof SubagentState];
