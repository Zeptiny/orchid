/**
 * The command palette's action surface: every `/command` and picker action the
 * shell exposes, plus user-initiated compaction. Memoized so the memoized
 * composer, footer, and palette are not invalidated on every streamed token.
 */
import { useCallback, useMemo } from 'react';
import type { CommandContext } from '../../../shared/types/ipc-boundary';
import type { Notify } from '../../utils/notify';
import type { UseSessionReturn } from '../../hooks/useSession';

export interface UseChatViewCommandContextOptions {
  readonly session: UseSessionReturn;
  readonly notify: Notify;
  readonly onCreateSession: () => Promise<void>;
  readonly onLoadSession: (id: string, options?: { force?: boolean }) => Promise<void>;
  readonly onDeleteSession: (id: string) => Promise<void>;
  readonly onSelectModel: (key: string) => Promise<void>;
  readonly onPickProjectDir: () => Promise<void>;
  readonly onIndexRAG: () => Promise<void>;
  readonly onIndexAST: () => Promise<void>;
  readonly onOpenSettings: () => void;
  readonly onClosePalette: () => void;
  readonly applyTheme: (name: string) => Promise<void>;
  readonly applyPersonality: (name: string) => Promise<void>;
  readonly availableModelKeys: readonly string[];
  readonly currentModelKey: string;
  readonly refreshIndex: (expectedWorkspaceKey?: string | null) => Promise<void>;
}

/**
 * /compact — user-initiated compaction of the active session. Main refuses
 * while a turn is streaming; the status maps to a toast and the renderer
 * reloads the session like an automatic compaction.
 */
function useCompactAction(notify: Notify): () => Promise<void> {
  return useCallback(async () => {
    if (!window.orchid?.chat?.compact) {
      throw new Error('Compaction IPC is not available');
    }
    const result = await window.orchid.chat.compact();
    if (result.status === 'compacted') {
      notify('Context compacted.', 'info');
    } else if (result.status === 'busy') {
      notify('Session is busy — compact after the current turn finishes.', 'warning');
    } else if (result.status === 'nothing_to_compact') {
      notify(result.detail ? `Nothing to compact (${result.detail}).` : 'Nothing to compact.', 'info');
    } else if (result.status === 'error') {
      throw new Error(result.error);
    }
  }, [notify]);
}

/** Assemble the shared `CommandContext` from the shell's action surface. */
export function useChatViewCommandContext({
  session,
  notify,
  onCreateSession,
  onLoadSession,
  onDeleteSession,
  onSelectModel,
  onPickProjectDir,
  onIndexRAG,
  onIndexAST,
  onOpenSettings,
  onClosePalette,
  applyTheme,
  applyPersonality,
  availableModelKeys,
  currentModelKey,
  refreshIndex,
}: UseChatViewCommandContextOptions): CommandContext {
  const handleCompact = useCompactAction(notify);

  const clearRAGIndex = useCallback(async () => {
    try {
      if (window.orchid?.rag?.clear) {
        await window.orchid.rag.clear();
        await refreshIndex();
      }
    } catch (err) {
      console.error('RAG clear failed:', err);
      throw err;
    }
  }, [refreshIndex]);

  return useMemo(() => ({
    onCreateSession,
    onLoadSession,
    onDeleteSession,
    onRenameSession: session.rename,
    getActiveSessionId: () => session.activeSession?.id ?? null,
    getActiveSessionName: () => session.activeSession?.name ?? null,
    onSetTheme: applyTheme,
    onSetPersonality: applyPersonality,
    onSetModel: onSelectModel,
    getAvailableModels: () => [...availableModelKeys],
    getCurrentModel: () => currentModelKey,
    onOpenSettings,
    onPickProjectDir,
    onIndexRAG,
    onIndexAST,
    onCompact: handleCompact,
    onClearRAG: clearRAGIndex,
    onNotify: notify,
    onClose: onClosePalette,
  }), [
    onCreateSession,
    onLoadSession,
    onDeleteSession,
    session,
    onSelectModel,
    availableModelKeys,
    currentModelKey,
    onOpenSettings,
    onPickProjectDir,
    onIndexRAG,
    onIndexAST,
    handleCompact,
    clearRAGIndex,
    applyTheme,
    applyPersonality,
    onClosePalette,
    notify,
  ]);
}
