/**
 * Session family bindings — CRUD, activation (load/open), rename/model
 * changes, workspace binding, and the draft overrides. The load/open
 * activation fan-out is shared through host/session-ops.activateSessionForClient.
 */
import { IPC_CHANNELS } from '../../../shared/types/ipc';
import { sessionForRenderer } from '../../../shared/types/session';
import { lastChainError } from '../../../shared/types/chain';
import { getSessionManager, resolveWindowWorkspace } from '../../session/singleton';
import { setDraftTierOverride } from '../../session/draft-tier';
import { setDraftReasoningOverride, takeDraftReasoningOverride } from '../../session/draft-reasoning';
import { takeDraftPermissionOverride, sessionPermissionOverrides } from '../../permissions/session-overrides';
import { approvalStore } from '../../permissions/approval-store';
import { clearToolCallHistoryForSession } from '../../permissions/history';
import { clearChatHistory } from '../chat/history';
import { clearFunctionHashesForSession } from '../../tools/ast/get-function';
import {
  clearDraftCwd,
  isWorkspaceBound,
  setDraftCwd,
} from '../../project/workspace';
import { getProjectTrustState } from '../../project/trust';
import { getProjectRuntimeRegistry } from '../../project/runtime';
import {
  workingSetClearFocus,
  workingSetOpenOrFocus,
  workingSetRemove,
} from '../../session/working-set-live';
import { clearNextRequestStop } from '../../agents/next-request-stop';
import { removeSessionActivity } from '../../session/activity-live';
import { discardDeletedSessionRuntime } from '../chat/abort';
import { getLiveChatSnapshot } from '../chat/snapshot';
import { sendSessionEvent as pipelineSendSessionEvent } from '../chat/events';
import { HOST_CAPABILITIES } from '../../../shared/host/protocol';
import {
  activateSessionForClient,
  bindProjectDirectory,
  reconcileClientWatcher,
  retargetWorkspaceWatcher,
} from '../session-ops';
import type {
  HostBinding,
  HostBindingEntries,
  HostRequestContext,
  HostServerSurface,
} from './types';

