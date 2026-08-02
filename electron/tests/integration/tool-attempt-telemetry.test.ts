/**
 * Tool attempt telemetry — integration tests for the 4 finalize exit paths in
 * `executeToolCall()` (tool-dispatch.ts).
 *
 * Verifies that a `tool_attempts` row is created (insertPending) and finalized
 * with the correct outcome / resultSizeBytes / offloaded / timedOut values at
 * every exit path:
 *
 * 1. Success path  — handler succeeds, finalization passes → outcome = canonical.status
 * 2. Error path     — handler throws → outcome = 'error'
 * 3. Parent abort   — handler succeeds but parentAbort fires → outcome = 'cancelled'
 * 4. Finalization error — handler succeeds but finalization pipeline throws → outcome = 'error'
 *
 * Also covers:
 * - Pre-aborted signal (early return before telemetry insert → no row created)
 * - Telemetry failure (insertPending throws → tool still executes successfully)
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { ToolRegistry } from '../../src/main/tools/registry';
import type { ToolHandler } from '../../src/main/tools/types';
import { genericToolResultDataSchema } from '../../src/shared/types/tool-result';
import {
  initializeToolAttemptStore,
  resetToolAttemptStore,
  getToolAttemptStore,
} from '../../src/main/providers/accounting/tool-attempt-store';

// ---------------------------------------------------------------------------
// Dynamic import — tool-dispatch pulls in heavy session/provider machinery at
// module scope; importing lazily keeps the test surface small and avoids
// touching the real SessionManager / provider runtime.
// ---------------------------------------------------------------------------

type ExecuteToolCall = typeof import('../../src/main/llm/tool-dispatch').executeToolCall;
type SetCacheRoot = typeof import('../../src/main/llm/tool-dispatch')._setToolOutputCacheRootForTests;
type SetAgentsMdResolver = typeof import('../../src/main/llm/tool-dispatch')._setAgentsMdStoreResolverForTests;

let executeToolCall: ExecuteToolCall;
let _setToolOutputCacheRootForTests: SetCacheRoot;
let _setAgentsMdStoreResolverForTests: SetAgentsMdResolver;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Standard dispatch options used by every test (cwd + agentsMdDisabled). */
function baseOptions(sessionId: string, cwd: string) {
  return {
    cwd,
    sessionId,
    agentsMdDisabled: true,
    timeoutSeconds: 5,
  };
}

