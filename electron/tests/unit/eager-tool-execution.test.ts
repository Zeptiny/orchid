/**
 * Eager tool execution — buildToolMap integration tests (U2/U3 contract).
 *
 * Exercises the real launcher → executeToolCall → handler path and the
 * `execute` shim that awaits the pre-started in-flight promise. Proves:
 *  - a tool begins executing at `start()` time (mid-stream), not at step end;
 *  - the SDK's later `execute` call awaits the same run (no double execution);
 *  - without a pre-start, `execute` falls back to running the tool normally;
 *  - handler errors surface through the shim as normal terminal results.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { buildToolMap } from '../../src/main/llm/orchestrator';
import { EagerToolExecutor } from '../../src/main/llm/eager-tool-executor';
import { ToolRegistry } from '../../src/main/tools/registry';
import { genericToolResultDataSchema } from '../../src/shared/types/tool-result';
import type { ToolHandler } from '../../src/main/tools/types';
import type { MCPManager } from '../../src/main/mcp/manager';
import type { Skill } from '../../src/shared/types/skill';
import { sessionPermissionOverrides } from '../../src/main/ipc/permission';

type ExecFn = (
  args: unknown,
  opts: { toolCallId: string; abortSignal?: AbortSignal },
) => Promise<unknown>;

describe('eager tool execution via buildToolMap', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-eager-exec-'));
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function registerTool(registry: ToolRegistry, name: string, handler: ToolHandler): void {
    registry.register(
      {
        name,
        description: `test tool ${name}`,
        inputSchema: z.object({ x: z.number().optional() }),
        resultFamily: 'generic',
        outputDataSchema: genericToolResultDataSchema,
        category: 'search',
        riskClass: 'read',
      },
      handler,
    );
  }

  function buildMap(handler: ToolHandler, eager?: EagerToolExecutor) {
    const registry = new ToolRegistry();
    registerTool(registry, 'slow', handler);
    const tools = buildToolMap(
      ['slow'],
      registry,
      null,
      { cwd, timeoutSeconds: 30 },
      undefined,
      eager,
    );
    return tools;
  }

  it('starts the handler at start() time and the execute shim awaits the same run', async () => {
    const eager = new EagerToolExecutor();
    let release!: () => void;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    let started = false;
    const handler = vi.fn(async () => {
      started = true;
      await gate;
      return { status: 'complete' as const, data: { value: 'done' } };
    });
    const tools = buildMap(handler, eager);

    // Mimic the stream loop on `tool-input-available`: start before step end.
    eager.start('call-1', 'slow', { x: 1 });
    expect(eager.getOrStart('call-1', 'slow', { x: 1 })).toBeInstanceOf(Promise);

    // Execution began from `start()` alone — flush the permission-gate microtask
    // so the handler runs up to the gate. The gate keeps it in-flight, proving
    // it started before any `execute` call (i.e. before model-call-end).
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    expect(started).toBe(true);

    // The SDK now calls execute at step end; it must await the in-flight run.
    const execPromise = (tools.slow.execute as unknown as ExecFn)({ x: 1 }, { toolCallId: 'call-1' });
    release();
    const result = (await execPromise) as { canonical: { status: string } };

    expect(result.canonical.status).toBe('complete');
    // Exactly one execution total — the shim did not re-run the handler.
    expect(handler).toHaveBeenCalledOnce();
  });

  it('execute falls back to running the tool when it was not pre-started', async () => {
    const eager = new EagerToolExecutor();
    const handler = vi.fn(async () => ({ status: 'complete' as const, data: { value: 'fallback' } }));
    const tools = buildMap(handler, eager);

    const result = (await (tools.slow.execute as unknown as ExecFn)(
      { x: 2 },
      { toolCallId: 'never-started' },
    )) as { canonical: { status: string } };

    expect(result.canonical.status).toBe('complete');
    expect(handler).toHaveBeenCalledOnce();
  });

  it('works with no eager executor at all (pure fallback path)', async () => {
    const handler = vi.fn(async () => ({ status: 'complete' as const, data: { value: 'plain' } }));
    const tools = buildMap(handler, undefined);

    const result = (await (tools.slow.execute as unknown as ExecFn)(
      { x: 3 },
      { toolCallId: 'plain-call' },
    )) as { canonical: { status: string } };

    expect(result.canonical.status).toBe('complete');
    expect(handler).toHaveBeenCalledOnce();
  });

  it('surfaces a handler error through the shim as a terminal error result', async () => {
    const eager = new EagerToolExecutor();
    const handler = vi.fn(async () => {
      throw new Error('handler boom');
    });
    const tools = buildMap(handler, eager);

    eager.start('call-err', 'slow', { x: 1 });
    const result = (await (tools.slow.execute as unknown as ExecFn)(
      { x: 1 },
      { toolCallId: 'call-err' },
    )) as { canonical: { status: string } };

    expect(result.canonical.status).toBe('error');
    expect(handler).toHaveBeenCalledOnce();
  });

  it('start() for an unregistered tool is a no-op; execute still falls back', async () => {
    const eager = new EagerToolExecutor();
    const handler = vi.fn(async () => ({ status: 'complete' as const, data: { value: 'ok' } }));
    const tools = buildMap(handler, eager);

    // No launcher for 'unknown' — start does nothing.
    eager.start('call-x', 'unknown', {});
    expect(eager.getOrStart('call-x', 'unknown', {})).toBeUndefined();

    const result = (await (tools.slow.execute as unknown as ExecFn)(
      { x: 9 },
      { toolCallId: 'call-x' },
    )) as { canonical: { status: string } };
    expect(result.canonical.status).toBe('complete');
    expect(handler).toHaveBeenCalledOnce();
  });

  it('start() with invalid input is a no-op; execute falls back to a validation error', async () => {
    const eager = new EagerToolExecutor();
    const handler = vi.fn(async () => ({ status: 'complete' as const, data: { value: 'ok' } }));
    const tools = buildMap(handler, eager);

    eager.start('call-bad', 'slow', { x: 'nope' });
    expect(eager.getOrStart('call-bad', 'slow', { x: 'nope' })).toBeUndefined();

    const result = (await (tools.slow.execute as unknown as ExecFn)(
      { x: 'nope' },
      { toolCallId: 'call-bad' },
    )) as { canonical: { status: string } };
    expect(result.canonical.status).toBe('error');
    expect(handler).not.toHaveBeenCalled();
  });

  it('executes exactly once when the execute shim runs before the stream loop starts the tool', async () => {
    const eager = new EagerToolExecutor();
    const handler = vi.fn(async () => ({ status: 'complete' as const, data: { value: 'shim-first' } }));
    const tools = buildMap(handler, eager);

    // Race case: the SDK calls execute (shim) before the stream loop's start().
    const execPromise = (tools.slow.execute as unknown as ExecFn)({ x: 5 }, { toolCallId: 'call-race' });
    // The stream loop's later start() must not launch a second execution.
    eager.start('call-race', 'slow', { x: 5 });

    const result = (await execPromise) as { canonical: { status: string } };
    expect(result.canonical.status).toBe('complete');
    // Exactly one execution — the memoized promise is shared, no double-run.
    expect(handler).toHaveBeenCalledOnce();
  });

  it('MCP tools: launcher keyed by internal name, execute under the mangled provider name awaits the eager run (KTD-3)', async () => {
    // mcp::* tools are always-ask; allow via session override so no dialog is needed.
    const sessionId = `eager-mcp-${Date.now()}`;
    sessionPermissionOverrides.set(sessionId, 'allow');
    try {
      const eager = new EagerToolExecutor();
      const mcpHandler = vi.fn(async () => ({ status: 'complete' as const, data: { value: 'mcp-ok' } }));
      const internalName = 'mcp::srv::do_thing';
      const mcpDefinition = {
        name: internalName,
        description: 'mcp test tool',
        inputSchema: z.object({ x: z.number().optional() }),
        resultFamily: 'generic',
        outputDataSchema: genericToolResultDataSchema,
        category: 'search',
        riskClass: 'read',
      };
      const mcpManager = {
        getTools: () => [{ definition: mcpDefinition, handler: mcpHandler }],
      } as unknown as MCPManager;

      const registry = new ToolRegistry();
      registerTool(registry, 'slow', vi.fn(async () => ({ status: 'complete' as const, data: {} })));
      const tools = buildToolMap(
        [internalName],
        registry,
        mcpManager,
        { cwd, timeoutSeconds: 30, sessionId },
        undefined,
        eager,
      );

      // The MCP tool is exposed under a mangled provider name, not the internal name.
      const providerName = Object.keys(tools).find((k) => k !== 'slow')!;
      expect(providerName).toBeDefined();
      expect(providerName).not.toBe(internalName);

      // Eager start uses the INTERNAL name; the execute shim lives under the provider name.
      eager.start('call-mcp', internalName, { x: 1 });
      await vi.waitFor(() => expect(mcpHandler).toHaveBeenCalledOnce());

      const result = (await (tools[providerName].execute as unknown as ExecFn)(
        { x: 1 },
        { toolCallId: 'call-mcp' },
      )) as { canonical: { status: string } };
      expect(result.canonical.status).toBe('complete');
      // Exactly one execution — the shim awaited the eager run keyed by toolCallId.
      expect(mcpHandler).toHaveBeenCalledOnce();

      // Fallback: a fresh toolCallId runs the tool normally.
      const fallback = (await (tools[providerName].execute as unknown as ExecFn)(
        { x: 2 },
        { toolCallId: 'mcp-fresh' },
      )) as { canonical: { status: string } };
      expect(fallback.canonical.status).toBe('complete');
      expect(mcpHandler).toHaveBeenCalledTimes(2);
    } finally {
      sessionPermissionOverrides.delete(sessionId);
    }
  });

  it('skill tool: eager launcher is registered and the execute shim awaits the eager run', async () => {
    const eager = new EagerToolExecutor();
    const skill: Skill = {
      name: 'test-skill',
      description: 'a test skill',
      requires: [],
      resources: [],
      content: 'test-skill body',
    };
    // A dummy 'skill' registry entry so buildToolMap enters the skill-rebuild branch.
    const registry = new ToolRegistry();
    registerTool(registry, 'skill', vi.fn(async () => ({ status: 'complete' as const, data: {} })));
    const tools = buildToolMap(
      ['skill'],
      registry,
      null,
      { cwd, timeoutSeconds: 30 },
      { skills: new Map([['test-skill', skill]]) },
      eager,
    );
    expect(tools.skill).toBeDefined();

    // Eagerly start the real skill handler.
    eager.start('call-skill', 'skill', { name: 'test-skill' });
    const eagerPromise = eager.getOrStart('call-skill', 'skill', { name: 'test-skill' });
    expect(eagerPromise).toBeInstanceOf(Promise); // launcher registered for 'skill'

    // The shim must await the eager run: its result is the same resolved object as
    // the eager promise (a fresh fallback execution would produce a different one).
    const shimResult = await (tools.skill.execute as unknown as ExecFn)(
      { name: 'test-skill' },
      { toolCallId: 'call-skill' },
    );
    expect(shimResult).toBe(await eagerPromise);
  });
});
