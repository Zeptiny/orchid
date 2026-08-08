import type { LanguageModelV4 } from '@ai-sdk/provider';
import { importESM } from '../../utils/esm-import';
import type {
  DiscoveredProviderModel,
  EffectiveModel,
  ProviderModelDefinition,
  ProviderProtocol,
} from '../../../shared/types/provider';
import type { ThinkingPolicy } from '../../../shared/types/provider-facets';
import {
  ANTHROPIC_THINKING_POLICY,
  OPENAI_OPAQUE_THINKING_POLICY,
  OPENAI_RESPONSES_THINKING_POLICY,
} from '../facets/thinking';
import { fetchModelsEndpoint, modelsListEntries } from './models-endpoint';
import type {
  DriverCredential,
  DriverDiscoveryFacet,
  ProviderDriver,
  ReasoningProviderOptions,
} from './types';

export const BUILTIN_PROVIDER_ORIGINS = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  'google-gemini': 'https://generativelanguage.googleapis.com/v1beta',
  xai: 'https://api.x.ai/v1',
} as const;

export const OPENAI_MODELS_URL = `${BUILTIN_PROVIDER_ORIGINS.openai}/models`;

export interface NativeLanguageModelInput {
  readonly providerId: keyof typeof BUILTIN_PROVIDER_ORIGINS;
  readonly protocol: ProviderProtocol;
  readonly modelId: string;
  readonly apiKey: string;
}

