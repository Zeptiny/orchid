/**
 * ChatView — main chat layout combining ChatStream, InputArea, Footer, Sidebar.
 *
 * This is the primary interface for Phase 1.
 * Manages all state hooks and coordinates the layout.
 */
import { useState, useCallback, useEffect } from 'react';
import { useChat } from '../hooks/useChat';
import { useSession } from '../hooks/useSession';
import { useSubagents } from '../hooks/useSubagents';
import { useTodos } from '../hooks/useTodos';
import { useToolRail } from '../hooks/useToolRail';
import type { MCPServerStatus, RAGStoreStatus, ASTStoreStatus, CommandContext } from '../../shared/types/ipc-boundary';
import { ChatStream } from './ChatStream';
import { InputArea } from './InputArea';
import { Footer } from './Footer';
import { Sidebar } from './Sidebar';
import { CommandPalette } from './CommandPalette';
import { ToolRail } from './ToolWidgets';

// ── Component ────────────────────────────────────────────────────────────────

export function ChatView() {
  // ── State hooks ──────────────────────────────────────────────────────────
  const chat = useChat();
  const session = useSession();
  const subagents = useSubagents(session.activeSession?.id ?? null);
  const todos = useTodos(session.activeSession?.id ?? null);
  const toolRail = useToolRail();

  // Sidebar state
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // Command palette state
  const [paletteOpen, setPaletteOpen] = useState(false);

  // MCP status
  const [mcpServers, setMcpServers] = useState<MCPServerStatus[]>([]);

  // Index status
  const [ragStatus, setRagStatus] = useState<RAGStoreStatus | null>(null);
  const [astStatus, setAstStatus] = useState<ASTStoreStatus | null>(null);

  // Current theme and personality for palette sub-pickers
  const [currentTheme, setCurrentTheme] = useState('default');
  const [currentPersonality, setCurrentPersonality] = useState('default');

  // ── Sidebar toggle ──────────────────────────────────────────────────────
  const toggleSidebar = useCallback(() => {
    setSidebarOpen((prev) => !prev);
  }, []);

  // ── Command palette toggle ──────────────────────────────────────────────
  const togglePalette = useCallback(() => {
    setPaletteOpen((prev) => !prev);
  }, []);

  // ── Cmd+K / Ctrl+K keyboard shortcut ────────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        togglePalette();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [togglePalette]);

  // ── Load theme and personality from config ───────────────────────────────
  useEffect(() => {
    async function loadConfig() {
      try {
        if (window.orchid?.config?.get) {
          const config = await window.orchid.config.get();
          if (config.theme) setCurrentTheme(config.theme);
          if (config.personality) setCurrentPersonality(config.personality);
        }
      } catch {
        // Non-fatal
      }
    }
    loadConfig();
  }, []);

  // ── Session actions ──────────────────────────────────────────────────────
  const handleSessionSelect = useCallback(
    async (id: string) => {
      const loadedSession = await session.load(id);
      // Use the returned session directly to avoid stale closure
      if (loadedSession) {
        const activeChain = loadedSession.chains.find(
          (c) => c.id === loadedSession.activeChainId,
        );
        if (activeChain) {
          chat.setMessages([...activeChain.messages]);
        }
      }
    },
    [session, chat],
  );

  const handleSessionCreate = useCallback(async () => {
    const newSession = await session.create();
    chat.setMessages([]);
    // Auto-load the new session
    await session.load(newSession.id);
  }, [session, chat]);

  // ── MCP status refresh ──────────────────────────────────────────────────
  const refreshMCP = useCallback(async () => {
    try {
      const status = await window.orchid.mcp.status();
      setMcpServers(status);
    } catch {
      // Non-fatal
    }
  }, []);

  // ── Index status refresh ────────────────────────────────────────────────
  const refreshIndex = useCallback(async () => {
    try {
      const [rag, ast] = await Promise.all([
        window.orchid.rag.status(),
        window.orchid.ast.status(),
      ]);
      setRagStatus(rag);
      setAstStatus(ast);
    } catch {
      // Non-fatal
    }
  }, []);

  // ── Index actions ────────────────────────────────────────────────────────
  const handleIndexRAG = useCallback(async () => {
    try {
      await window.orchid.rag.index();
      await refreshIndex();
    } catch (err) {
      console.error('RAG index failed:', err);
    }
  }, [refreshIndex]);

  const handleIndexAST = useCallback(async () => {
    try {
      await window.orchid.ast.index();
      await refreshIndex();
    } catch (err) {
      console.error('AST index failed:', err);
    }
  }, [refreshIndex]);

  // ── Load initial data ───────────────────────────────────────────────────
  useEffect(() => {
    refreshMCP();
    refreshIndex();
  }, [refreshMCP, refreshIndex]);

  // ── Notification helper ─────────────────────────────────────────────────
  const notify = useCallback((message: string, severity: 'info' | 'warning' | 'error' = 'info') => {
    // Simple notification — could be replaced with a toast system
    console.log(`[${severity.toUpperCase()}] ${message}`);
    // Also use Electron's notification API if available
    if (severity === 'error') {
      console.error(message);
    }
  }, []);

  // ── Command context for the palette ─────────────────────────────────────
  const commandContext: CommandContext = {
    onCreateSession: handleSessionCreate,
    onLoadSession: handleSessionSelect,
    onDeleteSession: session.deleteSession,
    onRenameSession: session.rename,
    getActiveSessionId: () => session.activeSession?.id ?? null,
    getActiveSessionName: () => session.activeSession?.name ?? null,
    onSetTheme: async (name: string) => {
      setCurrentTheme(name);
      try {
        if (window.orchid?.config?.save) {
          await window.orchid.config.save({ updates: { theme: name } });
        }
      } catch {
        // Non-fatal
      }
    },
    onSetPersonality: async (name: string) => {
      setCurrentPersonality(name);
      try {
        if (window.orchid?.config?.save) {
          await window.orchid.config.save({ updates: { personality: name } });
        }
      } catch {
        // Non-fatal
      }
    },
    onOpenSettings: () => {
      // Emit event for U24 Preferences to listen to
      window.dispatchEvent(new CustomEvent('orchid:open-settings'));
      notify('Settings: preferences window coming in U24.', 'info');
    },
    onIndexRAG: handleIndexRAG,
    onIndexAST: handleIndexAST,
    onClearRAG: async () => {
      try {
        await window.orchid.rag.clear();
        await refreshIndex();
      } catch (err) {
        console.error('RAG clear failed:', err);
      }
    },
    onGetRAGStatus: async () => {
      try {
        return await window.orchid.rag.status();
      } catch {
        return null;
      }
    },
    onNotify: notify,
    onClose: () => setPaletteOpen(false),
  };

  // ── Model from active session or config ─────────────────────────────────
  const model = session.activeSession?.model ?? '';

  // ── Session list for palette ─────────────────────────────────────────────
  const sessions =
    session.listState.status === 'ready' || session.listState.status === 'partial'
      ? session.listState.sessions
      : [];

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div className="app-layout">
      <div className={`chat-main ${sidebarOpen ? 'sidebar-open' : ''} ${toolRail.isOpen ? 'tool-rail-open' : ''}`}>
        <ChatStream
          messages={chat.messages}
          streamingContent={chat.streamingContent}
          status={chat.status}
          error={chat.error}
          onClearError={chat.clearError}
        />
        <InputArea
          status={chat.status}
          model={model}
          onSend={chat.send}
          onCancel={chat.cancel}
        />
        <Footer
          model={model}
          usage={chat.usage}
          elapsedSeconds={chat.elapsedSeconds}
          isStreaming={chat.status === 'streaming'}
        />
      </div>

      <ToolRail
        events={toolRail.events}
        isOpen={toolRail.isOpen}
        onOpen={toolRail.open}
        onClose={toolRail.close}
        onNavigate={toolRail.onNavigate}
      />

      <Sidebar
        isOpen={sidebarOpen}
        onToggle={toggleSidebar}
        sessionListState={session.listState}
        activeSessionId={session.activeSession?.id ?? null}
        onSessionSelect={handleSessionSelect}
        onSessionCreate={handleSessionCreate}
        onSessionDelete={session.deleteSession}
        onRefreshSessions={session.refresh}
        subagentState={subagents.state}
        onRefreshSubagents={subagents.refresh}
        todoState={todos.state}
        onRefreshTodos={todos.refresh}
        mcpServers={mcpServers}
        onRefreshMCP={refreshMCP}
        ragStatus={ragStatus}
        astStatus={astStatus}
        onIndexRAG={handleIndexRAG}
        onIndexAST={handleIndexAST}
        onRefreshIndex={refreshIndex}
      />

      <CommandPalette
        isOpen={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        context={commandContext}
        sessions={sessions}
        currentTheme={currentTheme}
        currentPersonality={currentPersonality}
      />
    </div>
  );
}
