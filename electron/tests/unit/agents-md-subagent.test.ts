/**
 * Subagent AGENTS.md handling tests (U6).
 *
 * Covers the two U6 guarantees plus the no-session degradation they rely on:
 * - Subagents START FRESH WITH THE ROOT: `seedSubagentRootAgentsMd` seeds only
 *   the subagent's scope-keyed store with the root instruction file (R13/R15),
 *   never touching the parent/main store, so the nested read-path mechanism
 *   never re-injects the root for the subagent (R4).
 * - The renderer `tool:execute` UI path opts out of AGENTS.md injection and
 *   write enforcement via `agentsMdDisabled` (R17/UI).
 * - Dispatch without a session degrades safely: no injection, no blocking (R17).
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
import { buildAgentsMdInjection } from '../../src/main/agents-md/inject';
import {
  findRootAgentsMdEntry,
  seedSubagentRootAgentsMd,
} from '../../src/main/project/agents-md';
import type { ProjectRuntime } from '../../src/main/project/runtime';
import { AgentsMdContextStore } from '../../src/main/session/agents-md-context';
import { SessionManager } from '../../src/main/session/manager';
import { _clearDbCache } from '../../src/main/session/storage';
import type { AgentsMdEntry } from '../../src/main/agents-md/resolver';

/** Build a full Config with `agents_md` overrides applied over the defaults. */
function agentsConfig(overrides: Partial<AgentsMdConfig> = {}): Config {
  return { ...defaults(), agents_md: { ...AGENTS_MD_DEFAULTS, ...overrides } };
}

/** Minimal ProjectRuntime carrying only what the AGENTS.md helpers read. */
function runtimeFor(projectDir: string, config: Config): ProjectRuntime {
  return { projectDir, config } as unknown as ProjectRuntime;
}

function makeEntry(
  filePath: string,
  mtimeMs = 1000,
  tier: 'root' | 'nested' = 'nested',
): AgentsMdEntry {
  return { path: filePath, displayPath: filePath, tier, sizeBytes: 42, mtimeMs };
}

describe('subagent AGENTS.md seeding and scope isolation', () => {
  const sessionId = `agents-md-subagent-${Date.now()}`;
  let tmpDir: string;
  let workspace: string;
  let manager: SessionManager;
  let config: Config;
  let runtime: ProjectRuntime;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-agents-md-subagent-'));
    workspace = path.join(tmpDir, 'workspace');
    fs.mkdirSync(path.join(workspace, 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'AGENTS.md'), 'root instructions', 'utf-8');
    fs.writeFileSync(path.join(workspace, 'pkg', 'AGENTS.md'), 'nested instructions', 'utf-8');
    fs.writeFileSync(path.join(workspace, 'pkg', 'x.ts'), 'code', 'utf-8');
    manager = new SessionManager({
      storage: { dbPath: path.join(tmpDir, 'sessions.db') },
    });
    config = agentsConfig();
    runtime = runtimeFor(workspace, config);
  });

  afterEach(() => {
    _clearDbCache();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('seeds the root into the given scope store only; other scopes stay empty', () => {
    const rootEntry = findRootAgentsMdEntry(workspace, config);
    expect(rootEntry).not.toBeNull();

    seedSubagentRootAgentsMd(sessionId, 'sub-1', runtime, manager);

    const subStore = manager.getAgentsMdContextStore(sessionId, 'sub-1');
    expect(subStore.isSeen(rootEntry!.path)).toBe(true);
    expect(subStore.size).toBe(1);
    // A fresh store for a different scope is still empty (no inheritance).
    expect(manager.getAgentsMdContextStore(sessionId, 'sub-2').size).toBe(0);
  });

  it('seeding a subagent scope does not mark the main scope, and vice versa (R15)', () => {
    seedSubagentRootAgentsMd(sessionId, 'sub-1', runtime, manager);

    const sub = manager.getAgentsMdContextStore(sessionId, 'sub-1');
    const main = manager.getAgentsMdContextStore(sessionId, 'main');
    const rootEntry = findRootAgentsMdEntry(workspace, config)!;

    // The subagent seed landed in the subagent scope...
    expect(sub.isSeen(rootEntry.path)).toBe(true);
    // ...and did NOT touch the parent/main store.
    expect(main.isSeen(rootEntry.path)).toBe(false);
    expect(main.size).toBe(0);

    // Vice versa: marking the main scope does not leak into the subagent scope.
    const nested = makeEntry(path.join(workspace, 'pkg', 'AGENTS.md'));
    main.markSeen(nested);
    expect(main.isSeen(nested.path)).toBe(true);
    expect(sub.isSeen(nested.path)).toBe(false);
  });

  it('a subagent store seeded with the root injects only the nested file on read (R4)', () => {
    seedSubagentRootAgentsMd(sessionId, 'sub-1', runtime, manager);
    const subStore = manager.getAgentsMdContextStore(sessionId, 'sub-1');

    const injection = buildAgentsMdInjection(
      'read',
      { file_path: 'pkg/x.ts' },
      workspace,
      config,
      subStore,
    );

    expect(injection).not.toBeNull();
    expect(injection!.xml).toContain('nested instructions');
    expect(injection!.xml).not.toContain('root instructions');
    expect(injection!.injected).toHaveLength(1);
    expect(injection!.injected[0]?.tier).toBe('nested');
  });

  it('no-ops without a session id (never throws, seeds nothing)', () => {
    expect(() =>
      seedSubagentRootAgentsMd(undefined, 'sub-1', runtime, manager),
    ).not.toThrow();
    expect(manager.getAgentsMdContextStore(sessionId, 'sub-1').size).toBe(0);
  });

  it('seeds nothing when there is no root instruction file', () => {
    const bare = path.join(tmpDir, 'bare');
    fs.mkdirSync(bare);
    seedSubagentRootAgentsMd(sessionId, 'sub-1', runtimeFor(bare, config), manager);
    expect(manager.getAgentsMdContextStore(sessionId, 'sub-1').size).toBe(0);
  });

  it('seeds nothing when the feature is disabled', () => {
    const disabled = runtimeFor(workspace, agentsConfig({ enabled: false }));
    seedSubagentRootAgentsMd(sessionId, 'sub-1', disabled, manager);
    expect(manager.getAgentsMdContextStore(sessionId, 'sub-1').size).toBe(0);
  });
});