/** Instantiate a direct provider through its native AI SDK adapter. */
export async function createNativeLanguageModel(
  input: NativeLanguageModelInput,
): Promise<LanguageModelV4> {
  switch (input.providerId) {
    case 'openai': {
      if (input.protocol !== 'openai-compatible' && input.protocol !== 'openai-responses') {
        throw new Error('OpenAI requires openai-compatible or openai-responses protocol');
      }
      const { createOpenAI } = await importESM<typeof import('@ai-sdk/openai')>('@ai-sdk/openai');
      const provider = createOpenAI({
        apiKey: input.apiKey,
        baseURL: BUILTIN_PROVIDER_ORIGINS.openai,
      });
      return input.protocol === 'openai-responses'
        ? provider.responses(input.modelId)
        : provider.chat(input.modelId);
    }
    case 'anthropic': {
      if (input.protocol !== 'anthropic-messages') throw new Error('Anthropic requires anthropic-messages protocol');
      const { createAnthropic } = await importESM<typeof import('@ai-sdk/anthropic')>('@ai-sdk/anthropic');
      return createAnthropic({
        apiKey: input.apiKey,
        baseURL: BUILTIN_PROVIDER_ORIGINS.anthropic,
      }).messages(input.modelId);
    }
    case 'google-gemini': {
      if (input.protocol !== 'google-generative-ai') throw new Error('Google Gemini requires google-generative-ai protocol');
      const { createGoogle } = await importESM<typeof import('@ai-sdk/google')>('@ai-sdk/google');
      return createGoogle({
        apiKey: input.apiKey,
        baseURL: BUILTIN_PROVIDER_ORIGINS['google-gemini'],
      }).languageModel(input.modelId);
    }
    case 'xai': {
      if (input.protocol !== 'xai') throw new Error('xAI requires xai protocol');
      const { createXai } = await importESM<typeof import('@ai-sdk/xai')>('@ai-sdk/xai');
      return createXai({
        apiKey: input.apiKey,
        baseURL: BUILTIN_PROVIDER_ORIGINS.xai,
      }).chat(input.modelId);
    }
  }
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
 * OpenAI's models list carries ids only, so a discovered entry contributes
 * nothing beyond the id — plus the Responses routing when the frozen catalog
 * marks that id openai-responses, the same per-model protocol that selects
 * the request adapter (R27, R31).
 */
export function parseOpenAIModels(
  payload: unknown,
  catalogModels: readonly ProviderModelDefinition[] = [],
): DiscoveredProviderModel[] {
  const protocolById = new Map<string, ProviderProtocol>();
  for (const model of catalogModels) protocolById.set(model.id, model.protocol);
  return modelsListEntries(payload, 'OpenAI').map((entry) => {
    const id = entry['id'] as string;
    return {
      id,
      ...(protocolById.get(id) === 'openai-responses' ? { protocol: 'openai-responses' as const } : {}),
    };
  });
}

export async function fetchOpenAIModels(options: {
  readonly apiKey: string;
  readonly catalogModels?: readonly ProviderModelDefinition[];
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}): Promise<readonly DiscoveredProviderModel[]> {
  const payload = await fetchModelsEndpoint(OPENAI_MODELS_URL, options.apiKey, 'OpenAI', {
    fetch: options.fetch,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
  return parseOpenAIModels(payload, options.catalogModels);
}

/** Built-in code-owned drivers that U4 can execute. */
export function createNativeProviderDrivers(options: {
  readonly fetch?: typeof globalThis.fetch;
} = {}): readonly ProviderDriver[] {
  return (Object.keys(BUILTIN_PROVIDER_ORIGINS) as Array<keyof typeof BUILTIN_PROVIDER_ORIGINS>).map((id) => {
    const protocol: ProviderProtocol = id === 'anthropic'
      ? 'anthropic-messages'
      : id === 'google-gemini'
        ? 'google-generative-ai'
        : id === 'xai'
          ? 'xai'
          : 'openai-compatible';
    const thinkingPolicyFor = (model: EffectiveModel): ThinkingPolicy | undefined => {
      if (id === 'anthropic') return ANTHROPIC_THINKING_POLICY;
      if (id === 'openai') {
        return model.protocol === 'openai-responses'
          ? OPENAI_RESPONSES_THINKING_POLICY
          : OPENAI_OPAQUE_THINKING_POLICY;
      }
      return undefined;
    };
    const discoveryFacet: DriverDiscoveryFacet | undefined = id === 'openai'
      ? {
        fetchModels: ({ provider, credential }) => fetchOpenAIModels({
          apiKey: apiKeyForDriver(credential),
          catalogModels: provider.models,
          fetch: options.fetch,
        }),
      }
      : undefined;
    const driver: ProviderDriver = {
      id,
      supportedAuthMethods: ['api-key', 'environment'],
      supportedProtocols: id === 'openai' ? ['openai-compatible', 'openai-responses'] : [protocol],
      allowsCustomEndpoint: false,
      origin: BUILTIN_PROVIDER_ORIGINS[id],
      createLanguageModel: async ({ model, credential }) => createNativeLanguageModel({
        providerId: id,
        protocol: model.protocol,
        modelId: model.id,
        apiKey: apiKeyForDriver(credential),
      }),
      ...(id === 'openai' || id === 'anthropic' ? { thinkingPolicy: thinkingPolicyFor } : {}),
      ...(discoveryFacet ? { discoveryFacet } : {}),
    };
    // OpenAI embeddings use the same code-owned OpenAI origin, but only the
    // typed provider runtime may surface this main-process target to RAG.
    if (id === 'openai') {
      driver.createEmbeddingTarget = async ({ model, credential }) => {
        if (model.protocol !== 'openai-compatible') {
          throw new Error('OpenAI embeddings require openai-compatible protocol');
        }
        return {
          baseURL: BUILTIN_PROVIDER_ORIGINS.openai,
          apiKey: apiKeyForEmbedding(credential),
        };
      };
    }
    switch (id) {
      case 'openai':
        // Both the Chat Completions and Responses schemas accept
        // reasoningEffort; neither accepts a numeric reasoning budget.
        driver.buildReasoningOptions = (effort: string | number, _model: EffectiveModel): ReasoningProviderOptions | undefined =>
          typeof effort === 'string'
            ? { openai: { reasoningEffort: effort } }
            : undefined;
        break;
      case 'anthropic':
        driver.buildReasoningOptions = (effort: string | number, _model: EffectiveModel): ReasoningProviderOptions | undefined =>
          typeof effort === 'number'
            ? { anthropic: { thinking: { type: 'enabled', budgetTokens: effort } } }
            : { anthropic: { effort } };
        break;
      case 'google-gemini':
        driver.buildReasoningOptions = (effort: string | number, _model: EffectiveModel): ReasoningProviderOptions | undefined =>
          typeof effort === 'number'
            ? { google: { thinkingConfig: { thinkingBudget: effort } } }
            : { google: { thinkingConfig: { thinkingLevel: effort } } };
        break;
    }
    return driver;
  });
}
