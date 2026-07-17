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
import { Button } from '../../src/renderer/components/ui/Button';
import { Checkbox } from '../../src/renderer/components/ui/Checkbox';
import { ConfigCard } from '../../src/renderer/components/ui/ConfigCard';
import { Tabs } from '../../src/renderer/components/ui/Tabs';
import { Alert } from '../../src/renderer/components/ui/Alert';
import { Spinner } from '../../src/renderer/components/ui/Spinner';

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

describe('Button', () => {
  it('produces variant class strings', () => {
    // Default size is sm, so class is "btn btn-sm btn-primary" etc.
    expect(markup(createElement(Button, { variant: 'primary' }, 'Go'))).toMatch(/btn btn-sm btn-primary/);
    expect(markup(createElement(Button, { variant: 'ghost' }, 'Go'))).toMatch(/btn btn-sm btn-ghost/);
    expect(markup(createElement(Button, { variant: 'error' }, 'Go'))).toMatch(/btn btn-sm btn-error/);
    expect(markup(createElement(Button, { variant: 'warning' }, 'Go'))).toMatch(/btn btn-sm btn-warning/);
    expect(markup(createElement(Button, { variant: 'link' }, 'Go'))).toMatch(/btn btn-sm btn-link/);
    expect(markup(createElement(Button, { variant: 'neutral' }, 'Go'))).toMatch(/\bbtn\b/);
    expect(markup(createElement(Button, { variant: 'neutral' }, 'Go'))).not.toContain('btn-neutral');
  });

  it('applies size classes', () => {
    expect(markup(createElement(Button, { size: 'xs' }, 'Go'))).toContain('btn-xs');
    expect(markup(createElement(Button, { size: 'sm' }, 'Go'))).toContain('btn-sm');
    expect(markup(createElement(Button, { size: 'lg' }, 'Go'))).toContain('btn-lg');
  });

  it('loading state adds spinner and aria-busy', () => {
    const html = markup(createElement(Button, { loading: true }, 'Submit'));
    expect(html).toContain('loading loading-spinner');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('disabled');
  });

  it('disabled propagates to the button element', () => {
    const html = markup(createElement(Button, { disabled: true }, 'Go'));
    expect(html).toContain('disabled');
  });
});

describe('Checkbox', () => {
  it('applies tone classes', () => {
    expect(markup(createElement(Checkbox, { tone: 'primary' }))).toContain('checkbox-primary');
    expect(markup(createElement(Checkbox, { tone: 'error' }))).toContain('checkbox-error');
    expect(markup(createElement(Checkbox, { tone: 'success' }))).toContain('checkbox-success');
    expect(markup(createElement(Checkbox, { tone: 'accent' }))).toContain('checkbox-accent');
  });

  it('label wrapping produces a <label> with label-text', () => {
    const html = markup(createElement(Checkbox, { label: 'Remember me' }));
    expect(html).toContain('<label');
    expect(html).toContain('label-text');
    expect(html).toContain('Remember me');
  });

  it('without label renders bare input', () => {
    const html = markup(createElement(Checkbox));
    expect(html).not.toContain('<label');
    expect(html).toContain('<input');
    expect(html).toContain('type="checkbox"');
  });
});

describe('ConfigCard', () => {
  it('variant default produces base-100 bg', () => {
    const html = markup(createElement(ConfigCard, { variant: 'default' }, 'Body'));
    expect(html).toContain('config-card');
    expect(html).toContain('bg-base-100');
    expect(html).toContain('Body');
  });

  it('variant active produces primary border/border', () => {
    const html = markup(createElement(ConfigCard, { variant: 'active' }, 'Body'));
    expect(html).toContain('border-primary/30');
    expect(html).toContain('bg-primary/5');
  });

  it('body stack variant uses card-body', () => {
    const html = markup(createElement(ConfigCard.Body, { variant: 'stack' }, 'Content'));
    expect(html).toContain('card-body');
    expect(html).not.toContain('config-card-row');
    expect(html).toContain('Content');
  });

  it('body row variant uses config-card-row', () => {
    const html = markup(createElement(ConfigCard.Body, { variant: 'row' }, 'Content'));
    expect(html).toContain('config-card-row');
    expect(html).toContain('card-body');
  });

  it('actions without title still renders actions area', () => {
    const html = markup(
      createElement(ConfigCard, {
        actions: createElement('button', null, 'Edit'),
      }),
    );
    expect(html).toContain('config-card-actions');
    expect(html).toContain('Edit');
  });
});

