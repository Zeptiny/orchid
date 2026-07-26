/**
 * Per-turn hierarchical project-instruction discovery.
 *
 * This module deliberately owns no session, worker, permission, or LLM state.
 * A caller creates one context from the workspace and its frozen config, then
 * uses its structured batches at the model/dispatch boundaries.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Config } from '../../shared/types/ipc-boundary';
import { escapeXmlAttribute, escapeXmlText } from '../tools/result';
import {
  canonicalizeEffectivePath,
  canonicalizeExistingPath,
  isPathContainedIn,
} from './path';

const PRIMARY_FILENAMES = ['AGENTS.override.md', 'AGENTS.md'] as const;
const OVER_BUDGET_DIAGNOSTIC_RESERVE_BYTES = 512;

export type ProjectInstructionDiagnosticCode =
  | 'shadowed'
  | 'unreadable'
  | 'missing-shim-target'
  | 'invalid-import'
  | 'escaped-workspace'
  | 'import-cycle'
  | 'import-depth-exceeded'
  | 'over-budget'
  | 'outside-workspace';

export interface ProjectInstructionDiagnostic {
  readonly code: ProjectInstructionDiagnosticCode;
  readonly scope: string;
  readonly path?: string;
  readonly detail: string;
  readonly blocksMutation: boolean;
}

export interface ProjectInstructionSource {
  /** Canonical path of the selected file (or canonical terminal shim target). */
  readonly path: string;
  /** Canonical directory whose hierarchy made this rule applicable. */
  readonly scope: string;
  /** Content normalized only for BOM/line endings. */
  readonly body: string;
  readonly hash: string;
  readonly selection: string;
  readonly kind: 'body-or-reference' | 'reference';
}

export interface ProjectInstructionAuditEvent {
  readonly type: 'selected' | 'shadowed' | 'diagnostic';
  /** Canonical selector identity; for shims this is the shim itself. */
  readonly path?: string;
  /** Canonical terminal shim target when it differs from `path`. */
  readonly terminalPath?: string;
  readonly scope: string;
  readonly selection?: string;
  readonly diagnosticCode?: ProjectInstructionDiagnosticCode;
}

export interface ProjectInstructionDiscovery {
  readonly id: string;
  readonly sources: readonly ProjectInstructionSource[];
  readonly diagnostics: readonly ProjectInstructionDiagnostic[];
  readonly auditEvents: readonly ProjectInstructionAuditEvent[];
  readonly envelope: string;
}

export interface ProjectInstructionDelivery {
  readonly envelope: string;
  readonly sources: readonly ProjectInstructionSource[];
  readonly diagnostics: readonly ProjectInstructionDiagnostic[];
}

export type MutationInstructionStatus = 'ready' | 'pending' | 'blocked';

export interface MutationInstructionPreflight {
  readonly status: MutationInstructionStatus;
  readonly discovery: ProjectInstructionDiscovery;
}

interface ScannedSelection {
  readonly scope: string;
  readonly selection: string;
  readonly sourcePath?: string;
  readonly selectorPath?: string;
  readonly body?: string;
  readonly diagnostics: readonly ProjectInstructionDiagnostic[];
  readonly auditEvents: readonly ProjectInstructionAuditEvent[];
}

interface BodyRecord {
  readonly hash: string;
  readonly body: string;
  readonly scopes: string[];
  emitted: boolean;
}

interface DeliveryRecord {
  readonly discovery: ProjectInstructionDiscovery;
  emitted: boolean;
  projectedStep?: number;
  output?: ProjectInstructionDelivery;
}

function normalizeBody(body: string): string {
  const withoutBom = body.startsWith('\uFEFF') ? body.slice(1) : body;
  return withoutBom.replace(/\r\n?/g, '\n');
}

function sha256(body: string): string {
  return crypto.createHash('sha256').update(body, 'utf8').digest('hex');
}

function isScopeAncestor(ancestor: string, candidate: string): boolean {
  return candidate === ancestor || candidate.startsWith(ancestor + path.sep);
}

