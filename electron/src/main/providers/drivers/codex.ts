import type { LanguageModelV4 } from '@ai-sdk/provider';
import { importESM } from '../../utils/esm-import';
import type { ProviderConnection } from '../../../shared/types/provider';
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

export const CODEX_SUBSCRIPTION_DRIVER_ID = 'chatgpt-codex';
export const CODEX_SUBSCRIPTION_PROTOCOL = 'openai-compatible';
export const CODEX_SUBSCRIPTION_MODEL_ALLOWLIST = ['gpt-5.2-codex'] as const;
export const CODEX_SUBSCRIPTION_OAUTH_SCOPES = ['openid', 'offline_access'] as const;

export interface CodexSubscriptionReleaseConfiguration extends SubscriptionReleaseConfiguration {
  /**
   * A release-approved account header name. The account value is supplied only
   * by a trusted main-process credential/account resolver, never a connection.
   */
  readonly accountHeaderName?: string;
}

export interface CodexSubscriptionDriverOptions {
  readonly release: CodexSubscriptionReleaseConfiguration;
  readonly accountIdForConnection?: (connection: ProviderConnection) => string | null | undefined;
}

function assertCodexRequest(request: DriverModelRequest): asserts request is DriverModelRequest & {
  readonly credential: { readonly kind: 'oauth'; readonly accessToken: string };
} {
  if (request.connection.providerId !== CODEX_SUBSCRIPTION_DRIVER_ID
    || request.provider.id !== CODEX_SUBSCRIPTION_DRIVER_ID) {
    throw new Error('Codex subscription driver received a request for another provider');
  }
  if (request.connection.protocol !== CODEX_SUBSCRIPTION_PROTOCOL
    || request.model.protocol !== CODEX_SUBSCRIPTION_PROTOCOL) {
    throw new Error('Codex subscription requires openai-compatible protocol');
  }
  if (request.connection.authMethod !== 'oauth' || request.credential.kind !== 'oauth') {
    throw new Error('Codex subscription requires OAuth credentials');
  }
  if (request.connection.endpoint) {
    throw new Error('Codex subscription uses its release-owned API origin and cannot be redirected');
  }
  if (!(CODEX_SUBSCRIPTION_MODEL_ALLOWLIST as readonly string[]).includes(request.model.id)) {
    throw new Error(`Codex subscription model '${request.model.id}' is not allowed by this integration version`);
  }
}

function accountHeaders(
  release: CodexSubscriptionReleaseConfiguration,
  accountId: string | null | undefined,
): Readonly<Record<string, string>> {
  const normalizedAccountId = accountId?.trim();
  if (!normalizedAccountId) return {};
  const headerName = release.accountHeaderName?.trim();
  if (!headerName) {
    throw new Error('Codex subscription account metadata requires a release-approved account header name');
  }
  return { [headerName]: normalizedAccountId };
}

/** Instantiate the isolated ChatGPT/Codex subscription adapter. */
export function createCodexSubscriptionDriver(options: CodexSubscriptionDriverOptions): ProviderDriver {
  const releaseStatus = evaluateSubscriptionReleaseEnablement(options.release);
  return {
    id: CODEX_SUBSCRIPTION_DRIVER_ID,
    supportedAuthMethods: ['oauth'],
    supportedProtocols: [CODEX_SUBSCRIPTION_PROTOCOL],
    allowsCustomEndpoint: false,
    origin: releaseStatus.enabled ? releaseStatus.endpoints.requestBaseUrl : null,
    createLanguageModel: async (request): Promise<LanguageModelV4> => {
      const release = assertSubscriptionReleaseEnabled(options.release);
      assertCodexRequest(request);
      const { createOpenAICompatible } = await importESM<typeof import('@ai-sdk/openai-compatible')>('@ai-sdk/openai-compatible');
      return createOpenAICompatible({
        name: 'orchid-chatgpt-codex-subscription',
        baseURL: release.endpoints.requestBaseUrl,
        apiKey: request.credential.accessToken,
        headers: createSubscriptionRequestHeaders(
          CODEX_SUBSCRIPTION_DRIVER_ID,
          options.release,
          accountHeaders(options.release, options.accountIdForConnection?.(request.connection)),
        ),
      })(request.model.id);
    },
  };
}

export function createCodexSubscriptionBrowserOAuthDefinition(
  release: CodexSubscriptionReleaseConfiguration,
): SubscriptionBrowserOAuthDefinition {
  return createSubscriptionBrowserOAuthDefinition(release, CODEX_SUBSCRIPTION_OAUTH_SCOPES);
}

export function createCodexSubscriptionDeviceOAuthDefinition(
  release: CodexSubscriptionReleaseConfiguration,
): SubscriptionDeviceOAuthDefinition {
  return createSubscriptionDeviceOAuthDefinition(release, CODEX_SUBSCRIPTION_OAUTH_SCOPES);
}

export async function refreshCodexSubscriptionTokens(
  input: Omit<RefreshSubscriptionOAuthTokensInput, 'release'> & {
    readonly release: CodexSubscriptionReleaseConfiguration;
    readonly tokens: OAuthTokens;
  },
): Promise<OAuthTokens> {
  return refreshSubscriptionOAuthTokens(input);
}

/** U7 consumes this as explicit unknown cost metadata when no charge exists. */
export function extractCodexSubscriptionCost(input: {
  readonly quota?: SubscriptionQuotaUsage;
}): UnknownSubscriptionCost {
  return createUnknownSubscriptionCost(input.quota);
}
