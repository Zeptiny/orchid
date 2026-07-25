import { describe, expect, it } from 'vitest';
import { formatChainTokens } from '../../src/renderer/components/ChainFooter';

describe('chain footer token formatting', () => {
  it('formats thousands and millions with compact units', () => {
    expect(formatChainTokens(999)).toBe('999');
    expect(formatChainTokens(1_000)).toBe('1.0k');
    expect(formatChainTokens(1_000_000)).toBe('1.0M');
    expect(formatChainTokens(2_450_000)).toBe('2.5M');
  });
});
