/**
 * Provider model-list IPC — unified listing, live discovery, and quota views.
 *
 * Connection CRUD and status refresh live in providers.ts; the shared
 * implementation for the unified per-connection model listing (catalog +
 * discovered + custom rows with tier/cache TTL view data), manual
 * live-discovery, and typed quota refresh lives in `providers/views.ts`
 * (electron-free, shared with the headless host). This module owns only the
 * Electron handler registration plus draft discovery (local-only: it resolves
 * a possibly-secret credential against this machine's drivers before any
 * connection exists, so it never routes to a driven remote host).
 */
import { ipcMain } from 'electron';
import { z } from 'zod';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import { HOST_ERROR_CODES, HostProtocolError } from '../../shared/host/protocol';
import { MACHINE_ID_LOCAL } from '../../shared/types/machine';
import { activeMachineFor } from '../host/routing';
import { hostRequest } from './host-request';
import type { ProviderDraftDiscoveryResult } from '../../shared/types/ipc';
import type { ProviderConnection } from '../../shared/types/provider';
import {
  providerConnectionIdRequestSchema,
  providerModelListRequestSchema,
  refineEnvironmentAuth,
} from '../../shared/types/ipc-schemas';
import {
  providerAuthMethodSchema,
  providerEndpointSchema,
  providerProtocolSchema,
  environmentVariableSchema,
} from '../../shared/types/provider';
import {
  discoverConnectionModels,
  type ConnectionDiscoveryOutcome,
} from '../providers/facets/discovery';
import type { DriverCredential } from '../providers/drivers/types';
import {
  modelView,
  requireStaticConnectionSupport,
  services,
} from '../providers/views';

const draftDiscoverySchema = z.object({
  providerId: z.string().trim().min(1),
  protocol: providerProtocolSchema,
  authMethod: providerAuthMethodSchema,
  endpoint: providerEndpointSchema.nullable().optional(),
  allowInsecureHttp: z.boolean().optional(),
  environmentVariable: environmentVariableSchema.optional(),
  // The value exists only for this validated IPC request. Do not log this
  // schema error or payload because it may include a usable credential.
  apiKey: z.string().trim().min(1).max(32_768).optional(),
}).strict().superRefine((value, ctx) => refineEnvironmentAuth(value, ctx));

/** Non-persisted live discovery for a connection that does not exist yet (#138). */
async function discoverDraftModels(
  input: z.infer<typeof draftDiscoverySchema>,
  current = services(),
): Promise<ProviderDraftDiscoveryResult> {
  const empty: ProviderDraftDiscoveryResult = {
    status: 'unsupported',
    models: [],
    discoveredAt: null,
    message: null,
  };
  const draftConnection = {
    id: '00000000-0000-4000-8000-000000000002',
    providerId: input.providerId,
    name: 'Draft discovery',
    protocol: input.protocol,
    authMethod: input.authMethod,
    credential: input.authMethod === 'environment'
      ? { kind: 'environment' as const, variable: input.environmentVariable! }
      : { kind: 'none' as const },
    modelIds: [],
    health: 'draft' as const,
    ...(input.endpoint ? { endpoint: input.endpoint } : {}),
    ...(input.allowInsecureHttp !== undefined ? { allowInsecureHttp: input.allowInsecureHttp } : {}),
  } satisfies ProviderConnection;
  // Same trust boundary as creation: provider, protocol, auth, and endpoint are
  // validated before any driver code runs. Nothing is persisted afterwards.
  const check = requireStaticConnectionSupport(draftConnection, current);
  const credential: DriverCredential | undefined =
    input.authMethod === 'api-key'
      ? input.apiKey ? { kind: 'api-key', apiKey: input.apiKey } : undefined
      : input.authMethod === 'environment'
        ? process.env[input.environmentVariable!]
          ? { kind: 'api-key', apiKey: process.env[input.environmentVariable!]! }
          : undefined
        : { kind: 'none' };
  const outcome = await discoverConnectionModels({
    driver: current.registry.require(check.definition.id),
    connection: draftConnection,
    provider: check.definition,
    credential,
  });
  if (outcome.status !== 'ok') {
    return { ...empty, status: outcome.status, message: draftDiscoveryMessage(outcome) };
  }
  return {
    status: 'ok',
    models: outcome.discoveredModels.map((model) => modelView({
      id: model.id,
      displayName: model.displayName ?? model.id,
      protocol: model.protocol ?? draftConnection.protocol,
      ...(model.capabilities ? { capabilities: model.capabilities } : {}),
      ...(model.limits ? { limits: model.limits } : {}),
    }, 'provider')),
    discoveredAt: outcome.discoveredModels[0]?.discoveredAt ?? null,
    message: draftDiscoveryMessage(outcome),
  };
}