export function buildSessionBindings(surface: HostServerSurface): HostBindingEntries {
  const entries: Array<[string, HostBinding<never>]> = [];

  const bind = <P>(method: string, binding: HostBinding<P>): void => {
    entries.push([method, binding as HostBinding<never>]);
  };

  const emitWorkspaceChanged = (ctx: HostRequestContext, workspace: unknown) => {
    surface.emitTo(ctx.clientId, IPC_CHANNELS.SESSION_WORKSPACE_CHANGED, { workspace });
  };

  bind('session.list', () => getSessionManager().listSaved());

  bind('session.load', (ctx, params: { id: string; activate?: boolean }) => {
    const manager = getSessionManager();
    const { id, activate } = params;
    // Read-only peek (todos / subagents refresh) — do not switch or reseed.
    if (!activate) {
      const session = manager.load(id);
      return session ? sessionForRenderer(session) : null;
    }
    const { session, workspace } = activateSessionForClient(
      ctx.clientId,
      id,
      { clearReleasedDraftCaches: true },
    );
    emitWorkspaceChanged(ctx, workspace);
    return session ? sessionForRenderer(session) : null;
  });

  bind('session.open', (ctx, params: { id: string }) => {
    const { id } = params;
    const { session, messages, workspace } = activateSessionForClient(ctx.clientId, id);
    emitWorkspaceChanged(ctx, workspace);
    const live = getLiveChatSnapshot(id);
    return {
      session: session ? sessionForRenderer(session) : null,
      messages,
      live,
      workspace,
      lastChainError: session && !live ? lastChainError(session.chains) : null,
    };
  });

  bind('session.history_page', (_ctx, params: {
    sessionId: string; chainId: string; beforeIndex?: number;
  }) => getSessionManager().getHistoryPage(params.sessionId, params.chainId, params.beforeIndex));

  bind('session.create', (ctx) => {
    const manager = getSessionManager();
    const workspace = resolveWindowWorkspace(ctx.clientId);
    if (!isWorkspaceBound(workspace) || workspace.cwd == null) {
      throw new Error('Cannot create session: no project folder selected. Choose a folder first.');
    }
    const cwd = workspace.cwd;
    if (getProjectTrustState(cwd) !== 'trusted') {
      throw new Error('Cannot create session: project folder is not trusted. Trust the project first.');
    }
    const config = getProjectRuntimeRegistry().get(cwd).config;
    const created = manager.create(config.default_model, { cwd }, ctx.clientId);
    const draftOverride = takeDraftReasoningOverride(ctx.clientId);
    if (draftOverride !== undefined) {
      manager.setReasoningEffortOverride(created.id, draftOverride);
    }
    const draftPermission = takeDraftPermissionOverride(ctx.clientId);
    if (draftPermission !== undefined) {
      manager.setPermissionMode(created.id, draftPermission);
    }
    const session = manager.getSession(created.id) ?? created;
    // Draft was promoted into the session.
    clearDraftCwd(ctx.clientId);
    clearChatHistory(session.id);
    workingSetOpenOrFocus(session.id, ctx.clientId);
    surface.emitTo(ctx.clientId, IPC_CHANNELS.SESSION_CREATED, { session });
    emitWorkspaceChanged(ctx, resolveWindowWorkspace(ctx.clientId));
    return session;
  });

  bind('session.clear_active', (ctx) => {
    const manager = getSessionManager();
    const selected = manager.getActive(ctx.clientId);
    if (selected?.cwd) setDraftCwd(ctx.clientId, selected.cwd);
    manager.clearActive(ctx.clientId);
    workingSetClearFocus(ctx.clientId);
    const workspace = resolveWindowWorkspace(ctx.clientId);
    emitWorkspaceChanged(ctx, workspace);
    return { status: 'cleared' };
  });

  bind('session.delete', (ctx, params: { id: string }) => {
    const manager = getSessionManager();
    const wasActive = manager.getActive(ctx.clientId)?.id === params.id;
    const deleted = manager.delete(params.id);
    // A deleted background session must not keep spending provider/tool work.
    discardDeletedSessionRuntime(params.id);
    sessionPermissionOverrides.delete(params.id);
    approvalStore.cancelAllForSession(params.id);
    clearToolCallHistoryForSession(params.id);
    // U5 additive fix (parity with the Electron handler this binding replaced):
    // a deleted session must also drop its AST function-hash cache entries.
    clearFunctionHashesForSession(params.id);
    clearNextRequestStop(params.id);
    removeSessionActivity(params.id);
    const workingSet = workingSetRemove(params.id, ctx.clientId);
    clearChatHistory(params.id);
    // Durable-deletion fan-out: every connected client loses its copy, each
    // with its own working-set snapshot.
    for (const clientId of surface.listConnections()) {
      const perClient = clientId === ctx.clientId
        ? workingSet
        : workingSetRemove(params.id, clientId);
      surface.emitTo(clientId, IPC_CHANNELS.SESSION_DELETED, {
        id: params.id,
        workingSet: perClient,
      });
    }
    if (deleted && wasActive) {
      const workspace = resolveWindowWorkspace(ctx.clientId);
      retargetWorkspaceWatcher(ctx.clientId, workspace.cwd);
      emitWorkspaceChanged(ctx, workspace);
    }
    return { status: deleted ? 'deleted' : 'not_found', workingSet };
  });

  bind('session.rename', (ctx, params: { id: string; name: string }) => {
    const manager = getSessionManager();
    const existing = manager.getSession(params.id);
    if (!existing) return { status: 'not_found' };
    if (existing.name === params.name) {
      return { status: 'unchanged', name: existing.name };
    }
    manager.rename(params.id, params.name);
    const after = manager.getSession(params.id);
    if (!after || after.name !== params.name) {
      return { status: 'not_active' };
    }
    pipelineSendSessionEvent(ctx.clientId, params.id, IPC_CHANNELS.SESSION_RENAMED, {
      id: params.id,
      name: params.name,
    });
    return { status: 'renamed' };
  });

  bind('session.change_model', (_ctx, params: {
    id: string;
    selection?: { connectionId: string; modelId: string } | null;
    modelLabel?: string | null;
  }) => {
    const manager = getSessionManager();
    const selection = params.selection ?? null;
    const existing = manager.getSession(params.id);
    if (!existing) return { status: 'not_found' };
    const nextLabel = params.modelLabel ?? selection?.modelId ?? null;
    const sameSelection =
      (existing.selection === null && selection === null) ||
      (existing.selection !== null &&
        selection !== null &&
        existing.selection.connectionId === selection.connectionId &&
        existing.selection.modelId === selection.modelId);
    if (sameSelection && existing.modelLabel === nextLabel) {
      return {
        status: 'unchanged',
        selection: existing.selection,
        modelLabel: existing.modelLabel,
      };
    }
    manager.changeModel(params.id, selection, nextLabel);
    const after = manager.getSession(params.id);
    if (!after) return { status: 'not_found' };
    const afterSame =
      (after.selection === null && selection === null) ||
      (after.selection !== null &&
        selection !== null &&
        after.selection.connectionId === selection.connectionId &&
        after.selection.modelId === selection.modelId);
    if (!afterSame || after.modelLabel !== nextLabel) {
      return { status: 'not_active' };
    }
    return {
      status: 'changed',
      selection: after.selection,
      modelLabel: after.modelLabel,
    };
  });

  bind('session.get_workspace', (ctx) => {
    const workspace = resolveWindowWorkspace(ctx.clientId);
    reconcileClientWatcher(ctx.clientId, workspace);
    return workspace;
  });

  bind('session.pick_project_dir', (_ctx) => {
    surface.requireCapability(HOST_CAPABILITIES.SESSION_PICK_PROJECT_DIR, 'session.pick_project_dir');
    // Capability declared only by an Electron-hosted transport that installs a
    // native dialog (U5); the headless daemon never declares it.
    throw new Error('session.pick_project_dir requires a host-native dialog transport.');
  });

  bind('session.set_workspace', async (ctx, params: { cwd: string }) => {
    const workspace = await bindProjectDirectory(ctx.clientId, params.cwd);
    emitWorkspaceChanged(ctx, workspace);
    return workspace;
  });

  bind('session.change_cwd', async (ctx, params: { id: string; cwd: string }) => {
    const manager = getSessionManager();
    const active = manager.getActive(ctx.clientId);
    if (!active || active.id !== params.id) {
      throw new Error('Cannot change project for a session that is not selected.');
    }
    const hadConversation = active.chains.length > 0;
    const workspace = await bindProjectDirectory(ctx.clientId, params.cwd);
    emitWorkspaceChanged(ctx, workspace);
    return hadConversation ? null : manager.getActive(ctx.clientId);
  });

  bind('session.set_reasoning_effort', (ctx, params: { effort: string | number | null }) => {
    const manager = getSessionManager();
    const active = manager.getActive(ctx.clientId);
    if (!active) {
      setDraftReasoningOverride(ctx.clientId, params.effort);
      return { status: 'ok' };
    }
    manager.setReasoningEffortOverride(active.id, params.effort);
    return { status: 'ok' };
  });

  bind('session.set_service_tier', (ctx, params: { tier: string | null }) => {
    const manager = getSessionManager();
    const active = manager.getActive(ctx.clientId);
    if (!active) {
      setDraftTierOverride(ctx.clientId, params.tier);
      return { status: 'ok' };
    }
    manager.setTierOverride(active.id, params.tier);
    return { status: 'ok' };
  });

  return entries;
}