describe('Tabs', () => {
  it('aria-selected toggles based on value', () => {
    const items = [
      { id: 'a', label: 'Alpha' },
      { id: 'b', label: 'Beta' },
    ];
    const html = markup(createElement(Tabs, { items, value: 'a', onValueChange: () => {} }));
    // Active tab gets aria-selected="true" and tab-active class
    expect(html).toMatch(/aria-selected="true"[^>]*>Alpha/);
    expect(html).toMatch(/aria-selected="false"[^>]*>Beta/);
    expect(html).toMatch(/tab-active/);
  });

  it('renders role=tablist container', () => {
    const items = [{ id: 'x', label: 'X' }];
    const html = markup(createElement(Tabs, { items, value: 'x', onValueChange: () => {} }));
    expect(html).toContain('role="tablist"');
    expect(html).toContain('role="tab"');
  });

  it('applies variant class', () => {
    const items = [{ id: 'x', label: 'X' }];
    const html = markup(createElement(Tabs, { items, value: 'x', onValueChange: () => {}, variant: 'bordered' }));
    expect(html).toContain('tabs-bordered');
  });
});

describe('Alert', () => {
  it('applies tone classes', () => {
    expect(markup(createElement(Alert, { tone: 'info' }))).toContain('alert-info');
    expect(markup(createElement(Alert, { tone: 'success' }))).toContain('alert-success');
    expect(markup(createElement(Alert, { tone: 'warning' }))).toContain('alert-warning');
    expect(markup(createElement(Alert, { tone: 'error' }))).toContain('alert-error');
  });

  it('defaults role to "alert"', () => {
    const html = markup(createElement(Alert));
    expect(html).toContain('role="alert"');
  });

  it('role can be overridden via prop', () => {
    const html = markup(createElement(Alert, { role: 'status' }));
    expect(html).toContain('role="status"');
    expect(html).not.toContain('role="alert"');
  });

  it('renders title and children', () => {
    const html = markup(createElement(Alert, { title: 'Heads up' }, 'Details here'));
    expect(html).toContain('Heads up');
    expect(html).toContain('Details here');
  });
});

describe('Spinner', () => {
  it('applies size classes', () => {
    expect(markup(createElement(Spinner, { size: 'xs' }))).toContain('loading-xs');
    expect(markup(createElement(Spinner, { size: 'sm' }))).toContain('loading-sm');
    expect(markup(createElement(Spinner, { size: 'lg' }))).toContain('loading-lg');
  });

  it('applies variant classes', () => {
    expect(markup(createElement(Spinner, { variant: 'dots' }))).toContain('loading-dots');
    expect(markup(createElement(Spinner, { variant: 'ring' }))).toContain('loading-ring');
    expect(markup(createElement(Spinner, { variant: 'ball' }))).toContain('loading-ball');
    expect(markup(createElement(Spinner, { variant: 'bars' }))).toContain('loading-bars');
    expect(markup(createElement(Spinner, { variant: 'infinity' }))).toContain('loading-infinity');
    expect(markup(createElement(Spinner, { variant: 'spinner' }))).toContain('loading-spinner');
  });

  it('defaults to role=status with aria-label', () => {
    const html = markup(createElement(Spinner));
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="Loading"');
  });

  it('aria-hidden suppresses role and aria-label', () => {
    const html = markup(createElement(Spinner, { 'aria-hidden': true }));
    expect(html).not.toContain('role=');
    expect(html).not.toContain('aria-label=');
  });
});

describe('primitive purity', () => {
  it('ui modules do not import domain hooks or IPC surfaces', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const dir = path.resolve(__dirname, '../../src/renderer/components/ui');
    const files = (await fs.readdir(dir)).filter(
      (name) => name.endsWith('.tsx') || name.endsWith('.ts'),
    );
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
