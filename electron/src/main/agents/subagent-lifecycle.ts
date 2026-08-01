import type { AskQuestionAnswerMessage, AskQuestionAskedEvent } from '../../shared/types/ipc';
import { isTerminalSubagentState, SubagentState } from './types';

export type SubagentWaiterReason = 'state-change' | 'flush';

export type SubagentQuestionResult =
  | { type: 'answered'; answers: AskQuestionAnswerMessage['answers'] }
  | { type: 'declined' };

export interface SubagentQuestion {
  readonly toolCallId: string;
  readonly questions: AskQuestionAskedEvent['questions'];
}

interface PendingQuestion extends SubagentQuestion {
  readonly resolve: (result: SubagentQuestionResult) => void;
}

interface LifecycleRecord {
  state: SubagentState;
  result: string | null;
  error: string | null;
  startTime: number;
  queuedAt: number | null;
  startedAt: number | null;
  endTime: number | null;
  usage: unknown | null;
  closed: boolean;
}

export type SubagentLifecycleEvent =
  | { type: 'admit' }
  | { type: 'running'; now: number }
  | { type: 'complete'; result: string; now: number }
  | { type: 'fail'; error: string; now: number }
  | { type: 'interrupt'; error: string; now: number }
  | { type: 'follow-up'; admitted: boolean; now: number }
  | { type: 'close' };

/** Effects the manager coordinates with the focused runtime collaborators. */
export interface SubagentLifecycleEffects {
  readonly persist: boolean;
  readonly notify: boolean;
  readonly resolveWaiters: boolean;
  readonly removeFromAdmissionQueue: boolean;
  readonly admitNext: boolean;
  readonly finishProjection: boolean;
  readonly clearQuestion: boolean;
}

/**
 * Owns runtime-only coordination which must never leak into a persisted
 * subagent record: wait callbacks and ask-question resolvers. It also owns
 * the small, mechanical record state transitions, returning a description of
 * the change so the manager can coordinate admission, persistence, chains,
 * and projection without duplicating lifecycle mutation rules.
 */
export class SubagentLifecycle {
  private readonly waiters = new Map<string, Set<(reason: SubagentWaiterReason) => void>>();
  private readonly questions = new Map<string, PendingQuestion>();

  transition(record: LifecycleRecord, event: SubagentLifecycleEvent): SubagentLifecycleEffects | null {
    switch (event.type) {
      case 'admit':
        if (record.state !== SubagentState.QUEUED) return null;
        record.state = SubagentState.PENDING;
        break;
      case 'running':
        if (record.state !== SubagentState.PENDING) return null;
        record.state = SubagentState.RUNNING;
        record.startedAt ??= event.now;
        break;
      case 'complete':
        if (isTerminalSubagentState(record.state)) return null;
        record.state = SubagentState.COMPLETED;
        record.result = event.result;
        record.endTime = event.now;
        break;
      case 'fail':
        if (isTerminalSubagentState(record.state)) return null;
        record.state = SubagentState.FAILED;
        record.error = event.error;
        record.endTime = event.now;
        break;
      case 'interrupt':
        if (isTerminalSubagentState(record.state)) return null;
        record.state = SubagentState.INTERRUPTED;
        record.error ??= event.error;
        record.endTime ??= event.now;
        break;
      case 'follow-up':
        if (!isTerminalSubagentState(record.state) || record.closed) return null;
        record.state = event.admitted ? SubagentState.PENDING : SubagentState.QUEUED;
        record.result = null;
        record.error = null;
        record.endTime = null;
        record.startedAt = null;
        record.startTime = event.now;
        record.queuedAt = event.admitted ? null : event.now;
        record.usage = null;
        break;
      case 'close':
        if (record.closed) return null;
        record.closed = true;
        break;
    }
    const terminal = isTerminalSubagentState(record.state);
    return {
      persist: true,
      notify: true,
      resolveWaiters: terminal,
      removeFromAdmissionQueue: terminal,
      admitNext: terminal,
      finishProjection: terminal,
      clearQuestion: event.type === 'follow-up' || event.type === 'interrupt',
    };
  }

  addWaiter(subagentId: string, waiter: (reason: SubagentWaiterReason) => void): () => void {
    const entries = this.waiters.get(subagentId) ?? new Set();
    entries.add(waiter);
    this.waiters.set(subagentId, entries);
    return () => {
      entries.delete(waiter);
      if (entries.size === 0) this.waiters.delete(subagentId);
    };
  }

  resolveWaiters(subagentId: string, reason: SubagentWaiterReason = 'state-change'): boolean {
    const entries = this.waiters.get(subagentId);
    if (!entries?.size) return false;
    this.waiters.delete(subagentId);
    for (const resolve of entries) resolve(reason);
    return true;
  }

  hasPendingQuestion(subagentId: string): boolean {
    return this.questions.has(subagentId);
  }

  getPendingQuestion(subagentId: string): SubagentQuestion | undefined {
    const pending = this.questions.get(subagentId);
    return pending && { toolCallId: pending.toolCallId, questions: pending.questions };
  }

  askQuestion(
    subagentId: string,
    question: SubagentQuestion,
  ): Promise<SubagentQuestionResult> {
    if (this.questions.has(subagentId)) return Promise.resolve({ type: 'declined' });
    return new Promise((resolve) => {
      this.questions.set(subagentId, { ...question, resolve });
    });
  }

  answerQuestion(subagentId: string, toolCallId: string, result: SubagentQuestionResult): boolean {
    const pending = this.questions.get(subagentId);
    if (!pending || pending.toolCallId !== toolCallId) return false;
    this.questions.delete(subagentId);
    pending.resolve(result);
    return true;
  }

  cancelQuestion(subagentId: string): boolean {
    const pending = this.questions.get(subagentId);
    if (!pending) return false;
    this.questions.delete(subagentId);
    pending.resolve({ type: 'declined' });
    return true;
  }

  clear(subagentId: string): void {
    this.cancelQuestion(subagentId);
    this.waiters.delete(subagentId);
  }
}
