import { describe, expect, it } from 'vitest';
import { shouldRefreshSubagentsAfterTurn } from '../../src/renderer/utils/subagent-refresh';

describe('subagent turn-completion refresh', () => {
  it('refreshes only when the same session transitions from active to idle', () => {
    expect(shouldRefreshSubagentsAfterTurn(
      { sessionId: 'session-a', status: 'streaming' },
      { sessionId: 'session-a', status: 'idle' },
    )).toBe(true);

    expect(shouldRefreshSubagentsAfterTurn(
      { sessionId: 'session-a', status: 'idle' },
      { sessionId: 'session-a', status: 'idle' },
    )).toBe(false);
    expect(shouldRefreshSubagentsAfterTurn(
      { sessionId: 'session-a', status: 'idle' },
      { sessionId: 'session-b', status: 'idle' },
    )).toBe(false);
    expect(shouldRefreshSubagentsAfterTurn(
      { sessionId: null, status: 'idle' },
      { sessionId: 'session-a', status: 'idle' },
    )).toBe(false);
  });
});
