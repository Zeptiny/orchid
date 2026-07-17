/** Redacted provider-connection cards and safe lifecycle actions. */
import { useState } from 'react';
import type {
  ProviderConnectionIdMessage,
  ProviderConnectionView,
  ProviderDefinitionView,
  ProviderDisconnectMessage,
  ProviderMutationResult,
  ProviderStatusRefreshMessage,
  ProviderStatusView,
} from '../../../shared/types/ipc';
import { providerStatusConnectionId } from '../../utils/provider-selection';
import { Icon } from '../Icon';
import { Panel } from '../ui/Panel';
import { SectionHeader } from '../ui/SectionHeader';
import { StateMessage } from '../ui/StateMessage';
import { StatusBadge } from '../ui/StatusBadge';
import { ProviderStatus } from './ProviderStatus';

export interface ConnectionListProps {
  readonly connections: readonly ProviderConnectionView[];
  readonly definitions?: readonly ProviderDefinitionView[];
  readonly statuses?: readonly ProviderStatusView[];
  readonly onAddConnection?: () => void;
  readonly onEditConnection?: (connection: ProviderConnectionView) => void;
  readonly onValidate?: (message: ProviderConnectionIdMessage) => Promise<ProviderMutationResult>;
  readonly onDisable?: (message: ProviderConnectionIdMessage) => Promise<ProviderMutationResult>;
  readonly onEnable?: (message: ProviderConnectionIdMessage) => Promise<ProviderMutationResult>;
  readonly onDisconnect?: (message: ProviderDisconnectMessage) => Promise<ProviderMutationResult>;
  readonly onRefreshStatus?: (
    message: ProviderStatusRefreshMessage,
  ) => Promise<ProviderStatusView | null>;
}

type ConnectionAction = 'validate' | 'disable' | 'enable' | 'disconnect';

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : 'The connection action could not be completed.';
}

function healthLabel(health: ProviderConnectionView['health']): string {
  switch (health) {
    case 'ready':
      return 'Ready';
    case 'needs_attention':
      return 'Needs attention';
    case 'disabled':
      return 'Disabled';
    case 'disconnected':
      return 'Disconnected';
    case 'draft':
      return 'Draft';
  }
}

function healthBadgeTone(
  health: ProviderConnectionView['health'],
): 'success' | 'warning' | 'neutral' | 'error' | 'info' {
  switch (health) {
    case 'ready':
      return 'success';
    case 'needs_attention':
      return 'warning';
    case 'disabled':
      return 'neutral';
    case 'disconnected':
      return 'error';
    case 'draft':
      return 'info';
  }
}

/**
 * Each card represents a single account/endpoint. It never shows a credential
 * handle or token, and disconnect requires an explicit in-context confirmation.
 */
