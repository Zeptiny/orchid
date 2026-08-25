/**
 * Provider IPC — connection-centered, intent-only renderer boundary.
 *
 * The renderer may select a catalog preset, name a connection, and submit a
 * one-shot credential. It never receives a credential handle, API key,
 * driver origin, or executable driver configuration.
 *
 * The mutation/view cores live in `providers/views.ts` (electron-free) and
 * every providers:* channel registered here is host-routed: a window's
 * create/update/submit intents land on the machine that window drives. The
 * secret-carrying submit_api_key (and api-key-auth create/update intents)
 * are answered by the driven host's `providers.vault-writes` capability —
 * the headless daemon rejects them with a typed error steering toward
 * environment references. (Draft live discovery, registered in
 * provider-models.ts, stays local: it resolves a credential against this
 * machine before any connection exists.)
 */
import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import { hostRequest } from './host-request';
import {
  connectionIdSchema,
  disconnectSchema,
  statusRefreshSchema,
} from '../providers/views';
import {
  providerCreateConnectionRequestSchema,
  providerSubmitApiKeyRequestSchema,
  providerUpdateConnectionRequestSchema,
} from '../../shared/types/ipc-schemas';

// ── Registration ────────────────────────────────────────────────────────────

export function registerProviderIPC(): void {
  ipcMain.handle(IPC_CHANNELS.PROVIDERS_LIST, async (event) => {
    return hostRequest(String(event.sender.id), IPC_CHANNELS.PROVIDERS_LIST);
  });

  ipcMain.handle(IPC_CHANNELS.PROVIDERS_CREATE, async (event, payload: unknown) => {
    const parsed = providerCreateConnectionRequestSchema.safeParse(payload);
    if (!parsed.success) throw new Error('Invalid providers:create payload');
    return hostRequest(String(event.sender.id), IPC_CHANNELS.PROVIDERS_CREATE, parsed.data);
  });

  ipcMain.handle(IPC_CHANNELS.PROVIDERS_UPDATE, async (event, payload: unknown) => {
    const parsed = providerUpdateConnectionRequestSchema.safeParse(payload);
    if (!parsed.success) throw new Error('Invalid providers:update payload');
    return hostRequest(String(event.sender.id), IPC_CHANNELS.PROVIDERS_UPDATE, parsed.data);
  });

  ipcMain.handle(IPC_CHANNELS.PROVIDERS_SUBMIT_API_KEY, async (event, payload: unknown) => {
    const parsed = providerSubmitApiKeyRequestSchema.safeParse(payload);
    if (!parsed.success) throw new Error('Invalid providers:submit_api_key payload');
    return hostRequest(String(event.sender.id), IPC_CHANNELS.PROVIDERS_SUBMIT_API_KEY, parsed.data);
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
