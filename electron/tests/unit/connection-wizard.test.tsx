// @vitest-environment jsdom
/** Connection wizard: protocol gating, draft model discovery, and model search. */
import type { ComponentProps } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionWizard } from '../../src/renderer/components/Providers/ConnectionWizard';
import type {
  ProviderConnectionView,
  ProviderDefinitionView,
  ProviderModelView,
} from '../../src/shared/types/ipc';

function model(id: string, displayName: string): ProviderModelView {
  return {
    id,
    displayName,
    protocol: 'openai-compatible',
    lifecycle: 'active',
    source: 'catalog',
    capabilities: { inputModalities: ['text'], outputModalities: ['text'], tools: true, reasoning: false },
    limits: null,
  };
}

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

describe('connection wizard draft model discovery (#138)', () => {
  it('fetches live models while creating and flows selections into the create payload', async () => {
    const onDiscoverDraftModels = vi.fn(async () => ({
      status: 'ok' as const,
      models: [{ ...model('live-model', 'Live Model'), source: 'provider' as const }],
      discoveredAt: '2026-08-21T00:00:00.000Z',
      message: 'Fetched 1 model from the live endpoint. Select the ones this connection should enable.',
    }));
    const { props } = renderWizard({
      definitions: [definition({ supportsDiscovery: true })],
      onDiscoverDraftModels,
    });

    fireEvent.click(screen.getByRole('button', { name: /fetch models/i }));

    await waitFor(() => expect(onDiscoverDraftModels).toHaveBeenCalledTimes(1));
    expect(onDiscoverDraftModels).toHaveBeenCalledWith({
      providerId: 'orchid-multi',
      protocol: 'openai-compatible',
      authMethod: 'api-key',
    });
    expect(await screen.findByText('Live Model')).toBeDefined();

    fireEvent.click(screen.getByLabelText('Use Live Model'));
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create connection' }));

    await waitFor(() => expect(props.onCreate).toHaveBeenCalledTimes(1));
    expect(props.onCreate).toHaveBeenCalledWith(expect.objectContaining({
      modelIds: ['orchid-text', 'live-model'],
    }));
  });

  it('surfaces the draft message without adding rows on failure', async () => {
    const onDiscoverDraftModels = vi.fn(async () => ({
      status: 'failed' as const,
      models: [],
      discoveredAt: null,
      message: 'Live model discovery failed (endpoint unreachable).',
    }));
    renderWizard({
      definitions: [definition({ supportsDiscovery: true })],
      onDiscoverDraftModels,
    });

    fireEvent.click(screen.getByRole('button', { name: /fetch models/i }));

    expect(await screen.findByText(/Live model discovery failed/)).toBeDefined();
    expect(screen.queryByText('Live Model')).toBeNull();
  });

  it('omits the fetch affordance when the provider publishes no models endpoint', () => {
    renderWizard({
      definitions: [definition({ supportsDiscovery: false })],
      onDiscoverDraftModels: vi.fn(),
    });

    expect(screen.queryByRole('button', { name: /fetch models/i })).toBeNull();
  });

  it('omits the fetch affordance when draft discovery is unavailable', () => {
    renderWizard({ definitions: [definition({ supportsDiscovery: true })] });

    expect(screen.queryByRole('button', { name: /fetch models/i })).toBeNull();
  });

  it('drops preview rows once the draft inputs they were fetched against change', async () => {
    const onDiscoverDraftModels = vi.fn(async () => ({
      status: 'ok' as const,
      models: [{ ...model('live-model', 'Live Model'), source: 'provider' as const }],
      discoveredAt: '2026-08-21T00:00:00.000Z',
      message: 'Fetched 1 model from the live endpoint. Select the ones this connection should enable.',
    }));
    renderWizard({
      definitions: [definition({
        id: 'generic-openai-compatible',
        displayName: 'Generic OpenAI-compatible',
        supportedAuthMethods: ['none'],
        allowsCustomModels: true,
        supportsDiscovery: true,
        models: [],
      })],
      onDiscoverDraftModels,
    });

    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://a.example.com/v1' } });
    fireEvent.click(screen.getByRole('button', { name: /fetch models/i }));
    expect(await screen.findByText('Live Model')).toBeDefined();
    expect(onDiscoverDraftModels).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: 'https://a.example.com/v1',
    }));

    // Retyping the endpoint invalidates rows fetched against the old one.
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://b.example.com/v1' } });
    expect(screen.queryByText('Live Model')).toBeNull();
  });
});

describe('connection wizard model search (#155)', () => {
  it('filters rows by fuzzy query and scopes select-all to visible rows', async () => {
    const models = Array.from({ length: 10 }, (_, index) => model(`orchid-${index}`, `Orchid ${index}`));
    const { props } = renderWizard({
      definitions: [definition({ models })],
    });

    fireEvent.change(screen.getByLabelText('Search models'), { target: { value: 'orchid-3' } });
    expect(screen.getByText('Orchid 3')).toBeDefined();
    expect(screen.queryByText('Orchid 1')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /select all models/i }));
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create connection' }));

    await waitFor(() => expect(props.onCreate).toHaveBeenCalledTimes(1));
    // Only the default selection plus the single visible row are enabled; the
    // nine hidden models are untouched by a filtered select-all.
    expect(props.onCreate).toHaveBeenCalledWith(expect.objectContaining({
      modelIds: ['orchid-0', 'orchid-3'],
    }));
  });

  it('shows an empty state when nothing matches the query', () => {
    renderWizard({
      definitions: [definition({
        models: Array.from({ length: 9 }, (_, index) => model(`orchid-${index}`, `Orchid ${index}`)),
      })],
    });

    fireEvent.change(screen.getByLabelText('Search models'), { target: { value: 'zzz-nothing' } });

    expect(screen.getByText(/no models match/i)).toBeDefined();
    expect(screen.queryByText('Orchid 1')).toBeNull();
  });

  it('omits the search input for short model lists', () => {
    renderWizard();

    expect(screen.queryByLabelText('Search models')).toBeNull();
  });

  it('deselects only visible rows when a filter is active', async () => {
    const models = Array.from({ length: 10 }, (_, index) => model(`orchid-${index}`, `Orchid ${index}`));
    const { props } = renderWizard({
      definitions: [definition({ models })],
    });

    // Select everything unfiltered, then narrow to one row and deselect it:
    // the nine hidden selections must survive.
    fireEvent.click(screen.getByRole('button', { name: /select all models/i }));
    fireEvent.change(screen.getByLabelText('Search models'), { target: { value: 'orchid-3' } });
    fireEvent.click(screen.getByRole('button', { name: /deselect all models/i }));
    fireEvent.change(screen.getByLabelText('Search models'), { target: { value: '' } });

    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create connection' }));

    await waitFor(() => expect(props.onCreate).toHaveBeenCalledTimes(1));
    expect(props.onCreate).toHaveBeenCalledWith(expect.objectContaining({
      modelIds: ['orchid-0', 'orchid-1', 'orchid-2', 'orchid-4', 'orchid-5', 'orchid-6', 'orchid-7', 'orchid-8', 'orchid-9'],
    }));
  });
});
