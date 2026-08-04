/**
 * Project trust store — persistent trust decisions over project surfaces.
 *
 * Trust is keyed by canonical absolute path and fingerprinted against the
 * project's security surface: the raw `.orchid.json` bytes, the files under
 * `.orchid/{agents,skills,personalities}`, and root instruction-file aliases.
 * Bare projects carry no surface and resolve `trusted` without a store entry;
 * a drifted fingerprint turns an existing grant into `changed`.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  ProjectTrustReport,
  TrustReportConfigOverride,
  TrustReportDefinition,
  TrustReportMcpServer,
  TrustReportModelOverride,
  TrustReportPermission,
  TrustState,
  TrustedProjectEntry,
} from '../../shared/types/ipc';
import { readAgents } from '../agents/registry';
import { effectiveAgentsMdFilenames } from '../agents-md/config';
import {
  atomicWriteJson,
  loadConfig,
  HOME_AGENTS_DIR,
  HOME_CONFIG_DIR,
  HOME_PERSONALITIES_DIR,
  HOME_SKILLS_DIR,
  PROJECT_CONFIG_NAME,
} from '../config/loader';
import { isPlainObject, isUnsafeKey } from '../config/merge';
import {
  agentsMdConfigSchema,
  defaults,
  modelSelectionSchema,
  permissionRuleSchema,
  type Config,
} from '../config/schema';
import { readPersonalities } from '../personality/registry';
import { readSkills } from '../skills/registry';
import { canonicalizeProjectDirectory } from './path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Store file name inside `~/.orchid/` (mirrors the providers.json precedent). */
export const TRUST_STORE_NAME = 'trusted_projects.json';

/** Surface files above this size fingerprint by size instead of content. */
export const TRUST_FINGERPRINT_MAX_FILE_BYTES = 1_048_576;

/** Max definition-tree files fingerprinted; overflow records a marker. */
export const TRUST_FINGERPRINT_MAX_FILES = 1000;

/** Freshness bound for the fingerprint and home-baseline caches. */
export const TRUST_FINGERPRINT_CACHE_TTL_MS = 2000;

const DEFINITION_DIRS = ['agents', 'skills', 'personalities'] as const;

/** Top-level project-config keys with dedicated report sections. */
const SECTION_KEYS = new Set([
  'mcp_servers',
  'permissions',
  'agents_md',
  'default_model',
  'tier_models',
]);

/** Permission modes that let the project run tools without asking. */
const AUTO_ALLOW_MODES = new Set<string>(['allow', 'decide-for-me']);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TrustStoreRecord {
  trustedAt: string;
  fingerprint: string;
}

export interface ProjectTrustStoreOptions {
  /** Override the store file (default: `~/.orchid/trusted_projects.json`). */
  readonly storePath?: string;
  /** Override the home config path (primarily for tests). */
  readonly homeConfigPath?: string;
  /** Override the home agents directory. */
  readonly homeAgentsDir?: string;
  /** Override the home skills directory. */
  readonly homeSkillsDir?: string;
  /** Override the home personalities directory. */
  readonly homePersonalitiesDir?: string;
}

interface SurfaceFile {
  readonly relPath: string;
  readonly absPath: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireCanonicalProjectDirectory(dir: string): string {
  if (!path.isAbsolute(dir)) {
    throw new TypeError('Project directory must be an absolute path.');
  }

  const canonical = canonicalizeProjectDirectory(dir);
  if (canonical == null) {
    throw new Error(
      `Project directory must exist and be accessible: ${dir}`,
    );
  }
  return canonical;
}

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/** Tolerant raw project-layer read — missing or malformed content yields {}. */
function readRawProjectLayer(canonicalDir: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(path.join(canonicalDir, PROJECT_CONFIG_NAME), 'utf-8'),
    );
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readTrustStoreFile(storePath: string): Map<string, TrustStoreRecord> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(storePath, 'utf-8'));
  } catch {
    return new Map();
  }
  if (!isPlainObject(parsed)) return new Map();

  const records = new Map<string, TrustStoreRecord>();
  for (const [projectDir, value] of Object.entries(parsed)) {
    if (isUnsafeKey(projectDir) || !isPlainObject(value)) continue;
    const { trustedAt, fingerprint } = value;
    if (typeof trustedAt === 'string' && typeof fingerprint === 'string') {
      records.set(projectDir, { trustedAt, fingerprint });
    }
  }
  return records;
}

