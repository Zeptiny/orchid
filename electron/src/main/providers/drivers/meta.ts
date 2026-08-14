/**
 * Meta (dev.meta.ai) first-party driver — the Responses API.
 *
 * Muse Spark reasons internally; the only cross-turn carriers are streamed
 * summaries and opt-in encrypted reasoning items, so this driver always
 * requests `include: ["reasoning.encrypted_content"]` with `store: false`
 * (stateless replay, no server-side conversation state). Reasoning effort is
 * validated against the documented vocabulary (`minimal`..`xhigh`): `"none"`
 * and `"max"` are rejected by the API, so they are never emitted.
 *
 * Model metadata and pricing come from the signed catalog; the driver owns
 * only the origin, protocol, and request-option behavior.
 */
import type { LanguageModelV4 } from '@ai-sdk/provider';
import { importESM } from '../../utils/esm-import';
import type { EffectiveModel } from '../../../shared/types/provider';
import type { CacheFacet, ThinkingPolicy } from '../../../shared/types/provider-facets';
import { META_THINKING_POLICY } from '../facets/thinking';
export { META_THINKING_POLICY } from '../facets/thinking';
import type {
  DriverCredential,
  ProviderDriver,
  ReasoningProviderOptions,
} from './types';

/** Code-owned Meta API origin; catalog data never controls this base URL. */
export const META_API_ORIGIN = 'https://api.meta.ai/v1';

/**
 * Documented `reasoning.effort` vocabulary (models.dev `reasoning_options`).
 * Muse Spark rejects `"none"` (disable reasoning) and the Responses API has
 * no `"max"` level, so only these values are ever emitted.
 */
export const META_REASONING_EFFORT_LEVELS = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
] as const;

/** Meta caching is fully automatic; the retention hint is the only knob. */
export const META_CACHE_FACET: CacheFacet = {
  mode: 'automatic',
  sessionKey: false,
  retentionHint: true,
  ttlOptions: [
    { id: 'in_memory', displayName: 'In-memory' },
    { id: '24h', displayName: '24 hours' },
  ],
};

function apiKeyForDriver(credential: DriverCredential): string {
  if (credential.kind === 'api-key') return credential.apiKey ?? '';
  return '';
}

/** Construct Meta's Responses-protocol model through the OpenAI adapter. */
export async function createMetaLanguageModel(input: {
  readonly modelId: string;
  readonly apiKey: string;
}): Promise<LanguageModelV4> {
  const { createOpenAI } = await importESM<typeof import('@ai-sdk/openai')>('@ai-sdk/openai');
  return createOpenAI({
    name: 'meta',
    baseURL: META_API_ORIGIN,
    apiKey: input.apiKey,
  }).responses(input.modelId);
}

export function createMetaProviderDriver(): ProviderDriver {
  return {
    id: 'meta',
    supportedAuthMethods: ['api-key', 'environment'],
    supportedProtocols: ['openai-responses'],
    allowsCustomEndpoint: false,
    origin: META_API_ORIGIN,
    createLanguageModel: async ({ model, credential }) => createMetaLanguageModel({
      modelId: model.id,
      apiKey: apiKeyForDriver(credential),
    }),
    thinkingPolicy: (_model: EffectiveModel): ThinkingPolicy => META_THINKING_POLICY,
    buildReasoningOptions: (effort: string | number): ReasoningProviderOptions | undefined => {
      if (typeof effort !== 'string') return undefined;
      return (META_REASONING_EFFORT_LEVELS as readonly string[]).includes(effort)
        ? { openai: { reasoningEffort: effort } }
        : undefined;
    },
    cacheFacet: META_CACHE_FACET,
  };
}
