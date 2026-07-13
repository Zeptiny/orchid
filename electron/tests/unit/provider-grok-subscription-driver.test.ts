import { beforeEach, describe, expect, it, vi } from 'vitest';
import { importESM } from '../../src/main/utils/esm-import';
import type { DriverModelRequest } from '../../src/main/providers/drivers/types';

vi.mock('../../src/main/utils/esm-import', () => ({ importESM: vi.fn() }));

const xaiModel = { kind: 'grok-subscription-model' };
const createXai = vi.fn(() => ({ chat: vi.fn(() => xaiModel) }));

const release = {
  enabled: true,
  integrationVersion: 'v2.0.1',
  registration: {
    clientId: 'test-grok-public-client',
    termsReviewVersion: 'terms-2026-07',
    liveContractFixtureVersion: 'contract-2026-07-12',
  },
  endpoints: {
    requestBaseUrl: 'https://grok.release.example.test/v1',
    authorizationEndpoint: 'https://grok.release.example.test/oauth/authorize',
    tokenEndpoint: 'https://grok.release.example.test/oauth/token',
    deviceAuthorizationEndpoint: 'https://grok.release.example.test/oauth/device',
  },
  requestHeaders: {
    'X-Release-Contract': 'contract-2026-07-12',
  },
} as const;

const request: DriverModelRequest = {
  connection: {
    id: '10000000-0000-4000-8000-000000000002',
    providerId: 'grok-subscription',
    name: 'Grok subscription',
    protocol: 'xai',
    authMethod: 'oauth',
    credential: { kind: 'stored', handle: '20000000-0000-4000-8000-000000000002' },
    modelIds: [],
    health: 'ready',
  },
  provider: {
    id: 'grok-subscription',
    displayName: 'Grok subscription',
    supportedAuthMethods: ['oauth'],
    supportedProtocols: ['xai'],
    allowsCustomModels: false,
    models: [{ id: 'grok-4.3', displayName: 'Grok 4.3', protocol: 'xai' }],
  },
  model: {
    id: 'grok-4.3',
    displayName: 'Grok 4.3',
    protocol: 'xai',
    source: 'catalog',
  },
  credential: { kind: 'oauth', accessToken: 'grok-access-token-for-request-only' },
};

describe('Grok subscription driver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(importESM).mockResolvedValue({ createXai });
  });

  it('uses its release-owned xAI transport without applying Codex account behavior', async () => {
    const { createGrokSubscriptionDriver } = await import('../../src/main/providers/drivers/grok-subscription');
    const driver = createGrokSubscriptionDriver({ release });

    await expect(driver.createLanguageModel(request)).resolves.toBe(xaiModel);

    expect(driver).toMatchObject({
      id: 'grok-subscription',
      supportedAuthMethods: ['oauth'],
      supportedProtocols: ['xai'],
      allowsCustomEndpoint: false,
      origin: release.endpoints.requestBaseUrl,
    });
    expect(createXai).toHaveBeenCalledWith({
      baseURL: release.endpoints.requestBaseUrl,
      apiKey: 'grok-access-token-for-request-only',
      headers: {
        'X-Orchid-Subscription-Driver': 'grok-subscription',
        'X-Orchid-Subscription-Integration': release.integrationVersion,
        'X-Release-Contract': release.requestHeaders['X-Release-Contract'],
      },
    });
    expect(importESM).toHaveBeenCalledWith('@ai-sdk/xai');
  });

  it('requires a listed xAI model and OAuth credentials before adapter construction', async () => {
    const { createGrokSubscriptionDriver } = await import('../../src/main/providers/drivers/grok-subscription');
    const driver = createGrokSubscriptionDriver({ release });

    await expect(driver.createLanguageModel({
      ...request,
      model: { ...request.model, id: 'grok-unknown' },
    })).rejects.toThrow(/not allowed/i);
    await expect(driver.createLanguageModel({
      ...request,
      credential: { kind: 'api-key', apiKey: 'must-not-be-used' },
    })).rejects.toThrow(/OAuth/i);
    expect(importESM).not.toHaveBeenCalled();
  });

  it('provides only release-approved device OAuth metadata and refreshes through the token endpoint', async () => {
    const {
      createGrokSubscriptionDeviceOAuthDefinition,
      refreshGrokSubscriptionTokens,
    } = await import('../../src/main/providers/drivers/grok-subscription');
    expect(createGrokSubscriptionDeviceOAuthDefinition(release)).toEqual({
      deviceAuthorizationEndpoint: release.endpoints.deviceAuthorizationEndpoint,
      clientId: release.registration.clientId,
      scopes: ['openid', 'offline_access'],
    });

    const postForm = vi.fn(async () => ({
      accessToken: 'grok-refreshed-token',
      expiresAt: '2026-07-12T04:00:00.000Z',
      tokenType: 'Bearer',
    }));
    await expect(refreshGrokSubscriptionTokens({
      release,
      tokens: {
        accessToken: 'grok-old-token',
        refreshToken: 'grok-refresh-token',
        expiresAt: '2026-07-12T00:00:00.000Z',
        tokenType: 'Bearer',
      },
      postForm,
    })).resolves.toEqual({
      accessToken: 'grok-refreshed-token',
      refreshToken: 'grok-refresh-token',
      expiresAt: '2026-07-12T04:00:00.000Z',
      tokenType: 'Bearer',
    });
  });
});
