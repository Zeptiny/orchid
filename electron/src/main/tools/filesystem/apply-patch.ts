/**
 * apply_patch tool — multi-file patch application in the *** Begin Patch format.
 *
 * Each file operation is applied independently; a failure in one file does not
 * prevent others from being applied.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import type { ToolDefinition, ToolHandler, ToolHandlerOutcome } from '../types';
import { RiskClass } from '../../../shared/types/permission';
import { resolveToolPath } from '../types';
import {
  renderXmlToolResult,
  escapeXmlText,
  escapeXmlAttribute,
  projectionWithCanonicalCompleteness,
} from '../result';
import type { AgentProjector } from '../../../shared/types/tool-result';
import { atomicWrite } from '../ast/utils';
import { buildStructuredFileChange } from './structured-diff';
import { parsePatch, ParseError } from './apply-patch-parser';
import { applyChunksToContent, ApplyPatchApplyError } from './apply-patch-apply';
import {
  fileChangeDataSchema,
} from '../../../shared/types/tool-result-filesystem';
import {
  applyPatchResultDataSchema,
  type ApplyPatchFileResult,
  type ApplyPatchResultData,
} from '../../../shared/types/tool-result-apply-patch';

// ── Schema ─────────────────────────────────────────────────────────────────

export const applyPatchInputSchema = z.object({
  patch: z.string().describe(
    'The full patch text in the *** Begin Patch / *** End Patch envelope format. ' +
    'Each file operation starts with a header: ' +
    '*** Add File: <path> (create), *** Update File: <path> (modify, optionally with *** Move to: <new path> to rename), ' +
    'or *** Delete File: <path> (remove). ' +
    'Within an update, each hunk starts with @@ (optionally followed by a class/function name for disambiguation). ' +
    'Hunk lines use " " (context), "-" (remove), "+" (add) prefixes. ' +
    'File paths must be relative, NEVER absolute. ' +
    'A hunk with only "+" lines and no context appends to the end of the file. ' +
    '*** End of File after a hunk anchors the match to the file\'s last line — the patch fails if the pattern is not at EOF. ' +
    'Control characters (null, bell, escape) cannot be embedded in patch content.',
  ),
});

export type ApplyPatchInput = z.infer<typeof applyPatchInputSchema>;

// ── Agent projector ─────────────────────────────────────────────────────────

const applyPatchAgentProjector: AgentProjector = (canonical, toolName = 'apply_patch') => {
  const parsed = applyPatchResultDataSchema.parse(canonical.data);
  const { files, added, modified, deleted, failed } = parsed;

  const summaryParts: string[] = [];
  if (added > 0) summaryParts.push(`${added} added`);
  if (modified > 0) summaryParts.push(`${modified} modified`);
  if (deleted > 0) summaryParts.push(`${deleted} deleted`);
  if (failed > 0) summaryParts.push(`${failed} failed`);
  // F11: count unique file paths so multi-operation patches on the same file
  // don't inflate the file count in the summary.
  const uniquePaths = new Set(files.map((f) => f.path));
  const summary = `${uniquePaths.size} file${uniquePaths.size === 1 ? '' : 's'}: ${summaryParts.join(', ')}`;

  const fileSections = files.map((file) => {
    const attrs: Record<string, string | number | undefined> = {
      path: file.path,
      operation: file.operation,
      status: file.status,
    };
    if (file.movePath) attrs.move_path = file.movePath;

    const attrString = Object.entries(attrs)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => ` ${k}="${escapeXmlAttribute(v)}"`)
      .join('');

    if (file.status === 'error' && file.error) {
      return `<file${attrString}>\n<error code="${escapeXmlAttribute(file.error.code)}">${escapeXmlText(file.error.message)}</error>\n</file>`;
    }

    return `<file${attrString} />`;
  });

  const body = [summary, ...fileSections].join('\n');

  return projectionWithCanonicalCompleteness(
    canonical,
    renderXmlToolResult(toolName, canonical, body, {
      files: files.length,
      added,
      modified,
      deleted,
      ...(failed > 0 ? { failed } : {}),
    }, undefined, true),
  );
};

// ── Tool definition ────────────────────────────────────────────────────────

export const applyPatchDefinition: ToolDefinition = {
  name: 'apply_patch',
  description:
    'Apply a multi-file patch using the *** Begin Patch envelope format. ' +
    'Each file is applied independently — a failure in one file does not prevent others from being applied.\n\n' +
    'Format:\n' +
    '*** Begin Patch\n' +
    '[ one or more file operations ]\n' +
    '*** End Patch\n\n' +
    'Each operation starts with one of three headers:\n' +
    '*** Add File: <path> — create a new file. Every following line is a + line (the initial contents).\n' +
    '*** Delete File: <path> — remove an existing file. Nothing follows.\n' +
    '*** Update File: <path> — patch an existing file in place. May be immediately followed by ' +
    '*** Move to: <new path> to rename the file. Then one or more hunks, each introduced by @@ ' +
    '(optionally followed by a class or function name to disambiguate repeated code).\n\n' +
    'Within a hunk each line starts with:\n' +
    '  " " (space) — context line (unchanged)\n' +
    '  "-" — line to remove\n' +
    '  "+" — line to add\n\n' +
    'Context guidelines:\n' +
    '- Show 3 lines of code immediately above and below each change. ' +
    'If a change is within 3 lines of a previous change, do NOT duplicate context lines.\n' +
    '- If 3 lines of context cannot uniquely identify the code, use @@ with the enclosing class or function name:\n' +
    '  @@ class BaseClass\n' +
    '  [3 lines pre-context]\n' +
    '  - [old_code]\n' +
    '  + [new_code]\n' +
    '  [3 lines post-context]\n' +
    '- For deeply repeated code, stack multiple @@ lines:\n' +
    '  @@ class BaseClass\n' +
    '  @@ def method():\n' +
    '  [3 lines pre-context]\n' +
    '  - [old_code]\n' +
    '  + [new_code]\n\n' +
    'Use *** End of File after the last hunk line to anchor changes to the end of the file. ' +
    'The patch fails if the anchored pattern is not at EOF — use this to disambiguate hunks that could match near the end.\n\n' +
    'A hunk with only "+" lines and no context appends to the end of the file.\n\n' +
    'If a hunk could match multiple locations, you MUST use @@ with the enclosing class/function name. ' +
    'Without it, the patch fails with an ambiguity error.\n\n' +
    'Limitations:\n' +
    '- Control characters (null, bell, escape) cannot be embedded in patch content.\n' +
    '- Do NOT patch symlinks directly — the tool follows symlinks and patches the target.\n\n' +
    'Grammar:\n' +
    'Patch := Begin { FileOp } End\n' +
    'Begin := "*** Begin Patch" NEWLINE\n' +
    'End := "*** End Patch" NEWLINE\n' +
    'FileOp := AddFile | DeleteFile | UpdateFile\n' +
    'AddFile := "*** Add File: " path NEWLINE { "+" line NEWLINE }\n' +
    'DeleteFile := "*** Delete File: " path NEWLINE\n' +
    'UpdateFile := "*** Update File: " path NEWLINE [ MoveTo ] { Hunk }\n' +
    'MoveTo := "*** Move to: " newPath NEWLINE\n' +
    'Hunk := "@@" [ header ] NEWLINE { HunkLine } [ "*** End of File" NEWLINE ]\n' +
    'HunkLine := (" " | "-" | "+") text NEWLINE\n\n' +
    'Hunk header is "@@" or "@@ <func/class>" ONLY — NEVER git unified-diff "@@ -a,b +c,d @@" (invalid, causes match_failed).\n\n' +
    'Example:\n' +
    '*** Begin Patch\n' +
    '*** Add File: hello.txt\n' +
    '+Hello world\n' +
    '*** Update File: src/app.py\n' +
    '*** Move to: src/main.py\n' +
    '@@ def greet():\n' +
    '-print("Hi")\n' +
    '+print("Hello, world!")\n' +
    '*** Delete File: obsolete.txt\n' +
    '*** End Patch\n\n' +
    'Important:\n' +
    '- You MUST start the patch with a *** Begin Patch line and end it with a *** End Patch line. Every patch is wrapped in this envelope.\n' +
    '- You MUST include a header (Add/Delete/Update) for each file operation.\n' +
    '- You MUST prefix new lines with + even when creating a new file.\n' +
    '- File paths must be relative to the working directory, NEVER absolute.\n' +
    '- Hunk header is "@@" or "@@ <symbol>" only. Do NOT use git-style "@@ -l,c +l,c @@".\n' +
    '- Do not re-read files after applying a patch — the tool reports success or failure per file.',
  inputSchema: applyPatchInputSchema,
  resultFamily: 'generic',
  outputDataSchema: applyPatchResultDataSchema,
  category: 'filesystem',
  riskClass: RiskClass.MUTATION,
  agentProjector: applyPatchAgentProjector,
};

// ── Helpers ────────────────────────────────────────────────────────────────

function errorOutcome(message: string, code: string): ToolHandlerOutcome<ApplyPatchResultData> {
  return {
    status: 'error',
    data: { files: [], added: 0, modified: 0, deleted: 0, failed: 0 },
    error: { code, message },
  };
}

function fileError(
  filePath: string,
  operation: 'create' | 'update' | 'delete',
  code: string,
  message: string,
): ApplyPatchFileResult {
  return { path: filePath, operation, status: 'error', error: { code, message } };
}

function isPathContainedIn(resolved: string, cwd: string): boolean {
  return resolved === cwd || resolved.startsWith(cwd + path.sep);
}

function isAbsolutePatchPath(filePath: string): boolean {
  return path.isAbsolute(filePath) || path.win32.isAbsolute(filePath);
}

/**
 * F3: If `filePath` is a symlink, write `content` to the symlink's resolved
 * target instead of replacing the symlink with a regular file. Returns true
 * if the write was performed through the symlink, false if the caller should
 * perform a normal atomic write (file doesn't exist or isn't a symlink).
 *
 * For move destinations that don't yet exist, this is a no-op (returns false).
 */
