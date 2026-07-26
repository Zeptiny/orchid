import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defaults } from '../../src/main/config/schema';
import {
  resolvePermission,
  resolveToolScope,
} from '../../src/main/permissions/resolver';
import { readDefinition } from '../../src/main/tools/filesystem/read';
import { writeDefinition } from '../../src/main/tools/filesystem/write';
import { applyPatchDefinition } from '../../src/main/tools/filesystem/apply-patch';
import { grepToolDefinition } from '../../src/main/tools/search/grep';
import { findSymbolReferencesDefinition } from '../../src/main/tools/ast/find-symbol-references';

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

    expect(resolveToolScope(readDefinition, { file_path: 'file-link' }, workspace)?.scope).toBe(
      'outside',
    );
  });

  it('canonicalizes the nearest existing parent for a new path below a directory symlink', () => {
    fs.symlinkSync(outside, path.join(workspace, 'directory-link'));

    expect(
      resolveToolScope(
        writeDefinition,
        { file_path: 'directory-link/new/nested.txt' },
        workspace,
      ),
    ).toMatchObject({ scope: 'outside' });
  });

  it('keeps existing and new effective targets within the canonical workspace inside', () => {
    const actualWorkspace = path.join(root, 'actual-workspace');
    const workspaceLink = path.join(root, 'workspace-link');
    fs.mkdirSync(actualWorkspace);
    fs.writeFileSync(path.join(actualWorkspace, 'existing.txt'), 'inside');
    fs.symlinkSync(actualWorkspace, workspaceLink);

    expect(
      resolveToolScope(readDefinition, { file_path: 'existing.txt' }, workspaceLink),
    ).toMatchObject({ scope: 'inside' });
    expect(
      resolveToolScope(writeDefinition, { file_path: 'new/nested.txt' }, workspaceLink),
    ).toMatchObject({ scope: 'inside' });
  });

  it('fails closed when an existing target cannot be canonicalized', () => {
    fs.symlinkSync(
      path.join(outside, 'missing-target'),
      path.join(workspace, 'dangling-link'),
    );

    expect(
      resolveToolScope(readDefinition, { file_path: 'dangling-link' }, workspace),
    ).toMatchObject({ scope: 'outside' });
  });

  it('fails closed when the workspace itself cannot be canonicalized', () => {
    const missingWorkspace = path.join(root, 'missing-workspace');

    expect(
      resolveToolScope(readDefinition, { file_path: 'missing.txt' }, missingWorkspace),
    ).toMatchObject({ scope: 'outside' });
  });

  it('classifies an apply_patch with a Move to destination outside the workspace as outside', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/a.ts',
      '*** Move to: ../outside.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '*** End Patch',
    ].join('\n');

    expect(resolveToolScope(applyPatchDefinition, { patch }, workspace)).toMatchObject({ scope: 'outside' });
  });

  it('classifies grep by its directory_path scope', () => {
    expect(
      resolveToolScope(grepToolDefinition, { pattern: 'x', directory_path: '.' }, workspace),
    ).toMatchObject({ scope: 'inside' });
    expect(
      resolveToolScope(grepToolDefinition, { pattern: 'x', directory_path: outside }, workspace),
    ).toMatchObject({ scope: 'outside' });
  });

  it('preserves resolved target metadata for later instruction discovery', () => {
    const resolved = resolveToolScope(
      grepToolDefinition,
      { pattern: 'x', directory_path: './src/../src' },
      workspace,
    );

    expect(resolved).toMatchObject({ scope: 'inside' });
    expect(resolved?.intents).toEqual([expect.objectContaining({
      userPath: 'src',
      resolvedPath: path.join(workspace, 'src'),
      target: 'directory',
      access: 'read',
      activateInstructions: false,
    })]);
  });

  it('emits both the source and destination intents for an apply_patch move', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/a.ts',
      '*** Move to: src/b.ts',
      '@@',
      '-old',
      '+new',
      '*** End Patch',
    ].join('\n');

    expect(resolveToolScope(applyPatchDefinition, { patch }, workspace)?.intents)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ userPath: path.join('src', 'a.ts'), access: 'mutation' }),
        expect.objectContaining({ userPath: path.join('src', 'b.ts'), access: 'mutation' }),
      ]));
  });

  it('does not activate a nested scope for an unanchored symbol search', () => {
    const resolved = resolveToolScope(
      findSymbolReferencesDefinition,
      { symbol_name: 'example' },
      workspace,
    );

    expect(resolved).toMatchObject({ scope: 'inside' });
    expect(resolved?.intents).toEqual([]);
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
        config,
        null,
      ),
    ).toMatchObject({ mode: 'allow', source: 'project-config' });
    expect(
      resolvePermission(
        'mcp::github::list_issues',
        'mcp',
        config,
        null,
      ),
    ).toMatchObject({ mode: 'ask-when-flagged', source: 'project-config' });
    expect(
      resolvePermission(
        'mcp::slack::list_channels',
        'mcp',
        config,
        null,
      ),
    ).toMatchObject({ mode: 'ask', source: 'tool-default' });
  });
});
