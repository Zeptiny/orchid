import type { OAuthTokens } from '../credentials/vault';

/**
 * Build/release-owned subscription configuration. It is intentionally not part
 * of catalog or connection data: a remote catalog or renderer must never be
 * able to select where an OAuth token is sent.
 *
 * A registration contains only public-client information. These integrations
 * use PKCE and deliberately have no confidential-client credential field.
 */
export interface SubscriptionReleaseConfiguration {
  readonly enabled: boolean;
  readonly integrationVersion?: string;
  readonly registration?: {
    readonly clientId?: string;
    readonly termsReviewVersion?: string;
    readonly liveContractFixtureVersion?: string;
  };
  readonly endpoints?: {
    readonly requestBaseUrl?: string;
    readonly authorizationEndpoint?: string;
    readonly tokenEndpoint?: string;
    readonly deviceAuthorizationEndpoint?: string;
  };
  /** Static request headers approved with the versioned release contract. */
  readonly requestHeaders?: Readonly<Record<string, string>>;
}

export type SubscriptionReleaseBlockReason =
  | 'disabled-by-release-config'
  | 'missing-integration-version'
  | 'missing-registration'
  | 'missing-terms-review'
  | 'missing-live-contract-fixture'
  | 'missing-release-endpoints'
  | 'invalid-release-endpoint'
  | 'invalid-request-header';

export type SubscriptionReleaseEnablement =
  | {
      readonly enabled: true;
      readonly integrationVersion: string;
      readonly registration: {
        readonly clientId: string;
        readonly termsReviewVersion: string;
        readonly liveContractFixtureVersion: string;
      };
      readonly endpoints: {
        readonly requestBaseUrl: string;
        readonly authorizationEndpoint: string;
        readonly tokenEndpoint: string;
        readonly deviceAuthorizationEndpoint?: string;
      };
      readonly requestHeaders: Readonly<Record<string, string>>;
    }
  | {
      readonly enabled: false;
      readonly reason: SubscriptionReleaseBlockReason;
    };

export class SubscriptionReleaseDisabledError extends Error {
  constructor(readonly reason: SubscriptionReleaseBlockReason) {
    super(`Subscription integration is unavailable by release configuration: ${reason}`);
    this.name = 'SubscriptionReleaseDisabledError';
  }
}

const INTEGRATION_VERSION_PATTERN = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const BLOCKED_HEADER_NAMES = new Set([
  'authorization',
  'cookie',
  'content-length',
  'host',
  'x-orchid-subscription-driver',
  'x-orchid-subscription-integration',
]);

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function normalizeBuildOwnedEndpoint(value: string | undefined): string | undefined {
  const candidate = nonEmpty(value);
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:'
      || url.username !== ''
      || url.password !== ''
      || url.search !== ''
      || url.hash !== '') {
      return undefined;
    }
    return url.toString().replace(/\/$/, '');
  } catch {
    return undefined;
  }
}

function isSafeRequestHeader(name: string, value: string): boolean {
  return HEADER_NAME_PATTERN.test(name)
    && !BLOCKED_HEADER_NAMES.has(name.toLowerCase())
    && value.trim().length > 0
    && !/[\r\n]/.test(value);
}

function normalizeRequestHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined {
  if (!headers) return {};
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!isSafeRequestHeader(name, value)) return undefined;
    normalized[name] = value.trim();
  }
  return normalized;
}

/**
 * Validate all evidence required to turn on a subscription integration. The
 * result is safe for status/UI display because it intentionally omits tokens.
 */