describe('dispatch-level UI gating (agentsMdDisabled)', () => {
  const sessionId = `agents-md-subagent-ui-${Date.now()}`;
  let root: string;
  let workspace: string;
  let store: AgentsMdContextStore;
  let writeHandler: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-agents-md-subagent-ui-'));
    workspace = path.join(root, 'workspace');
    fs.mkdirSync(path.join(workspace, 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'pkg', 'AGENTS.md'), 'nested dispatch rules', 'utf-8');
    fs.writeFileSync(path.join(workspace, 'pkg', 'x.ts'), 'code', 'utf-8');
    store = new AgentsMdContextStore();
    writeHandler = vi.fn(async () => ({ status: 'complete' as const, data: { value: 'wrote' } }));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function registerReadTool() {
    const { ToolRegistry } = await import('../../src/main/tools/registry');
    const { genericToolResultDataSchema } = await import('../../src/shared/types/tool-result');
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
    return registry;
  }

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
      writeHandler,
    );
    return registry;
  }

  it('read with agentsMdDisabled does not append an <agents_md> block', async () => {
    const { executeToolCall, _setAgentsMdStoreResolverForTests } = await import(
      '../../src/main/llm/tool-dispatch'
    );
    const { sessionPermissionOverrides } = await import('../../src/main/permissions/session-overrides');
    const registry = await registerReadTool();
    sessionPermissionOverrides.set(sessionId, 'allow');
    _setAgentsMdStoreResolverForTests(() => store);

    try {
      const gated = await executeToolCall(
        { id: 'read-ui', name: 'read', args: { file_path: 'pkg/x.ts' } },
        registry,
        { cwd: workspace, sessionId, agentsMdDisabled: true },
      );

      expect(gated.canonical.status).toBe('complete');
      expect(gated.agentProjection.content).not.toContain('<agents_md');
      // Nothing was injected, so the tracker stays empty.
      expect(store.size).toBe(0);

      // Control: the same store with the flag off DOES inject — proving the
      // flag (not an empty store) is what gated the injection.
      const control = await executeToolCall(
        { id: 'read-ui-control', name: 'read', args: { file_path: 'pkg/x.ts' } },
        registry,
        { cwd: workspace, sessionId },
      );
      expect(control.agentProjection.content).toContain('<agents_md');
      expect(store.size).toBe(1);
    } finally {
      _setAgentsMdStoreResolverForTests(null);
      sessionPermissionOverrides.delete(sessionId);
    }
  });

  it('write with agentsMdDisabled is not blocked under the block policy', async () => {
    const { executeToolCall, _setAgentsMdStoreResolverForTests } = await import(
      '../../src/main/llm/tool-dispatch'
    );
    const { sessionPermissionOverrides } = await import('../../src/main/permissions/session-overrides');
    const registry = await registerWriteTool();
    sessionPermissionOverrides.set(sessionId, 'allow');
    _setAgentsMdStoreResolverForTests(() => store);
    const blockRuntime = {
      config: agentsConfig({ enforce_on_write: 'block' }),
    } as never;

    try {
      const gated = await executeToolCall(
        { id: 'write-ui', name: 'write', args: { file_path: 'pkg/x.ts', content: 'new' } },
        registry,
        { cwd: workspace, sessionId, agentsMdDisabled: true, projectRuntime: blockRuntime },
      );

      // Enforcement was skipped, so the mutation ran despite the unseen file.
      expect(gated.canonical.status).toBe('complete');
      expect(writeHandler).toHaveBeenCalledTimes(1);

      // Control: the same store/policy with the flag off IS blocked.
      const control = await executeToolCall(
        { id: 'write-ui-control', name: 'write', args: { file_path: 'pkg/x.ts', content: 'new' } },
        registry,
        { cwd: workspace, sessionId, projectRuntime: blockRuntime },
      );
      expect(control.canonical.status).toBe('error');
      expect(control.canonical.error?.code).toBe('agents_md_not_in_context');
      expect(writeHandler).toHaveBeenCalledTimes(1);
    } finally {
      _setAgentsMdStoreResolverForTests(null);
      sessionPermissionOverrides.delete(sessionId);
    }
  });
});

