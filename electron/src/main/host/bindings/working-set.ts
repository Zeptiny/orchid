/**
 * Working-set + session-activity family bindings — the per-client open-tabs
 * surface (with its per-client broadcast on membership repair) and the
 * activity badge feed.
 */
import { IPC_CHANNELS } from '../../../shared/types/ipc';
import { sessionWorkingSet } from '../../session/working-set';
import {
  filterIfCatalogOk,
  mutateAndPersist,
  tryListSessionCatalog,
  workingSetOpenOrFocus,
  workingSetRemove,
} from '../../session/working-set-live';
import {
  listSessionActivity,
  markSessionActivitySeen,
  reconcileSessionActivity,
} from '../../session/activity-live';
import { getSubagentManager } from '../../tools';
import { getBackgroundStore } from '../../tools/process/background-store';
import type {
  HostBinding,
  HostBindingEntries,
  HostRequestContext,
  HostServerSurface,
} from './types';

export function buildWorkingSetBindings(surface: HostServerSurface): HostBindingEntries {
  const entries: Array<[string, HostBinding<never>]> = [];

  const bind = <P>(method: string, binding: HostBinding<P>): void => {
    entries.push([method, binding as HostBinding<never>]);
  };

  bind('session.working_set_get', (ctx: HostRequestContext) => {
    const { snapshot, membershipChanged } = filterIfCatalogOk(ctx.clientId);
    if (membershipChanged) {
      try {
        sessionWorkingSet.saveToDisk();
      } catch (err) {
        console.error('[working-set] failed to persist ui-state.json', err);
      }
      for (const clientId of surface.listConnections()) {
        const perClient = clientId === ctx.clientId
          ? snapshot
          : sessionWorkingSet.getSnapshot(clientId);
        surface.emitTo(clientId, IPC_CHANNELS.SESSION_WORKING_SET_CHANGED, {
          snapshot: perClient,
        });
      }
    }
    return snapshot;
  });

  bind('session.working_set_open_or_focus', (ctx, params: { id: string }) => {
    const catalog = tryListSessionCatalog();
    if (catalog.status === 'ok' && !catalog.ids.has(params.id)) {
      return sessionWorkingSet.getSnapshot(ctx.clientId);
    }
    return workingSetOpenOrFocus(params.id, ctx.clientId);
  });

  bind('session.working_set_close', (ctx, params: { id: string }) =>
    mutateAndPersist(ctx.clientId, () => sessionWorkingSet.close(params.id, ctx.clientId)));

  bind('session.working_set_remove', (ctx, params: { id: string }) =>
    workingSetRemove(params.id, ctx.clientId));

  bind('session.working_set_set_focus', (ctx, params: { id: string | null }) =>
    mutateAndPersist(ctx.clientId, () => sessionWorkingSet.setFocus(params.id, ctx.clientId)));

  // ── session activity ───────────────────────────────────────────────────────
  bind('session.activity_list', () => {
    const sessionIds = new Set(listSessionActivity().map((activity) => activity.sessionId));
    try {
      for (const record of getSubagentManager().allRecords()) {
        if (record.sessionId) sessionIds.add(record.sessionId);
      }
      for (const process of getBackgroundStore().list()) {
        if (process.sessionId && process.exitCode === null) sessionIds.add(process.sessionId);
      }
    } catch {
      // Activity remains usable before optional runtime services initialize.
    }
    for (const sessionId of sessionIds) {
      reconcileSessionActivity(sessionId);
    }
    return listSessionActivity();
  });

  bind('session.activity_mark_seen', (_ctx, params: { id: string }) =>
    markSessionActivitySeen(params.id));

  return entries;
}
