import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defaults } from '../../src/main/config/schema';
import {
  resolvePermission,
  resolveToolScope,
} from '../../src/main/permissions/resolver';

describe('permission resolver', () => {
  let root: string;
  let workspace: string;
  let outside: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-permission-resolver-'));
    workspace = path.join(root, 'workspace');
    outside = path.join(root, 'outside');
    fs.mkdirSync(workspace);
    fs.mkdirSync(outside);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('classifies an existing file symlink by its effective target', () => {
    const outsideFile = path.join(outside, 'secret.txt');
    fs.writeFileSync(outsideFile, 'secret');
    fs.symlinkSync(outsideFile, path.join(workspace, 'file-link'));

    expect(resolveToolScope('read', { file_path: 'file-link' }, workspace)).toBe(
      'outside',
    );
  });

  it('canonicalizes the nearest existing parent for a new path below a directory symlink', () => {
    fs.symlinkSync(outside, path.join(workspace, 'directory-link'));

    expect(
      resolveToolScope(
        'write',
        { file_path: 'directory-link/new/nested.txt' },
        workspace,
      ),
    ).toBe('outside');
  });

  it('keeps existing and new effective targets within the canonical workspace inside', () => {
    const actualWorkspace = path.join(root, 'actual-workspace');
    const workspaceLink = path.join(root, 'workspace-link');
    fs.mkdirSync(actualWorkspace);
    fs.writeFileSync(path.join(actualWorkspace, 'existing.txt'), 'inside');
    fs.symlinkSync(actualWorkspace, workspaceLink);

    expect(
      resolveToolScope('read', { file_path: 'existing.txt' }, workspaceLink),
    ).toBe('inside');
    expect(
      resolveToolScope('write', { file_path: 'new/nested.txt' }, workspaceLink),
    ).toBe('inside');
  });

  it('fails closed when an existing target cannot be canonicalized', () => {
    fs.symlinkSync(
      path.join(outside, 'missing-target'),
      path.join(workspace, 'dangling-link'),
    );

    expect(
      resolveToolScope('read', { file_path: 'dangling-link' }, workspace),
    ).toBe('outside');
  });

  it('fails closed when the workspace itself cannot be canonicalized', () => {
    const missingWorkspace = path.join(root, 'missing-workspace');

    expect(
      resolveToolScope('read', { file_path: 'missing.txt' }, missingWorkspace),
    ).toBe('outside');
  });

  it('classifies an apply_patch with a Move to destination outside the workspace as outside', () => {
    const patch = [
      '*** Update File: src/a.ts',
      '*** Move to: ../outside.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n');

    expect(resolveToolScope('apply_patch', { patch }, workspace)).toBe('outside');
  });

  it('classifies grep by its directory_path scope', () => {
    expect(
      resolveToolScope('grep', { pattern: 'x', directory_path: '.' }, workspace),
    ).toBe('inside');
    expect(
      resolveToolScope('grep', { pattern: 'x', directory_path: outside }, workspace),
    ).toBe('outside');
  });

  it('resolves an exact MCP rule before its server wildcard and the risk default', () => {
    const config = defaults();
    config.permissions = {
      'mcp::github::*': 'ask-when-flagged',
      'mcp::github::delete_issue': 'allow',
    };

    expect(
      resolvePermission(
        'mcp::github::delete_issue',
        'mcp',
        {},
        workspace,
        config,
        null,
      ),
    ).toMatchObject({ mode: 'allow', source: 'project-config' });
    expect(
      resolvePermission(
        'mcp::github::list_issues',
        'mcp',
        {},
        workspace,
        config,
        null,
      ),
    ).toMatchObject({ mode: 'ask-when-flagged', source: 'project-config' });
    expect(
      resolvePermission(
        'mcp::slack::list_channels',
        'mcp',
        {},
        workspace,
        config,
        null,
      ),
    ).toMatchObject({ mode: 'ask', source: 'tool-default' });
  });
});
