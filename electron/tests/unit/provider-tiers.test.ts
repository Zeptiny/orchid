/**
 * Service tier facet — resolution, variant mapping, opt-in behavior, grouping,
 * and served-tier evidence (R19–R23).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyVariantTier,
  buildTierProviderOptions,
  declaredTier,
  extractServedTier,
  groupTierVariantRows,
  resolveMainAgentTier,
  resolveSubagentTier,
  tierVariantModelId,
} from '../../src/main/providers/facets/tiers';
import { tierBaseModelId } from '../../src/shared/types/provider';
import { NEURALWATT_TIER_MECHANISM } from '../../src/main/providers/drivers/neuralwatt';
import { OPENAI_TIER_MECHANISM } from '../../src/main/providers/drivers/native';
import type { TierMechanism } from '../../src/shared/types/provider-facets';
import type { EffectiveModel } from '../../src/shared/types/provider';
import { ProviderRuntime } from '../../src/main/providers';
import { ProviderDriverRegistry } from '../../src/main/providers/drivers/registry';
import { ProviderResolutionError } from '../../src/main/llm/middleware/error-classification';
import type { ProviderConnection, ProviderDefinition } from '../../src/shared/types/provider';
import type { ProviderDriver } from '../../src/main/providers/drivers/types';

const variantMechanism: TierMechanism = NEURALWATT_TIER_MECHANISM;
const parameterMechanism: TierMechanism = OPENAI_TIER_MECHANISM;

function model(id: string): EffectiveModel {
  return {
    id,
    displayName: id,
    protocol: 'openai-compatible',
    source: 'catalog',
  };
}

describe('resolveMainAgentTier (R21)', () => {
  it('returns undefined when the driver declares no mechanism (opt-in, R23)', () => {
    expect(
      resolveMainAgentTier(
        { tierOverride: 'flex' },
        { tierSelections: { 'glm-5.2': 'flex' } },
        'glm-5.2',
        undefined,
      ),
    ).toBeUndefined();
  });

  it('prefers the session override over the connection selection', () => {
    expect(
      resolveMainAgentTier(
        { tierOverride: 'fast' },
        { tierSelections: { 'glm-5.2': 'flex' } },
        'glm-5.2',
        variantMechanism,
      ),
    ).toBe('fast');
  });

  it('falls back to the connection per-model selection', () => {
    expect(
      resolveMainAgentTier(
        { tierOverride: null },
        { tierSelections: { 'glm-5.2': 'flex' } },
        'glm-5.2',
        variantMechanism,
      ),
    ).toBe('flex');
  });

  it('ignores an override the mechanism does not declare', () => {
    expect(
      resolveMainAgentTier(
        { tierOverride: 'turbo' },
        { tierSelections: { 'glm-5.2': 'flex' } },
        'glm-5.2',
        variantMechanism,
      ),
    ).toBe('flex');
  });

  it('returns undefined when nothing is selected (R23)', () => {
    expect(
      resolveMainAgentTier({ tierOverride: null }, {}, 'glm-5.2', variantMechanism),
    ).toBeUndefined();
  });
});

describe('resolveSubagentTier', () => {
  it('uses the connection selection only', () => {
    expect(
      resolveSubagentTier({ tierSelections: { 'glm-5.2': 'short' } }, 'glm-5.2', variantMechanism),
    ).toBe('short');
  });
});

describe('tierVariantModelId + applyVariantTier (R19, R23)', () => {
  it('maps base + tier to the variant id', () => {
    expect(tierVariantModelId(variantMechanism, 'glm-5.2', 'flex')).toBe('glm-5.2-flex');
    expect(tierVariantModelId(variantMechanism, 'glm-5.2', 'short')).toBe('glm-5.2-short');
  });

  it('rewrites the executable id and records the base id', () => {
    const served = applyVariantTier(
      { tierMechanism: variantMechanism },
      model('glm-5.2'),
      'flex',
      { streaming: true },
    );
    expect(served.id).toBe('glm-5.2-flex');
    expect(served.baseModelId).toBe('glm-5.2');
  });

  it('passes through unchanged when no tier is selected (opt-in, R23)', () => {
    const base = model('glm-5.2');
    expect(applyVariantTier({ tierMechanism: variantMechanism }, base, undefined, { streaming: true })).toBe(base);
  });

  it('fails loudly when a streaming-required tier is built non-streaming (R23)', () => {
    expect(() =>
      applyVariantTier({ tierMechanism: variantMechanism }, model('glm-5.2'), 'flex', { streaming: false }),
    ).toThrow(/requires a streaming request/);
  });

  it('allows non-streaming for tiers without the precondition', () => {
    const served = applyVariantTier(
      { tierMechanism: variantMechanism },
      model('glm-5.2'),
      'fast',
      { streaming: false },
    );
    expect(served.id).toBe('glm-5.2-fast');
  });

  it('strips a known variant suffix back to the base id', () => {
    expect(tierBaseModelId('glm-5.2-flex', ['-flex', '-fast', '-short'])).toBe('glm-5.2');
    expect(tierBaseModelId('glm-5.2', ['-flex'])).toBeUndefined();
  });
});

describe('buildTierProviderOptions (R19)', () => {
  it('emits serviceTier under the openai namespace for a declared tier', () => {
    expect(buildTierProviderOptions(parameterMechanism, 'flex')).toEqual({
      openai: { serviceTier: 'flex' },
    });
  });

  it('emits nothing for a variant mechanism (parameter form ignored, R19)', () => {
    expect(buildTierProviderOptions(variantMechanism, 'flex')).toBeUndefined();
  });

  it('emits nothing when no tier is selected (R23)', () => {
    expect(buildTierProviderOptions(parameterMechanism, undefined)).toBeUndefined();
  });

  it('emits nothing for an undeclared tier id', () => {
    expect(buildTierProviderOptions(parameterMechanism, 'turbo')).toBeUndefined();
  });
});

describe('groupTierVariantRows (R20)', () => {
  function row(id: string): { model: { id: string } } {
    return { model: { id } };
  }

  it('folds variant rows under their base model entry', () => {
    const rows = [row('glm-5.2'), row('glm-5.2-flex'), row('glm-5.2-fast'), row('glm-5.2-short')];
    const { rows: grouped, variantTiersByBase } = groupTierVariantRows(rows, variantMechanism);
    expect(grouped.map((entry) => entry.model.id)).toEqual(['glm-5.2']);
    expect(variantTiersByBase.get('glm-5.2')).toEqual(['flex', 'fast', 'short']);
  });

  it('keeps a variant row when the base model is absent', () => {
    const rows = [row('kimi-k2.6-flex'), row('kimi-k2.6-fast')];
    const { rows: grouped, variantTiersByBase } = groupTierVariantRows(rows, variantMechanism);
    expect(grouped).toHaveLength(2);
    expect(variantTiersByBase.size).toBe(0);
  });

  it('is a no-op without a variant mechanism', () => {
    const rows = [row('glm-5.2'), row('glm-5.2-flex')];
    const { rows: grouped } = groupTierVariantRows(rows, undefined);
    expect(grouped).toHaveLength(2);
  });

  it('resolves compound variants against the longest suffix first', () => {
    const rows = [row('glm-5.2'), row('glm-5.2-short'), row('glm-5.2-short-flex')];
    const { rows: grouped, variantTiersByBase } = groupTierVariantRows(rows, variantMechanism);
    expect(grouped.map((entry) => entry.model.id)).toEqual(['glm-5.2']);
    expect(variantTiersByBase.get('glm-5.2')).toEqual(['short', 'flex']);
  });
});

describe('extractServedTier (R22)', () => {
  it('reads the provider-reported service tier for parameter mechanisms', () => {
    expect(
      extractServedTier({
        mechanism: parameterMechanism,
        servedModelId: 'gpt-5.6',
        requestedTier: 'flex',
        finishMetadata: { openai: { serviceTier: 'flex' } },
      }),
    ).toEqual({ tier: 'flex', requestedTier: 'flex' });
  });

  it('derives the served tier from the variant id for variant mechanisms', () => {
    expect(
      extractServedTier({
        mechanism: variantMechanism,
        servedModelId: 'glm-5.2-flex',
        baseModelId: 'glm-5.2',
        requestedTier: 'flex',
      }),
    ).toEqual({ tier: 'flex', servedModelId: 'glm-5.2-flex', baseModelId: 'glm-5.2', requestedTier: 'flex' });
  });

  it('recovers the base id from the served id when not supplied', () => {
    const result = extractServedTier({
      mechanism: variantMechanism,
      servedModelId: 'glm-5.2-fast',
    });
    expect(result?.tier).toBe('fast');
    expect(result?.baseModelId).toBe('glm-5.2');
  });

  it('returns undefined when no tier facet is active', () => {
    expect(extractServedTier({ mechanism: undefined, servedModelId: 'gpt-5.6' })).toBeUndefined();
  });

  it('reports a requested-but-unserved tier as { requestedTier } without a tier field (R22)', () => {
    expect(
      extractServedTier({
        mechanism: parameterMechanism,
        servedModelId: 'gpt-5.6',
        requestedTier: 'flex',
        finishMetadata: {},
      }),
    ).toEqual({ requestedTier: 'flex' });
  });
});

describe('declaredTier', () => {
  it('exposes the streaming precondition for variant tiers', () => {
    expect(declaredTier(variantMechanism, 'flex')).toEqual({ id: 'flex', requiresStreaming: true });
    expect(declaredTier(variantMechanism, 'fast')).toEqual({ id: 'fast', requiresStreaming: false });
    expect(declaredTier(variantMechanism, 'turbo')).toBeUndefined();
  });
});

describe('ProviderRuntime tier context and execution glue (R19–R22)', () => {
  const runtimeConnection: ProviderConnection = {
    id: '44444444-4444-4444-8444-444444444444',
    providerId: 'neuralwatt',
    name: 'Neuralwatt',
    protocol: 'openai-compatible',
    authMethod: 'api-key',
    credential: { kind: 'stored', handle: '55555555-5555-4555-8555-555555555555' },
    modelIds: ['glm-5.2'],
    discoveredModels: [{
      id: 'glm-5.2',
      provenance: 'provider',
      discoveredAt: '2026-07-12T11:50:00.000Z',
      pricing: {
        currencyUnit: { kind: 'fiat', code: 'USD' },
        observedAt: '2026-07-12T11:55:00.000Z',
        rates: {
          input: { amount: '1', per: 1_000_000, unit: 'tokens' },
          output: { amount: '4', per: 1_000_000, unit: 'tokens' },
        },
      },
    }],
    health: 'ready',
  };
  const runtimeProvider: ProviderDefinition = {
    id: 'neuralwatt',
    displayName: 'Neuralwatt',
    supportedAuthMethods: ['api-key'],
    supportedProtocols: ['openai-compatible'],
    allowsCustomModels: false,
    models: [{ id: 'glm-5.2', displayName: 'GLM 5.2', protocol: 'openai-compatible' }],
  };
  const selection = { connectionId: runtimeConnection.id, modelId: 'glm-5.2' };

  let createLanguageModel: ReturnType<typeof vi.fn>;
  let runtimeDriver: ProviderDriver;

  beforeEach(() => {
    vi.clearAllMocks();
    createLanguageModel = vi.fn(async () => ({ kind: 'trusted-model' }));
    runtimeDriver = {
      id: 'neuralwatt',
      supportedAuthMethods: ['api-key'],
      supportedProtocols: ['openai-compatible'],
      allowsCustomEndpoint: false,
      origin: 'https://api.neuralwatt.com/v1',
      createLanguageModel,
      tierMechanism: NEURALWATT_TIER_MECHANISM,
      pricingFacet: { currencyUnit: { kind: 'fiat', code: 'USD' } },
    };
  });

  function runtime(connections: readonly ProviderConnection[] = [runtimeConnection]): ProviderRuntime {
    return new ProviderRuntime({
      catalog: { getProviderDefinitions: () => [runtimeProvider] },
      connections: { list: async () => connections },
      vault: { readSecret: vi.fn(async () => ({ kind: 'api-key' as const, apiKey: 'vault-key' })) },
      registry: new ProviderDriverRegistry([runtimeDriver]),
    });
  }

  it('resolves a selection to the connection and its driver tier mechanism', async () => {
    const context = await runtime().resolveTierContext(selection);

    expect(context.connection).toBe(runtimeConnection);
    expect(context.tierMechanism).toBe(NEURALWATT_TIER_MECHANISM);
  });

  it('throws ProviderResolutionError when the selection cannot resolve', async () => {
    await expect(
      runtime([]).resolveTierContext(selection),
    ).rejects.toBeInstanceOf(ProviderResolutionError);
  });

  it('freezes the served variant id and bills the discovered base-id pricing for a variant-tier execution (R22, R27)', async () => {
    const execution = await runtime().resolveExecution(selection, { tier: 'flex' });

    expect(execution.snapshot.tier).toEqual({
      mechanism: 'model-name-variants',
      requestedTier: 'flex',
      servedModelId: 'glm-5.2-flex',
      baseModelId: 'glm-5.2',
    });
    expect(execution.snapshot.pricing?.rates.input).toMatchObject({
      amount: '1',
      provenance: { source: 'provider-api', observedAt: '2026-07-12T11:50:00.000Z' },
    });
    expect(execution.snapshot.pricing?.provenance).toMatchObject({
      source: 'provider-api',
      discovered: { observedAt: '2026-07-12T11:50:00.000Z' },
    });
    expect(createLanguageModel).toHaveBeenCalledWith(expect.objectContaining({
      model: expect.objectContaining({ id: 'glm-5.2' }),
      tier: 'flex',
    }));
  });

  it('applies a user override keyed by the base model id to a variant-tier execution', async () => {
    const execution = await runtime([{
      ...runtimeConnection,
      discoveredModels: undefined,
      pricingOverrides: {
        'glm-5.2': { input: { amount: '2', per: 1_000_000, unit: 'tokens' } },
      },
    }]).resolveExecution(selection, { tier: 'flex' });

    expect(execution.snapshot.tier?.servedModelId).toBe('glm-5.2-flex');
    expect(execution.snapshot.pricing?.rates.input).toMatchObject({
      amount: '2',
      provenance: { source: 'user', observedAt: null },
    });
    expect(execution.snapshot.pricing?.provenance).toMatchObject({ source: 'user', user: true });
  });
});
