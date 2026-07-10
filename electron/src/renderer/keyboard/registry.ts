/**
 * Single source of truth for discoverable keyboard shortcuts.
 */
import { formatChord } from './match';
import type { ShortcutDef, ShortcutGroup } from './types';

export const SHORTCUTS: readonly ShortcutDef[] = [
  {
    id: 'palette.toggle',
    chord: { key: 'k', mod: true },
    label: 'Toggle command palette',
    footerLabel: 'commands',
    group: 'global',
    allowInEditable: true,
  },
  {
    id: 'shortcuts.help',
    chord: { key: '/', mod: true },
    label: 'Keyboard shortcuts help',
    footerLabel: 'help',
    group: 'global',
    allowInEditable: true,
  },
  {
    id: 'settings.open',
    chord: { key: ',', mod: true },
    label: 'Open settings',
    group: 'global',
    allowInEditable: true,
  },
  {
    id: 'session.new',
    chord: { key: 'n', mod: true },
    label: 'New session',
    footerLabel: 'new session',
    group: 'sessions',
    allowInEditable: true,
  },
  ...([1, 2, 3, 4, 5, 6, 7, 8, 9] as const).map(
    (n): ShortcutDef => ({
      id: `session.switch.${n}`,
      chord: { key: String(n), mod: true },
      label: `Switch to session ${n}`,
      group: 'sessions',
      allowInEditable: true,
    }),
  ),
  {
    id: 'inspector.toggle',
    chord: { key: 'b', mod: true },
    label: 'Toggle right inspector',
    footerLabel: 'inspector',
    group: 'layout',
    allowInEditable: true,
  },
  {
    id: 'sessionsRail.toggle',
    chord: { key: '\\', mod: true },
    label: 'Toggle sessions rail',
    footerLabel: 'sessions',
    group: 'layout',
    allowInEditable: true,
  },
  {
    id: 'composer.send',
    chord: { key: 's', mod: true },
    label: 'Send message',
    group: 'composer',
    allowInEditable: true,
    showInHelp: true,
  },
  {
    id: 'composer.newline',
    chord: { key: 'Enter', shift: true },
    label: 'Insert newline in composer',
    group: 'composer',
    allowInEditable: true,
  },
  {
    id: 'composer.sendEnter',
    chord: { key: 'Enter' },
    label: 'Send message (composer)',
    group: 'composer',
    allowInEditable: true,
  },
  {
    id: 'composer.interrupt',
    chord: { key: 'Escape' },
    label: 'Interrupt agent / dismiss overlay',
    group: 'composer',
    allowInEditable: true,
  },
  {
    id: 'config.save',
    chord: { key: 's', mod: true },
    label: 'Save configuration',
    group: 'config',
    allowInEditable: true,
  },
  {
    id: 'config.close',
    chord: { key: 'Escape' },
    label: 'Close settings',
    group: 'config',
    allowInEditable: true,
  },
  {
    id: 'palette.navigate',
    chord: { key: 'ArrowDown' },
    label: 'Navigate palette / slash results',
    group: 'palette',
    allowInEditable: true,
  },
  {
    id: 'palette.select',
    chord: { key: 'Enter' },
    label: 'Select palette / slash result',
    group: 'palette',
    allowInEditable: true,
  },
  {
    id: 'palette.close',
    chord: { key: 'Escape' },
    label: 'Close palette / sub-picker',
    group: 'palette',
    allowInEditable: true,
  },
] as const;

const byId = new Map(SHORTCUTS.map((s) => [s.id, s]));

export function getShortcut(id: string): ShortcutDef | undefined {
  return byId.get(id);
}

export function formatShortcut(id: string): string {
  const def = byId.get(id);
  if (!def) return id;
  return formatChord(def.chord);
}

/** Shortcuts shown in the idle chat footer (order preserved). */
export const FOOTER_SHORTCUT_IDS = [
  'palette.toggle',
  'shortcuts.help',
] as const;

export const HELP_GROUP_ORDER: ShortcutGroup[] = [
  'global',
  'sessions',
  'layout',
  'composer',
  'config',
  'palette',
];

export const HELP_GROUP_LABELS: Record<ShortcutGroup, string> = {
  global: 'Global',
  sessions: 'Sessions',
  layout: 'Layout',
  composer: 'Composer',
  config: 'Settings',
  palette: 'Command palette & slash menu',
};

export function shortcutsForHelp(): ShortcutDef[] {
  return SHORTCUTS.filter((s) => s.showInHelp !== false);
}

export function groupShortcutsForHelp(): Array<{
  group: ShortcutGroup;
  label: string;
  items: ShortcutDef[];
}> {
  const items = shortcutsForHelp();
  return HELP_GROUP_ORDER.map((group) => ({
    group,
    label: HELP_GROUP_LABELS[group],
    items: items.filter((s) => s.group === group),
  })).filter((g) => g.items.length > 0);
}
