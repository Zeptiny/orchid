import {
  isUsableConnection,
  type EffectiveModel,
  type ModelSelection,
  type ProviderConnection,
  type ProviderDefinition,
  type ProviderResolution,
} from '../../shared/types/provider';

/** Resolve a typed selection without selecting a default or parsing a string reference. */
export function resolveModelSelection(
  selection: ModelSelection | null,
  connections: readonly ProviderConnection[],
  definitions: readonly ProviderDefinition[],
): ProviderResolution {
  if (!connections.some(isUsableConnection)) {
    return { kind: 'provider-required', reason: 'no-usable-connection' };
  }
  if (selection === null) {
    return { kind: 'selection-required', reason: 'no-selection' };
  }

  const connection = connections.find((item) => item.id === selection.connectionId);
  if (!connection) {
    return { kind: 'unavailable', selection, reason: 'unknown-connection' };
  }
  if (!isUsableConnection(connection)) {
    return { kind: 'unavailable', selection, reason: 'connection-not-ready' };
  }

  const provider = definitions.find((item) => item.id === connection.providerId);
  if (!provider) {
    return { kind: 'unavailable', selection, reason: 'unknown-provider' };
  }
  if (provider.lifecycle === 'disabled' || provider.lifecycle === 'retired') {
    return { kind: 'unavailable', selection, reason: 'provider-disabled' };
  }
  if (!provider.supportedAuthMethods.includes(connection.authMethod)
    || !provider.supportedProtocols.includes(connection.protocol)) {
    return { kind: 'unavailable', selection, reason: 'unsupported-connection' };
  }

  const catalogModel = provider.models.find((model) => model.id === selection.modelId);
  if (catalogModel) {
    if (catalogModel.lifecycle === 'disabled' || catalogModel.lifecycle === 'retired') {
      return { kind: 'unavailable', selection, reason: 'model-disabled' };
    }
    if (catalogModel.protocol !== connection.protocol) {
      return { kind: 'unavailable', selection, reason: 'provider-mismatch' };
    }
    const model: EffectiveModel = { ...catalogModel, source: 'catalog' };
    return { kind: 'resolved', selection, connection, provider, model };
  }

  const customModel = connection.customModels?.find((model) => model.id === selection.modelId);
  if (provider.allowsCustomModels && customModel) {
    if (customModel.protocol !== connection.protocol) {
      return { kind: 'unavailable', selection, reason: 'provider-mismatch' };
    }
    const model: EffectiveModel = { ...customModel, source: 'connection' };
    return { kind: 'resolved', selection, connection, provider, model };
  }

  if (provider.allowsCustomModels && connection.modelIds.includes(selection.modelId)) {
    const model: EffectiveModel = {
      id: selection.modelId,
      displayName: selection.modelId,
      protocol: connection.protocol,
      source: 'connection',
    };
    return { kind: 'resolved', selection, connection, provider, model };
  }

  return { kind: 'unavailable', selection, reason: 'missing-model' };
}