function diagnostic(
  code: ProjectInstructionDiagnosticCode,
  scope: string,
  detail: string,
  sourcePath?: string,
  blocksMutation = true,
): ProjectInstructionDiagnostic {
  return { code, scope, path: sourcePath, detail, blocksMutation };
}

function renderDiagnostic(item: ProjectInstructionDiagnostic): string {
  return '<project_instruction_diagnostic code="' + escapeXmlAttribute(item.code) +
    '" scope="' + escapeXmlAttribute(item.scope) + '"' +
    (item.path ? ' path="' + escapeXmlAttribute(item.path) + '"' : '') + '>' +
    escapeXmlText(item.detail) + '</project_instruction_diagnostic>';
}

function renderSource(source: ProjectInstructionSource, includeBody: boolean): string {
  const attrs = ' path="' + escapeXmlAttribute(source.path) + '" scope="' +
    escapeXmlAttribute(source.scope) + '" hash="' + escapeXmlAttribute(source.hash) + '"';
  if (!includeBody) return '<project_instruction_ref' + attrs + ' />';
  return '<project_instruction' + attrs + '>' + escapeXmlText(source.body) + '</project_instruction>';
}

function renderEnvelope(
  sources: readonly ProjectInstructionSource[],
  diagnostics: readonly ProjectInstructionDiagnostic[],
  includeBodies = true,
): string {
  const parts = [
    ...sources.map((source) => renderSource(source, includeBodies && source.kind !== 'reference')),
    ...diagnostics.map(renderDiagnostic),
  ];
  return parts.length === 0 ? '' : '<project_instructions>\n' + parts.join('\n') + '\n</project_instructions>';
}

/**
 * Holds one immutable filesystem snapshot and the acknowledgement state for a
 * single main-agent or subagent stream.
 */
export class ProjectInstructionContext {
  readonly workspace: string;
  readonly config: Pick<Config,
    'project_instruction_fallback_filenames' |
    'project_instruction_max_bytes' |
    'project_instruction_max_import_depth'>;

  private readonly filenames: readonly string[];
  private readonly filenameKeys: ReadonlySet<string>;
  private readonly scans = new Map<string, Promise<ScannedSelection>>();
  private readonly bodies = new Map<string, BodyRecord>();
  private readonly diagnosticIds = new Set<string>();
  private readonly blocked = new Map<string, ProjectInstructionDiagnostic[]>();
  private readonly pending = new Set<string>();
  private readonly acknowledged = new Set<string>();
  private readonly deliveries = new Map<string, DeliveryRecord>();
  private readonly audit: ProjectInstructionAuditEvent[] = [];
  private readonly chargedSourceScopes = new Set<string>();
  private readonly chargedBodyHashes = new Set<string>();
  private root?: ProjectInstructionDiscovery;
  private rootPromise?: Promise<ProjectInstructionDiscovery>;
  private rootAcknowledged = false;
  private step = 0;
  private sequence = 0;
  private readonly budgetEntries: string[] = [];

  constructor(workspace: string, config: ProjectInstructionContext['config']) {
    const canonicalWorkspace = canonicalizeExistingPath(workspace);
    if (canonicalWorkspace === null || !fs.statSync(canonicalWorkspace).isDirectory()) {
      throw new Error('ProjectInstructionContext requires an existing workspace directory');
    }
    this.workspace = canonicalWorkspace;
    this.config = Object.freeze({
      project_instruction_fallback_filenames: Object.freeze([...config.project_instruction_fallback_filenames]) as unknown as string[],
      project_instruction_max_bytes: config.project_instruction_max_bytes,
      project_instruction_max_import_depth: config.project_instruction_max_import_depth,
    });
    this.filenames = Object.freeze([...PRIMARY_FILENAMES, ...this.config.project_instruction_fallback_filenames]);
    this.filenameKeys = new Set(this.filenames.map((name) => name.toLocaleLowerCase('en-US')));
  }

