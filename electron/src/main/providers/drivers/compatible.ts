import type { LanguageModelV4 } from '@ai-sdk/provider';
import { importESM } from '../../utils/esm-import';
import { createUnwrappingFetch } from '../../llm/response-unwrap';
import type {
  DiscoveredProviderModel,
  EffectiveModel,
  ProviderProtocol,
} from '../../../shared/types/provider';
import type { ThinkingPolicy } from '../../../shared/types/provider-facets';
import {
  ANTHROPIC_THINKING_POLICY,
  OPENAI_RESPONSES_THINKING_POLICY,
} from '../facets/thinking';
import { fetchModelsEndpoint, modelsListEntries } from './models-endpoint';
import type { DriverCredential, ProviderDriver, ReasoningProviderOptions } from './types';

export interface GenericEndpoint {
  readonly endpoint: string;
  readonly origin: string;
  readonly insecureNonLoopback: boolean;
}

function isLoopbackHost(hostname: string): boolean {
  // Exact loopback only. Do not treat `127.*` hostnames (e.g. 127.evil.com)
  // or other 127.0.0.0/8 addresses as local — those require explicit confirmation.
  return hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '::1';
}

/** Validate endpoints before a generic credential can be sent to them. */
export function validateGenericEndpoint(
  value: string,
  options: { readonly allowInsecureNonLoopbackHttp?: boolean } = {},
): GenericEndpoint {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error('Generic provider endpoint is invalid', { cause: error });
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Generic provider endpoint must use http or https');
  }
  if (url.username || url.password) {
    throw new Error('Generic provider endpoint must not include credentials');
  }
  if (url.search || url.hash) {
    throw new Error('Generic provider endpoint must not include query parameters or fragments');
  }
  const insecureNonLoopback = url.protocol === 'http:' && !isLoopbackHost(url.hostname);
  if (insecureNonLoopback && !options.allowInsecureNonLoopbackHttp) {
    throw new Error('Non-loopback HTTP endpoints require explicit confirmation');
  }
  return {
    endpoint: url.toString().replace(/\/$/, ''),
    origin: url.origin,
    insecureNonLoopback,
  };
}

export interface CompatibleLanguageModelInput {
  readonly providerId: 'generic-openai-compatible' | 'generic-anthropic-compatible';
  readonly protocol: ProviderProtocol;
  readonly modelId: string;
  readonly apiKey: string;
  readonly endpoint: string;
}

/** Instantiate one of the user-configured, protocol-compatible adapters. */
export async function createCompatibleLanguageModel(
  input: CompatibleLanguageModelInput,
): Promise<LanguageModelV4> {
  const endpoint = validateGenericEndpoint(input.endpoint);
  if (input.providerId === 'generic-openai-compatible') {
    if (input.protocol === 'openai-responses') {
      const { createOpenAI } = await importESM<typeof import('@ai-sdk/openai')>('@ai-sdk/openai');
      return createOpenAI({
        name: input.providerId,
        baseURL: endpoint.endpoint,
        apiKey: input.apiKey,
        fetch: createUnwrappingFetch(),
      }).responses(input.modelId);
    }
    if (input.protocol !== 'openai-compatible') throw new Error('Generic OpenAI-compatible provider requires openai-compatible or openai-responses protocol');
    const { createOpenAICompatible } = await importESM<typeof import('@ai-sdk/openai-compatible')>('@ai-sdk/openai-compatible');
    return createOpenAICompatible({
      name: input.providerId,
      baseURL: endpoint.endpoint,
      apiKey: input.apiKey,
      fetch: createUnwrappingFetch(),
      includeUsage: true,
    })(input.modelId);
  }
  if (input.protocol !== 'anthropic-messages') throw new Error('Generic Anthropic-compatible provider requires anthropic-messages protocol');
  const { createAnthropic } = await importESM<typeof import('@ai-sdk/anthropic')>('@ai-sdk/anthropic');
  return createAnthropic({
    name: input.providerId,
    baseURL: endpoint.endpoint,
    apiKey: input.apiKey,
  }).messages(input.modelId);
}

function apiKeyForDriver(credential: { kind: string; apiKey?: string }): string {
  if (credential.kind === 'api-key') return credential.apiKey ?? '';
  return '';
}

