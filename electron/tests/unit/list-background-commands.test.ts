import { describe, expect, it } from 'vitest';
import { BackgroundProcessStore, setBackgroundStore } from '../../src/main/tools/process/background-store';
import { executeListBackgroundCommands } from '../../src/main/tools/process/list-background-commands';
import { finalizeToolExecutionResult } from '../../src/main/tools/result';
import { createCanonicalToolResult, type GenericToolResultData, type ToolHandlerOutcome } from '../../src/shared/types/tool-result';
import { listBackgroundCommandsToolDefinition } from '../../src/main/tools/process/list-background-commands';

describe('list_background_commands', () => {
  it('lists only the calling scope (scope-gated)', async () => {
    const store = new BackgroundProcessStore();
    setBackgroundStore(store);
    const sid = '33333333-3333-4333-8333-333333333333';
    await store.spawn('sleep 30', { sessionId: sid, agentScopeId: 'main' });
    await store.spawn('sleep 30', { sessionId: sid, agentScopeId: 'sub-1' });
    await store.spawn('sleep 30', { sessionId: 'other-session', agentScopeId: 'main' });

    const outcome = await executeListBackgroundCommands(sid, 'main');
    const exec = finalizeToolExecutionResult({
      canonical: createCanonicalToolResult('generic', outcome as ToolHandlerOutcome<GenericToolResultData>),
      toolName: listBackgroundCommandsToolDefinition.name,
      outputDataSchema: listBackgroundCommandsToolDefinition.outputDataSchema,
      expectedFamily: listBackgroundCommandsToolDefinition.resultFamily,
    });
    const data = (exec.canonical.data as unknown as GenericToolResultData).value as unknown as { commands: Array<{ id: number }> };
    expect(data.commands).toHaveLength(1);
    expect(data.commands[0]?.id).toBe(1);
    store.clear();
  });

  it('returns required fields per entry', async () => {
    const store = new BackgroundProcessStore();
    setBackgroundStore(store);
    const sid = '44444444-4444-4444-8444-444444444444';
    await store.spawn('echo hi; sleep 30', { sessionId: sid, agentScopeId: 'main', description: 'hi' });

    const outcome = await executeListBackgroundCommands(sid, 'main');
    const exec = finalizeToolExecutionResult({
      canonical: createCanonicalToolResult('generic', outcome as ToolHandlerOutcome<GenericToolResultData>),
      toolName: listBackgroundCommandsToolDefinition.name,
      outputDataSchema: listBackgroundCommandsToolDefinition.outputDataSchema,
      expectedFamily: listBackgroundCommandsToolDefinition.resultFamily,
    });
    const data = (exec.canonical.data as unknown as GenericToolResultData).value as unknown as { commands: Array<Record<string, unknown>> };
    expect(data.commands[0]).toMatchObject({
      id: expect.any(Number),
      command: 'echo hi; sleep 30',
      description: 'hi',
      interactive: false,
      owner: 'AGENT',
      running: true,
      exitCode: null,
      createdAt: expect.any(Number),
    });
    store.clear();
  });
});
