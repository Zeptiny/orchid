/**
 * plan_symbol_rename tool — compute a verified, read-only cross-file rename.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { filePathIntent, type ToolDefinition, type ToolHandler, type ToolPathIntent } from '../types';
import { RiskClass } from '../../../shared/types/permission';
import { genericToolResultMetadata } from '../types';
import { genericBuiltInToolOutcome } from '../result';
import { indexProject } from '../../ast/indexer';
import { ASTStore, type SymbolRow } from '../../ast/store';
import { canonicalizeExistingPath, isPathContainedIn } from '../../project/path';
import { withDisposable } from '../../utils/with-disposable';

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const manifestFileSchema = z.object({
  path: z.string().min(1),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  replacements: z.number().int().positive(),
}).strict();

export const renameManifestSchema = z.object({
  version: z.literal(1),
  anchor: z.object({
    path: z.string().min(1),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  old_name: z.string().regex(IDENTIFIER_PATTERN),
  new_name: z.string().regex(IDENTIFIER_PATTERN),
  files: z.array(manifestFileSchema).min(1),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export type RenameManifest = z.infer<typeof renameManifestSchema>;

export const planSymbolRenameSchema = z.object({
  file_path: z.string().min(1).describe('Definition file containing the symbol to rename'),
  old_name: z.string().regex(IDENTIFIER_PATTERN).describe('The existing identifier'),
  new_name: z.string().regex(IDENTIFIER_PATTERN).describe('The replacement identifier'),
}).strict().refine(({ old_name, new_name }) => old_name !== new_name, {
  message: 'The replacement identifier must differ from the existing identifier.',
  path: ['new_name'],
});

export type PlanSymbolRenameInput = z.infer<typeof planSymbolRenameSchema>;

interface PlannedRenameFile {
  path: string;
  absPath: string;
  hash: string;
  replacements: number;
  nextContent: string;
}

export interface RenamePlan {
  manifest: RenameManifest;
  files: PlannedRenameFile[];
}

export const planSymbolRenameDefinition: ToolDefinition = {
  ...genericToolResultMetadata,
  name: 'plan_symbol_rename',
  description:
    'Preview a cross-file symbol rename without modifying files. The specified file must contain an indexed definition. ' +
    'Returns a manifest that rename_symbol must apply unchanged.',
  inputSchema: planSymbolRenameSchema,
  category: 'ast',
  riskClass: RiskClass.READ_ONLY,
  inputPathIntents: (input) => [filePathIntent((input as PlanSymbolRenameInput).file_path, 'read')],
  resultPathIntents: (result) => manifestResultPathIntents(result),
  noTimeout: true,
};

/** Return a SHA-256 digest for source content and manifest integrity. */
export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalWorkspacePath(
  canonicalWorkspace: string,
  candidate: string,
): { absolute: string; relative: string } | null {
  const absolute = canonicalizeExistingPath(candidate);
  if (absolute === null || absolute === canonicalWorkspace ||
      !isPathContainedIn(absolute, canonicalWorkspace)) return null;
  return {
    absolute,
    relative: path.relative(canonicalWorkspace, absolute).split(path.sep).join('/'),
  };
}

function sourcePath(workspace: string, relative: string): string {
  return path.resolve(workspace, ...relative.split('/'));
}

function manifestDigestInput(manifest: Omit<RenameManifest, 'digest'>): string {
  return JSON.stringify(manifest);
}

export function manifestDigest(manifest: Omit<RenameManifest, 'digest'>): string {
  return sha256(manifestDigestInput(manifest));
}

function validateManifestStructure(manifest: RenameManifest): string | null {
  if (manifest.old_name === manifest.new_name) return 'The replacement identifier must differ from the existing identifier.';
  const ordered = [...manifest.files].sort((left, right) => left.path.localeCompare(right.path));
  if (ordered.some((file, index) => file.path !== manifest.files[index]?.path)) {
    return 'Rename manifest file paths must be sorted deterministically.';
  }
  if (new Set(manifest.files.map((file) => file.path)).size !== manifest.files.length) {
    return 'Rename manifest contains duplicate file paths.';
  }
  const expected = manifestDigest({
    version: manifest.version,
    anchor: manifest.anchor,
    old_name: manifest.old_name,
    new_name: manifest.new_name,
    files: manifest.files,
  });
  return expected === manifest.digest ? null : 'Rename manifest integrity digest does not match its contents.';
}

async function refreshIndex(workspace: string): Promise<void> {
  await indexProject({
    projectPath: workspace,
    force: true,
    inline: process.env.VITEST !== undefined,
  });
}

function replaceIndexedLocations(content: string, symbols: SymbolRow[], oldName: string, newName: string): {
  nextContent: string;
  replacements: number;
} {
  const lines = content.split('\n');
  const sorted = [...symbols].sort((left, right) => {
    if (left.startLine !== right.startLine) return right.startLine - left.startLine;
    return right.startColumn - left.startColumn;
  });
  let replacements = 0;

  for (const symbol of sorted) {
    const line = lines[symbol.startLine];
    if (line === undefined) continue;
    const bytes = Buffer.from(line, 'utf8');
    if (symbol.startColumn > bytes.length) continue;
    const start = Buffer.from(bytes.subarray(0, symbol.startColumn)).toString('utf8').length;
    const end = start + oldName.length;
    if (line.slice(start, end) !== oldName) continue;
    if (start > 0 && /[A-Za-z0-9_]/.test(line[start - 1]!)) continue;
    if (end < line.length && /[A-Za-z0-9_]/.test(line[end]!)) continue;
    lines[symbol.startLine] = line.slice(0, start) + newName + line.slice(end);
    replacements += 1;
  }
  return { nextContent: lines.join('\n'), replacements };
}

