import { describe, it, expect } from 'vitest';
import {
  resolveMainAgentEffort,
  resolveSubagentEffort,
} from '../../src/main/llm/reasoning-effort';
import type { ReasoningModelConfig } from '../../src/shared/types/provider';

const connectionWith = (
  modelId: string,
  config: ReasoningModelConfig,
) => ({ reasoningConfig: { [modelId]: config } });

const noConnection = {};

describe('resolveMainAgentEffort', () => {
  it('returns session override when set', () => {
    const result = resolveMainAgentEffort(
      { reasoningEffortOverride: 'high' },
      connectionWith('o3', { levels: ['low', 'high'], default: 'low' }),
      'o3',
      true,
    );
    expect(result).toBe('high');
  });

  it('falls back to connection default without override', () => {
    const result = resolveMainAgentEffort(
      { reasoningEffortOverride: null },
      connectionWith('o3', { levels: ['low', 'high'], default: 'medium' }),
      'o3',
      true,
    );
    expect(result).toBe('medium');
  });

  it('returns undefined when model does not support reasoning', () => {
    const result = resolveMainAgentEffort(
      { reasoningEffortOverride: 'high' },
      connectionWith('gpt-4o', { levels: ['low', 'high'], default: 'high' }),
      'gpt-4o',
      false,
    );
    expect(result).toBeUndefined();
  });

  it('returns undefined when no effort is configured anywhere', () => {
    const result = resolveMainAgentEffort(
      { reasoningEffortOverride: null },
      noConnection,
      'gpt-4o',
      true,
    );
    expect(result).toBeUndefined();
  });

  it('returns undefined when connection default is null', () => {
    const result = resolveMainAgentEffort(
      { reasoningEffortOverride: null },
      connectionWith('o3', { levels: ['low', 'high'], default: null }),
      'o3',
      true,
    );
    expect(result).toBeUndefined();
  });

  it('passes numeric override through unchanged', () => {
    const result = resolveMainAgentEffort(
      { reasoningEffortOverride: 8192 },
      noConnection,
      'claude-opus-4',
      true,
    );
    expect(result).toBe(8192);
  });

  it('passes numeric connection default through unchanged', () => {
    const result = resolveMainAgentEffort(
      { reasoningEffortOverride: null },
      connectionWith('claude-opus-4', { levels: ['low', 'high'], default: 4096 }),
      'claude-opus-4',
      true,
    );
    expect(result).toBe(4096);
  });

  it('returns undefined for model missing from reasoningConfig', () => {
    const result = resolveMainAgentEffort(
      { reasoningEffortOverride: null },
      connectionWith('o3', { levels: ['low', 'high'], default: 'high' }),
      'gpt-4o',
      true,
    );
    expect(result).toBeUndefined();
  });
});

describe('resolveSubagentEffort', () => {
  const noTierConfig = { tier_reasoning_effort: {} };
  const allNullTiers = {
    tier_reasoning_effort: {
      seed: null,
      sprout: null,
      bloom: null,
      crown: null,
    },
  };

  it('returns agent definition field when set', () => {
    const result = resolveSubagentEffort(
      { reasoning_effort: 'high', tier: 'bloom' },
      { tier_reasoning_effort: { bloom: 'low' } },
      connectionWith('o3', { levels: ['low', 'high'], default: 'low' }),
      'o3',
      true,
    );
    expect(result).toBe('high');
  });

  it('falls back to tier config without agent field', () => {
    const result = resolveSubagentEffort(
      { tier: 'seed' },
      { tier_reasoning_effort: { seed: 'low' } },
      noConnection,
      'o3',
      true,
    );
    expect(result).toBe('low');
  });

  it('falls back to connection default without tier config', () => {
    const result = resolveSubagentEffort(
      { tier: 'crown' },
      noTierConfig,
      connectionWith('o3', { levels: ['low', 'high'], default: 'medium' }),
      'o3',
      true,
    );
    expect(result).toBe('medium');
  });

  it('returns undefined when model does not support reasoning', () => {
    const result = resolveSubagentEffort(
      { reasoning_effort: 'high', tier: 'bloom' },
      { tier_reasoning_effort: { bloom: 'high' } },
      connectionWith('gpt-4o', { levels: ['low', 'high'], default: 'high' }),
      'gpt-4o',
      false,
    );
    expect(result).toBeUndefined();
  });

  it('returns undefined when all levels are empty or null', () => {
    const result = resolveSubagentEffort(
      { tier: 'seed' },
      allNullTiers,
      noConnection,
      'o3',
      true,
    );
    expect(result).toBeUndefined();
  });

  it('passes numeric agent effort through unchanged', () => {
    const result = resolveSubagentEffort(
      { reasoning_effort: 8192, tier: 'crown' },
      allNullTiers,
      noConnection,
      'claude-opus-4',
      true,
    );
    expect(result).toBe(8192);
  });

  it('passes numeric tier effort through unchanged', () => {
    const result = resolveSubagentEffort(
      { tier: 'sprout' },
      { tier_reasoning_effort: { sprout: 2048 } },
      noConnection,
      'o3',
      true,
    );
    expect(result).toBe(2048);
  });

  it('skips null tier config and falls back to connection default', () => {
    const result = resolveSubagentEffort(
      { tier: 'bloom' },
      { tier_reasoning_effort: { bloom: null } },
      connectionWith('o3', { levels: ['low', 'high'], default: 'high' }),
      'o3',
      true,
    );
    expect(result).toBe('high');
  });

  it('AE3: tier_reasoning_effort.seed = "low" and seed agent with no field returns "low"', () => {
    const result = resolveSubagentEffort(
      { tier: 'seed' },
      { tier_reasoning_effort: { seed: 'low', sprout: null, bloom: null, crown: null } },
      noConnection,
      'o3-mini',
      true,
    );
    expect(result).toBe('low');
  });

  it('AE4: tier_reasoning_effort.bloom = "medium" and bloom agent with field "high" returns "high"', () => {
    const result = resolveSubagentEffort(
      { reasoning_effort: 'high', tier: 'bloom' },
      { tier_reasoning_effort: { seed: null, sprout: null, bloom: 'medium', crown: null } },
      noConnection,
      'o3-mini',
      true,
    );
    expect(result).toBe('high');
  });
});
