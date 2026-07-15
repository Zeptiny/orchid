/**
 * Todo types for the Orchid domain.
 *
 * Ported from src/orchid/domain/todo.py.
 *
 * The TodoStore is session-scoped and tracks task state transitions
 * via VALID_TRANSITIONS (matching Python's state machine).
 *
 * Python has 7 statuses; the TS port includes all of them for
 * storage-compat. The task description's minimal subset (OPEN,
 * IN_PROGRESS, DONE) is the most commonly used.
 */

// ── Enums as const objects ──────────────────────────────────────────────────

export const TodoStatus = {
  OPEN: 'OPEN',
  IN_PROGRESS: 'IN_PROGRESS',
  DONE: 'DONE',
} as const;

export type TodoStatus = (typeof TodoStatus)[keyof typeof TodoStatus];

/** Parse a free-form status string into TodoStatus, or null if invalid. */
export function parseTodoStatus(status: string): TodoStatus | null {
  const upper = status.toUpperCase();
  if (!Object.values(TodoStatus).includes(upper as TodoStatus)) return null;
  return upper as TodoStatus;
}

// ── Valid transitions ───────────────────────────────────────────────────────

export const VALID_TRANSITIONS: Record<TodoStatus, ReadonlySet<TodoStatus>> = {
  [TodoStatus.OPEN]: new Set<TodoStatus>([TodoStatus.IN_PROGRESS]),
  [TodoStatus.IN_PROGRESS]: new Set<TodoStatus>([TodoStatus.DONE]),
  [TodoStatus.DONE]: new Set<TodoStatus>([]),
};

// ── Todo ────────────────────────────────────────────────────────────────────

export interface Todo {
  readonly id: string;
  readonly title: string;
  readonly status: TodoStatus;
  readonly subagent_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

// ── TodoStore ───────────────────────────────────────────────────────────────

/**
 * Serializable shape of the TodoStore (for storage).
 */
export interface TodoStoreData {
  readonly tasks: readonly Todo[];
}

// ── Storage dict ────────────────────────────────────────────────────────────

export interface TodoStorageDict {
  id: string;
  title: string;
  status?: string;
  subagent_id?: string;
  created_at?: string;
  updated_at?: string;
}

export interface TodoStoreStorageDict {
  tasks?: TodoStorageDict[];
}

// ── Serialization ───────────────────────────────────────────────────────────

export function todoToStorageDict(todo: Todo): TodoStorageDict {
  return {
    id: todo.id,
    title: todo.title,
    status: todo.status,
    subagent_id: todo.subagent_id ?? undefined,
    created_at: todo.created_at,
    updated_at: todo.updated_at,
  };
}

export function todoFromStorageDict(data: unknown): Todo {
  const raw = data as Record<string, unknown>;
  const now = new Date().toISOString();

  // Parse status with validation
  let status: TodoStatus = TodoStatus.OPEN;
  const rawStatus = typeof raw.status === 'string' ? raw.status.toUpperCase() : '';
  if (rawStatus === 'OPEN' || rawStatus === 'IN_PROGRESS' || rawStatus === 'DONE') {
    status = rawStatus;
  }

  return {
    id: typeof raw.id === 'string' ? raw.id : '',
    title: typeof raw.title === 'string' ? raw.title : '',
    status,
    subagent_id: typeof raw.subagent_id === 'string' ? raw.subagent_id : null,
    created_at: typeof raw.created_at === 'string' ? raw.created_at : now,
    updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : now,
  };
}

export function todoStoreToStorageDict(store: TodoStoreData): TodoStoreStorageDict {
  return {
    tasks: store.tasks.map(todoToStorageDict),
  };
}

export function todoStoreFromStorageDict(data: unknown): TodoStoreData {
  const raw = data as Record<string, unknown>;
  const tasks: Todo[] = [];
  if (Array.isArray(raw.tasks)) {
    for (const td of raw.tasks) {
      try {
        tasks.push(todoFromStorageDict(td));
      } catch {
        console.warn('Failed to restore todo, skipping');
      }
    }
  }
  return { tasks };
}
