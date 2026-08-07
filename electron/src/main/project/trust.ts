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

/** Surface files up to this size are read in one shot; larger ones stream. */
export const TRUST_FINGERPRINT_MAX_FILE_BYTES = 1_048_576;

/**
 * Surface files above this size fingerprint as `size=N:truncated` — beyond
 * this bound a file cannot plausibly be definition content, so same-size
 * content changes past the cap are a documented residual.
 */
export const TRUST_FINGERPRINT_HARD_CAP_BYTES = 33_554_432;

/** Chunk size for streaming content hashes of oversized surface files. */
const FINGERPRINT_CHUNK_BYTES = 65_536;

/** Max definition-tree files fingerprinted; overflow records a marker. */
export const TRUST_FINGERPRINT_MAX_FILES = 1000;

/** Freshness bound for the fingerprint and home-baseline caches. */
export const TRUST_FINGERPRINT_CACHE_TTL_MS = 2000;

/** Max `.orchid.json` size read for the report; larger files read as {}. */
export const TRUST_REPORT_MAX_CONFIG_BYTES = TRUST_FINGERPRINT_MAX_FILE_BYTES * 4;

/** Max definitions enumerated in the report. */
export const TRUST_REPORT_MAX_DEFINITIONS = 500;

/** Max characters per serialized config value in the report. */
export const TRUST_REPORT_MAX_VALUE_CHARS = 200;

/** Report key carrying the oversized-config note (survives diff filtering). */
const TRUST_REPORT_NOTE_KEY = 'trust-report-note';

const OVERSIZE_CONFIG_NOTE =
  `.orchid.json exceeds ${TRUST_REPORT_MAX_CONFIG_BYTES} bytes; ` +
  'its content is omitted from this report.';

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
  readonly size: number;
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

/** Keys that cannot appear in schema-valid report entries. */
function isUnreportableKey(key: string): boolean {
  return isUnsafeKey(key) || String(key).trim() === '';
}

/** JSON-serialize a config value for display, capped with an ellipsis. */
function serializeForReport(value: unknown): string {
  const text = JSON.stringify(value) ?? 'undefined';
  if (text.length <= TRUST_REPORT_MAX_VALUE_CHARS) return text;
  return `${text.slice(0, TRUST_REPORT_MAX_VALUE_CHARS)}…`;
}

/**
 * Tolerant raw project-layer read — missing or malformed content yields {}.
 * Oversized configs are skipped (with a report note) instead of being read.
 */
function readRawProjectLayer(canonicalDir: string): Record<string, unknown> {
  const configPath = path.join(canonicalDir, PROJECT_CONFIG_NAME);
  try {
    if (fs.statSync(configPath).size > TRUST_REPORT_MAX_CONFIG_BYTES) {
      return { [TRUST_REPORT_NOTE_KEY]: OVERSIZE_CONFIG_NOTE };
    }
  } catch {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
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
 * path, capped at TRUST_FINGERPRINT_MAX_FILES. The walk exits early once
 * MAX_FILES + 1 files are collected; the first overflowing file is returned
 * separately so the fingerprint can name it. Residual: files deeper past the
 * cap are never enumerated, so they are covered only indirectly — swapping
 * which file overflows changes the fingerprint, but edits to files the walk
 * never reached do not. Symlinked directories are followed with a realpath
 * cycle guard.
 */
function listDefinitionFiles(canonicalDir: string): {
  files: SurfaceFile[];
  overflow: SurfaceFile | null;
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
    if (files.length > TRUST_FINGERPRINT_MAX_FILES) break;
  }
  files.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  if (files.length <= TRUST_FINGERPRINT_MAX_FILES) return { files, overflow: null };
  return {
    files: files.slice(0, TRUST_FINGERPRINT_MAX_FILES),
    overflow: files[TRUST_FINGERPRINT_MAX_FILES],
  };
}

function walkDefinitionDir(
  absDir: string,
  relDir: string,
  out: SurfaceFile[],
  visitedDirs: Set<string>,
): void {
  if (out.length > TRUST_FINGERPRINT_MAX_FILES) return;

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
    if (out.length > TRUST_FINGERPRINT_MAX_FILES) return;
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
      out.push({ relPath: `${relDir}/${entry}`, absPath, size: stat.size });
    }
  }
}

/** Fingerprint marker naming the first file past the definition-file cap. */
function overflowMarker(overflow: SurfaceFile): string {
  return `overflow:${overflow.relPath}:${overflow.size}`;
}

