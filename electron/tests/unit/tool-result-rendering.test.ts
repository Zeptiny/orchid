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
});
