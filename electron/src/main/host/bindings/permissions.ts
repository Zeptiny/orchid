/**
 * Permissions + ask_question family bindings. Every answer/cancel path is
 * owner-gated: the caller must be the pending entry's bound owner AND view
 * the entry's session; non-owners get `{ ok: false }`, never an error.
 *
 * Reconnect self-healing (#26): resync (`host.pending_state`) broadcasts
 * orphaned pendings owner-stripped, but adoption there needs the caller's
 * active session to already match — on a fresh `conn-<n>` it is still null
 * until the renderer's forced `session.open` lands. The answer path therefore
 * adopts too: when the entry's owner is gone (null, or a connection the
 * server no longer has) and the answering client views the entry's session,
 * the owner binding moves to that client BEFORE the ownership check, so the
 * one client that can actually answer is never told `ok: false`. This mirrors
 * the live-delivery promotion policy (server.ts) via the store's existing
 * `rebindOwnerWindow` — a connected owner is never displaced.
 */
import type { PermissionMode } from '../../../shared/types/permission';
import { getSessionManager } from '../../session/singleton';
import {
  getDraftPermissionOverride,
  setDraftPermissionOverride,
} from '../../permissions/session-overrides';
import { approvalStore } from '../../permissions/approval-store';
import { questionStore } from '../../tools/ask-question/store';
import { forceAbortMainTurn } from '../chat/abort';
import type { HostBinding, HostBindingEntries, HostRequestContext, HostServerSurface } from './types';

/**
 * Re-bind one orphaned pending entry to the answering client when that client
 * views the entry's session and the current owner cannot come back.
 */
function adoptOrphanedOwner(
  surface: HostServerSurface,
  ctx: HostRequestContext,
  sessionId: string | null,
  entry: { ownerWindowId: string | null; sessionId: string } | undefined,
  rebind: (clientId: string) => boolean,
): void {
  if (!entry || sessionId == null) return;
  if (entry.ownerWindowId === ctx.clientId) return;
  if (entry.sessionId !== sessionId) return;
  if (entry.ownerWindowId != null && surface.listConnections().includes(entry.ownerWindowId)) {
    return;
  }
  rebind(ctx.clientId);
}

export function buildPermissionBindings(surface: HostServerSurface): HostBindingEntries {
  const entries: Array<[string, HostBinding<never>]> = [];

  const bind = <P>(method: string, binding: HostBinding<P>): void => {
    entries.push([method, binding as HostBinding<never>]);
  };

  // ── ask_question ───────────────────────────────────────────────────────────
  bind('ask_question.snapshot', (ctx) => {
    const sessionId = getSessionManager().getActive(ctx.clientId)?.id ?? null;
    return {
      questions: sessionId == null
        ? []
        : questionStore.listForOwner(sessionId, ctx.clientId),
    };
  });

  bind('ask_question.answer', (ctx, params: {
    toolCallId: string;
    answers: Array<{ selected: string[]; text: string | null; skipped: boolean }>;
  }) => {
    const entry = questionStore.get(params.toolCallId);
    const sessionId = getSessionManager().getActive(ctx.clientId)?.id ?? null;
    adoptOrphanedOwner(surface, ctx, sessionId, entry, (clientId) =>
      questionStore.rebindOwnerWindow(params.toolCallId, clientId));
    const owns = entry != null
      && entry.ownerWindowId === ctx.clientId
      && entry.sessionId === sessionId;
    if (!owns) return { ok: false };
    return { ok: questionStore.answer(params.toolCallId, params.answers) };
  });

  bind('ask_question.cancel', (ctx, params: { toolCallId: string }) => {
    const entry = questionStore.get(params.toolCallId);
    const sessionId = getSessionManager().getActive(ctx.clientId)?.id ?? null;
    adoptOrphanedOwner(surface, ctx, sessionId, entry, (clientId) =>
      questionStore.rebindOwnerWindow(params.toolCallId, clientId));
    const owns = entry != null
      && entry.ownerWindowId === ctx.clientId
      && entry.sessionId === sessionId;
    if (!owns) return { ok: false };
    const ok = questionStore.cancel(params.toolCallId);
    if (ok && entry) {
      setImmediate(() => forceAbortMainTurn(entry.sessionId, { emitTerminalEvents: true }));
    }
    return { ok };
  });

  // ── permissions ────────────────────────────────────────────────────────────
  bind('permission.snapshot', (ctx) => {
    const sessionId = getSessionManager().getActive(ctx.clientId)?.id ?? null;
    return {
      approvals: sessionId == null
        ? []
        : approvalStore.listForOwner(sessionId, ctx.clientId),
    };
  });

  bind('permission.approval_answer', (ctx, params: {
    toolCallId: string; decision: 'approved' | 'denied'; reason?: string;
  }) => {
    const entry = approvalStore.get(params.toolCallId);
    const sessionId = getSessionManager().getActive(ctx.clientId)?.id ?? null;
    adoptOrphanedOwner(surface, ctx, sessionId, entry, (clientId) =>
      approvalStore.rebindOwnerWindow(params.toolCallId, clientId));
    const owns = entry != null
      && entry.ownerWindowId === ctx.clientId
      && entry.sessionId === sessionId;
    if (!owns) return { ok: false };
    return { ok: approvalStore.answer(params.toolCallId, params.decision, params.reason) };
  });

  bind('permission.set_session_mode', (ctx, params: {
    mode: PermissionMode | null; expectedSessionId: string | null;
  }) => {
    const sessionId = getSessionManager().getActive(ctx.clientId)?.id ?? null;
    if (sessionId == null) {
      // Draft mode (no session file yet): stash in the per-client draft store.
      if (params.expectedSessionId !== null) {
        return { ok: false, sessionId: null };
      }
      setDraftPermissionOverride(ctx.clientId, params.mode);
      return { ok: true, sessionId: null };
    }
    if (sessionId !== params.expectedSessionId) {
      return { ok: false, sessionId };
    }
    getSessionManager().setPermissionMode(sessionId, params.mode);
    return { ok: true, sessionId };
  });

  bind('permission.get_session_mode', (ctx, params: { expectedSessionId: string | null }) => {
    const sessionId = getSessionManager().getActive(ctx.clientId)?.id ?? null;
    if (sessionId == null) {
      if (params.expectedSessionId !== null) {
        return { ok: false, sessionId: null, mode: null };
      }
      return {
        ok: true,
        sessionId: null,
        mode: getDraftPermissionOverride(ctx.clientId) ?? null,
      };
    }
    if (sessionId !== params.expectedSessionId) {
      return { ok: false, sessionId, mode: null };
    }
    const session = getSessionManager().getSession(sessionId);
    return {
      ok: true,
      sessionId,
      mode: session?.permissionMode ?? null,
    };
  });

  return entries;
}
