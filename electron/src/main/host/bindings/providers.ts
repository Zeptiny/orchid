/**
 * Provider family bindings — read-side connection surface plus read-side
 * mutations (validate/enable/disable/disconnect/delete, model listing and
 * discovery, status/quota refresh). Vault writes are not host methods.
 */
import {
  overview as providerOverview,
  validateConnection,
  disableConnection,
  enableConnection,
  disconnectConnection,
  deleteConnection,
  discoverModels,
  listModelOptions,
  refreshQuota,
  refreshStatus,
  statusView,
  withConnectionMutationLock,
} from '../../providers/views';
import type { HostBinding, HostBindingEntries } from './types';

export function buildProviderBindings(): HostBindingEntries {
  const entries: Array<[string, HostBinding<never>]> = [];

  const bind = <P>(method: string, binding: HostBinding<P>): void => {
    entries.push([method, binding as HostBinding<never>]);
  };

  bind('providers.list', () => providerOverview());
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
