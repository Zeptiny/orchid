// @vitest-environment jsdom
/** Connection wizard protocol gating: a picker exists only when a provider offers a choice. */
import type { ComponentProps } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionWizard } from '../../src/renderer/components/Providers/ConnectionWizard';
import type {
  ProviderConnectionView,
  ProviderDefinitionView,
} from '../../src/shared/types/ipc';

function definition(overrides: Partial<ProviderDefinitionView> = {}): ProviderDefinitionView {
  return {
    id: 'orchid-multi',
    displayName: 'Orchid Multi',
    supportedAuthMethods: ['api-key'],
    supportedProtocols: ['openai-compatible', 'openai-responses'],
    allowsCustomModels: false,
    lifecycle: 'active',
    available: true,
    unavailableReason: null,
    supportsDiscovery: false,
    supportsQuota: false,
    models: [{
      id: 'orchid-text',
      displayName: 'Orchid Text',
      protocol: 'openai-compatible',
      lifecycle: 'active',
      source: 'catalog',
      capabilities: { inputModalities: ['text'], outputModalities: ['text'], tools: true, reasoning: false },
      limits: null,
    }],
    ...overrides,
  };
}

const CONNECTION: ProviderConnectionView = {
  id: 'conn-1',
  providerId: 'orchid-multi',
  providerDisplayName: 'Orchid Multi',
  name: 'Orchid Multi',
  protocol: 'openai-compatible',
  authMethod: 'api-key',
  credentialKind: 'stored',
  environmentVariable: null,
  modelIds: ['orchid-text'],
  customModels: [],
  health: 'ready',
  activeTurnCount: 0,
  endpoint: null,
  allowInsecureHttp: false,
};

function renderWizard(overrides: Partial<ComponentProps<typeof ConnectionWizard>> = {}) {
  const mutation = { connection: CONNECTION, message: null };
  const onCreate = vi.fn(async () => mutation);
  const props: ComponentProps<typeof ConnectionWizard> = {
    isOpen: true,
    definitions: [definition()],
    secureStorage: { available: true, backend: 'test', reason: null },
    onClose: vi.fn(),
    onCreate,
    onSubmitApiKey: vi.fn(async () => mutation),
    onValidate: vi.fn(async () => mutation),
    ...overrides,
  };
  return { props, ...render(<ConnectionWizard {...props} />) };
}

afterEach(() => cleanup());

describe('connection wizard protocol picker', () => {
  it('omits the protocol panel when the provider supports a single protocol', () => {
    renderWizard({ definitions: [definition({ supportedProtocols: ['openai-compatible'] })] });

    expect(screen.queryByLabelText('Connection protocol')).toBeNull();
    expect(screen.queryByText('Protocol')).toBeNull();
    expect(screen.queryByText(/Protocol is fixed after creation/)).toBeNull();
  });

  it('still creates the connection with the definition default protocol when the picker is hidden', async () => {
    const { props } = renderWizard({
      definitions: [definition({
        supportedProtocols: ['anthropic-messages'],
        models: [{
          id: 'orchid-text',
          displayName: 'Orchid Text',
          protocol: 'anthropic-messages',
          lifecycle: 'active',
          source: 'catalog',
          capabilities: { inputModalities: ['text'], outputModalities: ['text'], tools: true, reasoning: false },
          limits: null,
        }],
      })],
    });

    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create connection' }));

    await waitFor(() => expect(props.onCreate).toHaveBeenCalledTimes(1));
    expect(props.onCreate).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'orchid-multi',
      protocol: 'anthropic-messages',
      modelIds: ['orchid-text'],
    }));
  });

  it('renders one option per supported protocol when several exist', () => {
    renderWizard({
      definitions: [definition({
        supportedProtocols: ['openai-responses', 'openai-compatible'],
      })],
    });

    const select = screen.getByLabelText('Connection protocol') as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual([
      'openai-responses',
      'openai-compatible',
    ]);
    // The definition's first protocol stays the default selection.
    expect(select.value).toBe('openai-responses');
  });

  it('omits the protocol panel in edit mode even for multi-protocol providers', () => {
    renderWizard({ existingConnection: CONNECTION });

    expect(screen.queryByLabelText('Connection protocol')).toBeNull();
    expect(screen.queryByText('Protocol')).toBeNull();
    expect(screen.queryByText(/Protocol is fixed after creation/)).toBeNull();
  });
});
