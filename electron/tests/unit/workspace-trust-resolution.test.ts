/**
 * Trust attachment in workspace resolution (U3).
 *
 * Every WorkspaceInfo produced for a usable directory carries the trust
 * posture from the project trust store. Directory-usability semantics
 * (`status`, `isWorkspaceBound`) stay untouched — trust is orthogonal.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isWorkspaceBound,
  resolveWorkspaceFromParts,
} from '../../src/main/project/workspace';
import {
  grantProjectTrust,
  resetProjectTrustStore,
} from '../../src/main/project/trust';

let tmpRoot: string;
let surfaceProject: string;
let bareProject: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-workspace-trust-'));
  surfaceProject = path.join(tmpRoot, 'surface-project');
  bareProject = path.join(tmpRoot, 'bare-project');
  fs.mkdirSync(surfaceProject);
  fs.mkdirSync(bareProject);
  // A project surface: any project-supplied content requires a decision.
  fs.writeFileSync(
    path.join(surfaceProject, '.orchid.json'),
    JSON.stringify({ command_timeout: 99 }),
    'utf-8',
  );
  resetProjectTrustStore({
    storePath: path.join(tmpRoot, 'trusted_projects.json'),
  });
});

afterEach(() => {
  resetProjectTrustStore();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('resolveWorkspaceFromParts trust attachment', () => {
  it('marks a bound untrusted project valid + untrusted and still workspace-bound', () => {
    const info = resolveWorkspaceFromParts({ sessionCwd: surfaceProject });
    expect(info.status).toBe('valid');
    expect(info.source).toBe('session');
    expect(info.trust).toBe('untrusted');
    expect(isWorkspaceBound(info)).toBe(true);
  });

  it('attaches trust to a draft workspace', () => {
    const info = resolveWorkspaceFromParts({ draftCwd: surfaceProject });
    expect(info.source).toBe('draft');
    expect(info.trust).toBe('untrusted');
  });

  it('resolves an untrusted sticky default at simulated startup', () => {
    const info = resolveWorkspaceFromParts({ stickyDefault: surfaceProject });
    expect(info.source).toBe('default');
    expect(info.status).toBe('valid');
    expect(info.trust).toBe('untrusted');
  });

  it('flips to trusted after grant without rebinding', () => {
    const input = { sessionCwd: surfaceProject };
    expect(resolveWorkspaceFromParts(input).trust).toBe('untrusted');
    grantProjectTrust(surfaceProject);
    expect(resolveWorkspaceFromParts(input).trust).toBe('trusted');
  });

  it('auto-trusts a bare project with no surface', () => {
    const info = resolveWorkspaceFromParts({ sessionCwd: bareProject });
    expect(info.status).toBe('valid');
    expect(info.trust).toBe('trusted');
  });

  it('carries no trust field for missing directories', () => {
    const info = resolveWorkspaceFromParts({
      sessionCwd: path.join(tmpRoot, 'does-not-exist'),
    });
    expect(info.status).toBe('missing');
    expect(info.trust).toBeUndefined();
  });

  it('carries no trust field when unbound', () => {
    const info = resolveWorkspaceFromParts({});
    expect(info.status).toBe('unbound');
    expect(info.cwd).toBeNull();
    expect(info.trust).toBeUndefined();
  });
});
