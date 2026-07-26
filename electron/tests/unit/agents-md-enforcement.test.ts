/**
 * Write-path AGENTS.md enforcement tests (U5).
 *
 * Covers the pure enforcement evaluator (mutator gating, governing-chain
 * aggregation, apply_patch fan-out, R10 instruction-file exemption, R16
 * staleness, R9 out-of-workspace) against temp-dir fixtures and a real
 * AgentsMdContextStore, plus dispatch-level tests proving the `block`, `warn`,
 * and `inject` policies behave end-to-end through executeToolCall.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  defaults,
  type AgentsMdConfig,
  type Config,
} from '../../src/main/config';
import { AGENTS_MD_DEFAULTS } from '../../src/main/agents-md/config';
import {
  buildAgentsMdBlockMessage,
  buildAgentsMdWarningBlock,
  evaluateAgentsMdEnforcement,
} from '../../src/main/agents-md/enforce';
import { resolveAgentsMdChain } from '../../src/main/agents-md/resolver';
import { AgentsMdContextStore } from '../../src/main/session/agents-md-context';

/** Build a full Config with `agents_md` overrides applied over the defaults. */
function agentsConfig(overrides: Partial<AgentsMdConfig> = {}): Config {
  return { ...defaults(), agents_md: { ...AGENTS_MD_DEFAULTS, ...overrides } };
}

