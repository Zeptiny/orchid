/**
 * RAGTab — RAG (Retrieval-Augmented Generation) configuration.
 *
 * Controls: chunking, retrieval, embedding model, and resource caps.
 * The embedding model selector auto-detects local ONNX vs API (provider)
 * based on which list the selected value belongs to.
 */
import { useCallback, useMemo } from 'react';
import { collectEmbeddingModelsFromProviders } from '../../utils/models';

// ── Types ────────────────────────────────────────────────────────────────────

export interface RAGConfig {
  chunk_size: number;
  chunk_overlap: number;
  top_k: number;
  max_file_size: number;
  embedding_model: string;
  embedding_threads: number;
  embedding_batch_size: number;
  embedding_api_model: string | null;
}

export interface RAGTabProps {
  rag: RAGConfig;
  providers?: Record<string, Record<string, unknown>>;
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

export function RAGTab({ rag, providers = {}, onChange }: RAGTabProps) {
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

  const apiEmbeddingModels = useMemo(
    () => collectEmbeddingModelsFromProviders(providers),
    [providers],
  );

  const apiModelSet = useMemo(() => new Set(apiEmbeddingModels), [apiEmbeddingModels]);
  const localModelSet = useMemo(() => new Set(LOCAL_EMBEDDING_MODELS), []);

  // The active value: API model takes precedence, else local ONNX model
  const activeModel = rag.embedding_api_model ?? rag.embedding_model;
  const usingApi = rag.embedding_api_model != null && rag.embedding_api_model !== '';

  const handleModelChange = useCallback(
    (value: string) => {
      if (apiModelSet.has(value)) {
        onChange({ ...rag, embedding_api_model: value });
      } else {
        onChange({ ...rag, embedding_api_model: null, embedding_model: value });
      }
    },
    [rag, onChange, apiModelSet],
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
        </div>
      </fieldset>

      <fieldset className="config-fieldset">
        <legend className="config-fieldset-legend">Embedding Model</legend>
        <div className="config-field">
          <label htmlFor="rag-embedding-model">Model</label>
          <select
            id="rag-embedding-model"
            value={activeModel}
            onChange={(e) => handleModelChange(e.target.value)}
            className="select config-control"
          >
            {LOCAL_EMBEDDING_MODELS.map((model) => (
              <option key={model} value={model}>
                {model} (local)
              </option>
            ))}
            {apiEmbeddingModels.length > 0 && (
              <optgroup label="API (provider)">
                {apiEmbeddingModels.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </optgroup>
            )}
            {/* Preserve unknown / custom values */}
            {!localModelSet.has(activeModel) && !apiModelSet.has(activeModel) && (
              <option value={activeModel}>{activeModel}</option>
            )}
          </select>
          <span className="config-field-hint">
            {usingApi
              ? 'API model — embeddings generated via provider endpoint.'
              : 'Local model — embeddings generated on-device via ONNX runtime.'}
            {apiEmbeddingModels.length === 0 &&
              ' Add a provider model with mode "embeddings" in the Providers tab to use API embeddings.'}
          </span>
        </div>
      </fieldset>

      <fieldset className="config-fieldset">
        <legend className="config-fieldset-legend">Resource Limits</legend>
        {!usingApi && (
          <p className="config-help text-sm opacity-70 mb-2">
            Caps local ONNX embedding CPU and peak memory during indexing and search.
          </p>
        )}
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
              disabled={usingApi}
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
              disabled={usingApi}
            />
          </div>
        </div>
      </fieldset>
    </div>
  );
}
