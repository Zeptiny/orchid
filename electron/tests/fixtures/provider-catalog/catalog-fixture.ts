import {
  catalogEnvelopeSchema,
  type ProviderCatalog,
} from '../../../src/main/providers/catalog/schema';

export const CATALOG_NOW = '2026-07-12T00:00:00.000Z';

export function createCatalogFixture(version = 1): ProviderCatalog {
  return catalogEnvelopeSchema.parse({
    schemaVersion: 1,
    catalogVersion: version,
    issuedAt: CATALOG_NOW,
    expiresAt: '2026-12-31T00:00:00.000Z',
    compatibleApp: { minimum: '0.1.0', maximum: '1.0.0' },
    provenance: {
      source: 'models.dev',
      sourceUrl: 'https://models.dev/api.json',
      capturedAt: CATALOG_NOW,
      contentHash: 'sha256:8157aaa5ff3f76be1ea17e011eae916ff2cce4613afcff2225e03f644dfd9bf5',
    },
    providers: [{
      id: 'openai',
      displayName: 'OpenAI',
      supportedAuthMethods: ['api-key'],
      supportedProtocols: ['openai-compatible'],
      allowsCustomModels: false,
      lifecycle: 'active',
      provenance: { source: 'catalog', observedAt: CATALOG_NOW },
      models: [{
        id: 'gpt-test/1',
        displayName: 'GPT Test',
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
          effectiveAt: CATALOG_NOW,
          rates: {
            input: { amount: '1.250000', per: 1000000, unit: 'tokens' },
            output: { amount: '5.000000', per: 1000000, unit: 'tokens' },
          },
          provenance: { source: 'catalog', observedAt: CATALOG_NOW },
        },
        provenance: { source: 'catalog', observedAt: CATALOG_NOW },
      }],
    }],
  });
}