/** Recompute the full rename plan from the current workspace index and files. */
export async function buildRenamePlan(
  workspace: string,
  input: PlanSymbolRenameInput,
): Promise<RenamePlan> {
  const canonicalWorkspace = canonicalizeExistingPath(workspace);
  if (canonicalWorkspace === null) {
    throw new Error(`Workspace was not found: ${workspace}`);
  }
  const requestedAnchor = path.resolve(workspace, input.file_path);
  const canonicalAnchor = canonicalWorkspacePath(canonicalWorkspace, requestedAnchor);
  if (!canonicalAnchor) {
    throw new Error(`Definition anchor file was not found inside the workspace: ${input.file_path}`);
  }
  const { absolute: anchorAbs, relative: anchorPath } = canonicalAnchor;
  await refreshIndex(workspace);
  const symbols = withDisposable(new ASTStore(workspace), (store) => store.getSymbolsByName(input.old_name, 'both'));
  const anchorHasDefinition = symbols.some((symbol) =>
    symbol.type === 'definition' &&
    canonicalWorkspacePath(canonicalWorkspace, sourcePath(workspace, symbol.filePath))?.relative === anchorPath);
  if (!anchorHasDefinition) {
    throw new Error(`Definition anchor '${anchorPath}' does not contain an indexed definition for '${input.old_name}'.`);
  }

  const byFile = new Map<string, SymbolRow[]>();
  for (const symbol of symbols) {
    const existing = byFile.get(symbol.filePath) ?? [];
    existing.push(symbol);
    byFile.set(symbol.filePath, existing);
  }
  const files: PlannedRenameFile[] = [];
  for (const [indexedPath, fileSymbols] of byFile) {
    const indexedAbsPath = sourcePath(workspace, indexedPath);
    const canonicalPath = canonicalWorkspacePath(canonicalWorkspace, indexedAbsPath);
    if (!canonicalPath) {
      throw new Error(`Indexed rename target is missing or outside the workspace: ${indexedPath}`);
    }
    const { absolute: absPath, relative } = canonicalPath;
    const content = fs.readFileSync(absPath, 'utf8');
    const replaced = replaceIndexedLocations(content, fileSymbols, input.old_name, input.new_name);
    if (replaced.replacements === 0) continue;
    files.push({
      path: relative,
      absPath,
      hash: sha256(content),
      replacements: replaced.replacements,
      nextContent: replaced.nextContent,
    });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  if (files.length === 0) {
    throw new Error(`No current rename locations found for '${input.old_name}'.`);
  }
  const anchorHash = files.find((file) => file.path === anchorPath)?.hash ??
    sha256(fs.readFileSync(anchorAbs, 'utf8'));
  const manifestWithoutDigest: Omit<RenameManifest, 'digest'> = {
    version: 1,
    anchor: { path: anchorPath, hash: anchorHash },
    old_name: input.old_name,
    new_name: input.new_name,
    files: files.map(({ path: filePath, hash, replacements }) => ({ path: filePath, hash, replacements })),
  };
  return {
    files,
    manifest: { ...manifestWithoutDigest, digest: manifestDigest(manifestWithoutDigest) },
  };
}

/** Extract preview targets from a canonical generic tool result. */
export function manifestResultPathIntents(result: unknown): readonly ToolPathIntent[] {
  const canonical = result as { data?: { value?: unknown } };
  const parsed = z.object({ manifest: renameManifestSchema }).safeParse(canonical.data?.value);
  return parsed.success
    ? parsed.data.manifest.files.map((file) => filePathIntent(file.path, 'read'))
    : [];
}

/** Validate a manifest before it reaches the write tool. */
export function validateRenameManifest(manifest: RenameManifest): string | null {
  return validateManifestStructure(manifest);
}

export const planSymbolRenameHandler: ToolHandler = async (input: unknown, ctx) => {
  const parsed = planSymbolRenameSchema.safeParse(input);
  if (!parsed.success) {
    return genericBuiltInToolOutcome('plan_symbol_rename', { error: parsed.error.issues[0]?.message ?? 'Invalid rename preview input.' }, 'error', 'invalid_rename_input');
  }
  try {
    const plan = await buildRenamePlan(ctx.cwd, parsed.data);
    return genericBuiltInToolOutcome('plan_symbol_rename', {
      manifest: plan.manifest,
      files: plan.manifest.files.length,
      replacements: plan.manifest.files.reduce((total, file) => total + file.replacements, 0),
    }, 'complete');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return genericBuiltInToolOutcome('plan_symbol_rename', { error: message }, 'error', 'rename_plan_failed', message);
  }
};
