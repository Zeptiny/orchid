import { describe, it, expect } from 'vitest';
import { seedReasoningConfig } from '../../src/main/providers/connection-store';
import type { CatalogModel } from '../../src/main/providers/catalog/schema';
import type { ProviderConnection } from '../../src/shared/types/provider';

function makeCatalogModel(overrides: Partial<CatalogModel> & { id: string }): CatalogModel {
  return {
    displayName: overrides.id,
    protocol: 'openai-compatible',
    capabilities: {
      inputModalities: ['text'],
      outputModalities: ['text'],
      tools: true,
      reasoning: true,
    },
    limits: { contextTokens: 128000, outputTokens: 16384 },
    lifecycle: 'active',
    pricing: {
      currency: 'USD',
      effectiveAt: '2026-01-01T00:00:00.000Z',
      rates: {},
      provenance: { source: 'catalog' },
    },
    provenance: { source: 'catalog' },
    ...overrides,
  } as CatalogModel;
}

function makeConnection(
  overrides: Partial<Pick<ProviderConnection, 'modelIds' | 'reasoningConfig'>> = {},
): Pick<ProviderConnection, 'modelIds' | 'reasoningConfig'> {
  return {
    modelIds: overrides.modelIds ?? ['o3'],
    reasoningConfig: overrides.reasoningConfig,
  };
}

describe('seedReasoningConfig', () => {
  it('seeds o3 model with [low, medium, high] and default medium', () => {
    const catalogModels = [
      makeCatalogModel({
        id: 'o3',
        reasoningLevels: ['low', 'medium', 'high'],
        reasoningDefault: 'medium',
      }),
    ];
    const connection = makeConnection({ modelIds: ['o3'] });

    const result = seedReasoningConfig(connection, catalogModels);

    expect(result).toEqual({
      o3: { levels: ['low', 'medium', 'high'], default: 'medium' },
    });
  });

  it('does not overwrite existing user-modified reasoningConfig', () => {
    const catalogModels = [
      makeCatalogModel({
        id: 'o3',
        reasoningLevels: ['low', 'medium', 'high'],
        reasoningDefault: 'medium',
      }),
    ];
    const connection = makeConnection({
      modelIds: ['o3'],
      reasoningConfig: {
        o3: { levels: ['low', 'high'], default: 'high' },
      },
    });

    const result = seedReasoningConfig(connection, catalogModels);

    expect(result).toEqual({
      o3: { levels: ['low', 'high'], default: 'high' },
    });
  });

  it('does not seed model without reasoning capability', () => {
    const catalogModels = [
      makeCatalogModel({
        id: 'gpt-4o',
        capabilities: {
          inputModalities: ['text'],
          outputModalities: ['text'],
          tools: true,
          reasoning: false,
        },
        reasoningLevels: ['low', 'medium', 'high'],
        reasoningDefault: 'medium',
      }),
    ];
    const connection = makeConnection({ modelIds: ['gpt-4o'] });

    const result = seedReasoningConfig(connection, catalogModels);

    expect(result).toBeUndefined();
  });

  it('does not seed catalog model without reasoningLevels field', () => {
    const catalogModels = [
      makeCatalogModel({ id: 'o3' }),
    ];
    const connection = makeConnection({ modelIds: ['o3'] });

    const result = seedReasoningConfig(connection, catalogModels);

    expect(result).toBeUndefined();
  });

  it('seeds only absent entries and preserves existing ones', () => {
    const catalogModels = [
      makeCatalogModel({
        id: 'o3',
        reasoningLevels: ['low', 'medium', 'high'],
        reasoningDefault: 'medium',
      }),
      makeCatalogModel({
        id: 'o4-mini',
        reasoningLevels: ['low', 'medium', 'high'],
        reasoningDefault: 'medium',
      }),
    ];
    const connection = makeConnection({
      modelIds: ['o3', 'o4-mini'],
      reasoningConfig: {
        o3: { levels: ['custom'], default: 'custom' },
      },
    });

    const result = seedReasoningConfig(connection, catalogModels);

    expect(result).toEqual({
      o3: { levels: ['custom'], default: 'custom' },
      'o4-mini': { levels: ['low', 'medium', 'high'], default: 'medium' },
    });
  });

  it('skips models not present in catalog', () => {
    const catalogModels = [
      makeCatalogModel({
        id: 'o3',
        reasoningLevels: ['low', 'medium', 'high'],
        reasoningDefault: 'medium',
      }),
    ];
    const connection = makeConnection({ modelIds: ['unknown-model'] });

    const result = seedReasoningConfig(connection, catalogModels);

    expect(result).toBeUndefined();
  });

  it('uses null default when reasoningDefault is not specified', () => {
    const catalogModels = [
      makeCatalogModel({
        id: 'o3',
        reasoningLevels: ['low', 'high'],
      }),
    ];
    const connection = makeConnection({ modelIds: ['o3'] });

    const result = seedReasoningConfig(connection, catalogModels);

    expect(result).toEqual({
      o3: { levels: ['low', 'high'], default: null },
    });
  });

  it('supports numeric reasoningDefault', () => {
    const catalogModels = [
      makeCatalogModel({
        id: 'claude-op-4',
        protocol: 'anthropic-messages',
        reasoningLevels: ['low', 'medium', 'high'],
        reasoningDefault: 8192,
      }),
    ];
    const connection = makeConnection({ modelIds: ['claude-op-4'] });

    const result = seedReasoningConfig(connection, catalogModels);

    expect(result).toEqual({
      'claude-op-4': { levels: ['low', 'medium', 'high'], default: 8192 },
    });
  });

  it('covers AE6: fresh connection with o3 gets levels pre-populated', () => {
    const catalogModels = [
      makeCatalogModel({
        id: 'o3',
        reasoningLevels: ['low', 'medium', 'high'],
        reasoningDefault: 'medium',
      }),
    ];
    const connection = makeConnection({ modelIds: ['o3'] });

    const result = seedReasoningConfig(connection, catalogModels);

    expect(result).toBeDefined();
    expect(result!['o3'].levels).toEqual(['low', 'medium', 'high']);
    expect(result!['o3'].default).toBe('medium');
  });
});