/** Build a registry with one generic-family, read-only test tool. */
function makeRegistry(
  handler: ToolHandler,
  overrides: { outputDataSchema?: z.ZodTypeAny } = {},
): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(
    {
      name: 'test_tool',
      description: 'Test tool for telemetry verification',
      inputSchema: z.object({}),
      resultFamily: 'generic' as const,
      outputDataSchema: overrides.outputDataSchema ?? genericToolResultDataSchema,
      category: 'test',
      riskClass: 'read-only' as const,
    },
    handler,
  );
  return registry;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('tool attempt telemetry', () => {
  let tmpRoot: string;
  let dbPath: string;
  let workspace: string;
  let cacheRoot: string;
  let sessionId: string;

  beforeEach(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-tool-telemetry-'));
    dbPath = path.join(tmpRoot, 'accounting.db');
    workspace = path.join(tmpRoot, 'workspace');
    cacheRoot = path.join(tmpRoot, 'cache');
    fs.mkdirSync(workspace, { recursive: true });

    // Unique session id per test so rows never leak between cases.
    sessionId = `telemetry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Initialize the singleton store against a temp DB.
    initializeToolAttemptStore({ dbPath });

    // Lazy-load tool-dispatch (heavy import chain).
    const mod = await import('../../src/main/llm/tool-dispatch');
    executeToolCall = mod.executeToolCall;
    _setToolOutputCacheRootForTests = mod._setToolOutputCacheRootForTests;
    _setAgentsMdStoreResolverForTests = mod._setAgentsMdStoreResolverForTests;

    // Redirect cache writes to the temp dir so we never touch ~/.orchid.
    _setToolOutputCacheRootForTests(cacheRoot);

    // Ensure AGENTS.md resolution never touches the real SessionManager.
    _setAgentsMdStoreResolverForTests(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    _setToolOutputCacheRootForTests(null);
    _setAgentsMdStoreResolverForTests(null);
    resetToolAttemptStore();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  // ── 1. Success path ───────────────────────────────────────────────────────

  it('success path: finalizes with outcome matching canonical status', async () => {
    const handler: ToolHandler = async () => ({
      status: 'complete',
      data: { value: 'telemetry-success' },
    });
    const registry = makeRegistry(handler);

    const result = await executeToolCall(
      { id: 'call-success', name: 'test_tool', args: {} },
      registry,
      baseOptions(sessionId, workspace),
    );

    // The tool itself succeeded.
    expect(result.canonical.status).toBe('complete');

    const rows = getToolAttemptStore().listBySession(sessionId);
    expect(rows).toHaveLength(1);

    const row = rows[0]!;
    expect(row.outcome).toBe('complete');
    expect(row.resultSizeBytes).not.toBeNull();
    expect(row.resultSizeBytes!).toBeGreaterThan(0);
    expect(row.timedOut).toBe(false);
    expect(row.offloaded).toBe(false);
    expect(row.completedAt).not.toBeNull();
    expect(row.toolName).toBe('test_tool');
    expect(row.toolSource).toBe('builtin');
    expect(row.toolFamily).toBe('generic');
    expect(row.error).toBeNull();
  });

  // ── 2. Error path (handler throws) ────────────────────────────────────────

  it('error path: finalizes with outcome="error" when handler throws', async () => {
    const handler: ToolHandler = async () => {
      throw new Error('handler exploded');
    };
    const registry = makeRegistry(handler);

    const result = await executeToolCall(
      { id: 'call-error', name: 'test_tool', args: {} },
      registry,
      baseOptions(sessionId, workspace),
    );

    // The dispatch returns a terminal error result.
    expect(result.canonical.status).toBe('error');

    const rows = getToolAttemptStore().listBySession(sessionId);
    expect(rows).toHaveLength(1);

    const row = rows[0]!;
    expect(row.outcome).toBe('error');
    expect(row.timedOut).toBe(false);
    expect(row.resultSizeBytes).toBeNull();
    expect(row.offloaded).toBe(false);
    expect(row.completedAt).not.toBeNull();
    expect(row.error).toContain('handler exploded');
  });

  // ── 3. Parent abort path ─────────────────────────────────────────────────

  it('parent abort: finalizes with outcome="cancelled" when parentAbort fires after handler succeeds', async () => {
    const controller = new AbortController();
    // The handler aborts the parent signal during execution but still
    // returns a result — so the handler try-block resolves normally,
    // and the post-handler `parentAbort?.aborted` check (line 461) fires.
    const handler: ToolHandler = async () => {
      controller.abort();
      return { status: 'complete', data: { value: 'aborted-after-success' } };
    };
    const registry = makeRegistry(handler);

    const result = await executeToolCall(
      { id: 'call-parent-abort', name: 'test_tool', args: {} },
      registry,
      {
        ...baseOptions(sessionId, workspace),
        abortSignal: controller.signal,
      },
    );

    expect(result.canonical.status).toBe('cancelled');

    const rows = getToolAttemptStore().listBySession(sessionId);
    expect(rows).toHaveLength(1);

    const row = rows[0]!;
    expect(row.outcome).toBe('cancelled');
    expect(row.timedOut).toBe(false);
    expect(row.resultSizeBytes).toBeNull();
    expect(row.offloaded).toBe(false);
    expect(row.completedAt).not.toBeNull();
  });

  // ── 4. Finalization error path ────────────────────────────────────────────

  it('finalization error: finalizes with outcome="error" when result schema validation fails', async () => {
    // Register a tool whose outputDataSchema requires value: string.
    // The handler returns value: 123 (number) — createCanonicalToolResult
    // accepts it (jsonValueSchema), but finalizeToolExecutionResult's
    // tool-specific schema parse fails, triggering the finalization-error
    // catch block.
    const strictSchema = z.object({ value: z.string() });
    const handler: ToolHandler = async () => ({
      status: 'complete',
      // Intentionally wrong type — causes schema parse failure downstream.
      data: { value: 123 },
    });
    const registry = makeRegistry(handler, { outputDataSchema: strictSchema });

    const result = await executeToolCall(
      { id: 'call-finalization-error', name: 'test_tool', args: {} },
      registry,
      baseOptions(sessionId, workspace),
    );

    expect(result.canonical.status).toBe('error');

    const rows = getToolAttemptStore().listBySession(sessionId);
    expect(rows).toHaveLength(1);

    const row = rows[0]!;
    expect(row.outcome).toBe('error');
    expect(row.timedOut).toBe(false);
    expect(row.resultSizeBytes).toBeNull();
    expect(row.offloaded).toBe(false);
    expect(row.completedAt).not.toBeNull();
  });

  // ── 5. Pre-aborted signal (early return before telemetry) ───────────────

  it('pre-aborted signal: returns cancelled without creating a telemetry row', async () => {
    const controller = new AbortController();
    controller.abort();
    const handler: ToolHandler = async () => ({
      status: 'complete',
      data: { value: 'should-not-run' },
    });
    const registry = makeRegistry(handler);

    const result = await executeToolCall(
      { id: 'call-pre-aborted', name: 'test_tool', args: {} },
      registry,
      {
        ...baseOptions(sessionId, workspace),
        abortSignal: controller.signal,
      },
    );

    expect(result.canonical.status).toBe('cancelled');

    // The early-return at line 165 happens BEFORE the telemetry insert,
    // so no row should exist.
    const rows = getToolAttemptStore().listBySession(sessionId);
    expect(rows).toHaveLength(0);
  });

  // ── 6. Telemetry failure does not break execution ────────────────────────

  it('telemetry failure: tool still executes successfully when insertPending throws', async () => {
    const handler: ToolHandler = async () => ({
      status: 'complete',
      data: { value: 'telemetry-broken' },
    });
    const registry = makeRegistry(handler);

    // Sabotage the store so insertPending throws.
    const store = getToolAttemptStore();
    vi.spyOn(store, 'insertPending').mockImplementation(() => {
      throw new Error('simulated DB failure');
    });

    const result = await executeToolCall(
      { id: 'call-telemetry-fail', name: 'test_tool', args: {} },
      registry,
      baseOptions(sessionId, workspace),
    );

    // The tool executed successfully despite telemetry failure.
    expect(result.canonical.status).toBe('complete');

    // No telemetry row was finalized (toolAttemptId was null).
    const rows = getToolAttemptStore().listBySession(sessionId);
    expect(rows).toHaveLength(0);
  });
});
