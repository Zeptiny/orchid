import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaults } from '../../src/main/config/schema';

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  injectKeychainKeys: vi.fn(),
}));

vi.mock('../../src/main/config/loader', () => ({
  getConfig: mocks.getConfig,
}));

vi.mock('../../src/main/config/keychain', () => ({
  injectKeychainKeys: mocks.injectKeychainKeys,
}));

describe('getRuntimeConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns config with provider keys rehydrated from the keychain', async () => {
    const stored = defaults();
    const hydrated = {
      ...stored,
      providers: {
        ...stored.providers,
        default: {
          ...stored.providers.default,
          api_key: 'sk-runtime-secret',
        },
      },
    };
    mocks.getConfig.mockReturnValue(stored);
    mocks.injectKeychainKeys.mockResolvedValue(hydrated);

    const { getRuntimeConfig } = await import('../../src/main/config/runtime');
    const { resolveModelRef } = await import('../../src/main/llm/providers');
    const result = await getRuntimeConfig();

    expect(mocks.injectKeychainKeys).toHaveBeenCalledWith(stored);
    expect(result).toEqual(hydrated);
    expect(resolveModelRef('default/mimo-v2.5', result).apiKey).toBe(
      'sk-runtime-secret',
    );
  });
});
