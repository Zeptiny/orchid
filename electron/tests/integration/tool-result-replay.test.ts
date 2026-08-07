// @vitest-environment jsdom
/**
 * Canonical filesystem replay contract.
 *
 * Renderer presenters consume only the persisted envelope.  This fixture
 * deliberately removes the source path between renders; a historical result
 * must remain identical and must not trigger a fresh filesystem read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import type { CanonicalToolResult } from '../../src/shared/types/tool-result';
import { serializeCanonicalResultForCopy } from '../../src/shared/types/tool-result';
import type { BgCommandSnapshotFound } from '../../src/shared/types/ipc';
import type { ToolBlock } from '../../src/renderer/hooks/useChat';
import { DirectoryToolResult } from '../../src/renderer/components/ToolResults/DirectoryToolResult';
import { SearchToolResult } from '../../src/renderer/components/ToolResults/SearchToolResult';
import { GenericToolResult } from '../../src/renderer/components/ToolResults/GenericToolResult';
import { ToolCallBlock } from '../../src/renderer/components/ToolCallBlock';
import { resetToolResultExpansionState } from '../../src/renderer/components/ToolResults/ToolResultShell';

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

/**
 * Background-command replay gating — the deliberately revised contract: a
 * replayed background result mounts the live process widget, which polls
 * once and freezes when the first snapshot reports the command exited or
 * unavailable. Long-dead sessions cost one snapshot per widget.
 */
describe('background command replay gating', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetToolResultExpansionState();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    resetToolResultExpansionState();
  });

  it('mounts the live widget for a replayed background result and freezes after one exited snapshot', async () => {
    const exited: BgCommandSnapshotFound = {
      found: true,
      tail: 'boom\n',
      exitCode: 3,
      running: false,
      interactive: false,
      owner: 'AGENT',
      command: 'npm run build',
      agentScopeId: 'main',
    };
    const snapshot = vi.fn().mockResolvedValue(exited);
    vi.stubGlobal('orchid', {
      bgCmd: {
        snapshot,
        sendInput: vi.fn().mockResolvedValue({ ok: true }),
        terminate: vi.fn().mockResolvedValue({ ok: true }),
        releaseInput: vi.fn().mockResolvedValue({ ok: true }),
      },
    });

    const canonical: CanonicalToolResult = {
      schemaVersion: 1,
      family: 'generic',
      status: 'complete',
      completeness: 'complete',
      data: {
        value: {
          commandId: 7,
          command: 'npm run build',
          background: true,
          running: true,
        },
      },
    };
    const block: ToolBlock = {
      id: 'bg-replay-freeze',
      toolName: 'execute_command',
      status: 'completed',
      partialArgs: '',
      args: JSON.stringify({ command: 'npm run build', background: true }),
      agentProjection: null,
      toolResult: canonical,
      startedAt: '2026-08-04T00:00:00.000Z',
      finishedAt: '2026-08-04T00:00:01.000Z',
    };

    const { container } = render(
      createElement(ToolCallBlock, { block, sessionId: 'sess-replay' }),
    );
    fireEvent.click(container.querySelector('.orchid-tool-block-title') as HTMLElement);
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.querySelector('.orchid-live-command')).toBeTruthy();
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(snapshot).toHaveBeenCalledWith(expect.objectContaining({
      commandId: 7,
      lastN: 50,
      sessionId: 'sess-replay',
    }));
    // The exited snapshot freezes the widget and surfaces the exit code.
    expect(container.querySelector('.orchid-live-command-title')?.textContent).toContain('exit 3');

    // No further polling once the process reports terminal.
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(snapshot).toHaveBeenCalledTimes(1);
  });
});
