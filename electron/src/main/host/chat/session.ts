import type { ModelSelection } from '../../../shared/types/provider';
import type { Session } from '../../../shared/types/session';
import type { ChatSendResult } from '../../../shared/types/ipc';
import { IPC_CHANNELS } from '../../../shared/types/ipc';
import { getSessionManager, resolveWindowWorkspace } from '../../session/singleton';
import { inspectProjectDirectory } from '../../project/path';
import { getProjectTrustState } from '../../project/trust';
import { takeDraftReasoningOverride } from '../../session/draft-reasoning';
import { takeDraftTierOverride } from '../../session/draft-tier';
import { takeDraftPermissionOverride } from '../../permissions/session-overrides';
import { workingSetOpenOrFocus } from '../../session/working-set-live';
import { clearDraftCwd } from '../../project/workspace';
import {
  getProjectRuntimeRegistry,
  type ProjectRuntime,
} from '../../project/runtime';
import { draftEnsureByWindow } from './state';
import { sendSessionEvent, type HostClientId } from './events';

export type EnsureActiveSessionResult =
  | {
      ok: true;
      cwd: string;
      session: Session;
      runtime: ProjectRuntime;
    }
  | { ok: false; result: ChatSendResult };

/**
 * Ensure there is a session ready before streaming/persisting.
 * Draft mode leaves no active session until the first chat:send — create
 * lazily here and notify the renderer so the sidebar gains a list entry.
 *
 * When `requestedSessionId` is set, resolves that session by id without
 * changing the window's active selection (mid-flight / background sends).
 *
 * Requires a valid workspace (draft → session → sticky default). Never uses
 * process.cwd() as the product default. If unbound, does not create a session.
 *
 * @returns ok + session cwd, or a structured failure for the send gate
 */
