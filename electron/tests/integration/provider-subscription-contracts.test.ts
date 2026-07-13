import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const safeStorage = {
  isEncryptionAvailable: vi.fn(() => true),
  getSelectedStorageBackend: vi.fn(() => 'gnome_libsecret'),
  encryptString: vi.fn((value: string) => Buffer.from(`encrypted:${value}`, 'utf8')),
  decryptString: vi.fn((value: Buffer) => value.toString('utf8').replace(/^encrypted:/, '')),
};

vi.mock('electron', () => ({ safeStorage }));

let tempDir: string;

const validRelease = {
  enabled: true,
  integrationVersion: 'v1.0.0',
  registration: {
    clientId: 'test-public-client',
    termsReviewVersion: 'terms-2026-07',
    liveContractFixtureVersion: 'contract-2026-07-12',
  },
  endpoints: {
    requestBaseUrl: 'https://subscription.release.example.test/v1',
    authorizationEndpoint: 'https://subscription.release.example.test/oauth/authorize',
    tokenEndpoint: 'https://subscription.release.example.test/oauth/token',
    deviceAuthorizationEndpoint: 'https://subscription.release.example.test/oauth/device',
  },
  requestHeaders: {},
} as const;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-subscription-contract-'));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('subscription driver release contracts', () => {
  it.each([
    ['disabled-by-release-config', { ...validRelease, enabled: false }],
    ['missing-integration-version', { ...validRelease, integrationVersion: undefined }],
    ['missing-registration', { ...validRelease, registration: undefined }],
    ['missing-live-contract-fixture', {
      ...validRelease,
      registration: { ...validRelease.registration, liveContractFixtureVersion: undefined },
    }],
  ] as const)('does not enable a driver when %s', async (reason, release) => {
    const { evaluateSubscriptionReleaseEnablement } = await import('../../src/main/providers/drivers/subscription');

    expect(evaluateSubscriptionReleaseEnablement(release)).toEqual({
      enabled: false,
      reason,
    });
  });

  it('feeds the release-owned Codex OAuth definition into the PKCE browser flow and keeps tokens in the vault', async () => {
    const { CredentialVault } = await import('../../src/main/providers/credentials/vault');
    const { OAuthFlowManager } = await import('../../src/main/providers/credentials/oauth-flow');
    const { createCodexSubscriptionBrowserOAuthDefinition } = await import('../../src/main/providers/drivers/codex');
    const vault = new CredentialVault({ credentialsPath: path.join(tempDir, 'credentials.json') });
    let completeCallback: ((input: { state: string; code: string }) => Promise<void>) | undefined;
    const manager = new OAuthFlowManager({
      vault,
      createLoopbackCallbackServer: async (_callbackPath, onAuthorization) => {
        completeCallback = onAuthorization;
        return {
          redirectUri: 'http://127.0.0.1:41414/oauth/callback',
          close: async () => {},
        };
      },
    });
    const definition = createCodexSubscriptionBrowserOAuthDefinition(validRelease);
    const binding = {
      connectionId: '10000000-0000-4000-8000-000000000099',
      driverId: 'chatgpt-codex',
      authMethod: 'oauth' as const,
      origin: validRelease.endpoints.requestBaseUrl,
    };
    const flow = await manager.startBrowserFlow({
      binding,
      authorizationEndpoint: definition.authorizationEndpoint,
      clientId: definition.clientId,
      scopes: definition.scopes,
      exchangeAuthorizationCode: async ({ code, codeVerifier }) => {
        expect(code).toBe('test-code');
        expect(codeVerifier.length).toBeGreaterThan(40);
        return {
          accessToken: 'contract-access-token',
          refreshToken: 'contract-refresh-token',
          expiresAt: '2026-07-13T00:00:00.000Z',
          tokenType: 'Bearer',
        };
      },
    });

    expect(new URL(flow.authorizationUrl).searchParams.get('code_challenge_method')).toBe('S256');
    await completeCallback!({ state: flow.state, code: 'test-code' });
    const completion = await flow.completion;
    expect(await vault.readSecret(completion.handle, binding)).toMatchObject({ kind: 'oauth' });
    const persisted = fs.readFileSync(path.join(tempDir, 'credentials.json'), 'utf8');
    expect(persisted).not.toContain('contract-access-token');
    expect(persisted).not.toContain('contract-refresh-token');
  });

  it('represents quota-only subscription usage as unknown money across both drivers', async () => {
    const { extractCodexSubscriptionCost } = await import('../../src/main/providers/drivers/codex');
    const { extractGrokSubscriptionCost } = await import('../../src/main/providers/drivers/grok-subscription');

    expect(extractCodexSubscriptionCost({ quota: { used: 1, limit: 10 } }).state).toBe('unknown');
    expect(extractGrokSubscriptionCost({ quota: { used: 1, limit: 10 } }).state).toBe('unknown');
  });
});
