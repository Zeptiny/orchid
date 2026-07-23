import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Ref,
} from 'react';
import type {
  PermissionApprovalAnswerMessage,
  PermissionApprovalRequestedEvent,
} from '../../shared/types/ipc';
import type { RiskClass } from '../../shared/types/permission';
import { Icon } from './Icon';
import { Button } from './ui/Button';
import { DialogSurface } from './ui/DialogSurface';
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
  denyButtonRef?: Ref<HTMLButtonElement>;
  onAnswer: (decision: 'approved' | 'denied', reason?: string) => void;
}

export function PermissionApprovalPanel({
  request,
  submittingDecision,
  denyButtonRef,
  onAnswer,
}: PermissionApprovalPanelProps) {
  const [reasonMode, setReasonMode] = useState(false);
  const [reason, setReason] = useState('');
  const reasonInputRef = useRef<HTMLTextAreaElement>(null);
  const busy = submittingDecision !== null;
  const trimmedReason = reason.trim();

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

export interface PermissionApprovalDialogProps {
  sessionId: string;
}

const NOOP = () => {};

export function PermissionApprovalDialog({ sessionId }: PermissionApprovalDialogProps) {
  const [queue, setQueue] = useState<PermissionApprovalRequestedEvent[]>([]);
  const [submittingDecision, setSubmittingDecision] = useState<'approved' | 'denied' | null>(null);
  const busyRef = useRef<string | null>(null);
  const hydrationRef = useRef<{
    buffered: PermissionApprovalRequestedEvent[];
    settledToolCallIds: Set<string>;
  } | null>(null);
  const hydrationGenerationRef = useRef(0);
  const denyButtonRef = useRef<HTMLButtonElement>(null);

  const pending = queue[0]?.sessionId === sessionId ? queue[0] : null;

  useEffect(() => {
    const bridge = window.orchid?.permission;
    const generation = ++hydrationGenerationRef.current;
    busyRef.current = null;
    setQueue([]);
    setSubmittingDecision(null);

    if (!bridge) {
      hydrationRef.current = null;
      return;
    }

    const hydration = {
      buffered: [] as PermissionApprovalRequestedEvent[],
      settledToolCallIds: new Set<string>(),
    };
    hydrationRef.current = hydration;
    let cancelled = false;

    const unsubscribeRequested = bridge.onApprovalRequested((event) => {
      if (event.sessionId !== sessionId || !event.toolCallId) return;
      if (hydrationRef.current === hydration) {
        if (!hydration.buffered.some((item) => item.toolCallId === event.toolCallId)) {
          hydration.buffered.push(event);
        }
        return;
      }
      setQueue((previous) => enqueueApproval(previous, event));
    });

    const unsubscribeSettled = bridge.onApprovalSettled((event) => {
      if (event.sessionId !== sessionId || !event.toolCallId) return;
      if (busyRef.current === event.toolCallId) busyRef.current = null;
      if (hydrationRef.current === hydration) {
        hydration.settledToolCallIds.add(event.toolCallId);
        hydration.buffered = hydration.buffered.filter(
          (item) => item.toolCallId !== event.toolCallId,
        );
      }
      setQueue((previous) => removeApproval(previous, event.toolCallId));
    });

    const applySnapshot = (snapshot: PermissionApprovalRequestedEvent[]) => {
      if (cancelled || hydrationGenerationRef.current !== generation) return;
      if (hydrationRef.current !== hydration) return;
      hydrationRef.current = null;
      setQueue(
        reconcileApprovals(
          snapshot,
          hydration.buffered,
          hydration.settledToolCallIds,
          sessionId,
        ),
      );
    };

    void bridge.snapshot().then(
      (snapshot) => applySnapshot(snapshot.approvals),
      () => applySnapshot([]),
    );

    return () => {
      cancelled = true;
      if (hydrationRef.current === hydration) hydrationRef.current = null;
      unsubscribeRequested();
      unsubscribeSettled();
    };
  }, [sessionId]);

  const answer = useCallback(
    (decision: 'approved' | 'denied', reason?: string) => {
      const bridge = window.orchid?.permission;
      if (!bridge || !pending || busyRef.current) return;
      const toolCallId = pending.toolCallId;
      busyRef.current = toolCallId;
      setSubmittingDecision(decision);
      const payload: PermissionApprovalAnswerMessage = reason
        ? { toolCallId, decision, reason }
        : { toolCallId, decision };
      const finish = () => {
        if (busyRef.current === toolCallId) busyRef.current = null;
        setSubmittingDecision(null);
      };
      void bridge.answer(payload).then(
        (result) => {
          finish();
          if (result.ok) setQueue((previous) => removeApproval(previous, toolCallId));
        },
        finish,
      );
    },
    [pending],
  );

  if (!pending) return null;

  return (
    <DialogSurface
      isOpen
      onClose={NOOP}
      closeOnBackdrop={false}
      closeOnEscape={false}
      label="Permission request"
      initialFocusRef={denyButtonRef}
      overlayClassName="orchid-permission-overlay"
      panelClassName="orchid-permission-dialog"
    >
      <PermissionApprovalPanel
        key={pending.toolCallId}
        request={pending}
        submittingDecision={submittingDecision}
        denyButtonRef={denyButtonRef}
        onAnswer={answer}
      />
    </DialogSurface>
  );
}
