/**
 * rag_index tool — manage the RAG index (status, index, clear).
 *
 * Ported from Python `src/orchid/tools/rag.py`.
 */
import { z } from 'zod';
import type { ToolDefinition, ToolHandler } from '../types';
import { RiskClass } from '../../../shared/types/permission';
import { genericToolResultMetadata } from '../types';
import { genericBuiltInToolOutcome, type GenericBuiltInToolOutcome } from '../result';
import { indexProject, getStatus, clearIndex } from '../../rag/indexer';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const ragIndexSchema = z.object({
  action: z
    .enum(['status', 'index', 'clear'])
    .describe('Action: "status" returns index stats, "index" triggers full re-index, "clear" drops the index'),
});

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const ragIndexDefinition: ToolDefinition = {
  ...genericToolResultMetadata,
  name: 'rag_index',
  description:
    'Manage the RAG (Retrieval Augmented Generation) index. ' +
    'Use "status" to check index stats, "index" to build/rebuild the index, "clear" to drop it.',
  inputSchema: ragIndexSchema,
  category: 'rag',
  riskClass: RiskClass.MUTATION,
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const ragIndexHandler: ToolHandler = async (
  input: unknown,
  ctx,
): Promise<GenericBuiltInToolOutcome> => {
  const { action } = input as { action: 'status' | 'index' | 'clear' };
  const projectPath = ctx.cwd;

  switch (action) {
    case 'status': {
      const status = getStatus(projectPath);
      return genericBuiltInToolOutcome('rag_index', {
        action: 'status',
        totalChunks: status.totalChunks,
        totalFiles: status.totalFiles,
        lastIndexed: status.lastIndexed ?? 'never',
        lastDuration: status.lastIndexDuration != null
          ? status.lastIndexDuration.toFixed(1) + 's'
          : 'N/A',
      });
    }

    case 'index': {
      // Run via worker (no custom embedder) so indexing leaves the main thread free.
      const result = await indexProject(
        projectPath,
        undefined,
        false,
        undefined,
        undefined,
        { config: ctx.projectRuntime?.config },
      );
      return genericBuiltInToolOutcome('rag_index', {
        action: 'index',
        filesScanned: result.filesScanned,
        filesIndexed: result.filesIndexed,
        filesSkipped: result.filesSkipped,
        filesDeleted: result.filesDeleted,
        chunksCreated: result.chunksCreated,
        duration: result.durationSeconds.toFixed(1) + 's',
        errors: result.errors.length,
      });
    }

    case 'clear': {
      clearIndex(projectPath);
      return genericBuiltInToolOutcome('rag_index', { action: 'clear' });
    }

    default:
      return genericBuiltInToolOutcome(
        'rag_index',
        `Unknown action: ${action}. Use "status", "index", or "clear".`,
        'error',
      );
  }
};