describe('dispatch-level no-session degradation (R17)', () => {
  let root: string;
  let workspace: string;
  let store: AgentsMdContextStore;
  let writeHandler: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-agents-md-subagent-nosession-'));
    workspace = path.join(root, 'workspace');
    fs.mkdirSync(path.join(workspace, 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'pkg', 'AGENTS.md'), 'nested dispatch rules', 'utf-8');
    fs.writeFileSync(path.join(workspace, 'pkg', 'x.ts'), 'code', 'utf-8');
    store = new AgentsMdContextStore();
    writeHandler = vi.fn(async () => ({ status: 'complete' as const, data: { value: 'wrote' } }));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('read with no sessionId injects nothing even with a resolvable store', async () => {
    const { executeToolCall, _setAgentsMdStoreResolverForTests } = await import(
      '../../src/main/llm/tool-dispatch'
    );
    const { ToolRegistry } = await import('../../src/main/tools/registry');
    const { genericToolResultDataSchema } = await import('../../src/shared/types/tool-result');
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
    // A store with unseen content: if injection wrongly ran, it would inject.
    _setAgentsMdStoreResolverForTests(() => store);

    try {
      const result = await executeToolCall(
        { id: 'read-nosession', name: 'read', args: { file_path: 'pkg/x.ts' } },
        registry,
        { cwd: workspace }, // no sessionId
      );

      expect(result.canonical.status).toBe('complete');
      expect(result.agentProjection.content).not.toContain('<agents_md');
      expect(store.size).toBe(0);
    } finally {
      _setAgentsMdStoreResolverForTests(null);
    }
  });

  it('write with no sessionId is not blocked under the block policy', async () => {
    const { executeToolCall } = await import('../../src/main/llm/tool-dispatch');
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
      writeHandler,
    );
    // No session → no session permission override; allow the mutator via a
    // project-config rule so the AGENTS.md path (not permission) is under test.
    const blockRuntime = {
      config: {
        ...agentsConfig({ enforce_on_write: 'block' }),
        permissions: { write: 'allow' },
      },
    } as never;

    const result = await executeToolCall(
      { id: 'write-nosession', name: 'write', args: { file_path: 'pkg/x.ts', content: 'new' } },
      registry,
      { cwd: workspace, projectRuntime: blockRuntime }, // no sessionId
    );

    expect(result.canonical.status).toBe('complete');
    expect(writeHandler).toHaveBeenCalledOnce();
  });
});