function draftDiscoveryMessage(outcome: ConnectionDiscoveryOutcome): string {
  switch (outcome.status) {
    case 'ok':
      return `Fetched ${outcome.discoveredModels.length} model${outcome.discoveredModels.length === 1 ? '' : 's'} from the live endpoint. Select the ones this connection should enable.`;
    case 'failed':
      return `Live model discovery failed (${outcome.message}).`;
    case 'no-credential':
      return 'Enter a working credential before fetching models.';
    case 'unsupported':
      return 'This provider does not publish a models endpoint Orchid can read.';
  }
}

// ── Registration ────────────────────────────────────────────────────────────

/**
 * Draft discovery (providers:discover_draft_models) is a credential-carrying
 * local-only intent: the key/env value it validates resolves against THIS
 * machine's drivers before any connection exists, so a window driving a
 * remote machine must never run it here. Connection create/update/submit are
 * host-routed instead — they land on the driven machine's own store.
 */
function assertLocalMachineForDraftDiscovery(windowId: string): void {
  if (activeMachineFor(windowId) !== MACHINE_ID_LOCAL) {
    throw new HostProtocolError(
      HOST_ERROR_CODES.UNSUPPORTED_ON_HOST,
      'providers:discover_draft_models runs only while this window drives the local machine — ' +
        'it resolves a credential against this machine before any connection exists. ' +
        'Switch back to the local machine to preview a draft connection, or create the ' +
        'connection on the remote machine first and use its live discovery.',
    );
  }
}

export function registerProviderModelsIPC(): void {
  ipcMain.handle(IPC_CHANNELS.PROVIDERS_MODEL_LIST, async (event, payload: unknown) => {
    if (payload === undefined) {
      // List every enabled option across connections (no connection selected).
      return hostRequest(String(event.sender.id), IPC_CHANNELS.PROVIDERS_MODEL_LIST);
    }
    const parsed = providerModelListRequestSchema.safeParse(payload);
    if (!parsed.success) throw new Error('Invalid providers:model_list payload');
    return hostRequest(
      String(event.sender.id),
      IPC_CHANNELS.PROVIDERS_MODEL_LIST,
      parsed.data,
    );
  });

  ipcMain.handle(IPC_CHANNELS.PROVIDERS_DISCOVER_MODELS, async (_event, payload: unknown) => {
    const parsed = providerConnectionIdRequestSchema.safeParse(payload);
    if (!parsed.success) throw new Error('Invalid providers:discover_models payload');
    return hostRequest(
      String(_event.sender.id),
      IPC_CHANNELS.PROVIDERS_DISCOVER_MODELS,
      parsed.data,
    );
  });

  ipcMain.handle(IPC_CHANNELS.PROVIDERS_DISCOVER_DRAFT_MODELS, async (_event, payload: unknown) => {
    const parsed = draftDiscoverySchema.safeParse(payload);
    if (!parsed.success) throw new Error('Invalid providers:discover_draft_models payload');
    // Draft discovery is a credential-carrying local-only intent: the
    // credential it validates and any connection it previews must never be
    // resolved against this machine's drivers/store from a remote-active window.
    assertLocalMachineForDraftDiscovery(String(_event.sender.id));
    return discoverDraftModels(parsed.data);
  });

  ipcMain.handle(IPC_CHANNELS.PROVIDERS_QUOTA_REFRESH, async (_event, payload: unknown) => {
    const parsed = providerConnectionIdRequestSchema.safeParse(payload);
    if (!parsed.success) throw new Error('Invalid providers:quota_refresh payload');
    return hostRequest(
      String(_event.sender.id),
      IPC_CHANNELS.PROVIDERS_QUOTA_REFRESH,
      parsed.data,
    );
  });
}

export function unregisterProviderModelsIPC(): void {
  ipcMain.removeHandler(IPC_CHANNELS.PROVIDERS_MODEL_LIST);
  ipcMain.removeHandler(IPC_CHANNELS.PROVIDERS_DISCOVER_MODELS);
  ipcMain.removeHandler(IPC_CHANNELS.PROVIDERS_DISCOVER_DRAFT_MODELS);
  ipcMain.removeHandler(IPC_CHANNELS.PROVIDERS_QUOTA_REFRESH);
}
