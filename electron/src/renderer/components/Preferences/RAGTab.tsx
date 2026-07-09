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
    <div className="config-form">
      <fieldset className="config-fieldset">
        <legend className="config-fieldset-legend">RAG Configuration</legend>
        <div className="config-form-grid">
          <div className="config-field">
            <label htmlFor="rag-chunk-size">Chunk Size (tokens)</label>
            <input
              id="rag-chunk-size"
              type="number"
              value={rag.chunk_size}
              onChange={(e) => handleNumberChange('chunk_size', e.target.value)}
              className="input config-control"
              min={100}
              max={10000}
            />
          </div>

          <div className="config-field">
            <label htmlFor="rag-chunk-overlap">Chunk Overlap (tokens)</label>
            <input
              id="rag-chunk-overlap"
              type="number"
              value={rag.chunk_overlap}
              onChange={(e) => handleNumberChange('chunk_overlap', e.target.value)}
              className="input config-control"
              min={0}
              max={2000}
            />
          </div>

          <div className="config-field">
            <label htmlFor="rag-top-k">Top K Results</label>
            <input
              id="rag-top-k"
              type="number"
              value={rag.top_k}
              onChange={(e) => handleNumberChange('top_k', e.target.value)}
              className="input config-control"
              min={1}
              max={50}
            />
          </div>

          <div className="config-field">
            <label htmlFor="rag-max-file-size">Max File Size (bytes)</label>
            <input
              id="rag-max-file-size"
              type="number"
              value={rag.max_file_size}
              onChange={(e) => handleNumberChange('max_file_size', e.target.value)}
              className="input config-control"
              min={1024}
              max={10_485_760}
            />
          </div>

          <div className="config-field config-form-grid-full">
            <label htmlFor="rag-embedding-model">Embedding Model</label>
            <select
              id="rag-embedding-model"
              value={rag.embedding_model}
              onChange={(e) => updateField('embedding_model', e.target.value)}
              className="select config-control"
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
          </div>
        </div>
      </fieldset>
    </div>
  );
}
