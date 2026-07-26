/**
 * Acceptance coverage for workspace instruction delivery across the stream,
 * dispatch, configuration, and persistence seams.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { mergeLayers } from '../../src/main/config/merge';
import { configSchema, defaults } from '../../src/main/config/schema';
import { makeToolResultMessage } from '../../src/main/llm/message-factories';
import { buildToolMap } from '../../src/main/llm/orchestrator';
import { executeToolCall } from '../../src/main/llm/tool-dispatch';
import { approvalStore } from '../../src/main/permissions/approval-store';
import { createProjectInstructionContext } from '../../src/main/project/instructions';
import { ToolRegistry } from '../../src/main/tools/registry';
import { filePathIntent } from '../../src/main/tools/types';
import { genericToolResultDataSchema } from '../../src/shared/types/tool-result';

const temporaryDirectories: string[] = [];

function workspace(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-hierarchical-integration-'));
  temporaryDirectories.push(directory);
  return fs.realpathSync.native(directory);
}

function write(root: string, relative: string, body: string): string {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

function createFixtureRegistry(): { registry: ToolRegistry; writeHandler: ReturnType<typeof vi.fn> } {
  const registry = new ToolRegistry();
  const writeHandler = vi.fn(async () => ({ status: 'complete' as const, data: { value: 'mutated' } }));
  const definition = {
    inputSchema: z.object({ file_path: z.string() }),
    resultFamily: 'generic' as const,
    outputDataSchema: genericToolResultDataSchema,
    category: 'filesystem',
  };
  registry.register({
    ...definition,
    name: 'acceptance_read',
    description: 'Read an acceptance fixture file',
    riskClass: 'read-only',
    inputPathIntents: (input) => [filePathIntent((input as { file_path: string }).file_path, 'read')],
  }, async () => ({ status: 'complete' as const, data: { value: 'read' } }));
  registry.register({
    ...definition,
    name: 'acceptance_write',
    description: 'Write an acceptance fixture file',
    riskClass: 'mutation',
    inputPathIntents: (input) => [filePathIntent((input as { file_path: string }).file_path, 'mutation')],
  }, writeHandler);
  registry.register({
    ...definition,
    name: 'acceptance_grep',
    description: 'Search an acceptance fixture workspace',
    riskClass: 'read-only',
    inputPathIntents: (input) => [filePathIntent(
      (input as { file_path: string }).file_path,
      'read',
      false,
    )],
  }, async () => ({ status: 'complete' as const, data: { value: 'searched' } }));
  return { registry, writeHandler };
}

afterEach(() => {
  vi.restoreAllMocks();
  approvalStore.cleanupAll();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('hierarchical project instructions acceptance', () => {
  it('delivers root-to-leaf selections, shadows aliases, expands shims, and interns sibling bodies by scope', async () => {
    const root = workspace();
    write(root, 'AGENTS.md', 'root primary');
    write(root, 'CLAUDE.md', 'root fallback must be shadowed');
    write(root, 'packages/CLAUDE.md', '@rules/GEMINI.md');
    const terminal = write(root, 'packages/rules/GEMINI.md', 'package shim rule');
    write(root, 'packages/src/AGENTS.override.md', 'source override');
    write(root, 'left/AGENTS.md', 'shared sibling rule');
    write(root, 'right/AGENTS.md', 'shared sibling rule');

    const hierarchy = createProjectInstructionContext(root, defaults());
    const discovery = await hierarchy.discover([path.join(root, 'packages', 'src', 'index.ts')]);

    expect(discovery.sources.map((source) => [source.scope, source.body])).toEqual([
      [root, 'root primary'],
      [path.join(root, 'packages'), 'package shim rule'],
      [path.join(root, 'packages', 'src'), 'source override'],
    ]);
    expect(discovery.diagnostics).toContainEqual(expect.objectContaining({
      code: 'shadowed', path: path.join(root, 'CLAUDE.md'),
    }));
    expect(discovery.sources[1]).toMatchObject({
      path: fs.realpathSync.native(terminal),
      scope: path.join(root, 'packages'),
    });

    const siblings = createProjectInstructionContext(root, defaults());
    const siblingDiscovery = await siblings.discover([
      path.join(root, 'left', 'one.ts'),
      path.join(root, 'right', 'two.ts'),
    ]);
    siblings.registerToolDelivery('sibling-read', siblingDiscovery);
    const delivery = siblings.claimProviderDelivery('sibling-read');
    const siblingSources = delivery.sources.filter((source) =>
      source.scope === path.join(root, 'left') || source.scope === path.join(root, 'right'),
    );
    expect(siblingSources.map((source) => source.kind).sort()).toEqual(['body-or-reference', 'reference']);
    expect((delivery.envelope.match(/shared sibling rule/g) ?? [])).toHaveLength(1);
  });

  it('keeps main and subagent contexts independent while freezing each turn snapshot', async () => {
    const root = workspace();
    write(root, 'AGENTS.md', 'root rule v1');
    const main = createProjectInstructionContext(root, defaults());
    const subagent = createProjectInstructionContext(root, defaults());

    const mainRoot = await main.prepareRoot();
    main.acknowledgeRoot();
    const subagentRoot = await subagent.prepareRoot();
    subagent.acknowledgeRoot();
    write(root, 'AGENTS.md', 'root rule v2');

    expect(mainRoot.envelope).toContain('root rule v1');
    expect(subagentRoot.envelope).toContain('root rule v1');
    expect(mainRoot).not.toBe(subagentRoot);
    expect((await main.discover([path.join(root, 'file.ts')])).envelope).not.toContain('root rule v2');
    expect((await createProjectInstructionContext(root, defaults()).prepareRoot()).envelope).toContain('root rule v2');
  });

  it('uses merged project limits and blocks escaped scopes before a mutation can run', async () => {
    const root = workspace();
    const outside = workspace();
    write(outside, 'outside.md', 'outside rule');
    fs.symlinkSync(path.join(outside, 'outside.md'), path.join(root, 'AGENTS.md'));

    const lowered = configSchema.parse(mergeLayers(
      defaults(),
      { project_instruction_max_bytes: 20_000, project_instruction_max_import_depth: 7 },
      { project_instruction_max_bytes: 10_000, project_instruction_max_import_depth: 2 },
    ));
    const raised = configSchema.parse(mergeLayers(
      defaults(),
      { project_instruction_max_bytes: 10_000, project_instruction_max_import_depth: 2 },
      { project_instruction_max_bytes: 20_000, project_instruction_max_import_depth: 7 },
    ));
    expect(lowered.project_instruction_max_bytes).toBe(10_000);
    expect(lowered.project_instruction_max_import_depth).toBe(2);
    expect(raised.project_instruction_max_bytes).toBe(20_000);
    expect(raised.project_instruction_max_import_depth).toBe(7);

    const context = createProjectInstructionContext(root, lowered);
    const { registry, writeHandler } = createFixtureRegistry();
    context.beginStep(1);
    const result = await executeToolCall(
      { id: 'escaped-write', name: 'acceptance_write', args: { file_path: 'new.ts' } },
      registry,
      { cwd: root, instructionContext: context },
    );

    expect(result.canonical.error?.code).toBe('project_instructions_blocked');
    expect(writeHandler).not.toHaveBeenCalled();
    expect(context.auditEvents())
      .toContainEqual(expect.objectContaining({ diagnosticCode: 'escaped-workspace' }));
  });

  it('defers a first scoped mutation, provides nested rules only to the model, then permits the next-step retry', async () => {
    const root = workspace();
    write(root, 'nested/AGENTS.md', 'nested mutation rule');
    const context = createProjectInstructionContext(root, defaults());
    context.beginStep(1);
    const { registry, writeHandler } = createFixtureRegistry();
    const approval = vi.spyOn(approvalStore, 'create').mockResolvedValue({ decision: 'approved' });

    const first = await executeToolCall(
      { id: 'first-write', name: 'acceptance_write', args: { file_path: 'nested/new.ts' } },
      registry,
      { cwd: root, instructionContext: context, sessionId: 'acceptance-mutation' },
    );
    expect(first.canonical.error?.code).toBe('project_instructions_pending');
    expect(first.agentProjection.content).not.toContain('nested mutation rule');
    const persisted = makeToolResultMessage(
      'first-write',
      'acceptance_write',
      first.agentProjection.content,
      first.canonical,
      'persisted-first-write',
    );
    expect(JSON.stringify(persisted)).not.toContain('nested mutation rule');
    expect(writeHandler).not.toHaveBeenCalled();
    expect(approval).not.toHaveBeenCalled();

    const tool = buildToolMap(['acceptance_write'], registry, null, {
      cwd: root,
      sessionId: 'acceptance-mutation',
      instructionContext: context,
    }).acceptance_write as unknown as {
      toModelOutput(options: { toolCallId: string; input: unknown; output: typeof first }): Promise<{ value: string }>;
    };
    const providerOutput = await tool.toModelOutput({
      toolCallId: 'first-write', input: { file_path: 'nested/new.ts' }, output: first,
    });
    expect(providerOutput.value).toContain('nested mutation rule');

    context.beginStep(2);
    const retry = await executeToolCall(
      { id: 'retry-write', name: 'acceptance_write', args: { file_path: 'nested/new.ts' } },
      registry,
      { cwd: root, instructionContext: context, sessionId: 'acceptance-mutation' },
    );
    expect(retry.canonical.status).toBe('complete');
    expect(writeHandler).toHaveBeenCalledOnce();
    expect(approval).toHaveBeenCalledOnce();
  });

  it('does not activate nested instructions for broad discovery tools', async () => {
    const root = workspace();
    write(root, 'deep/AGENTS.md', 'do not load for broad search');
    const context = createProjectInstructionContext(root, defaults());
    context.beginStep(1);
    const { registry } = createFixtureRegistry();

    const result = await executeToolCall(
      { id: 'broad-search', name: 'acceptance_grep', args: { file_path: 'deep' } },
      registry,
      { cwd: root, instructionContext: context },
    );
    expect(result.canonical.status).toBe('complete');
    expect(context.hasToolDelivery('broad-search')).toBe(false);
  });
});
