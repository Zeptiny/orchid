import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  PERMISSION_MODES,
  PermissionSelector,
  formatPermissionMode,
} from '../../src/renderer/components/PermissionSelector';
import type { PermissionMode } from '../../src/shared/types/permission';

interface RenderOptions {
  value?: PermissionMode | null;
  defaultValue?: PermissionMode;
  onChange?: (value: PermissionMode | null) => void;
  open?: boolean;
}

function renderSelector(options: RenderOptions = {}): string {
  const {
    value = null,
    defaultValue = 'ask-when-flagged',
    onChange = () => {},
    open,
  } = options;
  const node: ReactElement = createElement(PermissionSelector, {
    value,
    defaultValue,
    onChange,
    ...(open === undefined ? {} : { open }),
  });
  return renderToStaticMarkup(node);
}

describe('PERMISSION_MODES', () => {
  it('lists the four modes in display order', () => {
    expect(PERMISSION_MODES).toEqual(['allow', 'ask', 'decide-for-me', 'ask-when-flagged']);
  });
});

describe('formatPermissionMode', () => {
  it('labels a null value as Default', () => {
    expect(formatPermissionMode(null)).toBe('Default');
  });

  it('returns human-readable labels for every mode', () => {
    expect(formatPermissionMode('allow')).toBe('Allow all');
    expect(formatPermissionMode('ask')).toBe('Always ask');
    expect(formatPermissionMode('decide-for-me')).toBe('Decide for me');
    expect(formatPermissionMode('ask-when-flagged')).toBe('Ask when flagged');
  });
});

describe('PermissionSelector markup', () => {
  it('shows the inherited default label when no override is set', () => {
    const html = renderSelector({ value: null, defaultValue: 'ask-when-flagged' });
    expect(html).toContain('Ask when flagged');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('(inherited)');
  });

  it('shows the override label without the inheritance indicator when overridden', () => {
    const html = renderSelector({ value: 'allow', defaultValue: 'ask-when-flagged' });
    expect(html).toContain('Allow all');
    expect(html).toContain('(session override)');
    expect(html).not.toContain('(inherited)');
  });

  it('renders the shield trigger icon', () => {
    const html = renderSelector();
    expect(html).toContain('orchid-permission-trigger');
    expect(html).toContain('<svg');
  });

  it('renders all four modes with labels and descriptions when open', () => {
    const html = renderSelector({ open: true });
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('Allow all');
    expect(html).toContain('Execute everything without asking');
    expect(html).toContain('Always ask');
    expect(html).toContain('Approve every tool call');
    expect(html).toContain('Decide for me');
    expect(html).toContain('AI evaluates safety');
    expect(html).toContain('Ask when flagged');
    expect(html).toContain('Prompt only for dangerous calls');
  });

  it('marks the active mode as pressed', () => {
    const html = renderSelector({ open: true, value: 'decide-for-me' });
    expect(html).toContain('aria-pressed="true"');
  });

  it('marks the inherited default option in the popover', () => {
    const html = renderSelector({ open: true, defaultValue: 'ask' });
    expect(html).toContain('(default)');
  });

  it('disables Reset to default while inheriting', () => {
    const html = renderSelector({ open: true, value: null });
    expect(html).toMatch(/disabled[^>]*>\s*Reset to default/);
  });

  it('enables Reset to default when a session override is active', () => {
    const html = renderSelector({ open: true, value: 'allow' });
    expect(html).toContain('Reset to default');
    expect(html).not.toMatch(/disabled[^>]*>\s*Reset to default/);
  });

  it('does not render the popover while closed', () => {
    const html = renderSelector({ value: 'allow' });
    expect(html).not.toContain('Reset to default');
    expect(html).not.toContain('Execute everything without asking');
  });
});
