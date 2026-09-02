/**
 * QuestionStore — pending ask_question state bridging tool handler to IPC.
 *
 * The tool handler creates a pending entry and awaits its promise. The IPC
 * layer resolves it when the renderer answers or cancels.
 *
 * Undeliverable questions never auto-answer: an entry whose owner client is
 * not connected stays pending and settles CANCELLED at the same
 * `approval_timeout` boundary the approval store uses (R7) — one mechanism,
 * cleared on answer/cancel, and 0 waits forever (the turn stays blocked, the
 * same as an unanswered prompt with a connected client).
 */
import { EventEmitter } from 'node:events';

import { getConfig } from '../../config/loader';

/** A single answer to one question in an ask_question tool call. */
export type QuestionAnswer = {
  selected: string[];
  text: string | null;
  skipped: boolean;
};

/** Result of resolving a pending question. */
export type QuestionStoreResult =
  | { type: 'answered'; answers: QuestionAnswer[] }
  | { type: 'cancelled' };

/** A pending question entry awaiting user response. */
export interface QuestionEntry {
  toolCallId: string;
  sessionId: string;
  ownerWindowId: string | null;
  createdAt: string;
  questions: unknown[];
  resolve: (result: QuestionStoreResult) => void;
  abortSignal?: AbortSignal;
  onAbort?: () => void;
  timeout?: ReturnType<typeof setTimeout>;
}

/** Serializable pending-question state exposed to the owning renderer. */
export type PendingQuestion = Pick<QuestionEntry, 'toolCallId' | 'sessionId' | 'questions'>;

/** Pending question tagged with its owner client and creation time (reconnect resync). */
export type PendingQuestionWithOwner = PendingQuestion & {
  ownerClientId: string | null;
  createdAt: string;
};

/** Settlement identity retained long enough to notify the exact owning renderer. */
export interface QuestionSettledEvent {
  toolCallId: string;
  sessionId: string;
  ownerWindowId: string | null;
  result: QuestionStoreResult['type'];
}

/**
 * In-memory store for pending ask_question tool calls.
 *
 * Emits `question-asked` when a question is created and `question-settled`
 * exactly once when it leaves the store. IPC forwards both to the owner.
 */
export class QuestionStore extends EventEmitter {
  private pending = new Map<string, QuestionEntry>();

  constructor(private readonly questionTimeoutMs: number | null = null) {
    super();
  }

  /** Register a pending question and return a promise resolved by answer/cancel. */
  create(
    toolCallId: string,
    sessionId: string,
    questions: unknown[],
    abortSignal?: AbortSignal,
  ): Promise<QuestionStoreResult> {
    if (abortSignal?.aborted) {
      return Promise.resolve({ type: 'cancelled' });
    }

    this.cleanup(toolCallId);
    return new Promise((resolve) => {
      const onAbort = () => {
        this.settle(toolCallId, { type: 'cancelled' });
      };
      const entry: QuestionEntry = {
        toolCallId,
        sessionId,
        ownerWindowId: null,
        createdAt: new Date().toISOString(),
        questions,
        resolve,
        abortSignal,
        onAbort,
      };
      const timeoutMs = this.questionTimeoutMs ?? (() => {
        try {
          return getConfig().approval_timeout * 1000;
        } catch {
          return 600_000;
        }
      })();
      if (timeoutMs > 0) {
        const timer = setTimeout(() => {
          this.settle(toolCallId, { type: 'cancelled' });
        }, timeoutMs);
        timer.unref?.();
        entry.timeout = timer;
      }
      this.pending.set(toolCallId, entry);
      abortSignal?.addEventListener('abort', onAbort, { once: true });
      this.emit('question-asked', { sessionId, toolCallId, questions });
    });
  }

  private settle(toolCallId: string, result: QuestionStoreResult): boolean {
    const entry = this.pending.get(toolCallId);
    if (!entry) return false;
    if (entry.timeout) clearTimeout(entry.timeout);
    this.pending.delete(toolCallId);
    if (entry.abortSignal && entry.onAbort) {
      entry.abortSignal.removeEventListener('abort', entry.onAbort);
    }
    this.emit('question-settled', {
      toolCallId: entry.toolCallId,
      sessionId: entry.sessionId,
      ownerWindowId: entry.ownerWindowId,
      result: result.type,
    } satisfies QuestionSettledEvent);
    entry.resolve(result);
    return true;
  }

  /** Resolve a pending question with user answers. Returns false if not found. */
  answer(toolCallId: string, answers: QuestionAnswer[]): boolean {
    return this.settle(toolCallId, { type: 'answered', answers });
  }

  /** Cancel a pending question. Returns false if not found. */
  cancel(toolCallId: string): boolean {
    return this.settle(toolCallId, { type: 'cancelled' });
  }

  /** Look up a pending question by ID. */
  get(toolCallId: string): QuestionEntry | undefined {
    return this.pending.get(toolCallId);
  }

  /** Bind a pending question to the renderer window that owns its main turn. */
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
   * Replace an existing owner binding (reconnect resync, U10 — see the
   * approval store's twin for the rationale).
   */
  rebindOwnerWindow(toolCallId: string, ownerWindowId: string): boolean {
    const entry = this.pending.get(toolCallId);
    if (!entry) return false;
    entry.ownerWindowId = ownerWindowId;
    return true;
  }

  /** Replayable snapshot restricted to the exact originating renderer window. */
  listForOwner(sessionId: string, ownerWindowId: string): PendingQuestion[] {
    return [...this.pending.values()]
      .filter((entry) => (
        entry.sessionId === sessionId && entry.ownerWindowId === ownerWindowId
      ))
      .map(({ toolCallId, questions }) => ({ toolCallId, sessionId, questions }));
  }

  /** List pending questions (all sessions, or one) tagged with owner client + createdAt. */
  listPending(sessionId?: string): PendingQuestionWithOwner[] {
    return [...this.pending.values()]
      .filter((entry) => sessionId === undefined || entry.sessionId === sessionId)
      .map(({ toolCallId, sessionId: ownerSessionId, questions, ownerWindowId, createdAt }) => ({
        toolCallId,
        sessionId: ownerSessionId,
        questions,
        ownerClientId: ownerWindowId,
        createdAt,
      }));
  }

  /** Cancel and remove a pending question during lifecycle cleanup. */
  cleanup(toolCallId: string): boolean {
    return this.settle(toolCallId, { type: 'cancelled' });
  }

  /** Cancel every pending question during IPC/app shutdown. */
  cleanupAll(): void {
    for (const toolCallId of [...this.pending.keys()]) {
      this.cleanup(toolCallId);
    }
  }
}

/** Process-wide singleton shared by the tool handler and IPC layer. */
export const questionStore = new QuestionStore();
