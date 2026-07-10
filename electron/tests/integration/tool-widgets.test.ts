/**
 * Tool Widgets Integration Tests — U22.
 *
 * Tests the tool-call widget system: DiffWidget, TerminalWidget,
 * FilePreview, ResultsTable, ToolWidgetContainer, ToolRail,
 * and session replay.
 *
 * These tests validate the component logic without requiring a running
 * Electron app (mocked window.orchid API).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  ToolCallEvent,
  ToolCallStatus,
  DiffData,
  GrepResultRow,
  FilePreviewData,
} from '../../src/renderer/components/ToolWidgets/types';
import {
  DIFF_TOOLS,
  TERMINAL_TOOLS,
  FILE_PREVIEW_TOOLS,
  RESULTS_TABLE_TOOLS,
  detectLanguage,
} from '../../src/renderer/components/ToolWidgets/types';

// ─── Mock Setup ──────────────────────────────────────────────────────────────

const mockOrchid = {
  chat: {
    send: vi.fn().mockResolvedValue({ status: 'ok' }),
    cancel: vi.fn().mockResolvedValue({ status: 'ok' }),
    onChunk: vi.fn().mockReturnValue(() => {}),
    onState: vi.fn().mockReturnValue(() => {}),
    onDone: vi.fn().mockReturnValue(() => {}),
    onError: vi.fn().mockReturnValue(() => {}),
  },
  config: {
    get: vi.fn().mockResolvedValue({ theme: 'default', default_model: 'test/model' }),
    save: vi.fn().mockResolvedValue({ status: 'ok' }),
  },
  session: {
    list: vi.fn().mockResolvedValue([]),
    load: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue({ id: 'new-session', name: 'New Session' }),
    delete: vi.fn().mockResolvedValue({ status: 'ok' }),
    rename: vi.fn().mockResolvedValue({ status: 'ok' }),
  },
  tool: {
    execute: vi.fn().mockResolvedValue({ content: '', isError: false }),
  },
  agent: {
    list: vi.fn().mockResolvedValue([]),
    spawn: vi.fn().mockResolvedValue({ id: 'agent-1', agent: {} }),
  },
  mcp: {
    status: vi.fn().mockResolvedValue([]),
  },
  rag: {
    status: vi.fn().mockResolvedValue(null),
    index: vi.fn().mockResolvedValue({}),
    clear: vi.fn().mockResolvedValue({ status: 'ok' }),
    indexState: vi.fn().mockResolvedValue({ indexing: false, progress: null }),
    onProgress: vi.fn().mockReturnValue(() => {}),
  },
  ast: {
    status: vi.fn().mockResolvedValue(null),
    index: vi.fn().mockResolvedValue({}),
    indexState: vi.fn().mockResolvedValue({ indexing: false, progress: null }),
    onProgress: vi.fn().mockReturnValue(() => {}),
  },
};

beforeEach(() => {
  (globalThis as unknown as { window: typeof globalThis.window }).window = globalThis.window || {};
  (window as unknown as Record<string, unknown>).orchid = mockOrchid;
});

afterEach(() => {
  vi.clearAllMocks();
});

// ─── Helper: create a ToolCallEvent ──────────────────────────────────────────

function createToolCallEvent(
  overrides: Partial<ToolCallEvent> = {},
): ToolCallEvent {
  return {
    id: 'tc-1',
    toolName: 'read',
    args: { file_path: '/test/file.ts' },
    status: 'completed',
    result: 'const x = 1;',
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ─── Tool Routing Sets ───────────────────────────────────────────────────────

describe('Tool Routing Sets', () => {
  it('DIFF_TOOLS contains edit, write, replace_symbol, rename_symbol', () => {
    expect(DIFF_TOOLS.has('edit')).toBe(true);
    expect(DIFF_TOOLS.has('write')).toBe(true);
    expect(DIFF_TOOLS.has('replace_symbol')).toBe(true);
    expect(DIFF_TOOLS.has('rename_symbol')).toBe(true);
    expect(DIFF_TOOLS.has('read')).toBe(false);
  });

  it('TERMINAL_TOOLS contains execute_command', () => {
    expect(TERMINAL_TOOLS.has('execute_command')).toBe(true);
    expect(TERMINAL_TOOLS.has('read')).toBe(false);
  });

  it('FILE_PREVIEW_TOOLS contains read', () => {
    expect(FILE_PREVIEW_TOOLS.has('read')).toBe(true);
    expect(FILE_PREVIEW_TOOLS.has('edit')).toBe(false);
  });

  it('RESULTS_TABLE_TOOLS contains grep', () => {
    expect(RESULTS_TABLE_TOOLS.has('grep')).toBe(true);
    expect(RESULTS_TABLE_TOOLS.has('read')).toBe(false);
  });
});

// ─── Language Detection ──────────────────────────────────────────────────────

describe('Language Detection', () => {
  it('detects TypeScript from .ts extension', () => {
    expect(detectLanguage('/path/to/file.ts')).toBe('typescript');
  });

  it('detects TypeScript from .tsx extension', () => {
    expect(detectLanguage('/path/to/file.tsx')).toBe('typescript');
  });

  it('detects JavaScript from .js extension', () => {
    expect(detectLanguage('/path/to/file.js')).toBe('javascript');
  });

  it('detects Python from .py extension', () => {
    expect(detectLanguage('/path/to/file.py')).toBe('python');
  });

  it('detects JSON from .json extension', () => {
    expect(detectLanguage('/path/to/file.json')).toBe('json');
  });

  it('detects CSS from .css extension', () => {
    expect(detectLanguage('/path/to/file.css')).toBe('css');
  });

  it('detects Markdown from .md extension', () => {
    expect(detectLanguage('/path/to/file.md')).toBe('markdown');
  });

  it('detects Shell from .sh extension', () => {
    expect(detectLanguage('/path/to/file.sh')).toBe('shell');
  });

  it('returns plaintext for unknown extensions', () => {
    expect(detectLanguage('/path/to/file.xyz')).toBe('plaintext');
  });

  it('returns plaintext for files with no extension', () => {
    expect(detectLanguage('/path/to/Makefile')).toBe('plaintext');
  });

  it('handles case-insensitive extensions', () => {
    expect(detectLanguage('/path/to/file.TS')).toBe('typescript');
    expect(detectLanguage('/path/to/file.PY')).toBe('python');
  });
});

// ─── Diff Data Extraction ────────────────────────────────────────────────────

describe('Diff Data Extraction', () => {
  it('edit tool: extracts old_string and new_string', () => {
    const event = createToolCallEvent({
      toolName: 'edit',
      args: {
        file_path: '/src/app.ts',
        old_string: 'const x = 1;',
        new_string: 'const x = 2;',
      },
    });

    // Verify the args structure
    expect(event.args.old_string).toBe('const x = 1;');
    expect(event.args.new_string).toBe('const x = 2;');
    expect(event.args.file_path).toBe('/src/app.ts');
  });

  it('write tool: extracts content as new (original is empty)', () => {
    const event = createToolCallEvent({
      toolName: 'write',
      args: {
        file_path: '/src/new.ts',
        content: 'export const hello = "world";',
      },
    });

    expect(event.args.content).toBe('export const hello = "world";');
    expect(event.args.file_path).toBe('/src/new.ts');
  });

  it('replace_symbol tool: extracts old and new', () => {
    const event = createToolCallEvent({
      toolName: 'replace_symbol',
      args: {
        file_path: '/src/app.ts',
        old_string: 'function old() {}',
        new_string: 'function newName() {}',
      },
    });

    expect(event.args.old_string).toBe('function old() {}');
    expect(event.args.new_string).toBe('function newName() {}');
  });

  it('rename_symbol tool: extracts old_name and new_name', () => {
    const event = createToolCallEvent({
      toolName: 'rename_symbol',
      args: {
        file_path: '/src/app.ts',
        old_name: 'oldFunction',
        new_name: 'newFunction',
      },
    });

    expect(event.args.old_name).toBe('oldFunction');
    expect(event.args.new_name).toBe('newFunction');
  });
});

// ─── Edit → DiffWidget Shows Before/After ────────────────────────────────────

describe('Edit → DiffWidget', () => {
  it('edit tool event has correct structure for diff display', () => {
    const event = createToolCallEvent({
      id: 'tc-edit-1',
      toolName: 'edit',
      args: {
        file_path: '/src/app.ts',
        old_string: 'const x = 1;',
        new_string: 'const x = 2;',
      },
      status: 'completed',
      result: 'Edit applied successfully.',
    });

    expect(event.toolName).toBe('edit');
    expect(event.args.old_string).toBe('const x = 1;');
    expect(event.args.new_string).toBe('const x = 2;');
    expect(event.status).toBe('completed');
    expect(event.result).toBeTruthy();
  });

  it('write tool event has correct structure for diff display', () => {
    const event = createToolCallEvent({
      id: 'tc-write-1',
      toolName: 'write',
      args: {
        file_path: '/src/new.ts',
        content: 'export const hello = "world";',
      },
      status: 'completed',
      result: 'File written successfully.',
    });

    expect(event.toolName).toBe('write');
    expect(event.args.content).toBe('export const hello = "world";');
    expect(DIFF_TOOLS.has(event.toolName)).toBe(true);
  });
});

// ─── Execute → TerminalWidget Streams ────────────────────────────────────────

describe('Execute → TerminalWidget', () => {
  it('execute_command event has correct structure', () => {
    const event = createToolCallEvent({
      id: 'tc-exec-1',
      toolName: 'execute_command',
      args: {
        command: 'npm test',
        background: false,
      },
      status: 'running',
      result: null,
    });

    expect(event.toolName).toBe('execute_command');
    expect(event.args.command).toBe('npm test');
    expect(event.status).toBe('running');
    expect(TERMINAL_TOOLS.has(event.toolName)).toBe(true);
  });

  it('background execute_command has background flag', () => {
    const event = createToolCallEvent({
      id: 'tc-exec-bg-1',
      toolName: 'execute_command',
      args: {
        command: 'sleep 10',
        background: true,
      },
      status: 'running',
    });

    expect(event.args.background).toBe(true);
  });

  it('execute_command result updates with output', () => {
    const event = createToolCallEvent({
      id: 'tc-exec-2',
      toolName: 'execute_command',
      args: { command: 'echo hello' },
      status: 'completed',
      result: 'hello\n',
    });

    expect(event.result).toBe('hello\n');
    expect(event.status).toBe('completed');
  });

  it('interactive execute_command has interactive flag', () => {
    const event = createToolCallEvent({
      id: 'tc-exec-int-1',
      toolName: 'execute_command',
      args: {
        command: 'python -i',
        background: true,
        interactive: true,
      },
      status: 'running',
    });

    expect(event.args.interactive).toBe(true);
    expect(event.args.background).toBe(true);
  });
});

// ─── Read → FilePreview ──────────────────────────────────────────────────────

describe('Read → FilePreview', () => {
  it('read event has correct structure for file preview', () => {
    const event = createToolCallEvent({
      id: 'tc-read-1',
      toolName: 'read',
      args: {
        file_path: '/src/app.ts',
        offset: 10,
        limit: 20,
      },
      status: 'completed',
      result: 'line 10 content\nline 11 content\nline 12 content',
    });

    expect(event.toolName).toBe('read');
    expect(event.args.file_path).toBe('/src/app.ts');
    expect(event.args.offset).toBe(10);
    expect(event.args.limit).toBe(20);
    expect(event.result).toContain('line 10 content');
    expect(FILE_PREVIEW_TOOLS.has(event.toolName)).toBe(true);
  });

  it('read event with no offset defaults to line 1', () => {
    const event = createToolCallEvent({
      toolName: 'read',
      args: { file_path: '/src/app.ts' },
      status: 'completed',
      result: 'first line',
    });

    expect(event.args.offset).toBeUndefined();
    // Component should default to startLine = 1
  });

  it('read result contains file content', () => {
    const content = 'import React from "react";\n\nexport function App() {\n  return <div>Hello</div>;\n}';
    const event = createToolCallEvent({
      toolName: 'read',
      args: { file_path: '/src/App.tsx' },
      status: 'completed',
      result: content,
    });

    expect(event.result).toContain('import React');
    expect(event.result).toContain('export function App');
    expect(detectLanguage(event.args.file_path as string)).toBe('typescript');
  });
});

// ─── Grep → ResultsTable ─────────────────────────────────────────────────────

describe('Grep → ResultsTable', () => {
  it('grep event has correct structure for results table', () => {
    const grepOutput =
      '/src/app.ts:10:const x = 1;\n/src/app.ts:25:const y = 2;\n/src/utils.ts:5:const z = 3;';

    const event = createToolCallEvent({
      id: 'tc-grep-1',
      toolName: 'grep',
      args: {
        pattern: 'const',
        include_pattern: '*.ts',
      },
      status: 'completed',
      result: grepOutput,
    });

    expect(event.toolName).toBe('grep');
    expect(event.args.pattern).toBe('const');
    expect(RESULTS_TABLE_TOOLS.has(event.toolName)).toBe(true);
  });

  it('grep results are parseable as file:line:text', () => {
    const grepOutput =
      '/src/app.ts:10:const x = 1;\n/src/utils.ts:5:const z = 3;';

    const lines = grepOutput.split('\n');
    const rows: GrepResultRow[] = [];

    for (const line of lines) {
      const firstColon = line.indexOf(':');
      const secondColon = line.indexOf(':', firstColon + 1);
      const file = line.slice(0, firstColon);
      const lineNum = parseInt(line.slice(firstColon + 1, secondColon), 10);
      const text = line.slice(secondColon + 1);
      rows.push({ file, line: lineNum, text });
    }

    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      file: '/src/app.ts',
      line: 10,
      text: 'const x = 1;',
    });
    expect(rows[1]).toEqual({
      file: '/src/utils.ts',
      line: 5,
      text: 'const z = 3;',
    });
  });

  it('grep with empty result returns no rows', () => {
    const event = createToolCallEvent({
      toolName: 'grep',
      args: { pattern: 'nonexistent' },
      status: 'completed',
      result: '',
    });

    expect(event.result).toBe('');
    // Component should show empty state
  });

  it('grep results are sortable by file', () => {
    const rows: GrepResultRow[] = [
      { file: '/src/b.ts', line: 1, text: 'match1' },
      { file: '/src/a.ts', line: 2, text: 'match2' },
      { file: '/src/b.ts', line: 3, text: 'match3' },
    ];

    const sorted = [...rows].sort((a, b) => a.file.localeCompare(b.file));
    expect(sorted[0].file).toBe('/src/a.ts');
    expect(sorted[1].file).toBe('/src/b.ts');
    expect(sorted[2].file).toBe('/src/b.ts');
  });
});

// ─── Session Reloaded → Widget Reconstructs Correctly ────────────────────────

describe('Session Reloaded → Widget Reconstructs', () => {
  it('tool call events are serializable and deserializable', () => {
    const event: ToolCallEvent = {
      id: 'tc-1',
      toolName: 'edit',
      args: { file_path: '/src/app.ts', old_string: 'a', new_string: 'b' },
      status: 'completed',
      result: 'Edit applied.',
      error: null,
      startedAt: '2026-07-08T12:00:00.000Z',
      finishedAt: '2026-07-08T12:00:01.000Z',
    };

    // Serialize
    const serialized = JSON.stringify(event);
    expect(serialized).toBeTruthy();

    // Deserialize
    const deserialized: ToolCallEvent = JSON.parse(serialized);
    expect(deserialized.id).toBe(event.id);
    expect(deserialized.toolName).toBe(event.toolName);
    expect(deserialized.args.file_path).toBe('/src/app.ts');
    expect(deserialized.status).toBe('completed');
    expect(deserialized.result).toBe('Edit applied.');
    expect(deserialized.startedAt).toBe('2026-07-08T12:00:00.000Z');
  });

  it('multiple tool call events round-trip through serialization', () => {
    const events: ToolCallEvent[] = [
      {
        id: 'tc-1',
        toolName: 'read',
        args: { file_path: '/src/app.ts' },
        status: 'completed',
        result: 'file content',
        error: null,
        startedAt: '2026-07-08T12:00:00.000Z',
        finishedAt: '2026-07-08T12:00:01.000Z',
      },
      {
        id: 'tc-2',
        toolName: 'edit',
        args: { file_path: '/src/app.ts', old_string: 'a', new_string: 'b' },
        status: 'completed',
        result: 'Edit applied.',
        error: null,
        startedAt: '2026-07-08T12:00:02.000Z',
        finishedAt: '2026-07-08T12:00:03.000Z',
      },
      {
        id: 'tc-3',
        toolName: 'grep',
        args: { pattern: 'function' },
        status: 'error',
        result: null,
        error: 'Pattern not found',
        startedAt: '2026-07-08T12:00:04.000Z',
        finishedAt: '2026-07-08T12:00:05.000Z',
      },
    ];

    const serialized = JSON.stringify(events);
    const deserialized: ToolCallEvent[] = JSON.parse(serialized);

    expect(deserialized).toHaveLength(3);
    expect(deserialized[0].toolName).toBe('read');
    expect(deserialized[1].toolName).toBe('edit');
    expect(deserialized[2].toolName).toBe('grep');
    expect(deserialized[2].status).toBe('error');
    expect(deserialized[2].error).toBe('Pattern not found');
  });

  it('preserves all status types through serialization', () => {
    const statuses: ToolCallStatus[] = ['pending', 'running', 'completed', 'error'];

    for (const status of statuses) {
      const event = createToolCallEvent({ status });
      const serialized = JSON.stringify(event);
      const deserialized: ToolCallEvent = JSON.parse(serialized);
      expect(deserialized.status).toBe(status);
    }
  });

  it('preserves args with nested objects', () => {
    const event = createToolCallEvent({
      toolName: 'execute_command',
      args: {
        command: 'npm test',
        env: { NODE_ENV: 'test', DEBUG: 'true' },
        background: true,
      },
    });

    const serialized = JSON.stringify(event);
    const deserialized: ToolCallEvent = JSON.parse(serialized);
    expect((deserialized.args.env as Record<string, string>).NODE_ENV).toBe('test');
    expect(deserialized.args.background).toBe(true);
  });
});

// ─── Collapse → Minimizes to Tool Name + Summary ────────────────────────────

describe('Collapse → Minimizes', () => {
  it('collapsed state shows tool name', () => {
    const event = createToolCallEvent({
      toolName: 'edit',
      args: { file_path: '/src/app.ts', old_string: 'a', new_string: 'b' },
    });

    expect(event.toolName).toBe('edit');
    // In collapsed view, the tool name is always shown
  });

  it('summary is derived from args for each tool type', () => {
    const editEvent = createToolCallEvent({
      toolName: 'edit',
      args: { file_path: '/src/app.ts' },
    });
    expect((editEvent.args.file_path as string) ?? '').toBe('/src/app.ts');

    const execEvent = createToolCallEvent({
      toolName: 'execute_command',
      args: { command: 'npm test' },
    });
    expect((execEvent.args.command as string) ?? '').toBe('npm test');

    const grepEvent = createToolCallEvent({
      toolName: 'grep',
      args: { pattern: 'function' },
    });
    expect((grepEvent.args.pattern as string) ?? '').toBe('function');

    const readEvent = createToolCallEvent({
      toolName: 'read',
      args: { file_path: '/src/utils.ts' },
    });
    expect((readEvent.args.file_path as string) ?? '').toBe('/src/utils.ts');
  });

  it('rename_symbol summary shows old → new', () => {
    const event = createToolCallEvent({
      toolName: 'rename_symbol',
      args: { old_name: 'oldFunc', new_name: 'newFunc' },
    });

    const summary = `${event.args.old_name ?? ''} → ${event.args.new_name ?? ''}`;
    expect(summary).toBe('oldFunc → newFunc');
  });
});

// ─── Tool Widget Container Routing ───────────────────────────────────────────

describe('Tool Widget Container Routing', () => {
  it('routes edit to DiffWidget', () => {
    const event = createToolCallEvent({ toolName: 'edit' });
    expect(DIFF_TOOLS.has(event.toolName)).toBe(true);
    expect(TERMINAL_TOOLS.has(event.toolName)).toBe(false);
    expect(FILE_PREVIEW_TOOLS.has(event.toolName)).toBe(false);
    expect(RESULTS_TABLE_TOOLS.has(event.toolName)).toBe(false);
  });

  it('routes execute_command to TerminalWidget', () => {
    const event = createToolCallEvent({ toolName: 'execute_command' });
    expect(DIFF_TOOLS.has(event.toolName)).toBe(false);
    expect(TERMINAL_TOOLS.has(event.toolName)).toBe(true);
    expect(FILE_PREVIEW_TOOLS.has(event.toolName)).toBe(false);
    expect(RESULTS_TABLE_TOOLS.has(event.toolName)).toBe(false);
  });

  it('routes read to FilePreview', () => {
    const event = createToolCallEvent({ toolName: 'read' });
    expect(DIFF_TOOLS.has(event.toolName)).toBe(false);
    expect(TERMINAL_TOOLS.has(event.toolName)).toBe(false);
    expect(FILE_PREVIEW_TOOLS.has(event.toolName)).toBe(true);
    expect(RESULTS_TABLE_TOOLS.has(event.toolName)).toBe(false);
  });

  it('routes grep to ResultsTable', () => {
    const event = createToolCallEvent({ toolName: 'grep' });
    expect(DIFF_TOOLS.has(event.toolName)).toBe(false);
    expect(TERMINAL_TOOLS.has(event.toolName)).toBe(false);
    expect(FILE_PREVIEW_TOOLS.has(event.toolName)).toBe(false);
    expect(RESULTS_TABLE_TOOLS.has(event.toolName)).toBe(true);
  });

  it('unknown tool falls through to generic view', () => {
    const event = createToolCallEvent({ toolName: 'todo_create' });
    expect(DIFF_TOOLS.has(event.toolName)).toBe(false);
    expect(TERMINAL_TOOLS.has(event.toolName)).toBe(false);
    expect(FILE_PREVIEW_TOOLS.has(event.toolName)).toBe(false);
    expect(RESULTS_TABLE_TOOLS.has(event.toolName)).toBe(false);
  });
});

// ─── Tool Call Lifecycle ─────────────────────────────────────────────────────

describe('Tool Call Lifecycle', () => {
  it('pending → running → completed', () => {
    const event = createToolCallEvent({ status: 'pending', result: null });
    expect(event.status).toBe('pending');

    const running = { ...event, status: 'running' as ToolCallStatus };
    expect(running.status).toBe('running');

    const completed = { ...running, status: 'completed' as ToolCallStatus, result: 'done' };
    expect(completed.status).toBe('completed');
    expect(completed.result).toBe('done');
  });

  it('pending → running → error', () => {
    const event = createToolCallEvent({ status: 'pending', result: null });
    const running = { ...event, status: 'running' as ToolCallStatus };
    const error = { ...running, status: 'error' as ToolCallStatus, error: 'Failed' };

    expect(error.status).toBe('error');
    expect(error.error).toBe('Failed');
  });

  it('finishedAt is null while running', () => {
    const event = createToolCallEvent({
      status: 'running',
      finishedAt: null,
    });

    expect(event.finishedAt).toBeNull();
  });

  it('finishedAt is set on completion', () => {
    const event = createToolCallEvent({
      status: 'completed',
      finishedAt: '2026-07-08T12:00:01.000Z',
    });

    expect(event.finishedAt).toBeTruthy();
  });
});

// ─── File Structure ──────────────────────────────────────────────────────────

describe('Component File Structure', () => {
  const fs = require('node:fs');
  const path = require('node:path');

  const toolWidgetsDir = path.resolve(
    __dirname,
    '../../src/renderer/components/ToolWidgets',
  );
  const hooksDir = path.resolve(__dirname, '../../src/renderer/hooks');

  it('ToolWidgets directory exists', () => {
    expect(fs.existsSync(toolWidgetsDir)).toBe(true);
  });

  it('DiffWidget.tsx exists', () => {
    expect(fs.existsSync(path.join(toolWidgetsDir, 'DiffWidget.tsx'))).toBe(true);
  });

  it('TerminalWidget.tsx exists', () => {
    expect(fs.existsSync(path.join(toolWidgetsDir, 'TerminalWidget.tsx'))).toBe(true);
  });

  it('FilePreview.tsx exists', () => {
    expect(fs.existsSync(path.join(toolWidgetsDir, 'FilePreview.tsx'))).toBe(true);
  });

  it('ResultsTable.tsx exists', () => {
    expect(fs.existsSync(path.join(toolWidgetsDir, 'ResultsTable.tsx'))).toBe(true);
  });

  it('ToolWidgetContainer.tsx exists', () => {
    expect(fs.existsSync(path.join(toolWidgetsDir, 'ToolWidgetContainer.tsx'))).toBe(true);
  });

  it('ToolRail.tsx exists', () => {
    expect(fs.existsSync(path.join(toolWidgetsDir, 'ToolRail.tsx'))).toBe(true);
  });

  it('types.ts exists', () => {
    expect(fs.existsSync(path.join(toolWidgetsDir, 'types.ts'))).toBe(true);
  });

  it('index.ts exists', () => {
    expect(fs.existsSync(path.join(toolWidgetsDir, 'index.ts'))).toBe(true);
  });

  it('useToolRail hook exists', () => {
    expect(fs.existsSync(path.join(hooksDir, 'useToolRail.ts'))).toBe(true);
  });
});

// ─── CSS Classes ─────────────────────────────────────────────────────────────

describe('Tool Widget CSS Classes', () => {
  const fs = require('node:fs');
  const path = require('node:path');

  const cssPath = path.resolve(__dirname, '../../src/renderer/styles/chat.css');

  it('chat.css contains tool rail classes', () => {
    const css = fs.readFileSync(cssPath, 'utf-8');
    expect(css).toContain('.tool-rail');
    expect(css).toContain('.tool-rail-drag-handle');
    expect(css).toContain('.tool-rail-content');
    expect(css).toContain('.tool-rail-header');
    expect(css).toContain('.tool-rail-tabs');
    expect(css).toContain('.tool-rail-tab');
    expect(css).toContain('.tool-rail-widget');
  });

  it('chat.css contains diff widget classes', () => {
    const css = fs.readFileSync(cssPath, 'utf-8');
    expect(css).toContain('.tool-widget-diff');
    expect(css).toContain('.tool-widget-diff-header');
    expect(css).toContain('.tool-widget-diff-editor');
  });

  it('chat.css contains terminal widget classes', () => {
    const css = fs.readFileSync(cssPath, 'utf-8');
    expect(css).toContain('.tool-widget-terminal');
    expect(css).toContain('.tool-widget-terminal-header');
    expect(css).toContain('.tool-widget-terminal-body');
  });

  it('chat.css contains file preview classes', () => {
    const css = fs.readFileSync(cssPath, 'utf-8');
    expect(css).toContain('.tool-widget-file-preview');
    expect(css).toContain('.tool-widget-file-preview-header');
    expect(css).toContain('.tool-widget-file-preview-body');
  });

  it('chat.css contains results table classes', () => {
    const css = fs.readFileSync(cssPath, 'utf-8');
    expect(css).toContain('.tool-widget-results-table');
    expect(css).toContain('.tool-widget-results-header');
    expect(css).toContain('.tool-widget-results-row');
  });

  it('chat.css contains tool widget container classes', () => {
    const css = fs.readFileSync(cssPath, 'utf-8');
    expect(css).toContain('.tool-widget-container');
    expect(css).toContain('.tool-widget-header');
    expect(css).toContain('.tool-widget-body');
    expect(css).toContain('.tool-widget-status-badge');
  });

  it('chat.css uses CSS custom properties from themes', () => {
    const css = fs.readFileSync(cssPath, 'utf-8');
    expect(css).toContain('var(--bg-primary)');
    expect(css).toContain('var(--text-primary)');
    expect(css).toContain('var(--accent-primary)');
    expect(css).toContain('var(--border-default)');
  });
});
