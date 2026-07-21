import { describe, it, expect } from 'vitest';
import {
  providerConnectionSchema,
  reasoningModelConfigSchema,
} from '../../src/shared/types/provider';
import { configSchema } from '../../src/main/config/schema';
import type { Agent, AgentTier, AgentType } from '../../src/shared/types/agent';

const baseConnection = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  providerId: 'openai',
  name: 'Test Connection',
  protocol: 'openai-compatible' as const,
  authMethod: 'api-key' as const,
  credential: { kind: 'stored' as const, handle: 'test-handle' },
  modelIds: ['gpt-4o'],
  health: 'ready' as const,
};

describe('reasoningModelConfigSchema', () => {
  it('parses valid config with levels and default', () => {
    const result = reasoningModelConfigSchema.safeParse({
      levels: ['low', 'medium', 'high'],
      default: 'medium',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.levels).toEqual(['low', 'medium', 'high']);
      expect(result.data.default).toBe('medium');
    }
  });

  it('parses config with numeric default', () => {
    const result = reasoningModelConfigSchema.safeParse({
      levels: ['low', 'high'],
      default: 8192,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.default).toBe(8192);
    }
  });

  it('parses config with null default', () => {
    const result = reasoningModelConfigSchema.safeParse({
      levels: ['low', 'high'],
      default: null,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.default).toBeNull();
    }
  });

  it('rejects empty levels array', () => {
    const result = reasoningModelConfigSchema.safeParse({
      levels: [],
      default: 'high',
    });
    expect(result.success).toBe(false);
  });
});

describe('providerConnectionSchema with reasoningConfig', () => {
  it('parses connection with reasoningConfig', () => {
    const result = providerConnectionSchema.safeParse({
      ...baseConnection,
      reasoningConfig: {
        'o3-mini': { levels: ['low', 'medium', 'high'], default: 'medium' },
        'gpt-4o': { levels: ['low', 'high'], default: 4096 },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.reasoningConfig?.['o3-mini']?.levels).toEqual([
        'low',
        'medium',
        'high',
      ]);
      expect(result.data.reasoningConfig?.['gpt-4o']?.default).toBe(4096);
    }
  });

  it('parses connection without reasoningConfig (backward compat)', () => {
    const result = providerConnectionSchema.safeParse(baseConnection);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.reasoningConfig).toBeUndefined();
    }
  });

  it('rejects reasoningConfig with empty levels', () => {
    const result = providerConnectionSchema.safeParse({
      ...baseConnection,
      reasoningConfig: {
        'bad-model': { levels: [], default: 'high' },
      },
    });
    expect(result.success).toBe(false);
  });
});

describe('configSchema tier_reasoning_effort', () => {
  it('parses tier_reasoning_effort with mixed values', () => {
    const result = configSchema.safeParse({
      tier_reasoning_effort: {
        seed: 'low',
        sprout: 4096,
        bloom: null,
        crown: 'high',
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tier_reasoning_effort).toEqual({
        seed: 'low',
        sprout: 4096,
        bloom: null,
        crown: 'high',
      });
    }
  });

  it('defaults tier_reasoning_effort to all-null tiers', () => {
    const result = configSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tier_reasoning_effort).toEqual({
        seed: null,
        sprout: null,
        bloom: null,
        crown: null,
      });
    }
  });

  it('accepts unknown tier keys (open record)', () => {
    const result = configSchema.safeParse({
      tier_reasoning_effort: {
        seed: null,
        custom_tier: 'high',
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tier_reasoning_effort['custom_tier']).toBe('high');
    }
  });
});

describe('Agent reasoning_effort', () => {
  it('accepts numeric reasoning_effort', () => {
    const agent: Agent = {
      name: 'test-agent',
      type: 'subagent' as AgentType,
      tier: 'bloom' as AgentTier,
      description: 'Test agent',
      system_prompt: 'You are a test agent.',
      allowed_tools: [],
      allowed_skills: [],
      reasoning_effort: 8192,
    };
    expect(agent.reasoning_effort).toBe(8192);
  });

  it('accepts text reasoning_effort', () => {
    const agent: Agent = {
      name: 'test-agent',
      type: 'subagent' as AgentType,
      tier: 'crown' as AgentTier,
      description: 'Test agent',
      system_prompt: 'You are a test agent.',
      allowed_tools: [],
      allowed_skills: [],
      reasoning_effort: 'high',
    };
    expect(agent.reasoning_effort).toBe('high');
  });

  it('allows omitting reasoning_effort', () => {
    const agent: Agent = {
      name: 'test-agent',
      type: 'internal' as AgentType,
      tier: 'seed' as AgentTier,
      description: 'Test agent',
      system_prompt: 'You are a test agent.',
      allowed_tools: [],
      allowed_skills: [],
    };
    expect(agent.reasoning_effort).toBeUndefined();
  });
});
