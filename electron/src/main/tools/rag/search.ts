/**
 * rag_search tool — search the RAG index for code chunks similar to a query.
 *
 * Ported from Python `src/orchid/tools/rag.py`.
 */
import { z } from 'zod';
import type { ToolDefinition, ToolHandler } from '../types';
import { RiskClass } from '../../../shared/types/permission';
import { genericToolResultMetadata } from '../types';
import { genericBuiltInToolOutcome } from '../result';
import { getToolConfig } from '../types';
import { Embedder } from '../../rag/embedder';
import { RAGStore } from '../../rag/store';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const ragSearchSchema = z.object({
  query: z.string().describe('Natural language search query'),
  top_k: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Number of results to return (default from config)'),
  file_pattern: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Glob pattern to filter results by file path (e.g. "*.py", "src/**/*.ts"). ' +
        'When omitted, all indexed files are searched.',
    ),
});

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const ragSearchDefinition: ToolDefinition = {
  ...genericToolResultMetadata,
  name: 'rag_search',
  description:
    'Search the codebase using semantic search (RAG). Returns code chunks most relevant to the query. ' +
      'Use file_pattern to narrow results to specific files (e.g. "*.py", "src/**/*.ts").',
  inputSchema: ragSearchSchema,
  category: 'rag',
  riskClass: RiskClass.READ_ONLY,
  offload: true,
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const ragSearchHandler: ToolHandler = async (
  input: unknown,
  ctx,
) => {
  const { query, top_k, file_pattern } = input as {
    query: string;
    top_k?: number;
    file_pattern?: string;
  };
  const cfg = getToolConfig(ctx);
  const projectPath = ctx.cwd;

  const store = new RAGStore(projectPath);
  const status = store.status();

  if (status.totalChunks === 0) {
    // Operational precondition, not an execution failure — agent can index first.
    return genericBuiltInToolOutcome('rag_search', 'No RAG index found. Run `rag_index` with action "index" first.', 'complete');
  }

  // Generate query embedding (same thread/batch caps as indexing)
  const embedder = new Embedder({
    model: cfg.rag.embedding_model,
    threads: cfg.rag.embedding_threads,
    batchSize: cfg.rag.embedding_batch_size,
  });
  let queryEmbedding: Float32Array;
  try {
    queryEmbedding = await embedder.embedSingle(query);
  } catch (err) {
    return genericBuiltInToolOutcome(
      'rag_search',
      `Embedding failed: ${err instanceof Error ? err.message : String(err)}`,
      'error',
    );
  }

  // Search
  const results = store.search(
    Array.from(queryEmbedding),
    top_k,
    file_pattern,
  );

  if (results.length === 0) {
    return genericBuiltInToolOutcome('rag_search', 'No relevant results found.', 'complete');
  }

  return genericBuiltInToolOutcome('rag_search', {
    query,
    results: results.map((result) => ({
      score: result.score.toFixed(4),
      file: result.filePath,
      startLine: result.startLine,
      endLine: result.endLine,
      content: result.content,
    })),
  });
};
