/**
 * Schema contracts for the trusted-projects boundary (U1).
 *
 * Validates the zod mirrors of the trust types: workspace events carry the
 * optional `trust` field across all three states, chat send results accept
 * `untrusted_project`, and the trust report schema rejects malformed sections.
 */
import { describe, expect, it } from 'vitest';
import {
  chatSendResultSchema,
  projectTrustInfoSchema,
  projectTrustReportSchema,
  sessionWorkspaceChangedEventSchema,
  workspaceInfoSchema,
} from '../../src/shared/types/ipc-schemas';

function validReport() {
  return {
    projectDir: '/tmp/proj',
    hasSurface: true,
    mcpServers: [
      { name: 'fs', kind: 'added', command: 'npx', args: ['-y', 'server'], envKeys: ['TOKEN'] },
      { name: 'shared', kind: 'override', url: 'https://example.invalid/mcp' },
    ],
    permissions: [{ tool: 'execute_command', rule: 'allow', autoAllow: true }],
    agentsMdOverrides: [
      { key: 'enforce_on_write', projectValue: 'off', homeValue: 'warn' },
    ],
    modelOverrides: [
      { key: 'default_model', connectionId: 'conn-1', modelId: 'model-1' },
    ],
    otherConfigOverrides: [],
    definitions: [
      { kind: 'agent', name: 'reviewer', overridesHome: true },
      { kind: 'skill', name: 'deploy', overridesHome: false },
    ],
    instructionFiles: ['AGENTS.md'],
  };
}

describe('sessionWorkspaceChangedEventSchema trust field', () => {
  it.each(['trusted', 'untrusted', 'changed'] as const)(
    'parses workspace event with trust=%s',
    (trust) => {
      const parsed = sessionWorkspaceChangedEventSchema.safeParse({
        workspace: { cwd: '/tmp/proj', source: 'draft', status: 'valid', trust },
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.workspace.trust).toBe(trust);
    },
  );

  it('accepts a workspace event without trust (legacy producer)', () => {
    const parsed = sessionWorkspaceChangedEventSchema.safeParse({
      workspace: { cwd: '/tmp/proj', source: 'session', status: 'valid' },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.workspace.trust).toBeUndefined();
  });

  it('rejects an unknown trust value', () => {
    const parsed = sessionWorkspaceChangedEventSchema.safeParse({
      workspace: { cwd: '/tmp/proj', source: 'draft', status: 'valid', trust: 'maybe' },
    });
    expect(parsed.success).toBe(false);
  });
});

describe('workspaceInfoSchema', () => {
  it('round-trips trust state', () => {
    const parsed = workspaceInfoSchema.safeParse({
      cwd: '/tmp/proj',
      source: 'default',
      status: 'valid',
      trust: 'changed',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.trust).toBe('changed');
  });
});

describe('chatSendResultSchema', () => {
  it('accepts untrusted_project error kind', () => {
    const parsed = chatSendResultSchema.safeParse({
      status: 'error',
      kind: 'untrusted_project',
      error: 'Project is not trusted.',
    });
    expect(parsed.success).toBe(true);
  });
});

describe('projectTrustReportSchema', () => {
  it('accepts a fully-populated report', () => {
    const parsed = projectTrustReportSchema.safeParse(validReport());
    expect(parsed.success).toBe(true);
  });

  it('rejects an MCP entry with an invalid kind', () => {
    const report = validReport();
    report.mcpServers[0] = { name: 'fs', kind: 'bogus' } as never;
    const parsed = projectTrustReportSchema.safeParse(report);
    expect(parsed.success).toBe(false);
  });

  it('rejects a definition with an invalid kind', () => {
    const report = validReport();
    report.definitions[0] = { kind: 'macro', name: 'x', overridesHome: false } as never;
    const parsed = projectTrustReportSchema.safeParse(report);
    expect(parsed.success).toBe(false);
  });

  it('rejects a missing required array section', () => {
    const report = validReport() as Record<string, unknown>;
    delete report.permissions;
    const parsed = projectTrustReportSchema.safeParse(report);
    expect(parsed.success).toBe(false);
  });
});

describe('projectTrustInfoSchema', () => {
  it('accepts trusted state with null report', () => {
    const parsed = projectTrustInfoSchema.safeParse({
      projectDir: '/tmp/proj',
      state: 'trusted',
      report: null,
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts untrusted state with a report', () => {
    const parsed = projectTrustInfoSchema.safeParse({
      projectDir: '/tmp/proj',
      state: 'untrusted',
      report: validReport(),
    });
    expect(parsed.success).toBe(true);
  });
});