  /** Begin an SDK step and acknowledge only deliveries that reached the provider in a prior step. */
  beginStep(step: number): void {
    if (step < this.step) throw new Error('Instruction steps cannot move backwards');
    for (const delivery of this.deliveries.values()) {
      if (delivery.emitted && delivery.projectedStep !== undefined && delivery.projectedStep < step) {
        for (const source of delivery.discovery.sources) this.acknowledged.add(this.sourceKey(source));
      }
    }
    this.step = step;
  }

  /** Discover and prepare workspace-root instructions for the initial model input. */
  async prepareRoot(): Promise<ProjectInstructionDiscovery> {
    if (this.root) return this.root;
    if (!this.rootPromise) {
      this.rootPromise = this.discoverDirectories([this.workspace], true).then((discovery) => {
        this.root = discovery;
        return discovery;
      });
    }
    return this.rootPromise;
  }

  /** Mark a valid root delivery as visible at step zero. */
  acknowledgeRoot(): void {
    if (!this.root) throw new Error('prepareRoot must run before acknowledgeRoot');
    this.rootAcknowledged = true;
    for (const source of this.root.sources) this.acknowledged.add(this.sourceKey(source));
  }

  /** Discover instructions for effective target paths, from workspace root to target directory. */
  async discover(targets: readonly string[]): Promise<ProjectInstructionDiscovery> {
    const directories = this.targetDirectories(targets);
    return this.discoverDirectories(directories, false);
  }

  /**
   * Find rules and determine whether mutations may proceed. Any newly loaded
   * or same-step-undelivered scope defers all targeted mutation atomically.
   */
  async preflightMutation(targets: readonly string[]): Promise<MutationInstructionPreflight> {
    const discovery = await this.discover(targets);
    const directories = this.targetDirectories(targets);
    const status = directories.some((target) => this.hasBlockedScope(target))
      ? 'blocked'
      : directories.some((target) => this.hasPendingScope(target)) ? 'pending' : 'ready';
    return { status, discovery };
  }

  /** Attach a discovery to one tool call. Re-registering the call is idempotent. */
  registerToolDelivery(toolCallId: string, discovery: ProjectInstructionDiscovery): void {
    if (!this.deliveries.has(toolCallId)) this.deliveries.set(toolCallId, { discovery, emitted: false });
  }

  /**
   * Return provider-only output for a registered call. The first provider
   * ordered claim owns each body; later scopes refer to it. Repeated claims
   * for a call return exactly the same payload.
   */
  claimProviderDelivery(toolCallId: string): ProjectInstructionDelivery {
    const delivery = this.deliveries.get(toolCallId);
    if (!delivery) throw new Error('No instruction delivery registered for tool call ' + toolCallId);
    if (delivery.output) return delivery.output;
    const sources = delivery.discovery.sources.map((source) => {
      const body = this.bodies.get(source.hash);
      if (!body) return source;
      if (!body.emitted && source.kind !== 'reference') {
        body.emitted = true;
        return source;
      }
      return { ...source, kind: 'reference' as const };
    });
    const output = {
      sources,
      diagnostics: delivery.discovery.diagnostics,
      envelope: renderEnvelope(sources, delivery.discovery.diagnostics),
    };
    delivery.emitted = true;
    delivery.projectedStep = this.step;
    delivery.output = output;
    return output;
  }

  /** Stable metadata for the app-managed instruction-read audit seam. */
  auditEvents(): readonly ProjectInstructionAuditEvent[] {
    return [...this.audit];
  }

  /** Canonical directory scan keys, useful for deterministic focused tests. */
  scannedDirectories(): readonly string[] {
    return [...this.scans.keys()].sort();
  }

  get isRootAcknowledged(): boolean {
    return this.rootAcknowledged;
  }

