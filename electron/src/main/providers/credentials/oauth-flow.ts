import * as http from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import {
  CredentialVault,
  normalizeCredentialBinding,
  type CredentialBinding,
  type CredentialMetadata,
  type OAuthTokens,
} from './vault';

export interface OAuthCodeExchangeRequest {
  readonly code: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
  readonly connectionId: string;
  readonly driverId: string;
}

export interface BrowserOAuthFlowInput {
  readonly binding: CredentialBinding;
  readonly authorizationEndpoint: string;
  readonly clientId: string;
  readonly scopes: readonly string[];
  readonly exchangeAuthorizationCode: (request: OAuthCodeExchangeRequest) => Promise<OAuthTokens>;
  readonly callbackPath?: string;
  readonly expiresInMs?: number;
}

export interface OAuthFlowCompletion {
  readonly handle: string;
  readonly metadata: CredentialMetadata;
}

export interface BrowserOAuthFlow {
  readonly state: string;
  readonly authorizationUrl: string;
  readonly redirectUri: string;
  readonly expiresAt: string;
  /** Main-process promise; renderer IPC exposes only a redacted completion DTO later. */
  readonly completion: Promise<OAuthFlowCompletion>;
}

export interface DeviceCodeResponse {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete?: string;
  readonly expiresInSeconds: number;
  readonly intervalSeconds: number;
}

export type DeviceTokenPollResult =
  | { readonly kind: 'authorization_pending' }
  | { readonly kind: 'slow_down' }
  | { readonly kind: 'success'; readonly tokens: OAuthTokens }
  | { readonly kind: 'error'; readonly error: string };

export interface DeviceOAuthFlowInput {
  readonly binding: CredentialBinding;
  readonly requestDeviceCode: () => Promise<DeviceCodeResponse>;
  readonly pollToken: (request: {
    readonly deviceCode: string;
    readonly connectionId: string;
    readonly driverId: string;
  }) => Promise<DeviceTokenPollResult>;
}

export interface DeviceOAuthFlow {
  readonly id: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete?: string;
  readonly expiresAt: string;
}

export interface OAuthFlowManagerOptions {
  readonly vault: CredentialVault;
  readonly now?: () => Date;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly createLoopbackCallbackServer?: LoopbackCallbackServerFactory;
}

export interface LoopbackCallbackInput {
  readonly state: string;
  readonly code: string;
}

export interface LoopbackCallbackServer {
  readonly redirectUri: string;
  close(): Promise<void>;
}

export type LoopbackCallbackServerFactory = (
  callbackPath: string,
  onAuthorization: (input: LoopbackCallbackInput) => Promise<void>,
) => Promise<LoopbackCallbackServer>;

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

interface PendingBrowserFlow {
  readonly state: string;
  readonly binding: CredentialBinding;
  readonly codeVerifier: string;
  readonly redirectUri: string;
  readonly expiresAt: number;
  readonly exchangeAuthorizationCode: BrowserOAuthFlowInput['exchangeAuthorizationCode'];
  readonly listener: LoopbackCallbackServer;
  readonly deferred: Deferred<OAuthFlowCompletion>;
  readonly expiryTimer: ReturnType<typeof setTimeout>;
  used: boolean;
}

interface PendingDeviceFlow {
  readonly id: string;
  readonly binding: CredentialBinding;
  readonly deviceCode: string;
  readonly expiresAt: number;
  readonly pollToken: DeviceOAuthFlowInput['pollToken'];
  intervalMs: number;
}

const DEFAULT_BROWSER_FLOW_EXPIRY_MS = 10 * 60 * 1000;

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  // A user may cancel a flow without observing the internal completion promise.
  // Mark that rejection handled while still preserving the returned promise.
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function base64Url(value: Buffer): string {
  return value.toString('base64url');
}

function assertHttpsEndpoint(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error(`${label} is invalid`, { cause: error });
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error(`${label} must be a credential-free HTTPS URL`);
  }
  return url;
}

function callbackPath(value: string | undefined): string {
  const result = value ?? '/oauth/callback';
  if (!result.startsWith('/') || result.includes('..') || result.includes('?') || result.includes('#')) {
    throw new Error('OAuth callback path must be an absolute safe path');
  }
  return result;
}

function isLoopbackAddress(address: string | undefined): boolean {
  return address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1';
}

export function validateLoopbackRedirectUri(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error('OAuth redirect URI is invalid', { cause: error });
  }
  if (url.protocol !== 'http:'
    || !['127.0.0.1', '::1', 'localhost'].includes(url.hostname)
    || url.username
    || url.password
    || url.search
    || url.hash) {
    throw new Error('OAuth redirect URI must be a credential-free loopback HTTP URL');
  }
  return url;
}

function closeServer(server: http.Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function listenLoopback(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      const address = server.address() as AddressInfo;
      resolve(address.port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });
}

