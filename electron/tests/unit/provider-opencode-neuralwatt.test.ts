import { beforeEach, describe, expect, it, vi } from 'vitest';
import { importESM } from '../../src/main/utils/esm-import';
import type { ProviderConnection, ProviderDefinition } from '../../src/shared/types/provider';

vi.mock('../../src/main/utils/esm-import', () => ({ importESM: vi.fn() }));

const openaiCompatibleModel = { kind: 'openai-compatible' };
const openaiResponsesModel = { kind: 'openai-responses' };
const anthropicModel = { kind: 'anthropic-messages' };
const createOpenAICompatible = vi.fn(() => vi.fn(() => openaiCompatibleModel));
const openAIResponses = vi.fn(() => openaiResponsesModel);
const createOpenAI = vi.fn(() => ({ responses: openAIResponses }));
const createAnthropic = vi.fn(() => ({ messages: vi.fn(() => anthropicModel) }));

describe('OpenCode Go and Neuralwatt trusted drivers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(importESM).mockImplementation(async (specifier: string) => {
      if (specifier === '@ai-sdk/openai-compatible') return { createOpenAICompatible };
      if (specifier === '@ai-sdk/openai') return { createOpenAI };
      if (specifier === '@ai-sdk/anthropic') return { createAnthropic };
      throw new Error(`Unexpected adapter import ${specifier}`);
    });
  });

  it('routes OpenCode Go each model through its catalog-declared protocol on code-owned origins', async () => {
    const {
      OPENCODE_GO_API_ORIGIN,
      createOpenCodeGoLanguageModel,
    } = await import('../../src/main/providers/drivers/opencode-go');

    await expect(createOpenCodeGoLanguageModel({
      protocol: 'openai-compatible',
      modelId: 'deepseek-v4-flash',
      apiKey: 'go-key',
    })).resolves.toBe(openaiCompatibleModel);
    expect(createOpenAICompatible).toHaveBeenCalledWith(expect.objectContaining({
      name: 'opencode-go',
      baseURL: OPENCODE_GO_API_ORIGIN,
      apiKey: 'go-key',
    }));

    await expect(createOpenCodeGoLanguageModel({
      protocol: 'anthropic-messages',
      modelId: 'minimax-m3',
      apiKey: 'go-key',
    })).resolves.toBe(anthropicModel);
    expect(createAnthropic).toHaveBeenCalledWith({
      name: 'opencode-go',
      baseURL: OPENCODE_GO_API_ORIGIN,
      apiKey: 'go-key',
    });
  });

  it('maps an OpenCode Go Responses-protocol model to the responses route', async () => {
    const {
      OPENCODE_GO_API_ORIGIN,
      createOpenCodeGoLanguageModel,
    } = await import('../../src/main/providers/drivers/opencode-go');

    await expect(createOpenCodeGoLanguageModel({
      protocol: 'openai-responses',
      modelId: 'gpt-5.2',
      apiKey: 'go-key',
    })).resolves.toBe(openaiResponsesModel);
    expect(createOpenAI).toHaveBeenCalledWith(expect.objectContaining({
      name: 'opencode-go',
      baseURL: OPENCODE_GO_API_ORIGIN,
      apiKey: 'go-key',
    }));
    expect(openAIResponses).toHaveBeenCalledWith('gpt-5.2');
    expect(createOpenAICompatible).not.toHaveBeenCalled();
  });

  it('declares the Responses protocol and routes per-model protocol through the trusted driver', async () => {
    const { createOpenCodeGoProviderDriver } = await import('../../src/main/providers/drivers/opencode-go');
    const driver = createOpenCodeGoProviderDriver();
    expect(driver.supportedProtocols).toEqual(['openai-compatible', 'openai-responses', 'anthropic-messages']);

    const connection: ProviderConnection = {
      id: '44444444-4444-4444-8444-444444444444',
      providerId: 'opencode-go',
      name: 'Go',
      protocol: 'openai-responses',
      authMethod: 'api-key',
      credential: { kind: 'stored', handle: '55555555-5555-4555-8555-555555555555' },
      modelIds: ['gpt-5.2'],
      health: 'ready',
    };
    const provider: ProviderDefinition = {
      id: 'opencode-go',
      displayName: 'OpenCode Go',
      supportedAuthMethods: ['api-key'],
      supportedProtocols: ['openai-compatible', 'openai-responses', 'anthropic-messages'],
      allowsCustomModels: false,
      models: [],
    };

    await expect(driver.createLanguageModel({
      connection,
      provider,
      model: { id: 'gpt-5.2', displayName: 'GPT-5.2', protocol: 'openai-responses', source: 'catalog' },
      credential: { kind: 'api-key', apiKey: 'go-key' },
    })).resolves.toBe(openaiResponsesModel);
    expect(openAIResponses).toHaveBeenCalledWith('gpt-5.2');

    await expect(driver.createLanguageModel({
      connection,
      provider,
      model: { id: 'grok-4.3', displayName: 'Grok', protocol: 'xai', source: 'catalog' },
      credential: { kind: 'api-key', apiKey: 'go-key' },
    })).rejects.toThrow(/does not support protocol 'xai'/);
  });

  it("uses Neuralwatt's code-owned OpenAI-compatible origin and retains authoritative billing evidence", async () => {
    const {
      NEURALWATT_API_ORIGIN,
      createNeuralwattLanguageModel,
      extractNeuralwattBillingEvidence,
    } = await import('../../src/main/providers/drivers/neuralwatt');

    await expect(createNeuralwattLanguageModel({
      modelId: 'kimi-k2.6',
      apiKey: 'neuralwatt-key',
    })).resolves.toBe(openaiCompatibleModel);
    expect(createOpenAICompatible).toHaveBeenCalledWith(expect.objectContaining({
      name: 'neuralwatt',
      baseURL: NEURALWATT_API_ORIGIN,
      apiKey: 'neuralwatt-key',
    }));

    expect(extractNeuralwattBillingEvidence(new Headers({
      'x-request-cost-usd': '0.001234',
      'x-allowance-remaining-usd': '12.500000',
    }), {
      energy: {
        energy_kwh: 0.00012,
        measurement_available: true,
      },
      accounting_method: 'energy',
      energy_kwh_charged: 0.000078,
      pricing_multiplier: 0.65,
      energy_rate_usd_per_kwh: 5,
    })).toEqual({
      reportedCostUsd: '0.001234',
      allowanceRemainingUsd: '12.500000',
      accountingMethod: 'energy',
      energyKwhConsumed: '0.00012',
      energyKwhCharged: '0.000078',
      pricingMultiplier: '0.65',
      energyRateUsdPerKwh: '5',
      measurementAvailable: true,
    });
  });

  it('does not invent an energy calculation from incomplete Neuralwatt evidence', async () => {
    const { extractNeuralwattBillingEvidence } = await import('../../src/main/providers/drivers/neuralwatt');
    expect(extractNeuralwattBillingEvidence(new Headers(), {
      energy: { energy_kwh: 0.00012, measurement_available: true },
      accounting_method: 'energy',
    })).toMatchObject({
      reportedCostUsd: undefined,
      energyKwhConsumed: '0.00012',
      energyKwhCharged: undefined,
      energyRateUsdPerKwh: undefined,
    });
  });

  it('parses Neuralwatt quota/accounting status without retaining account or key identity', async () => {
    const { parseNeuralwattQuotaObservation } = await import('../../src/main/providers/drivers/neuralwatt-quota');
    const observation = parseNeuralwattQuotaObservation({
      snapshot_at: '2026-07-12T12:00:00.000Z',
      balance: {
        credits_remaining_usd: 32.6774,
        total_credits_usd: 52.34,
        credits_used_usd: 19.6626,
        accounting_method: 'energy',
      },
      usage: { current_month: { cost_usd: 1.2, requests: 3, tokens: 120, energy_kwh: 0.01 } },
      limits: { overage_limit_usd: null, rate_limit_tier: 'standard' },
      subscription: { plan: 'standard', status: 'active', kwh_included: 20, kwh_used: 13, kwh_remaining: 7, in_overage: false },
      key: { name: 'must-not-persist', allowance: null },
    }, new Date('2026-07-12T12:01:00.000Z'));

    expect(observation).toMatchObject({
      providerId: 'neuralwatt',
      data: {
        accountingMethod: 'energy',
        creditsRemainingUsd: 32.6774,
        rateLimitTier: 'standard',
        subscription: { kwhRemaining: 7 },
      },
    });
    expect(JSON.stringify(observation)).not.toContain('must-not-persist');
  });

  it('maps a selected Neuralwatt tier onto the variant model id at construction time (R19)', async () => {
    const { createNeuralwattProviderDriver } = await import('../../src/main/providers/drivers/neuralwatt');
    const driver = createNeuralwattProviderDriver();
    expect(driver.tierMechanism?.kind).toBe('model-name-variants');

    const connection: ProviderConnection = {
      id: '44444444-4444-4444-8444-444444444444',
      providerId: 'neuralwatt',
      name: 'NW',
      protocol: 'openai-compatible',
      authMethod: 'api-key',
      credential: { kind: 'stored', handle: '55555555-5555-4555-8555-555555555555' },
      modelIds: ['glm-5.2'],
      tierSelections: { 'glm-5.2': 'flex' },
      health: 'ready',
    };
    const provider: ProviderDefinition = {
      id: 'neuralwatt',
      displayName: 'Neuralwatt',
      supportedAuthMethods: ['api-key'],
      supportedProtocols: ['openai-compatible'],
      allowsCustomModels: false,
      models: [],
    };

    const request = {
      connection,
      provider,
      model: { id: 'glm-5.2', displayName: 'GLM 5.2', protocol: 'openai-compatible' as const, source: 'catalog' as const },
      credential: { kind: 'api-key' as const, apiKey: 'neuralwatt-key' },
    };

    // Selecting flex sends the variant id (streaming is always asserted here).
    await expect(driver.createLanguageModel({ ...request, tier: 'flex' })).resolves.toBe(openaiCompatibleModel);
    let factory = vi.mocked(createOpenAICompatible).mock.results.at(-1)?.value;
    expect(vi.mocked(factory).mock.calls.at(-1)?.[0]).toBe('glm-5.2-flex');

    // No selection sends the base id unchanged (opt-in, R23).
    await expect(driver.createLanguageModel(request)).resolves.toBe(openaiCompatibleModel);
    factory = vi.mocked(createOpenAICompatible).mock.results.at(-1)?.value;
    expect(vi.mocked(factory).mock.calls.at(-1)?.[0]).toBe('glm-5.2');
  });

  it('rejects a flex tier for a non-streaming construction path (R23)', async () => {
    const { createNeuralwattProviderDriver } = await import('../../src/main/providers/drivers/neuralwatt');
    const { applyVariantTier } = await import('../../src/main/providers/facets/tiers');
    const driver = createNeuralwattProviderDriver();
    expect(() =>
      applyVariantTier(
        driver,
        { id: 'glm-5.2', displayName: 'GLM 5.2', protocol: 'openai-compatible', source: 'catalog' },
        'flex',
        { streaming: false },
      ),
    ).toThrow(/requires a streaming request/);
  });
});
