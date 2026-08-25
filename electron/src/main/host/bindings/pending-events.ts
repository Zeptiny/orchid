/**
 * Owner-stripped pending-prompt payloads, shared by the live redelivery path
 * (HostServer.redeliverPendingTo) and the `host.pending_state` resync
 * binding: both must be byte-identical to the store's first delivery.
 */
import type {
  AskQuestionAskedEvent,
  PermissionApprovalRequestedEvent,
} from '../../../shared/types/ipc';
import type { PendingApprovalWithOwner } from '../../permissions/approval-store';
import type { PendingQuestionWithOwner } from '../../tools/ask-question/store';

/**
 * Owner-stripped event payload for one pending approval — byte-identical to
 * the store's live `permission:approval_requested` event, so a resync
 * re-broadcast is indistinguishable from the first delivery.
 */
export function pendingApprovalEvent(
  approval: PendingApprovalWithOwner,
): PermissionApprovalRequestedEvent {
  return {
    toolCallId: approval.toolCallId,
    sessionId: approval.sessionId,
    toolName: approval.toolName,
    riskClass: approval.riskClass,
    args: approval.args,
    cwd: approval.cwd,
    ...(approval.scope !== undefined ? { scope: approval.scope } : {}),
  };
}

/** Owner-stripped event payload for one pending question (see above). */
export function pendingQuestionEvent(
  question: PendingQuestionWithOwner,
): AskQuestionAskedEvent {
  return {
    sessionId: question.sessionId,
    toolCallId: question.toolCallId,
    // The store keeps the tool-call's question array untyped; the wire payload
    // is exactly what the live event delivers (askQuestionAskedEventSchema).
    questions: question.questions as AskQuestionAskedEvent['questions'],
  };
}
