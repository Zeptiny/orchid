// @vitest-environment jsdom
/** Unified connection model listing: one row set, provenance badges, uniform affordances. */
import type { ComponentProps } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionModelsEditor } from '../../src/renderer/components/Providers/ConnectionModelsDialog';
import type {
  ProviderDefinitionView,
  ProviderModelOption,
} from '../../src/shared/types/ipc';
import type { CustomConnectionModel } from '../../src/shared/types/provider';

function definition(overrides: Partial<ProviderDefinitionView> = {}): ProviderDefinitionView {
  return {
    id: 'neuralwatt',
    displayName: 'Neuralwatt',
    supportedAuthMethods: ['api-key', 'environment'],
    supportedProtocols: ['openai-compatible'],
    allowsCustomModels: true,
    lifecycle: 'active',
    available: true,
    unavailableReason: null,
    supportsDiscovery: true,
    models: [{
      id: 'nw-base',
      displayName: 'NW Base',
      protocol: 'openai-compatible',
      lifecycle: 'active',
      source: 'catalog',
      capabilities: { inputModalities: ['text'], outputModalities: ['text'], tools: true, reasoning: true },
      limits: { contextTokens: 1000, outputTokens: 100 },
    }],
    ...overrides,
  };
}

const CUSTOM_MODEL: CustomConnectionModel = {
  id: 'nw-custom',
  displayName: 'NW Custom',
  protocol: 'openai-compatible',
  capabilities: { inputModalities: ['text'], outputModalities: ['text'], tools: true, reasoning: false },
  limits: { contextTokens: 4096, outputTokens: 512 },
};

function option(
  modelId: string,
  overrides: Partial<ProviderModelOption> & { model?: Partial<ProviderModelOption['model']> } = {},
): ProviderModelOption {
  const { model: modelOverrides, ...rest } = overrides;
  return {
    selection: { connectionId: '11111111-1111-4111-8111-111111111111', modelId },
    connectionName: 'NW account',
    providerId: 'neuralwatt',
    providerDisplayName: 'Neuralwatt',
    model: {
      id: modelId,
      displayName: modelId,
      protocol: 'openai-compatible',
      lifecycle: 'active',
      source: 'catalog',
      capabilities: null,
      limits: null,
      ...modelOverrides,
    },
    enabled: false,
    customized: false,
    discoveredAt: null,
    available: true,
    unavailableReason: null,
    ...rest,
  };
}

function renderEditor(
  overrides: Partial<ComponentProps<typeof ConnectionModelsEditor>> = {},
) {
  const props: ComponentProps<typeof ConnectionModelsEditor> = {
    protocol: 'openai-compatible',
    definition: definition(),
    selectedModelIds: ['nw-base'],
    customModels: [CUSTOM_MODEL],
    reasoningConfig: {},
    onSelectedModelIdsChange: vi.fn(),
    onCustomModelsChange: vi.fn(),
    onReasoningConfigChange: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<ConnectionModelsEditor {...props} />) };
}

afterEach(() => cleanup());

