/**
 * Personality loading tests — seed, load, list, append.
 *
 * Mirrors Python `src/orchid/personality/__init__.py` behaviour.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  loadPersonalities,
  getPersonality,
  listPersonalityNames,
  listPersonalities,
  seedPersonalitiesDir,
  appendPersonality,
  resetPersonalityRegistry,
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
  resetPersonalityRegistry();
});

afterEach(() => {
  resetPersonalityRegistry();
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

describe('listPersonalityNames / getPersonality', () => {
  it('lists names sorted alphabetically', () => {
    writePersonality(tmpDir, 'zen', 'z');
    writePersonality(tmpDir, 'default', 'd');
    writePersonality(tmpDir, 'meow', 'm');
    loadPersonalities({ homeDir: tmpDir });

    expect(listPersonalityNames()).toEqual(['default', 'meow', 'zen']);
  });

  it('getPersonality returns content by name', () => {
    writePersonality(tmpDir, 'pirate', 'Arr!');
    loadPersonalities({ homeDir: tmpDir });

    expect(getPersonality('pirate')).toBe('Arr!');
    expect(getPersonality('missing')).toBeUndefined();
  });

  it('listPersonalities returns name/content pairs', () => {
    writePersonality(tmpDir, 'a', 'A text');
    writePersonality(tmpDir, 'b', 'B text');
    loadPersonalities({ homeDir: tmpDir });

    expect(listPersonalities()).toEqual([
      { name: 'a', content: 'A text' },
      { name: 'b', content: 'B text' },
    ]);
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
// appendPersonality
// ---------------------------------------------------------------------------

describe('appendPersonality', () => {
  it('appends personality section when name is known', () => {
    writePersonality(tmpDir, 'meow', 'You are a cat.');
    loadPersonalities({ homeDir: tmpDir });

    const result = appendPersonality('You are an agent.', 'meow');
    expect(result).toContain('You are an agent.');
    expect(result).toContain('## Personality');
    expect(result).toContain('You are a cat.');
  });

  it('returns prompt unchanged when personality is unknown', () => {
    loadPersonalities({ homeDir: tmpDir });
    const prompt = 'You are an agent.';
    expect(appendPersonality(prompt, 'missing')).toBe(prompt);
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
