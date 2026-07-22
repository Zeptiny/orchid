/**
 * QuestionStore — pending ask_question state bridging tool handler to IPC.
 *
 * The tool handler creates a pending entry and awaits its promise. The IPC
 * layer resolves it when the renderer answers or cancels.
 */
import { EventEmitter } from 'node:events';

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
  questions: unknown[];
  resolve: (result: QuestionStoreResult) => void;
}

/**
 * In-memory store for pending ask_question tool calls.
 *
 * Emits `question-asked` with `{ sessionId, toolCallId, questions }` when a
 * new question is created. The IPC layer subscribes and forwards to renderers.
 */
export class QuestionStore extends EventEmitter {
  private pending = new Map<string, QuestionEntry>();

  /** Register a pending question and return a promise resolved by answer/cancel. */
  create(toolCallId: string, sessionId: string, questions: unknown[]): Promise<QuestionStoreResult> {
    return new Promise((resolve) => {
      this.pending.set(toolCallId, { toolCallId, sessionId, questions, resolve });
      this.emit('question-asked', { sessionId, toolCallId, questions });
    });
  }

  /** Resolve a pending question with user answers. Returns false if not found. */
  answer(toolCallId: string, answers: QuestionAnswer[]): boolean {
    const entry = this.pending.get(toolCallId);
    if (!entry) return false;
    entry.resolve({ type: 'answered', answers });
    this.pending.delete(toolCallId);
    return true;
  }

  /** Cancel a pending question. Returns false if not found. */
  cancel(toolCallId: string): boolean {
    const entry = this.pending.get(toolCallId);
    if (!entry) return false;
    entry.resolve({ type: 'cancelled' });
    this.pending.delete(toolCallId);
    return true;
  }

  /** Look up a pending question by ID. */
  get(toolCallId: string): QuestionEntry | undefined {
    return this.pending.get(toolCallId);
  }

  /** Remove a pending question without resolving (cleanup on abort). */
  cleanup(toolCallId: string): void {
    this.pending.delete(toolCallId);
  }
}

/** Process-wide singleton shared by the tool handler and IPC layer. */
export const questionStore = new QuestionStore();
