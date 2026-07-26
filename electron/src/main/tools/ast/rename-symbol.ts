/** Apply a previously-previewed cross-file symbol rename manifest. */
import { z } from 'zod';
import { filePathIntent, type ToolDefinition, type ToolHandler } from '../types';
import { RiskClass } from '../../../shared/types/permission';
import { genericToolResultMetadata } from '../types';
import { genericBuiltInToolOutcome } from '../result';
import {
  buildRenamePlan,
  renameManifestSchema,
  validateRenameManifest,
  type RenameManifest,
} from './plan-symbol-rename';
import { atomicWrite } from './utils';

export const renameSymbolSchema = z.object({
  manifest: renameManifestSchema,
}).strict();

export type RenameSymbolInput = z.infer<typeof renameSymbolSchema>;

export const renameSymbolDefinition: ToolDefinition = {
  ...genericToolResultMetadata,
  name: 'rename_symbol',
  description:
    'Apply an unchanged manifest returned by plan_symbol_rename. Revalidates the current workspace before writing any file.',
  inputSchema: renameSymbolSchema,
  category: 'ast',
  riskClass: RiskClass.MUTATION,
  inputPathIntents: (input) => (input as RenameSymbolInput).manifest.files
    .map((file) => filePathIntent(file.path, 'mutation')),
  noTimeout: true,
};

function manifestsMatch(left: RenameManifest, right: RenameManifest): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export const renameSymbolHandler: ToolHandler = async (input: unknown, ctx) => {
  const parsed = renameSymbolSchema.safeParse(input);
  if (!parsed.success) {
    return genericBuiltInToolOutcome('rename_symbol', { error: parsed.error.issues[0]?.message ?? 'Invalid rename manifest.' }, 'error', 'invalid_rename_manifest');
  }
  const manifest = parsed.data.manifest;
  const integrityError = validateRenameManifest(manifest);
  if (integrityError) {
    return genericBuiltInToolOutcome('rename_symbol', { error: integrityError }, 'error', 'invalid_rename_manifest', integrityError);
  }

  let recomputed;
  try {
    recomputed = await buildRenamePlan(ctx.cwd, {
      file_path: manifest.anchor.path,
      old_name: manifest.old_name,
      new_name: manifest.new_name,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return genericBuiltInToolOutcome('rename_symbol', { error: message }, 'error', 'stale_rename_manifest', message);
  }
  if (!manifestsMatch(manifest, recomputed.manifest)) {
    return genericBuiltInToolOutcome(
      'rename_symbol',
      { error: 'Rename manifest no longer matches the current workspace. Re-run plan_symbol_rename before applying.' },
      'error',
      'stale_rename_manifest',
      'Rename manifest no longer matches the current workspace. Re-run plan_symbol_rename before applying.',
    );
  }

  const failed: Array<{ path: string; error: string }> = [];
  const edits: Array<{ path: string; replacements: number }> = [];
  for (const file of recomputed.files) {
    try {
      atomicWrite(file.absPath, file.nextContent);
      edits.push({ path: file.path, replacements: file.replacements });
    } catch (error) {
      failed.push({ path: file.path, error: error instanceof Error ? error.message : String(error) });
      break;
    }
  }
  if (failed.length > 0) {
    return genericBuiltInToolOutcome('rename_symbol', {
      oldName: manifest.old_name,
      newName: manifest.new_name,
      files: edits.length,
      success: false,
      edits,
      partialWrite: true,
      failed,
    }, 'error', 'partial_rename_write', `Rename partially wrote ${edits.length} file(s) before an I/O failure.`);
  }
  return genericBuiltInToolOutcome('rename_symbol', {
    oldName: manifest.old_name,
    newName: manifest.new_name,
    files: edits.length,
    success: true,
    edits,
  }, 'complete');
};
