/**
 * Provider IPC — connection-centered, intent-only renderer boundary.
 *
 * The renderer may select a catalog preset, name a connection, and submit a
 * one-shot credential. It never receives a credential handle, API key,
 * driver origin, or executable driver configuration.
 *
 * The redacted view builders, readiness/validation, and the read-side
 * connection mutations live in `providers/views.ts` (electron-free, shared
 * with the headless host). This module keeps the Electron-only surface:
 * handler registration plus the vault-write intents (create/update/
 * submit_api_key) that are deliberately not host-routed in v1.
 */
import { ipcMain } from 'electron';
import { z } from 'zod';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import type { ProviderConnection } from '../../shared/types/provider';
import type { ProviderMutationResult } from '../../shared/types/ipc';
import { hostRequest } from './host-request';
import { createEnvironmentCredentialReference } from '../providers/credentials/vault';
import {
  automaticDiscoveryMessage,
  clearConnectionConfigReferences,
  connectionIdSchema,
  connectionView,
  credentialBinding,
  discoveryCredential,
  disconnectSchema,
  dropRecordKeys,
  genericOrigin,
  modelView,
  pricingView,
  readApiKeyForTrustedStatus,
  refreshStatus,
  requireConnection,
  requireStaticConnectionSupport,
  runConnectionDiscovery,
  sameCredentialIdentity,
  services,
  statusRefreshSchema,
  statusView,
  terminalHealthMessage,
  validateConnection,
  withConnectionMutationLock,
  withDiscoveryOutcome,
  _clearConnectionMutationLocksForTests,
  _setProviderIPCServicesForTests,
  customConnectionModelSchema,
  environmentVariableSchema,
  idSchema,
  pricingRateFieldsSchema,
  providerAuthMethodSchema,
  providerEndpointSchema,
  providerProtocolSchema,
  reasoningModelConfigSchema,
  type ProviderIPCServices,
} from '../providers/views';

// Re-export the relocated core so existing IPC consumers (provider-models.ts,
// the provider end-to-end suite) keep their import surface.
export {
  automaticDiscoveryMessage,
  clearConnectionConfigReferences,
  connectionIdSchema,
  connectionView,
  credentialBinding,
  discoveryCredential,
  dropRecordKeys,
  modelView,
  pricingView,
  readApiKeyForTrustedStatus,
  refreshStatus,
  requireConnection,
  requireStaticConnectionSupport,
  runConnectionDiscovery,
  services,
  statusView,
  terminalHealthMessage,
  withConnectionMutationLock,
  withDiscoveryOutcome,
  _clearConnectionMutationLocksForTests,
  _setProviderIPCServicesForTests,
  type ProviderIPCServices,
};

// ── Renderer input schemas (vault-write intents; never host-routed) ─────────

const modelIdsSchema = z.array(z.string().trim().min(1)).max(500).default([]);
const tierSelectionsSchema = z.record(z.string().trim().min(1), z.string().trim().min(1).max(128));
const cacheTtlSchema = z.string().trim().min(1).max(24).nullable();

const createConnectionSchema = z.object({
  providerId: z.string().trim().min(1),
  name: z.string().trim().min(1).max(120),
  protocol: providerProtocolSchema,
  authMethod: providerAuthMethodSchema,
  modelIds: modelIdsSchema,
  customModels: z.array(customConnectionModelSchema).max(500).optional(),
  reasoningConfig: z.record(z.string(), reasoningModelConfigSchema).optional(),
  pricingOverrides: z.record(z.string(), pricingRateFieldsSchema).optional(),
  tierSelections: tierSelectionsSchema.optional(),
  cacheTtl: cacheTtlSchema.optional(),
  endpoint: providerEndpointSchema.nullable().optional(),
  allowInsecureHttp: z.boolean().optional(),
  environmentVariable: environmentVariableSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.authMethod === 'environment' && !value.environmentVariable) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['environmentVariable'],
      message: 'Environment authentication requires an environment variable name',
    });
  }
  if (value.authMethod !== 'environment' && value.environmentVariable !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['environmentVariable'],
      message: 'An environment variable is valid only for environment authentication',
    });
  }
});

