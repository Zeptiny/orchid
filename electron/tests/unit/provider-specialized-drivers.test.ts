import { beforeEach, describe, expect, it, vi } from 'vitest';
import { importESM } from '../../src/main/utils/esm-import';

vi.mock('../../src/main/utils/esm-import', () => ({ importESM: vi.fn() }));

const lilacModel = { kind: 'lilac-openai-compatible' };
const createOpenAICompatible = vi.fn(() => vi.fn(() => lilacModel));

describe('Lilac provider driver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(importESM).mockResolvedValue({ createOpenAICompatible });
  });

  it('uses the code-owned OpenAI-compatible endpoint and preserves model ids', async () => {
    const {
      LILAC_INFERENCE_BASE_URL,
      createLilacLanguageModel,
    } = await import('../../src/main/providers/drivers/lilac');

    await expect(createLilacLanguageModel({
      modelId: 'moonshotai/kimi-k2.6',
      apiKey: 'lilac-test-key',
    })).resolves.toBe(lilacModel);

    expect(createOpenAICompatible).toHaveBeenCalledWith({
      name: 'lilac',
      baseURL: LILAC_INFERENCE_BASE_URL,
      apiKey: 'lilac-test-key',
      fetch: expect.any(Function),
    });
  });

  it('parses authoritative live performance and supply-discount fields without deriving them', async () => {
    const { parseLilacStatus } = await import('../../src/main/providers/drivers/lilac');

    const observation = parseLilacStatus({
      updated_at: '2026-07-12T12:00:00.000Z',
      window: '5m',
      window_secs: 300,
      stale: false,
      current_subscription_supply_updated_at: '2026-07-12T11:59:00.000Z',
      models: [{
        id: 'moonshotai/kimi-k2.6',
        name: 'Kimi K2.6',
        tps: 142.7,
        ttfb_seconds: 0.41,
        uptime_pct: 99.8,
        current_subscription_supply_state: 'surplus',
        current_subscription_discount_percent: 75,
        current_subscription_credit_multiplier: 0.25,
      }],
    }, new Date('2026-07-12T12:01:00.000Z'));

    expect(observation.providerId).toBe('lilac');
    expect(observation.providerUpdatedAt).toBe('2026-07-12T12:00:00.000Z');
    expect(observation.stale).toBe(false);
    expect(observation.data).toMatchObject({
      window: '5m',
      subscriptionSupplyUpdatedAt: '2026-07-12T11:59:00.000Z',
      models: [{
        modelId: 'moonshotai/kimi-k2.6',
        tokensPerSecond: 142.7,
        timeToFirstTokenSeconds: 0.41,
        uptimePercent: 99.8,
        subscription: {
          availability: 'available',
          supplyState: 'surplus',
          discountPercent: 75,
          creditMultiplier: 0.25,
        },
      }],
    });
  });

  it('represents absent supply-discount fields as unavailable and stale source timestamps as stale', async () => {
    const { parseLilacStatus } = await import('../../src/main/providers/drivers/lilac');

    const observation = parseLilacStatus({
      updated_at: '2026-07-12T11:50:00.000Z',
      window: '5m',
      window_secs: 300,
      stale: false,
      models: [{
        id: 'moonshotai/kimi-k2.6',
        tps: 100,
        ttfb_seconds: 0.5,
        uptime_pct: 99,
      }],
    }, new Date('2026-07-12T12:00:00.000Z'));

    expect(observation.stale).toBe(true);
    expect(observation.data).toMatchObject({
      subscriptionSupplyUpdatedAt: null,
      models: [{
        subscription: {
          availability: 'unavailable',
          supplyState: null,
          discountPercent: null,
          creditMultiplier: null,
        },
      }],
    });
  });

  it('composes live subscription multipliers over catalog list rates', async () => {
    const { fetchLilacPricingRateCards } = await import('../../src/main/providers/drivers/lilac');
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      updated_at: '2026-07-12T12:00:00.000Z',
      window: '5m',
      window_secs: 300,
      stale: false,
      current_subscription_supply_updated_at: '2026-07-12T11:59:00.000Z',
      models: [
        {
          id: 'moonshotai/kimi-k2.6',
          current_subscription_supply_state: 'surplus',
          current_subscription_discount_percent: 75,
          current_subscription_credit_multiplier: 0.25,
        },
        // No subscription fields: contributes no rate card.
        { id: 'google/gemma-4-31b-it' },
        // Subscription data without catalog list rates cannot form absolute rates.
        {
          id: 'uncatalogued/model',
          current_subscription_supply_state: 'surplus',
          current_subscription_discount_percent: 50,
          current_subscription_credit_multiplier: 0.5,
        },
      ],
    }), { status: 200 }));

    const cards = await fetchLilacPricingRateCards({
      fetch: fetch as typeof globalThis.fetch,
      now: () => new Date('2026-07-12T12:01:00.000Z'),
      catalogRates: {
        'moonshotai/kimi-k2.6': {
          input: { amount: '0.7', per: 1_000_000, unit: 'tokens' },
          output: { amount: '3.5', per: 1_000_000, unit: 'tokens' },
          cacheRead: { amount: '0.2', per: 1_000_000, unit: 'tokens' },
          cacheWriteByTtl: { '5m': { amount: '1', per: 1_000_000, unit: 'tokens' } },
        },
      },
    });

    expect(cards).toEqual([{
      modelId: 'moonshotai/kimi-k2.6',
      currencyUnit: { kind: 'fiat', code: 'USD' },
      observedAt: '2026-07-12T11:59:00.000Z',
      rates: {
        input: { amount: '0.175', per: 1_000_000, unit: 'tokens' },
        output: { amount: '0.875', per: 1_000_000, unit: 'tokens' },
        cacheRead: { amount: '0.05', per: 1_000_000, unit: 'tokens' },
        cacheWriteByTtl: { '5m': { amount: '0.25', per: 1_000_000, unit: 'tokens' } },
      },
      adjustment: {
        kind: 'subscription-multiplier',
        multiplier: '0.25',
        discountPercent: 75,
        providerUpdatedAt: '2026-07-12T12:00:00.000Z',
        supplyUpdatedAt: '2026-07-12T11:59:00.000Z',
      },
    }]);
  });

  it('fails live pricing rather than composing rates from a stale observation', async () => {
    const { fetchLilacPricingRateCards } = await import('../../src/main/providers/drivers/lilac');
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      updated_at: '2026-07-12T11:00:00.000Z',
      window: '5m',
      window_secs: 300,
      stale: false,
      models: [],
    }), { status: 200 }));

    await expect(fetchLilacPricingRateCards({
      fetch: fetch as typeof globalThis.fetch,
      now: () => new Date('2026-07-12T12:01:00.000Z'),
    })).rejects.toThrow(/stale/i);
  });

  it('declares its dynamic pricing facet on the trusted driver', async () => {
    const { createLilacProviderDriver, LILAC_PRICING_REFRESH_INTERVAL_SECONDS } = await import('../../src/main/providers/drivers/lilac');
    const driver = createLilacProviderDriver();
    expect(driver.pricingFacet?.dynamic?.refreshIntervalSeconds).toBe(LILAC_PRICING_REFRESH_INTERVAL_SECONDS);
    expect(typeof driver.pricingFacet?.dynamic?.fetchRates).toBe('function');
  });
});

describe('Neuralwatt provider driver pricing facet', () => {
  it('surfaces typed cost evidence through the facet instead of inline middleware code', async () => {
    const { createNeuralwattProviderDriver } = await import('../../src/main/providers/drivers/neuralwatt');
    const facet = createNeuralwattProviderDriver().pricingFacet;

    const extracted = facet?.costEvidence?.({
      headers: { 'x-request-cost-usd': '0.001234' },
      rawUsage: {
        energy: { energy_kwh: 0.00012, measurement_available: true },
        accounting_method: 'energy',
        energy_kwh_charged: 0.000078,
        pricing_multiplier: 0.65,
        energy_rate_usd_per_kwh: 5,
      },
    });

    expect(extracted).toMatchObject({
      reportedCostAmount: '0.001234',
      reportedCurrency: 'USD',
      accountingMethod: 'energy',
      currency: 'USD',
      energyKwhConsumed: '0.00012',
      energyKwhCharged: '0.000078',
      pricingMultiplier: '0.65',
      energyRateUsdPerKwh: '5',
    });
    expect(extracted?.providerEvidence).toMatchObject({
      accountingMethod: 'energy',
      measurementAvailable: true,
    });
  });
});