function apiKeyForEmbedding(credential: DriverCredential): string | undefined {
  if (credential.kind === 'api-key') return credential.apiKey;
  return undefined;
}

/**
 * A user-configured OpenAI-compatible endpoint is treated as ids-only:
 * nothing beyond the id is trusted from an unverified shape (R27).
 */
export function parseCompatibleModels(payload: unknown): DiscoveredProviderModel[] {
  return modelsListEntries(payload, 'Generic OpenAI-compatible')
    .map((entry) => ({ id: entry['id'] as string }));
}

export async function fetchCompatibleModels(options: {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly allowInsecureNonLoopbackHttp?: boolean;
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}): Promise<readonly DiscoveredProviderModel[]> {
  const endpoint = validateGenericEndpoint(options.endpoint, {
    allowInsecureNonLoopbackHttp: options.allowInsecureNonLoopbackHttp,
  });
  const payload = await fetchModelsEndpoint(
    `${endpoint.endpoint}/models`,
    options.apiKey,
    'Generic OpenAI-compatible',
    { fetch: options.fetch, signal: options.signal, timeoutMs: options.timeoutMs },
  );
  return parseCompatibleModels(payload);
}

export function createCompatibleProviderDrivers(options: {
  readonly fetch?: typeof globalThis.fetch;
} = {}): readonly ProviderDriver[] {
  return [
    {
      id: 'generic-openai-compatible',
      supportedAuthMethods: ['api-key', 'environment', 'none'],
      supportedProtocols: ['openai-compatible', 'openai-responses'],
      allowsCustomEndpoint: true,
      origin: null,
      createLanguageModel: async ({ model, credential, endpoint }) => {
        if (!endpoint) throw new Error('Generic OpenAI-compatible connection requires an endpoint');
        return createCompatibleLanguageModel({
          providerId: 'generic-openai-compatible',
          protocol: model.protocol,
          modelId: model.id,
          apiKey: apiKeyForDriver(credential),
          endpoint,
        });
      },
      createEmbeddingTarget: async ({ model, credential, endpoint }) => {
        if (model.protocol !== 'openai-compatible' || !endpoint) {
          throw new Error('Generic OpenAI-compatible embeddings require an OpenAI-compatible endpoint');
        }
        return { baseURL: endpoint, apiKey: apiKeyForEmbedding(credential) };
      },
      // The Responses adapter always parses the 'openai' options key, even
      // under a renamed provider; the chat adapter parses 'openaiCompatible'.
      buildReasoningOptions: (effort: string | number, model: EffectiveModel): ReasoningProviderOptions | undefined => {
        if (typeof effort !== 'string') return undefined;
        return model.protocol === 'openai-responses'
          ? { openai: { reasoningEffort: effort } }
          : { openaiCompatible: { reasoningEffort: effort } };
      },
      // The Responses adapter keys reasoning metadata/options to 'openai' even
      // under a renamed provider; chat-completions endpoints stay on the
      // default plain-text policy.
      thinkingPolicy: (model: EffectiveModel): ThinkingPolicy | undefined =>
        model.protocol === 'openai-responses' ? OPENAI_RESPONSES_THINKING_POLICY : undefined,
      discoveryFacet: {
        fetchModels: async ({ connection, credential, endpoint }) => {
          if (!endpoint) throw new Error('Generic OpenAI-compatible connection requires an endpoint');
          return fetchCompatibleModels({
            endpoint,
            apiKey: apiKeyForDriver(credential),
            allowInsecureNonLoopbackHttp: connection.allowInsecureHttp === true,
            fetch: options.fetch,
          });
        },
      },
    },
    {
      id: 'generic-anthropic-compatible',
      supportedAuthMethods: ['api-key', 'environment', 'none'],
      supportedProtocols: ['anthropic-messages'],
      allowsCustomEndpoint: true,
      origin: null,
      createLanguageModel: async ({ model, credential, endpoint }) => {
        if (!endpoint) throw new Error('Generic Anthropic-compatible connection requires an endpoint');
        return createCompatibleLanguageModel({
          providerId: 'generic-anthropic-compatible',
          protocol: model.protocol,
          modelId: model.id,
          apiKey: apiKeyForDriver(credential),
          endpoint,
        });
      },
      thinkingPolicy: (): ThinkingPolicy => ANTHROPIC_THINKING_POLICY,
    },
  ];
}
