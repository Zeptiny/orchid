import type {
  ConfigPatch,
  ConfigPatchMap,
  ConfigSaveMessage,
  PermissionConfigScopeSaveMessage,
} from '../../shared/types/ipc';
import type { PermissionRule } from '../../shared/types/ipc-boundary';

export type ProjectPermissionDrafts = Record<string, ConfigPatchMap<PermissionRule>>;

/** Issues monotonic request tokens so only the newest async refresh can commit. */
export class LatestRequestGuard {
  private generation = 0;

  begin(): number {
    this.generation += 1;
    return this.generation;
  }

  isCurrent(generation: number): boolean {
    return this.generation === generation;
  }

  invalidate(): void {
    this.generation += 1;
  }
}

/** Synchronous guard shared by keyboard and button save entry points. */
export class SaveStartGuard {
  private active = false;

  tryStart(): boolean {
    if (this.active) return false;
    this.active = true;
    return true;
  }

  finish(): void {
    this.active = false;
  }
}

export type ConfigSaveStage = 'settings' | 'global permissions' | 'project permissions';

export interface ConfigSaveSnapshot {
  ordinary: ConfigPatch;
  globalPermissions?: ConfigPatchMap<PermissionRule>;
  project?: {
    projectDir: string;
    updates: ConfigPatchMap<PermissionRule>;
  };
  retainedProjectDirs: readonly string[];
}

export interface ConfigPersistenceAPI {
  save: (message: ConfigSaveMessage) => Promise<{ status: string }>;
  savePermissionScope: (
    message: PermissionConfigScopeSaveMessage,
  ) => Promise<{ status: string }>;
}

export interface ConfigSaveResult {
  ok: boolean;
  completedStages: readonly ConfigSaveStage[];
  failedStage?: ConfigSaveStage;
  retainedProjectDirs: readonly string[];
  error?: unknown;
}

/** Persist one immutable save snapshot, reporting each durable stage immediately. */
export async function persistConfigSnapshot(
  snapshot: ConfigSaveSnapshot,
  api: ConfigPersistenceAPI,
  onPersisted: (stage: ConfigSaveStage) => void,
): Promise<ConfigSaveResult> {
  const completedStages: ConfigSaveStage[] = [];
  const stages: Array<{
    name: ConfigSaveStage;
    run: () => Promise<unknown>;
  }> = [];

  if (hasKeys(snapshot.ordinary)) {
    stages.push({
      name: 'settings',
      run: () => api.save({ updates: snapshot.ordinary }),
    });
  }
  const globalPermissions = snapshot.globalPermissions;
  if (globalPermissions && hasKeys(globalPermissions)) {
    stages.push({
      name: 'global permissions',
      run: () => api.savePermissionScope({
        scope: 'global',
        updates: globalPermissions,
      }),
    });
  }
  if (snapshot.project && hasKeys(snapshot.project.updates)) {
    const project = snapshot.project;
    stages.push({
      name: 'project permissions',
      run: () => api.savePermissionScope({
        scope: 'project',
        updates: project.updates,
        expectedProjectDir: project.projectDir,
      }),
    });
  }

  for (const stage of stages) {
    try {
      await stage.run();
      completedStages.push(stage.name);
      onPersisted(stage.name);
    } catch (error) {
      return {
        ok: false,
        completedStages,
        failedStage: stage.name,
        retainedProjectDirs: snapshot.retainedProjectDirs,
        error,
      };
    }
  }

  return {
    ok: snapshot.retainedProjectDirs.length === 0,
    completedStages,
    retainedProjectDirs: snapshot.retainedProjectDirs,
  };
}

/** Remove only draft values that still equal the persisted snapshot. */
export function reconcileConfigDraft(
  current: ConfigPatch,
  persisted: ConfigPatch,
): ConfigPatch {
  const next = { ...current };
  for (const key of Object.keys(persisted) as Array<keyof ConfigPatch>) {
    if (isIncrementalKey(key)) {
      const currentMap = current[key];
      const persistedMap = persisted[key];
      if (isRecord(currentMap) && isRecord(persistedMap)) {
        const remaining = reconcileUnknownMap(currentMap, persistedMap);
        if (Object.keys(remaining).length === 0) delete next[key];
        else assignIncrementalPatch(next, key, remaining);
        continue;
      }
    }
    if (deepEqual(current[key], persisted[key])) {
      delete next[key];
    }
  }
  return next;
}

/** Remove only map entries that still equal values already persisted. */
export function reconcileMapDraft<V>(
  current: ConfigPatchMap<V>,
  persisted: ConfigPatchMap<V>,
): ConfigPatchMap<V> {
  const next = { ...current };
  for (const [key, value] of Object.entries(persisted)) {
    if (deepEqual(current[key], value)) delete next[key];
  }
  return next;
}

/** Merge an incremental permission edit into the draft owned by its project. */
export function mergeProjectPermissionDraft(
  current: ProjectPermissionDrafts,
  projectDir: string,
  updates: ConfigPatchMap<PermissionRule>,
): ProjectPermissionDrafts {
  return {
    ...current,
    [projectDir]: { ...(current[projectDir] ?? {}), ...updates },
  };
}

/** Reconcile a saved project snapshot without touching other project drafts. */
export function reconcileProjectPermissionDraft(
  current: ProjectPermissionDrafts,
  projectDir: string,
  persisted: ConfigPatchMap<PermissionRule>,
): ProjectPermissionDrafts {
  const remaining = reconcileMapDraft(current[projectDir] ?? {}, persisted);
  const next = { ...current };
  if (Object.keys(remaining).length === 0) delete next[projectDir];
  else next[projectDir] = remaining;
  return next;
}

/** Whether any retained project owns unsaved permission changes. */
export function hasProjectPermissionDrafts(current: ProjectPermissionDrafts): boolean {
  return Object.values(current).some((draft) => Object.keys(draft).length > 0);
}

function hasKeys(value: object): boolean {
  return Object.keys(value).length > 0;
}

function isIncrementalKey(
  key: keyof ConfigPatch,
): key is 'rag' | 'tier_models' | 'tier_reasoning_effort' | 'permissions' {
  return key === 'rag' ||
    key === 'tier_models' ||
    key === 'tier_reasoning_effort' ||
    key === 'permissions';
}

function reconcileUnknownMap(
  current: Record<string, unknown>,
  persisted: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...current };
  for (const [key, value] of Object.entries(persisted)) {
    if (deepEqual(current[key], value)) delete next[key];
  }
  return next;
}

function assignIncrementalPatch(
  patch: ConfigPatch,
  key: 'rag' | 'tier_models' | 'tier_reasoning_effort' | 'permissions',
  value: Record<string, unknown>,
): void {
  if (key === 'rag') patch.rag = value as ConfigPatch['rag'];
  else if (key === 'tier_models') {
    patch.tier_models = value as ConfigPatch['tier_models'];
  } else if (key === 'tier_reasoning_effort') {
    patch.tier_reasoning_effort = value as ConfigPatch['tier_reasoning_effort'];
  } else {
    patch.permissions = value as ConfigPatch['permissions'];
  }
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((value, index) => deepEqual(value, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every(
    (key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]),
  );
}

export { deepEqual };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object';
}
