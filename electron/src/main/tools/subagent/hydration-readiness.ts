/**
 * Per-manager, per-session readiness cache for persisted subagent hydration.
 *
 * Complete work remains ready for the lifetime of the manager. Failed or
 * caller-rejected results are evicted so a later lifecycle operation can retry.
 */
export class SubagentHydrationReadiness<TResult> {
  private readonly tasksByOwner = new WeakMap<object, Map<string, Promise<TResult>>>();

  ensure(
    owner: object,
    sessionId: string,
    hydrate: () => Promise<TResult>,
    retain = (_result: TResult): boolean => true,
  ): Promise<TResult> {
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
    const evictCurrent = () => {
      if (tasks?.get(sessionId) === task) {
        tasks.delete(sessionId);
      }
    };
    void task.then((result) => {
      if (!retain(result)) evictCurrent();
    }, evictCurrent);
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
