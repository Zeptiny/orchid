/**
 * Agent Parity Tests — U28.
 *
 * Protects the complete built-in agent inventory established by the desktop migration.
 * Tests STRUCTURE (all agents load, correct metadata), not behavior.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  loadAgents,
  getAgent,
  listAgents,
  resetAgentRegistry,
} from '../../src/main/agents/registry';
import { AgentType, AgentTier } from '../../src/shared/types/agent';

// ── Expected agents (27 total) ─────────────────────────────────────────────

const EXPECTED_AGENTS = [
  { name: 'compactor', type: 'internal', tier: 'seed' },
  { name: 'compactor-selective', type: 'internal', tier: 'seed' },
  { name: 'compactor-subagent', type: 'internal', tier: 'seed' },
  { name: 'compactor-subagent-selective', type: 'internal', tier: 'seed' },
  { name: 'general', type: 'internal', tier: 'bloom' },
  { name: 'permission-evaluator', type: 'internal', tier: 'seed' },
  { name: 'session-namer', type: 'internal', tier: 'seed' },
  { name: 'web-fetch', type: 'internal', tier: 'seed' },
  { name: 'implementer', type: 'subagent', tier: 'bloom' },
  { name: 'explorer', type: 'subagent', tier: 'seed' },
  { name: 'reviewer', type: 'subagent', tier: 'crown' },
  { name: 'correctness-reviewer', type: 'subagent', tier: 'crown' },
  { name: 'security-reviewer', type: 'subagent', tier: 'crown' },
  { name: 'performance-reviewer', type: 'subagent', tier: 'crown' },
  { name: 'maintainability-reviewer', type: 'subagent', tier: 'bloom' },
  { name: 'testing-reviewer', type: 'subagent', tier: 'bloom' },
  { name: 'adversarial-reviewer', type: 'subagent', tier: 'crown' },
  { name: 'reliability-reviewer', type: 'subagent', tier: 'crown' },
  { name: 'api-contract-reviewer', type: 'subagent', tier: 'bloom' },
  { name: 'coherence-reviewer', type: 'subagent', tier: 'bloom' },
  { name: 'agent-native-reviewer', type: 'subagent', tier: 'crown' },
  { name: 'architecture-strategist', type: 'subagent', tier: 'crown' },
  { name: 'data-integrity-guardian', type: 'subagent', tier: 'crown' },
  { name: 'feasibility-reviewer', type: 'subagent', tier: 'bloom' },
  { name: 'spec-flow-analyzer', type: 'subagent', tier: 'bloom' },
  { name: 'product-lens-reviewer', type: 'subagent', tier: 'crown' },
  { name: 'code-simplicity-reviewer', type: 'subagent', tier: 'bloom' },
  { name: 'scope-guardian-reviewer', type: 'subagent', tier: 'bloom' },
  { name: 'pr-comment-resolver', type: 'subagent', tier: 'bloom' },
  { name: 'web-researcher', type: 'subagent', tier: 'sprout' },
  { name: 'learnings-researcher', type: 'subagent', tier: 'sprout' },
  { name: 'adversarial-document-reviewer', type: 'subagent', tier: 'crown' },
];

// ── Helpers ─────────────────────────────────────────────────────────────────

let tmpDir: string;

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-agent-parity-'));
}

beforeEach(() => {
  tmpDir = makeTmpDir();
  resetAgentRegistry();
});

afterEach(() => {
  resetAgentRegistry();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Agent Parity', () => {
  it('all 32 agents load from defaults', () => {
    const agents = loadAgents({
      homeDir: path.join(__dirname, '../../src/main/agents/defaults'),
      projectDir: path.join(tmpDir, 'empty-project'),
    });

    expect(agents.size).toBe(32);
  });

  it('all expected agent names are present', () => {
    const agents = loadAgents({
      homeDir: path.join(__dirname, '../../src/main/agents/defaults'),
      projectDir: path.join(tmpDir, 'empty-project'),
    });

    const names = Array.from(agents.keys()).sort();
    const expectedNames = EXPECTED_AGENTS.map((a) => a.name).sort();
    expect(names).toEqual(expectedNames);
  });

  it('each agent has correct type and tier', () => {
    loadAgents({
      homeDir: path.join(__dirname, '../../src/main/agents/defaults'),
      projectDir: path.join(tmpDir, 'empty-project'),
    });

    for (const expected of EXPECTED_AGENTS) {
      const agent = getAgent(expected.name);
      expect(agent, `Agent '${expected.name}' should exist`).toBeDefined();
      expect(agent!.type, `Agent '${expected.name}' type`).toBe(expected.type);
      expect(agent!.tier, `Agent '${expected.name}' tier`).toBe(expected.tier);
    }
  });

  it('each agent has a non-empty description', () => {
    loadAgents({
      homeDir: path.join(__dirname, '../../src/main/agents/defaults'),
      projectDir: path.join(tmpDir, 'empty-project'),
    });

    for (const agent of listAgents()) {
      expect(agent.description, `Agent '${agent.name}' description`).toBeTruthy();
      expect(agent.description.length, `Agent '${agent.name}' description length`).toBeGreaterThan(5);
    }
  });

  it('each agent has allowed_tools array', () => {
    loadAgents({
      homeDir: path.join(__dirname, '../../src/main/agents/defaults'),
      projectDir: path.join(tmpDir, 'empty-project'),
    });

    for (const agent of listAgents()) {
      expect(Array.isArray(agent.allowed_tools), `Agent '${agent.name}' allowed_tools`).toBe(true);
    }
  });

  it('internal agents have correct allowed_tools', () => {
    loadAgents({
      homeDir: path.join(__dirname, '../../src/main/agents/defaults'),
      projectDir: path.join(tmpDir, 'empty-project'),
    });

    const general = getAgent('general')!;
    expect(general.allowed_tools).toContain('read');
    expect(general.allowed_tools).toContain('grep');
    expect(general.allowed_tools).toContain('edit');
    expect(general.allowed_tools).toContain('write');
    expect(general.allowed_tools).toContain('apply_patch');
    expect(general.allowed_tools).toContain('delegate_to_subagent');
    expect(general.allowed_skills).toContain('*');

    const webFetch = getAgent('web-fetch')!;
    expect(webFetch.allowed_tools).toEqual([]);

    const sessionNamer = getAgent('session-namer')!;
    expect(sessionNamer.allowed_tools).toEqual([]);

    const implementer = getAgent('implementer')!;
    expect(implementer.allowed_tools).toContain('apply_patch');
  });

  it('explorer has read-only tools (no edit/write)', () => {
    loadAgents({
      homeDir: path.join(__dirname, '../../src/main/agents/defaults'),
      projectDir: path.join(tmpDir, 'empty-project'),
    });

    const explorer = getAgent('explorer')!;
    expect(explorer.allowed_tools).toContain('read');
    expect(explorer.allowed_tools).toContain('glob');
    expect(explorer.allowed_tools).toContain('grep');
    expect(explorer.allowed_tools).not.toContain('edit');
    expect(explorer.allowed_tools).not.toContain('write');
  });

  it('tier distribution matches bundled defaults', () => {
    loadAgents({
      homeDir: path.join(__dirname, '../../src/main/agents/defaults'),
      projectDir: path.join(tmpDir, 'empty-project'),
    });

    const agents = listAgents();
    const tierCounts = { seed: 0, sprout: 0, bloom: 0, crown: 0 };

    for (const agent of agents) {
      tierCounts[agent.tier]++;
    }

    expect(tierCounts.seed).toBe(8);   // explorer, web-fetch, session-namer, compactor x4, permission-evaluator
    expect(tierCounts.sprout).toBe(2); // web-researcher, learnings-researcher
    expect(tierCounts.bloom).toBe(11); // general, implementer, api-contract, etc.
    expect(tierCounts.crown).toBe(11); // reviewers, adversarial, etc.
  });

  it('type distribution matches bundled defaults', () => {
    loadAgents({
      homeDir: path.join(__dirname, '../../src/main/agents/defaults'),
      projectDir: path.join(tmpDir, 'empty-project'),
    });

    const agents = listAgents();
    const internalAgents = agents.filter((a) => a.type === AgentType.INTERNAL);
    const subagentAgents = agents.filter((a) => a.type === AgentType.SUBAGENT);

    expect(internalAgents).toHaveLength(8);
    expect(subagentAgents).toHaveLength(24);
  });

  it('agent allowed_tools arrays are frozen (immutable)', () => {
    loadAgents({
      homeDir: path.join(__dirname, '../../src/main/agents/defaults'),
      projectDir: path.join(tmpDir, 'empty-project'),
    });

    const general = getAgent('general')!;
    expect(() => {
      (general.allowed_tools as string[]).push('new_tool');
    }).toThrow();
  });
});
