/**
 * Provider family bindings — read-side connection surface plus the
 * connection-mutation intents. create/update carry no credential material and
 * run on every host; the secret-carrying submit_api_key (and intents that
 * would authenticate with a stored API key) is gated on the
 * 'providers.vault-writes' capability, which the headless daemon never
 * declares — its answer is a typed UNSUPPORTED_ON_HOST error steering toward
 * environment-variable references.
 */
import { HOST_CAPABILITIES, HOST_ERROR_CODES, HostProtocolError } from '../../../shared/host/protocol';
import {
  createConnectionIntent,
  overview as providerOverview,
  updateConnectionIntent,
  submitConnectionApiKey,
  validateConnection,
  disableConnection,
  enableConnection,
  disconnectConnection,
  deleteConnection,
  discoverModels,
  listModelOptions,
  refreshQuota,
  refreshStatus,
  requireConnection,
  statusView,
  withConnectionMutationLock,
  type ProviderCreateConnectionIntent,
  type ProviderSubmitApiKeyIntent,
  type ProviderUpdateConnectionIntent,
} from '../../providers/views';
import type {
  HostBinding,
  HostBindingEntries,
  HostServerSurface,
} from './types';

function requireVaultWrites(surface: HostServerSurface, method: string): void {
  if (!surface.capabilities.has(HOST_CAPABILITIES.PROVIDERS_VAULT_WRITES)) {
    throw new HostProtocolError(
      HOST_ERROR_CODES.UNSUPPORTED_ON_HOST,
      `Method '${method}' requires storing a credential in this machine's encrypted vault, ` +
        'which this host does not provide (a headless orchid-agent daemon has no secure storage). ' +
        'Use environment-variable authentication for connections on this machine.',
    );
  }
}

export function buildProviderBindings(surface: HostServerSurface): HostBindingEntries {
  const entries: Array<[string, HostBinding<never>]> = [];

  const bind = <P>(method: string, binding: HostBinding<P>): void => {
    entries.push([method, binding as HostBinding<never>]);
  };

  bind('providers.list', () => providerOverview());
  bind('providers.create', (_ctx, params: ProviderCreateConnectionIntent) => {
    if (params.authMethod === 'api-key') requireVaultWrites(surface, 'providers.create');
    return createConnectionIntent(params);
  });
  bind('providers.update', async (_ctx, params: ProviderUpdateConnectionIntent) => {
    // Gate the transition TO api-key auth (a stored key could never be
    // attached on this host); updating an already-api-key connection — e.g.
    // renaming a hand-edited remote draft — stays available. A connection
    // that cannot be read fails closed into the same gate.
    if (params.authMethod === 'api-key') {
      let existing: { authMethod: string } | undefined;
      try {
        existing = await requireConnection(params.connectionId);
      } catch {
        // Unreadable/unknown connection: fail closed into the gate below.
      }
      if (existing?.authMethod !== 'api-key') {
        requireVaultWrites(surface, 'providers.update');
      }
    }
    return updateConnectionIntent(params);
  });
  bind('providers.submit_api_key', (_ctx, params: ProviderSubmitApiKeyIntent) => {
    requireVaultWrites(surface, 'providers.submit_api_key');
    return submitConnectionApiKey(params);
  });
  bind('providers.validate', (_ctx, params: { connectionId: string }) =>
    withConnectionMutationLock(params.connectionId, () => validateConnection(params.connectionId)));
  bind('providers.disable', (_ctx, params: { connectionId: string }) =>
    withConnectionMutationLock(params.connectionId, () => disableConnection(params.connectionId)));
  bind('providers.enable', (_ctx, params: { connectionId: string }) =>
    withConnectionMutationLock(params.connectionId, () => enableConnection(params.connectionId)));
  bind('providers.disconnect', (_ctx, params: { connectionId: string }) =>
    withConnectionMutationLock(params.connectionId, () => disconnectConnection(params.connectionId)));
  bind('providers.delete', (_ctx, params: { connectionId: string }) =>
    withConnectionMutationLock(params.connectionId, () => deleteConnection(params.connectionId)));
  bind('providers.model_list', (_ctx, params: { connectionId?: string; includeDisabled?: boolean }) =>
    listModelOptions(params?.connectionId, params?.includeDisabled));
  bind('providers.discover_models', (_ctx, params: { connectionId: string }) =>
    discoverModels(params.connectionId));
  bind('providers.status_refresh', async (_ctx, params: { providerId: string; connectionId?: string }) => {
    const observation = await refreshStatus(params.providerId, params.connectionId);
    return observation ? statusView(observation) : null;
  });
  bind('providers.quota_refresh', async (_ctx, params: { connectionId: string }) => {
    const observation = await refreshQuota(params.connectionId);
    return observation ? statusView(observation) : null;
  });

  return entries;
}
