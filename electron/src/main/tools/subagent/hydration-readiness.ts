/**
 * Per-manager, per-session readiness cache for persisted subagent hydration.
 *
 * Successful work remains ready for the lifetime of the manager. Failed work
 * is evicted immediately so the next send or lifecycle operation can retry.
 */
export class SubagentHydrationReadiness<TResult> {
  private readonly tasksByOwner = new WeakMap<object, Map<string, Promise<TResult>>>();

  ensure(owner: object, sessionId: string, hydrate: () => Promise<TResult>): Promise<TResult> {
    let tasks = this.tasksByOwner.get(owner);
    if (!tasks) {
      tasks = new Map();
      this.tasksByOwner.set(owner, tasks);
    }

    const existing = tasks.get(sessionId);
    if (existing) return existing;

    let task: Promise<TResult>;
    try {
      task = Promise.resolve(hydrate());
    } catch (error) {
      task = Promise.reject(error);
    }
    tasks.set(sessionId, task);
    void task.catch(() => {
      if (tasks?.get(sessionId) === task) {
        tasks.delete(sessionId);
      }
    });
    return task;
  }

  clear(owner: object, sessionId?: string): void {
    if (sessionId === undefined) {
      this.tasksByOwner.delete(owner);
      return;
    }

    const tasks = this.tasksByOwner.get(owner);
    tasks?.delete(sessionId);
    if (tasks?.size === 0) this.tasksByOwner.delete(owner);
  }
}
