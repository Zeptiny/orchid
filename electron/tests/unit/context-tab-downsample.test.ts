// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { downsamplePoints } from '../../src/renderer/components/analytics/ContextTab';

function series(usedTokens: number[]): Array<{ capturedAt: string; usedTokens: number }> {
  return usedTokens.map((tokens, i) => ({
    capturedAt: `2026-07-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
    usedTokens: tokens,
  }));
}

describe('downsamplePoints (Context chart display sampling)', () => {
  it('passes series at or under the cap through unchanged', () => {
    const points = series([100, 200, 300]);
    expect(downsamplePoints(points, 200)).toBe(points);
  });

  it('stride-samples oversize series and keeps the newest point', () => {
    const points = series(Array.from({ length: 1001 }, (_, i) => i));
    const sampled = downsamplePoints(points, 200) as Array<{ capturedAt: string; usedTokens: number }>;
    const stride = Math.ceil(1001 / 200);
    expect(sampled.length).toBeLessThanOrEqual(201);
    expect(sampled[0].usedTokens).toBe(0);
    expect(sampled[1].usedTokens).toBe(stride);
    expect(sampled[sampled.length - 1]).toBe(points[points.length - 1]);
    expect(sampled[sampled.length - 1].usedTokens).toBe(1000);
    expect(sampled[sampled.length - 2].usedTokens).toBe(996);
  });

  it('keeps the peak point even when it falls between stride steps', () => {
    const points = series([10, 50, 90, 40, 30, 20, 5]);
    const sampled = downsamplePoints(points, 3) as Array<{ capturedAt: string; usedTokens: number }>;
    expect(sampled.some((p) => p.usedTokens === 90)).toBe(true);
    expect(sampled[sampled.length - 1].usedTokens).toBe(5);
  });

  it('preserves chronological ordering after peak insertion', () => {
    const points = series([10, 20, 500, 30, 40]);
    const sampled = downsamplePoints(points, 3) as Array<{ capturedAt: string; usedTokens: number }>;
    const capturedAt = sampled.map((p) => p.capturedAt);
    expect(capturedAt).toEqual([...capturedAt].sort());
  });
});
