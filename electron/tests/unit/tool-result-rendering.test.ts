import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CanonicalToolResult } from '../../src/shared/types/tool-result';
import {
  clearToolResultRendererRegistry,
  registerToolResultRenderer,
  rendererRegistrySnapshot,
  resolveToolResultRenderer,
} from '../../src/renderer/components/ToolResults/registry';
import {
  terminalStatusForBlock,
  toolStatusLabel,
} from '../../src/renderer/components/ToolResults/ToolResultShell';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { FileChangeToolResult } from '../../src/renderer/components/ToolResults/FileChangeToolResult';
import { FileWriteToolResult } from '../../src/renderer/components/ToolResults/FileWriteToolResult';
import { FileContentToolResult } from '../../src/renderer/components/ToolResults/FileContentToolResult';

const rendererDir = path.resolve(__dirname, '../../src/renderer/components');

function canonical(status: CanonicalToolResult['status']): CanonicalToolResult {
  const data = { value: 'hello', origin: { kind: 'built-in' as const, name: 'test' } };
  if (status === 'partial') return { schemaVersion: 1, family: 'generic', data, status, completeness: 'partial', retrieval: { kind: 'rerun', toolName: 'test', input: {} } };
  if (status === 'error') return { schemaVersion: 1, family: 'generic', data, status, completeness: 'complete', error: { code: 'failed', message: 'nope' } };
  return { schemaVersion: 1, family: 'generic', data, status, completeness: 'complete' };
}

describe('shared canonical tool-result renderer', () => {
  it('has one shell, registry, inert generic body, and pager', () => {
    expect(fs.existsSync(path.join(rendererDir, 'ToolResults/ToolResultShell.tsx'))).toBe(true);
    expect(fs.existsSync(path.join(rendererDir, 'ToolResults/GenericToolResult.tsx'))).toBe(true);
    expect(fs.existsSync(path.join(rendererDir, 'ToolResults/registry.tsx'))).toBe(true);
    expect(fs.existsSync(path.join(rendererDir, 'ToolResults/ResultPager.tsx'))).toBe(true);
    const source = fs.readFileSync(path.join(rendererDir, 'ToolCallBlock.tsx'), 'utf8');
    expect(source).toContain('ToolResultShell');
    expect(source).not.toContain('parseToolPayload');
    expect(source).not.toContain('truncateResult');
  });

  it('resolves tool overrides before family defaults and restores them', () => {
    const original = resolveToolResultRenderer('execute_command', 'generic');
    const override = (() => null) as typeof original;
    const restore = registerToolResultRenderer('execute_command', override);
    expect(resolveToolResultRenderer('execute_command', 'generic')).toBe(override);
    restore();
    expect(resolveToolResultRenderer('execute_command', 'generic')).toBe(original);
    expect(rendererRegistrySnapshot().families).toContain('generic');
  });

  it('keeps lifecycle labels independent from color and canonical status', () => {
    const block = { status: 'running' } as never;
    expect(toolStatusLabel('generating')).toBe('generating');
    expect(toolStatusLabel('running')).toBe('running');
    expect(terminalStatusForBlock({ ...block, status: 'cancelled' })).toBe('cancelled');
    expect(toolStatusLabel('completed', canonical('partial'))).toBe('partial');
    expect(toolStatusLabel('completed', canonical('empty'))).toBe('empty');
    expect(toolStatusLabel('completed', canonical('error'))).toBe('error');
  });

  it('does not allow a cleared registry to remove family-safe fallback renderers', () => {
    clearToolResultRendererRegistry();
    expect(rendererRegistrySnapshot().families).toHaveLength(6);
    expect(resolveToolResultRenderer('unknown', 'generic')).toBeTypeOf('function');
  });

  it('uses distinct native presenters for filesystem families and tools', () => {
    expect(resolveToolResultRenderer('edit', 'generic')).toBe(FileChangeToolResult);
    expect(resolveToolResultRenderer('write', 'generic')).toBe(FileWriteToolResult);
    expect(resolveToolResultRenderer('read', 'generic')).toBe(FileContentToolResult);
    expect(resolveToolResultRenderer('unknown', 'file-change')).toBe(FileChangeToolResult);
    expect(resolveToolResultRenderer('unknown', 'file-write')).toBe(FileWriteToolResult);
    expect(resolveToolResultRenderer('unknown', 'file-content')).toBe(FileContentToolResult);
  });

  it('keeps diff semantics, write content, and numbered read lines in native bodies', () => {
    const diff = {
      schemaVersion: 1 as const,
      family: 'file-change' as const,
      status: 'complete' as const,
      completeness: 'complete' as const,
      data: {
        path: '/tmp/example.ts', operation: 'update' as const, addedLines: 1, removedLines: 1,
        resultingContent: 'const next = 2;\n',
        hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [
          { kind: 'remove' as const, content: 'const next = 1;', oldLineNumber: 1 },
          { kind: 'add' as const, content: 'const next = 2;', newLineNumber: 1 },
        ] }],
      },
    };
    const write = {
      schemaVersion: 1 as const,
      family: 'file-write' as const,
      status: 'complete' as const,
      completeness: 'complete' as const,
      data: { path: '/tmp/new.ts', operation: 'create' as const, content: 'export const value = 1;\n', byteCount: 25, lineCount: 1 },
    };
    const read = {
      schemaVersion: 1 as const,
      family: 'file-content' as const,
      status: 'partial' as const,
      completeness: 'partial' as const,
      retrieval: { kind: 'read' as const, path: '/tmp/read.ts', offset: 3, limit: 2 },
      data: { path: '/tmp/read.ts', language: 'typescript', lines: [{ number: 1, content: 'one' }, { number: 2, content: 'two' }], requestedRange: { start: 1, end: 4 }, returnedRange: { start: 1, end: 2 }, totalLineCount: 4 },
    };
    const diffMarkup = renderToStaticMarkup(createElement(FileChangeToolResult, { canonical: diff }));
    const writeMarkup = renderToStaticMarkup(createElement(FileWriteToolResult, { canonical: write }));
    const readMarkup = renderToStaticMarkup(createElement(FileContentToolResult, { canonical: read }));
    expect(diffMarkup).toContain('Added line 1');
    expect(diffMarkup).toContain('Removed line 1');
    expect(diffMarkup).toContain('−1');
    expect(writeMarkup).toContain('create');
    expect(writeMarkup).toContain('export const value = 1;');
    expect(writeMarkup).not.toContain('@@');
    expect(readMarkup).toContain('requested 1–4');
    expect(readMarkup).toContain('More lines are available');
    expect(readMarkup).toContain('language-typescript');
    expect(readMarkup).toContain('>one</code>');
  });
});
