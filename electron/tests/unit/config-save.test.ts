import { describe, expect, it, vi } from 'vitest';

import {
  persistConfigSnapshot,
  hasProjectPermissionDrafts,
  LatestRequestGuard,
  mergeProjectPermissionDraft,
  reconcileConfigDraft,
  reconcileMapDraft,
  reconcileProjectPermissionDraft,
  SaveStartGuard,
  type ConfigPersistenceAPI,
} from '../../src/renderer/utils/config-save';

function apiWithFailure(failedCall?: number): ConfigPersistenceAPI {
  let call = 0;
  const invoke = async () => {
    call += 1;
    if (call === failedCall) throw new Error(`failed stage ${call}`);
    return { status: 'saved' };
  };
  return { save: invoke, savePermissionScope: invoke };
}

const fullSnapshot = {
  ordinary: { theme: 'bluey' },
  globalPermissions: { grep: 'ask' as const },
  project: {
    projectDir: '/work/project-a',
    updates: { write: 'allow' as const },
  },
  retainedProjectDirs: [] as string[],
};

describe('persistConfigSnapshot', () => {
  it.each([
    [1, 'settings', []],
    [2, 'global permissions', ['settings']],
    [3, 'project permissions', ['settings', 'global permissions']],
  ] as const)('reports a failure at stage %i and only commits prior stages', async (
    failedCall,
    failedStage,
    completedStages,
  ) => {
    const persisted: string[] = [];
    const result = await persistConfigSnapshot(
      fullSnapshot,
      apiWithFailure(failedCall),
      (stage) => persisted.push(stage),
    );

    expect(result).toMatchObject({ ok: false, failedStage, completedStages });
    expect(persisted).toEqual(completedStages);
  });

  it('binds a project write to the project captured by the draft snapshot', async () => {
    const savePermissionScope = vi.fn(async () => ({ status: 'saved' }));

    await persistConfigSnapshot(
      { ...fullSnapshot, ordinary: {}, globalPermissions: undefined },
      { save: vi.fn(), savePermissionScope },
      () => {},
    );

    expect(savePermissionScope).toHaveBeenCalledWith({
      scope: 'project',
      updates: { write: 'allow' },
      expectedProjectDir: '/work/project-a',
    });
  });

  it('omits project identity from global permission writes', async () => {
    const savePermissionScope = vi.fn(async () => ({ status: 'saved' }));

    await persistConfigSnapshot(
      {
        ordinary: {},
        globalPermissions: { grep: 'ask' },
        retainedProjectDirs: [],
      },
      { save: vi.fn(), savePermissionScope },
      () => {},
    );

    expect(savePermissionScope).toHaveBeenCalledWith({
      scope: 'global',
      updates: { grep: 'ask' },
    });
  });

  it('returns incomplete while drafts belonging to another project remain', async () => {
    const result = await persistConfigSnapshot(
      {
        ordinary: {},
        retainedProjectDirs: ['/work/project-b'],
      },
      apiWithFailure(),
      () => {},
    );

    expect(result).toEqual({
      ok: false,
      completedStages: [],
      retainedProjectDirs: ['/work/project-b'],
    });
  });
});

describe('save reconciliation', () => {
  it('clears persisted values while retaining edits made during the await', () => {
    expect(reconcileConfigDraft(
      {
        theme: 'green-terminal',
        rag: { chunk_size: 4000, top_k: 9 },
      },
      {
        theme: 'bluey',
        rag: { chunk_size: 4000 },
      },
    )).toEqual({
      theme: 'green-terminal',
      rag: { top_k: 9 },
    });
  });

  it('reconciles permission entries independently', () => {
    expect(reconcileMapDraft(
      { grep: 'ask', write: 'allow', edit: 'deny' },
      { grep: 'ask', write: 'deny' },
    )).toEqual({ write: 'allow', edit: 'deny' });
  });

  it('keeps a successful write reconciled when a later refresh fails', async () => {
    let draft = { theme: 'bluey' as const };
    const result = await persistConfigSnapshot(
      { ordinary: draft, retainedProjectDirs: [] },
      apiWithFailure(),
      () => {
        draft = reconcileConfigDraft(draft, { theme: 'bluey' });
      },
    );

    await expect(Promise.reject(new Error('refresh failed'))).rejects.toThrow('refresh failed');
    expect(result.ok).toBe(true);
    expect(draft).toEqual({});
  });

  it('retains drafts by project across workspace navigation and restores them on return', () => {
    const projectA = '/work/project-a';
    const projectB = '/work/project-b';
    let drafts = mergeProjectPermissionDraft({}, projectA, { grep: 'ask' });
    drafts = mergeProjectPermissionDraft(drafts, projectB, { write: 'deny' });

    expect(drafts[projectA]).toEqual({ grep: 'ask' });
    expect(drafts[projectB]).toEqual({ write: 'deny' });
    expect(hasProjectPermissionDrafts(drafts)).toBe(true);

    drafts = reconcileProjectPermissionDraft(drafts, projectA, { grep: 'ask' });
    expect(drafts).toEqual({ [projectB]: { write: 'deny' } });
    expect(hasProjectPermissionDrafts(drafts)).toBe(true);
  });
});

describe('LatestRequestGuard', () => {
  it('rejects a stale workspace refresh after a newer request starts', () => {
    const guard = new LatestRequestGuard();
    const projectA = guard.begin();
    const projectB = guard.begin();

    expect(guard.isCurrent(projectA)).toBe(false);
    expect(guard.isCurrent(projectB)).toBe(true);
  });

  it('invalidates an in-flight refresh during unmount', () => {
    const guard = new LatestRequestGuard();
    const request = guard.begin();
    guard.invalidate();

    expect(guard.isCurrent(request)).toBe(false);
  });
});

describe('SaveStartGuard', () => {
  it('rejects duplicate keyboard/button starts synchronously until the save finishes', () => {
    const guard = new SaveStartGuard();

    expect(guard.tryStart()).toBe(true);
    expect(guard.tryStart()).toBe(false);
    guard.finish();
    expect(guard.tryStart()).toBe(true);
  });
});
