import { describe, expect, it } from 'vitest';
import type { ProviderModelOption, ProviderStatusView } from '../../src/shared/types/ipc';
import {
  providerModelOptionContextLabel,
  providerModelOptionDisplayName,
  providerModelOptionKey,
  providerModelOptionLabel,
  providerModelOptionNotifyLabel,
  providerStatusForConnection,
  providerStatusIsConnectionScoped,
  providerStatusConnectionId,
  resolveModelNotifyLabel,
  selectionMatchesOption,
} from '../../src/renderer/utils/provider-selection';
import type { ProviderConnectionView } from '../../src/shared/types/ipc';
import {
  connectionModelCapabilities,
  isEmbeddingModel,
  isTextGenerationModel,
} from '../../src/renderer/utils/models';

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
    enabled: true,
    customized: false,
    discoveredAt: null,
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
    expect(providerModelOptionDisplayName(model)).toBe('Model display');
    expect(providerModelOptionContextLabel(model)).toBe('OpenAI · Work');
    expect(providerModelOptionLabel(model)).toBe('OpenAI · Work · Model display');
    expect(providerModelOptionNotifyLabel(model)).toBe('OpenAI · Model display');
  });

  it('resolves notify labels without opaque connection ids', () => {
    const connectionId = 'cad8fcc6-8d34-408e-95a9-820b35020f47';
    const modelId = 'deepseek-v4-flash';
    const model = {
      ...option(connectionId, modelId),
      connectionName: 'DeepSeek',
      providerId: 'deepseek',
      providerDisplayName: 'DeepSeek',
      model: {
        ...option(connectionId, modelId).model,
        id: modelId,
        displayName: 'DeepSeek V4 Flash',
      },
    };
    const key = providerModelOptionKey(model);

    expect(key).toContain(connectionId);
    expect(resolveModelNotifyLabel(key, { [key]: model })).toBe('DeepSeek · DeepSeek V4 Flash');
    expect(resolveModelNotifyLabel(key, undefined, { [key]: 'Fallback Label' })).toBe('Fallback Label');
    expect(resolveModelNotifyLabel(key)).toBe(key);
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

  it('defaults editable model capabilities to text I/O with tools and reasoning', () => {
    expect(connectionModelCapabilities()).toEqual({
      inputModalities: ['text'],
      outputModalities: ['text'],
      tools: true,
      reasoning: true,
    });
    expect(connectionModelCapabilities(
      ['text', 'image'],
      ['text'],
      false,
      false,
    )).toEqual({
      inputModalities: ['text', 'image'],
      outputModalities: ['text'],
      tools: false,
      reasoning: false,
    });
    expect(connectionModelCapabilities(
      ['text'],
      ['embedding'],
      true,
      true,
    )).toEqual({
      inputModalities: ['text'],
      outputModalities: ['embedding'],
      tools: true,
      reasoning: true,
    });
  });

  it('hosts provider status on one matching connection and prefers a ready connection', () => {
    const connection = (
      id: string,
      providerId: string,
      health: ProviderConnectionView['health'],
    ): ProviderConnectionView => ({
      id,
      providerId,
      providerDisplayName: providerId,
      name: id,
      protocol: 'openai-compatible',
      authMethod: 'api-key',
      credentialKind: 'stored',
      environmentVariable: null,
      modelIds: [],
      customModels: [],
      health,
      activeTurnCount: 0,
      endpoint: null,
      allowInsecureHttp: false,
    });
    const connections = [
      connection('lilac-disabled', 'lilac', 'disabled'),
      connection('neuralwatt-ready', 'neuralwatt', 'ready'),
      connection('lilac-ready', 'lilac', 'ready'),
      connection('lilac-second-ready', 'lilac', 'ready'),
    ];

    expect(providerStatusConnectionId(connections, 'lilac')).toBe('lilac-ready');
    expect(providerStatusConnectionId(connections, 'neuralwatt')).toBe('neuralwatt-ready');
    expect(providerStatusConnectionId(connections, 'openai')).toBeNull();
  });

  it('attaches Neuralwatt quota observations to their exact account connection', () => {
    const connection = (id: string): ProviderConnectionView => ({
      id,
      providerId: 'neuralwatt',
      providerDisplayName: 'Neuralwatt',
      name: id,
      protocol: 'openai-compatible',
      authMethod: 'api-key',
      credentialKind: 'stored',
      environmentVariable: null,
      modelIds: [],
      customModels: [],
      health: 'ready',
      activeTurnCount: 0,
      endpoint: null,
      allowInsecureHttp: false,
    });
    const personal = connection('personal');
    const work = connection('work');
    const statuses: readonly ProviderStatusView[] = [
      {
        providerId: 'neuralwatt',
        connectionId: 'personal',
        observedAt: '2026-07-12T12:00:00.000Z',
        providerUpdatedAt: null,
        availability: 'available',
        stale: false,
        data: { creditsRemainingUsd: 12 },
        error: null,
      },
      {
        providerId: 'neuralwatt',
        connectionId: 'work',
        observedAt: '2026-07-12T12:00:00.000Z',
        providerUpdatedAt: null,
        availability: 'available',
        stale: false,
        data: { creditsRemainingUsd: 98 },
        error: null,
      },
    ];

    expect(providerStatusIsConnectionScoped('neuralwatt')).toBe(true);
    expect(providerStatusForConnection([personal, work], personal, statuses)?.data)
      .toEqual({ creditsRemainingUsd: 12 });
    expect(providerStatusForConnection([personal, work], work, statuses)?.data)
      .toEqual({ creditsRemainingUsd: 98 });
  });
});
