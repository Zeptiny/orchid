/**
 * Chat family bindings — the turn lifecycle methods (send/cancel/queue_next/
 * stop/snapshot/compact). Thin forwarders over host/chat/*; nothing here
 * reimplements pipeline policy.
 */
import { lastChainError } from '../../../shared/types/chain';
import { flattenSessionMessages } from '../../../shared/types/session';
import { getSessionManager } from '../../session/singleton';
import { getProjectTrustState } from '../../project/trust';
import { getProjectRuntimeRegistry } from '../../project/runtime';
import { activeAgents } from '../chat/state';
import { snapshotForAgent } from '../chat/snapshot';
import { trimMessagesForFrame } from '../chat/snapshot-trim';
import { startChatTurn } from '../chat/send';
import { requestChatCancel } from '../chat/cancel';
import { compactSessionNow } from '../chat/compaction';
import { forceStopSession } from '../chat/abort';
import { requestNextRequestStop } from '../../agents/next-request-stop';
import type { HostBinding, HostBindingEntries } from './types';

type ChatSendParams = Parameters<typeof startChatTurn>[1];

export function buildChatBindings(): HostBindingEntries {
  const entries: Array<[string, HostBinding<never>]> = [];

  const bind = <P>(method: string, binding: HostBinding<P>): void => {
    entries.push([method, binding as HostBinding<never>]);
  };

  bind('chat.send', (ctx, params: ChatSendParams) => startChatTurn(ctx.clientId, params));
  bind('chat.cancel', (ctx, params: { sessionId?: string | null }) =>
    requestChatCancel(ctx.clientId, params));
  bind('chat.queue_next', (_ctx, params: { sessionId: string }) => {
    requestNextRequestStop(params.sessionId);
    return null;
  });
  bind('chat.stop', (_ctx, params: { sessionId: string }) => ({
    status: forceStopSession(params.sessionId) ? 'stopped' : 'no_active_stream',
  }));
  bind('chat.snapshot', (ctx, params: { sessionId?: string | null }) => {
    const sessionId = params.sessionId ?? getSessionManager().getActive(ctx.clientId)?.id;
    if (!sessionId) return null;
    const session = getSessionManager().getSession(sessionId);
    if (!session) return null;
    const liveAgent = activeAgents.get(sessionId);
    const live = liveAgent && !liveAgent.finalized ? snapshotForAgent(liveAgent) : null;
    // #25: cap the serialized history at a safe frame budget; a trimmed
    // snapshot carries a continuation cursor the renderer feeds into
    // session.history_page (same mechanism as the per-chain lazy views).
    // session.open should apply the same trim to its messages — see
    // host/chat/snapshot-trim.ts.
    const rawMessages = liveAgent && live ? [...liveAgent.messages] : flattenSessionMessages(session);
    const { messages, trim } = trimMessagesForFrame(rawMessages, session.chains);
    return {
      sessionId,
      messages,
      live,
      lastChainError: live ? null : lastChainError(session.chains),
      ...(trim ? { trim } : {}),
    };
  });
  bind('chat.compact', (ctx, params: { sessionId?: string | null }) => {
    const sessionId = params.sessionId ?? getSessionManager().getActive(ctx.clientId)?.id;
    if (!sessionId) {
      return { status: 'nothing_to_compact', sessionId: '', detail: 'No active session to compact.' };
    }
    const session = getSessionManager().getSession(sessionId);
    if (!session) {
      return { status: 'nothing_to_compact', sessionId, detail: 'Session not found.' };
    }
    const boundCwd = session.cwd?.trim();
    if (!boundCwd || getProjectTrustState(boundCwd) !== 'trusted') {
      return { status: 'nothing_to_compact', sessionId, detail: 'The project folder for this session is not trusted.' };
    }
    const runtime = getProjectRuntimeRegistry().get(boundCwd);
    const selection = session.selection ?? runtime.config.default_model;
    if (!selection) {
      return { status: 'nothing_to_compact', sessionId, detail: 'A provider connection and model are required before compacting.' };
    }
    return compactSessionNow(sessionId, runtime, selection);
  });

  return entries;
}
