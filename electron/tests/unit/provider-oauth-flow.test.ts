import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockSafeStorage = {
  isEncryptionAvailable: vi.fn(() => true),
  getSelectedStorageBackend: vi.fn(() => 'gnome_libsecret'),
  encryptString: vi.fn((value: string) => Buffer.from(`encrypted:${value}`, 'utf8')),
  decryptString: vi.fn((value: Buffer) => value.toString('utf8').replace(/^encrypted:/, '')),
};

vi.mock('electron', () => ({ safeStorage: mockSafeStorage }));

let vaultModule: typeof import('../../src/main/providers/credentials/vault');
let oauthModule: typeof import('../../src/main/providers/credentials/oauth-flow');
let tempDir: string;
let now: Date;
let browserCallback: ((input: { state: string; code: string }) => Promise<void>) | null;
let closeBrowserCallbackServer: ReturnType<typeof vi.fn>;

const binding = {
  connectionId: '33333333-3333-4333-8333-333333333333',
  driverId: 'chatgpt-codex',
  authMethod: 'oauth' as const,
  origin: 'https://api.openai.com/v1',
};

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mockSafeStorage.isEncryptionAvailable.mockReturnValue(true);
  mockSafeStorage.getSelectedStorageBackend.mockReturnValue('gnome_libsecret');
  mockSafeStorage.encryptString.mockImplementation((value: string) => Buffer.from(`encrypted:${value}`, 'utf8'));
  mockSafeStorage.decryptString.mockImplementation((value: Buffer) => value.toString('utf8').replace(/^encrypted:/, ''));
  vi.doMock('electron', () => ({ safeStorage: mockSafeStorage }));
  vaultModule = await import('../../src/main/providers/credentials/vault');
  oauthModule = await import('../../src/main/providers/credentials/oauth-flow');
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-oauth-flow-'));
  now = new Date('2026-07-12T00:00:00.000Z');
  browserCallback = null;
  closeBrowserCallbackServer = vi.fn(async () => {});
});

