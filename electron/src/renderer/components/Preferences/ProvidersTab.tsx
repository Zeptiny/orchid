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
import { Alert } from '../ui/Alert';
import { Button } from '../ui/Button';
import { StateMessage } from '../ui/StateMessage';

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
      <StateMessage
        kind="warning"
        title={providers.error ?? 'Provider connections are unavailable in this build.'}
        action={
          <Button type="button" size="sm" onClick={() => void providers.refresh()}>
            Retry
          </Button>
        }
      />
    );
  }

  const { overview } = providers;
  return (
    <div className="config-form flex flex-col gap-4">
      {!overview.secureStorage.available && (
        <Alert tone="warning" icon="alert">
          Secure credential storage is unavailable
          {overview.secureStorage.reason === 'basic_text' ? ' because this system selected basic_text storage.' : '.'}
          {' '}Use an environment-variable connection instead of pasting an API key.
        </Alert>
      )}

      {providers.error && (
        <Alert tone="error" icon="alert" action={
          <Button variant="ghost" size="sm" type="button" onClick={providers.clearError}>Dismiss</Button>
        }>
          {providers.error}
        </Alert>
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
