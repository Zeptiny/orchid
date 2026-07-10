/**
 * Provider factory — creates AI SDK model instances from resolved references.
 *
 * Maps ResolvedModelRef (from providers.ts) to actual AI SDK provider/model objects.
 */
import type { LanguageModelV4 } from '@ai-sdk/provider';
import type { ResolvedModelRef } from './providers';
import { importESM } from '../utils/esm-import';
import { createUnwrappingFetch } from './response-unwrap';

/**
 * Create an AI SDK LanguageModel from a resolved model reference.
 *
 * Uses dynamic import() because @ai-sdk/openai and @ai-sdk/openai-compatible
 * v4+ are ESM-only, but Electron main compiles to CommonJS.
 *
 * OpenAI-compatible providers use a custom fetch that unwraps gateway envelopes
 * like `{ data: { choices: [...] }, success: true }` (e.g. Cline Pass) so
 * generateText/doGenerate (auto-naming) can parse the response.
 *
 * @param ref - Resolved model reference from resolveModelRef()
 * @returns LanguageModelV4 instance for use with streamText/generateText
 */
export async function createProviderModel(ref: ResolvedModelRef): Promise<LanguageModelV4> {
  if (ref.useCompatible || ref.providerName === 'openai-compatible') {
    const { createOpenAICompatible } = await importESM<typeof import('@ai-sdk/openai-compatible')>('@ai-sdk/openai-compatible');
    const provider = createOpenAICompatible({
      name: ref.providerName,
      baseURL: ref.baseUrl ?? 'https://api.openai.com/v1',
      apiKey: ref.apiKey ?? '',
      fetch: createUnwrappingFetch(),
    });
    return provider(ref.modelId);
  }

  // Direct OpenAI provider (default)
  const { createOpenAI } = await importESM<typeof import('@ai-sdk/openai')>('@ai-sdk/openai');
  const provider = createOpenAI({
    apiKey: ref.apiKey ?? '',
    ...(ref.baseUrl && { baseURL: ref.baseUrl }),
  });
  return provider.chat(ref.modelId);
}
