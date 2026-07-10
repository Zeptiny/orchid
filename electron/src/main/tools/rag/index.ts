/**
 * rag_index tool — manage the RAG index (status, index, clear).
 *
 * Ported from Python `src/orchid/tools/rag.py`.
 */
import { z } from 'zod';
import type { ToolDefinition, ToolHandler } from '../types';
import { indexProject, getStatus, clearIndex } from '../../rag/indexer';
import { Embedder } from '../../rag/embedder';
import { getConfig } from '../../config/loader';

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
  name: 'rag_index',
  description:
    'Manage the RAG (Retrieval Augmented Generation) index. ' +
    'Use "status" to check index stats, "index" to build/rebuild the index, "clear" to drop it.',
  inputSchema: ragIndexSchema,
  actionLabel: 'Managing RAG index...',
  category: 'rag',
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const ragIndexHandler: ToolHandler = async (
  input: unknown,
  ctx,
): Promise<string> => {
  const { action } = input as { action: 'status' | 'index' | 'clear' };
  const projectPath = ctx.cwd;

  switch (action) {
    case 'status': {
      const status = getStatus(projectPath);
      const lines = [
        'RAG Index Status:',
        `  Total chunks: ${status.totalChunks}`,
        `  Total files: ${status.totalFiles}`,
        `  Last indexed: ${status.lastIndexed ?? 'never'}`,
        `  Last index duration: ${status.lastIndexDuration != null ? status.lastIndexDuration.toFixed(1) + 's' : 'N/A'}`,
      ];
      return lines.join('\n');
    }

    case 'index': {
      const cfg = getConfig();
      const embedder = new Embedder(cfg.rag.embedding_model);
      const result = await indexProject(projectPath, undefined, undefined, embedder);
      const lines = [
        'RAG Index Complete:',
        `  Files scanned: ${result.filesScanned}`,
        `  Files indexed: ${result.filesIndexed}`,
        `  Files skipped: ${result.filesSkipped}`,
        `  Files deleted: ${result.filesDeleted}`,
        `  Chunks created: ${result.chunksCreated}`,
        `  Duration: ${result.durationSeconds.toFixed(1)}s`,
      ];
      if (result.errors.length > 0) {
        lines.push(`  Errors: ${result.errors.length}`);
        for (const err of result.errors.slice(0, 5)) {
          lines.push(`    - ${err}`);
        }
        if (result.errors.length > 5) {
          lines.push(`    ... and ${result.errors.length - 5} more`);
        }
      }
      return lines.join('\n');
    }

    case 'clear': {
      clearIndex(projectPath);
      return 'RAG index cleared.';
    }

    default:
      return `Unknown action: ${action}. Use "status", "index", or "clear".`;
  }
};
