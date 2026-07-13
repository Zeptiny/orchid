import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaults } from '../../src/main/config/schema';

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
}));

vi.mock('../../src/main/config/loader', () => ({
  getConfig: mocks.getConfig,
}));

describe('getRuntimeConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the sanitized config without legacy alias-keyed credential hydration', async () => {
    const stored = defaults();
    mocks.getConfig.mockReturnValue(stored);

    const { getRuntimeConfig } = await import('../../src/main/config/runtime');
    const { resolveModelRef } = await import('../../src/main/llm/providers');
    const result = await getRuntimeConfig();

    expect(mocks.getConfig).toHaveBeenCalledOnce();
    expect(result).toBe(stored);
    expect(result.providers).toEqual({});
    expect(() => resolveModelRef('legacy/model', result)).toThrow('typed model selection');
  });
});
