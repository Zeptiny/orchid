import type { LanguageModelV4 } from '@ai-sdk/provider';
import { importESM } from '../../utils/esm-import';
import type { OAuthTokens } from '../credentials/vault';
import {
  assertSubscriptionReleaseEnabled,
  createSubscriptionBrowserOAuthDefinition,
  createSubscriptionDeviceOAuthDefinition,
  createSubscriptionRequestHeaders,
  createUnknownSubscriptionCost,
  evaluateSubscriptionReleaseEnablement,
  refreshSubscriptionOAuthTokens,
  type RefreshSubscriptionOAuthTokensInput,
  type SubscriptionBrowserOAuthDefinition,
  type SubscriptionDeviceOAuthDefinition,
  type SubscriptionQuotaUsage,
  type SubscriptionReleaseConfiguration,
  type UnknownSubscriptionCost,
} from './subscription';
import type { DriverModelRequest, ProviderDriver } from './types';

export const GROK_SUBSCRIPTION_DRIVER_ID = 'grok-subscription';
export const GROK_SUBSCRIPTION_PROTOCOL = 'xai';
export const GROK_SUBSCRIPTION_MODEL_ALLOWLIST = ['grok-4.3'] as const;
export const GROK_SUBSCRIPTION_OAUTH_SCOPES = ['openid', 'offline_access'] as const;

export interface GrokSubscriptionDriverOptions {
  readonly release: SubscriptionReleaseConfiguration;
}

function assertGrokRequest(request: DriverModelRequest): asserts request is DriverModelRequest & {
  readonly credential: { readonly kind: 'oauth'; readonly accessToken: string };
} {
  if (request.connection.providerId !== GROK_SUBSCRIPTION_DRIVER_ID
    || request.provider.id !== GROK_SUBSCRIPTION_DRIVER_ID) {
    throw new Error('Grok subscription driver received a request for another provider');
  }
  if (request.connection.protocol !== GROK_SUBSCRIPTION_PROTOCOL
    || request.model.protocol !== GROK_SUBSCRIPTION_PROTOCOL) {
    throw new Error('Grok subscription requires xAI protocol');
  }
  if (request.connection.authMethod !== 'oauth' || request.credential.kind !== 'oauth') {
    throw new Error('Grok subscription requires OAuth credentials');
  }
  if (request.connection.endpoint) {
    throw new Error('Grok subscription uses its release-owned API origin and cannot be redirected');
  }
  if (!(GROK_SUBSCRIPTION_MODEL_ALLOWLIST as readonly string[]).includes(request.model.id)) {
    throw new Error(`Grok subscription model '${request.model.id}' is not allowed by this integration version`);
  }
}

/** Instantiate the isolated Grok subscription adapter using the native xAI SDK. */
export function createGrokSubscriptionDriver(options: GrokSubscriptionDriverOptions): ProviderDriver {
  const releaseStatus = evaluateSubscriptionReleaseEnablement(options.release);
  return {
    id: GROK_SUBSCRIPTION_DRIVER_ID,
    supportedAuthMethods: ['oauth'],
    supportedProtocols: [GROK_SUBSCRIPTION_PROTOCOL],
    allowsCustomEndpoint: false,
    origin: releaseStatus.enabled ? releaseStatus.endpoints.requestBaseUrl : null,
    createLanguageModel: async (request): Promise<LanguageModelV4> => {
      const release = assertSubscriptionReleaseEnabled(options.release);
      assertGrokRequest(request);
      const { createXai } = await importESM<typeof import('@ai-sdk/xai')>('@ai-sdk/xai');
      return createXai({
        baseURL: release.endpoints.requestBaseUrl,
        apiKey: request.credential.accessToken,
        headers: createSubscriptionRequestHeaders(GROK_SUBSCRIPTION_DRIVER_ID, options.release),
      }).chat(request.model.id);
    },
  };
}

export function createGrokSubscriptionBrowserOAuthDefinition(
  release: SubscriptionReleaseConfiguration,
): SubscriptionBrowserOAuthDefinition {
  return createSubscriptionBrowserOAuthDefinition(release, GROK_SUBSCRIPTION_OAUTH_SCOPES);
}

export function createGrokSubscriptionDeviceOAuthDefinition(
  release: SubscriptionReleaseConfiguration,
): SubscriptionDeviceOAuthDefinition {
  return createSubscriptionDeviceOAuthDefinition(release, GROK_SUBSCRIPTION_OAUTH_SCOPES);
}

export async function refreshGrokSubscriptionTokens(
  input: Omit<RefreshSubscriptionOAuthTokensInput, 'release'> & {
    readonly release: SubscriptionReleaseConfiguration;
    readonly tokens: OAuthTokens;
  },
): Promise<OAuthTokens> {
  return refreshSubscriptionOAuthTokens(input);
}

/** U7 consumes this as explicit unknown cost metadata when no charge exists. */
export function extractGrokSubscriptionCost(input: {
  readonly quota?: SubscriptionQuotaUsage;
}): UnknownSubscriptionCost {
  return createUnknownSubscriptionCost(input.quota);
}