const updateConnectionSchema = z.object({
  connectionId: idSchema,
  name: z.string().trim().min(1).max(120).optional(),
  authMethod: providerAuthMethodSchema.optional(),
  modelIds: modelIdsSchema.optional(),
  customModels: z.array(customConnectionModelSchema).max(500).optional(),
  reasoningConfig: z.record(z.string(), reasoningModelConfigSchema).optional(),
  pricingOverrides: z.record(z.string(), pricingRateFieldsSchema).optional(),
  tierSelections: tierSelectionsSchema.optional(),
  cacheTtl: cacheTtlSchema.nullable().optional(),
  endpoint: providerEndpointSchema.nullable().optional(),
  allowInsecureHttp: z.boolean().optional(),
  environmentVariable: environmentVariableSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.authMethod === 'environment' && !value.environmentVariable) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['environmentVariable'],
      message: 'Environment authentication requires an environment variable name',
    });
  }
  if (value.authMethod !== undefined
    && value.authMethod !== 'environment'
    && value.environmentVariable !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['environmentVariable'],
      message: 'An environment variable is valid only for environment authentication',
    });
  }
}).refine((value) => Object.keys(value).some((key) => key !== 'connectionId'), {
  message: 'Provide at least one connection field to update',
});

const submitApiKeySchema = z.object({
  connectionId: idSchema,
  apiKey: z.string().trim().min(1).max(32_768),
}).strict();

// ── Registration ────────────────────────────────────────────────────────────

