export interface SubagentAdmissionLimits {
  readonly maxActiveGlobal: number;
  readonly maxActivePerSession: number;
  readonly maxQueued: number;
}

export interface AdmissionCounters {
  activeCountGlobal(): number;
  sessionActiveCount(sessionId: string | null): number;
  recordSessionKey(id: string): string;
  isRecordQueued(id: string): boolean;
}

export class AdmissionController {
  private _queue: string[] = [];
  private _lastAdmittedSession: string | null = null;

  get queueLength(): number {
    return this._queue.length;
  }

  enqueue(id: string): void {
    this._queue.push(id);
  }

  removeFromQueue(id: string): void {
    const index = this._queue.indexOf(id);
    if (index >= 0) this._queue.splice(index, 1);
  }

  getQueuePosition(id: string): number | null {
    const index = this._queue.indexOf(id);
    return index >= 0 ? index + 1 : null;
  }

  filterQueue(predicate: (id: string) => boolean): void {
    this._queue = this._queue.filter(predicate);
  }

  canAdmit(
    sessionId: string | null,
    limits: SubagentAdmissionLimits,
    counters: AdmissionCounters,
  ): boolean {
    return (
      counters.activeCountGlobal() < limits.maxActiveGlobal &&
      counters.sessionActiveCount(sessionId) < limits.maxActivePerSession
    );
  }

  nextAdmissible(
    limits: SubagentAdmissionLimits,
    counters: AdmissionCounters,
  ): string | null {
    for (;;) {
      if (this._queue.length === 0) return null;
      if (counters.activeCountGlobal() >= limits.maxActiveGlobal) return null;
      const sessionKey = this._nextAdmissibleSessionKey(limits, counters);
      if (sessionKey === null) return null;
      const index = this._queue.findIndex(
        (id) => counters.recordSessionKey(id) === sessionKey,
      );
      if (index < 0) return null;
      const [id] = this._queue.splice(index, 1);
      if (counters.isRecordQueued(id)) return id;
    }
  }

  markAdmitted(sessionId: string | null): void {
    this._lastAdmittedSession = sessionId ?? '';
  }

  private _nextAdmissibleSessionKey(
    limits: SubagentAdmissionLimits,
    counters: AdmissionCounters,
  ): string | null {
    const sessionKeys: string[] = [];
    for (const id of this._queue) {
      const key = counters.recordSessionKey(id);
      if (!sessionKeys.includes(key)) sessionKeys.push(key);
    }
    if (sessionKeys.length === 0) return null;
    const cursor = this._lastAdmittedSession === null
      ? -1
      : sessionKeys.indexOf(this._lastAdmittedSession);
    for (let offset = 0; offset < sessionKeys.length; offset += 1) {
      const key = sessionKeys[(cursor + 1 + offset) % sessionKeys.length];
      if (counters.sessionActiveCount(key === '' ? null : key) < limits.maxActivePerSession) {
        return key;
      }
    }
    return null;
  }
}
