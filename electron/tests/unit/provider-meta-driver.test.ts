import { beforeEach, describe, expect, it, vi } from 'vitest';
import { importESM } from '../../src/main/utils/esm-import';

vi.mock('../../src/main/utils/esm-import', () => ({ importESM: vi.fn() }));

const metaModel = { kind: 'meta-openai-responses' };
const createOpenAI = vi.fn(() => ({ responses: vi.fn(() => metaModel) }));

describe('Meta provider driver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(importESM).mockResolvedValue({ createOpenAI });
  });

  it('constructs the Responses model through the code-owned Meta origin', async () => {
    const { META_API_ORIGIN, createMetaLanguageModel } = await import('../../src/main/providers/drivers/meta');

    await expect(createMetaLanguageModel({
      modelId: 'muse-spark-1.2',
      apiKey: 'meta-test-key',
    })).resolves.toBe(metaModel);

    expect(createOpenAI).toHaveBeenCalledWith({
      name: 'meta',
      baseURL: META_API_ORIGIN,
      apiKey: 'meta-test-key',
    });
  });

  it('declares a code-owned, responses-only driver surface', async () => {
    const { createMetaProviderDriver, META_API_ORIGIN } = await import('../../src/main/providers/drivers/meta');
    const driver = createMetaProviderDriver();

    expect(driver.id).toBe('meta');
    expect(driver.allowsCustomEndpoint).toBe(false);
    expect(driver.origin).toBe(META_API_ORIGIN);
    expect(driver.supportedProtocols).toEqual(['openai-responses']);
    expect(driver.supportedAuthMethods).toEqual(['api-key', 'environment']);
  });

  it('emits reasoning effort only for the documented vocabulary', async () => {
    const { createMetaProviderDriver, META_REASONING_EFFORT_LEVELS } = await import('../../src/main/providers/drivers/meta');
    const driver = createMetaProviderDriver();

    for (const level of META_REASONING_EFFORT_LEVELS) {
      expect(driver.buildReasoningOptions?.(level)).toEqual({
        openai: { reasoningEffort: level },
      });
    }
    // `none` and `max` are rejected by the API and are never emitted;
    // numeric budgets do not exist on the Responses protocol.
    expect(driver.buildReasoningOptions?.('none')).toBeUndefined();
    expect(driver.buildReasoningOptions?.('max')).toBeUndefined();
    expect(driver.buildReasoningOptions?.(5000)).toBeUndefined();
  });

  it('resolves the Meta thinking policy for every model', async () => {
    const { createMetaProviderDriver, META_THINKING_POLICY } = await import('../../src/main/providers/drivers/meta');
    const driver = createMetaProviderDriver();

    const model = {
      id: 'muse-spark-1.1',
      displayName: 'Muse Spark 1.1',
      protocol: 'openai-responses',
      source: 'catalog',
    };
    expect(driver.thinkingPolicy?.(model)).toEqual(META_THINKING_POLICY);
    expect(META_THINKING_POLICY).toMatchObject({
      exposure: 'summary',
      replay: 'recommended',
      knobs: { encryptedContentOption: true },
    });
  });

  it('declares an automatic cache facet with retention hints only', async () => {
    const { createMetaProviderDriver } = await import('../../src/main/providers/drivers/meta');
    const facet = createMetaProviderDriver().cacheFacet;

    expect(facet).toMatchObject({
      mode: 'automatic',
      sessionKey: false,
      retentionHint: true,
      ttlOptions: [
        { id: 'in_memory' },
        { id: '24h' },
      ],
    });
  });
});

describe('Meta turn-option assembly', () => {
  it('merges effort, stateless encrypted replay, and retention into one request', async () => {
    const { assembleFacetProviderOptions } = await import('../../src/main/providers/facets/turn-options');
    const { createMetaProviderDriver, META_THINKING_POLICY } = await import('../../src/main/providers/drivers/meta');
    const driver = createMetaProviderDriver();

    const result = assembleFacetProviderOptions({
      providerOptions: driver.buildReasoningOptions?.('high'),
      thinkingPolicy: META_THINKING_POLICY,
      providerId: 'meta',
      tierId: undefined,
      tierMechanism: undefined,
      cacheFacet: driver.cacheFacet,
      cacheTtlSelection: '24h',
      sessionId: 'session-1',
    });

    expect(result.providerOptions).toEqual({
      openai: {
        reasoningEffort: 'high',
        store: false,
        include: ['reasoning.encrypted_content'],
        promptCacheRetention: '24h',
      },
    });
    expect(result.cacheTtl).toBe('24h');
  });
});
