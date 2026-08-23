// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RAGTab, type RAGConfig } from '../../src/renderer/components/Preferences/RAGTab';
import type { IndexRefreshConfig } from '../../src/shared/types/ipc-boundary';

afterEach(() => {
  cleanup();
});

const RAG: RAGConfig = {
  chunk_size: 800,
  chunk_overlap: 100,
  top_k: 5,
  max_file_size: 512000,
  embedding_model: 'fastembed/BAAI/bge-small-en-v1.5',
  embedding_threads: 2,
  embedding_batch_size: 16,
  embedding_api_timeout: 30,
  embedding_api_retries: 3,
  model_download_inactivity_timeout: 30,
  model_download_total_timeout: 900,
  embedding_api_model: null,
};

const INDEX_REFRESH: IndexRefreshConfig = {
  rag: true,
  ast: true,
  watch: true,
  debounce_ms: 2000,
};

function renderTab(): ReturnType<typeof vi.fn> {
  const onIndexRefreshChange = vi.fn();
  // RAGTab mounts the provider-backed embedding-model picker; give the
  // shared providers store a minimal API surface before mounting.
  window.orchid = {
    providers: {
      list: vi.fn(async () => ({ connections: [], statuses: [] })),
      modelList: vi.fn(async () => []),
    },
  } as never;
  render(
    <RAGTab
      rag={RAG}
      onChange={() => {}}
      indexRefresh={INDEX_REFRESH}
      onIndexRefreshChange={onIndexRefreshChange}
    />,
  );
  return onIndexRefreshChange;
}

function checkbox(label: string): HTMLInputElement {
  return screen.getByLabelText(label) as HTMLInputElement;
}

describe('RAGTab index auto-refresh', () => {
  it('renders the section with current values', () => {
    renderTab();
    expect(screen.getByText('Index Auto-Refresh')).toBeTruthy();
    expect(checkbox('RAG auto-refresh').checked).toBe(true);
    expect(checkbox('AST auto-refresh').checked).toBe(true);
    expect(checkbox('Watch workspace for external changes').checked).toBe(true);
    expect((screen.getByLabelText('Debounce Window (ms)') as HTMLInputElement).value).toBe('2000');
  });

  it('toggles each boolean through the index_refresh change handler', () => {
    const onIndexRefreshChange = renderTab();

    fireEvent.click(checkbox('RAG auto-refresh'));
    expect(onIndexRefreshChange).toHaveBeenLastCalledWith({ ...INDEX_REFRESH, rag: false });

    fireEvent.click(checkbox('AST auto-refresh'));
    expect(onIndexRefreshChange).toHaveBeenLastCalledWith({ ...INDEX_REFRESH, ast: false });

    fireEvent.click(checkbox('Watch workspace for external changes'));
    expect(onIndexRefreshChange).toHaveBeenLastCalledWith({ ...INDEX_REFRESH, watch: false });
  });

  it('writes debounce edits and rejects values outside the schema bounds', () => {
    const onIndexRefreshChange = renderTab();
    const input = screen.getByLabelText('Debounce Window (ms)') as HTMLInputElement;

    fireEvent.change(input, { target: { value: '5000' } });
    expect(onIndexRefreshChange).toHaveBeenLastCalledWith({ ...INDEX_REFRESH, debounce_ms: 5000 });

    onIndexRefreshChange.mockClear();
    fireEvent.change(input, { target: { value: '50' } });
    expect(onIndexRefreshChange).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: '60001' } });
    expect(onIndexRefreshChange).not.toHaveBeenCalled();
  });
});