  private async discoverDirectories(
    requestedDirectories: readonly string[],
    rootOnly: boolean,
  ): Promise<ProjectInstructionDiscovery> {
    const directories = [...new Set(requestedDirectories)].sort((left, right) => {
      const depth = left.split(path.sep).length - right.split(path.sep).length;
      return depth || left.localeCompare(right);
    });
    const selected: ProjectInstructionSource[] = [];
    const diagnostics: ProjectInstructionDiagnostic[] = [];
    const auditEvents: ProjectInstructionAuditEvent[] = [];
    for (const directory of directories) {
      const chain = rootOnly ? [this.workspace] : this.ancestorChain(directory);
      for (const candidate of chain) {
        const scanned = await this.scanDirectory(candidate);
        const newDiagnostics = this.newDiagnostics(scanned.diagnostics);
        diagnostics.push(...newDiagnostics);
        auditEvents.push(...scanned.auditEvents);
        this.recordDiagnostics(newDiagnostics);
        const accepted = scanned.sourcePath && scanned.body !== undefined
          ? this.acceptSource(scanned)
          : undefined;
        if (accepted?.source) selected.push(accepted.source);
        if (accepted?.diagnostic) {
          diagnostics.push(accepted.diagnostic);
          auditEvents.push(this.auditDiagnostic(accepted.diagnostic));
        }
      }
    }
    return this.createDiscovery(selected, diagnostics, auditEvents);
  }

  private targetDirectories(targets: readonly string[]): string[] {
    const directories = new Set<string>();
    for (const target of targets) {
      const effective = canonicalizeEffectivePath(target);
      if (effective === null || !isPathContainedIn(effective, this.workspace)) continue;
      let directory = effective;
      try {
        if (!fs.statSync(effective).isDirectory()) directory = path.dirname(effective);
      } catch {
        directory = path.dirname(effective);
      }
      if (isPathContainedIn(directory, this.workspace)) directories.add(directory);
    }
    return [...directories];
  }

  private ancestorChain(targetDirectory: string): string[] {
    const result: string[] = [];
    let current = targetDirectory;
    while (isPathContainedIn(current, this.workspace)) {
      result.push(current);
      if (current === this.workspace) break;
      current = path.dirname(current);
    }
    return result.reverse();
  }

  private scanDirectory(directory: string): Promise<ScannedSelection> {
    const cached = this.scans.get(directory);
    if (cached) return cached;
    const pending = Promise.resolve()
      .then(() => this.readDirectorySnapshot(directory))
      .then((selection) => {
        this.audit.push(...selection.auditEvents);
        return selection;
      });
    this.scans.set(directory, pending);
    return pending;
  }

  private readDirectorySnapshot(scope: string): ScannedSelection {
    const existing = this.filenames.filter((filename) => this.candidateExists(path.join(scope, filename)));
    if (existing.length === 0) return { scope, selection: '', diagnostics: [], auditEvents: [] };
    const selection = existing[0];
    const selectedPath = path.join(scope, selection);
    const diagnostics = existing.slice(1).map((filename) => diagnostic(
      'shadowed', scope, filename + ' is shadowed by ' + selection, path.join(scope, filename), false,
    ));
    const auditEvents: ProjectInstructionAuditEvent[] = [
      ...diagnostics.map((entry) => ({
        type: 'shadowed' as const, path: entry.path, scope, diagnosticCode: entry.code,
      })),
    ];
    const canonical = canonicalizeExistingPath(selectedPath);
    if (canonical === null) {
      const item = diagnostic('unreadable', scope, 'Selected instruction file is unreadable', selectedPath);
      return { scope, selection, diagnostics: [...diagnostics, item], auditEvents: [...auditEvents, this.auditDiagnostic(item)] };
    }
    if (!isPathContainedIn(canonical, this.workspace)) {
      const item = diagnostic('escaped-workspace', scope, 'Selected instruction file resolves outside workspace', canonical);
      return { scope, selection, diagnostics: [...diagnostics, item], auditEvents: [...auditEvents, this.auditDiagnostic(item)] };
    }
    const expanded = this.expandShim(canonical, scope, 0, new Set([canonical]));
    if (expanded.diagnostic) {
      return {
        scope,
        selection,
        diagnostics: [...diagnostics, expanded.diagnostic],
        auditEvents: [...auditEvents, this.auditDiagnostic(expanded.diagnostic)],
      };
    }
    const sourcePath = expanded.path!;
    const body = expanded.body!;
    const selected = {
      type: 'selected' as const,
      path: canonical,
      terminalPath: sourcePath === canonical ? undefined : sourcePath,
      scope,
      selection,
    };
    return {
      scope,
      selection,
      sourcePath,
      selectorPath: canonical,
      body,
      diagnostics,
      auditEvents: [...auditEvents, selected],
    };
  }

