import { describe, expect, it, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WorkingSetStore } from '../../src/main/session/working-set';

function tmpStatePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-test-'));
  return path.join(dir, 'ui-state.json');
}

describe('WorkingSetStore', () => {
  let store: WorkingSetStore;

  beforeEach(() => {
    store = new WorkingSetStore({ statePath: tmpStatePath() });
  });

  it('open three in append order; focus last opened', () => {
    store.openOrFocus('a');
    store.openOrFocus('b');
    store.openOrFocus('c');

    const snap = store.getSnapshot();
    expect(snap.openSessionIds).toEqual(['a', 'b', 'c']);
    expect(snap.focusedSessionId).toBe('c');
  });

  it('openOrFocus existing id does not duplicate in open list', () => {
    store.openOrFocus('a');
    store.openOrFocus('b');
    store.openOrFocus('a');

    const snap = store.getSnapshot();
    expect(snap.openSessionIds).toEqual(['a', 'b']);
    expect(snap.focusedSessionId).toBe('a');
  });

  it('close non-focused tab leaves focus unchanged', () => {
    store.openOrFocus('a');
    store.openOrFocus('b');
    store.openOrFocus('c');

    store.close('b');

    const snap = store.getSnapshot();
    expect(snap.openSessionIds).toEqual(['a', 'c']);
    expect(snap.focusedSessionId).toBe('c');
  });

  it('close focused tab picks MRU among remaining', () => {
    store.openOrFocus('a');
    store.openOrFocus('b');
    store.openOrFocus('c');
    // MRU: [c, b, a], focused: c

    // Focus a to bring it to MRU front
    store.setFocus('a');
    // MRU: [a, c, b], focused: a

    store.close('a');
    // Remaining open: [b, c], MRU remaining: [c, b]
    // Focus should be c (first in MRU that is still open)

    const snap = store.getSnapshot();
    expect(snap.openSessionIds).toEqual(['b', 'c']);
    expect(snap.focusedSessionId).toBe('c');
  });

  it('close focused when it is the only tab', () => {
    store.openOrFocus('a');
    store.close('a');

    const snap = store.getSnapshot();
    expect(snap.openSessionIds).toEqual([]);
    expect(snap.focusedSessionId).toBeNull();
  });

  it('remove missing id is a no-op', () => {
    store.openOrFocus('a');
    store.remove('missing');

    const snap = store.getSnapshot();
    expect(snap.openSessionIds).toEqual(['a']);
    expect(snap.focusedSessionId).toBe('a');
  });

  it('filterExisting drops deleted ids and fixes focus', () => {
    store.openOrFocus('a');
    store.openOrFocus('b');
    store.openOrFocus('c');
    store.setFocus('b');

    store.filterExisting(new Set(['a', 'c']));

    const snap = store.getSnapshot();
    expect(snap.openSessionIds).toEqual(['a', 'c']);
    // b was focused but removed, pick MRU among remaining
    // MRU was [b, c, a] (b was last focused), remaining MRU: [c, a]
    expect(snap.focusedSessionId).toBe('c');
  });

  it('filterExisting accepts array input', () => {
    store.openOrFocus('x');
    store.openOrFocus('y');
    store.filterExisting(['x']);

    const snap = store.getSnapshot();
    expect(snap.openSessionIds).toEqual(['x']);
    expect(snap.focusedSessionId).toBe('x');
  });

  it('setFocus on non-open id is ignored', () => {
    store.openOrFocus('a');
    store.setFocus('not-open');

    const snap = store.getSnapshot();
    expect(snap.focusedSessionId).toBe('a');
  });

  it('setFocus(null) clears focus without removing from open', () => {
    store.openOrFocus('a');
    store.setFocus(null);

    const snap = store.getSnapshot();
    expect(snap.openSessionIds).toEqual(['a']);
    expect(snap.focusedSessionId).toBeNull();
  });

  it('setFocus updates MRU order', () => {
    store.openOrFocus('a');
    store.openOrFocus('b');
    store.openOrFocus('c');
    // MRU: [c, b, a]

    store.setFocus('a');
    // MRU: [a, c, b]

    store.close('a');
    // Remaining: [b, c], MRU remaining: [c, b]
    expect(store.getSnapshot().focusedSessionId).toBe('c');
  });

  it('persist and reload restores order and focus', () => {
    const statePath = tmpStatePath();
    const writer = new WorkingSetStore({ statePath });
    writer.openOrFocus('a');
    writer.openOrFocus('b');
    writer.openOrFocus('c');
    writer.setFocus('a');
    writer.saveToDisk();

    const reader = new WorkingSetStore({ statePath });
    reader.loadFromDisk();

    const snap = reader.getSnapshot();
    expect(snap.openSessionIds).toEqual(['a', 'b', 'c']);
    expect(snap.focusedSessionId).toBe('a');
    expect(snap.mruSessionIds).toEqual(['a', 'c', 'b']);
  });

  it('loadFromDisk on missing file keeps empty state', () => {
    const store = new WorkingSetStore({ statePath: '/nonexistent/path/ui-state.json' });
    store.loadFromDisk();

    const snap = store.getSnapshot();
    expect(snap.openSessionIds).toEqual([]);
    expect(snap.focusedSessionId).toBeNull();
    expect(snap.mruSessionIds).toEqual([]);
  });

  it('close missing id is a no-op', () => {
    store.openOrFocus('a');
    store.close('nonexistent');

    const snap = store.getSnapshot();
    expect(snap.openSessionIds).toEqual(['a']);
    expect(snap.focusedSessionId).toBe('a');
  });

  it('MRU tracks focus changes correctly through multiple operations', () => {
    store.openOrFocus('a');
    store.openOrFocus('b');
    store.openOrFocus('c');
    // MRU: [c, b, a], open: [a, b, c]

    store.setFocus('a');
    // MRU: [a, c, b]

    store.setFocus('b');
    // MRU: [b, a, c]

    store.close('b');
    // Remaining open: [a, c], MRU remaining: [a, c]
    expect(store.getSnapshot().focusedSessionId).toBe('a');

    store.close('a');
    // Remaining open: [c]
    expect(store.getSnapshot().focusedSessionId).toBe('c');
  });
});