afterEach(async () => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function createManager() {
  const vault = new vaultModule.CredentialVault({
    credentialsPath: path.join(tempDir, 'credentials.json'),
  });
  return {
    vault,
    manager: new oauthModule.OAuthFlowManager({
      vault,
      now: () => now,
      sleep: async () => {},
      createLoopbackCallbackServer: async (_callbackPath, onAuthorization) => {
        browserCallback = async (input) => {
          await onAuthorization(input);
          await closeBrowserCallbackServer();
        };
        return {
          redirectUri: 'http://127.0.0.1:42424/oauth/callback',
          close: closeBrowserCallbackServer,
        };
      },
    }),
  };
}

const tokens = {
  accessToken: 'access-token-123456789012345',
  refreshToken: 'refresh-token-123456789012345',
  expiresAt: '2026-07-12T01:00:00.000Z',
  tokenType: 'Bearer',
};

describe('OAuthFlowManager browser callback flow', () => {
  it('uses loopback state and PKCE, stores exchanged tokens only in the vault, and closes the callback server', async () => {
    const { manager, vault } = createManager();
    const exchangeAuthorizationCode = vi.fn(async (request: { code: string; codeVerifier: string }) => {
      expect(request.code).toBe('authorization-code');
      expect(request.codeVerifier.length).toBeGreaterThan(40);
      return tokens;
    });

    const flow = await manager.startBrowserFlow({
      binding,
      authorizationEndpoint: 'https://auth.example.test/authorize',
      clientId: 'orchid-client',
      scopes: ['openid', 'profile'],
      exchangeAuthorizationCode,
    });
    const authorizationUrl = new URL(flow.authorizationUrl);
    expect(authorizationUrl.searchParams.get('state')).toBe(flow.state);
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(flow.redirectUri.startsWith('http://127.0.0.1:')).toBe(true);

    await browserCallback!({ state: flow.state, code: 'authorization-code' });
    const completion = await flow.completion;
    expect(exchangeAuthorizationCode).toHaveBeenCalledTimes(1);
    expect(await vault.readSecret(completion.handle, binding)).toMatchObject({
      kind: 'oauth',
      accessToken: tokens.accessToken,
    });
    expect(fs.readFileSync(path.join(tempDir, 'credentials.json'), 'utf8')).not.toContain(tokens.accessToken);
    expect(manager.browserFlowCount()).toBe(0);
    expect(closeBrowserCallbackServer).toHaveBeenCalledTimes(1);

    await expect(manager.completeBrowserAuthorization({
      state: flow.state,
      code: 'authorization-code',
    })).rejects.toThrow(/state/i);
  });

  it('rejects mismatched, expired, and non-loopback callback flow inputs without persisting a credential', async () => {
    const { manager } = createManager();
    expect(() => oauthModule.validateLoopbackRedirectUri('https://auth.example.test/callback'))
      .toThrow(/loopback/i);

    const flow = await manager.startBrowserFlow({
      binding,
      authorizationEndpoint: 'https://auth.example.test/authorize',
      clientId: 'orchid-client',
      scopes: [],
      expiresInMs: 1000,
      exchangeAuthorizationCode: async () => tokens,
    });
    await expect(manager.completeBrowserAuthorization({ state: 'wrong-state', code: 'x' }))
      .rejects.toThrow(/state/i);

    now = new Date('2026-07-12T00:00:02.000Z');
    await expect(manager.completeBrowserAuthorization({ state: flow.state, code: 'x' }))
      .rejects.toThrow(/expired/i);
    await manager.cancelBrowserFlow(flow.state);
  });

  it('cancels browser flow, closes the loopback listener, and retains no pending PKCE state', async () => {
    const { manager } = createManager();
    const flow = await manager.startBrowserFlow({
      binding,
      authorizationEndpoint: 'https://auth.example.test/authorize',
      clientId: 'orchid-client',
      scopes: [],
      exchangeAuthorizationCode: async () => tokens,
    });

    await manager.cancelBrowserFlow(flow.state);
    await expect(flow.completion).rejects.toThrow(/cancelled/i);
    expect(closeBrowserCallbackServer).toHaveBeenCalledTimes(1);
    expect(manager.browserFlowCount()).toBe(0);
  });
});

describe('OAuthFlowManager device flow', () => {
  it('honors authorization_pending and slow_down before atomically persisting tokens', async () => {
    const { manager, vault } = createManager();
    const waits: number[] = [];
    const pollToken = vi.fn()
      .mockResolvedValueOnce({ kind: 'authorization_pending' })
      .mockResolvedValueOnce({ kind: 'slow_down' })
      .mockResolvedValueOnce({ kind: 'success', tokens });
    const deviceManager = new oauthModule.OAuthFlowManager({
      vault,
      now: () => now,
      sleep: async (milliseconds: number) => { waits.push(milliseconds); },
    });

    const flow = await deviceManager.startDeviceFlow({
      binding,
      requestDeviceCode: async () => ({
        deviceCode: 'device-code-not-rendered',
        userCode: 'ABCD-EFGH',
        verificationUri: 'https://auth.example.test/device',
        expiresInSeconds: 300,
        intervalSeconds: 2,
      }),
      pollToken,
    });
    expect(flow).toMatchObject({ userCode: 'ABCD-EFGH' });
    expect(JSON.stringify(flow)).not.toContain('device-code-not-rendered');

    const completion = await deviceManager.pollDeviceFlow(flow.id);
    expect(waits).toEqual([2000, 7000]);
    expect(await vault.readSecret(completion.handle, binding)).toMatchObject({ kind: 'oauth' });
  });

  it('cancels device flow before any token request and releases its pending state', async () => {
    const { manager } = createManager();
    const pollToken = vi.fn();
    const flow = await manager.startDeviceFlow({
      binding,
      requestDeviceCode: async () => ({
        deviceCode: 'device-code',
        userCode: 'ABCD-EFGH',
        verificationUri: 'https://auth.example.test/device',
        expiresInSeconds: 300,
        intervalSeconds: 2,
      }),
      pollToken,
    });
    manager.cancelDeviceFlow(flow.id);
    await expect(manager.pollDeviceFlow(flow.id)).rejects.toThrow(/cancelled/i);
    expect(pollToken).not.toHaveBeenCalled();
    expect(manager.deviceFlowCount()).toBe(0);
  });
});