/**
 * Content hash for one surface file. Files above the inline-read threshold
 * are hashed by streaming chunks; only files past the hard cap degrade to a
 * size marker.
 */
function fileFingerprintPart(absPath: string): string {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return 'missing';
  }
  if (!stat.isFile()) return 'not-a-file';
  if (stat.size > TRUST_FINGERPRINT_HARD_CAP_BYTES) {
    return `size=${stat.size}:truncated`;
  }
  if (stat.size <= TRUST_FINGERPRINT_MAX_FILE_BYTES) {
    try {
      return createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
    } catch {
      return 'unreadable';
    }
  }
  try {
    return hashFileStream(absPath);
  } catch {
    return 'unreadable';
  }
}

/** sha256 over a file read in fixed-size chunks (no full-buffer alloc). */
function hashFileStream(absPath: string): string {
  const hash = createHash('sha256');
  const fd = fs.openSync(absPath, 'r');
  try {
    const buffer = Buffer.alloc(FINGERPRINT_CHUNK_BYTES);
    let position = 0;
    for (;;) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/** Cheap size + mtime signature used to keep the caches fresh. */
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
    if (isUnreportableKey(name)) continue;
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
    if (isUnreportableKey(tool)) continue;
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
      projectValue: serializeForReport(project),
      homeValue: serializeForReport(baseline.agents_md),
    }];
  }

  const overrides: TrustReportConfigOverride[] = [];
  for (const key of Object.keys(project).sort()) {
    if (isUnreportableKey(key)) continue;
    const projectValue = project[key];
    if (projectValue === undefined) continue;
    const homeValue = baselineBlock[key];
    if (JSON.stringify(projectValue) === JSON.stringify(homeValue)) continue;
    overrides.push({
      key,
      projectValue: serializeForReport(projectValue),
      homeValue: homeValue === undefined ? 'unset' : serializeForReport(homeValue),
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
      if (isUnreportableKey(tier)) continue;
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
    if (isUnreportableKey(key) || SECTION_KEYS.has(key)) continue;
    const projectValue = raw[key];
    if (projectValue === undefined) continue;
    const homeValue = baselineRecord[key];
    overrides.push({
      key,
      projectValue: serializeForReport(projectValue),
      homeValue: homeValue === undefined ? 'unset' : serializeForReport(homeValue),
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
  private readonly stateCache = new Map<
    string,
    { state: TrustState; signature: string; at: number }
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
    this.invalidateCaches(canonical);
    const fingerprint = this.computeFingerprint(canonical);
    const next = new Map(this.loadRecords());
    next.set(canonical, { trustedAt: new Date().toISOString(), fingerprint });
    this.persist(next);
  }

  /** Remove a trust entry. Idempotent for unknown or invalid directories. */
  revoke(dir: string): void {
    const canonical = canonicalizeProjectDirectory(dir);
    if (canonical == null) return;
    this.invalidateCaches(canonical);

    const records = this.loadRecords();
    if (!records.has(canonical)) return;
    const next = new Map(records);
    next.delete(canonical);
    this.persist(next);
  }

  /**
   * Delete the store record keyed by the EXACT supplied path string without
   * canonicalizing — for revoking entries whose directory no longer exists.
   * Idempotent for unknown keys. No cache invalidation: caches are keyed by
   * canonical paths.
   */
  revokeRaw(dir: string): void {
    const records = this.loadRecords();
    if (!records.has(dir)) return;
    const next = new Map(records);
    next.delete(dir);
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

    return {
      projectDir: canonical,
      hasSurface: this.surfacePresent(canonical),
      mcpServers: diffMcpServers(raw, baseline),
      permissions: diffPermissions(raw),
      agentsMdOverrides: diffAgentsMd(raw, baseline),
      modelOverrides: diffModelOverrides(raw),
      otherConfigOverrides: diffOtherConfig(raw, baseline),
      definitions: this.projectDefinitions(canonical),
      instructionFiles: this.presentInstructionFiles(canonical),
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

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * Trust state for a canonical path, TTL-cached and validated by a cheap
   * surface signature (stat-only — never re-parses definitions), so repeated
   * workspace resolution does not re-walk or re-load the surface.
   */
  private stateForCanonical(canonical: string): TrustState {
    const signature = this.surfaceSignature(canonical);
    const now = Date.now();
    const cached = this.stateCache.get(canonical);
    if (
      cached != null &&
      cached.signature === signature &&
      now - cached.at < TRUST_FINGERPRINT_CACHE_TTL_MS
    ) {
      return cached.state;
    }

    let state: TrustState;
    if (!this.surfacePresent(canonical)) {
      state = 'trusted';
    } else {
      const record = this.loadRecords().get(canonical);
      if (record == null) {
        state = 'untrusted';
      } else {
        state =
          record.fingerprint === this.computeFingerprint(canonical, signature)
            ? 'trusted'
            : 'changed';
      }
    }
    this.stateCache.set(canonical, { state, signature, at: now });
    return state;
  }

  private invalidateCaches(canonical: string): void {
    this.fingerprintCache.delete(canonical);
    this.stateCache.delete(canonical);
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

  /**
   * Surface presence is file-based (config file, any definition-tree file,
   * root alias file) — the same file set the fingerprint covers — so state
   * resolution never runs the definition registries.
   */
  private surfacePresent(canonical: string): boolean {
    if (isFile(path.join(canonical, PROJECT_CONFIG_NAME))) return true;
    if (listDefinitionFiles(canonical).files.length > 0) return true;
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

  /**
   * Project-local definitions with home-shadow markers, capped for the
   * report. `homeDir: null` loads project definitions only — no probe path.
   */
  private projectDefinitions(canonical: string): TrustReportDefinition[] {
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
      homeDir: null,
      projectDir: path.join(canonical, '.orchid', 'agents'),
    });
    const projectSkills = readSkills({
      homeDir: null,
      projectDir: path.join(canonical, '.orchid', 'skills'),
    });
    const projectPersonalities = readPersonalities({
      homeDir: null,
      projectDir: canonical,
    });

    const definitions: TrustReportDefinition[] = [];
    for (const name of [...projectAgents.keys()].sort()) {
      if (name.trim() === '') continue;
      definitions.push({ kind: 'agent', name, overridesHome: homeAgents.has(name) });
    }
    for (const name of [...projectSkills.keys()].sort()) {
      if (name.trim() === '') continue;
      definitions.push({ kind: 'skill', name, overridesHome: homeSkills.has(name) });
    }
    for (const name of [...projectPersonalities.keys()].sort()) {
      if (name.trim() === '') continue;
      definitions.push({
        kind: 'personality',
        name,
        overridesHome: homePersonalities.has(name),
      });
    }
    return definitions.slice(0, TRUST_REPORT_MAX_DEFINITIONS);
  }

  private computeFingerprint(canonical: string, signature?: string): string {
    const now = Date.now();
    const sig = signature ?? this.surfaceSignature(canonical);
    const cached = this.fingerprintCache.get(canonical);
    if (
      cached != null &&
      cached.signature === sig &&
      now - cached.at < TRUST_FINGERPRINT_CACHE_TTL_MS
    ) {
      return cached.fingerprint;
    }

    const fingerprint = this.hashSurface(canonical);
    this.fingerprintCache.set(canonical, { fingerprint, signature: sig, at: now });
    return fingerprint;
  }

  private surfaceSignature(canonical: string): string {
    const parts = [
      fileSignaturePart('config', path.join(canonical, PROJECT_CONFIG_NAME)),
    ];
    const { files, overflow } = listDefinitionFiles(canonical);
    for (const file of files) {
      parts.push(fileSignaturePart(file.relPath, file.absPath));
    }
    if (overflow != null) parts.push(overflowMarker(overflow));
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
    const { files, overflow } = listDefinitionFiles(canonical);
    for (const file of files) {
      hash.update(`${file.relPath}:${fileFingerprintPart(file.absPath)}\n`);
    }
    if (overflow != null) hash.update(`${overflowMarker(overflow)}\n`);
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

/** Exact-string revocation (no canonicalization) for vanished directories. */
export function revokeProjectTrustRaw(dir: string): void {
  getProjectTrustStore().revokeRaw(dir);
}

export function buildProjectTrustReport(dir: string): ProjectTrustReport {
  return getProjectTrustStore().buildReport(dir);
}

export function listTrustedProjects(): TrustedProjectEntry[] {
  return getProjectTrustStore().list();
}

/** @internal — tests: replace the process store (no options → defaults). */
export function resetProjectTrustStore(options?: ProjectTrustStoreOptions): void {
  projectTrustStore = new ProjectTrustStore(options);
}
