/**
 * Session family bindings — CRUD, activation (load/open), rename/model
 * changes, workspace binding, the draft overrides, and the reasoning/tier
 * picker config reads (fix #4: reads resolve the same stores the paired
 * setters write, so a remote window's pickers describe the machine that will
 * actually run the turn). The load/open activation fan-out is shared through
 * host/session-ops.activateSessionForClient.
 */
import { IPC_CHANNELS } from '../../../shared/types/ipc';
import type { ModelSelection } from '../../../shared/types/provider';
import { sessionForRenderer } from '../../../shared/types/session';
import { lastChainError } from '../../../shared/types/chain';
import { getSessionManager, resolveWindowWorkspace } from '../../session/singleton';
import { getConfig } from '../../config/loader';
import { setDraftTierOverride, getDraftTierOverride } from '../../session/draft-tier';
import {
  setDraftReasoningOverride,
  getDraftReasoningOverride,
  takeDraftReasoningOverride,
} from '../../session/draft-reasoning';
import { takeDraftPermissionOverride, sessionPermissionOverrides } from '../../permissions/session-overrides';
import { approvalStore } from '../../permissions/approval-store';
import { clearToolCallHistoryForSession } from '../../permissions/history';
import { clearChatHistory } from '../chat/history';
import { trimMessagesForFrame } from '../chat/snapshot-trim';
import { clearFunctionHashesForSession } from '../../tools/ast/get-function';
import {
  clearDraftCwd,
  isWorkspaceBound,
  setDraftCwd,
} from '../../project/workspace';
import { getProjectTrustState } from '../../project/trust';
import { getProjectRuntimeRegistry } from '../../project/runtime';
import {
  getProviderCatalogStore,
  getProviderConnectionStore,
  getProviderDriverRegistry,
} from '../../providers/runtime-context';
import { resolveModelSelection } from '../../providers/resolver';
import { listConnectionModelRows } from '../../providers/facets/discovery';
import { groupTierVariantRows } from '../../providers/facets/tiers';
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

/**
 * Model selection to reason about in draft mode (no active session):
 * bound project default_model → user default_model → null.
 */
function resolveDraftModelSelection(clientId: string): ModelSelection | null {
  try {
    const info = resolveWindowWorkspace(clientId);
    if (info.cwd) {
      const projectDefault = getProjectRuntimeRegistry().get(info.cwd).config.default_model;
      if (projectDefault) return projectDefault;
    }
  } catch {
    // Workspace/runtime unresolvable — fall through to the user default.
  }
  return getConfig().default_model ?? null;
}

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
    const { session, messages: rawMessages, workspace } = activateSessionForClient(ctx.clientId, id);
    emitWorkspaceChanged(ctx, workspace);
    const live = getLiveChatSnapshot(id);
    // Keep the one-frame result under the wire frame cap (review #25) —
    // chat.snapshot's trim path; the continuation cursor satisfies
    // session.history_page so the renderer can page in older history.
    const { messages, trim } = session
      ? trimMessagesForFrame(rawMessages, session.chains)
      : { messages: rawMessages, trim: null };
    return {
      session: session ? sessionForRenderer(session) : null,
      messages,
      trim,
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

  bind('session.get_reasoning_config', async (ctx, params: {
    selection?: ModelSelection | null;
  } | undefined) => {
    const draftSelection = params?.selection ?? null;
    const manager = getSessionManager();
    const active = manager.getActive(ctx.clientId);
    // Draft mode: prefer the renderer's current picker selection so switching
    // models in a draft (no session yet) immediately updates reasoning options.
    // Falls back to the project/default model for backward compat when no
    // selection is supplied.
    const selection = active?.selection ?? draftSelection ?? resolveDraftModelSelection(ctx.clientId);
    const override = active
      ? active.reasoningEffortOverride
      : getDraftReasoningOverride(ctx.clientId);

    if (!selection) {
      return { levels: [], default: null, override, supportsReasoning: false };
    }

    const connections = await getProviderConnectionStore().list();
    const definitions = getProviderCatalogStore().getProviderDefinitions();
    const resolution = resolveModelSelection(selection, connections, definitions);

    if (resolution.kind !== 'resolved') {
      return { levels: [], default: null, override, supportsReasoning: false };
    }

    const { connection, model } = resolution;
    const supportsReasoning = model.capabilities?.reasoning ?? false;
    const modelConfig = connection.reasoningConfig?.[selection.modelId];

    return {
      levels: modelConfig?.levels ?? [],
      default: modelConfig?.default ?? null,
      override,
      supportsReasoning,
    };
  });

  bind('session.get_service_tier_config', async (ctx, params: {
    selection?: ModelSelection | null;
  } | undefined) => {
    const draftSelection = params?.selection ?? null;
    const empty = { mechanism: null, tiers: [], selected: null, override: null, effective: null };
    const manager = getSessionManager();
    const active = manager.getActive(ctx.clientId);
    const selection = active?.selection ?? draftSelection ?? resolveDraftModelSelection(ctx.clientId);
    const override = active ? active.tierOverride : getDraftTierOverride(ctx.clientId);

    if (!selection) return { ...empty, override };

    const connections = await getProviderConnectionStore().list();
    const definitions = getProviderCatalogStore().getProviderDefinitions();
    const resolution = resolveModelSelection(selection, connections, definitions);
    if (resolution.kind !== 'resolved') return { ...empty, override };

    const driver = getProviderDriverRegistry().get(resolution.provider.id);
    const mechanism = driver?.tierMechanism;
    if (!mechanism) return { ...empty, override };

    const selected = resolution.connection.tierSelections?.[selection.modelId] ?? null;
    // Variant-mechanism tiers are offered only when the variant model id is
    // actually present for the active model; selecting an absent variant would
    // rewrite the request to a model id the provider does not serve (R20).
    const variantTierIds = mechanism.kind === 'model-name-variants'
      ? groupTierVariantRows(
          listConnectionModelRows(resolution.connection, resolution.provider),
          mechanism,
        ).variantTiersByBase.get(resolution.model.id)
      : undefined;
    if (mechanism.kind === 'model-name-variants' && variantTierIds === undefined) {
      return { ...empty, override };
    }
    const tiers = mechanism.tiers
      .filter((tier) => variantTierIds === undefined || variantTierIds.includes(tier.id))
      .map((tier) => {
        const requiresStreaming = mechanism.kind === 'model-name-variants'
          && (tier as { requiresStreaming?: boolean }).requiresStreaming === true;
        return {
          id: tier.id,
          displayName: tier.displayName ?? null,
          description: tier.description ?? null,
          ...(requiresStreaming ? { requiresStreaming: true } : {}),
        };
      });
    const effective = override ?? selected ?? null;
    return {
      mechanism: mechanism.kind,
      tiers,
      selected,
      override,
      effective,
    };
  });

  return entries;
}
