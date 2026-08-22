/**
 * Read-path AGENTS.md injection tests (U4).
 *
 * Covers the pure injection builder (path extraction, chain resolution, unseen
 * computation, byte cap, XML rendering/escaping, directory synthetic-child
 * resolution, staleness) against temp-dir fixtures and a real
 * AgentsMdContextStore, plus one dispatch-level test proving a `read` call's
 * agent projection gains an `<agents_md>` block end-to-end.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  defaults,
  type AgentsMdConfig,
  type Config,
} from '../../src/main/config';
import { AGENTS_MD_DEFAULTS } from '../../src/main/agents-md/config';
import { buildAgentsMdInjection } from '../../src/main/agents-md/inject';
import { resolveAgentsMdChain } from '../../src/main/agents-md/resolver';
import { AgentsMdContextStore } from '../../src/main/session/agents-md-context';

/** Build a full Config with `agents_md` overrides applied over the defaults. */
function agentsConfig(overrides: Partial<AgentsMdConfig> = {}): Config {
  return { ...defaults(), agents_md: { ...AGENTS_MD_DEFAULTS, ...overrides } };
}

describe('buildAgentsMdInjection', () => {
  let root: string;
  let workspace: string;
  let store: AgentsMdContextStore;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-agents-md-inject-'));
    workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace);
    store = new AgentsMdContextStore();
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

  it('injects an unseen nested file governing a read target', () => {
    write('pkg/AGENTS.md', 'nested instructions');
    write('pkg/lib/x.ts', 'code');

    const injection = buildAgentsMdInjection(
      'read',
      { file_path: 'pkg/lib/x.ts' },
      workspace,
      agentsConfig(),
      store,
    );

    expect(injection).not.toBeNull();
    expect(injection!.xml).toContain('nested instructions');
    expect(injection!.xml).toContain('<agents_md');
    expect(injection!.xml).toContain(`path="${path.join('pkg', 'AGENTS.md')}"`);
    expect(injection!.xml).toContain('tier="nested"');
    expect(injection!.injected).toHaveLength(1);
    expect(injection!.injected[0]?.displayPath).toBe(path.join('pkg', 'AGENTS.md'));
  });

  it('dedupes: a second build after marking seen returns null', () => {
    write('pkg/AGENTS.md', 'nested instructions');
    write('pkg/lib/x.ts', 'code');
    const config = agentsConfig();
    const args = { file_path: 'pkg/lib/x.ts' };

    const first = buildAgentsMdInjection('read', args, workspace, config, store);
    expect(first).not.toBeNull();

    // The dispatcher marks injected entries seen after appending.
    first!.injected.forEach((entry) => store.markSeen(entry));

    const second = buildAgentsMdInjection('read', args, workspace, config, store);
    expect(second).toBeNull();
  });

  it('never re-injects the seeded root, only the unseen nested file (R4)', () => {
    write('AGENTS.md', 'root instructions');
    write('pkg/AGENTS.md', 'nested instructions');
    write('pkg/x.ts', 'code');
    const config = agentsConfig();

    // Seed the root exactly as the session-start hook does (U3).
    const rootEntry = resolveAgentsMdChain('pkg/x.ts', workspace, config)
      .find((entry) => entry.tier === 'root');
    expect(rootEntry).toBeDefined();
    store.seedRoot(rootEntry!);

    const injection = buildAgentsMdInjection(
      'read',
      { file_path: 'pkg/x.ts' },
      workspace,
      config,
      store,
    );

    expect(injection).not.toBeNull();
    expect(injection!.xml).toContain('nested instructions');
    expect(injection!.xml).not.toContain('root instructions');
    expect(injection!.injected).toHaveLength(1);
    expect(injection!.injected[0]?.tier).toBe('nested');
  });

  it('returns null when inject_on_read is false', () => {
    write('pkg/AGENTS.md', 'nested instructions');
    write('pkg/x.ts', 'code');

    const injection = buildAgentsMdInjection(
      'read',
      { file_path: 'pkg/x.ts' },
      workspace,
      agentsConfig({ inject_on_read: false }),
      store,
    );
    expect(injection).toBeNull();
  });

  it('returns null when the feature is disabled', () => {
    write('pkg/AGENTS.md', 'nested instructions');
    write('pkg/x.ts', 'code');

    const injection = buildAgentsMdInjection(
      'read',
      { file_path: 'pkg/x.ts' },
      workspace,
      agentsConfig({ enabled: false }),
      store,
    );
    expect(injection).toBeNull();
  });

  it('returns null for non-injectable tools (fan-out and mutators)', () => {
    write('pkg/AGENTS.md', 'nested instructions');
    write('pkg/x.ts', 'code');
    const config = agentsConfig();
    const args = { file_path: 'pkg/x.ts' };

    expect(buildAgentsMdInjection('grep', args, workspace, config, store)).toBeNull();
    expect(buildAgentsMdInjection('glob', args, workspace, config, store)).toBeNull();
    expect(buildAgentsMdInjection('rag_search', args, workspace, config, store)).toBeNull();
    expect(buildAgentsMdInjection('edit', args, workspace, config, store)).toBeNull();
    expect(buildAgentsMdInjection('write', args, workspace, config, store)).toBeNull();
  });

  it('returns null for a missing, empty, or non-string path arg', () => {
    write('pkg/AGENTS.md', 'nested instructions');
    write('pkg/x.ts', 'code');
    const config = agentsConfig();

    expect(buildAgentsMdInjection('read', {}, workspace, config, store)).toBeNull();
    expect(buildAgentsMdInjection('read', { file_path: '' }, workspace, config, store)).toBeNull();
    expect(buildAgentsMdInjection('read', { file_path: '   ' }, workspace, config, store)).toBeNull();
    expect(buildAgentsMdInjection('read', { file_path: 123 }, workspace, config, store)).toBeNull();
    // find_symbol_references treats file_path as optional — omitted skips injection.
    expect(buildAgentsMdInjection('find_symbol_references', { symbol_name: 'x' }, workspace, config, store)).toBeNull();
  });

  it('read_directory injects the AGENTS.md inside the directory itself (synthetic child)', () => {
    write('docs/AGENTS.md', 'docs instructions');
    fs.mkdirSync(path.join(workspace, 'docs'), { recursive: true });

    const injection = buildAgentsMdInjection(
      'read_directory',
      { directory_path: 'docs' },
      workspace,
      agentsConfig(),
      store,
    );

    expect(injection).not.toBeNull();
    expect(injection!.xml).toContain('docs instructions');
    expect(injection!.injected[0]?.displayPath).toBe(path.join('docs', 'AGENTS.md'));
  });

  it('read on a directory (isDirectory override) injects the AGENTS.md inside it', () => {
    write('docs/AGENTS.md', 'docs instructions');
    fs.mkdirSync(path.join(workspace, 'docs'), { recursive: true });

    const injection = buildAgentsMdInjection(
      'read',
      { file_path: 'docs' },
      workspace,
      agentsConfig(),
      store,
      { isDirectory: true },
    );

    expect(injection).not.toBeNull();
    expect(injection!.xml).toContain('docs instructions');
    expect(injection!.injected[0]?.displayPath).toBe(path.join('docs', 'AGENTS.md'));
  });

  it('read on a directory without the override resolves as a file target', () => {
    write('docs/AGENTS.md', 'docs instructions');
    fs.mkdirSync(path.join(workspace, 'docs'), { recursive: true });

    // Without the override, `read` treats the path as a file and walks from its
    // parent, so the AGENTS.md inside `docs` itself is not governed.
    const injection = buildAgentsMdInjection(
      'read',
      { file_path: 'docs' },
      workspace,
      agentsConfig(),
      store,
    );

    expect(injection).toBeNull();
  });

  it('renders an over-cap file with truncated="true" and a read pointer (R5)', () => {
    write('pkg/AGENTS.md', 'y'.repeat(100));
    write('pkg/x.ts', 'code');

    const injection = buildAgentsMdInjection(
      'read',
      { file_path: 'pkg/x.ts' },
      workspace,
      agentsConfig({ max_file_bytes: 50 }),
      store,
    );

    expect(injection).not.toBeNull();
    expect(injection!.xml).toContain('truncated="true"');
    expect(injection!.xml).toContain('y'.repeat(50));
    expect(injection!.xml).not.toContain('y'.repeat(51));
    expect(injection!.xml).toContain('use read');
  });

  it('re-injects a seen entry whose mtime changed on disk (R16)', () => {
    const agentsFile = write('pkg/AGENTS.md', 'version one');
    write('pkg/x.ts', 'code');
    const config = agentsConfig();
    const args = { file_path: 'pkg/x.ts' };

    const first = buildAgentsMdInjection('read', args, workspace, config, store);
    expect(first).not.toBeNull();
    first!.injected.forEach((entry) => store.markSeen(entry));
    expect(buildAgentsMdInjection('read', args, workspace, config, store)).toBeNull();

    // Rewrite and bump the mtime so the stored record is stale.
    fs.writeFileSync(agentsFile, 'version two', 'utf-8');
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(agentsFile, future, future);

    const refreshed = buildAgentsMdInjection('read', args, workspace, config, store);
    expect(refreshed).not.toBeNull();
    expect(refreshed!.xml).toContain('version two');
  });

  it('excludes the root tier from re-injection even when it changes, but re-injects a changed nested file (F5/R4/R16)', () => {
    const rootFile = write('AGENTS.md', 'root instructions');
    const nestedFile = write('pkg/AGENTS.md', 'nested one');
    write('pkg/x.ts', 'code');
    const config = agentsConfig();
    const args = { file_path: 'pkg/x.ts' };

    // Seed the root (U3) and mark the nested file seen, so only changes surface.
    const chain = resolveAgentsMdChain('pkg/x.ts', workspace, config);
    const rootEntry = chain.find((entry) => entry.tier === 'root');
    const nestedEntry = chain.find((entry) => entry.tier === 'nested');
    expect(rootEntry).toBeDefined();
    expect(nestedEntry).toBeDefined();
    store.seedRoot(rootEntry!);
    store.markSeen(nestedEntry!);

    // Bump BOTH files' mtimes on disk mid-turn.
    const future = new Date(Date.now() + 60_000);
    fs.writeFileSync(rootFile, 'root instructions (changed)', 'utf-8');
    fs.utimesSync(rootFile, future, future);
    fs.writeFileSync(nestedFile, 'nested two', 'utf-8');
    fs.utimesSync(nestedFile, future, future);

    const injection = buildAgentsMdInjection('read', args, workspace, config, store);

    // The changed nested file re-injects (R16)...
    expect(injection).not.toBeNull();
    expect(injection!.xml).toContain('nested two');
    expect(injection!.injected).toHaveLength(1);
    expect(injection!.injected[0]?.tier).toBe('nested');
    // ...but the changed root is never re-injected by the nested mechanism (R4/F5).
    expect(injection!.xml).not.toContain('tier="root"');
    expect(injection!.xml).not.toContain('root instructions (changed)');
  });

  it('renders AGENTS.md content as raw data without escaping', () => {
    write('pkg/AGENTS.md', '<script> & "quotes" >');
    write('pkg/x.ts', 'code');

    const injection = buildAgentsMdInjection(
      'read',
      { file_path: 'pkg/x.ts' },
      workspace,
      agentsConfig(),
      store,
    );

    expect(injection).not.toBeNull();
    expect(injection!.xml).toContain('<script> & "quotes" >');
    expect(injection!.xml).not.toContain('&lt;script&gt;');
    expect(injection!.xml).not.toContain('&amp;');
  });
});

