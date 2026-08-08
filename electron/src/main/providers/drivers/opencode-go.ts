import type { LanguageModelV4 } from '@ai-sdk/provider';
import type { EffectiveModel, ProviderProtocol } from '../../../shared/types/provider';
import type { ThinkingPolicy } from '../../../shared/types/provider-facets';
import {
  ANTHROPIC_THINKING_POLICY,
  OPENAI_RESPONSES_THINKING_POLICY,
} from '../facets/thinking';
import { createUnwrappingFetch } from '../../llm/response-unwrap';
import { importESM } from '../../utils/esm-import';
import type { ProviderDriver } from './types';

/** Code-owned OpenCode Go API base; catalog data never controls this origin. */
export const OPENCODE_GO_API_ORIGIN = 'https://opencode.ai/zen/go/v1';

export interface OpenCodeGoLanguageModelInput {
  readonly protocol: Extract<ProviderProtocol, 'openai-compatible' | 'openai-responses' | 'anthropic-messages'>;
  readonly modelId: string;
  readonly apiKey: string;
}

/**
 * OpenCode Go publishes a protocol per model. The frozen catalog model
 * protocol—not a name substring—selects the compatible adapter.
 */
export async function createOpenCodeGoLanguageModel(
  input: OpenCodeGoLanguageModelInput,
): Promise<LanguageModelV4> {
  if (input.protocol === 'openai-compatible') {
    const { createOpenAICompatible } = await importESM<typeof import('@ai-sdk/openai-compatible')>('@ai-sdk/openai-compatible');
    return createOpenAICompatible({
      name: 'opencode-go',
      baseURL: OPENCODE_GO_API_ORIGIN,
      apiKey: input.apiKey,
      fetch: createUnwrappingFetch(),
    })(input.modelId);
  }

  if (input.protocol === 'openai-responses') {
    const { createOpenAI } = await importESM<typeof import('@ai-sdk/openai')>('@ai-sdk/openai');
    return createOpenAI({
      name: 'opencode-go',
      baseURL: OPENCODE_GO_API_ORIGIN,
      apiKey: input.apiKey,
      fetch: createUnwrappingFetch(),
    }).responses(input.modelId);
  }

  const { createAnthropic } = await importESM<typeof import('@ai-sdk/anthropic')>('@ai-sdk/anthropic');
  return createAnthropic({
    name: 'opencode-go',
    baseURL: OPENCODE_GO_API_ORIGIN,
    apiKey: input.apiKey,
  }).messages(input.modelId);
}

function apiKeyForDriver(credential: { kind: string; apiKey?: string }): string {
  if (credential.kind === 'api-key') return credential.apiKey ?? '';
  return '';
}

export function createOpenCodeGoProviderDriver(): ProviderDriver {
  return {
    id: 'opencode-go',
    supportedAuthMethods: ['api-key', 'environment'],
    supportedProtocols: ['openai-compatible', 'openai-responses', 'anthropic-messages'],
    allowsCustomEndpoint: false,
    origin: OPENCODE_GO_API_ORIGIN,
    createLanguageModel: async ({ model, credential }) => {
      if (model.protocol !== 'openai-compatible'
        && model.protocol !== 'openai-responses'
        && model.protocol !== 'anthropic-messages') {
        throw new Error(`OpenCode Go does not support protocol '${model.protocol}'`);
      }
      return createOpenCodeGoLanguageModel({
        protocol: model.protocol,
        modelId: model.id,
        apiKey: apiKeyForDriver(credential),
      });
    },
    // Policy follows the frozen per-model protocol: Anthropic-routed models
    // need signed replay, Responses-routed models replay encrypted items, and
    // chat-completions models keep the default plain-text policy.
    thinkingPolicy: (model: EffectiveModel): ThinkingPolicy | undefined => {
      if (model.protocol === 'anthropic-messages') return ANTHROPIC_THINKING_POLICY;
      if (model.protocol === 'openai-responses') return OPENAI_RESPONSES_THINKING_POLICY;
      return undefined;
    },
  };
}
