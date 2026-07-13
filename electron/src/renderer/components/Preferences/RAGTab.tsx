/**
 * RAGTab — RAG (Retrieval-Augmented Generation) configuration.
 *
 * Controls: chunking, retrieval, embedding model, and resource caps.
 * Provider-backed embeddings stay disabled until U4 introduces a typed
 * connection-scoped selection; U1 keeps RAG safely local-only.
 */
import { useCallback } from 'react';
import { ModelPicker } from '../ModelPicker';
import type { ModelSelection } from '../../../shared/types/provider';

// ── Types ────────────────────────────────────────────────────────────────────

export interface RAGConfig {
  chunk_size: number;
  chunk_overlap: number;
  top_k: number;
  max_file_size: number;
  embedding_model: string;
  embedding_threads: number;
  embedding_batch_size: number;
  embedding_api_model: ModelSelection | null;
}

export interface RAGTabProps {
  rag: RAGConfig;
  onChange: (rag: RAGConfig) => void;
}

// ── Known local ONNX embedding models (auto-download from Hugging Face) ─────
// Keep in sync with BUILTIN_LOCAL_EMBEDDING_MODELS in main/rag/embedder.ts

const LOCAL_EMBEDDING_MODELS = [
  'fastembed/BAAI/bge-small-en-v1.5',
  'fastembed/BAAI/bge-base-en-v1.5',
  'fastembed/BAAI/bge-large-en-v1.5',
  'fastembed/sentence-transformers/all-MiniLM-L6-v2',
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
        updateField(field, num as RAGConfig[typeof field]);
      }
    },
    [updateField],
  );

  const activeModel = rag.embedding_model;

  const handleModelChange = useCallback(
    (value: string) => {
      onChange({ ...rag, embedding_api_model: null, embedding_model: value });
    },
    [rag, onChange],
  );

  return (
    <div className="config-form">
      <section className="config-fieldset">
        <div className="config-fieldset-legend">RAG Configuration</div>
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
        </div>
      </section>

      <section className="config-fieldset">
        <div className="config-fieldset-legend">Embedding Model</div>
        <div className="config-field">
          <label>Model</label>
          <ModelPicker
            value={activeModel}
            options={LOCAL_EMBEDDING_MODELS}
            onChange={handleModelChange}
            label="Select embedding model"
            align="start"
            className="config-model-picker"
            emptyMessage="No local embedding models available"
          />
          <span className="config-field-hint">
            Local model — embeddings are generated on-device via ONNX runtime.
            Provider-backed embeddings will be available after provider connections are configured.
          </span>
        </div>
      </section>

      <section className="config-fieldset">
        <div className="config-fieldset-legend">Resource Limits</div>
        <p className="config-help text-sm opacity-70 mb-2">
          Caps local ONNX embedding CPU and peak memory during indexing and search.
        </p>
        <div className="config-form-grid">
          <div className="config-field">
            <label htmlFor="rag-embedding-threads">Embedding Threads</label>
            <input
              id="rag-embedding-threads"
              type="number"
              value={rag.embedding_threads ?? 2}
              onChange={(e) => handleNumberChange('embedding_threads', e.target.value)}
              className="input config-control"
              min={1}
              max={64}
              title="ONNX Runtime CPU threads (intra-op). Default 2."
            />
          </div>

          <div className="config-field">
            <label htmlFor="rag-embedding-batch-size">Embedding Batch Size</label>
            <input
              id="rag-embedding-batch-size"
              type="number"
              value={rag.embedding_batch_size ?? 16}
              onChange={(e) => handleNumberChange('embedding_batch_size', e.target.value)}
              className="input config-control"
              min={1}
              max={256}
              title="Texts per forward pass. Lower = less peak RAM/CPU."
            />
          </div>
        </div>
      </section>
    </div>
  );
}
