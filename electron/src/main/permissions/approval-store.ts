import { EventEmitter } from 'node:events';

export interface ApprovalResult {
  decision: 'approved' | 'denied';
  reason?: string;
}

export interface ApprovalEntry {
  toolCallId: string;
  sessionId: string;
  toolName: string;
  riskClass: string;
  args: unknown;
  cwd: string;
  scope?: string;
  ownerWindowId: string | null;
  resolve: (result: ApprovalResult) => void;
  abortSignal?: AbortSignal;
  onAbort?: () => void;
}

export type PendingApproval = Pick<
  ApprovalEntry,
  'toolCallId' | 'sessionId' | 'toolName' | 'riskClass' | 'args' | 'cwd' | 'scope'
>;

export interface ApprovalSettledEvent {
  toolCallId: string;
  sessionId: string;
  ownerWindowId: string | null;
  result: ApprovalResult;
}

export class ApprovalStore extends EventEmitter {
  private pending = new Map<string, ApprovalEntry>();

  create(
    toolCallId: string,
    sessionId: string,
    toolName: string,
    riskClass: string,
    args: unknown,
    cwd: string,
    scope?: string,
    abortSignal?: AbortSignal,
  ): Promise<ApprovalResult> {
    if (abortSignal?.aborted) {
      return Promise.resolve({ decision: 'denied', reason: 'cancelled' });
    }

    this.settle(toolCallId, { decision: 'denied', reason: 'cancelled' });
    return new Promise((resolve) => {
      const onAbort = () => {
        this.settle(toolCallId, { decision: 'denied', reason: 'cancelled' });
      };
      this.pending.set(toolCallId, {
        toolCallId,
        sessionId,
        toolName,
        riskClass,
        args,
        cwd,
        scope,
        ownerWindowId: null,
        resolve,
        abortSignal,
        onAbort,
      });
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

  answer(toolCallId: string, decision: 'approved' | 'denied', reason?: string): boolean {
    return this.settle(toolCallId, { decision, reason });
  }

  cancel(toolCallId: string): boolean {
    return this.settle(toolCallId, { decision: 'denied', reason: 'cancelled' });
  }

  cancelAllForSession(sessionId: string): void {
    for (const [toolCallId, entry] of this.pending) {
      if (entry.sessionId === sessionId) {
        this.settle(toolCallId, { decision: 'denied', reason: 'cancelled' });
      }
    }
  }

  get(toolCallId: string): ApprovalEntry | undefined {
    return this.pending.get(toolCallId);
  }

  bindOwnerWindow(toolCallId: string, ownerWindowId: string): boolean {
    const entry = this.pending.get(toolCallId);
    if (!entry) return false;
    if (entry.ownerWindowId != null) {
      return entry.ownerWindowId === ownerWindowId;
    }
    entry.ownerWindowId = ownerWindowId;
    return true;
  }

  getSnapshot(): PendingApproval[] {
    return [...this.pending.values()].map(
      ({ toolCallId, sessionId, toolName, riskClass, args, cwd, scope }) => ({
        toolCallId,
        sessionId,
        toolName,
        riskClass,
        args,
        cwd,
        scope,
      }),
    );
  }

  cleanupAll(): void {
    for (const toolCallId of [...this.pending.keys()]) {
      this.cancel(toolCallId);
    }
  }
}

export const approvalStore = new ApprovalStore();
