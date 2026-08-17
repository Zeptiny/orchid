import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => {
  const state = {
    workspaceCwd: null as string | null,
    sessionCwds: [] as string[],
    listSavedThrows: false,
  };
  return {
    state,
    canonicalizeProjectDirectory: vi.fn((dir: string) => (dir.startsWith('/bad') ? null : dir)),
  };
});

vi.mock('../../src/main/project/path', () => ({
  canonicalizeProjectDirectory: mocks.canonicalizeProjectDirectory,
}));

vi.mock('../../src/main/session/singleton', () => ({
  resolveWindowWorkspace: vi.fn(() => (
    mocks.state.workspaceCwd == null
      ? { cwd: null, source: 'unbound', status: 'unbound' }
      : { cwd: mocks.state.workspaceCwd, source: 'session', status: 'valid' }
  )),
  getSessionManager: () => ({
    listSaved: () => {
      if (mocks.state.listSavedThrows) throw new Error('session db unavailable');
      return mocks.state.sessionCwds.map((cwd) => ({ cwd }));
    },
  }),
}));

import { resolveAuthorizedProjectDir } from '../../src/main/ipc/project-target';

describe('resolveAuthorizedProjectDir', () => {
  beforeEach(() => {
    mocks.state.workspaceCwd = null;
    mocks.state.sessionCwds = [];
    mocks.state.listSavedThrows = false;
    mocks.canonicalizeProjectDirectory.mockImplementation((dir: string) =>
      dir.startsWith('/bad') ? null : dir,
    );
  });

  it('authorizes the selected workspace', () => {
    mocks.state.workspaceCwd = '/work/project';
    expect(resolveAuthorizedProjectDir(1, '/work/project')).toBe('/work/project');
  });

  it('authorizes a project that has sessions even when another workspace is selected', () => {
    mocks.state.workspaceCwd = '/work/other';
    mocks.state.sessionCwds = ['/work/project'];
    expect(resolveAuthorizedProjectDir(1, '/work/project')).toBe('/work/project');
  });

  it('matches session cwds through canonicalization', () => {
    mocks.state.workspaceCwd = '/work/other';
    mocks.state.sessionCwds = ['/work/project/'];
    mocks.canonicalizeProjectDirectory.mockImplementation((dir: string) =>
      dir.endsWith('/') ? dir.slice(0, -1) : dir,
    );
    expect(resolveAuthorizedProjectDir(1, '/work/project')).toBe('/work/project');
  });

  it('rejects a directory that is neither the workspace nor a session project', () => {
    mocks.state.workspaceCwd = '/work/other';
    mocks.state.sessionCwds = ['/work/session-project'];
    expect(() => resolveAuthorizedProjectDir(1, '/work/unknown')).toThrow(
      /does not match the selected workspace or any project with sessions/,
    );
  });

  it('rejects when nothing is bound and the project has no sessions', () => {
    expect(() => resolveAuthorizedProjectDir(1, '/work/project')).toThrow(
      /does not match the selected workspace or any project with sessions/,
    );
  });

  it('rejects directories that cannot be canonicalized', () => {
    mocks.state.workspaceCwd = '/bad/dir';
    expect(() => resolveAuthorizedProjectDir(1, '/bad/dir')).toThrow(
      /not a valid project directory/,
    );
  });

  it('fails closed when the session store is unavailable', () => {
    mocks.state.workspaceCwd = '/work/other';
    mocks.state.sessionCwds = ['/work/project'];
    mocks.state.listSavedThrows = true;
    expect(() => resolveAuthorizedProjectDir(1, '/work/project')).toThrow(
      /does not match the selected workspace or any project with sessions/,
    );
    expect(resolveAuthorizedProjectDir(1, '/work/other')).toBe('/work/other');
  });
});
