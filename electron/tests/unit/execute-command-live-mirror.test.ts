/**
 * Foreground live output mirror tests (U2).
 *
 * Covers: live tail growth during execution, canonical semantics unchanged
 * (stdout/stderr separation, exit codes, truncation), finalize on
 * exit/timeout/abort, grace removal, LRU cap, dropSession/dropScope, and
 * toolCallId flow from dispatch/handler into the registry.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ForegroundLiveRegistry,
  setForegroundLiveRegistry,
} from '../../src/main/tools/process/foreground-live';
import {
  executeCommand,
  executeCommandHandler,
} from '../../src/main/tools/process/execute-command';
import { executeToolCall } from '../../src/main/llm/tool-dispatch';
import type { ToolRegistry } from '../../src/main/tools/registry';
import type { ToolExecutionContext } from '../../src/main/tools/types';
import { genericToolResultDataSchema } from '../../src/shared/types/tool-result';
import type { Config } from '../../src/main/config/schema';

const TEST_CONFIG: Pick<Config, 'command_timeout' | 'command_max_output_bytes'> = {
  command_timeout: 30,
  command_max_output_bytes: 1024 * 1024,
};

function resultText(result: Awaited<ReturnType<typeof executeCommand>>): string {
  const candidate = result as unknown as { data?: { value?: unknown }; content?: unknown };
  const value = candidate.data?.value ?? candidate.content;
  return typeof value === 'string' ? value : JSON.stringify(value ?? '');
}

function resultStatus(result: Awaited<ReturnType<typeof executeCommand>>): string {
  const candidate = result as unknown as { status?: string };
  return candidate.status ?? 'complete';
}

function resultValue(result: Awaited<ReturnType<typeof executeCommand>>): {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
} {
  const candidate = result as unknown as { data?: { value?: unknown } };
  return candidate.data?.value as { stdout: string; stderr: string; exitCode: number; truncated: boolean };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let registry: ForegroundLiveRegistry;

beforeEach(() => {
  registry = new ForegroundLiveRegistry({ graceMs: 500, maxEntries: 64 });
  setForegroundLiveRegistry(registry);
});

afterEach(() => {
  registry.clear();
});

// ---------------------------------------------------------------------------
// Live mirroring during foreground execution
// ---------------------------------------------------------------------------

describe('foreground live mirror', () => {
  it('streams output into the registry while the command runs', async () => {
    const toolCallId = 'tc-live-grow';
    const run = executeCommand({
      command: 'echo line-1; sleep 0.5; echo line-2; sleep 0.5; echo line-3',
      toolCallId,
      config: TEST_CONFIG,
    });

    // Poll for a mid-run snapshot with partial output and no exit code.
    let mid: { tail: string; exitCode: number | null } | undefined;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const snap = registry.snapshot(toolCallId);
      if (snap && snap.tail.includes('line-1') && !snap.tail.includes('line-3')) {
        mid = snap;
        break;
      }
      if (snap && snap.exitCode !== null) break; // finished before we sampled
      await sleep(25);
    }
    expect(mid, 'mid-run snapshot with partial output').toBeDefined();
    expect(mid!.exitCode).toBeNull();
    expect(mid!.tail).toContain('line-1');
    expect(mid!.tail).not.toContain('line-3');

    const result = await run;
    expect(resultStatus(result)).toBe('complete');

    // Post-completion snapshot keeps the full tail plus the final exit code.
    const done = registry.snapshot(toolCallId);
    expect(done).toBeDefined();
    expect(done!.exitCode).toBe(0);
    expect(done!.tail).toContain('line-1');
    expect(done!.tail).toContain('line-2');
    expect(done!.tail).toContain('line-3');
  }, 10_000);

  it('merges stdout and stderr into the live tail', async () => {
    const toolCallId = 'tc-live-merged';
    const result = await executeCommand({
      command: 'echo to-stdout; echo to-stderr >&2',
      toolCallId,
      config: TEST_CONFIG,
    });
    expect(resultStatus(result)).toBe('complete');

    const snap = registry.snapshot(toolCallId);
    expect(snap).toBeDefined();
    expect(snap!.exitCode).toBe(0);
    expect(snap!.tail).toContain('to-stdout');
    expect(snap!.tail).toContain('to-stderr');
  });

  it('finalizes with the real exit code on non-zero exit', async () => {
    const toolCallId = 'tc-live-exit';
    const result = await executeCommand({
      command: 'echo about-to-fail; exit 7',
      toolCallId,
      config: TEST_CONFIG,
    });
    expect(resultStatus(result)).toBe('error');
    expect(resultValue(result).exitCode).toBe(7);

    const snap = registry.snapshot(toolCallId);
    expect(snap).toBeDefined();
    expect(snap!.tail).toContain('about-to-fail');
    expect(snap!.exitCode).toBe(7);
  });

  it('finalizes with the -1 sentinel on inner timeout', async () => {
    const toolCallId = 'tc-live-timeout';
    const result = await executeCommand({
      command: 'echo started; sleep 10',
      timeout: 1,
      toolCallId,
      config: TEST_CONFIG,
    });
    expect(resultStatus(result)).toBe('error');
    expect(resultText(result)).toContain('timed out');

    const snap = registry.snapshot(toolCallId);
    expect(snap).toBeDefined();
    expect(snap!.tail).toContain('started');
    // SIGKILL'd processes report no exit code; -1 matches the
    // BackgroundProcessStore exit-event convention.
    expect(snap!.exitCode).toBe(-1);
  }, 10_000);

  it('finalizes with the -1 sentinel on abort', async () => {
    const toolCallId = 'tc-live-abort';
    const ac = new AbortController();
    const run = executeCommand({
      command: 'echo before-abort; sleep 10',
      timeout: 30,
      toolCallId,
      config: TEST_CONFIG,
      abortSignal: ac.signal,
    });
    await sleep(300);
    ac.abort();

    const result = await run;
    expect(resultStatus(result)).toBe('cancelled');

    const snap = registry.snapshot(toolCallId);
    expect(snap).toBeDefined();
    expect(snap!.tail).toContain('before-abort');
    expect(snap!.exitCode).toBe(-1);
  }, 10_000);

  it('skips mirroring entirely when toolCallId is absent', async () => {
    const result = await executeCommand({
      command: 'echo untracked',
      config: TEST_CONFIG,
    });
    expect(resultStatus(result)).toBe('complete');
    expect(resultText(result)).toContain('untracked');
    expect(registry.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Canonical semantics unchanged
// ---------------------------------------------------------------------------

describe('canonical foreground semantics with mirroring', () => {
  it('keeps stdout/stderr separation', async () => {
    const result = await executeCommand({
      command: 'echo out-text; echo err-text >&2',
      toolCallId: 'tc-separation',
      config: TEST_CONFIG,
    });
    expect(resultStatus(result)).toBe('complete');
    const value = resultValue(result);
    expect(value.stdout).toContain('out-text');
    expect(value.stdout).not.toContain('err-text');
    expect(value.stderr).toContain('err-text');
    expect(value.stderr).not.toContain('out-text');
    expect(value.exitCode).toBe(0);
  });

  it('keeps the truncation cap on the canonical result only', async () => {
    const toolCallId = 'tc-truncation';
    const result = await executeCommand({
      command: 'for i in $(seq 1 50); do printf AAAAAAAAAA; done',
      toolCallId,
      config: { command_timeout: 30, command_max_output_bytes: 64 },
    });
    expect(resultStatus(result)).toBe('complete');
    const value = resultValue(result);
    expect(value.truncated).toBe(true);
    expect(value.stdout.length).toBeLessThanOrEqual(64);

    // The mirror is additive and bounded by its own head/tail caps instead.
    const snap = registry.snapshot(toolCallId);
    expect(snap).toBeDefined();
    expect(snap!.exitCode).toBe(0);
    expect(snap!.tail.length).toBeGreaterThan(64);
  });

  it('returns identical outcomes with and without mirroring', async () => {
    const mirrored = await executeCommand({
      command: 'echo same-out; echo same-err >&2',
      toolCallId: 'tc-equivalence',
      config: TEST_CONFIG,
    });
    const plain = await executeCommand({
      command: 'echo same-out; echo same-err >&2',
      config: TEST_CONFIG,
    });
    expect(resultStatus(mirrored)).toBe('complete');
    expect(mirrored).toEqual(plain);

    const failingMirrored = await executeCommand({
      command: 'exit 3',
      toolCallId: 'tc-equivalence-fail',
      config: TEST_CONFIG,
    });
    const failingPlain = await executeCommand({
      command: 'exit 3',
      config: TEST_CONFIG,
    });
    expect(resultStatus(failingMirrored)).toBe('error');
    expect(failingMirrored).toEqual(failingPlain);
  });
});

// ---------------------------------------------------------------------------
// Registry unit behavior
// ---------------------------------------------------------------------------

describe('ForegroundLiveRegistry', () => {
  it('evicts the oldest entry when the cap is exceeded', () => {
    const reg = new ForegroundLiveRegistry({ maxEntries: 3 });
    for (const id of ['a', 'b', 'c', 'd']) {
      reg.register(id, { command: id, sessionId: null, agentScopeId: 'main' });
    }
    expect(reg.size).toBe(3);
    expect(reg.snapshot('a')).toBeUndefined();
    expect(reg.snapshot('b')).toBeDefined();
    expect(reg.snapshot('c')).toBeDefined();
    expect(reg.snapshot('d')).toBeDefined();
  });

  it('dropSession and dropScope remove only matching entries', () => {
    const reg = new ForegroundLiveRegistry();
    reg.register('c1', { command: 'x', sessionId: 's1', agentScopeId: 'main' });
    reg.register('c2', { command: 'x', sessionId: 's1', agentScopeId: 'sub-1' });
    reg.register('c3', { command: 'x', sessionId: 's2', agentScopeId: 'main' });

    reg.dropScope('s1', 'sub-1');
    expect(reg.snapshot('c2')).toBeUndefined();
    expect(reg.snapshot('c1')).toBeDefined();
    expect(reg.snapshot('c3')).toBeDefined();

    reg.dropSession('s1');
    expect(reg.snapshot('c1')).toBeUndefined();
    expect(reg.snapshot('c3')).toBeDefined();
    expect(reg.size).toBe(1);
  });

  it('append/finalize are safe no-ops for unknown ids; register is idempotent', () => {
    const reg = new ForegroundLiveRegistry();
    expect(() => reg.append('missing', Buffer.from('x'))).not.toThrow();
    expect(() => reg.finalize('missing', 0)).not.toThrow();
    expect(reg.snapshot('missing')).toBeUndefined();

    const first = reg.register('dup', { command: 'one', sessionId: null, agentScopeId: 'main' });
    const second = reg.register('dup', { command: 'two', sessionId: 'other', agentScopeId: 'x' });
    expect(second).toBe(first);
    expect(reg.size).toBe(1);
    expect(reg.get('dup')?.command).toBe('one');
  });

  it('finalize keeps the first exit code (idempotent)', () => {
    const reg = new ForegroundLiveRegistry();
    reg.register('f1', { command: 'x', sessionId: null, agentScopeId: 'main' });
    reg.finalize('f1', 3);
    reg.finalize('f1', -1);
    expect(reg.snapshot('f1')?.exitCode).toBe(3);
  });

  it('removes finalized entries after the grace period only', () => {
    vi.useFakeTimers();
    try {
      const reg = new ForegroundLiveRegistry({ graceMs: 1000 });
      reg.register('g1', { command: 'true', sessionId: null, agentScopeId: 'main' });
      reg.append('g1', Buffer.from('data\n'));
      reg.finalize('g1', 0);

      expect(reg.snapshot('g1')).toEqual({ tail: 'data\n', exitCode: 0 });
      vi.advanceTimersByTime(999);
      expect(reg.snapshot('g1')).toBeDefined();
      vi.advanceTimersByTime(1);
      expect(reg.snapshot('g1')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clear() drops entries and cancels pending removal timers', () => {
    vi.useFakeTimers();
    try {
      const reg = new ForegroundLiveRegistry({ graceMs: 1000 });
      reg.register('c1', { command: 'true', sessionId: null, agentScopeId: 'main' });
      reg.finalize('c1', 0);
      reg.clear();
      expect(reg.size).toBe(0);
      expect(() => vi.advanceTimersByTime(5000)).not.toThrow();
      expect(reg.snapshot('c1')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('snapshot honors lastN line selection', () => {
    const reg = new ForegroundLiveRegistry();
    reg.register('lines', { command: 'x', sessionId: null, agentScopeId: 'main' });
    reg.append('lines', Buffer.from('one\ntwo\nthree\n'));
    expect(reg.snapshot('lines', 2)?.tail).toBe('two\nthree\n');
  });

  it('snapshotForSession returns full metadata for the owning session', () => {
    const reg = new ForegroundLiveRegistry();
    const entry = reg.register('vis-1', {
      command: 'npm test',
      sessionId: 's1',
      agentScopeId: 'sub-7',
    });
    reg.append('vis-1', Buffer.from('one\ntwo\nthree\n'));
    reg.finalize('vis-1', 2);

    expect(reg.snapshotForSession('vis-1', 2, 's1')).toEqual({
      tail: 'two\nthree\n',
      exitCode: 2,
      running: false,
      command: 'npm test',
      agentScopeId: 'sub-7',
      createdAt: entry.startedAt,
    });
  });

  it('snapshotForSession reports running entries with a null exit code', () => {
    const reg = new ForegroundLiveRegistry();
    reg.register('vis-run', { command: 'sleep 5', sessionId: 's1', agentScopeId: 'main' });
    reg.append('vis-run', Buffer.from('working\n'));

    const snap = reg.snapshotForSession('vis-run', undefined, 's1');
    expect(snap).toMatchObject({ tail: 'working\n', exitCode: null, running: true });
    expect(snap?.createdAt).toBe(reg.get('vis-run')?.startedAt);
  });

  it('snapshotForSession denies mismatched sessions, unbound entries, and unknown ids', () => {
    const reg = new ForegroundLiveRegistry();
    reg.register('vis-2', { command: 'x', sessionId: 's1', agentScopeId: 'main' });
    reg.register('vis-unbound', { command: 'x', sessionId: null, agentScopeId: 'main' });

    expect(reg.snapshotForSession('vis-2', undefined, 's2')).toBeUndefined();
    expect(reg.snapshotForSession('vis-unbound', undefined, 's1')).toBeUndefined();
    expect(reg.snapshotForSession('vis-missing', undefined, 's1')).toBeUndefined();
  });

  it('dropSession and dropScope remove entries and cancel pending grace timers', () => {
    vi.useFakeTimers();
    try {
      const reg = new ForegroundLiveRegistry({ graceMs: 1000 });
      reg.register('d1', { command: 'x', sessionId: 's1', agentScopeId: 'main' });
      reg.register('d2', { command: 'x', sessionId: 's1', agentScopeId: 'sub-1' });
      reg.register('d3', { command: 'x', sessionId: 's2', agentScopeId: 'main' });
      reg.finalize('d1', 0);

      reg.dropScope('s1', 'sub-1');
      expect(reg.get('d2')).toBeUndefined();
      expect(reg.get('d1')).toBeDefined();
      expect(reg.get('d3')).toBeDefined();

      reg.dropSession('s1');
      expect(reg.get('d1')).toBeUndefined();
      expect(reg.get('d3')).toBeDefined();
      expect(reg.size).toBe(1);
      // The finalized entry's removal timer was cancelled with the drop.
      expect(() => vi.advanceTimersByTime(5000)).not.toThrow();
      expect(reg.get('d3')).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('dropScope with a null session id never matches (unbound entries survive)', () => {
    const reg = new ForegroundLiveRegistry();
    reg.register('u1', { command: 'x', sessionId: null, agentScopeId: 'scope-x' });
    reg.register('b1', { command: 'x', sessionId: 's1', agentScopeId: 'scope-x' });

    reg.dropScope(null, 'scope-x');

    expect(reg.get('u1')).toBeDefined();
    expect(reg.get('b1')).toBeDefined();
    expect(reg.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// toolCallId flow
// ---------------------------------------------------------------------------

describe('toolCallId flow', () => {
  it('executeCommandHandler passes ctx.toolCallId into the executor', async () => {
    const result = await executeCommandHandler(
      { command: 'echo via-handler' },
      { cwd: process.cwd(), toolCallId: 'tc-handler-1', sessionId: 'sess-live', agentScopeId: 'sub-9' },
    );
    expect(result.status).toBe('complete');

    const entry = registry.get('tc-handler-1');
    expect(entry).toBeDefined();
    expect(entry!.command).toBe('echo via-handler');
    expect(entry!.sessionId).toBe('sess-live');
    expect(entry!.agentScopeId).toBe('sub-9');
    expect(registry.snapshot('tc-handler-1')?.tail).toContain('via-handler');
    expect(registry.snapshot('tc-handler-1')?.exitCode).toBe(0);
  });

  it('executeCommandHandler defaults to sessionless main scope', async () => {
    const result = await executeCommandHandler(
      { command: 'echo defaults' },
      { cwd: process.cwd(), toolCallId: 'tc-handler-defaults' },
    );
    expect(result.status).toBe('complete');

    const entry = registry.get('tc-handler-defaults');
    expect(entry).toBeDefined();
    expect(entry!.sessionId).toBeNull();
    expect(entry!.agentScopeId).toBe('main');
  });

  it('executeToolCall sets ctx.toolCallId from the dispatch request id', async () => {
    let seenCtx: ToolExecutionContext | undefined;
    const stubRegistry = {
      get: () => ({
        definition: {
          name: 'probe',
          riskClass: 'read-only',
          resultFamily: 'generic',
          outputDataSchema: genericToolResultDataSchema,
        },
        handler: async (_input: unknown, ctx: ToolExecutionContext) => {
          seenCtx = ctx;
          return {
            status: 'complete' as const,
            data: { value: 'ok', origin: { kind: 'built-in' as const, name: 'probe' } },
          };
        },
      }),
      validate: (_name: string, args: unknown) => ({ ok: true as const, data: args }),
      listAll: () => [],
      getToolExecutionResultSchema: () => ({ parse: (value: unknown) => value }),
      resolveAgentProjector: () => ({
        source: 'generic',
        projector: () => ({ content: 'ok', completeness: 'complete' }),
      }),
    };

    const execution = await executeToolCall(
      { id: 'call-abc-123', name: 'probe', args: {} },
      stubRegistry as unknown as ToolRegistry,
      { cwd: process.cwd(), agentScopeId: 'main' },
    );

    expect(execution.canonical.status).toBe('complete');
    expect(seenCtx).toBeDefined();
    expect(seenCtx!.toolCallId).toBe('call-abc-123');
  });
});
