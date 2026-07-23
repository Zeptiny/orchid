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
  onChange?: (value: PermissionMode | null) => void;
  open?: boolean;
}

function renderSelector(options: RenderOptions = {}): string {
  const {
    value = null,
    onChange = () => {},
    open,
  } = options;
  const node: ReactElement = createElement(PermissionSelector, {
    value,
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
  it('shows Default when no override is set', () => {
    const html = renderSelector({ value: null });
    expect(html).toContain('Default');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('(per-tool rules)');
  });

  it('shows the override label with session override indicator', () => {
    const html = renderSelector({ value: 'allow' });
    expect(html).toContain('Allow all');
    expect(html).toContain('(session override)');
    expect(html).not.toContain('(per-tool rules)');
  });

  it('renders the shield trigger icon', () => {
    const html = renderSelector();
    expect(html).toContain('orchid-permission-trigger');
    expect(html).toContain('<svg');
  });

  it('renders Default and all four modes with labels and descriptions when open', () => {
    const html = renderSelector({ open: true });
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('Default');
    expect(html).toContain('Per-tool rules from project config');
    expect(html).toContain('Allow all');
    expect(html).toContain('Execute everything without asking');
    expect(html).toContain('Always ask');
    expect(html).toContain('Approve every tool call');
    expect(html).toContain('Decide for me');
    expect(html).toContain('AI evaluates safety');
    expect(html).toContain('Ask when flagged');
    expect(html).toContain('Prompt only for dangerous calls');
  });

  it('marks Default as pressed when no override is set', () => {
    const html = renderSelector({ open: true, value: null });
    expect(html).toContain('aria-pressed="true"');
  });

  it('marks the active mode as pressed', () => {
    const html = renderSelector({ open: true, value: 'decide-for-me' });
    expect(html).toContain('aria-pressed="true"');
  });

  it('does not render the popover while closed', () => {
    const html = renderSelector({ value: 'allow' });
    expect(html).not.toContain('Per-tool rules from project config');
    expect(html).not.toContain('Execute everything without asking');
  });
});
