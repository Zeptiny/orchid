/** Redacted provider-connection cards and safe lifecycle actions. */
import { useState } from 'react';
import type {
  ProviderConnectionIdMessage,
  ProviderConnectionView,
  ProviderDeleteConnectionMessage,
  ProviderDeleteConnectionResult,
  ProviderDefinitionView,
  ProviderDisconnectMessage,
  ProviderMutationResult,
  ProviderStatusRefreshMessage,
  ProviderStatusView,
} from '../../../shared/types/ipc';
import {
  providerStatusForConnection,
  providerStatusIsConnectionScoped,
} from '../../utils/provider-selection';
import { Icon } from '../Icon';
import { Alert } from '../ui/Alert';
import { Button } from '../ui/Button';
import { ConfigCard } from '../ui/ConfigCard';
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
  readonly onDelete?: (
    message: ProviderDeleteConnectionMessage,
  ) => Promise<ProviderDeleteConnectionResult>;
  readonly onRefreshStatus?: (
    message: ProviderStatusRefreshMessage,
  ) => Promise<ProviderStatusView | null>;
}

type ConnectionAction = 'validate' | 'disable' | 'enable' | 'disconnect' | 'delete';

interface ConnectionActionResult {
  readonly message: string | null;
  readonly connection?: ProviderConnectionView;
}

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
  onDelete,
  onRefreshStatus,
}: ConnectionListProps) {
  const [busy, setBusy] = useState<{ connectionId: string; action: ConnectionAction } | null>(null);
  const [confirmDisconnectId, setConfirmDisconnectId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runAction = async (
    connectionId: string,
    action: ConnectionAction,
    operation: (() => Promise<ConnectionActionResult>) | undefined,
  ) => {
    if (!operation) return;
    setBusy({ connectionId, action });
    setError(null);
    setMessage(null);
    try {
      const result = await operation();
      setMessage(
        result.message ?? (result.connection
          ? `${healthLabel(result.connection.health)} connection updated.`
          : 'Connection updated.'),
      );
      if (action === 'disconnect') setConfirmDisconnectId(null);
      if (action === 'delete') setConfirmDeleteId(null);
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
            <Button size="sm" onClick={onAddConnection}>
              Add a connection
            </Button>
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
            <Button size="sm" onClick={onAddConnection}>
              <Icon name="plus" size={15} />
              Add connection
            </Button>
          ) : undefined
        }
      />

      {message && (
        <Alert tone="info" role="status" icon="alertCircle" aria-live="polite">{message}</Alert>
      )}
      {error && (
        <Alert tone="error" icon="alertCircle" aria-live="assertive">{error}</Alert>
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
          const status = providerStatusForConnection(connections, connection, statuses);
          const showsProviderStatus = status !== undefined
            || (providerStatusIsConnectionScoped(connection.providerId)
              && connection.credentialKind !== 'none');
          return (
            <ConfigCard key={connection.id}>
              <ConfigCard.Body className="flex flex-col gap-4">
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

                <dl className="flex flex-col gap-2 text-sm">
                  <div className="flex gap-4">
                    <dt className="shrink-0 font-medium text-base-content/70">Models</dt>
                    <dd className="min-w-0 break-words">
                      {modelNames.length > 0 ? modelNames.join(', ') : 'No model selected'}
                    </dd>
                  </div>
                  {connection.endpoint && (
                    <div className="flex gap-4">
                      <dt className="shrink-0 font-medium text-base-content/70">Endpoint</dt>
                      <dd className="min-w-0 break-all">{connection.endpoint}</dd>
                    </div>
                  )}
                </dl>

                {connection.health === 'needs_attention' && (
                  <Alert tone="warning" icon="alert">
                    Reconnect or validate this connection before using it. Other connections are
                    unaffected.
                  </Alert>
                )}
                {connection.health === 'disabled' && (
                  <Alert tone="info" role="status" icon="alertCircle">
                    New turns are disabled. A turn that already started can finish safely.
                  </Alert>
                )}
                {connection.activeTurnCount > 0 && (
                  <Alert tone="info" role="status" icon="alertCircle">
                    {connection.activeTurnCount} active turn
                    {connection.activeTurnCount === 1 ? ' is' : 's are'} using this connection.
                  </Alert>
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
                  <Alert
                    tone="warning"
                    className="flex-wrap"
                    icon="alert"
                    action={
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          onClick={() => setConfirmDisconnectId(null)}
                          disabled={isBusy}
                        >
                          Cancel
                        </Button>
                        <Button
                          variant="error"
                          size="sm"
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
                        </Button>
                      </div>
                    }
                  >
                    Disconnect removes Orchid's stored credentials.
                    {connection.activeTurnCount > 0
                      ? ` It will cancel ${connection.activeTurnCount} active turn${connection.activeTurnCount === 1 ? '' : 's'} and finalize their accounting first.`
                      : ''}{' '}
                    You may also need to revoke access or a generated key with the provider.
                  </Alert>
                )}

                {confirmDeleteId === connection.id && (
                  <Alert
                    tone="warning"
                    className="flex-wrap"
                    icon="alert"
                    action={
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          onClick={() => setConfirmDeleteId(null)}
                          disabled={isBusy}
                        >
                          Cancel
                        </Button>
                        <Button
                          variant="error"
                          size="sm"
                          onClick={() =>
                            void runAction(
                              connection.id,
                              'delete',
                              onDelete
                                ? () => onDelete({ connectionId: connection.id, confirm: true })
                                : undefined,
                            )
                          }
                          disabled={isBusy || !onDelete}
                        >
                          Delete permanently
                        </Button>
                      </div>
                    }
                  >
                    Delete permanently removes this connection and its stored credentials.
                    Default, tier, and RAG model assignments that use it will be cleared.
                    Historical sessions and accounting remain available.
                  </Alert>
                )}

                <div className="flex justify-end gap-2">
                  {onEditConnection && (
                    <Button
                      size="sm"
                      onClick={() => onEditConnection(connection)}
                      disabled={isBusy}
                    >
                      <Icon name="edit" size={14} />
                      Edit connection
                    </Button>
                  )}
                  {canValidate && (
                    <Button
                      size="sm"
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
                    </Button>
                  )}
                  {connection.health === 'disabled' && (
                    <Button
                      size="sm"
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
                    </Button>
                  )}
                  {connection.health === 'ready' && (
                    <Button
                      size="sm"
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
                    </Button>
                  )}
                  {connection.health !== 'disconnected' &&
                    confirmDisconnectId !== connection.id && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setConfirmDisconnectId(connection.id)}
                        disabled={isBusy || !onDisconnect}
                      >
                        Disconnect
                      </Button>
                    )}
                  {confirmDeleteId !== connection.id && (
                    <Button
                      variant="error"
                      size="sm"
                      onClick={() => {
                        setConfirmDisconnectId(null);
                        setConfirmDeleteId(connection.id);
                      }}
                      disabled={isBusy || !onDelete}
                    >
                      Delete connection
                    </Button>
                  )}
                </div>
              </ConfigCard.Body>
            </ConfigCard>
          );
        })}
      </div>
    </Panel>
  );
}