describe('evaluateAgentsMdEnforcement', () => {
  let root: string;
  let workspace: string;
  let store: AgentsMdContextStore;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-agents-md-enforce-'));
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

  it('block policy surfaces an unseen governing file in `unseen`', () => {
    write('pkg/AGENTS.md', 'nested instructions');
    write('pkg/x.ts', 'code');

    const enforcement = evaluateAgentsMdEnforcement(
      'edit',
      { file_path: 'pkg/x.ts' },
      workspace,
      agentsConfig({ enforce_on_write: 'block' }),
      store,
    );

    expect(enforcement).not.toBeNull();
    expect(enforcement!.policy).toBe('block');
    expect(enforcement!.unseen).toHaveLength(1);
    expect(enforcement!.unseen[0]?.displayPath).toBe(path.join('pkg', 'AGENTS.md'));
    expect(enforcement!.editedInstructionFiles).toHaveLength(0);
  });

  it('returns null when the policy is `off`', () => {
    write('pkg/AGENTS.md', 'nested instructions');
    write('pkg/x.ts', 'code');

    const enforcement = evaluateAgentsMdEnforcement(
      'edit',
      { file_path: 'pkg/x.ts' },
      workspace,
      agentsConfig({ enforce_on_write: 'off' }),
      store,
    );
    expect(enforcement).toBeNull();
  });

  it('returns null when the feature is disabled', () => {
    write('pkg/AGENTS.md', 'nested instructions');
    write('pkg/x.ts', 'code');

    const enforcement = evaluateAgentsMdEnforcement(
      'edit',
      { file_path: 'pkg/x.ts' },
      workspace,
      agentsConfig({ enabled: false, enforce_on_write: 'block' }),
      store,
    );
    expect(enforcement).toBeNull();
  });

  it('returns null for non-mutator tools', () => {
    write('pkg/AGENTS.md', 'nested instructions');
    write('pkg/x.ts', 'code');
    const config = agentsConfig({ enforce_on_write: 'block' });
    const args = { file_path: 'pkg/x.ts' };

    expect(evaluateAgentsMdEnforcement('read', args, workspace, config, store)).toBeNull();
    expect(evaluateAgentsMdEnforcement('execute_command', { command: 'ls' }, workspace, config, store)).toBeNull();
    expect(evaluateAgentsMdEnforcement('grep', { pattern: 'x' }, workspace, config, store)).toBeNull();
  });

  it('applies to all five file mutators', () => {
    write('pkg/AGENTS.md', 'nested instructions');
    write('pkg/x.ts', 'code');
    const config = agentsConfig({ enforce_on_write: 'warn' });

    for (const toolName of ['edit', 'write', 'rename_symbol', 'replace_symbol']) {
      const enforcement = evaluateAgentsMdEnforcement(
        toolName,
        { file_path: 'pkg/x.ts' },
        workspace,
        config,
        store,
      );
      expect(enforcement, toolName).not.toBeNull();
      expect(enforcement!.unseen, toolName).toHaveLength(1);
    }

    const patch = evaluateAgentsMdEnforcement(
      'apply_patch',
      { patch: '*** Update File: pkg/x.ts\n' },
      workspace,
      config,
      store,
    );
    expect(patch).not.toBeNull();
    expect(patch!.unseen).toHaveLength(1);
  });

  it('reports no unseen files once the governing file is seen (any policy)', () => {
    write('pkg/AGENTS.md', 'nested instructions');
    write('pkg/x.ts', 'code');
    const config = agentsConfig({ enforce_on_write: 'block' });

    const chain = resolveAgentsMdChain('pkg/x.ts', workspace, config);
    chain.forEach((entry) => store.markSeen(entry));

    const enforcement = evaluateAgentsMdEnforcement(
      'edit',
      { file_path: 'pkg/x.ts' },
      workspace,
      config,
      store,
    );
    expect(enforcement).not.toBeNull();
    expect(enforcement!.unseen).toHaveLength(0);
  });

  it('aggregates unseen files across an apply_patch touching two trees (R8)', () => {
    write('pkg/AGENTS.md', 'pkg instructions');
    write('other/AGENTS.md', 'other instructions');
    const config = agentsConfig({ enforce_on_write: 'block' });
    const patch = [
      '*** Begin Patch',
      '*** Update File: pkg/a.ts',
      '*** Update File: other/b.ts',
      '*** End Patch',
    ].join('\n');

    const enforcement = evaluateAgentsMdEnforcement(
      'apply_patch',
      { patch },
      workspace,
      config,
      store,
    );

    expect(enforcement).not.toBeNull();
    const displayPaths = enforcement!.unseen.map((entry) => entry.displayPath).sort();
    expect(displayPaths).toEqual(
      [path.join('other', 'AGENTS.md'), path.join('pkg', 'AGENTS.md')].sort(),
    );
    // The block message names every unseen file in a single denial.
    const message = buildAgentsMdBlockMessage(enforcement!.unseen);
    expect(message).toContain(path.join('pkg', 'AGENTS.md'));
    expect(message).toContain(path.join('other', 'AGENTS.md'));
  });

  it('does not enforce a target outside the workspace (R9)', () => {
    write('pkg/AGENTS.md', 'nested instructions');
    const outside = path.join(root, 'outside', 'x.ts');
    fs.mkdirSync(path.dirname(outside), { recursive: true });
    fs.writeFileSync(outside, 'code', 'utf-8');

    const enforcement = evaluateAgentsMdEnforcement(
      'edit',
      { file_path: outside },
      workspace,
      agentsConfig({ enforce_on_write: 'block' }),
      store,
    );

    expect(enforcement).not.toBeNull();
    expect(enforcement!.unseen).toHaveLength(0);
  });

  it('exempts an instruction file being edited and records it for refresh (R10)', () => {
    write('pkg/AGENTS.md', 'nested instructions');
    const config = agentsConfig({ enforce_on_write: 'block' });

    const enforcement = evaluateAgentsMdEnforcement(
      'write',
      { file_path: 'pkg/AGENTS.md' },
      workspace,
      config,
      store,
    );

    expect(enforcement).not.toBeNull();
    // The edited instruction file is NOT treated as an unseen governing file...
    expect(enforcement!.unseen).toHaveLength(0);
    // ...but is surfaced so the dispatcher can refresh its tracker entry.
    expect(enforcement!.editedInstructionFiles).toHaveLength(1);
    expect(enforcement!.editedInstructionFiles[0]?.displayPath).toBe(
      path.join('pkg', 'AGENTS.md'),
    );
  });

  it('treats a seen-but-changed governing file as unseen again (R16)', () => {
    const agentsFile = write('pkg/AGENTS.md', 'version one');
    write('pkg/x.ts', 'code');
    const config = agentsConfig({ enforce_on_write: 'block' });
    const args = { file_path: 'pkg/x.ts' };

    const chain = resolveAgentsMdChain('pkg/x.ts', workspace, config);
    chain.forEach((entry) => store.markSeen(entry));
    expect(
      evaluateAgentsMdEnforcement('edit', args, workspace, config, store)!.unseen,
    ).toHaveLength(0);

    // Rewrite and bump the mtime so the stored record is stale.
    fs.writeFileSync(agentsFile, 'version two', 'utf-8');
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(agentsFile, future, future);

    const enforcement = evaluateAgentsMdEnforcement('edit', args, workspace, config, store);
    expect(enforcement!.unseen).toHaveLength(1);
    expect(enforcement!.unseen[0]?.displayPath).toBe(path.join('pkg', 'AGENTS.md'));
  });

  it('escapes XML metacharacters in the warning block', () => {
    const block = buildAgentsMdWarningBlock([
      {
        path: '/w/pkg/AGENTS.md',
        displayPath: 'pkg/<weird> & "AGENTS".md',
        tier: 'nested',
        sizeBytes: 1,
        mtimeMs: 1,
      },
    ]);
    expect(block).toContain('<agents_md_warning>');
    expect(block).toContain('&lt;weird&gt;');
    expect(block).toContain('&amp;');
    expect(block).not.toContain('<weird>');
  });
});

