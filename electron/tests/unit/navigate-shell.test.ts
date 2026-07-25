/**
 * Behavioral tests for orchid:navigate shell routing and force-open epoch.
 */
import { describe, expect, it } from 'vitest';
import {
  NAV_SECTION_MAP,
  nextForceOpenEpoch,
  resolveInspectorSectionId,
  resolveOrchidNavigate,
  shouldOpenCollapseFromToken,
} from '../../src/renderer/utils/navigate-shell';

describe('resolveOrchidNavigate (ChatView orchid:navigate)', () => {
  it('noops on empty / whitespace sections', () => {
    expect(resolveOrchidNavigate(undefined)).toEqual({ kind: 'noop' });
    expect(resolveOrchidNavigate(null)).toEqual({ kind: 'noop' });
    expect(resolveOrchidNavigate('')).toEqual({ kind: 'noop' });
    expect(resolveOrchidNavigate('   ')).toEqual({ kind: 'noop' });
  });

  it('expands left sessions panel for sessions', () => {
    expect(resolveOrchidNavigate('sessions')).toEqual({ kind: 'sessions' });
    expect(resolveOrchidNavigate('  sessions  ')).toEqual({ kind: 'sessions' });
  });

  it('opens inspector for palette navigation targets', () => {
    expect(resolveOrchidNavigate('subagents')).toEqual({
      kind: 'inspector',
      section: 'subagents',
    });
    expect(resolveOrchidNavigate('todos')).toEqual({
      kind: 'inspector',
      section: 'todos',
    });
    expect(resolveOrchidNavigate('mcp-servers')).toEqual({
      kind: 'inspector',
      section: 'mcp-servers',
    });
  });
});

describe('Sidebar forceOpenEpoch / section mapping', () => {
  it('maps palette aliases to inspector section ids', () => {
    expect(resolveInspectorSectionId('subagents')).toBe('inspector-subagents');
    expect(resolveInspectorSectionId('todos')).toBe('inspector-todos');
    expect(resolveInspectorSectionId('mcp-servers')).toBe('inspector-mcp');
    expect(resolveInspectorSectionId('index-status')).toBe('inspector-index');
    expect(resolveInspectorSectionId('context')).toBe('inspector-context');
    expect(resolveInspectorSectionId('usage')).toBe('inspector-usage');
    // Already-canonical ids pass through.
    expect(resolveInspectorSectionId('inspector-subagents')).toBe('inspector-subagents');
  });

  it('covers every NAV_SECTION_MAP entry', () => {
    for (const [alias, sectionId] of Object.entries(NAV_SECTION_MAP)) {
      expect(resolveInspectorSectionId(alias)).toBe(sectionId);
    }
  });

  it('bumps force-open epoch on every focusSection so same-section re-nav works', () => {
    let epoch = 0;
    epoch = nextForceOpenEpoch(epoch);
    expect(epoch).toBe(1);
    // User collapses section, then palette re-navigates to the same section.
    epoch = nextForceOpenEpoch(epoch);
    expect(epoch).toBe(2);
    expect(shouldOpenCollapseFromToken(epoch)).toBe(true);
  });

  it('CollapseBlock only opens on positive tokens', () => {
    expect(shouldOpenCollapseFromToken(0)).toBe(false);
    expect(shouldOpenCollapseFromToken(1)).toBe(true);
    expect(shouldOpenCollapseFromToken(3)).toBe(true);
  });
});
