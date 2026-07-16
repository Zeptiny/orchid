import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { WorkingSetSnapshot } from '../../shared/types/ipc';
import { atomicWriteJson } from '../config/loader';

export type { WorkingSetSnapshot };

interface PersistedShape {
  workingSet: {
    openSessionIds: string[];
    focusedSessionId: string | null;
    mruSessionIds: string[];
  };
}

export interface WorkingSetOptions {
  statePath?: string;
}

const DEFAULT_STATE_PATH = path.join(os.homedir(), '.orchid', 'ui-state.json');
const PRIMARY_OWNER = '__primary__';

export class WorkingSetStore {
  private openSessionIds: string[] = [];
  private mruSessionIds: string[] = [];
  private readonly focusedByOwner = new Map<string, string | null>();
  private readonly mruByOwner = new Map<string, string[]>();
  private readonly statePath: string;
  /** Last known primary-window focus for cold start before a real owner attaches. */
  private restoredPrimaryFocus: string | null = null;
  /** Real window owner whose focus is persisted (promoted from PRIMARY_OWNER on first mutation). */
  private primaryOwnerId: string = PRIMARY_OWNER;

  constructor(options?: WorkingSetOptions) {
    this.statePath = options?.statePath ?? DEFAULT_STATE_PATH;
  }

  getSnapshot(ownerId: string = PRIMARY_OWNER): WorkingSetSnapshot {
    const owner = ownerId || PRIMARY_OWNER;
    return {
      openSessionIds: [...this.openSessionIds],
      focusedSessionId: this.focusedByOwner.has(owner)
        ? this.focusedByOwner.get(owner) ?? null
        : this.restoredPrimaryFocus && this.openSessionIds.includes(this.restoredPrimaryFocus)
          ? this.restoredPrimaryFocus
          : null,
      mruSessionIds: [...(this.mruByOwner.get(owner) ?? this.mruSessionIds)],
    };
  }

  openOrFocus(id: string, ownerId: string = PRIMARY_OWNER): WorkingSetSnapshot {
    const owner = this.touchPrimaryOwner(ownerId || PRIMARY_OWNER);
    if (!this.openSessionIds.includes(id)) {
      this.openSessionIds.push(id);
    }
    this.moveToMruFront(id);
    this.moveOwnerMruFront(owner, id);
    this.focusedByOwner.set(owner, id);
    if (owner === this.primaryOwnerId) {
      this.restoredPrimaryFocus = id;
    }
    return this.getSnapshot(owner);
  }

  close(id: string, ownerId: string = PRIMARY_OWNER): WorkingSetSnapshot {
    const owner = this.touchPrimaryOwner(ownerId || PRIMARY_OWNER);
    const idx = this.openSessionIds.indexOf(id);
    if (idx === -1) return this.getSnapshot(owner);

    this.openSessionIds.splice(idx, 1);
    this.mruSessionIds = this.mruSessionIds.filter((sid) => sid !== id);
    for (const [oid, mru] of this.mruByOwner) {
      this.mruByOwner.set(oid, mru.filter((sid) => sid !== id));
    }

    for (const [oid, focused] of this.focusedByOwner) {
      if (focused === id) {
        const next = this.pickMruAmongForOwner(oid, this.openSessionIds);
        this.focusedByOwner.set(oid, next);
      }
    }
    if (this.restoredPrimaryFocus === id) {
      this.restoredPrimaryFocus = this.pickMruAmong(this.openSessionIds);
    }

    return this.getSnapshot(owner);
  }

  remove(id: string, ownerId: string = PRIMARY_OWNER): WorkingSetSnapshot {
    return this.close(id, ownerId);
  }

  setFocus(id: string | null, ownerId: string = PRIMARY_OWNER): WorkingSetSnapshot {
    const owner = this.touchPrimaryOwner(ownerId || PRIMARY_OWNER);
    if (id === null) {
      this.focusedByOwner.set(owner, null);
      if (owner === this.primaryOwnerId) {
        this.restoredPrimaryFocus = null;
      }
      return this.getSnapshot(owner);
    }
    if (!this.openSessionIds.includes(id)) return this.getSnapshot(owner);
    this.focusedByOwner.set(owner, id);
    this.moveToMruFront(id);
    this.moveOwnerMruFront(owner, id);
    if (owner === this.primaryOwnerId) {
      this.restoredPrimaryFocus = id;
    }
    return this.getSnapshot(owner);
  }