describe('dispatch-level write enforcement', () => {
  const sessionId = `agents-md-enforcement-${Date.now()}`;
  let root: string;
  let workspace: string;
  let store: AgentsMdContextStore;
  let handler: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-agents-md-enforce-dispatch-'));
    workspace = path.join(root, 'workspace');
    fs.mkdirSync(path.join(workspace, 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'pkg', 'AGENTS.md'), 'nested dispatch rules', 'utf-8');
    fs.writeFileSync(path.join(workspace, 'pkg', 'x.ts'), 'code', 'utf-8');
    store = new AgentsMdContextStore();
    handler = vi.fn(async () => ({ status: 'complete' as const, data: { value: 'wrote' } }));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /** Register a generic-family tool named `write` (enforcement keys off the name). */
  async function registerWriteTool() {
    const { ToolRegistry } = await import('../../src/main/tools/registry');
    const { genericToolResultDataSchema } = await import('../../src/shared/types/tool-result');
    const registry = new ToolRegistry();
    registry.register(
      {
        name: 'write',
        description: 'Write a file',
        inputSchema: z.object({ file_path: z.string(), content: z.string().optional() }),
        resultFamily: 'generic',
        outputDataSchema: genericToolResultDataSchema,
        category: 'filesystem',
        riskClass: 'write',
      },
      handler,
    );
    return registry;
  }

  it('block: denies the mutation with a terminal error and never runs the handler', async () => {
    const { executeToolCall, _setAgentsMdStoreResolverForTests } = await import(
      '../../src/main/llm/tool-dispatch'
    );
    const { sessionPermissionOverrides } = await import('../../src/main/ipc/permission');
    const registry = await registerWriteTool();
    sessionPermissionOverrides.set(sessionId, 'allow');
    _setAgentsMdStoreResolverForTests(() => store);

    try {
      const result = await executeToolCall(
        { id: 'write-block', name: 'write', args: { file_path: 'pkg/x.ts', content: 'new' } },
        registry,
        {
          cwd: workspace,
          sessionId,
          projectRuntime: { config: agentsConfig({ enforce_on_write: 'block' }) } as never,
        },
      );

      expect(result.canonical.status).toBe('error');
      expect(result.canonical.error?.code).toBe('agents_md_not_in_context');
      expect(result.agentProjection.content).toContain(path.join('pkg', 'AGENTS.md'));
      expect(result.agentProjection.content).toContain('blocked');
      expect(handler).not.toHaveBeenCalled();
      // Nothing was injected, so the tracker stays empty.
      expect(store.size).toBe(0);
    } finally {
      _setAgentsMdStoreResolverForTests(null);
      sessionPermissionOverrides.delete(sessionId);
    }
  });

  it('warn: runs the handler and appends an <agents_md_warning> without marking seen', async () => {
    const { executeToolCall, _setAgentsMdStoreResolverForTests } = await import(
      '../../src/main/llm/tool-dispatch'
    );
    const { sessionPermissionOverrides } = await import('../../src/main/ipc/permission');
    const registry = await registerWriteTool();
    sessionPermissionOverrides.set(sessionId, 'allow');
    _setAgentsMdStoreResolverForTests(() => store);

    try {
      // No projectRuntime: the default policy is `warn` (FALLBACK_CONFIG).
      const result = await executeToolCall(
        { id: 'write-warn', name: 'write', args: { file_path: 'pkg/x.ts', content: 'new' } },
        registry,
        { cwd: workspace, sessionId },
      );

      expect(result.canonical.status).toBe('complete');
      expect(handler).toHaveBeenCalledOnce();
      expect(result.agentProjection.content).toContain('<agents_md_warning>');
      expect(result.agentProjection.content).toContain(path.join('pkg', 'AGENTS.md'));
      // The warning does not inject content, so the file is NOT marked seen.
      expect(store.size).toBe(0);
    } finally {
      _setAgentsMdStoreResolverForTests(null);
      sessionPermissionOverrides.delete(sessionId);
    }
  });

  it('inject: runs the handler, appends the <agents_md> content, and marks seen', async () => {
    const { executeToolCall, _setAgentsMdStoreResolverForTests } = await import(
      '../../src/main/llm/tool-dispatch'
    );
    const { sessionPermissionOverrides } = await import('../../src/main/ipc/permission');
    const registry = await registerWriteTool();
    sessionPermissionOverrides.set(sessionId, 'allow');
    _setAgentsMdStoreResolverForTests(() => store);

    try {
      const result = await executeToolCall(
        { id: 'write-inject', name: 'write', args: { file_path: 'pkg/x.ts', content: 'new' } },
        registry,
        {
          cwd: workspace,
          sessionId,
          projectRuntime: { config: agentsConfig({ enforce_on_write: 'inject' }) } as never,
        },
      );

      expect(result.canonical.status).toBe('complete');
      expect(handler).toHaveBeenCalledOnce();
      expect(result.agentProjection.content).toContain('<agents_md');
      expect(result.agentProjection.content).toContain('nested dispatch rules');
      // Injection puts the content in context, so the entry is marked seen.
      expect(store.size).toBe(1);
    } finally {
      _setAgentsMdStoreResolverForTests(null);
      sessionPermissionOverrides.delete(sessionId);
    }
  });

  it('R10: editing an instruction file itself is allowed under block and refreshes it', async () => {
    const { executeToolCall, _setAgentsMdStoreResolverForTests } = await import(
      '../../src/main/llm/tool-dispatch'
    );
    const { sessionPermissionOverrides } = await import('../../src/main/ipc/permission');
    const registry = await registerWriteTool();
    sessionPermissionOverrides.set(sessionId, 'allow');
    _setAgentsMdStoreResolverForTests(() => store);

    try {
      const result = await executeToolCall(
        { id: 'write-agents', name: 'write', args: { file_path: 'pkg/AGENTS.md', content: 'new' } },
        registry,
        {
          cwd: workspace,
          sessionId,
          projectRuntime: { config: agentsConfig({ enforce_on_write: 'block' }) } as never,
        },
      );

      // Not blocked: the instruction file being edited is exempt (R10).
      expect(result.canonical.status).toBe('complete');
      expect(handler).toHaveBeenCalledOnce();
      // Phase B refreshed the tracker entry for the edited instruction file.
      expect(store.size).toBe(1);
      const entry = resolveAgentsMdChain('pkg/AGENTS.md', workspace, agentsConfig())[0];
      expect(store.isSeen(entry!.path)).toBe(true);
    } finally {
      _setAgentsMdStoreResolverForTests(null);
      sessionPermissionOverrides.delete(sessionId);
    }
  });

  it('R17: never blocks when no store is resolvable, even under block policy', async () => {
    const { executeToolCall, _setAgentsMdStoreResolverForTests } = await import(
      '../../src/main/llm/tool-dispatch'
    );
    const { sessionPermissionOverrides } = await import('../../src/main/ipc/permission');
    const registry = await registerWriteTool();
    sessionPermissionOverrides.set(sessionId, 'allow');
    // Simulate the no-session degradation: the store resolver yields nothing.
    _setAgentsMdStoreResolverForTests(() => null);

    try {
      const result = await executeToolCall(
        { id: 'write-nostore', name: 'write', args: { file_path: 'pkg/x.ts', content: 'new' } },
        registry,
        {
          cwd: workspace,
          sessionId,
          projectRuntime: { config: agentsConfig({ enforce_on_write: 'block' }) } as never,
        },
      );

      expect(result.canonical.status).toBe('complete');
      expect(handler).toHaveBeenCalledOnce();
    } finally {
      _setAgentsMdStoreResolverForTests(null);
      sessionPermissionOverrides.delete(sessionId);
    }
  });
});
