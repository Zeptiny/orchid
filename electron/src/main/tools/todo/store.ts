/**
 * TodoStore — in-memory store for todo tasks.
 *
 * Ported from Python `src/orchid/domain/todo.py` (TodoStore class).
 *
 * Key behaviors:
 * - Session-scoped in-memory store
 * - 8-hex UUID generation with collision retry
 * - create(), get(), list(), update(), delete()
 * - toData() for serialization (TodoStoreData)
 *
 * The store is mutable — callers hold a reference and mutate in place.
 * The Session stores the immutable TodoStoreData snapshot for persistence.
 */
import { randomUUID } from 'node:crypto';
import {
  TodoStatus,
  type Todo,
  type TodoStoreData,
} from '../../../shared/types/todo';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Retry budget for ID-collision avoidance (matches Python _MAX_ID_RETRIES). */
const MAX_ID_RETRIES = 8;

// ---------------------------------------------------------------------------
// TodoStore
// ---------------------------------------------------------------------------

/**
 * In-memory todo store with state machine validation.
 *
 * Each session has its own TodoStore instance. The store is mutable —
 * tools call create/update/delete to mutate, then snapshot via toData()
 * for persistence.
 */
export class TodoStore {
  private _tasks = new Map<string, Todo>();

  /**
   * Create a new todo task.
   *
   * Generates an 8-hex UUID (32 bits of entropy). Retries on collision
   * up to MAX_ID_RETRIES times. Raises if all attempts collide.
   *
   * @param title - Task title (required)
   * @param subagent_id - Optional subagent ID that owns this task
   * @returns The created Todo
   * @throws If ID generation fails after all retries
   */
  create(title: string, subagent_id?: string): Todo {
    const now = new Date().toISOString();

    for (let attempt = 0; attempt < MAX_ID_RETRIES; attempt++) {
      const id = randomUUID().replace(/-/g, '').slice(0, 8);
      if (!this._tasks.has(id)) {
        const todo: Todo = {
          id,
          title,
          status: TodoStatus.OPEN,
          subagent_id: subagent_id ?? null,
          created_at: now,
          updated_at: now,
        };
        this._tasks.set(id, todo);
        return todo;
      }
    }

    throw new Error(
      `Failed to generate a unique todo ID after ${MAX_ID_RETRIES} attempts ` +
        `(store has ${this._tasks.size} tasks)`,
    );
  }

  /**
   * Get a task by ID, or undefined if not found.
   */
  get(id: string): Todo | undefined {
    return this._tasks.get(id);
  }

  /**
   * List tasks, optionally filtered by status.
   *
   * @param status - Filter by status (optional)
   * @returns Array of matching tasks
   */
  list(status?: TodoStatus): Todo[] {
    let tasks = Array.from(this._tasks.values());

    if (status !== undefined) {
      tasks = tasks.filter((t) => t.status === status);
    }

    return tasks;
  }

  /**
   * Update a task. Returns [task, error]. On success, error is null.
   *
   * No status-transition restrictions — any status can go to any status.
   *
   * @param id - Task ID to update
   * @param updates - Fields to update (title, status)
   * @returns Tuple of [updated task | null, error message | null]
   */
  update(
    id: string,
    updates: { title?: string; status?: TodoStatus },
  ): [Todo | null, string | null] {
    const task = this._tasks.get(id);
    if (!task) {
      return [null, `No task found with ID '${id}'.`];
    }

    // Apply updates
    const now = new Date().toISOString();
    const updated: Todo = {
      ...task,
      title: updates.title ?? task.title,
      status: updates.status ?? task.status,
      updated_at: now,
    };

    this._tasks.set(id, updated);
    return [updated, null];
  }

  /**
   * Delete a task by ID. Returns the deleted task, or undefined if not found.
   */
  delete(id: string): Todo | undefined {
    const task = this._tasks.get(id);
    if (task) {
      this._tasks.delete(id);
    }
    return task;
  }

  /**
   * Snapshot the store as a TodoStoreData for persistence.
   */
  toData(): TodoStoreData {
    return { tasks: Array.from(this._tasks.values()) };
  }

  /**
   * Restore a store from a TodoStoreData snapshot.
   *
   * @param data - The persisted TodoStoreData
   * @returns A new TodoStore populated with the snapshot's tasks
   */
  static fromData(data: TodoStoreData): TodoStore {
    const store = new TodoStore();
    for (const task of data.tasks) {
      store._tasks.set(task.id, task);
    }
    return store;
  }
}