export function registerProviderIPC(): void {
  ipcMain.handle(IPC_CHANNELS.PROVIDERS_LIST, async (event) => {
    return hostRequest(String(event.sender.id), IPC_CHANNELS.PROVIDERS_LIST);
  });

  ipcMain.handle(IPC_CHANNELS.PROVIDERS_CREATE, async (_event, payload: unknown) => {
    const parsed = createConnectionSchema.safeParse(payload);
    if (!parsed.success) throw new Error('Invalid providers:create payload');
    const current = services();
    const credential = parsed.data.authMethod === 'environment'
      ? createEnvironmentCredentialReference(parsed.data.environmentVariable!)
      : { kind: 'none' as const };
    const draftConnection = {
      id: '00000000-0000-4000-8000-000000000001',
      providerId: parsed.data.providerId,
      name: parsed.data.name,
      protocol: parsed.data.protocol,
      authMethod: parsed.data.authMethod,
      credential,
      modelIds: parsed.data.modelIds,
      ...(parsed.data.customModels ? { customModels: parsed.data.customModels } : {}),
      ...(parsed.data.reasoningConfig ? { reasoningConfig: parsed.data.reasoningConfig } : {}),
      ...(parsed.data.pricingOverrides ? { pricingOverrides: parsed.data.pricingOverrides } : {}),
      ...(parsed.data.tierSelections ? { tierSelections: parsed.data.tierSelections } : {}),
      ...(parsed.data.cacheTtl != null ? { cacheTtl: parsed.data.cacheTtl } : {}),
      ...(parsed.data.endpoint !== undefined ? { endpoint: parsed.data.endpoint } : {}),
      ...(parsed.data.allowInsecureHttp !== undefined
        ? { allowInsecureHttp: parsed.data.allowInsecureHttp }
        : {}),
      health: parsed.data.authMethod === 'none' ? 'ready' : 'draft',
    } satisfies ProviderConnection;
    // Reject malformed, disabled, or unsupported connections before anything
    // is persisted. This is also the boundary that prevents renderer data from
    // selecting a driver/origin outside trusted code.
    requireStaticConnectionSupport(draftConnection, current);
    const { id: _draftId, ...createInput } = draftConnection;
    const catalogModels = current.catalog.load().catalog.providers
      .find((provider) => provider.id === parsed.data.providerId)
      ?.models;
    const connection = await current.connections.create(createInput, catalogModels);
    return withConnectionMutationLock(connection.id, async () => {
      const result = await validateConnection(connection.id);
      if (result.connection.health !== 'ready') return result;
      return withDiscoveryOutcome(connection.id, result, current);
    });
  });

  ipcMain.handle(IPC_CHANNELS.PROVIDERS_UPDATE, async (_event, payload: unknown) => {
    const parsed = updateConnectionSchema.safeParse(payload);
    if (!parsed.success) throw new Error('Invalid providers:update payload');
    return withConnectionMutationLock(parsed.data.connectionId, async () => {
      const current = services();
      const existing = await requireConnection(parsed.data.connectionId);
      const nextAuthMethod = parsed.data.authMethod ?? existing.authMethod;
      const authMethodChanged = nextAuthMethod !== existing.authMethod;
      const patch = {
        ...(parsed.data.name === undefined ? {} : { name: parsed.data.name }),
        ...(parsed.data.authMethod === undefined ? {} : { authMethod: parsed.data.authMethod }),
        ...(parsed.data.modelIds === undefined ? {} : { modelIds: parsed.data.modelIds }),
        ...(parsed.data.customModels === undefined ? {} : { customModels: parsed.data.customModels }),
        ...(parsed.data.reasoningConfig === undefined ? {} : { reasoningConfig: parsed.data.reasoningConfig }),
        ...(parsed.data.pricingOverrides === undefined
          ? {}
          : { pricingOverrides: parsed.data.pricingOverrides }),
        ...(parsed.data.tierSelections === undefined ? {} : { tierSelections: parsed.data.tierSelections }),
        ...(parsed.data.cacheTtl === undefined
          ? {}
          : parsed.data.cacheTtl === null
            ? { cacheTtl: undefined }
            : { cacheTtl: parsed.data.cacheTtl }),
        ...(parsed.data.endpoint === undefined ? {} : { endpoint: parsed.data.endpoint }),
        ...(parsed.data.allowInsecureHttp === undefined
          ? {}
          : { allowInsecureHttp: parsed.data.allowInsecureHttp }),
      };
      if (parsed.data.environmentVariable !== undefined) {
        if (nextAuthMethod !== 'environment') {
          throw new Error('Only environment-authenticated connections can change an environment reference');
        }
        Object.assign(patch, {
          credential: createEnvironmentCredentialReference(parsed.data.environmentVariable),
          health: 'draft' as const,
        });
      } else if (authMethodChanged) {
        Object.assign(patch, {
          credential: { kind: 'none' as const },
          health: nextAuthMethod === 'none' ? 'ready' as const : 'draft' as const,
        });
      }
      const candidate = { ...existing, ...patch } as ProviderConnection;
      requireStaticConnectionSupport(candidate, current);

      // Generic credentials are destination-bound. An origin change must erase
      // a stored secret or require the renderer to explicitly reconfirm the
      // environment reference in the same intent before the endpoint is usable.
      const endpointChanged = parsed.data.endpoint !== undefined
        && genericOrigin(existing, current) !== genericOrigin(candidate, current);
      if (existing.credential.kind === 'stored' && (authMethodChanged || endpointChanged)) {
        await current.vault.deleteConnectionCredentials(existing.id);
      }
      if (endpointChanged && nextAuthMethod === 'api-key') {
        Object.assign(patch, { credential: { kind: 'none' as const }, health: 'draft' });
      } else if (
        endpointChanged
        && nextAuthMethod === 'environment'
        && parsed.data.environmentVariable === undefined
      ) {
        Object.assign(patch, { credential: { kind: 'none' as const }, health: 'draft' });
      }
      const updated = await current.connections.update(existing.id, patch);
      if (!sameCredentialIdentity(existing, updated)) {
        current.status.invalidate(existing.providerId, existing.id);
        current.pricing?.invalidate(existing.providerId, existing.id);
      }
      return validateConnection(existing.id);
    });
  });

  ipcMain.handle(IPC_CHANNELS.PROVIDERS_SUBMIT_API_KEY, async (_event, payload: unknown) => {
    const parsed = submitApiKeySchema.safeParse(payload);
    if (!parsed.success) throw new Error('Invalid providers:submit_api_key payload');
    return withConnectionMutationLock(parsed.data.connectionId, async () => {
      const current = services();
      const connection = await requireConnection(parsed.data.connectionId);
      if (connection.health === 'disabled') {
        throw new Error(
          `Connection '${connection.name}' is disabled. Enable it before submitting a credential.`,
        );
      }
      // disconnected is allowed: submit is the re-auth path after disconnect.
      if (connection.authMethod !== 'api-key') {
        throw new Error(`Connection '${connection.name}' does not accept an API key`);
      }
      requireStaticConnectionSupport(connection, current);
      const handle = await current.vault.replaceConnectionApiKey(
        credentialBinding(connection, current),
        parsed.data.apiKey,
      );
      const updated = await current.connections.update(connection.id, {
        credential: { kind: 'stored', handle },
        health: 'draft',
      });
      if (!sameCredentialIdentity(connection, updated)) {
        current.status.invalidate(connection.providerId, connection.id);
        current.pricing?.invalidate(connection.providerId, connection.id);
      }
      // CAS cleanup: if health became disconnected after the connection write
      // (should not happen under this lock, but re-check and erase the key).
      const afterWrite = await requireConnection(connection.id);
      if (afterWrite.health === 'disconnected') {
        await current.vault.deleteConnectionCredentials(connection.id);
        return {
          connection: connectionView(afterWrite, current.catalog.getProviderDefinitions()),
          message: terminalHealthMessage('disconnected'),
        } satisfies ProviderMutationResult;
      }
      const result = await validateConnection(connection.id);
      // Run discovery once, the first time a credential validates (R26).
      const latest = await requireConnection(connection.id);
      if (result.connection.health === 'ready' && latest.discoveredModels === undefined) {
        return withDiscoveryOutcome(connection.id, result, current);
      }
      return result;
    });
  });

  ipcMain.handle(IPC_CHANNELS.PROVIDERS_VALIDATE, async (_event, payload: unknown) => {
    const parsed = connectionIdSchema.safeParse(payload);
    if (!parsed.success) throw new Error('Invalid providers:validate payload');
    return hostRequest(
      String(_event.sender.id),
      IPC_CHANNELS.PROVIDERS_VALIDATE,
      parsed.data,
    );
  });

  ipcMain.handle(IPC_CHANNELS.PROVIDERS_DISABLE, async (_event, payload: unknown) => {
    const parsed = connectionIdSchema.safeParse(payload);
    if (!parsed.success) throw new Error('Invalid providers:disable payload');
    return hostRequest(
      String(_event.sender.id),
      IPC_CHANNELS.PROVIDERS_DISABLE,
      parsed.data,
    );
  });

  ipcMain.handle(IPC_CHANNELS.PROVIDERS_ENABLE, async (_event, payload: unknown) => {
    const parsed = connectionIdSchema.safeParse(payload);
    if (!parsed.success) throw new Error('Invalid providers:enable payload');
    return hostRequest(
      String(_event.sender.id),
      IPC_CHANNELS.PROVIDERS_ENABLE,
      parsed.data,
    );
  });

  ipcMain.handle(IPC_CHANNELS.PROVIDERS_DISCONNECT, async (_event, payload: unknown) => {
    const parsed = disconnectSchema.safeParse(payload);
    if (!parsed.success) throw new Error('Invalid providers:disconnect payload');
    return hostRequest(
      String(_event.sender.id),
      IPC_CHANNELS.PROVIDERS_DISCONNECT,
      parsed.data,
    );
  });

  ipcMain.handle(IPC_CHANNELS.PROVIDERS_DELETE, async (_event, payload: unknown) => {
    const parsed = disconnectSchema.safeParse(payload);
    if (!parsed.success) throw new Error('Invalid providers:delete payload');
    return hostRequest(
      String(_event.sender.id),
      IPC_CHANNELS.PROVIDERS_DELETE,
      parsed.data,
    );
  });

  ipcMain.handle(IPC_CHANNELS.PROVIDERS_STATUS_REFRESH, async (event, payload: unknown) => {
    const parsed = statusRefreshSchema.safeParse(payload);
    if (!parsed.success) throw new Error('Invalid providers:status_refresh payload');
    return hostRequest(String(event.sender.id), IPC_CHANNELS.PROVIDERS_STATUS_REFRESH, parsed.data);
  });
}

export function unregisterProviderIPC(): void {
  ipcMain.removeHandler(IPC_CHANNELS.PROVIDERS_LIST);
  ipcMain.removeHandler(IPC_CHANNELS.PROVIDERS_CREATE);
  ipcMain.removeHandler(IPC_CHANNELS.PROVIDERS_UPDATE);
  ipcMain.removeHandler(IPC_CHANNELS.PROVIDERS_SUBMIT_API_KEY);
  ipcMain.removeHandler(IPC_CHANNELS.PROVIDERS_VALIDATE);
  ipcMain.removeHandler(IPC_CHANNELS.PROVIDERS_DISABLE);
  ipcMain.removeHandler(IPC_CHANNELS.PROVIDERS_ENABLE);
  ipcMain.removeHandler(IPC_CHANNELS.PROVIDERS_DISCONNECT);
  ipcMain.removeHandler(IPC_CHANNELS.PROVIDERS_DELETE);
  ipcMain.removeHandler(IPC_CHANNELS.PROVIDERS_STATUS_REFRESH);
}