  private candidateExists(candidate: string): boolean {
    try {
      fs.lstatSync(candidate);
      return true;
    } catch {
      return false;
    }
  }

  private expandShim(
    sourcePath: string,
    scope: string,
    depth: number,
    graph: Set<string>,
  ): { path?: string; body?: string; diagnostic?: ProjectInstructionDiagnostic } {
    let raw: string;
    try {
      raw = fs.readFileSync(sourcePath, 'utf8');
    } catch {
      return { diagnostic: diagnostic('unreadable', scope, 'Instruction file is unreadable', sourcePath) };
    }
    const body = normalizeBody(raw);
    const match = body.trim().match(/^@([^\s]+)$/);
    if (!match) return { path: sourcePath, body };
    const relative = match[1];
    const basename = path.basename(relative).toLocaleLowerCase('en-US');
    if (path.isAbsolute(relative) || !this.filenameKeys.has(basename)) {
      return { diagnostic: diagnostic('invalid-import', scope, 'Shim target must be an allowlisted relative instruction filename', sourcePath) };
    }
    if (depth >= this.config.project_instruction_max_import_depth) {
      return { diagnostic: diagnostic('import-depth-exceeded', scope, 'Shim import depth exceeds configured maximum', sourcePath) };
    }
    const target = path.resolve(path.dirname(sourcePath), relative);
    const canonical = canonicalizeExistingPath(target);
    if (canonical === null) {
      return { diagnostic: diagnostic('missing-shim-target', scope, 'Shim target is missing or unreadable', target) };
    }
    if (!isPathContainedIn(canonical, this.workspace)) {
      return { diagnostic: diagnostic('escaped-workspace', scope, 'Shim target resolves outside workspace', canonical) };
    }
    if (graph.has(canonical)) {
      return { diagnostic: diagnostic('import-cycle', scope, 'Shim import graph contains a cycle', canonical) };
    }
    const nextGraph = new Set(graph);
    nextGraph.add(canonical);
    return this.expandShim(canonical, scope, depth + 1, nextGraph);
  }

  private acceptSource(scanned: ScannedSelection): {
    source?: ProjectInstructionSource;
    diagnostic?: ProjectInstructionDiagnostic;
  } | undefined {
    const body = scanned.body!;
    const sourcePath = scanned.sourcePath!;
    const hash = sha256(body);
    const sourceKey = sourcePath + '\u0000' + scanned.scope;
    if (this.acknowledged.has(sourceKey)) return undefined;
    const existing = this.bodies.get(hash);
    if (existing && existing.scopes.some(
      (scope) => scope !== scanned.scope && isScopeAncestor(scope, scanned.scope),
    )) return undefined;
    const source: ProjectInstructionSource = {
      path: sourcePath,
      scope: scanned.scope,
      body,
      hash,
      selection: scanned.selection,
      kind: 'body-or-reference',
    };
    const budgetSource: ProjectInstructionSource = this.chargedBodyHashes.has(hash)
      ? { ...source, kind: 'reference' }
      : source;
    if (!this.chargedSourceScopes.has(sourceKey) && !this.reserve(budgetSource, [])) {
      const item = diagnostic('over-budget', scanned.scope, 'Instruction envelope exceeds configured byte budget', sourcePath);
      const [newItem] = this.newDiagnostics([item]);
      if (newItem) {
        this.recordDiagnostics([newItem]);
        this.audit.push(this.auditDiagnostic(newItem));
        return { diagnostic: newItem };
      }
      return undefined;
    }
    if (!this.chargedSourceScopes.has(sourceKey)) {
      this.chargedSourceScopes.add(sourceKey);
      this.chargedBodyHashes.add(hash);
    }
    if (existing) {
      if (!existing.scopes.includes(scanned.scope)) existing.scopes.push(scanned.scope);
    } else {
      this.bodies.set(hash, { hash, body, scopes: [scanned.scope], emitted: false });
    }
    this.pending.add(this.sourceKey(source));
    return { source };
  }