function symlinkSafeWrite(filePath: string, content: string): boolean {
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) {
      const target = fs.realpathSync(filePath);
      atomicWrite(target, content);
      return true;
    }
  } catch {
    // File doesn't exist (move destination) or lstat failed — not a symlink.
  }
  return false;
}

// ── Handler ────────────────────────────────────────────────────────────────

export const applyPatchHandler: ToolHandler = async (input: unknown, ctx) => {
  const { patch } = input as ApplyPatchInput;

  let parsed;
  try {
    parsed = parsePatch(patch);
  } catch (err) {
    if (err instanceof ParseError) {
      return errorOutcome(err.message, 'parse_error');
    }
    const message = err instanceof Error ? err.message : String(err);
    return errorOutcome(`Failed to parse patch: ${message}`, 'parse_error');
  }

  if (parsed.hunks.length === 0) {
    return errorOutcome('No files were modified.', 'empty_patch');
  }

  const files: ApplyPatchFileResult[] = [];
  let added = 0;
  let modified = 0;
  let deleted = 0;
  let failed = 0;

  for (const hunk of parsed.hunks) {
    const resolved = resolveToolPath(ctx.cwd, hunk.path);

    if (isAbsolutePatchPath(hunk.path) || !isPathContainedIn(resolved, ctx.cwd)) {
      files.push(fileError(hunk.path, hunk.type === 'add' ? 'create' : hunk.type === 'delete' ? 'delete' : 'update', 'path_traversal', `Path '${hunk.path}' escapes the working directory.`));
      failed++;
      continue;
    }

    // F10: reject trailing slash on Add File paths — a trailing slash implies
    // a directory, not a file.
    if (hunk.type === 'add' && hunk.path.endsWith('/')) {
      files.push(fileError(hunk.path, 'create', 'invalid_path',
        `Add File path '${hunk.path}' must not end with '/'. To create a directory, add a file inside it.`));
      failed++;
      continue;
    }

    try {
      if (hunk.type === 'add') {
        if (fs.existsSync(resolved)) {
          files.push(fileError(hunk.path, 'create', 'already_exists',
            `File '${hunk.path}' already exists. Use *** Update File to modify existing files.`));
          failed++;
          continue;
        }
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        atomicWrite(resolved, hunk.contents);
        fs.chmodSync(resolved, 0o644);

        const data = buildStructuredFileChange({
          path: resolved,
          operation: 'create',
          oldContent: '',
          newContent: hunk.contents,
        });
        const validated = fileChangeDataSchema.parse(data);
        files.push({ path: hunk.path, operation: 'create', status: 'complete', fileChange: validated });
        added++;
      } else if (hunk.type === 'delete') {
        if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
          files.push(fileError(hunk.path, 'delete', 'not_found', `Cannot delete '${hunk.path}': file does not exist or is a directory.`));
          failed++;
          continue;
        }
        fs.unlinkSync(resolved);
        files.push({ path: hunk.path, operation: 'delete', status: 'complete' });
        deleted++;
      } else {
        let content: string;
        try {
          content = fs.readFileSync(resolved, 'utf-8');
        } catch {
          files.push(fileError(hunk.path, 'update', 'read_failed', `Cannot read file '${hunk.path}' for update.`));
          failed++;
          continue;
        }

        let newContent: string;
        try {
          newContent = applyChunksToContent(content, hunk.chunks, resolved);
        } catch (err) {
          if (err instanceof ApplyPatchApplyError) {
            const unmatched = err.unmatchedLines ? `\nUnmatched lines:\n${err.unmatchedLines.join('\n')}` : '';
            files.push(fileError(hunk.path, 'update', 'match_failed', `${err.message}${unmatched}`));
          } else {
            const message = err instanceof Error ? err.message : String(err);
            files.push(fileError(hunk.path, 'update', 'apply_failed', message));
          }
          failed++;
          continue;
        }

        const data = buildStructuredFileChange({
          path: resolved,
          operation: 'update',
          oldContent: content,
          newContent,
        });
        const validated = fileChangeDataSchema.parse(data);

        if (hunk.movePath) {
          const moveResolved = resolveToolPath(ctx.cwd, hunk.movePath);
          if (isAbsolutePatchPath(hunk.movePath) || !isPathContainedIn(moveResolved, ctx.cwd)) {
            files.push(fileError(hunk.path, 'update', 'path_traversal', `Move path '${hunk.movePath}' escapes the working directory.`));
            failed++;
            continue;
          }
          // F5: refuse to overwrite an existing file at the move destination.
          if (fs.existsSync(moveResolved)) {
            files.push(fileError(hunk.path, 'update', 'move_target_exists',
              `Move target '${hunk.movePath}' already exists. Delete it first or choose a different target.`));
            failed++;
            continue;
          }
          fs.mkdirSync(path.dirname(moveResolved), { recursive: true });
          // F3: if the source is a symlink, write the patched content to the
          // symlink's target (preserving the symlink itself) rather than
          // replacing the symlink with a regular file at the new path.
          const moveSourceIsSymlink = symlinkSafeWrite(moveResolved, newContent);
          if (!moveSourceIsSymlink) {
            atomicWrite(moveResolved, newContent);
            fs.chmodSync(moveResolved, 0o644);
          }
          fs.unlinkSync(resolved);
          files.push({ path: hunk.path, operation: 'update', status: 'complete', fileChange: validated, movePath: hunk.movePath });
          modified++;
        } else {
          // F3: if the target is a symlink, write to the resolved target
          // path (preserving the symlink) rather than replacing the symlink
          // with a regular file.
          const wroteThroughSymlink = symlinkSafeWrite(resolved, newContent);
          if (!wroteThroughSymlink) {
            atomicWrite(resolved, newContent);
          }
          // F9: if the new content is identical to the original (no-op hunk),
          // report success but do not increment the modified counter.
          if (newContent === content) {
            files.push({ path: hunk.path, operation: 'update', status: 'complete', fileChange: validated });
          } else {
            files.push({ path: hunk.path, operation: 'update', status: 'complete', fileChange: validated });
            modified++;
          }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const op = hunk.type === 'add' ? 'create' : hunk.type === 'delete' ? 'delete' : 'update';
      files.push(fileError(hunk.path, op, 'operation_failed', message));
      failed++;
    }
  }

  const resultData: ApplyPatchResultData = { files, added, modified, deleted, failed };

  return { status: 'complete', data: applyPatchResultDataSchema.parse(resultData) };
};
