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
      'disconnect', 'deleteConnection', 'modelList', 'refreshStatus',
    ];
    expect(methods).toHaveLength(11);
  });

  it('opens onboarding based on has_completed_onboarding, not provider readiness', () => {
    const app = source('AppReady.tsx');
    expect(app).toContain('window.orchid?.config?.get');
    expect(app).toContain('has_completed_onboarding');
    expect(app).toContain('First-run wizard opens only until finish/skip');
    expect(app).not.toContain("connection.health === 'ready'");
  });

  it('keeps plain chat disabled with an accessible provider-setup path', () => {
    const composer = source('components', 'InputArea.tsx');
    const sendLock = source('utils', 'composer-send-lock.ts');
    expect(composer).toContain('providerAvailable');
    expect(composer).toContain('Set up provider');
    expect(composer).toContain('onOpenProviders');
    // Slash commands remain distinct from LLM sends so local commands work.
    expect(sendLock).toContain("input.trimmed.startsWith('/')");
    expect(sendLock).toContain("!input.providerAvailable && !isSlash");
  });

  it('uses typed connection/model selections and never parses model IDs', () => {
    const chat = source('components', 'ChatView.tsx');
    const viewModel = source('utils', 'provider-selection.ts');
    expect(chat).toContain('providerModelOptionKey');
    expect(chat).toContain('connectionId: option.selection.connectionId');
    expect(viewModel).toContain('never splits a model ID');
  });

  it('restores config default_model in draft mode instead of clearing selection', () => {
    const chat = source('components', 'ChatView.tsx');
    // Draft (no active session) must re-apply the configured default, not null.
    expect(chat).toContain('setDefaultSelection');
    expect(chat).toMatch(
      /if \(session\.activeSession\) \{[\s\S]*setCurrentSelection\(session\.activeSession\.selection \?\? null\);[\s\S]*return;[\s\S]*\}[\s\S]*setCurrentSelection\(defaultSelection\);/,
    );
    // Must not unconditionally wipe selection when activeSession is null.
    expect(chat).not.toMatch(
      /setCurrentSelection\(session\.activeSession\?\.selection \?\? null\);/,
    );
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
    const popoverList = source('components', 'ui', 'PopoverList.tsx');
    expect(wizard).toContain('PopoverList');
    expect(wizard).toContain('<ConnectionModelsEditor');
    expect(wizard).toContain('searchPlaceholder="Search providers..."');
    expect(popoverList).toContain('searchPlaceholder');
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

  it('offers provider-scoped select-all and deselect-all model actions everywhere the editor is used', () => {
    const modelEditor = source('components', 'Providers', 'ConnectionModelsDialog.tsx');
    const onboarding = source('components', 'Onboarding', 'OnboardingScreen.tsx');
    const providersTab = source('components', 'Preferences', 'ProvidersTab.tsx');

    expect(modelEditor).toContain('Select all models');
    expect(modelEditor).toContain('Deselect all models');
    expect(modelEditor).toContain('catalogModelIds');
    expect(modelEditor).toContain('selectableModelIds');
    expect(onboarding).toContain('<ConnectionWizard');
    expect(providersTab).toContain('<ConnectionWizard');
  });

  it('keeps onboarding open for multiple providers before assigning the default and tier models', () => {
    const onboarding = source('components', 'Onboarding', 'OnboardingScreen.tsx');

    expect(onboarding).toContain("'providers'");
    expect(onboarding).toContain("'models'");
    expect(onboarding).toContain("'appearance'");
    expect(onboarding).toContain("'project'");
    expect(onboarding).toContain("'rag'");
    expect(onboarding).toContain("'mcp'");
    expect(onboarding).toContain('Add another provider');
    expect(onboarding).toContain('default_model');
    expect(onboarding).toContain('tier_models');
    expect(onboarding).toContain('has_completed_onboarding');
    expect(onboarding).toContain('window.orchid.config.save');
    expect(onboarding).toContain('RECOMMENDED_MCP_SERVERS');
    expect(onboarding).toContain('Skip onboarding');
    expect(onboarding).toContain('Finish onboarding');
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
    expect(connections).toContain('providerStatusForConnection');
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

  it('requires confirmation before permanently deleting a connection', () => {
    const providersTab = source('components', 'Preferences', 'ProvidersTab.tsx');
    const connections = source('components', 'Providers', 'ConnectionList.tsx');

    expect(providersTab).toContain('onDelete={providers.deleteConnection}');
    expect(connections).toContain('Delete connection');
    expect(connections).toContain('Delete permanently');
    expect(connections).toContain('Default, tier, and RAG model assignments');
    expect(connections).toMatch(
      /onDelete\s*\?\s*\(\)\s*=>\s*onDelete\(\{\s*connectionId:\s*connection\.id,\s*confirm:\s*true\s*\}\)/,
    );
    expect(connections).toContain('initialFocusRef={deletePermanentRef}');
    expect(connections).toContain('restoreFocusRef={deleteTriggerRef}');
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
    expect(wizard).toContain('title="Authentication"');
  });

  it('keeps connection cards compact and sends lifecycle feedback to the settings surface', () => {
    const connections = source('components', 'Providers', 'ConnectionList.tsx');
    const providersTab = source('components', 'Preferences', 'ProvidersTab.tsx');

    expect(connections).not.toContain('Each connection is a separate provider account or endpoint.');
    expect(connections).not.toContain('New turns are disabled. A turn that already started can finish safely.');
    expect(connections).not.toContain('{message && (');
    expect(connections).not.toContain('{error && (');
    expect(connections).toContain('onNotify');
    expect(connections).toContain('className="h-full"');
    expect(connections).toContain('mt-auto flex flex-wrap');
    expect(connections).toContain('model.displayName');
    expect(connections).toContain('definition?.models');
    expect(providersTab).toContain('onNotify');
    expect(providersTab).toContain("'info'");
    expect(providersTab).not.toContain('statusMessage');
    expect(providersTab).not.toContain('statusTimer');
    expect(providersTab).toContain('result.message');
    expect(source('AppReady.tsx')).toContain('onNotify={notify}');
  });

  it('matches the provider wizard shell and edits explicit input/output capabilities', () => {
    const modelEditor = source('components', 'Providers', 'ConnectionModelsDialog.tsx');
    const wizard = source('components', 'Providers', 'ConnectionWizard.tsx');

    expect(wizard).toContain('provider-connection-wizard');
    expect(wizard).toContain('provider-wizard-header');
    expect(wizard).toContain('provider-wizard-body');
    expect(wizard).toContain('provider-wizard-actions');
    expect(modelEditor).toContain('startEditingRow');
    expect(modelEditor).toContain('Customized');
    expect(modelEditor).toContain('Input capabilities');
    expect(modelEditor).toContain('Output capabilities');
    expect(modelEditor).toContain('toggleModality');
    expect(modelEditor).not.toContain('connection-model-editor-type');
    expect(modelEditor).not.toContain('Model type');
  });

  it('prevents focus scrolling from moving the provider modal shell', () => {
    const css = source('styles', 'components.css');

    expect(css).toMatch(
      /\.provider-connection-wizard \.modal-box \{[^}]*overflow-clip/s,
    );
  });
});
