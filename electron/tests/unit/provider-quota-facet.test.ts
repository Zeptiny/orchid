import { describe, expect, it, vi } from 'vitest';
import {
  observationWithQuota,
  validateDriverQuota,
  fetchDriverQuota,
  type ConnectionQuotaRequest,
} from '../../src/main/providers/facets/quota';
import type { ProviderQuota } from '../../src/shared/types/provider-facets';
import type { ProviderStatusObservation } from '../../src/main/providers/status/cache';
import type { ProviderDriver } from '../../src/main/providers/drivers/types';
import type {
  ProviderConnection,
  ProviderDefinition,
} from '../../src/shared/types/provider';

const NOW = new Date('2026-07-12T12:00:00.000Z');

function quota(overrides: Partial<ProviderQuota> = {}): ProviderQuota {
  return {
    observedAt: '2026-07-12T11:59:00.000Z',
    balances: [{ label: 'Credits remaining', amount: '12.5', unit: 'USD' }],
    subscription: { state: 'active', displayName: 'Pro', renewsAt: '2026-08-01T00:00:00.000Z' },
    allowances: [{ label: 'API key', state: 'available' }],
    ...overrides,
  };
}

function observation(overrides: Partial<ProviderStatusObservation> = {}): ProviderStatusObservation {
  return {
    providerId: 'neuralwatt',
    connectionId: 'conn-1',
    observedAt: '2026-07-12T12:00:00.000Z',
    providerUpdatedAt: '2026-07-12T12:00:00.000Z',
    availability: 'available',
    stale: false,
    data: { accountingMethod: 'energy' },
    ...overrides,
  };
}

function connection(): ProviderConnection {
  return {
    id: 'conn-1',
    providerId: 'neuralwatt',
    name: 'NW',
    protocol: 'openai-compatible',
    authMethod: 'api-key',
    credential: { kind: 'stored', handle: 'h' },
    modelIds: [],
    health: 'ready',
  };
}

function provider(): ProviderDefinition {
  return {
    id: 'neuralwatt',
    displayName: 'Neuralwatt',
    supportedAuthMethods: ['api-key'],
    supportedProtocols: ['openai-compatible'],
    allowsCustomModels: false,
    models: [],
  };
}

function driverWithQuota(fetchQuota: ProviderDriver['quotaFacet'] extends infer T
  ? T extends { fetchQuota: infer F } ? F : never : never): ProviderDriver {
  return {
    id: 'neuralwatt',
    supportedAuthMethods: ['api-key'],
    supportedProtocols: ['openai-compatible'],
    allowsCustomEndpoint: false,
    origin: 'https://api.neuralwatt.com/v1',
    createLanguageModel: () => Promise.reject(new Error('not exercised')),
    quotaFacet: { fetchQuota },
  };
}

describe('validateDriverQuota', () => {
  it('accepts a contract-conformant quota payload', () => {
    expect(validateDriverQuota(quota(), 'neuralwatt')).toEqual(quota());
  });

  it('rejects a malformed payload as a schema error', () => {
    expect(() => validateDriverQuota({ balances: 'nope' }, 'neuralwatt'))
      .toThrowError(/does not match the typed contract/);
  });

  it('rejects balances with unknown shape rather than coercing', () => {
    expect(() => validateDriverQuota(
      { ...quota(), balances: [{ label: 'x', amount: 'not-a-decimal', unit: 'USD' }] },
      'neuralwatt',
    )).toThrowError();
  });
});

describe('fetchDriverQuota', () => {
  it('returns the validated driver result', async () => {
    const fetchQuota = vi.fn(async () => quota());
    const request: ConnectionQuotaRequest = {
      driver: driverWithQuota(fetchQuota),
      connection: connection(),
      provider: provider(),
      credential: { kind: 'api-key', apiKey: 'key' },
    };
    await expect(fetchDriverQuota(request)).resolves.toEqual(quota());
    expect(fetchQuota).toHaveBeenCalledWith({
      connection: connection(),
      provider: provider(),
      credential: { kind: 'api-key', apiKey: 'key' },
    });
  });

  it('throws when the driver declares no quota facet', async () => {
    const driver: ProviderDriver = {
      id: 'bare',
      supportedAuthMethods: ['api-key'],
      supportedProtocols: ['openai-compatible'],
      allowsCustomEndpoint: false,
      origin: null,
      createLanguageModel: () => Promise.reject(new Error('not exercised')),
    };
    await expect(fetchDriverQuota({
      driver,
      connection: connection(),
      provider: provider(),
      credential: { kind: 'api-key', apiKey: 'key' },
    })).rejects.toThrowError(/no quota facet/);
  });

  it('rejects an invalid driver payload rather than trusting it', async () => {
    const request: ConnectionQuotaRequest = {
      driver: driverWithQuota(vi.fn(async () => ({ bad: true }))),
      connection: connection(),
      provider: provider(),
      credential: { kind: 'api-key', apiKey: 'key' },
    };
    await expect(fetchDriverQuota(request)).rejects.toThrowError(/does not match the typed contract/);
  });
});

describe('observationWithQuota', () => {
  it('stores typed quota on data.quota without disturbing existing data', () => {
    const result = observationWithQuota(observation(), quota(), NOW);
    expect(result.data['quota']).toEqual(quota());
    expect(result.data['accountingMethod']).toBe('energy');
    expect(result.stale).toBe(false);
  });

  it('an absent quota degrades to stale without dropping prior data', () => {
    const prior = observation({ data: { accountingMethod: 'energy', quota: quota() } });
    const result = observationWithQuota(prior, undefined, NOW);
    expect(result.stale).toBe(true);
    expect(result.data['quota']).toEqual(quota());
  });

  it('a future-dated quota marks the observation stale but keeps the data', () => {
    const result = observationWithQuota(
      observation(),
      quota({ observedAt: '2026-07-13T00:00:00.000Z' }),
      NOW,
    );
    expect(result.stale).toBe(true);
    expect(result.data['quota']).toMatchObject({ observedAt: '2026-07-13T00:00:00.000Z' });
  });

  it('never fabricates balances or subscription for an empty quota', () => {
    const empty = quota({ balances: [], subscription: null, allowances: [] });
    const result = observationWithQuota(observation(), empty, NOW);
    expect(result.data['quota']).toEqual(empty);
  });
});
