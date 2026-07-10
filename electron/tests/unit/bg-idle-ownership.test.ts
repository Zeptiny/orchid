/**
 * Background command idle ownership reclaim (P0-5b).
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { BackgroundProcessStore } from '../../src/main/tools/process/background-store';

describe('BackgroundProcessStore.checkIdleOwnership', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reclaims USER ownership after idle timeout', () => {
    const store = new BackgroundProcessStore();
    // Inject a fake entry without spawning a process
    const entry = {
      id: 1,
      command: 'sleep 999',
      process: {} as never,
      buffer: { getTail: () => '' } as never,
      owner: 'USER' as const,
      lastOutputAt: Date.now(),
      lastUserInputAt: Date.now(),
      exitCode: null,
      createdAt: Date.now(),
      interactive: true,
      sessionId: null,
      agentScopeId: 'main',
      description: '',
      drainAbort: null,
    };
    // Access private map via cast for unit isolation
    (store as unknown as { _entries: Map<number, typeof entry> })._entries.set(1, entry);

    // Still within timeout
    store.checkIdleOwnership(60_000);
    expect(entry.owner).toBe('USER');

    // Advance past lastUserInputAt + timeout
    vi.advanceTimersByTime(61_000);
    // lastUserInputAt is wall-clock Date.now() at creation; with fake timers
    // we need to set it explicitly relative to "now"
    entry.lastUserInputAt = Date.now() - 61_000;
    store.checkIdleOwnership(60_000);
    expect(entry.owner).toBe('AGENT');
  });
});