export function evaluateSubscriptionReleaseEnablement(
  configuration: SubscriptionReleaseConfiguration,
): SubscriptionReleaseEnablement {
  if (!configuration.enabled) return { enabled: false, reason: 'disabled-by-release-config' };

  const integrationVersion = nonEmpty(configuration.integrationVersion);
  if (!integrationVersion || !INTEGRATION_VERSION_PATTERN.test(integrationVersion)) {
    return { enabled: false, reason: 'missing-integration-version' };
  }

  const registration = configuration.registration;
  const clientId = nonEmpty(registration?.clientId);
  if (!registration || !clientId) return { enabled: false, reason: 'missing-registration' };
  const termsReviewVersion = nonEmpty(registration.termsReviewVersion);
  if (!termsReviewVersion) return { enabled: false, reason: 'missing-terms-review' };
  const liveContractFixtureVersion = nonEmpty(registration.liveContractFixtureVersion);
  if (!liveContractFixtureVersion) return { enabled: false, reason: 'missing-live-contract-fixture' };

  const endpoints = configuration.endpoints;
  if (!endpoints) return { enabled: false, reason: 'missing-release-endpoints' };
  const requestBaseUrl = normalizeBuildOwnedEndpoint(endpoints.requestBaseUrl);
  const authorizationEndpoint = normalizeBuildOwnedEndpoint(endpoints.authorizationEndpoint);
  const tokenEndpoint = normalizeBuildOwnedEndpoint(endpoints.tokenEndpoint);
  if (!requestBaseUrl || !authorizationEndpoint || !tokenEndpoint) {
    return { enabled: false, reason: 'invalid-release-endpoint' };
  }
  const deviceAuthorizationEndpoint = endpoints.deviceAuthorizationEndpoint === undefined
    ? undefined
    : normalizeBuildOwnedEndpoint(endpoints.deviceAuthorizationEndpoint);
  if (endpoints.deviceAuthorizationEndpoint !== undefined && !deviceAuthorizationEndpoint) {
    return { enabled: false, reason: 'invalid-release-endpoint' };
  }

  const requestHeaders = normalizeRequestHeaders(configuration.requestHeaders);
  if (!requestHeaders) return { enabled: false, reason: 'invalid-request-header' };

  return {
    enabled: true,
    integrationVersion,
    registration: { clientId, termsReviewVersion, liveContractFixtureVersion },
    endpoints: {
      requestBaseUrl,
      authorizationEndpoint,
      tokenEndpoint,
      ...(deviceAuthorizationEndpoint ? { deviceAuthorizationEndpoint } : {}),
    },
    requestHeaders,
  };
}

export function assertSubscriptionReleaseEnabled(
  configuration: SubscriptionReleaseConfiguration,
): Extract<SubscriptionReleaseEnablement, { readonly enabled: true }> {
  const enablement = evaluateSubscriptionReleaseEnablement(configuration);
  if (!enablement.enabled) throw new SubscriptionReleaseDisabledError(enablement.reason);
  return enablement;
}

export interface SubscriptionBrowserOAuthDefinition {
  readonly authorizationEndpoint: string;
  readonly clientId: string;
  readonly scopes: readonly string[];
}

export interface SubscriptionDeviceOAuthDefinition {
  readonly deviceAuthorizationEndpoint: string;
  readonly clientId: string;
  readonly scopes: readonly string[];
}

function normalizeScopes(scopes: readonly string[]): readonly string[] {
  const normalized = [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))];
  if (normalized.length === 0) throw new Error('Subscription OAuth requires at least one scope');
  return normalized;
}

export function createSubscriptionBrowserOAuthDefinition(
  configuration: SubscriptionReleaseConfiguration,
  scopes: readonly string[],
): SubscriptionBrowserOAuthDefinition {
  const release = assertSubscriptionReleaseEnabled(configuration);
  return {
    authorizationEndpoint: release.endpoints.authorizationEndpoint,
    clientId: release.registration.clientId,
    scopes: normalizeScopes(scopes),
  };
}

export function createSubscriptionDeviceOAuthDefinition(
  configuration: SubscriptionReleaseConfiguration,
  scopes: readonly string[],
): SubscriptionDeviceOAuthDefinition {
  const release = assertSubscriptionReleaseEnabled(configuration);
  if (!release.endpoints.deviceAuthorizationEndpoint) {
    throw new Error('Subscription integration does not have a release-approved device authorization endpoint');
  }
  return {
    deviceAuthorizationEndpoint: release.endpoints.deviceAuthorizationEndpoint,
    clientId: release.registration.clientId,
    scopes: normalizeScopes(scopes),
  };
}

export interface SubscriptionTokenRefreshResponse {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt?: string;
  readonly expiresInSeconds?: number;
  readonly tokenType?: string;
}

export interface SubscriptionTokenRefreshTransport {
  /** Called only in the trusted main process with the refresh token. */
  postForm(request: {
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: Readonly<Record<string, string>>;
  }): Promise<SubscriptionTokenRefreshResponse>;
}

export interface HttpSubscriptionTokenRefreshTransportOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

