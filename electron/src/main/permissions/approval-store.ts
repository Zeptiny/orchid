import { EventEmitter } from 'node:events';

import type { RiskClass, ToolScope } from '../../shared/types/permission';
import { getConfig } from '../config/loader';

/** Outcome of an approval request once it has been settled. */
export interface ApprovalResult {
  decision: 'approved' | 'denied';
  reason?: string;
}

/** Internal record for an in-flight approval awaiting a user decision. */
export interface ApprovalEntry {
  toolCallId: string;
  sessionId: string;
  toolName: string;
  riskClass: RiskClass;
  args: unknown;
  cwd: string;
  scope?: ToolScope;
  ownerWindowId: string | null;
  createdAt: string;
  resolve: (result: ApprovalResult) => void;
  abortSignal?: AbortSignal;
  onAbort?: () => void;
  timeout?: ReturnType<typeof setTimeout>;
}

/** Public view of a pending approval (no resolver or signal internals). */
export type PendingApproval = Pick<
  ApprovalEntry,
  'toolCallId' | 'sessionId' | 'toolName' | 'riskClass' | 'args' | 'cwd' | 'scope'
>;

/** Pending approval tagged with its owner client and creation time (reconnect resync). */
export type PendingApprovalWithOwner = PendingApproval & {
  ownerClientId: string | null;
  createdAt: string;
};

/** Payload emitted on the 'approval-settled' event. */
export interface ApprovalSettledEvent {
  toolCallId: string;
  sessionId: string;
  ownerWindowId: string | null;
  result: ApprovalResult;
}

/**
 * Tracks in-flight tool-call approvals and settles them exactly once.
 *
 * The per-request timeout is the fail-closed boundary for approvals whose
 * owner client is not connected (R7): an approval pending on a host with zero
 * clients is NEVER auto-approved — the timer settles it DENIED with reason
 * `approval-timeout` (or waits forever when the timeout is 0), and the
 * `approval-settled` event lets reconnecting clients observe the outcome.
 */
export class ApprovalStore extends EventEmitter {
  private pending = new Map<string, ApprovalEntry>();

  constructor(private readonly approvalTimeoutMs: number | null = null) {
    super();
  }

  /** Register a pending approval and resolve once it is answered, cancelled, aborted, or timed out. */
  create(
    toolCallId: string,
    sessionId: string,
    toolName: string,
    riskClass: RiskClass,
    args: unknown,
    cwd: string,
    scope?: ToolScope,
    abortSignal?: AbortSignal,
    ownerWindowId?: string,
  ): Promise<ApprovalResult> {
    if (abortSignal?.aborted) {
      return Promise.resolve({ decision: 'denied', reason: 'cancelled' });
    }

    this.settle(toolCallId, { decision: 'denied', reason: 'cancelled' });
    return new Promise((resolve) => {
      const onAbort = () => {
        this.settle(toolCallId, { decision: 'denied', reason: 'cancelled' });
      };
      const entry: ApprovalEntry = {
        toolCallId,
        sessionId,
        toolName,
        riskClass,
        args,
        cwd,
        scope,
        ownerWindowId: ownerWindowId ?? null,
        createdAt: new Date().toISOString(),
        resolve,
        abortSignal,
        onAbort,
      };
      const timeoutMs = this.approvalTimeoutMs ?? (() => {
        try {
          return getConfig().approval_timeout * 1000;
        } catch {
          return 600_000;
        }
      })();
      if (timeoutMs > 0) {
        const timer = setTimeout(() => {
          this.settle(toolCallId, { decision: 'denied', reason: 'approval-timeout' });
        }, timeoutMs);
        timer.unref?.();
        entry.timeout = timer;
      }
      this.pending.set(toolCallId, entry);
      abortSignal?.addEventListener('abort', onAbort, { once: true });
      this.emit('approval-requested', {
        toolCallId,
        sessionId,
        toolName,
        riskClass,
        args,
        cwd,
        scope,
      });
    });
  }

