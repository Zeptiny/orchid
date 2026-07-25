import { useEffect, useRef, useState } from 'react';
import type { PermissionApprovalRequestedEvent } from '../../shared/types/ipc';
import type { RiskClass } from '../../shared/types/permission';
import { Icon } from './Icon';
import { Button } from './ui/Button';
import { StatusBadge, type StatusBadgeTone } from './ui/StatusBadge';

export function formatToolArgs(args: unknown): string {
  try {
    return JSON.stringify(args, null, 2) ?? String(args);
  } catch {
    return String(args);
  }
}

const RISK_BADGE_TONES: Record<RiskClass, StatusBadgeTone> = {
  'read-only': 'info',
  mutation: 'warning',
  execution: 'error',
  delegation: 'warning',
  network: 'warning',
  mcp: 'primary',
};

export function enqueueApproval(
  queue: PermissionApprovalRequestedEvent[],
  event: PermissionApprovalRequestedEvent,
): PermissionApprovalRequestedEvent[] {
  return queue.some((item) => item.toolCallId === event.toolCallId)
    ? queue
    : [...queue, event];
}

export function removeApproval(
  queue: PermissionApprovalRequestedEvent[],
  toolCallId: string,
): PermissionApprovalRequestedEvent[] {
  const next = queue.filter((item) => item.toolCallId !== toolCallId);
  return next.length === queue.length ? queue : next;
}

export function reconcileApprovals(
  snapshot: readonly PermissionApprovalRequestedEvent[],
  buffered: readonly PermissionApprovalRequestedEvent[],
  settledToolCallIds: ReadonlySet<string>,
  sessionId: string,
): PermissionApprovalRequestedEvent[] {
  return [...snapshot, ...buffered].reduce<PermissionApprovalRequestedEvent[]>(
    (queue, event) =>
      event.sessionId !== sessionId || settledToolCallIds.has(event.toolCallId)
        ? queue
        : enqueueApproval(queue, event),
    [],
  );
}

export interface PermissionApprovalPanelProps {
  request: PermissionApprovalRequestedEvent;
  submittingDecision: 'approved' | 'denied' | null;
  onAnswer: (decision: 'approved' | 'denied', reason?: string) => void;
}

export function PermissionApprovalPanel({
  request,
  submittingDecision,
  onAnswer,
}: PermissionApprovalPanelProps) {
  const [reasonMode, setReasonMode] = useState(false);
  const [reason, setReason] = useState('');
  const reasonInputRef = useRef<HTMLTextAreaElement>(null);
  const denyButtonRef = useRef<HTMLButtonElement>(null);
  const busy = submittingDecision !== null;
  const trimmedReason = reason.trim();

  // Safe default: land focus on Deny so a bare Enter refuses the call. The
  // panel is keyed by toolCallId, so this runs once per request.
  useEffect(() => {
    denyButtonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (reasonMode) reasonInputRef.current?.focus();
  }, [reasonMode]);

  const scopeLabel =
    request.scope === 'inside'
      ? 'Inside workspace'
      : request.scope === 'outside'
        ? 'Outside workspace'
        : null;

  return (
    <>
      <header className="orchid-permission-header">
        <div className="flex min-w-0 items-start gap-3">
          <span className="orchid-permission-icon" aria-hidden>
            <Icon name="shield" size={16} />
          </span>
          <div className="flex min-w-0 flex-col gap-1">
            <span className="orchid-permission-eyebrow">Permission request</span>
            <h2 className="orchid-permission-title">{request.toolName}</h2>
            <span className="orchid-permission-cwd" title={request.cwd}>
              {request.cwd}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          <StatusBadge
            tone={RISK_BADGE_TONES[request.riskClass]}
            size="sm"
            withDot
          >
            {request.riskClass}
          </StatusBadge>
          {scopeLabel && (
            <StatusBadge
              tone={request.scope === 'outside' ? 'error' : 'success'}
              size="sm"
              withDot
            >
              {scopeLabel}
            </StatusBadge>
          )}
        </div>
      </header>

      <div className="orchid-permission-body">
        <div className="flex flex-col gap-1">
          <span className="orchid-permission-section-label">Arguments</span>
          <pre className="orchid-permission-args">{formatToolArgs(request.args)}</pre>
        </div>

        {reasonMode && (
          <label className="flex flex-col gap-1">
            <span className="orchid-permission-section-label">Reason</span>
            <textarea
              ref={reasonInputRef}
              className="orchid-permission-reason"
              value={reason}
              rows={3}
              placeholder="Tell the agent why this call was denied"
              onChange={(event) => setReason(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.shiftKey) return;
                event.preventDefault();
                if (trimmedReason) onAnswer('denied', trimmedReason);
              }}
            />
          </label>
        )}
      </div>

      <footer className="orchid-permission-footer">
        {reasonMode ? (
          <>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                setReasonMode(false);
                setReason('');
              }}
            >
              Back
            </Button>
            <Button
              variant="error"
              size="sm"
              icon="x"
              disabled={busy || !trimmedReason}
              loading={submittingDecision === 'denied'}
              onClick={() => onAnswer('denied', trimmedReason)}
            >
              Deny with reason
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => setReasonMode(true)}
            >
              Deny with reason…
            </Button>
            <Button
              ref={denyButtonRef}
              size="sm"
              icon="x"
              disabled={busy}
              loading={submittingDecision === 'denied'}
              onClick={() => onAnswer('denied')}
            >
              Deny
            </Button>
            <Button
              variant="primary"
              size="sm"
              iconRight="check"
              disabled={busy}
              loading={submittingDecision === 'approved'}
              onClick={() => onAnswer('approved')}
            >
              Approve
            </Button>
          </>
        )}
      </footer>
    </>
  );
}