export function ensureActiveSession(
  clientId: HostClientId,
  preferredModel?: ModelSelection | null,
  requestedSessionId?: string,
  draftGeneration?: number,
): EnsureActiveSessionResult {
  const windowId = clientId;
  const manager = getSessionManager();
  // Resolve by id without switchTo — do not steal window selection mid-flight.
  let active = requestedSessionId
    ? manager.getSession(requestedSessionId)
    : manager.getActive(windowId);
  if (requestedSessionId && !active) {
    return {
      ok: false,
      result: {
        status: 'error',
        error: 'The requested session no longer exists.',
        kind: 'session_not_found',
      },
    };
  }
  const workspace = resolveWindowWorkspace(windowId);

  const boundCwd = active?.cwd?.trim() || workspace.cwd;

  if (boundCwd == null || boundCwd === '') {
    return {
      ok: false,
      result: {
        status: 'error',
        error:
          'No project folder selected. Choose a folder before sending a message.',
        kind: 'unbound_workspace',
      },
    };
  }

  // A session whose folder was deleted/moved externally must surface a
  // re-bindable failure; the trust gate would instead report untrusted_project
  // and open a dialog that can never grant an invalid directory.
  if (inspectProjectDirectory(boundCwd).status !== 'valid') {
    return {
      ok: false,
      result: {
        status: 'error',
        error:
          'The project folder for this session no longer exists. Choose a folder before sending a message.',
        kind: 'unbound_workspace',
      },
    };
  }

  // No project-supplied content may run until the project is trusted.
  if (getProjectTrustState(boundCwd) !== 'trusted') {
    return {
      ok: false,
      result: {
        status: 'error',
        error:
          'This project folder is not trusted. Review and trust it before sending messages.',
        kind: 'untrusted_project',
      },
    };
  }

  // Resolve once at turn start. The returned snapshot is independent from
  // whatever project another window selects while this turn is running.
  const runtime = getProjectRuntimeRegistry().get(boundCwd);

  const selection = preferredModel ?? active?.selection ?? runtime.config.default_model;
  if (selection == null) {
    return {
      ok: false,
      result: {
        status: 'error',
        error: 'A provider connection and model are required before sending a message.',
        kind: 'provider_required',
      },
    };
  }

  // Draft path: re-check in case a concurrent first-send just created a session.
  if (!active) {
    active = manager.getActive(windowId);
  }

  if (active) {
    const selectedNow = manager.getActive(windowId)?.id === active.id;
    if (preferredModel && (
      active.selection?.connectionId !== preferredModel.connectionId
      || active.selection?.modelId !== preferredModel.modelId
    )) {
      if (selectedNow) {
        manager.changeModel(active.id, preferredModel, preferredModel.modelId);
        active = manager.getSession(active.id) ?? { ...active, selection: preferredModel };
      } else {
        // Turn-local override only — do not steal selection to persist.
        active = { ...active, selection: preferredModel };
      }
    }
    return { ok: true, cwd: boundCwd, session: active, runtime };
  }

  const created = manager.create(
    selection,
    { cwd: boundCwd },
    windowId,
    selection.modelId,
  );
  // A reasoning effort chosen in draft mode rides into the new session so the
  // very first turn (which reads the returned session) already honors it.
  const draftOverride = takeDraftReasoningOverride(windowId);
  if (draftOverride !== undefined) {
    manager.setReasoningEffortOverride(created.id, draftOverride);
  }
  const draftTier = takeDraftTierOverride(windowId);
  if (draftTier !== undefined) {
    manager.setTierOverride(created.id, draftTier);
  }
  const draftPermission = takeDraftPermissionOverride(windowId);
  if (draftPermission !== undefined) {
    manager.setPermissionMode(created.id, draftPermission);
  }
  const session =
    manager.getSession(created.id) ??
    {
      ...created,
      reasoningEffortOverride: draftOverride ?? created.reasoningEffortOverride,
      tierOverride: draftTier ?? created.tierOverride,
    };
  // Draft was promoted into the new session.
  clearDraftCwd(windowId);
  workingSetOpenOrFocus(session.id, windowId);
  // Only the creating client can have the fresh session selected, so the
  // session-event fan-out reaches exactly that sender.
  sendSessionEvent(windowId, session.id, IPC_CHANNELS.SESSION_CREATED, { session, draftGeneration });
  return { ok: true, cwd: boundCwd, session, runtime };
}

/**
 * Window-level single-flight for draft first-send. Concurrent chat:send without
 * sessionId share one ensure promise so only one session is created.
 */
export function ensureActiveSessionSingleFlight(
  clientId: HostClientId,
  preferredModel?: ModelSelection | null,
  requestedSessionId?: string,
  draftGeneration?: number,
): EnsureActiveSessionResult | Promise<EnsureActiveSessionResult> {
  const windowId = clientId;
  const manager = getSessionManager();
  // Existing session or explicit id: no draft create race.
  if (requestedSessionId || manager.getActive(windowId)) {
    return ensureActiveSession(
      clientId,
      preferredModel,
      requestedSessionId,
      draftGeneration,
    );
  }

  const inflight = draftEnsureByWindow.get(windowId);
  if (inflight) return inflight;

  let resolveFlight!: (value: EnsureActiveSessionResult) => void;
  let rejectFlight!: (reason: unknown) => void;
  const flight = new Promise<EnsureActiveSessionResult>((resolve, reject) => {
    resolveFlight = resolve;
    rejectFlight = reject;
  });
  draftEnsureByWindow.set(windowId, flight);

  try {
    const result = ensureActiveSession(
      clientId,
      preferredModel,
      requestedSessionId,
      draftGeneration,
    );
    resolveFlight(result);
  } catch (error) {
    rejectFlight(error);
    draftEnsureByWindow.delete(windowId);
    throw error;
  } finally {
    queueMicrotask(() => {
      if (draftEnsureByWindow.get(windowId) === flight) {
        draftEnsureByWindow.delete(windowId);
      }
    });
  }
  return flight;
}
