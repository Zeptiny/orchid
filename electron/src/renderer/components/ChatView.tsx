/**
 * ChatView — main chat layout combining ChatStream, InputArea, Footer, Sidebar.
 *
 * Uses DaisyUI components for styling.
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

export function ChatView() {
  const chat = useChat();
  const session = useSession();
  const subagents = useSubagents(session.activeSession?.id ?? null);
  const todos = useTodos(session.activeSession?.id ?? null);
  const toolRail = useToolRail();

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [mcpServers, setMcpServers] = useState<MCPServerStatus[]>([]);
  const [ragStatus, setRagStatus] = useState<RAGStoreStatus | null>(null);
  const [astStatus, setAstStatus] = useState<ASTStoreStatus | null>(null);
  const [currentTheme, setCurrentTheme] = useState('default');
  const [currentPersonality, setCurrentPersonality] = useState('default');

  const toggleSidebar = useCallback(() => {
    setSidebarOpen((prev) => !prev);
  }, []);

  const togglePalette = useCallback(() => {
    setPaletteOpen((prev) => !prev);
  }, []);

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

  const handleSessionSelect = useCallback(
    async (id: string) => {
      const loadedSession = await session.load(id);
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
    await session.load(newSession.id);
  }, [session, chat]);

  const refreshMCP = useCallback(async () => {
    try {
      if (window.orchid?.mcp?.status) {
        const status = await window.orchid.mcp.status();
        setMcpServers(status);
      }
    } catch {
      // Non-fatal
    }
  }, []);

  const refreshIndex = useCallback(async () => {
    try {
      if (window.orchid?.rag?.status && window.orchid?.ast?.status) {
        const [rag, ast] = await Promise.all([
          window.orchid.rag.status(),
          window.orchid.ast.status(),
        ]);
        setRagStatus(rag);
        setAstStatus(ast);
      }
    } catch {
      // Non-fatal
    }
  }, []);

  const handleIndexRAG = useCallback(async () => {
    try {
      if (window.orchid?.rag?.index) {
        await window.orchid.rag.index();
        await refreshIndex();
      }
    } catch (err) {
      console.error('RAG index failed:', err);
    }
  }, [refreshIndex]);

  const handleIndexAST = useCallback(async () => {
    try {
      if (window.orchid?.ast?.index) {
        await window.orchid.ast.index();
        await refreshIndex();
      }
    } catch (err) {
      console.error('AST index failed:', err);
    }
  }, [refreshIndex]);

  useEffect(() => {
    refreshMCP();
    refreshIndex();
  }, [refreshMCP, refreshIndex]);

  const notify = useCallback((message: string, severity: 'info' | 'warning' | 'error' = 'info') => {
    console.log(`[${severity.toUpperCase()}] ${message}`);
    if (severity === 'error') {
      console.error(message);
    }
  }, []);

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
      window.dispatchEvent(new CustomEvent('orchid:open-settings'));
      notify('Settings: preferences window coming in U24.', 'info');
    },
    onIndexRAG: handleIndexRAG,
    onIndexAST: handleIndexAST,
    onClearRAG: async () => {
      try {
        if (window.orchid?.rag?.clear) {
          await window.orchid.rag.clear();
          await refreshIndex();
        }
      } catch (err) {
        console.error('RAG clear failed:', err);
      }
    },
    onGetRAGStatus: async () => {
      try {
        if (window.orchid?.rag?.status) {
          return await window.orchid.rag.status();
        }
        return null;
      } catch {
        return null;
      }
    },
    onNotify: notify,
    onClose: () => setPaletteOpen(false),
  };

  const model = session.activeSession?.model ?? '';

  const sessions =
    session.listState.status === 'ready' || session.listState.status === 'partial'
      ? session.listState.sessions
      : [];

  return (
    <div className="flex h-screen overflow-hidden bg-base-100">
      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col min-w-0">
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

      {/* Tool Rail */}
      <ToolRail
        events={toolRail.events}
        isOpen={toolRail.isOpen}
        onOpen={toolRail.open}
        onClose={toolRail.close}
        onNavigate={toolRail.onNavigate}
      />

      {/* Sidebar */}
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

      {/* Command Palette */}
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
