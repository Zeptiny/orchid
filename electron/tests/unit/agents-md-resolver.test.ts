/**
 * AGENTS.md resolver + config tests (U1).
 *
 * Covers the governing-chain resolver (upward walk, alias precedence, depth
 * cap, symlink containment, case-insensitive matching, non-existent targets),
 * the `agents_md` config schema/defaults/deep-merge, and the byte-capped
 * content reader.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  configSchema,
  defaults,
  mergeLayers,
  type AgentsMdConfig,
  type Config,
} from '../../src/main/config';
import {
  AGENTS_LOCAL_FILENAME,
  AGENTS_MD_DEFAULTS,
  effectiveAgentsMdFilenames,
} from '../../src/main/agents-md/config';
import {
  readAgentsMdContent,
  resolveAgentsMdChain,
} from '../../src/main/agents-md/resolver';

/** Build a full Config with `agents_md` overrides applied over the defaults. */
function agentsConfig(overrides: Partial<AgentsMdConfig> = {}): Config {
  return { ...defaults(), agents_md: { ...AGENTS_MD_DEFAULTS, ...overrides } };
}

describe('resolveAgentsMdChain', () => {
  let root: string;
  let workspace: string;
  let outside: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-agents-md-'));
    workspace = path.join(root, 'workspace');
    outside = path.join(root, 'outside');
    fs.mkdirSync(workspace);
    fs.mkdirSync(outside);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function write(rel: string, content = 'instructions'): string {
    const abs = path.join(workspace, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
    return abs;
  }

  it('collects a nested file and the root file, nearest first with correct tiers', () => {
    const rootFile = write('AGENTS.md', 'root');
    const nestedFile = write('pkg/AGENTS.md', 'nested');
    write('pkg/lib/x.ts', 'code');

    const chain = resolveAgentsMdChain('pkg/lib/x.ts', workspace, agentsConfig());

    expect(chain.map((e) => e.path)).toEqual([nestedFile, rootFile]);
    expect(chain.map((e) => e.tier)).toEqual(['nested', 'root']);
    expect(chain.map((e) => e.displayPath)).toEqual([
      path.join('pkg', 'AGENTS.md'),
      'AGENTS.md',
    ]);
    expect(chain[0]?.sizeBytes).toBe(Buffer.byteLength('nested'));
    expect(typeof chain[0]?.mtimeMs).toBe('number');
  });

  it('returns only the first configured alias when a directory has several', () => {
    const agentsFile = write('pkg/AGENTS.md', 'primary');
    write('pkg/CLAUDE.md', 'alias');
    write('pkg/y.ts', 'code');

    const chain = resolveAgentsMdChain('pkg/y.ts', workspace, agentsConfig());

    expect(chain).toHaveLength(1);
    expect(chain[0]?.path).toBe(agentsFile);
  });

  it('falls back to a later alias when the primary is absent', () => {
    const claudeFile = write('pkg/CLAUDE.md', 'alias');
    write('pkg/y.ts', 'code');

    const chain = resolveAgentsMdChain('pkg/y.ts', workspace, agentsConfig());

    expect(chain).toHaveLength(1);
    expect(chain[0]?.path).toBe(claudeFile);
  });

  it('caps the upward walk at max_chain_depth', () => {
    write('AGENTS.md', 'root');
    write('a/AGENTS.md', 'a');
    write('a/b/AGENTS.md', 'b');
    write('a/b/c/AGENTS.md', 'c');
    const deepFile = write('a/b/c/d/AGENTS.md', 'd');
    write('a/b/c/d/file.ts', 'code');

    const chain = resolveAgentsMdChain(
      'a/b/c/d/file.ts',
      workspace,
      agentsConfig({ max_chain_depth: 2 }),
    );

    // Only the two nearest directories are walked; the root is never reached.
    expect(chain).toHaveLength(2);
    expect(chain.map((e) => e.tier)).toEqual(['nested', 'nested']);
    expect(chain[0]?.path).toBe(deepFile);
    expect(chain.some((e) => e.tier === 'root')).toBe(false);
  });

  it('excludes an instruction file whose symlink target escapes cwd', () => {
    const outsideFile = path.join(outside, 'AGENTS.md');
    fs.writeFileSync(outsideFile, 'escaped', 'utf-8');
    const rootFile = write('AGENTS.md', 'root');
    fs.mkdirSync(path.join(workspace, 'nested'));
    fs.symlinkSync(outsideFile, path.join(workspace, 'nested', 'AGENTS.md'));
    write('nested/code.ts', 'code');

    const chain = resolveAgentsMdChain('nested/code.ts', workspace, agentsConfig());

    // The escaping nested file is dropped; the contained root file survives.
    expect(chain.map((e) => e.path)).toEqual([rootFile]);
    expect(chain.map((e) => e.tier)).toEqual(['root']);
  });

  it('matches filenames case-insensitively while preserving the on-disk name', () => {
    const lowerFile = write('agents.md', 'lowercase on disk');
    write('code.ts', 'code');

    const chain = resolveAgentsMdChain('code.ts', workspace, agentsConfig());

    expect(chain).toHaveLength(1);
    expect(chain[0]?.path).toBe(lowerFile);
    expect(chain[0]?.displayPath).toBe('agents.md');
    expect(chain[0]?.tier).toBe('root');
  });

  it('prefers the exact-case file when both cases coexist, deterministically (F2)', () => {
    // A case-sensitive FS can hold both `AGENTS.md` and `agents.md`; the
    // configured (exact-case) name must win regardless of readdir order.
    const exactFile = write('both/AGENTS.md', 'exact case');
    write('both/agents.md', 'lower case');
    write('both/code.ts', 'code');

    const chain = resolveAgentsMdChain('both/code.ts', workspace, agentsConfig());
    expect(chain).toHaveLength(1);
    expect(chain[0]?.path).toBe(exactFile);
    expect(chain[0]?.displayPath).toBe(path.join('both', 'AGENTS.md'));
  });

  it('returns an empty chain for a target outside cwd', () => {
    write('AGENTS.md', 'root');
    const outsideTarget = path.join(outside, 'file.ts');
    fs.writeFileSync(outsideTarget, 'code', 'utf-8');

    expect(resolveAgentsMdChain(outsideTarget, workspace, agentsConfig())).toEqual([]);
    expect(resolveAgentsMdChain('../outside/file.ts', workspace, agentsConfig())).toEqual([]);
  });

  it('considers AGENTS.local.md only when include_local is true, as lowest precedence', () => {
    const localFile = write('solo/AGENTS.local.md', 'local only');
    write('solo/z.ts', 'code');

    expect(
      resolveAgentsMdChain('solo/z.ts', workspace, agentsConfig({ include_local: false })),
    ).toEqual([]);

    const withLocal = resolveAgentsMdChain(
      'solo/z.ts',
      workspace,
      agentsConfig({ include_local: true }),
    );
    expect(withLocal.map((e) => e.path)).toEqual([localFile]);

    // When a primary alias is also present, it wins over the local file.
    const primaryFile = write('solo/AGENTS.md', 'primary');
    const preferred = resolveAgentsMdChain(
      'solo/z.ts',
      workspace,
      agentsConfig({ include_local: true }),
    );
    expect(preferred.map((e) => e.path)).toEqual([primaryFile]);
  });

  it('resolves the governing chain for a target whose components do not exist yet', () => {
    const rootFile = write('AGENTS.md', 'root');
    const nestedFile = write('src/AGENTS.md', 'nested');
    // src/deep/ does not exist on disk; the target is a file about to be created.

    const chain = resolveAgentsMdChain(
      'src/deep/new-file.ts',
      workspace,
      agentsConfig(),
    );

    expect(chain.map((e) => e.path)).toEqual([nestedFile, rootFile]);
    expect(chain.map((e) => e.tier)).toEqual(['nested', 'root']);
  });

  it('returns an empty chain when the workspace itself cannot be canonicalized', () => {
    const missing = path.join(root, 'missing-workspace');
    expect(resolveAgentsMdChain('file.ts', missing, agentsConfig())).toEqual([]);
  });

  it('canonicalizes the cwd once and serves repeats from a bounded cache (F1)', () => {
    write('AGENTS.md', 'root');
    write('pkg/x.ts', 'code');
    const config = agentsConfig();
    const cwdKey = path.resolve(workspace);

    const realpathSpy = vi.spyOn(fs.realpathSync, 'native');
    try {
      const first = resolveAgentsMdChain('pkg/x.ts', workspace, config);
      expect(first.length).toBeGreaterThan(0);
      for (let i = 0; i < 25; i++) {
        expect(resolveAgentsMdChain('pkg/x.ts', workspace, config)).toEqual(first);
      }
      // Only the cwd canonicalization is cached; count just those calls. Without
      // the cache this would be 26 (one per resolve); with it, exactly one.
      const cwdCalls = realpathSpy.mock.calls.filter((call) => call[0] === cwdKey).length;
      expect(cwdCalls).toBe(1);
    } finally {
      realpathSpy.mockRestore();
    }
  });
});

describe('readAgentsMdContent', () => {
  let root: string;
  let workspace: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-agents-md-content-'));
    workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function entryFor(content: string) {
    fs.writeFileSync(path.join(workspace, 'AGENTS.md'), content, 'utf-8');
    fs.writeFileSync(path.join(workspace, 'f.ts'), 'code', 'utf-8');
    const chain = resolveAgentsMdChain('f.ts', workspace, agentsConfig());
    const entry = chain.find((e) => e.tier === 'root');
    expect(entry).toBeDefined();
    return entry!;
  }

  it('returns full content without truncation at exactly max_file_bytes', () => {
    const content = 'x'.repeat(100);
    const entry = entryFor(content);

    const result = readAgentsMdContent(entry, 100);
    expect(result.truncated).toBe(false);
    expect(result.content).toBe(content);
  });

  it('returns a head plus truncated flag when the file exceeds max_file_bytes', () => {
    const content = 'y'.repeat(100);
    const entry = entryFor(content);

    const result = readAgentsMdContent(entry, 99);
    expect(result.truncated).toBe(true);
    expect(result.content).toBe('y'.repeat(99));
  });
});

describe('effectiveAgentsMdFilenames', () => {
  it('returns the configured aliases in order by default', () => {
    expect(effectiveAgentsMdFilenames(agentsConfig())).toEqual(['AGENTS.md', 'CLAUDE.md']);
  });

  it('appends AGENTS.local.md last when include_local is true', () => {
    const names = effectiveAgentsMdFilenames(agentsConfig({ include_local: true }));
    expect(names).toEqual(['AGENTS.md', 'CLAUDE.md', AGENTS_LOCAL_FILENAME]);
  });

  it('trims entries, drops empties, and de-duplicates case-insensitively', () => {
    const names = effectiveAgentsMdFilenames(
      agentsConfig({ filenames: ['  AGENTS.md  ', '', 'claude.md', 'CLAUDE.md', 'custom.md'] }),
    );
    expect(names).toEqual(['AGENTS.md', 'claude.md', 'custom.md']);
  });
});

describe('agents_md config schema', () => {
  it('populates the documented defaults', () => {
    expect(defaults().agents_md).toEqual(AGENTS_MD_DEFAULTS);
    expect(AGENTS_MD_DEFAULTS).toEqual({
      enabled: true,
      filenames: ['AGENTS.md', 'CLAUDE.md'],
      max_file_bytes: 32768,
      max_chain_depth: 8,
      enforce_on_write: 'warn',
      inject_on_read: true,
      include_local: false,
    });
  });

  it('fills sibling defaults from a partial agents_md override', () => {
    const parsed = configSchema.parse({ agents_md: { max_chain_depth: 3 } });
    expect(parsed.agents_md.max_chain_depth).toBe(3);
    expect(parsed.agents_md.max_file_bytes).toBe(32768);
    expect(parsed.agents_md.enforce_on_write).toBe('warn');
  });

  it('rejects an unknown top-level key under the strict schema', () => {
    expect(configSchema.safeParse({ agents_md_bogus: {} }).success).toBe(false);
  });

  it('rejects an invalid enforce_on_write policy and non-positive integers', () => {
    expect(
      configSchema.safeParse({ agents_md: { enforce_on_write: 'explode' } }).success,
    ).toBe(false);
    expect(configSchema.safeParse({ agents_md: { max_file_bytes: 0 } }).success).toBe(false);
    expect(configSchema.safeParse({ agents_md: { max_chain_depth: -1 } }).success).toBe(false);
  });

  it('bounds max_file_bytes, max_chain_depth, and filenames length (F10)', () => {
    // At the upper bounds still parses.
    expect(
      configSchema.safeParse({ agents_md: { max_file_bytes: 2_097_152, max_chain_depth: 32 } })
        .success,
    ).toBe(true);
    expect(
      configSchema.safeParse({
        agents_md: { filenames: Array.from({ length: 16 }, (_, i) => `f${i}.md`) },
      }).success,
    ).toBe(true);

    // Above the bounds is rejected (DoS guard: readAgentsMdContent allocs max_file_bytes).
    expect(configSchema.safeParse({ agents_md: { max_file_bytes: 2_097_153 } }).success).toBe(false);
    expect(configSchema.safeParse({ agents_md: { max_chain_depth: 33 } }).success).toBe(false);
    expect(
      configSchema.safeParse({
        agents_md: { filenames: Array.from({ length: 17 }, (_, i) => `f${i}.md`) },
      }).success,
    ).toBe(false);
  });

  it('deep-merges a partial project override without wiping sibling fields', () => {
    const merged = mergeLayers(
      defaults() as unknown as Record<string, unknown>,
      {},
      { agents_md: { enforce_on_write: 'block' } },
    );
    const parsed = configSchema.parse(merged);
    expect(parsed.agents_md.enforce_on_write).toBe('block');
    expect(parsed.agents_md.max_file_bytes).toBe(32768);
    expect(parsed.agents_md.include_local).toBe(false);
  });
});
