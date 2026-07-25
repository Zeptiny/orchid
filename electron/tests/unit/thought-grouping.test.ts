/**
 * Unit tests for consecutive thought-activity grouping (option A).
 */
import { describe, expect, it } from 'vitest';
import {
  estimateThoughtDurationMs,
  foldConsecutiveWhere,
  formatDurationMs,
  summarizeThoughtGroup,
} from '../../src/renderer/utils/thought-grouping';

describe('estimateThoughtDurationMs / formatDurationMs', () => {
  it('returns null for empty content', () => {
    expect(estimateThoughtDurationMs('')).toBeNull();
  });

  it('clamps and formats', () => {
    const ms = estimateThoughtDurationMs('x'.repeat(100));
    expect(ms).toBeGreaterThanOrEqual(40);
    expect(formatDurationMs(210)).toBe('210ms');
    expect(formatDurationMs(1500)).toBe('1.5s');
  });
});

describe('summarizeThoughtGroup', () => {
  it('sums durations and shows segment count', () => {
    const a = 'a'.repeat(20); // ~70ms
    const b = 'b'.repeat(40); // ~140ms
    const summary = summarizeThoughtGroup([
      { id: '1', content: a },
      { id: '2', content: b },
    ]);
    expect(summary.segmentCount).toBe(2);
    expect(summary.isStreaming).toBe(false);
    expect(summary.title).toMatch(/^Thought /);
    expect(summary.title).toContain(' · 2');
    expect(summary.totalMs).toBe(
      (estimateThoughtDurationMs(a) ?? 0) + (estimateThoughtDurationMs(b) ?? 0),
    );
  });

  it('uses Thinking… while any segment streams', () => {
    const summary = summarizeThoughtGroup([
      { id: '1', content: 'done', isStreaming: false },
      { id: '2', content: 'partial', isStreaming: true },
    ]);
    expect(summary.title).toBe('Thinking… · 2');
    expect(summary.isStreaming).toBe(true);
  });

  it('single streaming segment has no count suffix', () => {
    const summary = summarizeThoughtGroup([
      { id: '1', content: '', isStreaming: true },
    ]);
    expect(summary.title).toBe('Thinking…');
  });
});

describe('foldConsecutiveWhere (thought adjacency)', () => {
  type Item =
    | { kind: 'thought'; id: string }
    | { kind: 'tool'; id: string }
    | { kind: 'group'; ids: string[] };

  function fold(items: Item[]): Item[] {
    return foldConsecutiveWhere(
      items,
      (item) => item.kind === 'thought',
      (matched) => ({
        kind: 'group',
        ids: matched.map((m) => (m as { kind: 'thought'; id: string }).id),
      }),
    );
  }

  it('groups consecutive thoughts (n >= 2)', () => {
    expect(
      fold([
        { kind: 'thought', id: 't1' },
        { kind: 'thought', id: 't2' },
        { kind: 'thought', id: 't3' },
      ]),
    ).toEqual([{ kind: 'group', ids: ['t1', 't2', 't3'] }]);
  });

  it('does not group a single thought', () => {
    expect(fold([{ kind: 'thought', id: 't1' }])).toEqual([
      { kind: 'thought', id: 't1' },
    ]);
  });

  it('breaks on tools (interleaved thoughts stay separate)', () => {
    // Matches the user's screenshot pattern: thought · tools · thought · tools
    expect(
      fold([
        { kind: 'thought', id: 't1' },
        { kind: 'tool', id: 'g1' },
        { kind: 'thought', id: 't2' },
        { kind: 'tool', id: 'g2' },
        { kind: 'thought', id: 't3' },
      ]),
    ).toEqual([
      { kind: 'thought', id: 't1' },
      { kind: 'tool', id: 'g1' },
      { kind: 'thought', id: 't2' },
      { kind: 'tool', id: 'g2' },
      { kind: 'thought', id: 't3' },
    ]);
  });

  it('groups only the consecutive runs', () => {
    expect(
      fold([
        { kind: 'thought', id: 't1' },
        { kind: 'thought', id: 't2' },
        { kind: 'tool', id: 'g1' },
        { kind: 'thought', id: 't3' },
        { kind: 'thought', id: 't4' },
      ]),
    ).toEqual([
      { kind: 'group', ids: ['t1', 't2'] },
      { kind: 'tool', id: 'g1' },
      { kind: 'group', ids: ['t3', 't4'] },
    ]);
  });
});
