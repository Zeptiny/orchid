import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { defaults } from '../../src/main/config/schema';
import { buildToolMap } from '../../src/main/llm/orchestrator';
import { executeToolCall } from '../../src/main/llm/tool-dispatch';
import { approvalStore } from '../../src/main/permissions/approval-store';
import { createProjectInstructionContext } from '../../src/main/project/instructions';
import {
  readDefinition,
  readHandler,
} from '../../src/main/tools/filesystem/read';
import { ToolRegistry } from '../../src/main/tools/registry';
import { directoryPathIntent, filePathIntent } from '../../src/main/tools/types';
import { genericToolResultDataSchema } from '../../src/shared/types/tool-result';

const temporaryDirectories: string[] = [];

function workspace(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-instruction-dispatch-'));
  temporaryDirectories.push(directory);
  return fs.realpathSync.native(directory);
}

function registryFor(
  name: string,
  riskClass: 'read-only' | 'mutation',
  intent: (input: { file_path: string }) => ReturnType<typeof filePathIntent>[],
  handler = vi.fn(async () => ({ status: 'complete' as const, data: { value: 'handled' } })),
): { registry: ToolRegistry; handler: ReturnType<typeof vi.fn> } {
  const registry = new ToolRegistry();
  registry.register({
    name,
    description: name,
    inputSchema: z.object({ file_path: z.string() }),
    resultFamily: 'generic',
    outputDataSchema: genericToolResultDataSchema,
    category: 'filesystem',
    riskClass,
    inputPathIntents: intent,
  }, handler);
  return { registry, handler };
}

