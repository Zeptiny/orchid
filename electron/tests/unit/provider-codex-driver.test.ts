import { beforeEach, describe, expect, it, vi } from 'vitest';
import { importESM } from '../../src/main/utils/esm-import';
import type { DriverModelRequest } from '../../src/main/providers/drivers/types';

vi.mock('../../src/main/utils/esm-import', () => ({ importESM: vi.fn() }));

const compatibleModel = { kind: 'codex-subscription-model' };
const createOpenAICompatible = vi.fn(() => vi.fn(() => compatibleModel));

const release = {
  enabled: true,
  integrationVersion: 'v1.2.3',
  registration: {
    clientId: 'test-codex-public-client',
    termsReviewVersion: 'terms-2026-07',
    liveContractFixtureVersion: 'contract-2026-07-12',
  },
  endpoints: {
    requestBaseUrl: 'https://codex.release.example.test/v1',
    authorizationEndpoint: 'https://codex.release.example.test/oauth/authorize',
    tokenEndpoint: 'https://codex.release.example.test/oauth/token',
    deviceAuthorizationEndpoint: 'https://codex.release.example.test/oauth/device',
  },
  requestHeaders: {
    'X-Release-Contract': 'contract-2026-07-12',
  },
  accountHeaderName: 'X-Orchid-Test-Account',
} as const;

const request: DriverModelRequest = {
  connection: {
    id: '10000000-0000-4000-8000-000000000001',
    providerId: 'chatgpt-codex',
    name: 'Work Codex',
    protocol: 'openai-compatible',
    authMethod: 'oauth',
    credential: { kind: 'stored', handle: '20000000-0000-4000-8000-000000000001' },
    modelIds: [],
    health: 'ready',
  },
  provider: {
    id: 'chatgpt-codex',
    displayName: 'ChatGPT/Codex',
    supportedAuthMethods: ['oauth'],
    supportedProtocols: ['openai-compatible'],
    allowsCustomModels: false,
    models: [{ id: 'gpt-5.2-codex', displayName: 'GPT-5.2 Codex', protocol: 'openai-compatible' }],
  },
  model: {
    id: 'gpt-5.2-codex',
    displayName: 'GPT-5.2 Codex',
    protocol: 'openai-compatible',
    source: 'catalog',
  },
  credential: { kind: 'oauth', accessToken: 'access-token-for-request-only' },
};

describe('ChatGPT/Codex subscription driver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(importESM).mockResolvedValue({ createOpenAICompatible });
  });

  it('uses the release-owned endpoint, OAuth access token, and Codex-only account header', async () => {
    const { createCodexSubscriptionDriver } = await import('../../src/main/providers/drivers/codex');
    const driver = createCodexSubscriptionDriver({
      release,
      accountIdForConnection: () => 'acct-work-only',
    });

    await expect(driver.createLanguageModel(request)).resolves.toBe(compatibleModel);

    expect(driver).toMatchObject({
      id: 'chatgpt-codex',
      supportedAuthMethods: ['oauth'],
      supportedProtocols: ['openai-compatible'],
      allowsCustomEndpoint: false,
      origin: release.endpoints.requestBaseUrl,
    });
    expect(createOpenAICompatible).toHaveBeenCalledWith({
      name: 'orchid-chatgpt-codex-subscription',
      baseURL: release.endpoints.requestBaseUrl,
      apiKey: 'access-token-for-request-only',
      headers: {
        'X-Orchid-Subscription-Driver': 'chatgpt-codex',
        'X-Orchid-Subscription-Integration': release.integrationVersion,
        'X-Release-Contract': release.requestHeaders['X-Release-Contract'],
        'X-Orchid-Test-Account': 'acct-work-only',
      },
    });
    expect(importESM).toHaveBeenCalledWith('@ai-sdk/openai-compatible');
  });

  it('rejects unsupported models and disabled release configurations before loading an adapter', async () => {
    const { createCodexSubscriptionDriver } = await import('../../src/main/providers/drivers/codex');
    const enabledDriver = createCodexSubscriptionDriver({ release });
    await expect(enabledDriver.createLanguageModel({
      ...request,
      model: { ...request.model, id: 'gpt-unknown' },
    })).rejects.toThrow(/not allowed/i);
    expect(importESM).not.toHaveBeenCalled();

    const disabledDriver = createCodexSubscriptionDriver({
      release: { ...release, enabled: false },
    });
    await expect(disabledDriver.createLanguageModel(request)).rejects.toThrow(/release/i);
    expect(importESM).not.toHaveBeenCalled();
  });

  it('exposes browser/device OAuth definitions and refreshes tokens only through a main-process transport', async () => {
    const {
      createCodexSubscriptionBrowserOAuthDefinition,
      createCodexSubscriptionDeviceOAuthDefinition,
      refreshCodexSubscriptionTokens,
    } = await import('../../src/main/providers/drivers/codex');
    expect(createCodexSubscriptionBrowserOAuthDefinition(release)).toEqual({
      authorizationEndpoint: release.endpoints.authorizationEndpoint,
      clientId: release.registration.clientId,
      scopes: ['openid', 'offline_access'],
    });
    expect(createCodexSubscriptionDeviceOAuthDefinition(release)).toEqual({
      deviceAuthorizationEndpoint: release.endpoints.deviceAuthorizationEndpoint,
      clientId: release.registration.clientId,
      scopes: ['openid', 'offline_access'],
    });

    const postForm = vi.fn(async () => ({
      accessToken: 'refreshed-access-token',
      refreshToken: 'rotated-refresh-token',
      expiresInSeconds: 3600,
      tokenType: 'Bearer',
    }));
    const refreshed = await refreshCodexSubscriptionTokens({
      release,
      tokens: {
        accessToken: 'old-access-token',
        refreshToken: 'refresh-token-only-for-token-endpoint',
        expiresAt: '2026-07-12T00:00:00.000Z',
        tokenType: 'Bearer',
      },
      postForm,
      now: () => new Date('2026-07-12T00:00:00.000Z'),
    });

    expect(postForm).toHaveBeenCalledWith({
      url: release.endpoints.tokenEndpoint,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: {
        grant_type: 'refresh_token',
        client_id: release.registration.clientId,
        refresh_token: 'refresh-token-only-for-token-endpoint',
      },
    });
    expect(refreshed).toEqual({
      accessToken: 'refreshed-access-token',
      refreshToken: 'rotated-refresh-token',
      expiresAt: '2026-07-12T01:00:00.000Z',
      tokenType: 'Bearer',
    });
  });

  it('marks subscription quota-only usage as an unknown monetary cost rather than zero', async () => {
    const { extractCodexSubscriptionCost } = await import('../../src/main/providers/drivers/codex');

    expect(extractCodexSubscriptionCost({
      quota: { used: 12, limit: 40, resetAt: '2026-07-13T00:00:00.000Z' },
    })).toEqual({
      state: 'unknown',
      source: 'subscription-quota',
      reason: 'no-authoritative-monetary-charge',
      quota: { used: 12, limit: 40, resetAt: '2026-07-13T00:00:00.000Z' },
    });
  });
});