  private settle(toolCallId: string, result: ApprovalResult): boolean {
    const entry = this.pending.get(toolCallId);
    if (!entry) return false;
    if (entry.timeout) clearTimeout(entry.timeout);
    this.pending.delete(toolCallId);
    if (entry.abortSignal && entry.onAbort) {
      entry.abortSignal.removeEventListener('abort', entry.onAbort);
    }
    this.emit('approval-settled', {
      toolCallId: entry.toolCallId,
      sessionId: entry.sessionId,
      ownerWindowId: entry.ownerWindowId,
      result,
    } satisfies ApprovalSettledEvent);
    entry.resolve(result);
    return true;
  }

  /** Resolve a pending approval with an explicit user decision. */
  answer(toolCallId: string, decision: 'approved' | 'denied', reason?: string): boolean {
    return this.settle(toolCallId, { decision, reason });
  }

  /** Cancel a single pending approval, settling it as denied. */
  cancel(toolCallId: string): boolean {
    return this.settle(toolCallId, { decision: 'denied', reason: 'cancelled' });
  }

  /** Cancel every pending approval belonging to a session. */
  cancelAllForSession(sessionId: string): void {
    for (const [toolCallId, entry] of this.pending) {
      if (entry.sessionId === sessionId) {
        this.settle(toolCallId, { decision: 'denied', reason: 'cancelled' });
      }
    }
  }

  /** Look up a pending approval by its tool call id. */
  get(toolCallId: string): ApprovalEntry | undefined {
    return this.pending.get(toolCallId);
  }

  /** Associate a pending approval with its owner window (idempotent if already bound). */
  bindOwnerWindow(toolCallId: string, ownerWindowId: string): boolean {
    const entry = this.pending.get(toolCallId);
    if (!entry) return false;
    if (entry.ownerWindowId != null) {
      return entry.ownerWindowId === ownerWindowId;
    }
    entry.ownerWindowId = ownerWindowId;
    return true;
  }

  /**
   * Replace an existing owner binding. Used by reconnect resync (U10): a
   * remote host assigns a fresh connection id per attach, so a pending
   * entry's owner can never return — the orphaned binding moves to the
   * reconnecting client or the prompt stays visible-but-unanswerable.
   */
  rebindOwnerWindow(toolCallId: string, ownerWindowId: string): boolean {
    const entry = this.pending.get(toolCallId);
    if (!entry) return false;
    entry.ownerWindowId = ownerWindowId;
    return true;
  }

  /** List pending approvals for a session scoped to a specific owner window. */
  listForOwner(sessionId: string, ownerWindowId: string): PendingApproval[] {
    return [...this.pending.values()]
      .filter(
        (entry) =>
          entry.sessionId === sessionId && entry.ownerWindowId === ownerWindowId,
      )
      .map(
        ({ toolCallId, sessionId: ownerSessionId, toolName, riskClass, args, cwd, scope }) => ({
          toolCallId,
          sessionId: ownerSessionId,
          toolName,
          riskClass,
          args,
          cwd,
          scope,
        }),
      );
  }

  /** List pending approvals (all sessions, or one) tagged with owner client + createdAt. */
  listPending(sessionId?: string): PendingApprovalWithOwner[] {
    return [...this.pending.values()]
      .filter((entry) => sessionId === undefined || entry.sessionId === sessionId)
      .map(({
        toolCallId, sessionId: ownerSessionId, toolName, riskClass, args, cwd, scope,
        ownerWindowId, createdAt,
      }) => ({
        toolCallId,
        sessionId: ownerSessionId,
        toolName,
        riskClass,
        args,
        cwd,
        ...(scope !== undefined ? { scope } : {}),
        ownerClientId: ownerWindowId,
        createdAt,
      }));
  }

  /** Cancel every pending approval and clear their timers. */
  cleanupAll(): void {
    for (const toolCallId of [...this.pending.keys()]) {
      this.cancel(toolCallId);
    }
  }
}

/** Shared singleton approval store used across the main process. */
export const approvalStore = new ApprovalStore();
