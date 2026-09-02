/**
 * Workspace-scoped service status for the ChatView inspector: MCP servers,
 * the RAG/AST stores, and the manual index actions they expose.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ASTStoreStatus,
  MCPServerStatus,
  RAGStoreStatus,
} from '../../../shared/types/ipc-boundary';

export interface UseChatViewIndexStatusOptions {
  readonly workspaceCwd: string | null;
}

export interface UseChatViewIndexStatusReturn {
  readonly mcpServers: MCPServerStatus[];
  readonly ragStatus: RAGStoreStatus | null;
  readonly astStatus: ASTStoreStatus | null;
  readonly autoRefreshing: { rag: boolean; ast: boolean };
  readonly refreshMCP: (expectedWorkspaceKey?: string | null) => Promise<void>;
  readonly refreshIndex: (expectedWorkspaceKey?: string | null) => Promise<void>;
  readonly onIndexRAG: () => Promise<void>;
  readonly onIndexAST: () => Promise<void>;
}

interface WorkspaceReadGuard {
  /** Generation this read started with. */
  readonly generation: number;
  /** Generation of the newest refresh started so far. */
  readonly latestGeneration: number;
  /** Workspace the caller expected, or `undefined` when any workspace is fine. */
  readonly expectedWorkspaceKey: string | null | undefined;
  /** Workspace this window is bound to right now. */
  readonly currentWorkspaceKey: string | null;
}

/** A status read is dropped once a newer refresh started or the workspace moved. */
function isStaleWorkspaceRead(guard: WorkspaceReadGuard): boolean {
  const supersededByNewerRefresh = guard.generation !== guard.latestGeneration;
  const workspaceChanged = guard.expectedWorkspaceKey !== undefined
    && guard.currentWorkspaceKey !== guard.expectedWorkspaceKey;
  return supersededByNewerRefresh || workspaceChanged;
}

/**
 * Read-path injection for the inspector's workspace panels: refreshes are
 * generation-guarded so a slow response can never paint a previous project.
 */
export function useChatViewIndexStatus({
  workspaceCwd,
}: UseChatViewIndexStatusOptions): UseChatViewIndexStatusReturn {
  const workspaceCwdRef = useRef(workspaceCwd);
  workspaceCwdRef.current = workspaceCwd;
  const [mcpServers, setMcpServers] = useState<MCPServerStatus[]>([]);
  const [ragStatus, setRagStatus] = useState<RAGStoreStatus | null>(null);
  const [astStatus, setAstStatus] = useState<ASTStoreStatus | null>(null);
  const [autoRefreshing, setAutoRefreshing] = useState<{ rag: boolean; ast: boolean }>({
    rag: false,
    ast: false,
  });
  const mcpRefreshGeneration = useRef(0);
  const indexRefreshGeneration = useRef(0);

  const refreshMCP = useCallback(async (expectedWorkspaceKey?: string | null) => {
    const generation = ++mcpRefreshGeneration.current;
    try {
      if (window.orchid?.mcp?.status) {
        const status = await window.orchid.mcp.status();
        const stale = isStaleWorkspaceRead({
          generation,
          latestGeneration: mcpRefreshGeneration.current,
          expectedWorkspaceKey,
          currentWorkspaceKey: workspaceCwdRef.current,
        });
        if (stale) return;
        setMcpServers(status);
      }
    } catch {
      // Non-fatal
    }
  }, []);

  const refreshIndex = useCallback(async (expectedWorkspaceKey?: string | null) => {
    const generation = ++indexRefreshGeneration.current;
    try {
      if (window.orchid?.rag?.status && window.orchid?.ast?.status) {
        const [rag, ast] = await Promise.all([
          window.orchid.rag.status(),
          window.orchid.ast.status(),
        ]);
        const stale = isStaleWorkspaceRead({
          generation,
          latestGeneration: indexRefreshGeneration.current,
          expectedWorkspaceKey,
          currentWorkspaceKey: workspaceCwdRef.current,
        });
        if (stale) return;
        setRagStatus(rag);
        setAstStatus(ast);
      }
    } catch {
      // Non-fatal
    }
  }, []);

  // Background auto-refreshes (index refresh coordinator) push a lifecycle
  // stream so the Workspace Index panel shows live busy state and fresh store
  // statuses without polling. `started` marks the indexes a flush is running
  // for, `landed` carries fresh statuses, `settled` clears the busy state on
  // every outcome (failures included). The broadcast is routed per-window to
  // the flushed project, mirroring the index progress events.
  useEffect(() => {
    const unsubscribe = window.orchid?.index?.onAutoRefresh?.((event) => {
      if (event.phase === 'started') {
        setAutoRefreshing({ rag: event.rag, ast: event.ast });
      } else if (event.phase === 'landed') {
        if (event.rag) setRagStatus(event.rag);
        if (event.ast) setAstStatus(event.ast);
        setAutoRefreshing({ rag: false, ast: false });
      } else {
        setAutoRefreshing({ rag: false, ast: false });
      }
    });
    return () => unsubscribe?.();
  }, []);

  const onIndexRAG = useCallback(async () => {
    if (!window.orchid?.rag?.index) {
      throw new Error('RAG IPC is not available');
    }
    const result = await window.orchid.rag.index();
    await refreshIndex();
    // Surface indexer-reported failures (still a resolved IPC result)
    if (result?.errors && result.errors.length > 0) {
      throw new Error(result.errors[0] ?? 'RAG indexing reported errors');
    }
  }, [refreshIndex]);

  const onIndexAST = useCallback(async () => {
    if (!window.orchid?.ast?.index) {
      throw new Error('AST IPC is not available');
    }
    const result = await window.orchid.ast.index();
    await refreshIndex();
    if (result?.errors && result.errors.length > 0) {
      throw new Error(result.errors[0] ?? 'AST indexing reported errors');
    }
  }, [refreshIndex]);

  return {
    mcpServers,
    ragStatus,
    astStatus,
    autoRefreshing,
    refreshMCP,
    refreshIndex,
    onIndexRAG,
    onIndexAST,
  };
}
