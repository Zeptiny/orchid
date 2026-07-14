/**
 * Personality loading tests — seed, load, and list names/content.
 *
 * Protects personality loading behavior preserved by the desktop migration.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  loadPersonalities,
  listPersonalityNames,
  seedPersonalitiesDir,
} from '../../src/main/personality/registry';

// ---------------------------------------------------------------------------
// Temp dir helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-personality-test-'));
}

function writePersonality(baseDir: string, name: string, content: string): void {
  fs.mkdirSync(baseDir, { recursive: true });
  fs.writeFileSync(path.join(baseDir, `${name}.md`), content, 'utf-8');
}

beforeEach(() => {
  tmpDir = makeTmpDir();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

describe('loadPersonalities', () => {
  it('loads all .md files from the personalities directory', () => {
    writePersonality(tmpDir, 'default', 'Default tone.');
    writePersonality(tmpDir, 'meow', 'You are a cat.');
    writePersonality(tmpDir, 'zen', 'Be calm.');

    const map = loadPersonalities({ homeDir: tmpDir });

    expect(map.size).toBe(3);
    expect(map.get('default')).toBe('Default tone.');
    expect(map.get('meow')).toBe('You are a cat.');
    expect(map.get('zen')).toBe('Be calm.');
  });

  it('skips empty files', () => {
    writePersonality(tmpDir, 'default', 'Default tone.');
    writePersonality(tmpDir, 'empty', '   \n  ');

    const map = loadPersonalities({ homeDir: tmpDir });
    expect(map.size).toBe(1);
    expect(map.has('empty')).toBe(false);
  });

  it('skips non-.md files', () => {
    writePersonality(tmpDir, 'default', 'Default tone.');
    fs.writeFileSync(path.join(tmpDir, 'notes.txt'), 'not a personality', 'utf-8');

    const map = loadPersonalities({ homeDir: tmpDir });
    expect(map.size).toBe(1);
    expect(map.has('notes')).toBe(false);
  });

  it('returns empty map for missing directory', () => {
    const map = loadPersonalities({ homeDir: path.join(tmpDir, 'does-not-exist') });
    expect(map.size).toBe(0);
  });

  it('trims whitespace from content', () => {
    writePersonality(tmpDir, 'default', '  \nHello world\n  ');
    const map = loadPersonalities({ homeDir: tmpDir });
    expect(map.get('default')).toBe('Hello world');
  });
});

// ---------------------------------------------------------------------------
// List / get
// ---------------------------------------------------------------------------

describe('listPersonalityNames', () => {
  it('lists names sorted alphabetically', () => {
    writePersonality(tmpDir, 'zen', 'z');
    writePersonality(tmpDir, 'default', 'd');
    writePersonality(tmpDir, 'meow', 'm');
    loadPersonalities({ homeDir: tmpDir });

    expect(listPersonalityNames()).toEqual(['default', 'meow', 'zen']);
  });

});

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

describe('seedPersonalitiesDir', () => {
  it('copies bundled defaults into an empty home directory', () => {
    const homeDir = path.join(tmpDir, 'home');
    seedPersonalitiesDir(homeDir);

    const files = fs.readdirSync(homeDir).filter((f) => f.endsWith('.md')).sort();
    expect(files).toEqual([
      'default.md',
      'meow.md',
      'pirate.md',
      'socrates.md',
      'stupid.md',
      'zen.md',
    ]);

    const content = fs.readFileSync(path.join(homeDir, 'default.md'), 'utf-8');
    expect(content.length).toBeGreaterThan(0);
  });

  it('does not overwrite existing personality files', () => {
    const homeDir = path.join(tmpDir, 'home');
    fs.mkdirSync(homeDir, { recursive: true });
    fs.writeFileSync(path.join(homeDir, 'default.md'), 'Custom default.', 'utf-8');

    seedPersonalitiesDir(homeDir);

    expect(fs.readFileSync(path.join(homeDir, 'default.md'), 'utf-8')).toBe('Custom default.');
    // Other defaults still get seeded
    expect(fs.existsSync(path.join(homeDir, 'meow.md'))).toBe(true);
  });

  it('is idempotent', () => {
    const homeDir = path.join(tmpDir, 'home');
    seedPersonalitiesDir(homeDir);
    seedPersonalitiesDir(homeDir);

    const files = fs.readdirSync(homeDir).filter((f) => f.endsWith('.md'));
    expect(files).toHaveLength(6);
  });
});

// ---------------------------------------------------------------------------
// Bundled defaults exist in source tree
// ---------------------------------------------------------------------------

describe('bundled defaults', () => {
  it('ships the same default set as Python', () => {
    const defaultsDir = path.join(
      __dirname,
      '../../src/main/personality/defaults',
    );
    expect(fs.existsSync(defaultsDir)).toBe(true);

    const names = fs
      .readdirSync(defaultsDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/\.md$/, ''))
      .sort();

    expect(names).toEqual(['default', 'meow', 'pirate', 'socrates', 'stupid', 'zen']);
  });
});
