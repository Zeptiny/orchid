/** Connection-centered provider settings; all data comes from redacted IPC. */
import { useState } from 'react';
import type { ModelSelection } from '../../../shared/types/provider';
import type { ProviderConnectionView } from '../../../shared/types/ipc';
import { useProviders } from '../../hooks/useProviders';
import {
  ConnectionWizard,
  type ProviderConnectionCompletion,
} from '../Providers/ConnectionWizard';
import { ConnectionList } from '../Providers/ConnectionList';
import { Icon } from '../Icon';

export function ProvidersTab() {
  const providers = useProviders();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [connectionToEdit, setConnectionToEdit] = useState<ProviderConnectionView | null>(null);

  const completeConnection = async (result: ProviderConnectionCompletion) => {
    if (result.selection) {
      window.dispatchEvent(new CustomEvent<{ selection: ModelSelection }>(
        'orchid:provider-selection-created',
        { detail: { selection: result.selection } },
      ));
    }
    await providers.refresh();
    setConnectionToEdit(null);
  };

  // ConfigView gates tab mount until overview is ready — no intermediate spinner.
  if (!providers.overview) {
    return (
      <div role="alert" className="alert alert-warning">
        <Icon name="alert" size={16} />
        <span>{providers.error ?? 'Provider connections are unavailable in this build.'}</span>
        <button type="button" className="btn btn-sm" onClick={() => void providers.refresh()}>
          Retry
        </button>
      </div>
    );
  }

  const { overview } = providers;
  return (
    <div className="config-form">
      {!overview.secureStorage.available && (
        <div role="alert" className="alert alert-warning">
          <Icon name="alert" size={16} />
          <span>
            Secure credential storage is unavailable
            {overview.secureStorage.reason === 'basic_text' ? ' because this system selected basic_text storage.' : '.'}
            {' '}Use an environment-variable connection instead of pasting an API key.
          </span>
        </div>
      )}

      {providers.error && (
        <div role="alert" className="alert alert-error">
          <Icon name="alert" size={16} />
          <span>{providers.error}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={providers.clearError}>Dismiss</button>
        </div>
      )}

      <ConnectionList
        connections={overview.connections}
        definitions={overview.definitions}
        statuses={overview.statuses}
        onAddConnection={() => {
          setConnectionToEdit(null);
          setWizardOpen(true);
        }}
        onEditConnection={(connection) => {
          setConnectionToEdit(connection);
          setWizardOpen(true);
        }}
        onValidate={providers.validateConnection}
        onDisable={providers.disableConnection}
        onEnable={providers.enableConnection}
        onDisconnect={providers.disconnectConnection}
        onRefreshStatus={providers.refreshStatus}
      />

      <ConnectionWizard
        isOpen={wizardOpen}
        existingConnection={connectionToEdit}
        definitions={overview.definitions}
        secureStorage={overview.secureStorage}
        onClose={() => {
          setWizardOpen(false);
          setConnectionToEdit(null);
        }}
        onCreate={providers.createConnection}
        onUpdate={providers.updateConnection}
        onSubmitApiKey={providers.submitApiKey}
        onValidate={providers.validateConnection}

        onComplete={completeConnection}
      />
    </div>
  );
}
