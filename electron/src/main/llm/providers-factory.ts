/**
 * Provider factory — creates AI SDK model instances from resolved references.
 *
 * Maps ResolvedModelRef (from providers.ts) to actual AI SDK provider/model objects.
 */
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModelV1 } from 'ai';
import type { ResolvedModelRef } from './providers';

/**
 * Create an AI SDK LanguageModelV1 from a resolved model reference.
 *
 * @param ref - Resolved model reference from resolveModelRef()
 * @returns LanguageModelV1 instance for use with streamText/generateText
 */
export function createProviderModel(ref: ResolvedModelRef): LanguageModelV1 {
  if (ref.useCompatible || ref.providerName === 'openai-compatible') {
    const provider = createOpenAICompatible({
      name: ref.providerName,
      baseURL: ref.baseUrl ?? 'https://api.openai.com/v1',
      apiKey: ref.apiKey ?? '',
    });
    return provider(ref.modelId) as unknown as LanguageModelV1;
  }

  // Direct OpenAI provider (default)
  const provider = createOpenAI({
    apiKey: ref.apiKey ?? '',
    ...(ref.baseUrl && { baseURL: ref.baseUrl }),
  });
  return provider.chat(ref.modelId);
}