describe('dispatch-level read-path injection', () => {
  const sessionId = `agents-md-injection-${Date.now()}`;
  let root: string;
  let workspace: string;
  let store: AgentsMdContextStore;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-agents-md-dispatch-'));
    workspace = path.join(root, 'workspace');
    fs.mkdirSync(path.join(workspace, 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'pkg', 'AGENTS.md'), 'nested dispatch rules', 'utf-8');
    fs.writeFileSync(path.join(workspace, 'pkg', 'x.ts'), 'code', 'utf-8');
    store = new AgentsMdContextStore();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('appends an <agents_md> block to a read tool projection end-to-end', async () => {
    // Lazy imports keep the heavy dispatch graph out of the pure-builder suite.
    const { executeToolCall, _setAgentsMdStoreResolverForTests } = await import(
      '../../src/main/llm/tool-dispatch'
    );
    const { ToolRegistry } = await import('../../src/main/tools/registry');
    const { genericToolResultDataSchema } = await import('../../src/shared/types/tool-result');
    const { sessionPermissionOverrides } = await import('../../src/main/permissions/session-overrides');

    const registry = new ToolRegistry();
    registry.register(
      {
        name: 'read',
        description: 'Read a file',
        inputSchema: z.object({ file_path: z.string() }),
        resultFamily: 'generic',
        outputDataSchema: genericToolResultDataSchema,
        category: 'filesystem',
        riskClass: 'read-only',
      },
      async () => ({ status: 'complete' as const, data: { value: 'file body' } }),
    );
    sessionPermissionOverrides.set(sessionId, 'allow');
    // The production resolver uses a native `createRequire` that cannot load
    // `.ts` under vitest, so inject the session store directly for this test.
    _setAgentsMdStoreResolverForTests(() => store);

    try {
      const first = await executeToolCall(
        { id: 'read-call', name: 'read', args: { file_path: 'pkg/x.ts' } },
        registry,
        { cwd: workspace, sessionId },
      );

      expect(first.canonical.status).toBe('complete');
      expect(first.agentProjection.content).toContain('<agents_md');
      expect(first.agentProjection.content).toContain('nested dispatch rules');
      // The block is appended after the tool_result envelope as a sibling.
      expect(first.agentProjection.content.lastIndexOf('</tool_result>')).toBeLessThan(
        first.agentProjection.content.indexOf('<agents_md'),
      );
      // Injection marked the entry seen, so a second read does not re-inject.
      expect(store.size).toBe(1);

      const second = await executeToolCall(
        { id: 'read-call-2', name: 'read', args: { file_path: 'pkg/x.ts' } },
        registry,
        { cwd: workspace, sessionId },
      );
      expect(second.agentProjection.content).not.toContain('<agents_md');
    } finally {
      _setAgentsMdStoreResolverForTests(null);
      sessionPermissionOverrides.delete(sessionId);
    }
  });
});
