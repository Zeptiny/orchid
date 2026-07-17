/**
 * RAGTab — RAG (Retrieval-Augmented Generation) configuration.
 *
 * Controls: chunking, retrieval, embedding model, and resource caps.
 * Provider-backed embeddings use the same typed connection-scoped selection as
 * chat, while local ONNX remains the default path.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ModelPicker } from '../ModelPicker';
import type { ProviderModelOption } from '../../../shared/types/ipc';
import type { ModelSelection } from '../../../shared/types/provider';
import { useProviders } from '../../hooks/useProviders';
import { parseConfigNumber } from '../../utils/config-draft';
import { isEmbeddingModel } from '../../utils/models';
import {
  providerModelOptionDisplayName,
  providerModelOptionKey,
  selectionKey,
} from '../../utils/provider-selection';
import { FormField } from '../ui/FormField';
import { Panel } from '../ui/Panel';
import { SectionHeader } from '../ui/SectionHeader';

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
  const providers = useProviders();
  const [providerEmbeddingOptions, setProviderEmbeddingOptions] = useState<readonly ProviderModelOption[]>([]);

  useEffect(() => {
    void providers.ensureModelList();
  }, [providers.ensureModelList]);

  useEffect(() => {
    if (providers.modelOptions == null) return;
    setProviderEmbeddingOptions(providers.modelOptions.filter((option) => (
      option.available && option.embeddingSupported === true && isEmbeddingModel(option.model)
    )));
  }, [providers.modelOptions]);

  useEffect(() => {
    const refreshProviders = () => {
      void providers.refresh().then(() => providers.ensureModelList());
    };
    window.addEventListener('orchid:providers-updated', refreshProviders);
    return () => window.removeEventListener('orchid:providers-updated', refreshProviders);
  }, [providers.refresh, providers.ensureModelList]);

  const updateField = useCallback(
    <K extends keyof RAGConfig>(field: K, value: RAGConfig[K]) => {
      onChange({ ...rag, [field]: value });
    },
    [rag, onChange],
  );

  const handleNumberChange = useCallback(
    (field: keyof RAGConfig, value: string, min = 1) => {
      const num = parseConfigNumber(value, min, { integer: true });
      if (num !== null) {
        updateField(field, num as RAGConfig[typeof field]);
      }
    },
    [updateField],
  );

  const activeModel = rag.embedding_api_model
    ? selectionKey(rag.embedding_api_model)
    : rag.embedding_model;
  const providerModelLabels = useMemo(
    () => Object.fromEntries(providerEmbeddingOptions.map((option) => [
      providerModelOptionKey(option),
      providerModelOptionDisplayName(option),
    ])),
    [providerEmbeddingOptions],
  );
  const providerModelDetails = useMemo(
    () => Object.fromEntries(providerEmbeddingOptions.map((option) => [providerModelOptionKey(option), option])),
    [providerEmbeddingOptions],
  );
  const localModelOptions = useMemo(
    () => LOCAL_EMBEDDING_MODELS.map((model) => ({
      value: model,
      label: model,
      description: 'Local ONNX model',
    })),
    [],
  );

  const handleModelChange = useCallback((value: string) => {
    const option = providerEmbeddingOptions.find((candidate) => providerModelOptionKey(candidate) === value);
    if (option) {
      onChange({
        ...rag,
        embedding_api_model: {
          connectionId: option.selection.connectionId,
          modelId: option.selection.modelId,
        },
      });
      return;
    }
    if (localModelOptions.some((candidate) => candidate.value === value)) {
      onChange({ ...rag, embedding_api_model: null, embedding_model: value });
    }
  }, [localModelOptions, onChange, providerEmbeddingOptions, rag]);

  return (
    <div className="config-form flex flex-col gap-4">
      <Panel as="section" className="config-fieldset flex flex-col gap-3">
        <SectionHeader title="RAG Configuration" />
        <div className="config-form-grid">
          <FormField label="Chunk Size (tokens)" htmlFor="rag-chunk-size" className="config-field">
            <input
              id="rag-chunk-size"
              type="number"
              value={rag.chunk_size}
              onChange={(e) => handleNumberChange('chunk_size', e.target.value, 100)}
              className="input input-bordered w-full"
              min={100}
              max={10000}
            />
          </FormField>

          <FormField
            label="Chunk Overlap (tokens)"
            htmlFor="rag-chunk-overlap"
            hint="Zero disables overlap between consecutive chunks."
            className="config-field"
          >
            <input
              id="rag-chunk-overlap"
              type="number"
              value={rag.chunk_overlap}
              onChange={(e) => handleNumberChange('chunk_overlap', e.target.value, 0)}
              className="input input-bordered w-full"
              min={0}
              max={2000}
            />
          </FormField>

          <FormField label="Top K Results" htmlFor="rag-top-k" className="config-field">
            <input
              id="rag-top-k"
              type="number"
              value={rag.top_k}
              onChange={(e) => handleNumberChange('top_k', e.target.value)}
              className="input input-bordered w-full"
              min={1}
              max={50}
            />
          </FormField>

          <FormField label="Max File Size (bytes)" htmlFor="rag-max-file-size" className="config-field">
            <input
              id="rag-max-file-size"
              type="number"
              value={rag.max_file_size}
              onChange={(e) => handleNumberChange('max_file_size', e.target.value, 1024)}
              className="input input-bordered w-full"
              min={1024}
              max={10_485_760}
            />
          </FormField>
        </div>
      </Panel>

      <Panel as="section" className="config-fieldset flex flex-col gap-3">
        <SectionHeader title="Embedding Model" />
        <FormField
          label="Model"
          htmlFor="rag-embedding-model"
          hint="Choose a local ONNX model or a provider embedding model. Provider models use the selected connection's embedding endpoint."
          className="config-field"
        >
          <ModelPicker
            id="rag-embedding-model"
            value={activeModel}
            options={providerEmbeddingOptions.map(providerModelOptionKey)}
            optionLabels={providerModelLabels}
            optionDetails={providerModelDetails}
            additionalOptions={localModelOptions}
            onChange={handleModelChange}
            label="Select embedding model"
            align="start"
            className="config-model-picker"
            emptyMessage="No embedding models available"
          />
        </FormField>
      </Panel>

      <Panel as="section" className="config-fieldset flex flex-col gap-3">
        <SectionHeader
          title="Resource Limits"
          description="Caps local ONNX embedding CPU and peak memory during indexing and search."
        />
        <div className="config-form-grid">
          <FormField label="Embedding Threads" htmlFor="rag-embedding-threads" className="config-field">
            <input
              id="rag-embedding-threads"
              type="number"
              value={rag.embedding_threads ?? 2}
              onChange={(e) => handleNumberChange('embedding_threads', e.target.value)}
              className="input input-bordered w-full"
              min={1}
              max={64}
              title="ONNX Runtime CPU threads (intra-op). Default 2."
            />
          </FormField>

          <FormField label="Embedding Batch Size" htmlFor="rag-embedding-batch-size" className="config-field">
            <input
              id="rag-embedding-batch-size"
              type="number"
              value={rag.embedding_batch_size ?? 16}
              onChange={(e) => handleNumberChange('embedding_batch_size', e.target.value)}
              className="input input-bordered w-full"
              min={1}
              max={256}
              title="Texts per forward pass. Lower = less peak RAM/CPU."
            />
          </FormField>
        </div>
      </Panel>
    </div>
  );
}
