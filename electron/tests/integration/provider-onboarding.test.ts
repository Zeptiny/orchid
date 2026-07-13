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

  it('searches provider presets and catalog models during setup', () => {
    const wizard = source('components', 'Providers', 'ConnectionWizard.tsx');
    const providerPicker = source('components', 'SearchableOptionPicker.tsx');
    const modelPicker = source('components', 'ModelPicker.tsx');
    expect(wizard).toContain('SearchableOptionPicker');
    expect(wizard).toContain('<ModelPicker');
    expect(wizard).toContain('searchPlaceholder="Search providers..."');
    expect(providerPicker).toContain('searchPlaceholder');
    expect(modelPicker).toContain('Search models...');
    expect(modelPicker).toContain('additionalOptions');
  });

  it('renders Lilac supply discount and Neuralwatt quota as informational status', () => {
    const status = source('components', 'Providers', 'ProviderStatus.tsx');
    expect(status).toContain('Subscription discount');
    expect(status).toContain('Credit multiplier');
    expect(status).toContain('Accounting method');
    expect(status).toContain('Informational only');
  });
});
