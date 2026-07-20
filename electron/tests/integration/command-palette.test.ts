/**
 * Command Palette Integration Tests — U21.
 *
 * Tests the command palette component, fuzzy search, keyboard navigation,
 * command execution, and sub-pickers.
 * These tests validate the component logic without requiring a running
 * Electron app (mocked window.orchid API).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SessionSummary } from '../../src/main/session/storage';
import type { CommandContext } from '../../src/shared/types/ipc-boundary';
import {
  COMMANDS,
  getRecentCommands,
  trackRecentCommand,
  buildThemeResults,
  buildPersonalityResults,
  fuzzyMatch,
} from '../../src/renderer/commands/registry';
import {
  eventMatchesChord,
  getShortcut,
} from '../../src/renderer/keyboard';

const findCommand = (name: string) =>
  COMMANDS.find((command) => command.name === name);

// ─── Mock Setup ──────────────────────────────────────────────────────────────

// Mock window.orchid API
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

// Mock localStorage
const localStorageMock: Record<string, string> = {};
const mockLocalStorage = {
  getItem: vi.fn((key: string) => localStorageMock[key] ?? null),
  setItem: vi.fn((key: string, value: string) => {
    localStorageMock[key] = value;
  }),
  removeItem: vi.fn((key: string) => {
    delete localStorageMock[key];
  }),
  clear: vi.fn(() => {
    for (const key of Object.keys(localStorageMock)) {
      delete localStorageMock[key];
    }
  }),
};

// Setup globals
beforeEach(() => {
  (globalThis as unknown as { window: typeof globalThis.window }).window = globalThis.window || {};
  (window as unknown as Record<string, unknown>).orchid = mockOrchid;
  Object.defineProperty(globalThis, 'localStorage', { value: mockLocalStorage, writable: true });
  mockLocalStorage.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ─── Command Registry ────────────────────────────────────────────────────────

describe('Command Registry', () => {
  it('all 12 commands are registered', () => {
    expect(COMMANDS).toHaveLength(12);
  });

  it('all command names are defined', () => {
    const names = COMMANDS.map((command) => command.name);
    expect(names).toContain('/new');
    expect(names).toContain('/sessions');
    expect(names).toContain('/rename');
    expect(names).toContain('/delete');
    expect(names).toContain('/model');
    expect(names).toContain('/theme');
    expect(names).toContain('/personality');
    expect(names).toContain('/settings');
    expect(names).toContain('/cd');
    expect(names).toContain('/rag index');
    expect(names).toContain('/ast index');
    expect(names).toContain('/rag clear');
    expect(names).not.toContain('/rag status');
    expect(names).not.toContain('/index-rag');
    expect(names).not.toContain('/index-ast');
  });

  it('all commands have required fields', () => {
    for (const cmd of COMMANDS) {
      expect(cmd.name).toBeTruthy();
      expect(cmd.description).toBeTruthy();
      expect(cmd.category).toBeTruthy();
      expect(typeof cmd.execute).toBe('function');
    }
  });

  it('all commands have category "commands"', () => {
    for (const cmd of COMMANDS) {
      expect(cmd.category).toBe('commands');
    }
  });
});

// ─── Fuzzy Search ────────────────────────────────────────────────────────────

describe('Fuzzy Search', () => {
  it('exact prefix match gets highest score', () => {
    const score = fuzzyMatch('mod', '/model');
    expect(score).toBeGreaterThan(0);
  });

  it('fuzzy match: "mod" matches "/model"', () => {
    const score = fuzzyMatch('mod', '/model');
    expect(score).toBeGreaterThan(0);
  });

  it('fuzzy match: "mod" does NOT match "/rename"', () => {
    const score = fuzzyMatch('mod', '/rename');
    expect(score).toBe(-1);
  });

  it('fuzzy match: "ses" matches "/sessions"', () => {
    const score = fuzzyMatch('ses', '/sessions');
    expect(score).toBeGreaterThan(0);
  });

  it('fuzzy match: "ses" matches session names with "ses"', () => {
    const score = fuzzyMatch('ses', 'My Session');
    expect(score).toBeGreaterThan(0);
  });

  it('fuzzy match: "new" matches "/new"', () => {
    const score = fuzzyMatch('new', '/new');
    expect(score).toBeGreaterThan(0);
  });

  it('fuzzy match: "thm" matches "/theme"', () => {
    const score = fuzzyMatch('thm', '/theme');
    expect(score).toBeGreaterThan(0);
  });

  it('fuzzy match: "rag" matches "/rag index"', () => {
    const score = fuzzyMatch('rag', '/rag index');
    expect(score).toBeGreaterThan(0);
  });

  it('fuzzy match: "ast" matches "/ast index"', () => {
    const score = fuzzyMatch('ast', '/ast index');
    expect(score).toBeGreaterThan(0);
  });

  it('fuzzy match: "set" matches "/settings"', () => {
    const score = fuzzyMatch('set', '/settings');
    expect(score).toBeGreaterThan(0);
  });

  it('fuzzy match: empty query matches everything', () => {
    const score = fuzzyMatch('', '/anything');
    expect(score).toBeGreaterThan(0);
  });

  it('fuzzy match: non-matching query returns -1', () => {
    const score = fuzzyMatch('xyz', '/model');
    expect(score).toBe(-1);
  });

  it('fuzzy match: consecutive characters get bonus', () => {
    const score1 = fuzzyMatch('mod', '/model');
    const score2 = fuzzyMatch('mod', '/m-o-d-e-l');
    // Consecutive match should score higher
    expect(score1).toBeGreaterThan(score2);
  });

  it('fuzzy match: word boundary gets bonus', () => {
    // Use same-length texts so length bonus doesn't skew results
    const score1 = fuzzyMatch('new', '/new abc'); // boundary match at pos 1
    const score2 = fuzzyMatch('new', '/xnewabc'); // no boundary match
    // Word boundary match should score higher
    expect(score1).toBeGreaterThan(score2);
  });
});

// ─── Recent Commands ─────────────────────────────────────────────────────────

describe('Recent Commands', () => {
  it('getRecentCommands returns empty array initially', () => {
    const recent = getRecentCommands();
    expect(recent).toEqual([]);
  });

  it('trackRecentCommand stores command in localStorage', () => {
    trackRecentCommand('/new');
    const recent = getRecentCommands();
    expect(recent).toEqual(['/new']);
  });

  it('trackRecentCommand moves command to front if already exists', () => {
    trackRecentCommand('/new');
    trackRecentCommand('/model');
    trackRecentCommand('/new');
    const recent = getRecentCommands();
    expect(recent).toEqual(['/new', '/model']);
  });

  it('trackRecentCommand limits to 5 recent commands', () => {
    trackRecentCommand('/new');
    trackRecentCommand('/model');
    trackRecentCommand('/theme');
    trackRecentCommand('/sessions');
    trackRecentCommand('/delete');
    trackRecentCommand('/rename');
    const recent = getRecentCommands();
    expect(recent).toHaveLength(5);
    expect(recent[0]).toBe('/rename');
    expect(recent).not.toContain('/new');
  });

  it('getRecentCommands handles corrupted localStorage gracefully', () => {
    mockLocalStorage.setItem('orchid-recent-commands', 'not-json');
    const recent = getRecentCommands();
    expect(recent).toEqual([]);
  });
});

// ─── Theme Results ───────────────────────────────────────────────────────────

describe('Theme Results', () => {
  it('buildThemeResults returns all 6 themes', () => {
    const results = buildThemeResults('default');
    expect(results).toHaveLength(6);
  });

  it('buildThemeResults marks current theme with filled circle', () => {
    const results = buildThemeResults('bluey');
    const bluey = results.find((r) => r.value === 'bluey');
    expect(bluey?.icon).toBe('\u25cf');
    const other = results.find((r) => r.value === 'default');
    expect(other?.icon).toBe('\u25cb');
  });

  it('buildThemeResults has correct action type', () => {
    const results = buildThemeResults('default');
    for (const result of results) {
      expect(result.action).toBe('theme');
      expect(result.commandName).toBe('/theme');
      expect(result.category).toBe('commands');
    }
  });

  it('buildThemeResults includes all theme names', () => {
    const results = buildThemeResults('default');
    const values = results.map((r) => r.value);
    expect(values).toContain('default');
    expect(values).toContain('light');
    expect(values).toContain('solarized-light');
    expect(values).toContain('bluey');
    expect(values).toContain('windows-xp');
    expect(values).toContain('green-terminal');
  });
});

// ─── Personality Results ─────────────────────────────────────────────────────

const DISK_PERSONALITIES = ['default', 'meow', 'pirate', 'socrates', 'stupid', 'zen'];

describe('Personality Results', () => {
  it('buildPersonalityResults returns personalities from the provided list', () => {
    const results = buildPersonalityResults('default', DISK_PERSONALITIES);
    expect(results).toHaveLength(6);
    expect(results.map((r) => r.value)).toEqual(DISK_PERSONALITIES);
  });

  it('buildPersonalityResults returns empty when no names provided', () => {
    const results = buildPersonalityResults('default');
    expect(results).toHaveLength(0);
  });

  it('buildPersonalityResults marks current personality with filled circle', () => {
    const results = buildPersonalityResults('meow', DISK_PERSONALITIES);
    const meow = results.find((r) => r.value === 'meow');
    expect(meow?.icon).toBe('\u25cf');
    const other = results.find((r) => r.value === 'default');
    expect(other?.icon).toBe('\u25cb');
  });

  it('buildPersonalityResults has correct action type', () => {
    const results = buildPersonalityResults('default', DISK_PERSONALITIES);
    for (const result of results) {
      expect(result.action).toBe('personality');
      expect(result.commandName).toBe('/personality');
      expect(result.category).toBe('commands');
    }
  });
});

// ─── Command Execution ───────────────────────────────────────────────────────

describe('Command Execution', () => {
  let mockContext: CommandContext;

  beforeEach(() => {
    mockContext = {
      onCreateSession: vi.fn().mockResolvedValue(undefined),
      onLoadSession: vi.fn().mockResolvedValue(undefined),
      onDeleteSession: vi.fn().mockResolvedValue(undefined),
      onRenameSession: vi.fn().mockResolvedValue(undefined),
      getActiveSessionId: vi.fn().mockReturnValue('session-1'),
      getActiveSessionName: vi.fn().mockReturnValue('Test Session'),
      onSetTheme: vi.fn().mockResolvedValue(undefined),
      onSetPersonality: vi.fn().mockResolvedValue(undefined),
      onSetModel: vi.fn().mockResolvedValue(undefined),
      getAvailableModels: vi.fn().mockReturnValue(['test/model']),
      getCurrentModel: vi.fn().mockReturnValue('test/model'),
      onOpenSettings: vi.fn(),
      onPickProjectDir: vi.fn().mockResolvedValue(undefined),
      onIndexRAG: vi.fn().mockResolvedValue(undefined),
      onIndexAST: vi.fn().mockResolvedValue(undefined),
      onClearRAG: vi.fn().mockResolvedValue(undefined),
      onNotify: vi.fn(),
      onClose: vi.fn(),
    };

    // /delete and /rename use browser dialogs on window
    (window as unknown as { confirm: typeof confirm }).confirm = vi
      .fn()
      .mockReturnValue(true);
    (window as unknown as { prompt: typeof prompt }).prompt = vi
      .fn()
      .mockReturnValue('Renamed Session');
  });

  it('/new creates a new session and closes palette', async () => {
    const cmd = findCommand('/new');
    expect(cmd).toBeDefined();
    await cmd!.execute(mockContext);
    expect(mockContext.onCreateSession).toHaveBeenCalled();
    expect(mockContext.onClose).toHaveBeenCalled();
  });

  it('/delete deletes the active session after confirm', async () => {
    const cmd = findCommand('/delete');
    expect(cmd).toBeDefined();
    await cmd!.execute(mockContext);
    expect(mockContext.onDeleteSession).toHaveBeenCalledWith('session-1');
    expect(mockContext.onNotify).toHaveBeenCalledWith('Session deleted.', 'info');
  });

  it('/delete cancels when user declines confirm', async () => {
    (window as unknown as { confirm: typeof confirm }).confirm = vi
      .fn()
      .mockReturnValue(false);
    const cmd = findCommand('/delete');
    await cmd!.execute(mockContext);
    expect(mockContext.onDeleteSession).not.toHaveBeenCalled();
  });

  it('/delete notifies when no active session', async () => {
    mockContext.getActiveSessionId = vi.fn().mockReturnValue(null);
    const cmd = findCommand('/delete');
    await cmd!.execute(mockContext);
    expect(mockContext.onNotify).toHaveBeenCalledWith('No active session to delete.', 'warning');
    expect(mockContext.onClose).toHaveBeenCalled();
  });

  it('/rename renames the active session', async () => {
    const cmd = findCommand('/rename');
    expect(cmd).toBeDefined();
    await cmd!.execute(mockContext);
    expect(mockContext.onRenameSession).toHaveBeenCalledWith('session-1', 'Renamed Session');
    expect(mockContext.onNotify).toHaveBeenCalledWith(
      expect.stringContaining('Renamed Session'),
      'info',
    );
  });

  it('/rename cancels when prompt is dismissed', async () => {
    (window as unknown as { prompt: typeof prompt }).prompt = vi
      .fn()
      .mockReturnValue(null);
    const cmd = findCommand('/rename');
    await cmd!.execute(mockContext);
    expect(mockContext.onRenameSession).not.toHaveBeenCalled();
  });

  it('/settings opens settings and closes palette', async () => {
    const cmd = findCommand('/settings');
    expect(cmd).toBeDefined();
    await cmd!.execute(mockContext);
    expect(mockContext.onOpenSettings).toHaveBeenCalled();
    expect(mockContext.onClose).toHaveBeenCalled();
  });

  it('/cd opens the project folder picker', async () => {
    const cmd = findCommand('/cd');
    expect(cmd).toBeDefined();
    await cmd!.execute(mockContext);
    expect(mockContext.onPickProjectDir).toHaveBeenCalled();
    expect(mockContext.onNotify).toHaveBeenCalledWith(
      'Project folder updated.',
      'info',
    );
    expect(mockContext.onClose).toHaveBeenCalled();
  });

  it('/rag index triggers RAG indexing', async () => {
    const cmd = findCommand('/rag index');
    expect(cmd).toBeDefined();
    await cmd!.execute(mockContext);
    expect(mockContext.onIndexRAG).toHaveBeenCalled();
    expect(mockContext.onClose).toHaveBeenCalled();
    expect(mockContext.onNotify).toHaveBeenCalledWith('RAG indexing complete.', 'info');
  });

  it('/ast index triggers AST indexing', async () => {
    const cmd = findCommand('/ast index');
    expect(cmd).toBeDefined();
    await cmd!.execute(mockContext);
    expect(mockContext.onIndexAST).toHaveBeenCalled();
    expect(mockContext.onClose).toHaveBeenCalled();
    expect(mockContext.onNotify).toHaveBeenCalledWith('AST indexing complete.', 'info');
  });

  it('/rag clear clears the RAG index', async () => {
    const cmd = findCommand('/rag clear');
    await cmd!.execute(mockContext);
    expect(mockContext.onClearRAG).toHaveBeenCalled();
    expect(mockContext.onNotify).toHaveBeenCalledWith('RAG index cleared.', 'info');
    expect(mockContext.onClose).toHaveBeenCalled();
  });
});

// ─── Keyboard Shortcuts ──────────────────────────────────────────────────────

function fakeKeyEvent(
  partial: Partial<KeyboardEvent> & { key: string },
): KeyboardEvent {
  return {
    key: partial.key,
    code: partial.code ?? '',
    ctrlKey: partial.ctrlKey ?? false,
    metaKey: partial.metaKey ?? false,
    shiftKey: partial.shiftKey ?? false,
    altKey: partial.altKey ?? false,
    defaultPrevented: false,
    preventDefault() {
      (this as { defaultPrevented: boolean }).defaultPrevented = true;
    },
    target: partial.target ?? null,
  } as KeyboardEvent;
}

describe('Command Palette Keyboard Shortcuts', () => {
  it('Cmd+K / Ctrl+K opens palette via registry', () => {
    const def = getShortcut('palette.toggle');
    expect(def).toBeDefined();
    expect(def!.chord).toEqual({ key: 'k', mod: true });
    expect(eventMatchesChord(fakeKeyEvent({ key: 'k', metaKey: true }), def!.chord)).toBe(true);
    expect(eventMatchesChord(fakeKeyEvent({ key: 'k', ctrlKey: true }), def!.chord)).toBe(true);
  });

  it('Ctrl+K opens palette on Windows/Linux via registry', () => {
    const def = getShortcut('palette.toggle');
    expect(def).toBeDefined();
    expect(eventMatchesChord(fakeKeyEvent({ key: 'k', ctrlKey: true }), def!.chord)).toBe(true);
    expect(eventMatchesChord(fakeKeyEvent({ key: 'k' }), def!.chord)).toBe(false);
  });

  it('ArrowDown navigates palette via registry', () => {
    const def = getShortcut('palette.navigate');
    expect(def).toBeDefined();
    expect(def!.chord).toEqual({ key: 'ArrowDown' });
    expect(eventMatchesChord(fakeKeyEvent({ key: 'ArrowDown' }), def!.chord)).toBe(true);
  });

  it('Enter selects palette result via registry', () => {
    const def = getShortcut('palette.select');
    expect(def).toBeDefined();
    expect(def!.chord).toEqual({ key: 'Enter' });
    expect(eventMatchesChord(fakeKeyEvent({ key: 'Enter' }), def!.chord)).toBe(true);
  });

  it('Escape closes palette via registry', () => {
    const def = getShortcut('palette.close');
    expect(def).toBeDefined();
    expect(def!.chord).toEqual({ key: 'Escape' });
    expect(eventMatchesChord(fakeKeyEvent({ key: 'Escape' }), def!.chord)).toBe(true);
  });
});

// ─── Session Search ──────────────────────────────────────────────────────────

describe('Session Search in Palette', () => {
  const sessions: SessionSummary[] = [
    { id: 's1', name: 'TypeScript Migration', model: 'openai/gpt-4o', cwd: null, chainCount: 3, updatedAt: Date.now() },
    { id: 's2', name: 'Python Bug Fix', model: 'anthropic/claude-3', cwd: null, chainCount: 1, updatedAt: Date.now() - 86400000 },
    { id: 's3', name: 'React Component Work', model: 'openai/gpt-4o', cwd: null, chainCount: 2, updatedAt: Date.now() - 2 * 86400000 },
  ];

  it('fuzzy search matches session names', () => {
    const score = fuzzyMatch('type', 'TypeScript Migration');
    expect(score).toBeGreaterThan(0);
  });

  it('fuzzy search matches partial session names', () => {
    const score = fuzzyMatch('bug', 'Python Bug Fix');
    expect(score).toBeGreaterThan(0);
  });

  it('fuzzy search does not match unrelated sessions', () => {
    const score = fuzzyMatch('java', 'TypeScript Migration');
    expect(score).toBe(-1);
  });

  it('sessions can be found by model name in description', () => {
    // The palette also searches descriptions
    const score = fuzzyMatch('gpt', 'openai/gpt-4o');
    expect(score).toBeGreaterThan(0);
  });
});

// ─── File Structure ──────────────────────────────────────────────────────────

describe('Command Palette File Structure', () => {
  const fs = require('node:fs');
  const path = require('node:path');

  const componentsDir = path.resolve(__dirname, '../../src/renderer/components');
  const commandsDir = path.resolve(__dirname, '../../src/renderer/commands');

  it('CommandPalette component exists', () => {
    expect(fs.existsSync(path.join(componentsDir, 'CommandPalette.tsx'))).toBe(true);
  });

  it('command registry exists', () => {
    expect(fs.existsSync(path.join(commandsDir, 'registry.ts'))).toBe(true);
  });

  it('chat.css or components.css contain command palette styles', () => {
    const chatCss = fs.readFileSync(
      path.resolve(__dirname, '../../src/renderer/styles/chat.css'),
      'utf-8',
    );
    const componentsCss = fs.readFileSync(
      path.resolve(__dirname, '../../src/renderer/styles/components.css'),
      'utf-8',
    );
    const css = `${chatCss}\n${componentsCss}`;
    expect(css).toContain('.orchid-command-palette-overlay');
    expect(css).toContain('.orchid-command-palette');
    expect(css).toContain('.orchid-command-palette-results');
    expect(css).toContain('.orchid-command-palette-item');
    expect(css).toContain('.orchid-command-palette-group');
    expect(css).toContain('.orchid-command-palette-footer');
  });

  it('wires orchid:navigate from palette to ChatView/Sidebar', () => {
    const palette = fs.readFileSync(
      path.join(componentsDir, 'CommandPalette.tsx'),
      'utf-8',
    );
    const chatView = fs.readFileSync(
      path.join(componentsDir, 'ChatView.tsx'),
      'utf-8',
    );
    expect(palette).toContain("orchid:navigate");
    expect(chatView).toContain("orchid:navigate");
    expect(chatView).toContain('setInspectorFocusSection');
  });

  it('Sidebar re-opens collapsed inspector section on same-section re-nav', () => {
    const sidebar = fs.readFileSync(
      path.join(componentsDir, 'Sidebar.tsx'),
      'utf-8',
    );
    expect(sidebar).toContain('forceOpenEpoch');
    expect(sidebar).toContain('forceOpenToken');
    expect(sidebar).toMatch(/shouldOpenCollapseFromToken\(forceOpenToken\)/);
  });

  it('CommandPalette ignores re-entrant selection while async select is in flight', () => {
    const palette = fs.readFileSync(
      path.join(componentsDir, 'CommandPalette.tsx'),
      'utf-8',
    );
    expect(palette).toContain('selectingRef');
    expect(palette).toMatch(/if \(selectingRef\.current\) return/);
    expect(palette).toMatch(/selectingRef\.current = true/);
    expect(palette).toMatch(/finally \{[\s\S]*selectingRef\.current = false/);
    expect(palette).toMatch(/disabled=\{isSelecting\}/);
  });
});
