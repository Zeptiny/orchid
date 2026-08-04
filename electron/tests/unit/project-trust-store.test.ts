/**
 * Project trust store — persistence, canonical keys, fingerprint lifecycle (U2).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as agentsRegistry from '../../src/main/agents/registry';
import * as personalityRegistry from '../../src/main/personality/registry';
import * as skillsRegistry from '../../src/main/skills/registry';
import {
  ProjectTrustStore,
  TRUST_FINGERPRINT_HARD_CAP_BYTES,
  TRUST_FINGERPRINT_MAX_FILE_BYTES,
  TRUST_FINGERPRINT_MAX_FILES,
  getProjectTrustState,
  grantProjectTrust,
  listTrustedProjects,
  resetProjectTrustStore,
  revokeProjectTrust,
  revokeProjectTrustRaw,
} from '../../src/main/project/trust';

let tmpRoot: string;
let storePath: string;
let homeDir: string;
let project: string;

function createStore(): ProjectTrustStore {
  return new ProjectTrustStore({
    storePath,
    homeConfigPath: path.join(homeDir, 'config.json'),
    homeAgentsDir: path.join(homeDir, 'agents'),
    homeSkillsDir: path.join(homeDir, 'skills'),
    homePersonalitiesDir: path.join(homeDir, 'personalities'),
  });
}

function writeOrchidJson(dir: string, value: unknown): void {
  fs.writeFileSync(
    path.join(dir, '.orchid.json'),
    JSON.stringify(value, null, 2),
    'utf-8',
  );
}

function writeAgentDefinition(baseDir: string, name: string, body: string): void {
  const agentDir = path.join(baseDir, '.orchid', 'agents', name);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, 'AGENT.md'),
    [
      '---',
      `name: ${name}`,
      'type: subagent',
      'tier: bloom',
      'description: test agent',
      '---',
      body,
    ].join('\n'),
    'utf-8',
  );
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-project-trust-store-'));
  storePath = path.join(tmpRoot, 'trusted_projects.json');
  homeDir = path.join(tmpRoot, 'home');
  project = path.join(tmpRoot, 'project');
  fs.mkdirSync(project);
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('ProjectTrustStore', () => {
  it('persists grants to disk, reloads them, and canonicalizes symlinked keys', () => {
    writeOrchidJson(project, { command_timeout: 31 });
    const store = createStore();
    expect(store.getState(project)).toBe('untrusted');

    store.grant(project);

    const canonical = fs.realpathSync(project);
    const raw = JSON.parse(fs.readFileSync(storePath, 'utf-8')) as Record<
      string,
      { trustedAt: string; fingerprint: string }
    >;
    expect(Object.keys(raw)).toEqual([canonical]);
    expect(typeof raw[canonical].trustedAt).toBe('string');
    expect(typeof raw[canonical].fingerprint).toBe('string');

    const reloaded = createStore();
    expect(reloaded.getState(project)).toBe('trusted');

    const alias = path.join(tmpRoot, 'project-alias');
    fs.symlinkSync(
      project,
      alias,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    expect(reloaded.getState(alias)).toBe('trusted');
    expect(reloaded.list()).toHaveLength(1);
  });

  it('auto-trusts bare projects without writing a store entry', () => {
    const store = createStore();

    expect(store.hasSurface(project)).toBe(false);
    expect(store.getState(project)).toBe('trusted');
    expect(fs.existsSync(storePath)).toBe(false);
    expect(store.list()).toEqual([]);
  });

  it('detects surfaces from .orchid.json, definitions, and instruction files', () => {
    const store = createStore();
    expect(store.hasSurface(project)).toBe(false);

    fs.writeFileSync(path.join(project, 'README.md'), '# readme', 'utf-8');
    expect(store.hasSurface(project)).toBe(false);

    writeOrchidJson(project, { command_timeout: 31 });
    expect(store.hasSurface(project)).toBe(true);
    fs.rmSync(path.join(project, '.orchid.json'));

    writeAgentDefinition(project, 'reviewer', 'reviews code');
    expect(store.hasSurface(project)).toBe(true);
    fs.rmSync(path.join(project, '.orchid'), { recursive: true, force: true });

    fs.writeFileSync(path.join(project, 'AGENTS.md'), '# rules', 'utf-8');
    expect(store.hasSurface(project)).toBe(true);
  });

  it('walks untrusted → trusted → changed → trusted across grants and edits', () => {
    writeOrchidJson(project, { command_timeout: 31 });
    const store = createStore();

    expect(store.getState(project)).toBe('untrusted');
    store.grant(project);
    expect(store.getState(project)).toBe('trusted');

    writeOrchidJson(project, { command_timeout: 999 });
    expect(store.getState(project)).toBe('changed');

    store.grant(project);
    expect(store.getState(project)).toBe('trusted');
  });

  it('flips to changed only for security-surface edits', () => {
    writeOrchidJson(project, { command_timeout: 31 });
    writeAgentDefinition(project, 'reviewer', 'reviews code');
    fs.writeFileSync(path.join(project, 'AGENTS.md'), '# rules v1', 'utf-8');
    fs.writeFileSync(path.join(project, 'README.md'), '# readme v1', 'utf-8');
    const store = createStore();
    store.grant(project);
    expect(store.getState(project)).toBe('trusted');

    writeAgentDefinition(project, 'reviewer', 'reviews code much more strictly now');
    expect(store.getState(project)).toBe('changed');
    store.grant(project);
    expect(store.getState(project)).toBe('trusted');

    fs.writeFileSync(path.join(project, 'AGENTS.md'), '# rules v2 (changed)', 'utf-8');
    expect(store.getState(project)).toBe('changed');
    store.grant(project);
    expect(store.getState(project)).toBe('trusted');

    fs.writeFileSync(path.join(project, 'README.md'), '# readme v2 (changed)', 'utf-8');
    expect(store.getState(project)).toBe('trusted');
  });

  it('revokes entries and treats unknown revocations as no-ops', () => {
    writeOrchidJson(project, { command_timeout: 31 });
    const store = createStore();
    store.grant(project);
    expect(store.getState(project)).toBe('trusted');

    store.revoke(project);
    expect(store.getState(project)).toBe('untrusted');
    expect(store.list()).toEqual([]);
    const raw = JSON.parse(fs.readFileSync(storePath, 'utf-8'));
    expect(raw).toEqual({});

    store.revoke(project);
    store.revoke(path.join(tmpRoot, 'never-seen'));
    expect(store.getState(project)).toBe('untrusted');
  });

  it('revokeRaw drops records by exact path string without canonicalizing', () => {
    writeOrchidJson(project, { command_timeout: 31 });
    const goneProject = path.join(tmpRoot, 'gone-project');
    fs.mkdirSync(goneProject);
    writeOrchidJson(goneProject, { command_timeout: 32 });

    const store = createStore();
    store.grant(project);
    store.grant(goneProject);
    fs.rmSync(goneProject, { recursive: true, force: true });
    expect(store.list()).toHaveLength(2);

    // Works for entries whose directory no longer exists.
    store.revokeRaw(goneProject);
    const entries = store.list();
    expect(entries).toHaveLength(1);
    expect(entries[0].projectDir).toBe(fs.realpathSync(project));

    // Exact-string semantics: no canonicalization, idempotent for unknown keys.
    store.revokeRaw(fs.realpathSync(project) + path.sep);
    expect(store.list()).toHaveLength(1);
    store.revokeRaw(fs.realpathSync(project));
    expect(store.list()).toEqual([]);
    store.revokeRaw(fs.realpathSync(project));
    expect(store.list()).toEqual([]);
  });

  it('loads corrupt or non-object store files as empty without throwing', () => {
    writeOrchidJson(project, { command_timeout: 31 });

    fs.writeFileSync(storePath, '%%% not json %%%', 'utf-8');
    const corruptStore = createStore();
    expect(() => corruptStore.list()).not.toThrow();
    expect(corruptStore.list()).toEqual([]);
    expect(corruptStore.getState(project)).toBe('untrusted');
    corruptStore.grant(project);
    expect(corruptStore.getState(project)).toBe('trusted');

    fs.writeFileSync(storePath, '[1, 2, 3]', 'utf-8');
    const nonObjectStore = createStore();
    expect(nonObjectStore.list()).toEqual([]);

    fs.writeFileSync(storePath, JSON.stringify({ [project]: { trustedAt: 42 } }), 'utf-8');
    const badRecordStore = createStore();
    expect(badRecordStore.list()).toEqual([]);
  });

  it('lists entries with live trust state including changed', () => {
    const projectB = path.join(tmpRoot, 'project-b');
    fs.mkdirSync(projectB);
    writeOrchidJson(project, { command_timeout: 31 });
    writeOrchidJson(projectB, { command_timeout: 32 });
    const store = createStore();
    store.grant(project);
    store.grant(projectB);

    writeOrchidJson(projectB, { command_timeout: 99999 });

    const entries = store.list();
    expect(entries).toHaveLength(2);
    const entryA = entries.find((e) => e.projectDir === fs.realpathSync(project));
    const entryB = entries.find((e) => e.projectDir === fs.realpathSync(projectB));
    expect(entryA?.state).toBe('trusted');
    expect(entryB?.state).toBe('changed');
    expect(typeof entryA?.trustedAt).toBe('string');
  });

  it('reports untrusted for entries whose directory disappeared', () => {
    writeOrchidJson(project, { command_timeout: 31 });
    const store = createStore();
    store.grant(project);

    fs.rmSync(project, { recursive: true, force: true });

    const entries = store.list();
    expect(entries).toHaveLength(1);
    expect(entries[0].state).toBe('untrusted');
    expect(store.getState(project)).toBe('untrusted');
  });

  it('hashes oversized surface files by content, so same-size swaps flip to changed', () => {
    writeOrchidJson(project, { command_timeout: 31 });
    const bigDir = path.join(project, '.orchid', 'agents', 'big');
    fs.mkdirSync(bigDir, { recursive: true });
    const blobPath = path.join(bigDir, 'blob.dat');
    fs.writeFileSync(blobPath, Buffer.alloc(TRUST_FINGERPRINT_MAX_FILE_BYTES + 1, 1));
    const store = createStore();
    store.grant(project);
    expect(store.getState(project)).toBe('trusted');

    fs.writeFileSync(blobPath, Buffer.alloc(TRUST_FINGERPRINT_MAX_FILE_BYTES + 1, 2));
    expect(store.getState(project)).toBe('changed');

    store.grant(project);
    expect(store.getState(project)).toBe('trusted');
  });

  it('fingerprints files above the streaming hard cap by size only', () => {
    writeOrchidJson(project, { command_timeout: 31 });
    const bigDir = path.join(project, '.orchid', 'agents', 'big');
    fs.mkdirSync(bigDir, { recursive: true });
    const blobPath = path.join(bigDir, 'blob.dat');
    fs.writeFileSync(blobPath, Buffer.alloc(TRUST_FINGERPRINT_HARD_CAP_BYTES + 1, 1));
    const store = createStore();
    store.grant(project);
    expect(store.getState(project)).toBe('trusted');

    // Documented residual: same-size content edits past the hard cap stay
    // invisible to the fingerprint.
    fs.writeFileSync(blobPath, Buffer.alloc(TRUST_FINGERPRINT_HARD_CAP_BYTES + 1, 2));
    expect(store.getState(project)).toBe('trusted');

    fs.writeFileSync(blobPath, Buffer.alloc(TRUST_FINGERPRINT_HARD_CAP_BYTES + 2, 1));
    expect(store.getState(project)).toBe('changed');
  });

  it('caps the fingerprint listing at TRUST_FINGERPRINT_MAX_FILES', () => {
    writeOrchidJson(project, { command_timeout: 31 });
    const manyDir = path.join(project, '.orchid', 'skills', 'many');
    fs.mkdirSync(manyDir, { recursive: true });
    for (let i = 0; i <= TRUST_FINGERPRINT_MAX_FILES; i += 1) {
      fs.writeFileSync(
        path.join(manyDir, `file-${String(i).padStart(5, '0')}.txt`),
        `content ${i}`,
      );
    }
    const store = createStore();
    store.grant(project);
    expect(store.getState(project)).toBe('trusted');

    fs.writeFileSync(path.join(manyDir, 'file-00000.txt'), 'content 0 changed');
    expect(store.getState(project)).toBe('changed');
    store.grant(project);
    expect(store.getState(project)).toBe('trusted');

    // The overflow marker names the first file past the cap, so swapping
    // which file overflows changes the fingerprint even though the kept
    // file set is identical.
    fs.renameSync(
      path.join(manyDir, 'file-01000.txt'),
      path.join(manyDir, 'file-01000-renamed.txt'),
    );
    expect(store.getState(project)).toBe('changed');
  });

  it('fails closed for invalid directories and throws on grant', () => {
    const store = createStore();

    expect(store.getState(path.join(tmpRoot, 'missing'))).toBe('untrusted');
    expect(store.getState('relative/dir')).toBe('untrusted');
    expect(store.hasSurface(path.join(tmpRoot, 'missing'))).toBe(false);

    expect(() => store.grant(path.join(tmpRoot, 'missing'))).toThrow(/accessible/i);
    expect(() => store.grant('relative/dir')).toThrow(/absolute/i);
  });
});

describe('process store state caching', () => {
  beforeEach(() => {
    resetProjectTrustStore({ storePath });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetProjectTrustStore();
  });

  it('resolves repeated trust state without re-running definition loaders', () => {
    writeOrchidJson(project, { command_timeout: 31 });
    const bareProject = path.join(tmpRoot, 'bare-project');
    fs.mkdirSync(bareProject);

    const readAgentsSpy = vi.spyOn(agentsRegistry, 'readAgents');
    const readSkillsSpy = vi.spyOn(skillsRegistry, 'readSkills');
    const readPersonalitiesSpy = vi.spyOn(personalityRegistry, 'readPersonalities');

    expect(getProjectTrustState(project)).toBe('untrusted');
    expect(getProjectTrustState(project)).toBe('untrusted');
    expect(getProjectTrustState(bareProject)).toBe('trusted');
    expect(getProjectTrustState(bareProject)).toBe('trusted');

    // Surface detection is file-based and TTL-cached — the definition
    // registries never run during state resolution.
    expect(readAgentsSpy).not.toHaveBeenCalled();
    expect(readSkillsSpy).not.toHaveBeenCalled();
    expect(readPersonalitiesSpy).not.toHaveBeenCalled();

    // Grant / revoke invalidate the cache immediately.
    grantProjectTrust(project);
    expect(getProjectTrustState(project)).toBe('trusted');
    revokeProjectTrust(project);
    expect(getProjectTrustState(project)).toBe('untrusted');
    expect(readAgentsSpy).not.toHaveBeenCalled();
  });

  it('revokeProjectTrustRaw routes to the process store', () => {
    writeOrchidJson(project, { command_timeout: 31 });
    grantProjectTrust(project);
    expect(getProjectTrustState(project)).toBe('trusted');

    // Record removal without invalidation side effects.
    revokeProjectTrustRaw(fs.realpathSync(project));
    expect(fs.readFileSync(storePath, 'utf-8')).toBe('{}');
    expect(listTrustedProjects()).toEqual([]);
  });
});