async function createDefaultLoopbackCallbackServer(
  expectedPath: string,
  onAuthorization: (input: LoopbackCallbackInput) => Promise<void>,
): Promise<LoopbackCallbackServer> {
  const server = http.createServer((request, response) => {
    void (async () => {
      if (!isLoopbackAddress(request.socket.remoteAddress)) {
        response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('Loopback callback rejected.');
        return;
      }
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== expectedPath) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('Not found.');
        return;
      }
      const state = url.searchParams.get('state');
      const code = url.searchParams.get('code');
      if (!state || !code) {
        response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('Missing OAuth callback state or code.');
        return;
      }
      try {
        await onAuthorization({ state, code });
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('Authentication complete. You can return to Orchid.');
      } catch {
        response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('Authentication could not be completed. Return to Orchid and try again.');
      } finally {
        // Do not await close before ending this response: server.close waits
        // for active connections, including this callback request.
        void closeServer(server);
      }
    })();
  });
  const port = await listenLoopback(server);
  return {
    redirectUri: `http://127.0.0.1:${port}${expectedPath}`,
    close: () => closeServer(server),
  };
}

/**
 * Main-process PKCE/browser callback and device-code coordinator. Providers
 * supply their code-owned endpoints and exchange implementation; remote catalog
 * data never reaches this class.
 */
export class OAuthFlowManager {
  private readonly vault: CredentialVault;
  private readonly now: () => Date;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly createLoopbackCallbackServer: LoopbackCallbackServerFactory;
  private readonly browserFlows = new Map<string, PendingBrowserFlow>();
  private readonly deviceFlows = new Map<string, PendingDeviceFlow>();
  private readonly cancelledDeviceFlowIds = new Set<string>();

  constructor(options: OAuthFlowManagerOptions) {
    this.vault = options.vault;
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.createLoopbackCallbackServer = options.createLoopbackCallbackServer
      ?? createDefaultLoopbackCallbackServer;
  }

  async startBrowserFlow(input: BrowserOAuthFlowInput): Promise<BrowserOAuthFlow> {
    const binding = normalizeCredentialBinding(input.binding);
    if (binding.authMethod !== 'oauth') throw new Error('Browser OAuth requires an oauth credential binding');
    const endpoint = assertHttpsEndpoint(input.authorizationEndpoint, 'OAuth authorization endpoint');
    if (!input.clientId.trim()) throw new Error('OAuth client id must not be empty');

    const state = base64Url(randomBytes(32));
    const codeVerifier = base64Url(randomBytes(64));
    const codeChallenge = base64Url(createHash('sha256').update(codeVerifier).digest());
    const expiresAt = this.now().getTime() + (input.expiresInMs ?? DEFAULT_BROWSER_FLOW_EXPIRY_MS);
    const completion = deferred<OAuthFlowCompletion>();
    const path = callbackPath(input.callbackPath);
    const listener = await this.createLoopbackCallbackServer(path, async ({ state: callbackState, code }) => {
      const pending = this.browserFlows.get(callbackState);
      if (!pending) throw new Error('OAuth callback state is unknown, expired, or already consumed');
      await this.finalizeBrowserAuthorization(pending, code);
    });
    const redirectUri = listener.redirectUri;
    validateLoopbackRedirectUri(redirectUri);
    const pending: PendingBrowserFlow = {
      state,
      binding,
      codeVerifier,
      redirectUri,
      expiresAt,
      exchangeAuthorizationCode: input.exchangeAuthorizationCode,
      listener,
      deferred: completion,
      expiryTimer: setTimeout(() => {
        void this.expireBrowserFlow(state).catch(() => undefined);
      }, Math.max(0, expiresAt - this.now().getTime())),
      used: false,
    };
    pending.expiryTimer.unref?.();
    this.browserFlows.set(state, pending);

    endpoint.searchParams.set('response_type', 'code');
    endpoint.searchParams.set('client_id', input.clientId);
    endpoint.searchParams.set('redirect_uri', redirectUri);
    endpoint.searchParams.set('state', state);
    endpoint.searchParams.set('code_challenge', codeChallenge);
    endpoint.searchParams.set('code_challenge_method', 'S256');
    if (input.scopes.length > 0) endpoint.searchParams.set('scope', input.scopes.join(' '));

    return {
      state,
      authorizationUrl: endpoint.toString(),
      redirectUri,
      expiresAt: new Date(expiresAt).toISOString(),
      completion: completion.promise,
    };
  }

  async completeBrowserAuthorization(input: {
    readonly state: string;
    readonly code: string;
  }): Promise<OAuthFlowCompletion> {
    const pending = this.browserFlows.get(input.state);
    if (!pending) throw new Error('OAuth callback state is unknown, expired, or already consumed');
    try {
      return await this.finalizeBrowserAuthorization(pending, input.code);
    } finally {
      await pending.listener.close();
    }
  }

