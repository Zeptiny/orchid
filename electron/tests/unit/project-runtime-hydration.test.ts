import { describe, expect, it, vi } from 'vitest';
import type { ProjectRuntime } from '../../src/main/project/runtime';
import { resolveModelRef } from '../../src/main/llm/providers';

const mocks = vi.hoisted(() => ({
  injectKeychainKeys: vi.fn(async (config: Record<string, unknown>) => ({
    ...config,
    providers: {
      default: {
        ...((config.providers as Record<string, Record<string, unknown>>).default),
        api_key: 'key-restored-from-keychain',
      },
    },
  })),
}));

vi.mock('../../src/main/config/keychain', () => ({
  injectKeychainKeys: mocks.injectKeychainKeys,
}));

import { hydrateProjectRuntime } from '../../src/main/project/runtime';

describe('hydrateProjectRuntime', () => {
  it('restores provider keys into a distinct frozen turn snapshot', async () => {
    const runtime = {
      projectDir: '/projects/orchid',
      config: {
        providers: {
          default: { base_url: 'https://provider.example/v1' },
        },
      },
      agents: new Map(),
      skills: new Map(),
      personalities: new Map(),
    } as unknown as ProjectRuntime;

    const hydrated = await hydrateProjectRuntime(runtime);

    expect(mocks.injectKeychainKeys).toHaveBeenCalledWith(runtime.config);
    expect(hydrated).not.toBe(runtime);
    expect(hydrated.agents).toBe(runtime.agents);
    expect(hydrated.config.providers.default?.api_key).toBe(
      'key-restored-from-keychain',
    );
    expect(
      resolveModelRef('default/test-model', hydrated.config).apiKey,
    ).toBe('key-restored-from-keychain');
    expect(runtime.config.providers.default?.api_key).toBeUndefined();
    expect(Object.isFrozen(hydrated)).toBe(true);
  });
});
