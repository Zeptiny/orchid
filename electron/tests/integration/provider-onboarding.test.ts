/** U8 public-surface checks for connection onboarding and local-only UX. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { OrchidAPI } from '../../src/shared/types/ipc';

const rendererRoot = path.resolve(__dirname, '../../src/renderer');

function source(...parts: string[]): string {
  return fs.readFileSync(path.join(rendererRoot, ...parts), 'utf8');
}

describe('provider onboarding and disconnected UX', () => {
  it('exposes the redacted connection lifecycle through the preload contract', () => {
    type ProviderAPI = OrchidAPI['providers'];
    const methods: Array<keyof ProviderAPI> = [
      'list', 'create', 'update', 'submitApiKey', 'validate', 'disable', 'enable',
      'disconnect', 'modelList', 'refreshStatus',
    ];
    expect(methods).toHaveLength(10);
  });

  it('opens onboarding based on usable connections, not session presence', () => {
    const app = source('App.tsx');
    expect(app).toContain('window.orchid?.providers?.list');
    expect(app).toContain("connection.health === 'ready'");
    expect(app).toContain('provider onboarding is driven by connection readiness');
  });

  it('keeps plain chat disabled with an accessible provider-setup path', () => {
    const composer = source('components', 'InputArea.tsx');
    expect(composer).toContain('providerAvailable');
    expect(composer).toContain('Set up provider');
    expect(composer).toContain('onOpenProviders');
    // Slash commands remain distinct from LLM sends so local commands work.
    expect(composer).toContain("!trimmed.startsWith('/')");
  });

  it('uses typed connection/model selections and never parses model IDs', () => {
    const chat = source('components', 'ChatView.tsx');
    const viewModel = source('utils', 'provider-selection.ts');
    expect(chat).toContain('providerModelOptionKey');
    expect(chat).toContain('connectionId: option.selection.connectionId');
    expect(viewModel).toContain('never splits a model ID');
  });

  it('clears a pasted API key after its one-shot submission settles', () => {
    const wizard = source('components', 'Providers', 'ConnectionWizard.tsx');
    expect(wizard).toContain('onSubmitApiKey');
    expect(wizard).toContain('finally');
    expect(wizard).toContain("setApiKey('')");
    expect(wizard).not.toContain('credential.handle');
  });

  it('guards provider submission synchronously and keeps composer gates reactive', () => {
    const wizard = source('components', 'Providers', 'ConnectionWizard.tsx');
    const composer = source('components', 'InputArea.tsx');
    expect(wizard).toContain('if (submittingRef.current) return');
    expect(wizard).toContain('submittingRef.current = true');
    expect(composer).toMatch(/modelSelected,[\s\S]*onOpenProviders,[\s\S]*providerAvailable,[\s\S]*workspaceBound,/);
  });

  it('searches provider presets and uses the shared model editor during setup', () => {
    const wizard = source('components', 'Providers', 'ConnectionWizard.tsx');
    const providerPicker = source('components', 'SearchableOptionPicker.tsx');
    expect(wizard).toContain('SearchableOptionPicker');
    expect(wizard).toContain('<ConnectionModelsEditor');
    expect(wizard).toContain('searchPlaceholder="Search providers..."');
    expect(providerPicker).toContain('searchPlaceholder');
    expect(wizard).not.toContain('<ModelPicker');
    expect(wizard).not.toContain('Initial model');
  });

  it('configures multiple models and capabilities before creating a connection', () => {
    const onboarding = source('components', 'Onboarding', 'OnboardingScreen.tsx');
    const providersTab = source('components', 'Preferences', 'ProvidersTab.tsx');
    const wizard = source('components', 'Providers', 'ConnectionWizard.tsx');

    expect(onboarding).toContain('<ConnectionWizard');
    expect(onboarding).toContain('onCreate={providers.createConnection}');
    expect(providersTab).toContain('<ConnectionWizard');
    expect(providersTab).toContain('onCreate={providers.createConnection}');
    expect(wizard).toContain('function defaultModelIds');
    expect(wizard).toContain('setConnectionModelIds(defaultModelIds(definition, nextProtocol))');
    expect(wizard).toContain('{selectedDefinition && (');
    expect(wizard).not.toContain('{existingConnection && selectedDefinition && (');
    expect(wizard).toContain('selectedModelIds={connectionModelIds}');
    expect(wizard).toContain('modelIds = [...connectionModelIds]');
    expect(wizard).toContain('customModels = [...connectionCustomModels]');
    expect(wizard).toContain(
      "const selectionModelId = existingConnection ? '' : connectionModelIds[0] ?? '';",
    );
  });

  it('renders Lilac supply discount and Neuralwatt quota as informational status', () => {
    const status = source('components', 'Providers', 'ProviderStatus.tsx');
    const providersTab = source('components', 'Preferences', 'ProvidersTab.tsx');
    const connections = source('components', 'Providers', 'ConnectionList.tsx');
    expect(status).toContain('Subscription discount');
    expect(status).toContain('Credit multiplier');
    expect(status).toContain('Accounting method');
    expect(status).toContain('Informational only');
    expect(providersTab).not.toContain('<ProviderStatus');
    expect(connections).toContain('<ProviderStatus');
    expect(connections).toContain('providerStatusConnectionId');
  });

  it('manages connection settings and models through one edit modal', () => {
    const providersTab = source('components', 'Preferences', 'ProvidersTab.tsx');
    const connections = source('components', 'Providers', 'ConnectionList.tsx');
    const modelEditor = source('components', 'Providers', 'ConnectionModelsDialog.tsx');
    const wizard = source('components', 'Providers', 'ConnectionWizard.tsx');

    expect(providersTab).not.toContain('<ConnectionModelsDialog');
    expect(connections).toContain('Edit connection');
    expect(connections).not.toContain('Manage models');
    expect(connections).not.toContain('Update authentication');
    expect(wizard).toContain('<ConnectionModelsEditor');
    expect(wizard).toContain('modelIds = [...connectionModelIds]');
    expect(wizard).toContain('customModels = [...connectionCustomModels]');
    expect(modelEditor).not.toContain('<dialog');
    expect(modelEditor).toContain('customModels');
    expect(modelEditor).toContain('Add custom model');
    expect(modelEditor).toContain('Edit');
    expect(modelEditor).toContain('Remove');
  });

  it('omits fixed protocol controls from edit mode and removes the separate initial-model picker', () => {
    const wizard = source('components', 'Providers', 'ConnectionWizard.tsx');

    expect(wizard).toContain('{!existingConnection && (');
    expect(wizard).toContain('Connection protocol');
    expect(wizard).not.toContain('Initial model');
    expect(wizard).toContain('Edit connection');
    expect(wizard).toContain('Save changes');
  });

  it('allows every connection to update its authentication through the safe credential wizard', () => {
    const providersTab = source('components', 'Preferences', 'ProvidersTab.tsx');
    const connections = source('components', 'Providers', 'ConnectionList.tsx');
    const wizard = source('components', 'Providers', 'ConnectionWizard.tsx');

    expect(providersTab).toContain('onEditConnection');
    expect(connections).toContain('Edit connection');
    expect(wizard).toContain('authMethod: message.authMethod');
    expect(wizard).toContain('Edit connection');
    expect(wizard).toContain('disabled={metadataLocked}');
    expect(wizard).toContain('onSubmitApiKey');
  });

  it('keeps authentication and protocol details out of connection cards', () => {
    const connections = source('components', 'Providers', 'ConnectionList.tsx');
    const wizard = source('components', 'Providers', 'ConnectionWizard.tsx');

    expect(connections).not.toContain('>Authentication</dt>');
    expect(connections).not.toContain('credentialLabel(connection)');
    expect(connections).not.toContain('>Protocol</dt>');
    expect(connections).not.toContain('protocolLabel(connection.protocol)');
    expect(wizard).toContain('<legend className="fieldset-legend">Authentication</legend>');
  });

  it('matches the provider wizard shell and edits explicit input/output capabilities', () => {
    const modelEditor = source('components', 'Providers', 'ConnectionModelsDialog.tsx');
    const wizard = source('components', 'Providers', 'ConnectionWizard.tsx');

    expect(wizard).toContain('provider-connection-wizard');
    expect(wizard).toContain('provider-wizard-header');
    expect(wizard).toContain('provider-wizard-body');
    expect(wizard).toContain('provider-wizard-actions');
    expect(modelEditor).toContain('startEditingCatalogModel');
    expect(modelEditor).toContain('Customized');
    expect(modelEditor).toContain('Input capabilities');
    expect(modelEditor).toContain('Output capabilities');
    expect(modelEditor).toContain('toggleModality');
    expect(modelEditor).not.toContain('connection-model-editor-type');
    expect(modelEditor).not.toContain('Model type');
  });
});
