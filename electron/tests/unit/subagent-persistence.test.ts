import { describe, expect, it } from 'vitest';
import { SubagentPersistence } from '../../src/main/agents/subagent-persistence';

describe('SubagentPersistence', () => {
  it('confirms only the captured terminal revision, preserving a resumed generation', () => {
    const persistence = new SubagentPersistence(() => 2);
    persistence.register('sub-1', 'session-1', { admitted: true });
    persistence.markDirty('sub-1');
    const terminal = persistence.checkpointCandidate('sub-1', 'session-1', true)!;

    persistence.beginFollowUp('sub-1');

    expect(persistence.confirmCheckpoint(terminal)).toEqual({ evict: false, removeIds: [] });
    expect(persistence.checkpointCandidate('sub-1', 'session-1', false)?.revision)
      .toBeGreaterThan(terminal.revision);
    expect(persistence.isSummary('sub-1')).toBe(false);
  });

  it('retains summaries FIFO and resets checkpoint eligibility when rehydrated', () => {
    const persistence = new SubagentPersistence(() => 1);
    persistence.register('old', 'session-1', { admitted: true });
    persistence.register('new', 'session-1', { admitted: true });

    const old = persistence.checkpointCandidate('old', 'session-1', true)!;
    expect(persistence.confirmCheckpoint(old)).toEqual({ evict: true, removeIds: [] });
    const recent = persistence.checkpointCandidate('new', 'session-1', true)!;
    expect(persistence.confirmCheckpoint(recent)).toEqual({ evict: true, removeIds: ['old'] });

    persistence.rehydrate('new', 'session-1');
    persistence.markDirty('new');
    expect(persistence.checkpointCandidate('new', 'session-1', false)?.revision).toBe(1);
    expect(persistence.isSummary('new')).toBe(false);
  });

  it('tracks confirmed sessions for recovery and clears every owned policy fact', () => {
    const persistence = new SubagentPersistence(() => 2);
    persistence.register('sub-1', 'session-1', { admitted: true });
    persistence.confirmCheckpoint(persistence.checkpointCandidate('sub-1', 'session-1', false)!);

    expect(persistence.trackedSessions()).toEqual(['session-1']);
    persistence.clearSession('session-1');
    expect(persistence.trackedSessions()).toEqual([]);
    expect(persistence.needsHydration('sub-1')).toBe(true);
  });

  it('rejects a terminal confirmation captured before the same id is rehydrated', () => {
    const persistence = new SubagentPersistence(() => 2);
    persistence.register('sub-1', 'session-1', { admitted: true });
    persistence.markDirty('sub-1');
    const stale = persistence.checkpointCandidate('sub-1', 'session-1', true)!;
    expect(persistence.confirmCheckpoint(stale).evict).toBe(true);

    persistence.rehydrate('sub-1', 'session-1');
    persistence.markDirty('sub-1');
    const current = persistence.checkpointCandidate('sub-1', 'session-1', true)!;
    expect(current.revision).toBe(stale.revision);

    expect(persistence.confirmCheckpoint(stale)).toEqual({ evict: false, removeIds: [] });
    expect(persistence.isSummary('sub-1')).toBe(false);
    expect(persistence.checkpointCandidate('sub-1', 'session-1', true)?.revision)
      .toBe(current.revision);
  });

  it('uses the legacy empty-session FIFO for undurable queued cancellations', () => {
    const persistence = new SubagentPersistence(() => 1);
    persistence.register('old', null, { admitted: false });
    expect(persistence.summarizeUndurable('old')).toEqual({ evict: true, removeIds: [] });

    persistence.register('new', null, { admitted: false });
    expect(persistence.summarizeUndurable('new')).toEqual({ evict: true, removeIds: ['old'] });
  });
});
