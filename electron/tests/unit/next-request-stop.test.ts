import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearNextRequestStop,
  requestNextRequestStop,
  shouldStopNextRequest,
} from '../../src/main/ipc/next-request-stop';

// The module holds a module-private Set, so state persists across tests in this
// file. Clear the id we use before each case to keep them independent.
const SESSION = 'session-next-request-stop';

describe('next-request-stop', () => {
  beforeEach(() => {
    clearNextRequestStop(SESSION);
  });

  it('returns false for an unknown session', () => {
    expect(shouldStopNextRequest('never-signaled')).toBe(false);
  });

  it('sets the flag after a request', () => {
    requestNextRequestStop(SESSION);
    expect(shouldStopNextRequest(SESSION)).toBe(true);
  });

  it('clears the flag after clear', () => {
    requestNextRequestStop(SESSION);
    clearNextRequestStop(SESSION);
    expect(shouldStopNextRequest(SESSION)).toBe(false);
  });

  it('is idempotent — repeated requests stay set, one clear removes', () => {
    requestNextRequestStop(SESSION);
    requestNextRequestStop(SESSION);
    expect(shouldStopNextRequest(SESSION)).toBe(true);
    clearNextRequestStop(SESSION);
    expect(shouldStopNextRequest(SESSION)).toBe(false);
  });

  it('does not mutate the flag when read', () => {
    requestNextRequestStop(SESSION);
    expect(shouldStopNextRequest(SESSION)).toBe(true);
    // Reading is non-destructive — the flag stays set until cleared.
    expect(shouldStopNextRequest(SESSION)).toBe(true);
  });

  it('keeps sessions independent', () => {
    requestNextRequestStop('session-a');
    requestNextRequestStop('session-b');
    clearNextRequestStop('session-a');
    expect(shouldStopNextRequest('session-a')).toBe(false);
    expect(shouldStopNextRequest('session-b')).toBe(true);
    clearNextRequestStop('session-b');
  });
});
