import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { atomicWriteJson } from '../config/loader';

export interface WorkingSetSnapshot {
  openSessionIds: string[];
  focusedSessionId: string | null;
  mruSessionIds: string[];
}

interface PersistedShape {
  workingSet: WorkingSetSnapshot;
}

export interface WorkingSetOptions {
  statePath?: string;
}

const DEFAULT_STATE_PATH = path.join(os.homedir(), '.orchid', 'ui-state.json');

export class WorkingSetStore {
  private openSessionIds: string[] = [];
  private focusedSessionId: string | null = null;
  private mruSessionIds: string[] = [];
  private readonly statePath: string;

  constructor(options?: WorkingSetOptions) {
    this.statePath = options?.statePath ?? DEFAULT_STATE_PATH;
  }

  getSnapshot(): WorkingSetSnapshot {
    return {
      openSessionIds: [...this.openSessionIds],
      focusedSessionId: this.focusedSessionId,
      mruSessionIds: [...this.mruSessionIds],
    };
  }

  openOrFocus(id: string): WorkingSetSnapshot {
    if (!this.openSessionIds.includes(id)) {
      this.openSessionIds.push(id);
    }
    this.focusedSessionId = id;
    this.moveToMruFront(id);
    return this.getSnapshot();
  }

  close(id: string): WorkingSetSnapshot {
    const idx = this.openSessionIds.indexOf(id);
    if (idx === -1) return this.getSnapshot();

    this.openSessionIds.splice(idx, 1);
    this.mruSessionIds = this.mruSessionIds.filter((sid) => sid !== id);

    if (this.focusedSessionId === id) {
      this.focusedSessionId = this.pickMruAmong(this.openSessionIds);
    }
    return this.getSnapshot();
  }

  remove(id: string): WorkingSetSnapshot {
    return this.close(id);
  }

  setFocus(id: string | null): WorkingSetSnapshot {
    if (id === null) {
      this.focusedSessionId = null;
      return this.getSnapshot();
    }
    if (!this.openSessionIds.includes(id)) return this.getSnapshot();
    this.focusedSessionId = id;
    this.moveToMruFront(id);
    return this.getSnapshot();
  }

  filterExisting(existingIds: ReadonlySet<string> | string[]): WorkingSetSnapshot {
    const set = existingIds instanceof Set
      ? existingIds
      : new Set(existingIds);
    this.openSessionIds = this.openSessionIds.filter((sid) => set.has(sid));
    this.mruSessionIds = this.mruSessionIds.filter((sid) => set.has(sid));
    if (this.focusedSessionId !== null && !set.has(this.focusedSessionId)) {
      this.focusedSessionId = this.pickMruAmong(this.openSessionIds);
    }
    return this.getSnapshot();
  }

  loadFromDisk(): WorkingSetSnapshot {
    try {
      const raw = fs.readFileSync(this.statePath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (isPersistedShape(parsed)) {
        const ws = parsed.workingSet;
        this.openSessionIds = Array.isArray(ws.openSessionIds) ? [...ws.openSessionIds] : [];
        this.focusedSessionId = typeof ws.focusedSessionId === 'string' ? ws.focusedSessionId : null;
        this.mruSessionIds = Array.isArray(ws.mruSessionIds) ? [...ws.mruSessionIds] : [];
      }
    } catch {
      // missing or corrupt file — keep current state
    }
    return this.getSnapshot();
  }

  saveToDisk(): void {
    const data: PersistedShape = { workingSet: this.getSnapshot() };
    atomicWriteJson(this.statePath, data);
  }

  private moveToMruFront(id: string): void {
    this.mruSessionIds = [id, ...this.mruSessionIds.filter((sid) => sid !== id)];
  }

  private pickMruAmong(openIds: string[]): string | null {
    for (const sid of this.mruSessionIds) {
      if (openIds.includes(sid)) return sid;
    }
    return openIds[0] ?? null;
  }
}

function isPersistedShape(value: unknown): value is PersistedShape {
  return typeof value === 'object' && value !== null && 'workingSet' in value;
}

export const sessionWorkingSet = new WorkingSetStore();