export function ConnectionList({
  connections,
  definitions = [],
  statuses = [],
  onAddConnection,
  onEditConnection,
  onValidate,
  onDisable,
  onEnable,
  onDisconnect,
  onRefreshStatus,
}: ConnectionListProps) {
  const [busy, setBusy] = useState<{ connectionId: string; action: ConnectionAction } | null>(null);
  const [confirmDisconnectId, setConfirmDisconnectId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runAction = async (
    connectionId: string,
    action: ConnectionAction,
    operation: (() => Promise<ProviderMutationResult>) | undefined,
  ) => {
    if (!operation) return;
    setBusy({ connectionId, action });
    setError(null);
    setMessage(null);
    try {
      const result = await operation();
      setMessage(result.message ?? `${healthLabel(result.connection.health)} connection updated.`);
      if (action === 'disconnect') setConfirmDisconnectId(null);
    } catch (actionError) {
      setError(describeError(actionError));
    } finally {
      setBusy(null);
    }
  };

  if (connections.length === 0) {
    return (
      <Panel
        as="section"
        aria-labelledby="provider-connections-title"
        className="config-fieldset flex flex-col gap-3"
      >
        <SectionHeader title={<span id="provider-connections-title">Connections</span>} />
        <StateMessage
          kind="info"
          icon="cpu"
          title="No provider connections yet"
          className="py-4"
        >
          Local workspace, history, and settings stay available.
        </StateMessage>
        {onAddConnection && (
          <div className="flex justify-center">
            <button type="button" className="btn btn-sm" onClick={onAddConnection}>
              Add a connection
            </button>
          </div>
        )}
      </Panel>
    );
  }

  return (
    <Panel
      as="section"
      aria-labelledby="provider-connections-title"
      className="config-fieldset flex flex-col gap-3"
    >
      <SectionHeader
        title={<h2 id="provider-connections-title" className="text-sm font-semibold">Connections</h2>}
        description="Each connection is a separate provider account or endpoint."
        actions={
          onAddConnection ? (
            <button type="button" className="btn btn-sm" onClick={onAddConnection}>
              <Icon name="plus" size={15} />
              Add connection
            </button>
          ) : undefined
        }
      />

      {message && (
        <div role="status" aria-live="polite" className="alert alert-info">
          <Icon name="alertCircle" size={16} />
          <span>{message}</span>
        </div>
      )}
      {error && (
        <div role="alert" aria-live="assertive" className="alert alert-error">
          <Icon name="alertCircle" size={16} />
          <span>{error}</span>
        </div>
      )}

      <div className="grid gap-3 xl:grid-cols-2">
        {connections.map((connection) => {
          const isBusy = busy?.connectionId === connection.id;
          const modelNames = [
            ...connection.modelIds,
            ...connection.customModels
              .map((model) => model.id)
              .filter((modelId) => !connection.modelIds.includes(modelId)),
          ];
          const canValidate =
            connection.health === 'draft' || connection.health === 'needs_attention';
          const definition = definitions.find((candidate) => candidate.id === connection.providerId);
          const status = statuses.find((candidate) => candidate.providerId === connection.providerId);
          const showsProviderStatus = providerStatusConnectionId(
            connections,
            connection.providerId,
          ) === connection.id;
          return (
            <article key={connection.id} className="config-card card bg-base-100 border border-base-300">
              <div className="card-body flex flex-col gap-4 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="config-card-title font-semibold">{connection.name}</h3>
                    <p className="config-card-desc text-sm text-base-content/70">
                      {connection.providerDisplayName ?? connection.providerId}
                    </p>
                  </div>
                  <StatusBadge tone={healthBadgeTone(connection.health)} size="sm">
                    {healthLabel(connection.health)}
                  </StatusBadge>
                </div>

                <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
                  <dt className="font-medium text-base-content/70">Models</dt>
                  <dd className="break-words">
                    {modelNames.length > 0 ? modelNames.join(', ') : 'No model selected'}
                  </dd>
                  {connection.endpoint && (
                    <>
                      <dt className="font-medium text-base-content/70">Endpoint</dt>
                      <dd className="break-all">{connection.endpoint}</dd>
                    </>
                  )}
                </dl>

                {connection.health === 'needs_attention' && (
                  <div role="alert" className="alert alert-warning">
                    <Icon name="alert" size={16} />
                    <span>
                      Reconnect or validate this connection before using it. Other connections are
                      unaffected.
                    </span>
                  </div>
                )}
                {connection.health === 'disabled' && (
                  <div role="status" className="alert alert-info">
                    <Icon name="alertCircle" size={16} />
                    <span>
                      New turns are disabled. A turn that already started can finish safely.
                    </span>
                  </div>
                )}
                {connection.activeTurnCount > 0 && (
                  <div role="status" className="alert alert-info">
                    <Icon name="alertCircle" size={16} />
                    <span>
                      {connection.activeTurnCount} active turn
                      {connection.activeTurnCount === 1 ? ' is' : 's are'} using this connection.
                    </span>
                  </div>
                )}

                {showsProviderStatus && (
                  <ProviderStatus
                    connection={connection}
                    definition={definition}
                    status={status}
                    onRefresh={onRefreshStatus}
                  />
                )}

                {confirmDisconnectId === connection.id && (
                  <div role="alert" className="alert alert-warning flex-wrap">
                    <Icon name="alert" size={16} />
                    <span>
                      Disconnect removes Orchid’s stored credentials.
                      {connection.activeTurnCount > 0
                        ? ` It will cancel ${connection.activeTurnCount} active turn${connection.activeTurnCount === 1 ? '' : 's'} and finalize their accounting first.`
                        : ''}{' '}
                      You may also need to revoke access or a generated key with the provider.
                    </span>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => setConfirmDisconnectId(null)}
                        disabled={isBusy}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="btn btn-error btn-sm"
                        onClick={() =>
                          void runAction(
                            connection.id,
                            'disconnect',
                            onDisconnect
                              ? () => onDisconnect({ connectionId: connection.id, confirm: true })
                              : undefined,
                          )
                        }
                        disabled={isBusy || !onDisconnect}
                      >
                        Disconnect
                      </button>
                    </div>
                  </div>
                )}

                <div className="flex justify-end gap-2">
                  {onEditConnection && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => onEditConnection(connection)}
                      disabled={isBusy}
                    >
                      <Icon name="edit" size={14} />
                      Edit connection
                    </button>
                  )}
                  {canValidate && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() =>
                        void runAction(
                          connection.id,
                          'validate',
                          onValidate
                            ? () => onValidate({ connectionId: connection.id })
                            : undefined,
                        )
                      }
                      disabled={isBusy || !onValidate}
                    >
                      {isBusy && busy?.action === 'validate' ? 'Validating…' : 'Validate'}
                    </button>
                  )}
                  {connection.health === 'disabled' && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() =>
                        void runAction(
                          connection.id,
                          'enable',
                          onEnable ? () => onEnable({ connectionId: connection.id }) : undefined,
                        )
                      }
                      disabled={isBusy || !onEnable}
                    >
                      {isBusy && busy?.action === 'enable' ? 'Enabling…' : 'Enable'}
                    </button>
                  )}
                  {connection.health === 'ready' && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() =>
                        void runAction(
                          connection.id,
                          'disable',
                          onDisable ? () => onDisable({ connectionId: connection.id }) : undefined,
                        )
                      }
                      disabled={isBusy || !onDisable}
                    >
                      {isBusy && busy?.action === 'disable' ? 'Disabling…' : 'Disable'}
                    </button>
                  )}
                  {connection.health !== 'disconnected' &&
                    confirmDisconnectId !== connection.id && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => setConfirmDisconnectId(connection.id)}
                        disabled={isBusy || !onDisconnect}
                      >
                        Disconnect
                      </button>
                    )}
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </Panel>
  );
}
