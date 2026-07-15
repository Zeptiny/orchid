import { describe, expect, it } from 'vitest';
import { defaults } from '../../src/main/config/schema';
import { hydrateProjectRuntime, type ProjectRuntime } from '../../src/main/project/runtime';

describe('hydrateProjectRuntime', () => {
  it('keeps the frozen typed-selection snapshot unchanged without legacy key hydration', async () => {
    const runtime = Object.freeze({
      projectDir: '/projects/orchid',
      config: {
        ...defaults(),
        default_model: {
          connectionId: '11111111-1111-4111-8111-111111111111',
          modelId: 'vendor/models/gpt-4o',
        },
      },
      agents: new Map(),
      skills: new Map(),
      personalities: new Map(),
    }) as ProjectRuntime;

    const hydrated = await hydrateProjectRuntime(runtime);

    expect(hydrated).toBe(runtime);
    expect(hydrated.config.default_model).toEqual({
      connectionId: '11111111-1111-4111-8111-111111111111',
      modelId: 'vendor/models/gpt-4o',
    });
    expect(hydrated.config.providers).toEqual({});
    expect(Object.isFrozen(hydrated)).toBe(true);
  });
});
