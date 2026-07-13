import { describe, expect, it } from 'vitest';
import type { ProviderModelOption } from '../../src/shared/types/ipc';
import {
  providerModelOptionKey,
  providerModelOptionLabel,
  selectionMatchesOption,
} from '../../src/renderer/utils/provider-selection';
import { isEmbeddingModel, isTextGenerationModel } from '../../src/renderer/utils/models';

function option(connectionId: string, modelId: string): ProviderModelOption {
  return {
    selection: { connectionId, modelId },
    connectionName: connectionId.endsWith('1') ? 'Personal' : 'Work',
    providerId: 'openai',
    providerDisplayName: 'OpenAI',
    model: {
      id: modelId,
      displayName: 'Model display',
      protocol: 'openai-compatible',
      lifecycle: 'active',
      source: 'catalog',
      capabilities: null,
      limits: null,
    },
    available: true,
    unavailableReason: null,
  };
}

describe('provider selection view model', () => {
  it('keeps model IDs with slashes opaque while differentiating connections', () => {
    const personal = option('00000000-0000-4000-8000-000000000001', 'org/model/with/slashes');
    const work = option('00000000-0000-4000-8000-000000000002', 'org/model/with/slashes');

    expect(providerModelOptionKey(personal)).not.toBe(providerModelOptionKey(work));
    expect(providerModelOptionKey(personal)).toContain('org/model/with/slashes');
    expect(selectionMatchesOption(personal.selection, personal)).toBe(true);
    expect(selectionMatchesOption(personal.selection, work)).toBe(false);
  });

  it('labels a model with provider and connection identity', () => {
    const model = option('00000000-0000-4000-8000-000000000002', 'gpt-5');
    expect(providerModelOptionLabel(model)).toBe('OpenAI · Work · Model display');
  });

  it('separates chat and embedding model roles by output capability', () => {
    const text = {
      ...option('connection', 'chat').model,
      capabilities: { inputModalities: ['text'], outputModalities: ['text'], tools: true, reasoning: true },
    };
    const embedding = {
      ...option('connection', 'embedding').model,
      capabilities: { inputModalities: ['text'], outputModalities: ['embedding'], tools: false, reasoning: false },
    };
    expect(isTextGenerationModel(text)).toBe(true);
    expect(isEmbeddingModel(text)).toBe(false);
    expect(isTextGenerationModel(embedding)).toBe(false);
    expect(isEmbeddingModel(embedding)).toBe(true);
  });
});
