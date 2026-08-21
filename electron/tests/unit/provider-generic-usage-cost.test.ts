import { describe, expect, it } from 'vitest';

describe('generic usage-body cost evidence', () => {
  it('extracts the OpenRouter-style usage cost as a USD provider report', async () => {
    const { extractGenericUsageCostEvidence } = await import('../../src/main/providers/drivers/compatible');

    const evidence = extractGenericUsageCostEvidence({}, {
      prompt_tokens: 15,
      completion_tokens: 16,
      total_tokens: 31,
      cost: 0.0000914,
      cost_details: { upstream_inference_cost: 0.0000914 },
    });

    expect(evidence.reportedCostUsd).toBe('0.0000914');
    expect(evidence.costDetails).toMatchObject({ upstream_inference_cost: 0.0000914 });
  });

  it('accepts string costs and the cost_usd variant', async () => {
    const { extractGenericUsageCostEvidence } = await import('../../src/main/providers/drivers/compatible');

    expect(extractGenericUsageCostEvidence({}, { cost: '0.0012' }).reportedCostUsd).toBe('0.0012');
    expect(extractGenericUsageCostEvidence({}, { cost_usd: 2.5 }).reportedCostUsd).toBe('2.5');
  });

  it('keeps a zero charge as an authoritative report', async () => {
    const { extractGenericUsageCostEvidence } = await import('../../src/main/providers/drivers/compatible');

    expect(extractGenericUsageCostEvidence({}, { cost: 0 }).reportedCostUsd).toBe('0');
  });

  it('ignores undocumented shapes instead of guessing a cost', async () => {
    const { extractGenericUsageCostEvidence } = await import('../../src/main/providers/drivers/compatible');

    expect(extractGenericUsageCostEvidence({}, { cost: -1 }).reportedCostUsd).toBeUndefined();
    expect(extractGenericUsageCostEvidence({}, { cost: 'free' }).reportedCostUsd).toBeUndefined();
    expect(extractGenericUsageCostEvidence({}, { cost: { usd: 1 } }).reportedCostUsd).toBeUndefined();
    expect(extractGenericUsageCostEvidence({}, 'usage-text').reportedCostUsd).toBeUndefined();
    expect(extractGenericUsageCostEvidence({}, undefined).reportedCostUsd).toBeUndefined();
  });

  it('falls back to the allowlisted cost header and lets the usage body win', async () => {
    const { extractGenericUsageCostEvidence } = await import('../../src/main/providers/drivers/compatible');

    expect(extractGenericUsageCostEvidence({ 'x-request-cost-usd': '0.0042' }, {}).reportedCostUsd).toBe('0.0042');
    expect(
      extractGenericUsageCostEvidence({ 'x-request-cost-usd': '0.0042' }, { cost: 0.0000914 }).reportedCostUsd,
    ).toBe('0.0000914');
  });

  it('declares the facet on both generic compatible drivers', async () => {
    const { createCompatibleProviderDrivers } = await import('../../src/main/providers/drivers/compatible');

    for (const driver of createCompatibleProviderDrivers()) {
      const extracted = driver.pricingFacet?.costEvidence?.({
        headers: {},
        rawUsage: { cost: 0.0000914, cost_details: { upstream_inference_cost: 0.0000914 } },
      });
      expect(extracted).toMatchObject({
        reportedCostAmount: '0.0000914',
        reportedCurrency: 'USD',
        providerEvidence: { reportedUsageCostUsd: '0.0000914' },
      });
    }
  });

  it('omits the report when neither body nor header carries a usable cost', async () => {
    const { createCompatibleProviderDrivers } = await import('../../src/main/providers/drivers/compatible');
    const facet = createCompatibleProviderDrivers()[0].pricingFacet;

    const extracted = facet?.costEvidence?.({ headers: {}, rawUsage: { prompt_tokens: 15 } });
    expect(extracted?.reportedCostAmount).toBeUndefined();
  });
});
