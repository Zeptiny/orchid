/**
 * rag_search tool — search the RAG index for code chunks similar to a query.
 *
 * Ported from Python `src/orchid/tools/rag.py`.
 */
import { z } from 'zod';
import type { ToolDefinition, ToolHandler } from '../types';
import { Embedder } from '../../rag/embedder';
import { RAGStore } from '../../rag/store';
import { getConfig } from '../../config/loader';

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
});

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const ragSearchDefinition: ToolDefinition = {
  name: 'rag_search',
  description:
    'Search the codebase using semantic search (RAG). Returns code chunks most relevant to the query.',
  inputSchema: ragSearchSchema,
  actionLabel: 'Searching codebase...',
  category: 'rag',
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const ragSearchHandler: ToolHandler = async (
  input: unknown,
): Promise<string> => {
  const { query, top_k } = input as { query: string; top_k?: number };
  const cfg = getConfig();
  const projectPath = process.cwd();

  const store = new RAGStore(projectPath);
  const status = store.status();

  if (status.totalChunks === 0) {
    return 'No RAG index found. Run `rag_index` with action "index" first.';
  }

  // Generate query embedding
  const embedder = new Embedder(cfg.rag.embedding_model);
  let queryEmbedding: Float32Array;
  try {
    queryEmbedding = await embedder.embedSingle(query);
  } catch (err) {
    return `Embedding failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  // Search
  const results = store.search(
    Array.from(queryEmbedding),
    top_k,
  );

  if (results.length === 0) {
    return 'No relevant results found.';
  }

  // Format results
  const lines: string[] = [`Found ${results.length} relevant chunks:\n`];
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    lines.push(
      `--- Result ${i + 1} (score: ${r.score.toFixed(4)}) ---`,
      `File: ${r.filePath} (lines ${r.startLine}-${r.endLine})`,
      '```',
      r.content,
      '```\n',
    );
  }

  return lines.join('\n');
};