  filterExisting(
    existingIds: ReadonlySet<string> | string[],
    ownerId: string = PRIMARY_OWNER,
  ): WorkingSetSnapshot {
    const owner = ownerId || PRIMARY_OWNER;
    const set = existingIds instanceof Set
      ? existingIds
      : new Set(existingIds);
    this.openSessionIds = this.openSessionIds.filter((sid) => set.has(sid));
    this.mruSessionIds = this.mruSessionIds.filter((sid) => set.has(sid));
    for (const [oid, mru] of this.mruByOwner) {
      this.mruByOwner.set(oid, mru.filter((sid) => set.has(sid)));
    }
    for (const [oid, focused] of this.focusedByOwner) {
      if (focused !== null && !set.has(focused)) {
        this.focusedByOwner.set(oid, this.pickMruAmongForOwner(oid, this.openSessionIds));
      }
    }
    if (this.restoredPrimaryFocus !== null && !set.has(this.restoredPrimaryFocus)) {
      this.restoredPrimaryFocus = this.pickMruAmong(this.openSessionIds);
    }
    return this.getSnapshot(owner);
  }

  loadFromDisk(): WorkingSetSnapshot {
    try {
      const raw = fs.readFileSync(this.statePath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (isPersistedShape(parsed)) {
        const ws = parsed.workingSet;
        this.openSessionIds = asStringIdList(ws.openSessionIds);
        this.mruSessionIds = asStringIdList(ws.mruSessionIds);
        let focus: string | null;
        if (ws.focusedSessionId === null) {
          focus = null;
        } else if (
          typeof ws.focusedSessionId === 'string'
          && this.openSessionIds.includes(ws.focusedSessionId)
        ) {
          focus = ws.focusedSessionId;
        } else {
          focus = this.pickMruAmong(this.openSessionIds);
        }
        this.restoredPrimaryFocus = focus;
        this.primaryOwnerId = PRIMARY_OWNER;
        this.focusedByOwner.clear();
        this.focusedByOwner.set(PRIMARY_OWNER, focus);
        if (focus) {
          this.mruByOwner.set(PRIMARY_OWNER, [...this.mruSessionIds]);
        }
      }
    } catch {
      // missing or corrupt file — keep current state
    }
    return this.getSnapshot(PRIMARY_OWNER);
  }

  saveToDisk(): void {
    const owner = this.primaryOwnerId;
    let focusedSessionId: string | null;
    if (this.focusedByOwner.has(owner)) {
      // Explicit entry (including intentional null) wins over restored fallback.
      focusedSessionId = this.focusedByOwner.get(owner) ?? null;
    } else if (this.focusedByOwner.has(PRIMARY_OWNER)) {
      focusedSessionId = this.focusedByOwner.get(PRIMARY_OWNER) ?? null;
    } else {
      focusedSessionId = this.restoredPrimaryFocus;
    }
    const data: PersistedShape = {
      workingSet: {
        openSessionIds: [...this.openSessionIds],
        focusedSessionId,
        mruSessionIds: [...this.mruSessionIds],
      },
    };
    atomicWriteJson(this.statePath, data);
  }

  /** Promote sentinel primary to the first real window owner and migrate focus/MRU. */
  private touchPrimaryOwner(owner: string): string {
    if (this.primaryOwnerId === PRIMARY_OWNER && owner !== PRIMARY_OWNER) {
      this.primaryOwnerId = owner;
      if (!this.focusedByOwner.has(owner) && this.focusedByOwner.has(PRIMARY_OWNER)) {
        this.focusedByOwner.set(owner, this.focusedByOwner.get(PRIMARY_OWNER) ?? null);
        this.focusedByOwner.delete(PRIMARY_OWNER);
      }
      if (!this.mruByOwner.has(owner) && this.mruByOwner.has(PRIMARY_OWNER)) {
        this.mruByOwner.set(owner, this.mruByOwner.get(PRIMARY_OWNER) ?? []);
        this.mruByOwner.delete(PRIMARY_OWNER);
      }
    }
    return owner;
  }

  private moveToMruFront(id: string): void {
    this.mruSessionIds = [id, ...this.mruSessionIds.filter((sid) => sid !== id)];
  }

  private moveOwnerMruFront(owner: string, id: string): void {
    const prev = this.mruByOwner.get(owner) ?? [];
    this.mruByOwner.set(owner, [id, ...prev.filter((sid) => sid !== id)]);
  }

  private pickMruAmong(openIds: string[]): string | null {
    for (const sid of this.mruSessionIds) {
      if (openIds.includes(sid)) return sid;
    }
    return openIds[0] ?? null;
  }

  private pickMruAmongForOwner(owner: string, openIds: string[]): string | null {
    const mru = this.mruByOwner.get(owner) ?? this.mruSessionIds;
    for (const sid of mru) {
      if (openIds.includes(sid)) return sid;
    }
    return openIds[0] ?? null;
  }
}

function asStringIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is string => typeof id === 'string' && id.length > 0);
}

function isPersistedShape(value: unknown): value is PersistedShape {
  if (typeof value !== 'object' || value === null) return false;
  if (!('workingSet' in value)) return false;
  const ws = (value as { workingSet: unknown }).workingSet;
  return typeof ws === 'object' && ws !== null;
}

export const sessionWorkingSet = new WorkingSetStore();
