/**
 * Contract tests for shared renderer UI primitives (U3).
 *
 * Uses ReactDOMServer static markup so Vitest stays on Node (no jsdom).
 * Interaction contracts (focus trap, outside click) remain covered by
 * focus-trap.test.ts and integration picker/palette tests.
 */
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { IconButton } from '../../src/renderer/components/ui/IconButton';
import { Panel } from '../../src/renderer/components/ui/Panel';
import { SectionHeader } from '../../src/renderer/components/ui/SectionHeader';
import { StatusBadge } from '../../src/renderer/components/ui/StatusBadge';
import { StateMessage } from '../../src/renderer/components/ui/StateMessage';
import { FormField } from '../../src/renderer/components/ui/FormField';
import { DialogSurface } from '../../src/renderer/components/ui/DialogSurface';
import { PopoverList } from '../../src/renderer/components/ui/PopoverList';
import { ShortcutBar } from '../../src/renderer/components/ui/ShortcutBar';

function markup(node: ReactElement): string {
  return renderToStaticMarkup(node);
}

describe('IconButton', () => {
  it('exposes accessible name and tooltip for icon-only controls', () => {
    const html = markup(
      createElement(IconButton, { label: 'Close panel', icon: 'x' }),
    );
    expect(html).toContain('aria-label="Close panel"');
    expect(html).toContain('title="Close panel"');
    expect(html).toContain('btn-circle');
    expect(html).toContain('btn-ghost');
  });

  it('keeps text-bearing controls readable without forcing circle shape', () => {
    const html = markup(
      createElement(IconButton, { label: 'Save settings', icon: 'check' }, 'Save'),
    );
    expect(html).toContain('aria-label="Save settings"');
    expect(html).toContain('Save');
    expect(html).not.toContain('btn-circle');
  });

  it('disables and marks busy while loading', () => {
    const html = markup(
      createElement(IconButton, { label: 'Refresh', icon: 'refresh', loading: true }),
    );
    expect(html).toContain('disabled');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('loading-spinner');
  });
});

describe('Panel / SectionHeader / StatusBadge / StateMessage / FormField', () => {
  it('Panel composes surface tone classes', () => {
    const html = markup(createElement(Panel, { tone: 'raised' }, 'Body'));
    expect(html).toContain('orchid-panel');
    expect(html).toContain('bg-base-200');
    expect(html).toContain('Body');
  });

  it('SectionHeader renders title, description, and actions', () => {
    const html = markup(
      createElement(SectionHeader, {
        title: 'Models',
        description: 'Pick a default',
        actions: createElement('button', { type: 'button' }, 'Edit'),
      }),
    );
    expect(html).toContain('orchid-section-header');
    expect(html).toContain('Models');
    expect(html).toContain('Pick a default');
    expect(html).toContain('Edit');
  });

  it('StatusBadge applies tone and optional status dot', () => {
    const html = markup(
      createElement(StatusBadge, { tone: 'success', withDot: true, outline: true }, 'Ready'),
    );
    expect(html).toContain('badge-success');
    expect(html).toContain('badge-outline');
    expect(html).toContain('status-success');
    expect(html).toContain('Ready');
  });

  it('StateMessage supports empty, loading, and error states', () => {
    const empty = markup(createElement(StateMessage, { kind: 'empty', title: 'Nothing here' }));
    expect(empty).toContain('Nothing here');
    expect(empty).toContain('orchid-state-message');

    const loading = markup(createElement(StateMessage, { kind: 'loading', title: 'Loading' }));
    expect(loading).toContain('loading-spinner');

    const error = markup(
      createElement(StateMessage, { kind: 'error', title: 'Failed' }, 'Try again'),
    );
    expect(error).toContain('role="alert"');
    expect(error).toContain('Failed');
    expect(error).toContain('Try again');
  });

  it('FormField wires label, aria-describedby, and unique hint/error ids', () => {
    const withHint = markup(
      createElement(
        FormField,
        { label: 'Name', htmlFor: 'name', hint: 'Display name', required: true },
        createElement('input', { id: 'name', className: 'input' }),
      ),
    );
    expect(withHint).toContain('for="name"');
    expect(withHint).toContain('id="name"');
    expect(withHint).toContain('Display name');
    expect(withHint).toContain('*');
    const hintDesc = withHint.match(/aria-describedby="([^"]+)"/)?.[1];
    expect(hintDesc).toBeTruthy();
    expect(withHint).toContain(`id="${hintDesc}"`);

    const withError = markup(
      createElement(
        FormField,
        { label: 'Name', htmlFor: 'name', error: 'Required' },
        createElement('input', { id: 'name', className: 'input' }),
      ),
    );
    expect(withError).toContain('role="alert"');
    expect(withError).toContain('Required');
    expect(withError).toContain('aria-invalid="true"');
    const errorDesc = withError.match(/aria-describedby="([^"]+)"/)?.[1];
    expect(errorDesc).toBeTruthy();
    expect(withError).toContain(`id="${errorDesc}"`);
  });

  it('FormField generates unique describedby ids across fields without htmlFor', () => {
    const html = markup(
      createElement(
        'div',
        null,
        createElement(
          FormField,
          { label: 'A', hint: 'hint-a' },
          createElement('input', { className: 'input' }),
        ),
        createElement(
          FormField,
          { label: 'B', hint: 'hint-b' },
          createElement('input', { className: 'input' }),
        ),
      ),
    );
    const ids = [...html.matchAll(/aria-describedby="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    expect(html).toContain(`id="${ids[0]}"`);
    expect(html).toContain(`id="${ids[1]}"`);
  });
});

