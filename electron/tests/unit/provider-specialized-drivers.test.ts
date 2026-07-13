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
});
