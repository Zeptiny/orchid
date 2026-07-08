/**
 * RAGTab — RAG (Retrieval-Augmented Generation) configuration.
 *
 * Controls: chunk_size, chunk_overlap, top_k, max_file_size, embedding_model.
 */
import { useCallback } from 'react';

// ── Types ────────────────────────────────────────────────────────────────────

export interface RAGConfig {
  chunk_size: number;
  chunk_overlap: number;
  top_k: number;
  max_file_size: number;
  embedding_model: string;
}

export interface RAGTabProps {
  rag: RAGConfig;
  onChange: (rag: RAGConfig) => void;
}

// ── Known embedding models ───────────────────────────────────────────────────

const EMBEDDING_MODELS = [
  'fastembed/BAAI/bge-small-en-v1.5',
  'fastembed/BAAI/bge-base-en-v1.5',
  'fastembed/BAAI/bge-large-en-v1.5',
  'fastembed/sentence-transformers/all-MiniLM-L6-v2',
  'openai/text-embedding-3-small',
  'openai/text-embedding-3-large',
  'openai/text-embedding-ada-002',
];

// ── Component ────────────────────────────────────────────────────────────────

export function RAGTab({ rag, onChange }: RAGTabProps) {
  const updateField = useCallback(
    <K extends keyof RAGConfig>(field: K, value: RAGConfig[K]) => {
      onChange({ ...rag, [field]: value });
    },
    [rag, onChange],
  );

  const handleNumberChange = useCallback(
    (field: keyof RAGConfig, value: string) => {
      const num = parseInt(value, 10);
      if (!isNaN(num) && num > 0) {
        updateField(field, num);
      }
    },
    [updateField],
  );

  return (
    <div className="pref-tab-content">
      <div className="pref-tab-header">
        <h3>RAG Configuration</h3>
        <p className="pref-tab-description">
          Configure Retrieval-Augmented Generation settings for semantic search over your codebase.
        </p>
      </div>

      <div className="pref-form-grid">
        <div className="pref-form-row">
          <label htmlFor="rag-chunk-size">Chunk Size (tokens)</label>
          <input
            id="rag-chunk-size"
            type="number"
            value={rag.chunk_size}
            onChange={(e) => handleNumberChange('chunk_size', e.target.value)}
            className="pref-input pref-input-number"
            min={100}
            max={10000}
          />
          <span className="pref-form-hint">
            Number of tokens per chunk. Larger chunks provide more context but use more memory.
          </span>
        </div>

        <div className="pref-form-row">
          <label htmlFor="rag-chunk-overlap">Chunk Overlap (tokens)</label>
          <input
            id="rag-chunk-overlap"
            type="number"
            value={rag.chunk_overlap}
            onChange={(e) => handleNumberChange('chunk_overlap', e.target.value)}
            className="pref-input pref-input-number"
            min={0}
            max={2000}
          />
          <span className="pref-form-hint">
            Overlap between adjacent chunks. Helps preserve context across chunk boundaries.
          </span>
        </div>

        <div className="pref-form-row">
          <label htmlFor="rag-top-k">Top K Results</label>
          <input
            id="rag-top-k"
            type="number"
            value={rag.top_k}
            onChange={(e) => handleNumberChange('top_k', e.target.value)}
            className="pref-input pref-input-number"
            min={1}
            max={50}
          />
          <span className="pref-form-hint">
            Number of most relevant chunks to retrieve per query.
          </span>
        </div>

        <div className="pref-form-row">
          <label htmlFor="rag-max-file-size">Max File Size (bytes)</label>
          <input
            id="rag-max-file-size"
            type="number"
            value={rag.max_file_size}
            onChange={(e) => handleNumberChange('max_file_size', e.target.value)}
            className="pref-input pref-input-number"
            min={1024}
            max={10_485_760}
          />
          <span className="pref-form-hint">
            Files larger than this are skipped during indexing. Default: 512KB.
          </span>
        </div>

        <div className="pref-form-row">
          <label htmlFor="rag-embedding-model">Embedding Model</label>
          <select
            id="rag-embedding-model"
            value={rag.embedding_model}
            onChange={(e) => updateField('embedding_model', e.target.value)}
            className="pref-select"
          >
            {EMBEDDING_MODELS.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
            {!EMBEDDING_MODELS.includes(rag.embedding_model) && (
              <option value={rag.embedding_model}>{rag.embedding_model}</option>
            )}
          </select>
          <span className="pref-form-hint">
            Model used for generating embeddings. Local models (fastembed) run offline.
          </span>
        </div>
      </div>
    </div>
  );
}
