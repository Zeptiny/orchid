import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaults } from '../../src/main/config/schema';
import { createProjectInstructionContext } from '../../src/main/project/instructions';

const temporaryDirectories: string[] = [];

function workspace(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-instructions-'));
  temporaryDirectories.push(directory);
  return fs.realpathSync.native(directory);
}

function write(directory: string, name: string, body: string): string {
  const file = path.join(directory, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('ProjectInstructionContext', () => {
  it('selects instructions broad-to-specific with stable alias precedence', async () => {
    const root = workspace();
    write(root, 'CLAUDE.md', 'root fallback');
    write(root, 'AGENTS.md', 'root primary');
    write(root, 'nested/CLAUDE.md', 'nested fallback');
    write(root, 'nested/AGENTS.override.md', 'nested override');
    const context = createProjectInstructionContext(root, defaults());

    const discovery = await context.discover([path.join(root, 'nested', 'code.ts')]);

    expect(discovery.sources.map((source) => [path.basename(source.path), source.body])).toEqual([
      ['AGENTS.md', 'root primary'],
      ['AGENTS.override.md', 'nested override'],
    ]);
    expect(discovery.diagnostics.map((diagnostic) => diagnostic.code)).toContain('shadowed');
  });

  it('expands an allowlisted shim in the selecting directory scope', async () => {
    const root = workspace();
    write(root, 'nested/AGENTS.md', '@rules/CLAUDE.md\n');
    const imported = write(root, 'nested/rules/CLAUDE.md', 'imported rules');
    const context = createProjectInstructionContext(root, defaults());

    const discovery = await context.discover([path.join(root, 'nested', 'file.ts')]);

    expect(discovery.sources).toHaveLength(1);
    expect(discovery.sources[0]).toMatchObject({
      path: fs.realpathSync.native(imported),
      scope: path.join(root, 'nested'),
      body: 'imported rules',
    });
    expect(context.auditEvents()).toContainEqual(expect.objectContaining({
      type: 'selected',
      path: fs.realpathSync.native(path.join(root, 'nested', 'AGENTS.md')),
      terminalPath: fs.realpathSync.native(imported),
    }));
  });

  it('blocks mutation scope for invalid shim imports but permits read discovery', async () => {
    const root = workspace();
    write(root, 'AGENTS.md', '@not-allowed.md');
    const context = createProjectInstructionContext(root, defaults());
    const target = path.join(root, 'file.ts');

    const discovery = await context.discover([target]);
    expect(discovery.diagnostics.map((diagnostic) => diagnostic.code)).toContain('invalid-import');
    expect((await context.preflightMutation([target])).status).toBe('blocked');
  });

  it('deduplicates an identical child body subsumed by its parent', async () => {
    const root = workspace();
    write(root, 'AGENTS.md', 'same\r\nrules');
    write(root, 'nested/AGENTS.md', '\uFEFFsame\nrules');
    const context = createProjectInstructionContext(root, defaults());

    const discovery = await context.discover([path.join(root, 'nested', 'file.ts')]);
    expect(discovery.sources).toHaveLength(1);
    expect(discovery.sources[0].scope).toBe(root);
  });

  it('keeps an identical sibling as a scoped reference and claims its body only once', async () => {
    const root = workspace();
    write(root, 'left/AGENTS.md', 'shared');
    write(root, 'right/AGENTS.md', 'shared');
    const context = createProjectInstructionContext(root, defaults());
    const discovery = await context.discover([
      path.join(root, 'left', 'file.ts'),
      path.join(root, 'right', 'file.ts'),
    ]);
    context.registerToolDelivery('siblings', discovery);
    const delivery = context.claimProviderDelivery('siblings');

    expect(discovery.sources.map((source) => source.kind)).toEqual(['body-or-reference', 'body-or-reference']);
    expect((delivery.envelope.match(/<project_instruction /g) ?? [])).toHaveLength(1);
    expect((delivery.envelope.match(/<project_instruction_ref/g) ?? [])).toHaveLength(1);
  });

  it('rejects cycles and escaped selected symlinks without reading their bodies', async () => {
    const root = workspace();
    write(root, 'AGENTS.md', '@CLAUDE.md');
    write(root, 'CLAUDE.md', '@AGENTS.md');
    const cyclic = createProjectInstructionContext(root, defaults());
    expect((await cyclic.discover([path.join(root, 'file.ts')])).diagnostics.map((item) => item.code))
      .toContain('import-cycle');

    const outside = workspace();
    write(outside, 'outside.md', 'do not load');
    const linkedRoot = workspace();
    fs.symlinkSync(path.join(outside, 'outside.md'), path.join(linkedRoot, 'AGENTS.md'));
    const linked = createProjectInstructionContext(linkedRoot, defaults());
    const linkedDiscovery = await linked.discover([path.join(linkedRoot, 'file.ts')]);
    expect(linkedDiscovery.sources).toHaveLength(0);
    expect(linkedDiscovery.diagnostics.map((item) => item.code)).toContain('escaped-workspace');
  });

  it('honors the configured shim depth boundary', async () => {
    const root = workspace();
    write(root, 'AGENTS.md', '@CLAUDE.md');
    write(root, 'CLAUDE.md', '@GEMINI.md');
    write(root, 'GEMINI.md', 'terminal');
    const context = createProjectInstructionContext(root, {
      ...defaults(), project_instruction_max_import_depth: 1,
    });

    expect((await context.discover([path.join(root, 'file.ts')])).diagnostics.map((item) => item.code))
      .toContain('import-depth-exceeded');
  });

  it('reports a missing shim target and dangling selected source as blocking diagnostics', async () => {
    const root = workspace();
    write(root, 'AGENTS.md', '@CLAUDE.md');
    const missing = createProjectInstructionContext(root, defaults());
    expect((await missing.discover([path.join(root, 'file.ts')])).diagnostics.map((item) => item.code))
      .toContain('missing-shim-target');

    const danglingRoot = workspace();
    fs.symlinkSync(path.join(danglingRoot, 'missing.md'), path.join(danglingRoot, 'AGENTS.md'));
    const dangling = createProjectInstructionContext(danglingRoot, defaults());
    const discovery = await dangling.discover([path.join(danglingRoot, 'file.ts')]);
    expect(discovery.diagnostics.map((item) => item.code)).toContain('unreadable');
    expect((await dangling.preflightMutation([path.join(danglingRoot, 'file.ts')])).status).toBe('blocked');
  });

  it('defers a new mutation for one step and promotes an emitted delivery idempotently', async () => {
    const root = workspace();
    write(root, 'nested/AGENTS.md', 'nested rules');
    const context = createProjectInstructionContext(root, defaults());
    context.beginStep(1);
    const target = path.join(root, 'nested', 'file.ts');

    const preflight = await context.preflightMutation([target]);
    expect(preflight.status).toBe('pending');
    context.registerToolDelivery('call-1', preflight.discovery);
    expect(context.claimProviderDelivery('call-1').envelope).toContain('nested rules');
    expect(context.claimProviderDelivery('call-1').envelope).toContain('nested rules');
    context.beginStep(1);
    expect((await context.preflightMutation([target])).status).toBe('pending');
    context.beginStep(2);
    expect((await context.preflightMutation([target])).status).toBe('ready');
  });

  it('allows a retry to deliver a canceled or unprojected discovery', async () => {
    const root = workspace();
    write(root, 'nested/AGENTS.md', 'retry rules');
    const context = createProjectInstructionContext(root, defaults());
    context.beginStep(1);
    const target = path.join(root, 'nested', 'file.ts');
    const cancelled = await context.preflightMutation([target]);
    context.registerToolDelivery('cancelled', cancelled.discovery);
    const retry = await context.preflightMutation([target]);

    expect(retry.status).toBe('pending');
    expect(retry.discovery.sources.map((source) => source.body)).toContain('retry rules');
    context.registerToolDelivery('retry', retry.discovery);
    expect(context.claimProviderDelivery('retry').envelope).toContain('retry rules');
    context.beginStep(2);
    expect((await context.preflightMutation([target])).status).toBe('ready');
  });

  it('does not reset body emission when the same scope is rediscovered in one step', async () => {
    const root = workspace();
    write(root, 'nested/AGENTS.md', 'once only');
    const context = createProjectInstructionContext(root, defaults());
    context.beginStep(1);
    const target = path.join(root, 'nested', 'file.ts');
    const first = await context.preflightMutation([target]);
    context.registerToolDelivery('first', first.discovery);
    expect(context.claimProviderDelivery('first').envelope).toContain('<project_instruction ');

    const repeated = await context.preflightMutation([target]);
    context.registerToolDelivery('repeated', repeated.discovery);
    const retryOutput = context.claimProviderDelivery('repeated').envelope;
    expect(retryOutput).toContain('<project_instruction_ref');
    expect(retryOutput).not.toContain('<project_instruction path');
    context.beginStep(1);
    expect((await context.preflightMutation([target])).status).toBe('pending');
  });

  it('memoizes concurrent root preparation as one complete root discovery', async () => {
    const root = workspace();
    write(root, 'AGENTS.md', 'root rules');
    const context = createProjectInstructionContext(root, defaults());
    const [first, second] = await Promise.all([context.prepareRoot(), context.prepareRoot()]);

    expect(first).toBe(second);
    expect(first.sources.map((source) => source.body)).toEqual(['root rules']);
    context.acknowledgeRoot();
    expect(context.isRootAcknowledged).toBe(true);
  });

  it('freezes scanned directories and shares their scan under concurrent discovery', async () => {
    const root = workspace();
    write(root, 'AGENTS.md', 'original');
    const context = createProjectInstructionContext(root, defaults());
    const target = path.join(root, 'file.ts');
    const [first, second] = await Promise.all([context.discover([target]), context.discover([target])]);
    write(root, 'AGENTS.md', 'changed');
    const later = await context.discover([target]);

    expect([...first.sources, ...second.sources].map((source) => source.body)).toContain('original');
    expect(later.sources.map((source) => source.body)).not.toContain('changed');
    expect(context.scannedDirectories()).toEqual([root]);
  });

  it('fails an entire discovery when the configured rendered budget is exceeded', async () => {
    const root = workspace();
    write(root, 'AGENTS.md', 'x'.repeat(8_000));
    const context = createProjectInstructionContext(root, {
      ...defaults(),
      project_instruction_max_bytes: 4_096,
    });

    const discovery = await context.discover([path.join(root, 'file.ts')]);
    expect(discovery.sources).toHaveLength(0);
    expect(discovery.diagnostics.map((diagnostic) => diagnostic.code)).toContain('over-budget');
    expect((await context.preflightMutation([path.join(root, 'file.ts')])).status).toBe('blocked');
  });

  it('atomically blocks a multi-target mutation when any branch is blocked', async () => {
    const root = workspace();
    write(root, 'safe/AGENTS.md', 'safe rules');
    write(root, 'blocked/AGENTS.md', '@missing/CLAUDE.md');
    const context = createProjectInstructionContext(root, defaults());
    const preflight = await context.preflightMutation([
      path.join(root, 'safe', 'one.ts'),
      path.join(root, 'blocked', 'two.ts'),
    ]);

    expect(preflight.status).toBe('blocked');
    expect(preflight.discovery.sources.map((source) => source.scope)).toContain(path.join(root, 'safe'));
    expect(preflight.discovery.diagnostics.map((item) => item.code)).toContain('missing-shim-target');
  });

  it('accounts for bodies, scoped references, and diagnostics in the accumulated envelope budget', async () => {
    const root = workspace();
    write(root, 'left/AGENTS.md', 'a'.repeat(1_300));
    write(root, 'left/CLAUDE.md', 'shadowed');
    write(root, 'right/AGENTS.md', 'b'.repeat(1_300));
    write(root, 'third/AGENTS.md', 'c'.repeat(1_200));
    const context = createProjectInstructionContext(root, {
      ...defaults(), project_instruction_max_bytes: 4_096,
    });
    const initial = await context.discover([
      path.join(root, 'left', 'one.ts'),
      path.join(root, 'right', 'two.ts'),
    ]);
    const final = await context.discover([path.join(root, 'third', 'three.ts')]);

    expect(Buffer.byteLength(initial.envelope, 'utf8')).toBeLessThanOrEqual(4_096);
    expect(initial.diagnostics.map((item) => item.code)).toContain('shadowed');
    expect(final.sources).toHaveLength(0);
    expect(final.diagnostics.map((item) => item.code)).toContain('over-budget');
  });

  it('does not charge a canceled retry twice against the tight instruction budget', async () => {
    const root = workspace();
    write(root, 'nested/AGENTS.md', 'r'.repeat(3_200));
    const context = createProjectInstructionContext(root, {
      ...defaults(), project_instruction_max_bytes: 4_096,
    });
    const target = path.join(root, 'nested', 'file.ts');
    const first = await context.discover([target]);
    const retry = await context.discover([target]);

    expect(first.sources).toHaveLength(1);
    expect(retry.sources).toHaveLength(1);
    expect(retry.diagnostics.map((item) => item.code)).not.toContain('over-budget');
  });

  it('charges identical sibling content as one body plus one reference', async () => {
    const root = workspace();
    write(root, 'left/AGENTS.md', 's'.repeat(1_700));
    write(root, 'right/AGENTS.md', 's'.repeat(1_700));
    const context = createProjectInstructionContext(root, {
      ...defaults(), project_instruction_max_bytes: 4_096,
    });
    const discovery = await context.discover([
      path.join(root, 'left', 'one.ts'),
      path.join(root, 'right', 'two.ts'),
    ]);

    expect(discovery.sources).toHaveLength(2);
    expect(discovery.diagnostics.map((item) => item.code)).not.toContain('over-budget');
    context.registerToolDelivery('siblings-tight', discovery);
    const output = context.claimProviderDelivery('siblings-tight').envelope;
    expect((output.match(/<project_instruction /g) ?? [])).toHaveLength(1);
    expect((output.match(/<project_instruction_ref/g) ?? [])).toHaveLength(1);
  });
});