describe('connection models unified listing', () => {
  it('renders catalog, discovered, and custom rows with provenance badges in one list', () => {
    renderEditor({
      unifiedModels: [
        option('nw-base', {
          enabled: true,
          model: { displayName: 'NW Base', source: 'catalog' },
        }),
        option('nw-live', {
          discoveredAt: '2026-08-08T12:00:00.000Z',
          model: { displayName: 'NW Live', source: 'provider' },
        }),
        option('nw-custom', {
          model: { displayName: 'NW Custom', source: 'user' },
        }),
      ],
    });

    expect(screen.getByText('NW Base').closest('li')?.textContent).toContain('Catalog');
    const discoveredRow = screen.getByText('NW Live').closest('li');
    expect(discoveredRow?.textContent).toContain('Discovered');
    expect(discoveredRow?.textContent).not.toContain('Customized');
    expect(screen.getByText('NW Custom').closest('li')?.textContent).toContain('Custom');
    // One unified list, not separate catalog/custom sections.
    expect(screen.getByRole('list')).toBeDefined();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  it('gives every origin the same affordances, with reset/remove matching the layer', () => {
    renderEditor({
      unifiedModels: [
        option('nw-base', {
          enabled: true,
          customized: true,
          discoveredAt: '2026-08-08T12:00:00.000Z',
          model: { displayName: 'NW Base tuned', source: 'provider' },
        }),
        option('nw-live', {
          discoveredAt: '2026-08-08T12:00:00.000Z',
          model: { displayName: 'NW Live', source: 'provider' },
        }),
        option('nw-custom', { model: { displayName: 'NW Custom', source: 'user' } }),
      ],
      customModels: [
        { ...CUSTOM_MODEL, id: 'nw-base', displayName: 'NW Base tuned' },
        CUSTOM_MODEL,
      ],
    });

    for (const name of ['NW Base tuned', 'NW Live', 'NW Custom']) {
      const row = screen.getByText(name).closest('li');
      expect(row, name).not.toBeNull();
      expect(row!.querySelector('input[type="checkbox"]')).not.toBeNull();
      expect(screen.getByRole('button', { name: `Edit ${name}` })).toBeDefined();
    }
    // A user override over a live/catalog layer offers reset; a pure custom row offers remove.
    expect(screen.getByText('NW Base tuned').closest('li')?.textContent).toContain('Customized');
    expect(screen.getByRole('button', { name: 'Reset' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Remove NW Custom' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Remove NW Live' })).toBeNull();
  });

  it('toggles a discovered row through the same enable affordance as any origin', () => {
    const { props } = renderEditor({
      unifiedModels: [
        option('nw-base', { enabled: true, model: { displayName: 'NW Base' } }),
        option('nw-live', {
          discoveredAt: '2026-08-08T12:00:00.000Z',
          model: { displayName: 'NW Live', source: 'provider' },
        }),
      ],
    });

    const row = screen.getByText('NW Live').closest('li')!;
    fireEvent.click(row.querySelector('input[type="checkbox"]')!);
    expect(props.onSelectedModelIdsChange).toHaveBeenCalledWith(['nw-base', 'nw-live']);
  });

  it('runs manual discovery from the listing and surfaces a non-blocking result', async () => {
    const onDiscoverModels = vi.fn(async () => ({
      connection: {} as never,
      status: 'ok' as const,
      discoveredModelCount: 2,
      addedModelIds: ['nw-live'],
      message: 'Discovered 1 new model; 2 provider models are tracked on this connection.',
    }));
    renderEditor({ discoveryAvailable: true, onDiscoverModels });

    fireEvent.click(screen.getByRole('button', { name: /fetch models/i }));

    await waitFor(() => expect(onDiscoverModels).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/discovered 1 new model/i)).toBeDefined();
  });

  it('surfaces discovery failures without disturbing the listed models', async () => {
    const onDiscoverModels = vi.fn(async () => ({
      connection: {} as never,
      status: 'failed' as const,
      discoveredModelCount: 0,
      addedModelIds: [],
      message: 'Live model discovery failed (HTTP 401); catalog and custom models are unchanged.',
    }));
    renderEditor({ discoveryAvailable: true, onDiscoverModels });

    fireEvent.click(screen.getByRole('button', { name: /fetch models/i }));

    expect(await screen.findByText(/catalog and custom models are unchanged/i)).toBeDefined();
    expect(screen.getByText('NW Base')).toBeDefined();
  });

  it('composes rows locally from the catalog and custom drafts when no listing was fetched', () => {
    renderEditor();

    expect(screen.getByText('NW Base').closest('li')?.textContent).toContain('Catalog');
    expect(screen.getByText('NW Custom').closest('li')?.textContent).toContain('Custom');
    expect(screen.queryByRole('button', { name: /fetch models/i })).toBeNull();
  });
});
