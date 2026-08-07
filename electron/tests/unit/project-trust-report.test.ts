/**
 * Project trust report — surface diffing against the home baseline (U2).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ProjectTrustStore,
  TRUST_REPORT_MAX_CONFIG_BYTES,
  TRUST_REPORT_MAX_DEFINITIONS,
  TRUST_REPORT_MAX_VALUE_CHARS,
} from '../../src/main/project/trust';
import { projectTrustReportSchema } from '../../src/shared/types/ipc-schemas';

let tmpRoot: string;
let homeDir: string;
let project: string;
let store: ProjectTrustStore;

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

function writeOrchidJson(value: unknown): void {
  writeJson(path.join(project, '.orchid.json'), value);
}

function writeAgentDefinition(baseDir: string, name: string, description: string): void {
  const agentDir = path.join(baseDir, name);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, 'AGENT.md'),
    [
      '---',
      `name: ${name}`,
      'type: subagent',
      'tier: bloom',
      `description: ${description}`,
      '---',
      `${description} prompt`,
    ].join('\n'),
    'utf-8',
  );
}

function writeSkillDefinition(baseDir: string, name: string, description: string): void {
  const skillDir = path.join(baseDir, name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    [
      '---',
      `name: ${name}`,
      `description: ${description}`,
      '---',
      `${description} body`,
    ].join('\n'),
    'utf-8',
  );
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-project-trust-report-'));
  homeDir = path.join(tmpRoot, 'home');
  project = path.join(tmpRoot, 'project');
  fs.mkdirSync(project);

  writeJson(path.join(homeDir, 'config.json'), {
    mcp_servers: {
      homeServer: {
        command: '/usr/bin/home-server',
        env: { HOME_TOKEN: 'home-secret' },
      },
    },
  });
  writeAgentDefinition(path.join(homeDir, 'agents'), 'shared-agent', 'Home agent');

  store = new ProjectTrustStore({
    storePath: path.join(tmpRoot, 'trusted_projects.json'),
    homeConfigPath: path.join(homeDir, 'config.json'),
    homeAgentsDir: path.join(homeDir, 'agents'),
    homeSkillsDir: path.join(homeDir, 'skills'),
    homePersonalitiesDir: path.join(homeDir, 'personalities'),
  });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('ProjectTrustStore.buildReport', () => {
  it('classifies MCP servers as added vs overriding without leaking env values', () => {
    writeOrchidJson({
      mcp_servers: {
        homeServer: {
          command: '/usr/bin/replaced',
          args: ['-v'],
          env: { TOKEN: 'super-secret' },
        },
        projectServer: { url: 'https://mcp.example.org/sse' },
        broken: 'not-an-object',
      },
    });

    const report = store.buildReport(project);
    const byName = new Map(report.mcpServers.map((s) => [s.name, s]));

    const override = byName.get('homeServer');
    expect(override?.kind).toBe('override');
    expect(override?.command).toBe('/usr/bin/replaced');
    expect(override?.args).toEqual(['-v']);
    expect(override?.envKeys).toEqual(['TOKEN']);

    const added = byName.get('projectServer');
    expect(added?.kind).toBe('added');
    expect(added?.url).toBe('https://mcp.example.org/sse');
    expect(added?.command).toBeUndefined();
    expect(added?.envKeys).toBeUndefined();

    expect(byName.get('broken')?.kind).toBe('added');
    expect(byName.get('broken')?.command).toBeUndefined();

    expect(JSON.stringify(report)).not.toContain('super-secret');
    expect(JSON.stringify(report)).not.toContain('home-secret');
  });

  it('renders permission rules and flags auto-allow modes', () => {
    writeOrchidJson({
      permissions: {
        execute_command: 'allow',
        read: 'ask',
        edit: { inside: 'ask', outside: 'ask' },
        write: { inside: 'allow', outside: 'ask' },
        autopilot: 'decide-for-me',
        bogus: { sometimes: 'allow' },
      },
    });

    const report = store.buildReport(project);
    const byTool = new Map(report.permissions.map((p) => [p.tool, p]));

    expect(byTool.get('execute_command')).toEqual({
      tool: 'execute_command',
      rule: 'allow',
      autoAllow: true,
    });
    expect(byTool.get('read')).toEqual({
      tool: 'read',
      rule: 'ask',
      autoAllow: false,
    });
    expect(byTool.get('edit')).toEqual({
      tool: 'edit',
      rule: 'inside:ask outside:ask',
      autoAllow: false,
    });
    expect(byTool.get('write')).toEqual({
      tool: 'write',
      rule: 'inside:allow outside:ask',
      autoAllow: true,
    });
    expect(byTool.get('autopilot')?.autoAllow).toBe(true);
    expect(byTool.has('bogus')).toBe(false);
  });

  it('surfaces agents_md field overrides against the home defaults', () => {
    writeOrchidJson({
      agents_md: {
        enforce_on_write: 'off',
        filenames: ['AGENTS.md', 'CLAUDE.md'],
      },
    });

    const report = store.buildReport(project);
    const byKey = new Map(report.agentsMdOverrides.map((o) => [o.key, o]));

    expect(byKey.get('enforce_on_write')).toEqual({
      key: 'enforce_on_write',
      projectValue: '"off"',
      homeValue: '"warn"',
    });
    expect(byKey.has('filenames')).toBe(false);
  });

  it('marks project definitions shadowing home names as overrides', () => {
    writeAgentDefinition(
      path.join(project, '.orchid', 'agents'),
      'shared-agent',
      'Project agent',
    );
    writeAgentDefinition(
      path.join(project, '.orchid', 'agents'),
      'project-only',
      'New agent',
    );
    writeSkillDefinition(
      path.join(project, '.orchid', 'skills'),
      'brand-new-skill',
      'New skill',
    );

    const report = store.buildReport(project);
    const byKey = new Map(
      report.definitions.map((d) => [`${d.kind}:${d.name}`, d]),
    );

    expect(byKey.get('agent:shared-agent')?.overridesHome).toBe(true);
    expect(byKey.get('agent:project-only')?.overridesHome).toBe(false);
    expect(byKey.get('skill:brand-new-skill')?.overridesHome).toBe(false);
  });

  it('splits model overrides from other top-level config overrides', () => {
    const selection = {
      connectionId: '22222222-2222-4222-8222-222222222222',
      modelId: 'project/model',
    };
    writeOrchidJson({
      default_model: selection,
      tier_models: { seed: selection, sprout: null },
      command_timeout: 99,
      theme: 'bluey',
      completely_unknown_key: { nested: true },
    });

    const report = store.buildReport(project);

    expect(report.modelOverrides).toEqual([
      {
        key: 'default_model',
        connectionId: selection.connectionId,
        modelId: selection.modelId,
      },
      { key: 'seed', connectionId: selection.connectionId, modelId: selection.modelId },
    ]);

    const byKey = new Map(report.otherConfigOverrides.map((o) => [o.key, o]));
    expect(byKey.get('command_timeout')).toEqual({
      key: 'command_timeout',
      projectValue: '99',
      homeValue: '30',
    });
    expect(byKey.get('theme')).toEqual({
      key: 'theme',
      projectValue: '"bluey"',
      homeValue: '"default"',
    });
    expect(byKey.get('completely_unknown_key')?.homeValue).toBe('unset');
    expect(byKey.has('default_model')).toBe(false);
    expect(byKey.has('tier_models')).toBe(false);
  });

  it('lists root instruction files and reports surface presence', () => {
    fs.writeFileSync(path.join(project, 'AGENTS.md'), '# project rules', 'utf-8');

    const report = store.buildReport(project);
    expect(report.instructionFiles).toEqual(['AGENTS.md']);
    expect(report.hasSurface).toBe(true);
    expect(report.projectDir).toBe(fs.realpathSync(project));

    const bare = path.join(tmpRoot, 'bare');
    fs.mkdirSync(bare);
    const bareReport = store.buildReport(bare);
    expect(bareReport.hasSurface).toBe(false);
    expect(bareReport.instructionFiles).toEqual([]);
    expect(bareReport.mcpServers).toEqual([]);
    expect(bareReport.definitions).toEqual([]);
  });

  it('honors project-declared instruction-file aliases', () => {
    writeOrchidJson({ agents_md: { filenames: ['RULES.md'] } });
    fs.writeFileSync(path.join(project, 'RULES.md'), '# rules', 'utf-8');

    const report = store.buildReport(project);
    expect(report.instructionFiles).toEqual(['RULES.md']);
    expect(report.hasSurface).toBe(true);
  });

  it('produces a report for a malformed .orchid.json instead of throwing', () => {
    fs.writeFileSync(path.join(project, '.orchid.json'), '"just a string"', 'utf-8');
    const report = store.buildReport(project);
    expect(report.hasSurface).toBe(true);
    expect(report.mcpServers).toEqual([]);
    expect(report.permissions).toEqual([]);
    expect(report.otherConfigOverrides).toEqual([]);

    fs.writeFileSync(path.join(project, '.orchid.json'), '{{{{', 'utf-8');
    expect(() => store.buildReport(project)).not.toThrow();
  });

  it('skips blank keys everywhere so the report stays schema-valid', () => {
    fs.writeFileSync(
      path.join(project, '.orchid.json'),
      JSON.stringify({
        mcp_servers: { '': { command: '/usr/bin/empty' }, '  ': { command: 'x' } },
        permissions: { '': 'allow', '  ': 'allow' },
        agents_md: { '': 'x', '  ': 'y' },
        '': 1,
        '  ': 2,
      }),
      'utf-8',
    );
    // A personality file whose name degenerates to an empty stem.
    fs.mkdirSync(path.join(project, '.orchid', 'personalities'), { recursive: true });
    fs.writeFileSync(path.join(project, '.orchid', 'personalities', '.md'), 'x', 'utf-8');

    const report = store.buildReport(project);

    expect(report.mcpServers).toEqual([]);
    expect(report.permissions).toEqual([]);
    expect(report.agentsMdOverrides).toEqual([]);
    expect(report.otherConfigOverrides).toEqual([]);
    for (const definition of report.definitions) {
      expect(definition.name.trim()).not.toBe('');
    }
    expect(projectTrustReportSchema.safeParse(report).success).toBe(true);
  });

  it('caps an oversized .orchid.json with a note instead of throwing', () => {
    const huge = { padding: 'x'.repeat(TRUST_REPORT_MAX_CONFIG_BYTES) };
    fs.writeFileSync(
      path.join(project, '.orchid.json'),
      JSON.stringify(huge),
      'utf-8',
    );

    let report!: ReturnType<ProjectTrustStore['buildReport']>;
    expect(() => {
      report = store.buildReport(project);
    }).not.toThrow();
    expect(report.hasSurface).toBe(true);
    expect(report.mcpServers).toEqual([]);
    expect(report.permissions).toEqual([]);

    const byKey = new Map(report.otherConfigOverrides.map((o) => [o.key, o]));
    expect(byKey.get('trust-report-note')?.projectValue).toContain(
      String(TRUST_REPORT_MAX_CONFIG_BYTES),
    );
    expect(projectTrustReportSchema.safeParse(report).success).toBe(true);
  });

  it('caps serialized override values with an ellipsis', () => {
    writeOrchidJson({ theme: 'a'.repeat(TRUST_REPORT_MAX_VALUE_CHARS * 3) });

    const report = store.buildReport(project);
    const byKey = new Map(report.otherConfigOverrides.map((o) => [o.key, o]));
    const theme = byKey.get('theme');
    expect(theme?.projectValue.length).toBe(TRUST_REPORT_MAX_VALUE_CHARS + 1);
    expect(theme?.projectValue.endsWith('…')).toBe(true);
  });

  it('caps report definitions at TRUST_REPORT_MAX_DEFINITIONS', () => {
    const personalitiesDir = path.join(project, '.orchid', 'personalities');
    fs.mkdirSync(personalitiesDir, { recursive: true });
    for (let i = 0; i < TRUST_REPORT_MAX_DEFINITIONS + 1; i += 1) {
      fs.writeFileSync(
        path.join(personalitiesDir, `persona-${String(i).padStart(4, '0')}.md`),
        `persona ${i}`,
        'utf-8',
      );
    }

    const report = store.buildReport(project);
    expect(report.definitions).toHaveLength(TRUST_REPORT_MAX_DEFINITIONS);
    expect(report.definitions.every((d) => d.kind === 'personality')).toBe(true);
  });

  it('does not surface definitions planted under __trust_probe__', () => {
    const probeDir = path.join(project, '.orchid', '__trust_probe__');
    // Former home-probe injection vectors: direct agent subdir + personality
    // file under the probe path, plus a nested agents tree.
    writeAgentDefinition(path.join(probeDir, 'phantom-agent'), 'phantom', 'Phantom');
    fs.mkdirSync(path.join(probeDir, 'agents', 'nested'), { recursive: true });
    fs.writeFileSync(
      path.join(probeDir, 'agents', 'nested', 'AGENT.md'),
      '---\nname: nested-phantom\ntype: subagent\ntier: bloom\ndescription: Phantom\n---\nbody',
      'utf-8',
    );
    fs.mkdirSync(probeDir, { recursive: true });
    fs.writeFileSync(path.join(probeDir, 'phantom.md'), 'phantom personality', 'utf-8');

    writeAgentDefinition(
      path.join(project, '.orchid', 'agents'),
      'real-agent',
      'Real agent',
    );

    const report = store.buildReport(project);
    expect(report.definitions).toEqual([
      { kind: 'agent', name: 'real-agent', overridesHome: false },
    ]);
  });
});