/** Trusted main-process OAuth refresh transport with bounded, redacted errors. */
export function createHttpSubscriptionTokenRefreshTransport(
  options: HttpSubscriptionTokenRefreshTransportOptions = {},
): SubscriptionTokenRefreshTransport {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;
  return {
    postForm: async ({ url, headers, body }) => {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: new URLSearchParams(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        throw new Error(`Subscription token refresh failed with HTTP ${response.status}`);
      }
      const payload: unknown = await response.json();
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('Subscription token refresh returned an invalid response');
      }
      const value = payload as Record<string, unknown>;
      const accessToken = value['access_token'] ?? value['accessToken'];
      const refreshToken = value['refresh_token'] ?? value['refreshToken'];
      const expiresAt = value['expires_at'] ?? value['expiresAt'];
      const expiresInSeconds = value['expires_in'] ?? value['expiresInSeconds'];
      const tokenType = value['token_type'] ?? value['tokenType'];
      return {
        accessToken: typeof accessToken === 'string' ? accessToken : '',
        ...(typeof refreshToken === 'string' ? { refreshToken } : {}),
        ...(typeof expiresAt === 'string' ? { expiresAt } : {}),
        ...(typeof expiresInSeconds === 'number' ? { expiresInSeconds } : {}),
        ...(typeof tokenType === 'string' ? { tokenType } : {}),
      };
    },
  };
}

export interface RefreshSubscriptionOAuthTokensInput {
  readonly release: SubscriptionReleaseConfiguration;
  readonly tokens: OAuthTokens;
  readonly postForm: SubscriptionTokenRefreshTransport['postForm'];
  readonly now?: () => Date;
}

function resolveExpiresAt(
  response: SubscriptionTokenRefreshResponse,
  now: () => Date,
): string {
  const explicit = nonEmpty(response.expiresAt);
  if (explicit && !Number.isNaN(Date.parse(explicit))) return explicit;
  if (Number.isFinite(response.expiresInSeconds) && (response.expiresInSeconds ?? 0) > 0) {
    return new Date(now().getTime() + (response.expiresInSeconds! * 1000)).toISOString();
  }
  throw new Error('Subscription token refresh response did not include a valid expiry');
}

/**
 * Normalize a refresh response for CredentialRefreshCoordinator. The access
 * and refresh tokens stay inside this main-process call chain; no result type
 * here is renderer-facing or persisted as request metadata.
 */
export async function refreshSubscriptionOAuthTokens(
  input: RefreshSubscriptionOAuthTokensInput,
): Promise<OAuthTokens> {
  const release = assertSubscriptionReleaseEnabled(input.release);
  const response = await input.postForm({
    url: release.endpoints.tokenEndpoint,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: {
      grant_type: 'refresh_token',
      client_id: release.registration.clientId,
      refresh_token: input.tokens.refreshToken,
    },
  });
  const accessToken = nonEmpty(response.accessToken);
  if (!accessToken) throw new Error('Subscription token refresh response did not include an access token');
  const refreshToken = nonEmpty(response.refreshToken) ?? input.tokens.refreshToken;
  const tokenType = nonEmpty(response.tokenType) ?? input.tokens.tokenType;
  return {
    accessToken,
    refreshToken,
    expiresAt: resolveExpiresAt(response, input.now ?? (() => new Date())),
    tokenType,
  };
}

export function createSubscriptionRequestHeaders(
  driverId: string,
  configuration: SubscriptionReleaseConfiguration,
  additionalHeaders: Readonly<Record<string, string>> = {},
): Readonly<Record<string, string>> {
  const release = assertSubscriptionReleaseEnabled(configuration);
  for (const [name, value] of Object.entries(additionalHeaders)) {
    if (!isSafeRequestHeader(name, value)) {
      throw new SubscriptionReleaseDisabledError('invalid-request-header');
    }
  }
  return {
    'X-Orchid-Subscription-Driver': driverId,
    'X-Orchid-Subscription-Integration': release.integrationVersion,
    ...release.requestHeaders,
    ...additionalHeaders,
  };
}

export interface SubscriptionQuotaUsage {
  readonly used?: number;
  readonly limit?: number;
  readonly resetAt?: string;
}

export interface UnknownSubscriptionCost {
  readonly state: 'unknown';
  readonly source: 'subscription-quota';
  readonly reason: 'no-authoritative-monetary-charge';
  readonly quota?: SubscriptionQuotaUsage;
}

/** Subscription quota is usage evidence, never a claim that money cost zero. */
export function createUnknownSubscriptionCost(
  quota?: SubscriptionQuotaUsage,
): UnknownSubscriptionCost {
  return {
    state: 'unknown',
    source: 'subscription-quota',
    reason: 'no-authoritative-monetary-charge',
    ...(quota ? { quota: { ...quota } } : {}),
  };
}
