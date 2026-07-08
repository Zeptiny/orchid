/**
 * Command Parity Tests — U28.
 *
 * Verifies that all 12 commands from the Python TUI are ported to the TS/Electron app.
 * Tests STRUCTURE (all commands registered, correct metadata), not behavior.
 */
import { describe, it, expect } from 'vitest';
import {
  COMMANDS,
  getCommand,
  getCommandNames,
  isCommand,
} from '../../src/main/commands/registry';

// ── Expected commands (12 total) ───────────────────────────────────────────

const EXPECTED_COMMANDS = [
  { name: '/new', category: 'commands' },
  { name: '/sessions', category: 'commands' },
  { name: '/rename', category: 'commands' },
  { name: '/delete', category: 'commands' },
  { name: '/model', category: 'commands' },
  { name: '/theme', category: 'commands' },
  { name: '/personality', category: 'commands' },
  { name: '/settings', category: 'commands' },
  { name: '/index-rag', category: 'commands' },
  { name: '/index-ast', category: 'commands' },
  { name: '/rag status', category: 'commands' },
  { name: '/rag clear', category: 'commands' },
];

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Command Parity', () => {
  it('all 12 commands are registered', () => {
    expect(COMMANDS).toHaveLength(12);
  });

  it('all expected command names are present', () => {
    const names = getCommandNames().sort();
    const expectedNames = EXPECTED_COMMANDS.map((c) => c.name).sort();
    expect(names).toEqual(expectedNames);
  });

  it('each command has name, description, and category', () => {
    for (const cmd of COMMANDS) {
      expect(cmd.name, `Command name`).toBeTruthy();
      expect(cmd.name.startsWith('/'), `Command '${cmd.name}' starts with /`).toBe(true);
      expect(cmd.description, `Command '${cmd.name}' description`).toBeTruthy();
      expect(cmd.description.length, `Command '${cmd.name}' description length`).toBeGreaterThan(5);
      expect(cmd.category, `Command '${cmd.name}' category`).toBeTruthy();
    }
  });

  it('each command has an execute function', () => {
    for (const cmd of COMMANDS) {
      expect(typeof cmd.execute, `Command '${cmd.name}' execute`).toBe('function');
    }
  });

  it('each expected command has correct category', () => {
    for (const expected of EXPECTED_COMMANDS) {
      const cmd = getCommand(expected.name);
      expect(cmd, `Command '${expected.name}' should exist`).toBeDefined();
      expect(cmd!.category, `Command '${expected.name}' category`).toBe(expected.category);
    }
  });

  it('getCommand() returns correct command by name', () => {
    const cmd = getCommand('/new');
    expect(cmd).toBeDefined();
    expect(cmd!.name).toBe('/new');
    expect(cmd!.description).toContain('new session');
  });

  it('getCommand() returns undefined for unknown command', () => {
    const cmd = getCommand('/unknown');
    expect(cmd).toBeUndefined();
  });

  it('isCommand() returns true for known commands', () => {
    expect(isCommand('/new')).toBe(true);
    expect(isCommand('/sessions')).toBe(true);
    expect(isCommand('/theme')).toBe(true);
  });

  it('isCommand() returns false for unknown commands', () => {
    expect(isCommand('/unknown')).toBe(false);
    expect(isCommand('not-a-command')).toBe(false);
  });

  it('command names are unique', () => {
    const names = COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