afterEach(() => {
  vi.restoreAllMocks();
  approvalStore.cleanupAll();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('hierarchical instruction dispatch', () => {
  it('discovers instructions before a read, retains raw output, and appends only provider delivery', async () => {
    const root = workspace();
    fs.mkdirSync(path.join(root, 'nested'));
    fs.writeFileSync(path.join(root, 'nested', 'AGENTS.md'), 'nested read rule');
    fs.writeFileSync(path.join(root, 'nested', 'file.ts'), 'source');
    const context = createProjectInstructionContext(root, defaults());
    context.beginStep(1);
    const { registry, handler } = registryFor(
      'read_fixture',
      'read-only',
      (input) => [filePathIntent(input.file_path, 'read')],
    );
    const audit = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const result = await executeToolCall(
      { id: 'read-call', name: 'read_fixture', args: { file_path: 'nested/file.ts' } },
      registry,
      { cwd: root, instructionContext: context },
    );

    expect(handler).toHaveBeenCalledOnce();
    expect(result.agentProjection.content).not.toContain('nested read rule');
    const tool = buildToolMap(['read_fixture'], registry, null, {
      cwd: root,
      instructionContext: context,
    }).read_fixture as unknown as {
      toModelOutput: (options: {
        toolCallId: string;
        input: unknown;
        output: typeof result;
      }) => Promise<{ type: string; value: string }>;
    };
    const providerOutput = await tool.toModelOutput({
      toolCallId: 'read-call',
      input: { file_path: 'nested/file.ts' },
      output: result,
    });
    expect(providerOutput.value).toContain('nested read rule');
    expect(await tool.toModelOutput({
      toolCallId: 'read-call',
      input: { file_path: 'nested/file.ts' },
      output: result,
    })).toEqual(providerOutput);
    expect(audit).toHaveBeenCalledWith(
      '[project-instructions] automatic workspace instruction read',
      expect.objectContaining({ toolCallId: 'read-call', selection: 'AGENTS.md' }),
    );
    expect(JSON.stringify(audit.mock.calls)).not.toContain('nested read rule');
    expect(JSON.stringify(audit.mock.calls)).not.toContain('<project_instructions>');
  });

  it('defers first-touch mutations atomically without approval or handler execution, then permits retry', async () => {
    const root = workspace();
    fs.mkdirSync(path.join(root, 'nested'));
    fs.writeFileSync(path.join(root, 'nested', 'AGENTS.md'), 'nested mutation rule');
    const context = createProjectInstructionContext(root, defaults());
    context.beginStep(1);
    const { registry, handler } = registryFor(
      'write_fixture',
      'mutation',
      (input) => [filePathIntent(input.file_path, 'mutation')],
    );
    const approval = vi.spyOn(approvalStore, 'create').mockResolvedValue({ decision: 'approved' });

    const first = await executeToolCall(
      { id: 'first-write', name: 'write_fixture', args: { file_path: 'nested/new.ts' } },
      registry,
      { cwd: root, instructionContext: context },
    );

    expect(first.canonical.error?.code).toBe('project_instructions_pending');
    expect(handler).not.toHaveBeenCalled();
    expect(approval).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(root, 'nested', 'new.ts'))).toBe(false);
    const tool = buildToolMap(['write_fixture'], registry, null, {
      cwd: root,
      instructionContext: context,
    }).write_fixture as unknown as {
      toModelOutput: (options: {
        toolCallId: string;
        input: unknown;
        output: typeof first;
      }) => Promise<{ type: string; value: string }>;
    };
    expect((await tool.toModelOutput({
      toolCallId: 'first-write',
      input: { file_path: 'nested/new.ts' },
      output: first,
    })).value).toContain('nested mutation rule');

    const sameStep = await executeToolCall(
      { id: 'same-step-write', name: 'write_fixture', args: { file_path: 'nested/new.ts' } },
      registry,
      { cwd: root, instructionContext: context, sessionId: 'mutation-policy' },
    );
    expect(sameStep.canonical.error?.code).toBe('project_instructions_pending');
    expect(approval).not.toHaveBeenCalled();

    context.beginStep(2);
    const retry = await executeToolCall(
      { id: 'retry-write', name: 'write_fixture', args: { file_path: 'nested/new.ts' } },
      registry,
      { cwd: root, instructionContext: context, sessionId: 'mutation-policy' },
    );

    expect(retry.canonical.status).toBe('complete');
    expect(approval).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledOnce();
  });

  it('defers same-step parallel mutations and leaves broad discovery tools inactive', async () => {
    const root = workspace();
    fs.mkdirSync(path.join(root, 'nested'));
    fs.writeFileSync(path.join(root, 'nested', 'AGENTS.md'), 'parallel rule');
    const context = createProjectInstructionContext(root, defaults());
    context.beginStep(1);
    const { registry, handler } = registryFor(
      'edit_fixture',
      'read-only',
      (input) => [filePathIntent(input.file_path, 'mutation')],
    );

    const [left, right] = await Promise.all([
      executeToolCall({ id: 'left', name: 'edit_fixture', args: { file_path: 'nested/a.ts' } }, registry, {
        cwd: root, instructionContext: context,
      }),
      executeToolCall({ id: 'right', name: 'edit_fixture', args: { file_path: 'nested/b.ts' } }, registry, {
        cwd: root, instructionContext: context,
      }),
    ]);

    expect(left.canonical.error?.code).toBe('project_instructions_pending');
    expect(right.canonical.error?.code).toBe('project_instructions_pending');
    expect(handler).not.toHaveBeenCalled();

    const broad = new ToolRegistry();
    const broadHandler = vi.fn(async () => ({ status: 'complete' as const, data: { value: 'searched' } }));
    broad.register({
      name: 'grep_fixture',
      description: 'grep',
      inputSchema: z.object({ directory_path: z.string() }),
      resultFamily: 'generic',
      outputDataSchema: genericToolResultDataSchema,
      category: 'search',
      riskClass: 'read-only',
      inputPathIntents: (input) => [directoryPathIntent(
        (input as { directory_path: string }).directory_path,
        'read',
        false,
      )],
    }, broadHandler);
    await executeToolCall(
      { id: 'broad', name: 'grep_fixture', args: { directory_path: 'nested' } },
      broad,
      { cwd: root, instructionContext: context },
    );

    expect(broadHandler).toHaveBeenCalledOnce();
    expect(context.hasToolDelivery('broad')).toBe(false);
  });

  it('merges read-only result path instructions into one provider-only delivery', async () => {
    const root = workspace();
    const outside = workspace();
    fs.mkdirSync(path.join(root, 'input'));
    fs.mkdirSync(path.join(root, 'left'));
    fs.mkdirSync(path.join(root, 'right'));
    fs.writeFileSync(path.join(root, 'input', 'AGENTS.md'), 'input rule');
    fs.writeFileSync(path.join(root, 'left', 'AGENTS.md'), 'left result rule');
    fs.writeFileSync(path.join(root, 'right', 'AGENTS.md'), 'right result rule');
    fs.writeFileSync(path.join(outside, 'AGENTS.md'), 'outside result rule');
    const context = createProjectInstructionContext(root, defaults());
    context.beginStep(1);
    const registry = new ToolRegistry();
    registry.register({
      name: 'plan_fixture',
      description: 'Plan a read-only operation',
      inputSchema: z.object({ file_path: z.string() }),
      resultFamily: 'generic',
      outputDataSchema: genericToolResultDataSchema,
      category: 'ast',
      riskClass: 'read-only',
      inputPathIntents: (input) => [filePathIntent(
        (input as { file_path: string }).file_path,
        'read',
      )],
      resultPathIntents: (result) => {
        const canonical = result as { data: { value: { affected: string[] } } };
        return canonical.data.value.affected.map((filePath) => filePathIntent(filePath, 'read'));
      },
    }, async () => ({
      status: 'complete',
      data: {
        value: {
          affected: ['left/a.ts', 'right/b.ts', path.join(outside, 'ignored.ts')],
        },
      },
    }));

    const execution = await executeToolCall(
      { id: 'plan', name: 'plan_fixture', args: { file_path: 'input/origin.ts' } },
      registry,
      { cwd: root, instructionContext: context },
    );
    expect(execution.agentProjection.content).not.toContain('input rule');
    expect(execution.agentProjection.content).not.toContain('left result rule');
    expect(JSON.stringify(execution.canonical)).not.toContain('left result rule');

    const tool = buildToolMap(['plan_fixture'], registry, null, {
      cwd: root,
      instructionContext: context,
    }).plan_fixture as unknown as {
      toModelOutput: (options: {
        toolCallId: string;
        input: unknown;
        output: typeof execution;
      }) => Promise<{ type: string; value: string }>;
    };
    const providerOutput = await tool.toModelOutput({
      toolCallId: 'plan',
      input: { file_path: 'input/origin.ts' },
      output: execution,
    });
    expect(providerOutput.value).toContain('input rule');
    expect(providerOutput.value).toContain('left result rule');
    expect(providerOutput.value).toContain('right result rule');
    expect(providerOutput.value).not.toContain('outside result rule');
  });

  it('rejects a symlink target that changes while mutation permission is pending', async () => {
    const root = workspace();
    const inside = path.join(root, 'inside');
    const outside = workspace();
    fs.mkdirSync(inside);
    fs.writeFileSync(path.join(root, 'AGENTS.md'), 'root rule');
    fs.symlinkSync(inside, path.join(root, 'target'));
    const context = createProjectInstructionContext(root, defaults());
    await context.prepareRoot();
    context.acknowledgeRoot();
    context.beginStep(1);
    const { registry, handler } = registryFor(
      'mutate_fixture',
      'mutation',
      (input) => [filePathIntent(input.file_path, 'mutation')],
    );
    vi.spyOn(approvalStore, 'create').mockImplementation(async () => {
      fs.unlinkSync(path.join(root, 'target'));
      fs.symlinkSync(outside, path.join(root, 'target'));
      return { decision: 'approved' };
    });

    const result = await executeToolCall(
      { id: 'stale', name: 'mutate_fixture', args: { file_path: 'target/new.ts' } },
      registry,
      { cwd: root, instructionContext: context, sessionId: 'stale-scope' },
    );

    expect(result.canonical.error?.code).toBe('stale_instruction_scope');
    expect(handler).not.toHaveBeenCalled();
  });

  it('reads the preflighted target when an activating symlink changes during discovery', async () => {
    const root = workspace();
    const outside = workspace();
    const inside = path.join(root, 'inside');
    fs.mkdirSync(inside);
    fs.writeFileSync(path.join(inside, 'AGENTS.md'), 'inside instructions');
    fs.writeFileSync(path.join(inside, 'file.ts'), 'inside source');
    fs.writeFileSync(path.join(outside, 'file.ts'), 'outside source');
    const link = path.join(root, 'target');
    fs.symlinkSync(inside, link);
    const context = createProjectInstructionContext(root, defaults());
    context.beginStep(1);
    const discover = context.discover.bind(context);
    vi.spyOn(context, 'discover').mockImplementation(async (targets) => {
      const discovery = await discover(targets);
      fs.unlinkSync(link);
      fs.symlinkSync(outside, link);
      return discovery;
    });
    const registry = new ToolRegistry();
    registry.register(readDefinition, readHandler);

    const result = await executeToolCall(
      { id: 'stable-read', name: 'read', args: { file_path: 'target/file.ts' } },
      registry,
      { cwd: root, instructionContext: context },
    );

    expect(result.canonical.status).toBe('complete');
    expect(JSON.stringify(result.canonical)).toContain('inside source');
    expect(JSON.stringify(result.canonical)).not.toContain('outside source');
  });
});