/**
 * Files under `.orchid/{agents,skills,personalities}` sorted by relative
 * path, capped at TRUST_FINGERPRINT_MAX_FILES. Symlinked directories are
 * followed with a realpath cycle guard.
 */
function listDefinitionFiles(canonicalDir: string): {
  files: SurfaceFile[];
  omitted: number;
} {
  const files: SurfaceFile[] = [];
  const visitedDirs = new Set<string>();
  for (const dirName of DEFINITION_DIRS) {
    walkDefinitionDir(
      path.join(canonicalDir, '.orchid', dirName),
      `.orchid/${dirName}`,
      files,
      visitedDirs,
    );
  }
  files.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  if (files.length <= TRUST_FINGERPRINT_MAX_FILES) return { files, omitted: 0 };
  return {
    files: files.slice(0, TRUST_FINGERPRINT_MAX_FILES),
    omitted: files.length - TRUST_FINGERPRINT_MAX_FILES,
  };
}

function walkDefinitionDir(
  absDir: string,
  relDir: string,
  out: SurfaceFile[],
  visitedDirs: Set<string>,
): void {
  let realDir: string;
  try {
    realDir = fs.realpathSync(absDir);
  } catch {
    return;
  }
  if (visitedDirs.has(realDir)) return;
  visitedDirs.add(realDir);

  let entries: string[];
  try {
    entries = fs.readdirSync(absDir).sort();
  } catch {
    return;
  }

  for (const entry of entries) {
    const absPath = path.join(absDir, entry);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absPath);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      walkDefinitionDir(absPath, `${relDir}/${entry}`, out, visitedDirs);
    } else if (stat.isFile()) {
      out.push({ relPath: `${relDir}/${entry}`, absPath });
    }
  }
}

/** Content hash for one surface file; oversized files fingerprint by size. */
function fileFingerprintPart(absPath: string): string {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return 'missing';
  }
  if (!stat.isFile()) return 'not-a-file';
  if (stat.size > TRUST_FINGERPRINT_MAX_FILE_BYTES) return `size=${stat.size}`;
  try {
    return createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
  } catch {
    return 'unreadable';
  }
}