describe('DialogSurface', () => {
  it('returns nothing when closed', () => {
    const html = markup(
      createElement(
        DialogSurface,
        { isOpen: false, onClose: () => {}, label: 'Help' },
        createElement('p', null, 'Body'),
      ),
    );
    expect(html).toBe('');
  });

  it('renders dialog semantics with accessible name when open', () => {
    const html = markup(
      createElement(
        DialogSurface,
        {
          isOpen: true,
          onClose: () => {},
          label: 'Keyboard shortcuts',
          overlayClassName: 'shortcuts-help-overlay',
          panelClassName: 'shortcuts-help-dialog',
        },
        createElement('p', null, 'Body'),
      ),
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-label="Keyboard shortcuts"');
    expect(html).toContain('shortcuts-help-overlay');
    expect(html).toContain('shortcuts-help-dialog');
    expect(html).toContain('Body');
  });
});

describe('PopoverList', () => {
  it('renders listbox trigger with expanded state and option labels', () => {
    const html = markup(
      createElement(PopoverList, {
        value: 'a',
        options: [
          { value: 'a', label: 'Alpha', description: 'First' },
          { value: 'b', label: 'Beta', disabled: true },
        ],
        onChange: () => {},
        label: 'Select option',
        title: 'Options',
        searchPlaceholder: 'Search options...',
        emptyMessage: 'No options',
      }),
    );
    expect(html).toContain('aria-haspopup="listbox"');
    expect(html).toContain('aria-label="Select option"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('Alpha');
  });
});

describe('ShortcutBar', () => {
  it('renders keycap items and labels', () => {
    const html = markup(
      createElement(ShortcutBar, {
        items: [
          { chord: ['↑', '↓'], label: 'navigate' },
          { chord: 'Esc', label: 'close' },
        ],
      }),
    );
    expect(html).toContain('orchid-shortcut-bar');
    expect(html).toContain('orchid-keycap');
    expect(html).toContain('navigate');
    expect(html).toContain('close');
  });
});

describe('primitive purity', () => {
  it('ui modules do not import domain hooks or IPC surfaces', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const dir = path.resolve(__dirname, '../../src/renderer/components/ui');
    const files = (await fs.readdir(dir)).filter((name) => name.endsWith('.tsx'));
    const forbidden = [
      /from ['"].*useChat['"]/,
      /from ['"].*useSession['"]/,
      /from ['"].*useProviders['"]/,
      /window\.orchid/,
      /from ['"]@shared\//,
      /from ['"].*shared\/types/,
    ];
    for (const file of files) {
      const source = await fs.readFile(path.join(dir, file), 'utf8');
      for (const pattern of forbidden) {
        expect(source, `${file} must not match ${pattern}`).not.toMatch(pattern);
      }
    }
  });
});
