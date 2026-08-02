import type { LanguageModelV4 } from '@ai-sdk/provider';
import { importESM } from '../../utils/esm-import';
import { createUnwrappingFetch } from '../../llm/response-unwrap';
import type { EffectiveModel, ProviderProtocol } from '../../../shared/types/provider';
import type { DriverCredential, ProviderDriver } from './types';

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
    if (input.protocol !== 'openai-compatible') throw new Error('Generic OpenAI-compatible provider requires openai-compatible protocol');
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

export function createCompatibleProviderDrivers(): readonly ProviderDriver[] {
  return [
    {
      id: 'generic-openai-compatible',
      supportedAuthMethods: ['api-key', 'environment', 'none'],
      supportedProtocols: ['openai-compatible'],
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
      buildReasoningOptions: (effort: string | number, _model: EffectiveModel) =>
        typeof effort === 'string'
          ? { openaiCompatible: { reasoningEffort: effort } }
          : undefined,
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
    },
  ];
}
