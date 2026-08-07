import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { BgCommandListItem } from '../../src/shared/types/ipc';
import {
  CommandsSection,
  countRunningCommands,
  partitionCommandsByStatus,
} from '../../src/renderer/components/Sidebar/CommandsSection';
import type { BackgroundCommandsState } from '../../src/renderer/hooks/useBackgroundCommands';

function command(overrides: Partial<BgCommandListItem> = {}): BgCommandListItem {
  return {
    id: 1,
    command: 'npm run dev',
    description: 'dev server',
    interactive: false,
    owner: 'AGENT',
    agentScopeId: 'main',
    scopeName: 'main',
    running: true,
    exitCode: null,
    createdAt: 1_000,
    lastOutputAt: 2_000,
    ...overrides,
  };
}

describe('commands sidebar grouping', () => {
  it('keeps running commands visible and groups terminal commands', () => {
    const groups = partitionCommandsByStatus([
      command({ id: 1, running: true }),
      command({ id: 2, running: false, exitCode: 0 }),
      command({ id: 3, running: true }),
      command({ id: 4, running: false, exitCode: 1 }),
    ]);

    expect(groups.running.map((item) => item.id)).toEqual([1, 3]);
    expect(groups.ended.map((item) => item.id)).toEqual([2, 4]);
  });

  it('counts only running commands for the section badge', () => {
    expect(countRunningCommands([
      command({ id: 1, running: true }),
      command({ id: 2, running: false, exitCode: 0 }),
      command({ id: 3, running: false, exitCode: 130 }),
    ])).toBe(1);
  });

  it('renders the running row inline with a status badge', () => {
    const html = renderSection({
      status: 'ready',
      commands: [
        command({ id: 1, running: true }),
        command({ id: 2, running: false, exitCode: 0 }),
        command({ id: 3, running: false, exitCode: 1 }),
      ],
    });

    // Running row stays inline with a running badge; terminal rows stay out
    // of the static markup until the menu opens (covered by integration test).
    expect(html).toContain('>running<');
    expect(html).not.toContain('>done<');
    expect(html).not.toContain('>exit 1<');
  });

  it('renders running rows first and hides terminal rows behind the dropdown', () => {
    const html = renderSection({
      status: 'ready',
      commands: [
        command({ id: 1, command: 'npm run dev', running: true }),
        command({ id: 2, command: 'sleep 100', running: false, exitCode: 0 }),
      ],
    });

    expect(html.indexOf('npm run dev')).toBeGreaterThanOrEqual(0);
    expect(html.indexOf('npm run dev')).toBeLessThan(html.indexOf('Other commands'));
    expect(html).toContain('Show 1 other command');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('btn btn-ghost btn-xs');
    expect(html).toContain('orchid-command-dropdown-flow');
    // Terminal command body is not rendered until the menu opens.
    expect(html).not.toContain('sleep 100');
  });

  it('pluralizes the dropdown label', () => {
    const html = renderSection({
      status: 'ready',
      commands: [
        command({ id: 1, running: false, exitCode: 0 }),
        command({ id: 2, running: false, exitCode: 1 }),
      ],
    });

    expect(html).toContain('Show 2 other commands');
    expect(html).toContain('Other commands');
  });

  it('omits the dropdown when every command is still running', () => {
    const html = renderSection({
      status: 'ready',
      commands: [command({ id: 1, running: true })],
    });

    expect(html).not.toContain('Other commands');
    expect(html).not.toContain('aria-haspopup="menu"');
  });
});

function renderSection(state: BackgroundCommandsState): string {
  return renderToStaticMarkup(
    createElement(CommandsSection, {
      state,
      onRefresh: () => {},
      sessionId: 'sess-1',
    }),
  );
}