  private createDiscovery(
    sources: readonly ProjectInstructionSource[],
    diagnostics: readonly ProjectInstructionDiagnostic[],
    auditEvents: readonly ProjectInstructionAuditEvent[],
  ): ProjectInstructionDiscovery {
    const acceptedDiagnostics: ProjectInstructionDiagnostic[] = [];
    for (const item of diagnostics) {
      if (this.reserve([], [item])) acceptedDiagnostics.push(item);
    }
    const discovery: ProjectInstructionDiscovery = {
      id: 'instruction-batch-' + (++this.sequence),
      sources,
      diagnostics: acceptedDiagnostics,
      auditEvents,
      envelope: renderEnvelope(sources, acceptedDiagnostics),
    };
    return discovery;
  }

  private reserve(sources: readonly ProjectInstructionSource[] | ProjectInstructionSource, diagnostics: readonly ProjectInstructionDiagnostic[]): boolean {
    const sourceList = Array.isArray(sources) ? sources : [sources];
    const entries = [
      ...sourceList.map((source) => renderSource(source, source.kind !== 'reference')),
      ...diagnostics.map(renderDiagnostic),
    ];
    const allEntries = [...this.budgetEntries, ...entries];
    const envelope = allEntries.length === 0
      ? ''
      : '<project_instructions>\n' + allEntries.join('\n') + '\n</project_instructions>';
    const requiredBytes = Buffer.byteLength(envelope, 'utf8') +
      (sourceList.length > 0 ? OVER_BUDGET_DIAGNOSTIC_RESERVE_BYTES : 0);
    if (requiredBytes > this.config.project_instruction_max_bytes) return false;
    this.budgetEntries.push(...entries);
    return true;
  }

  private recordDiagnostics(items: readonly ProjectInstructionDiagnostic[]): void {
    for (const item of items) {
      if (item.blocksMutation) {
        const existing = this.blocked.get(item.scope) ?? [];
        if (!existing.some((prior) => prior.code === item.code && prior.path === item.path)) {
          existing.push(item);
          this.blocked.set(item.scope, existing);
        }
      }
    }
  }

  private newDiagnostics(items: readonly ProjectInstructionDiagnostic[]): ProjectInstructionDiagnostic[] {
    return items.filter((item) => {
      const key = item.code + '\u0000' + item.scope + '\u0000' + (item.path ?? '') + '\u0000' + item.detail;
      if (this.diagnosticIds.has(key)) return false;
      this.diagnosticIds.add(key);
      return true;
    });
  }

  private auditDiagnostic(item: ProjectInstructionDiagnostic): ProjectInstructionAuditEvent {
    return { type: 'diagnostic', path: item.path, scope: item.scope, diagnosticCode: item.code };
  }

  private hasBlockedScope(target: string): boolean {
    return [...this.blocked.keys()].some((scope) => isScopeAncestor(scope, target));
  }

  private hasPendingScope(target: string): boolean {
    for (const key of this.pending) {
      if (!this.acknowledged.has(key)) {
        const [, scope] = key.split('\u0000');
        if (scope && isScopeAncestor(scope, target)) return true;
      }
    }
    return false;
  }

  private sourceKey(source: ProjectInstructionSource): string {
    return source.path + '\u0000' + source.scope;
  }
}

/** Create a per-stream instruction context from an existing canonical workspace and frozen config. */
export function createProjectInstructionContext(
  workspace: string,
  config: Pick<Config,
    'project_instruction_fallback_filenames' |
    'project_instruction_max_bytes' |
    'project_instruction_max_import_depth'>,
): ProjectInstructionContext {
  return new ProjectInstructionContext(workspace, config);
}
