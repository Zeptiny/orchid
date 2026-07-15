import { describe, expect, it } from 'vitest';
import {
  modelSelectionSchema,
  copyModelSelection,
  providerConnectionSchema,
  type ProviderConnection,
  type ProviderDefinition,
} from '../../src/shared/types/provider';
import { resolveModelSelection } from '../../src/main/providers/resolver';

const CONNECTION_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_CONNECTION_ID = '22222222-2222-4222-8222-222222222222';

function definition(overrides: Partial<ProviderDefinition> = {}): ProviderDefinition {
  return {
    id: 'openai',
    displayName: 'OpenAI',
    supportedAuthMethods: ['api-key', 'environment'],
    supportedProtocols: ['openai-compatible'],
    models: [{ id: 'vendor/path/model', displayName: 'Slash model', protocol: 'openai-compatible' }],
    allowsCustomModels: false,
    ...overrides,
  };
}

function connection(overrides: Partial<ProviderConnection> = {}): ProviderConnection {
  return {
    id: CONNECTION_ID,
    providerId: 'openai',
    name: 'Work account',
    protocol: 'openai-compatible',
    authMethod: 'api-key',
    credential: { kind: 'stored', handle: 'credential-work-v1' },
    modelIds: ['vendor/path/model'],
    health: 'ready',
    ...overrides,
  };
}

describe('provider domain', () => {
  it('keeps a model id containing slashes intact in a connection-scoped selection', () => {
    const selection = modelSelectionSchema.parse({
      connectionId: CONNECTION_ID,
      modelId: 'vendor/path/model',
    });
    expect(selection).toEqual({
      connectionId: CONNECTION_ID,
      modelId: 'vendor/path/model',
    });
    expect(copyModelSelection(selection)).toEqual(selection);
    expect(copyModelSelection(selection)).not.toBe(selection);
  });

  it('rejects malformed selections and secret-bearing connection records', () => {
    expect(() => modelSelectionSchema.parse({ connectionId: 'not-a-uuid', modelId: 'model' }))
      .toThrow();
    expect(() => providerConnectionSchema.parse({
      ...connection(),
      name: ' ',
    })).toThrow();
    expect(() => providerConnectionSchema.parse({
      ...connection(),
      credential: { kind: 'environment', variable: 'lowercase' },
    })).toThrow();
    expect(() => providerConnectionSchema.parse({
      ...connection(),
      apiKey: 'never-persist-this',
    })).toThrow();
  });

  it('returns provider-required with no usable connection', () => {
    expect(resolveModelSelection(null, [], [definition()])).toEqual({
      kind: 'provider-required',
      reason: 'no-usable-connection',
    });
    expect(resolveModelSelection(
      { connectionId: CONNECTION_ID, modelId: 'vendor/path/model' },
      [connection({ health: 'disabled' })],
      [definition()],
    )).toEqual({
      kind: 'provider-required',
      reason: 'no-usable-connection',
    });
  });

  it('requires an explicit selection instead of auto-selecting a ready connection', () => {
    expect(resolveModelSelection(null, [connection()], [definition()])).toEqual({
      kind: 'selection-required',
      reason: 'no-selection',
    });
  });

  it('resolves only the selected connection and preserves slash model ids', () => {
    const result = resolveModelSelection(
      { connectionId: CONNECTION_ID, modelId: 'vendor/path/model' },
      [
        connection(),
        connection({
          id: OTHER_CONNECTION_ID,
          name: 'Personal account',
          credential: { kind: 'stored', handle: 'credential-personal-v1' },
        }),
      ],
      [definition()],
    );

    expect(result.kind).toBe('resolved');
    if (result.kind === 'resolved') {
      expect(result.connection.id).toBe(CONNECTION_ID);
      expect(result.model.id).toBe('vendor/path/model');
    }
  });

  it('does not resolve a catalog model removed from the connection model set', () => {
    expect(resolveModelSelection(
      { connectionId: CONNECTION_ID, modelId: 'vendor/path/model' },
      [connection({ modelIds: [] })],
      [definition()],
    )).toMatchObject({ kind: 'unavailable', reason: 'missing-model' });
  });

  it('prefers connection-local metadata over a matching preconfigured catalog model', () => {
    const result = resolveModelSelection(
      { connectionId: CONNECTION_ID, modelId: 'vendor/path/model' },
      [connection({
        customModels: [{
          id: 'vendor/path/model',
          displayName: 'Work-tuned model',
          protocol: 'openai-compatible',
          capabilities: {
            inputModalities: ['text', 'image'],
            outputModalities: ['text'],
            tools: false,
            reasoning: true,
          },
          limits: { contextTokens: 64_000, outputTokens: 8_000 },
        }],
      })],
      [definition({ allowsCustomModels: false })],
    );

    expect(result).toMatchObject({
      kind: 'resolved',
      model: {
        source: 'connection',
        displayName: 'Work-tuned model',
        capabilities: { inputModalities: ['text', 'image'] },
      },
    });
  });

  it('fails closed for unknown, disabled, and definition-mismatched selections', () => {
    expect(resolveModelSelection(
      { connectionId: OTHER_CONNECTION_ID, modelId: 'vendor/path/model' },
      [connection()],
      [definition()],
    )).toMatchObject({ kind: 'unavailable', reason: 'unknown-connection' });

    expect(resolveModelSelection(
      { connectionId: CONNECTION_ID, modelId: 'vendor/path/model' },
      [connection({ health: 'disabled' }), connection({ id: OTHER_CONNECTION_ID })],
      [definition()],
    )).toMatchObject({ kind: 'unavailable', reason: 'connection-not-ready' });

    expect(resolveModelSelection(
      { connectionId: CONNECTION_ID, modelId: 'different-provider-model' },
      [connection()],
      [definition()],
    )).toMatchObject({ kind: 'unavailable', reason: 'missing-model' });
  });
});
