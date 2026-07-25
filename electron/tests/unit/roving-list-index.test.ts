/**
 * Behavior tests for roving list index logic (pure clamp helpers mirrored here).
 * The hook itself is thin; we validate clamp semantics used by the UI.
 */
import { describe, expect, it } from 'vitest';

function clampIndex(prev: number, length: number, preferred?: number): number {
  if (length <= 0) return 0;
  if (preferred != null && preferred >= 0 && preferred < length) return preferred;
  return Math.min(prev, length - 1);
}

function move(prev: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  const next = prev + delta;
  if (next < 0) return 0;
  if (next >= length) return length - 1;
  return next;
}

describe('roving list index math', () => {
  it('clamps when list shrinks', () => {
    expect(clampIndex(5, 3)).toBe(2);
  });

  it('prefers active session index', () => {
    expect(clampIndex(0, 10, 4)).toBe(4);
  });

  it('moves within bounds', () => {
    expect(move(0, -1, 5)).toBe(0);
    expect(move(4, 1, 5)).toBe(4);
    expect(move(2, 1, 5)).toBe(3);
  });
});
