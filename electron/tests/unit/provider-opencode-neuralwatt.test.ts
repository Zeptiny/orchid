import { beforeEach, describe, expect, it, vi } from 'vitest';
import { importESM } from '../../src/main/utils/esm-import';

vi.mock('../../src/main/utils/esm-import', () => ({ importESM: vi.fn() }));

const openaiCompatibleModel = { kind: 'openai-compatible' };
const anthropicModel = { kind: 'anthropic-messages' };
const createOpenAICompatible = vi.fn(() => vi.fn(() => openaiCompatibleModel));
const createAnthropic = vi.fn(() => ({ messages: vi.fn(() => anthropicModel) }));

describe('OpenCode Go and Neuralwatt trusted drivers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(importESM).mockImplementation(async (specifier: string) => {
      if (specifier === '@ai-sdk/openai-compatible') return { createOpenAICompatible };
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
    const { parseNeuralwattQuotaStatus } = await import('../../src/main/providers/drivers/neuralwatt');
    const observation = parseNeuralwattQuotaStatus({
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
});
