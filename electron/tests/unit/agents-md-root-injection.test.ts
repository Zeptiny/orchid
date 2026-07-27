/**
 * Root AGENTS.md injection tests (U3).
 *
 * Covers the pure helpers in `project/agents-md.ts`: locating the workspace-root
 * instruction file (`findRootAgentsMdEntry`) and appending its byte-capped
 * content to the system prompt (`appendRootAgentsMd`). The chat.ts wiring is not
 * unit-tested here — it is verified by typecheck plus the existing chat and
 * personality suites staying green.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  defaults,
  type AgentsMdConfig,
  type Config,
} from '../../src/main/config';
import { AGENTS_MD_DEFAULTS } from '../../src/main/agents-md/config';
import {
  appendRootAgentsMd,
  findRootAgentsMdEntry,
} from '../../src/main/project/agents-md';
import type { ProjectRuntime } from '../../src/main/project/runtime';

const BASE_PROMPT = 'You are a helpful assistant.';

/** Build a full Config with `agents_md` overrides applied over the defaults. */
function agentsConfig(overrides: Partial<AgentsMdConfig> = {}): Config {
  return { ...defaults(), agents_md: { ...AGENTS_MD_DEFAULTS, ...overrides } };
}

/** Minimal runtime carrying only the fields the helpers read. */
function makeRuntime(projectDir: string, config: Config): ProjectRuntime {
  return {
    projectDir,
    config,
    agents: new Map(),
    skills: new Map(),
    personalities: new Map(),
  };
}

describe('root AGENTS.md injection', () => {
  let root: string;
  let workspace: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-agents-md-root-'));
    workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function write(rel: string, content = 'instructions'): string {
    const abs = path.join(workspace, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
    return abs;
  }

  it('appends the root file content and reports a root-tier entry', () => {
    const rootFile = write('AGENTS.md', 'root instructions');
    const config = agentsConfig();

    const entry = findRootAgentsMdEntry(workspace, config);
    expect(entry).not.toBeNull();
    expect(entry?.tier).toBe('root');
    expect(entry?.path).toBe(rootFile);
    expect(entry?.displayPath).toBe('AGENTS.md');

    const result = appendRootAgentsMd(BASE_PROMPT, makeRuntime(workspace, config));
    expect(result).toBe(
      `${BASE_PROMPT}\n\n## Project instructions (AGENTS.md)\n\nroot instructions\n`,
    );
    expect(result.startsWith(BASE_PROMPT)).toBe(true);
    expect(result).toContain('root instructions');
  });

  it('returns the prompt unchanged when no root instruction file exists', () => {
    const config = agentsConfig();

    expect(findRootAgentsMdEntry(workspace, config)).toBeNull();
    expect(appendRootAgentsMd(BASE_PROMPT, makeRuntime(workspace, config))).toBe(
      BASE_PROMPT,
    );
  });

  it('returns the prompt unchanged when the feature is disabled, even with a root file', () => {
    write('AGENTS.md', 'root instructions');
    const config = agentsConfig({ enabled: false });

    expect(findRootAgentsMdEntry(workspace, config)).toBeNull();
    expect(appendRootAgentsMd(BASE_PROMPT, makeRuntime(workspace, config))).toBe(
      BASE_PROMPT,
    );
  });

  it('injects only the first configured alias when the root has several', () => {
    write('AGENTS.md', 'primary content');
    write('CLAUDE.md', 'alias content');
    const config = agentsConfig();

    const entry = findRootAgentsMdEntry(workspace, config);
    expect(entry?.displayPath).toBe('AGENTS.md');

    const result = appendRootAgentsMd(BASE_PROMPT, makeRuntime(workspace, config));
    expect(result).toContain('primary content');
    expect(result).not.toContain('alias content');
    expect(result).toContain('## Project instructions (AGENTS.md)');
  });

  it('truncates an over-cap root file and appends a read pointer note', () => {
    write('AGENTS.md', 'x'.repeat(100));
    const config = agentsConfig({ max_file_bytes: 10 });

    const entry = findRootAgentsMdEntry(workspace, config);
    expect(entry?.sizeBytes).toBe(100);

    const result = appendRootAgentsMd(BASE_PROMPT, makeRuntime(workspace, config));
    expect(result).toContain('x'.repeat(10));
    expect(result).not.toContain('x'.repeat(11));
    expect(result).toContain('[truncated to 10 bytes');
    expect(result).toContain('use read for the full file]');
  });

  it('does not add a truncation note for a file at exactly max_file_bytes', () => {
    write('AGENTS.md', 'y'.repeat(10));
    const config = agentsConfig({ max_file_bytes: 10 });

    const result = appendRootAgentsMd(BASE_PROMPT, makeRuntime(workspace, config));
    expect(result).toContain('y'.repeat(10));
    expect(result).not.toContain('[truncated');
  });

  it('picks up a root AGENTS.local.md only when include_local is true and no alias precedes it', () => {
    write('AGENTS.local.md', 'local only');

    expect(findRootAgentsMdEntry(workspace, agentsConfig({ include_local: false }))).toBeNull();

    const config = agentsConfig({ include_local: true });
    const entry = findRootAgentsMdEntry(workspace, config);
    expect(entry?.displayPath).toBe('AGENTS.local.md');

    const result = appendRootAgentsMd(BASE_PROMPT, makeRuntime(workspace, config));
    expect(result).toContain('local only');
    expect(result).toContain('## Project instructions (AGENTS.local.md)');
  });

  it('returns null for a nested-only setup with no root instruction file', () => {
    write('pkg/AGENTS.md', 'nested only');
    const config = agentsConfig();

    expect(findRootAgentsMdEntry(workspace, config)).toBeNull();
    expect(appendRootAgentsMd(BASE_PROMPT, makeRuntime(workspace, config))).toBe(
      BASE_PROMPT,
    );
  });
});