  async cancelBrowserFlow(state: string): Promise<void> {
    const pending = this.browserFlows.get(state);
    if (!pending) return;
    this.deleteBrowserFlow(pending);
    pending.deferred.reject(new Error('OAuth flow cancelled'));
    await pending.listener.close();
  }

  browserFlowCount(): number {
    return this.browserFlows.size;
  }

  async startDeviceFlow(input: DeviceOAuthFlowInput): Promise<DeviceOAuthFlow> {
    const binding = normalizeCredentialBinding(input.binding);
    if (binding.authMethod !== 'oauth') throw new Error('Device OAuth requires an oauth credential binding');
    const response = await input.requestDeviceCode();
    if (!response.deviceCode || !response.userCode || response.expiresInSeconds <= 0 || response.intervalSeconds <= 0) {
      throw new Error('Provider returned an invalid device authorization response');
    }
    assertHttpsEndpoint(response.verificationUri, 'Device verification URI');
    if (response.verificationUriComplete) {
      assertHttpsEndpoint(response.verificationUriComplete, 'Complete device verification URI');
    }
    const id = randomUUID();
    const expiresAt = this.now().getTime() + (response.expiresInSeconds * 1000);
    this.deviceFlows.set(id, {
      id,
      binding,
      deviceCode: response.deviceCode,
      expiresAt,
      pollToken: input.pollToken,
      intervalMs: response.intervalSeconds * 1000,
    });
    return {
      id,
      userCode: response.userCode,
      verificationUri: response.verificationUri,
      verificationUriComplete: response.verificationUriComplete,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  async pollDeviceFlow(id: string): Promise<OAuthFlowCompletion> {
    const pending = this.deviceFlows.get(id);
    if (!pending) {
      if (this.cancelledDeviceFlowIds.delete(id)) throw new Error('OAuth device flow was cancelled');
      throw new Error('OAuth device flow is unknown or expired');
    }
    while (true) {
      if (!this.deviceFlows.has(id)) throw new Error('OAuth device flow was cancelled');
      if (this.now().getTime() >= pending.expiresAt) {
        this.deviceFlows.delete(id);
        throw new Error('OAuth device flow expired');
      }
      const result = await pending.pollToken({
        deviceCode: pending.deviceCode,
        connectionId: pending.binding.connectionId,
        driverId: pending.binding.driverId,
      });
      if (!this.deviceFlows.has(id)) throw new Error('OAuth device flow was cancelled');
      if (result.kind === 'success') {
        try {
          const handle = await this.vault.storeOAuthTokens(pending.binding, result.tokens);
          const record = await this.vault.getMetadata(handle);
          return { handle, metadata: record };
        } finally {
          this.deviceFlows.delete(id);
        }
      }
      if (result.kind === 'error') {
        this.deviceFlows.delete(id);
        throw new Error(`OAuth device flow failed: ${result.error}`);
      }
      if (result.kind === 'slow_down') pending.intervalMs += 5000;
      await this.sleep(pending.intervalMs);
    }
  }

  cancelDeviceFlow(id: string): void {
    if (this.deviceFlows.delete(id)) this.cancelledDeviceFlowIds.add(id);
  }

  deviceFlowCount(): number {
    return this.deviceFlows.size;
  }

  private async finalizeBrowserAuthorization(
    pending: PendingBrowserFlow,
    code: string,
  ): Promise<OAuthFlowCompletion> {
    if (this.now().getTime() >= pending.expiresAt) {
      this.deleteBrowserFlow(pending);
      const error = new Error('OAuth callback state expired');
      pending.deferred.reject(error);
      throw error;
    }
    if (pending.used) throw new Error('OAuth authorization code was already consumed');
    pending.used = true;
    try {
      const tokens = await pending.exchangeAuthorizationCode({
        code,
        codeVerifier: pending.codeVerifier,
        redirectUri: pending.redirectUri,
        connectionId: pending.binding.connectionId,
        driverId: pending.binding.driverId,
      });
      if (this.browserFlows.get(pending.state) !== pending) {
        throw new Error('OAuth flow was cancelled');
      }
      const handle = await this.vault.storeOAuthTokens(pending.binding, tokens);
      const completion: OAuthFlowCompletion = {
        handle,
        metadata: await this.vault.getMetadata(handle),
      };
      this.deleteBrowserFlow(pending);
      pending.deferred.resolve(completion);
      return completion;
    } catch (error) {
      this.deleteBrowserFlow(pending);
      pending.deferred.reject(error);
      throw error;
    }
  }

  private deleteBrowserFlow(pending: PendingBrowserFlow): void {
    if (this.browserFlows.get(pending.state) !== pending) return;
    this.browserFlows.delete(pending.state);
    clearTimeout(pending.expiryTimer);
  }

  private async expireBrowserFlow(state: string): Promise<void> {
    const pending = this.browserFlows.get(state);
    if (!pending) return;
    this.deleteBrowserFlow(pending);
    pending.deferred.reject(new Error('OAuth flow expired'));
    await pending.listener.close();
  }
}
