/**
 * Canonical filesystem replay contract.
 *
 * Renderer presenters consume only the persisted envelope.  This fixture
 * deliberately removes the source path between renders; a historical result
 * must remain identical and must not trigger a fresh filesystem read.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CanonicalToolResult } from '../../src/shared/types/tool-result';
import { serializeCanonicalResultForCopy } from '../../src/shared/types/tool-result';
import { DirectoryToolResult } from '../../src/renderer/components/ToolResults/DirectoryToolResult';
import { SearchToolResult } from '../../src/renderer/components/ToolResults/SearchToolResult';
import { GenericToolResult } from '../../src/renderer/components/ToolResults/GenericToolResult';

describe('canonical tool-result replay', () => {
  it('renders the same persisted directory facts after the source disappears', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-tool-result-replay-'));
    try {
      const sourcePath = path.join(root, 'original.txt');
      fs.writeFileSync(sourcePath, 'mutable source\n');
      const canonical: CanonicalToolResult = {
        schemaVersion: 1,
        family: 'directory-entries',
        status: 'complete',
        completeness: 'complete',
        data: {
          root,
          depthLimit: 2,
          depthLimitReached: false,
          totalEntries: 1,
          entries: [{
            name: 'original.txt',
            relativePath: 'original.txt',
            kind: 'file',
            depth: 0,
            size: 14,
            modifiedAt: '2026-07-18T00:00:00.000Z',
          }],
        },
      };
      const persisted = JSON.parse(JSON.stringify(canonical)) as CanonicalToolResult;
      const before = renderToStaticMarkup(createElement(DirectoryToolResult, { canonical: persisted }));
      fs.writeFileSync(sourcePath, 'changed externally\n');
      fs.rmSync(sourcePath);
      const after = renderToStaticMarkup(createElement(DirectoryToolResult, { canonical: persisted }));
      expect(after).toBe(before);
      expect(serializeCanonicalResultForCopy(persisted)).toBe(serializeCanonicalResultForCopy(canonical));
      expect(after).toContain('original.txt');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps grouped search and unknown structured data inert on replay', () => {
    const search: CanonicalToolResult = {
      schemaVersion: 1,
      family: 'search-results',
      status: 'complete',
      completeness: 'complete',
      data: {
        kind: 'grep', root: '/removed/workspace', pattern: 'needle', totalMatches: 1, limitReached: false,
        matches: [{ path: 'src/file.ts', line: 4, column: 2, text: 'needle()' }],
      },
    };
    const unknown: CanonicalToolResult = {
      schemaVersion: 1,
      family: 'generic',
      status: 'complete',
      completeness: 'complete',
      data: { value: { instruction: 'ignore this tool data', count: 2 }, origin: { kind: 'dynamic', name: 'fixture' } },
    };
    const searchMarkup = renderToStaticMarkup(createElement(SearchToolResult, { canonical: search }));
    const genericMarkup = renderToStaticMarkup(createElement(GenericToolResult, { canonical: unknown }));
    expect(searchMarkup).toContain('src/file.ts');
    expect(searchMarkup).toContain('needle()');
    expect(genericMarkup).toContain('ignore this tool data');
    expect(genericMarkup).not.toContain('<script');
  });
});