/** Cheap size + mtime signature used to keep the fingerprint cache fresh. */
function fileSignaturePart(label: string, absPath: string): string {
  try {
    const stat = fs.statSync(absPath);
    return `${label}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return `${label}:missing`;
  }
}

// ---------------------------------------------------------------------------
// Report diffing
// ---------------------------------------------------------------------------

function diffMcpServers(
  raw: Record<string, unknown>,
  baseline: Config,
): TrustReportMcpServer[] {
  const projectServers = isPlainObject(raw['mcp_servers']) ? raw['mcp_servers'] : {};
  const servers: TrustReportMcpServer[] = [];
  for (const name of Object.keys(projectServers).sort()) {
    if (isUnsafeKey(name)) continue;
    const server: TrustReportMcpServer = {
      name,
      kind: Object.prototype.hasOwnProperty.call(baseline.mcp_servers, name)
        ? 'override'
        : 'added',
    };
    const entry = projectServers[name];
    if (isPlainObject(entry)) {
      const { command, url, args, env } = entry;
      if (typeof command === 'string') server.command = command;
      if (typeof url === 'string') server.url = url;
      if (Array.isArray(args) && args.every((arg) => typeof arg === 'string')) {
        server.args = [...args] as string[];
      }
      if (isPlainObject(env)) server.envKeys = Object.keys(env);
    }
    servers.push(server);
  }
  return servers;
}

function diffPermissions(raw: Record<string, unknown>): TrustReportPermission[] {
  const projectPermissions = isPlainObject(raw['permissions']) ? raw['permissions'] : {};
  const permissions: TrustReportPermission[] = [];
  for (const tool of Object.keys(projectPermissions).sort()) {
    if (isUnsafeKey(tool)) continue;
    const parsed = permissionRuleSchema.safeParse(projectPermissions[tool]);
    if (!parsed.success) continue;

    const rule = parsed.data;
    if (typeof rule === 'string') {
      permissions.push({ tool, rule, autoAllow: AUTO_ALLOW_MODES.has(rule) });
    } else {
      permissions.push({
        tool,
        rule: `inside:${rule.inside} outside:${rule.outside}`,
        autoAllow: AUTO_ALLOW_MODES.has(rule.inside) || AUTO_ALLOW_MODES.has(rule.outside),
      });
    }
  }
  return permissions;
}

function diffAgentsMd(
  raw: Record<string, unknown>,
  baseline: Config,
): TrustReportConfigOverride[] {
  const project = raw['agents_md'];
  if (project === undefined) return [];

  const baselineBlock = baseline.agents_md as unknown as Record<string, unknown>;
  if (!isPlainObject(project)) {
    return [{
      key: 'agents_md',
      projectValue: JSON.stringify(project),
      homeValue: JSON.stringify(baseline.agents_md),
    }];
  }

  const overrides: TrustReportConfigOverride[] = [];
  for (const key of Object.keys(project).sort()) {
    if (isUnsafeKey(key)) continue;
    const projectValue = project[key];
    if (projectValue === undefined) continue;
    const homeValue = baselineBlock[key];
    if (JSON.stringify(projectValue) === JSON.stringify(homeValue)) continue;
    overrides.push({
      key,
      projectValue: JSON.stringify(projectValue),
      homeValue: homeValue === undefined ? 'unset' : JSON.stringify(homeValue),
    });
  }
  return overrides;
}

function diffModelOverrides(raw: Record<string, unknown>): TrustReportModelOverride[] {
  const overrides: TrustReportModelOverride[] = [];

  if ('default_model' in raw) {
    const parsed = modelSelectionSchema.safeParse(raw['default_model']);
    if (parsed.success) {
      overrides.push({
        key: 'default_model',
        connectionId: parsed.data.connectionId,
        modelId: parsed.data.modelId,
      });
    }
  }

  const tiers = raw['tier_models'];
  if (isPlainObject(tiers)) {
    for (const tier of Object.keys(tiers).sort()) {
      if (isUnsafeKey(tier)) continue;
      const value = tiers[tier];
      if (value == null) continue;
      const parsed = modelSelectionSchema.safeParse(value);
      if (!parsed.success) continue;
      overrides.push({
        key: tier,
        connectionId: parsed.data.connectionId,
        modelId: parsed.data.modelId,
      });
    }
  }
  return overrides;
}

function diffOtherConfig(
  raw: Record<string, unknown>,
  baseline: Config,
): TrustReportConfigOverride[] {
  const baselineRecord = baseline as unknown as Record<string, unknown>;
  const overrides: TrustReportConfigOverride[] = [];
  for (const key of Object.keys(raw).sort()) {
    if (isUnsafeKey(key) || SECTION_KEYS.has(key)) continue;
    const projectValue = raw[key];
    if (projectValue === undefined) continue;
    const homeValue = baselineRecord[key];
    overrides.push({
      key,
      projectValue: JSON.stringify(projectValue),
      homeValue: homeValue === undefined ? 'unset' : JSON.stringify(homeValue),
    });
  }
  return overrides;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * Persistent trust decisions plus surface fingerprinting and report diffing.
 * Injectable paths keep tests away from the real home directory.
 */
export class ProjectTrustStore {
  private readonly storePath: string;
  private readonly options: ProjectTrustStoreOptions;
  private records: Map<string, TrustStoreRecord> | null = null;
  private readonly fingerprintCache = new Map<
    string,
    { fingerprint: string; signature: string; at: number }
  >();
  private baselineCache: { config: Config; at: number } | null = null;

  constructor(options: ProjectTrustStoreOptions = {}) {
    this.options = { ...options };
    this.storePath = options.storePath ?? path.join(HOME_CONFIG_DIR, TRUST_STORE_NAME);
  }

  /**
   * Resolve the live trust state for a directory. Fail-closed: anything that
   * cannot be canonicalized — or whose surface cannot be safely inspected —
   * is `untrusted`; bare projects are `trusted` without a store entry.
   */
  getState(dir: string): TrustState {
    try {
      const canonical = canonicalizeProjectDirectory(dir);
      if (canonical == null) return 'untrusted';
      return this.stateForCanonical(canonical);
    } catch {
      return 'untrusted';
    }
  }

  /** Record a trust grant with the current surface fingerprint. */
  grant(dir: string): void {
    const canonical = requireCanonicalProjectDirectory(dir);
    this.fingerprintCache.delete(canonical);
    const fingerprint = this.computeFingerprint(canonical);
    const next = new Map(this.loadRecords());
    next.set(canonical, { trustedAt: new Date().toISOString(), fingerprint });
    this.persist(next);
  }

  /** Remove a trust entry. Idempotent for unknown or invalid directories. */
  revoke(dir: string): void {
    const canonical = canonicalizeProjectDirectory(dir);
    if (canonical == null) return;
    this.fingerprintCache.delete(canonical);

    const records = this.loadRecords();
    if (!records.has(canonical)) return;
    const next = new Map(records);
    next.delete(canonical);
    this.persist(next);
  }

  /**
   * Whether the directory carries any project-supplied surface. Inspection
   * errors fail closed: assume a surface exists so the project still prompts.
   */
  hasSurface(dir: string): boolean {
    try {
      const canonical = canonicalizeProjectDirectory(dir);
      return canonical != null && this.surfacePresent(canonical);
    } catch {
      return true;
    }
  }

  /** Surface diff between the project and the home/global configuration. */
  buildReport(dir: string): ProjectTrustReport {
    const canonical = requireCanonicalProjectDirectory(dir);
    const raw = readRawProjectLayer(canonical);
    const baseline = this.homeBaseline();

    const definitions = this.projectDefinitions(canonical);
    const instructionFiles = this.presentInstructionFiles(canonical);

    return {
      projectDir: canonical,
      hasSurface:
        definitions.length > 0 ||
        instructionFiles.length > 0 ||
        isFile(path.join(canonical, PROJECT_CONFIG_NAME)),
      mcpServers: diffMcpServers(raw, baseline),
      permissions: diffPermissions(raw),
      agentsMdOverrides: diffAgentsMd(raw, baseline),
      modelOverrides: diffModelOverrides(raw),
      otherConfigOverrides: diffOtherConfig(raw, baseline),
      definitions,
      instructionFiles,
    };
  }

  /** Every store entry with its live trust state. */
  list(): TrustedProjectEntry[] {
    const entries: TrustedProjectEntry[] = [];
    for (const [projectDir, record] of this.loadRecords()) {
      let state: TrustState = 'untrusted';
      try {
        const canonical = canonicalizeProjectDirectory(projectDir);
        if (canonical != null) state = this.stateForCanonical(canonical);
      } catch {
        state = 'untrusted';
      }
      entries.push({ projectDir, trustedAt: record.trustedAt, state });
    }
    return entries.sort((a, b) =>
      a.projectDir < b.projectDir ? -1 : a.projectDir > b.projectDir ? 1 : 0,
    );
  }

  /** Drop in-memory caches; the next access re-reads from disk. */
  clear(): void {
    this.records = null;
    this.fingerprintCache.clear();
    this.baselineCache = null;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private stateForCanonical(canonical: string): TrustState {
    if (!this.surfacePresent(canonical)) return 'trusted';
    const record = this.loadRecords().get(canonical);
    if (record == null) return 'untrusted';
    return record.fingerprint === this.computeFingerprint(canonical)
      ? 'trusted'
      : 'changed';
  }

  private loadRecords(): Map<string, TrustStoreRecord> {
    if (this.records != null) return this.records;
    this.records = readTrustStoreFile(this.storePath);
    return this.records;
  }

  private persist(records: Map<string, TrustStoreRecord>): void {
    atomicWriteJson(this.storePath, Object.fromEntries(records));
    this.records = records;
  }

  private surfacePresent(canonical: string): boolean {
    if (isFile(path.join(canonical, PROJECT_CONFIG_NAME))) return true;
    if (this.projectDefinitions(canonical).length > 0) return true;
    return this.presentInstructionFiles(canonical).length > 0;
  }

  /** Home-effective config (defaults + home layer) for baseline diffs. */
  private homeBaseline(): Config {
    const now = Date.now();
    if (
      this.baselineCache != null &&
      now - this.baselineCache.at < TRUST_FINGERPRINT_CACHE_TTL_MS
    ) {
      return this.baselineCache.config;
    }
    let config: Config;
    try {
      config = loadConfig({
        projectDir: HOME_CONFIG_DIR,
        homeConfigPath: this.options.homeConfigPath,
      });
    } catch {
      // A corrupt home config must not wedge trust resolution.
      config = defaults();
    }
    this.baselineCache = { config, at: now };
    return config;
  }

  /** Union of home-effective and project-declared instruction-file aliases. */
  private instructionAliases(canonical: string): string[] {
    const aliases = [...effectiveAgentsMdFilenames(this.homeBaseline())];
    const raw = readRawProjectLayer(canonical);
    const projectBlock = raw['agents_md'];
    if (isPlainObject(projectBlock)) {
      const parsed = agentsMdConfigSchema.safeParse(projectBlock);
      if (parsed.success) {
        aliases.push(...effectiveAgentsMdFilenames({ agents_md: parsed.data }));
      }
    }

    const seen = new Set<string>();
    const result: string[] = [];
    for (const name of aliases) {
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(name);
    }
    return result;
  }

  /** Root alias files present at the project root (disk names, alias order). */
  private presentInstructionFiles(canonical: string): string[] {
    let entries: string[];
    try {
      entries = fs.readdirSync(canonical).sort();
    } catch {
      return [];
    }
    const byLower = new Map<string, string>();
    for (const entry of entries) {
      const lower = entry.toLowerCase();
      if (!byLower.has(lower)) byLower.set(lower, entry);
    }

    const present: string[] = [];
    const seen = new Set<string>();
    for (const alias of this.instructionAliases(canonical)) {
      const match = byLower.get(alias.toLowerCase());
      if (match == null) continue;
      const key = match.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      present.push(match);
    }
    return present;
  }

  /** Project-local definitions with home-shadow markers. */
  private projectDefinitions(canonical: string): TrustReportDefinition[] {
    const probeHomeDir = path.join(canonical, '.orchid', '__trust_probe__');
    const homeAgents = readAgents({
      homeDir: this.options.homeAgentsDir ?? HOME_AGENTS_DIR,
    });
    const homeSkills = readSkills({
      homeDir: this.options.homeSkillsDir ?? HOME_SKILLS_DIR,
    });
    const homePersonalities = readPersonalities({
      homeDir: this.options.homePersonalitiesDir ?? HOME_PERSONALITIES_DIR,
    });
    const projectAgents = readAgents({
      homeDir: probeHomeDir,
      projectDir: path.join(canonical, '.orchid', 'agents'),
    });
    const projectSkills = readSkills({
      homeDir: probeHomeDir,
      projectDir: path.join(canonical, '.orchid', 'skills'),
    });
    const projectPersonalities = readPersonalities({
      homeDir: probeHomeDir,
      projectDir: canonical,
    });

    const definitions: TrustReportDefinition[] = [];
    for (const name of [...projectAgents.keys()].sort()) {
      definitions.push({ kind: 'agent', name, overridesHome: homeAgents.has(name) });
    }
    for (const name of [...projectSkills.keys()].sort()) {
      definitions.push({ kind: 'skill', name, overridesHome: homeSkills.has(name) });
    }
    for (const name of [...projectPersonalities.keys()].sort()) {
      definitions.push({
        kind: 'personality',
        name,
        overridesHome: homePersonalities.has(name),
      });
    }
    return definitions;
  }

  private computeFingerprint(canonical: string): string {
    const now = Date.now();
    const signature = this.surfaceSignature(canonical);
    const cached = this.fingerprintCache.get(canonical);
    if (
      cached != null &&
      cached.signature === signature &&
      now - cached.at < TRUST_FINGERPRINT_CACHE_TTL_MS
    ) {
      return cached.fingerprint;
    }

    const fingerprint = this.hashSurface(canonical);
    this.fingerprintCache.set(canonical, { fingerprint, signature, at: now });
    return fingerprint;
  }

  private surfaceSignature(canonical: string): string {
    const parts = [
      fileSignaturePart('config', path.join(canonical, PROJECT_CONFIG_NAME)),
    ];
    const { files, omitted } = listDefinitionFiles(canonical);
    for (const file of files) {
      parts.push(fileSignaturePart(file.relPath, file.absPath));
    }
    if (omitted > 0) parts.push(`truncated:${omitted}`);
    for (const name of this.presentInstructionFiles(canonical)) {
      parts.push(fileSignaturePart(`alias:${name}`, path.join(canonical, name)));
    }
    return parts.join('|');
  }

  private hashSurface(canonical: string): string {
    const hash = createHash('sha256');
    hash.update(
      `config:${fileFingerprintPart(path.join(canonical, PROJECT_CONFIG_NAME))}\n`,
    );
    const { files, omitted } = listDefinitionFiles(canonical);
    for (const file of files) {
      hash.update(`${file.relPath}:${fileFingerprintPart(file.absPath)}\n`);
    }
    if (omitted > 0) hash.update(`truncated:${omitted}\n`);
    for (const name of this.presentInstructionFiles(canonical)) {
      hash.update(`alias:${name}:${fileFingerprintPart(path.join(canonical, name))}\n`);
    }
    return hash.digest('hex');
  }
}

// ---------------------------------------------------------------------------
// Process singleton + accessors
// ---------------------------------------------------------------------------

let projectTrustStore = new ProjectTrustStore();

export function getProjectTrustStore(): ProjectTrustStore {
  return projectTrustStore;
}

export function getProjectTrustState(dir: string): TrustState {
  return getProjectTrustStore().getState(dir);
}

export function grantProjectTrust(dir: string): void {
  getProjectTrustStore().grant(dir);
}

export function revokeProjectTrust(dir: string): void {
  getProjectTrustStore().revoke(dir);
}

export function buildProjectTrustReport(dir: string): ProjectTrustReport {
  return getProjectTrustStore().buildReport(dir);
}

export function hasProjectSurface(dir: string): boolean {
  return getProjectTrustStore().hasSurface(dir);
}

export function listTrustedProjects(): TrustedProjectEntry[] {
  return getProjectTrustStore().list();
}

/** @internal — tests: replace the process store (no options → defaults). */
export function resetProjectTrustStore(options?: ProjectTrustStoreOptions): void {
  projectTrustStore = new ProjectTrustStore(options);
}

/** @internal — tests: clear the current store's in-memory caches. */
export function clearProjectTrustStore(): void {
  projectTrustStore.clear();
}
