/**
 * ChatView — main chat layout combining ChatStream, InputArea, Footer, Sidebar.
 *
 * Iteration 012 three-panel shell: left sessions | center chat | right inspector.
 */
import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useChat } from '../hooks/useChat';
import { useSession } from '../hooks/useSession';
import { useSubagents } from '../hooks/useSubagents';
import { useTodos } from '../hooks/useTodos';
import { useSessionActivity } from '../hooks/useSessionActivity';
import { useGlobalShortcuts } from '../keyboard';
import type { Message } from '../../shared/types/message';
import type { Session } from '../../shared/types/session';
import type { MCPServerStatus, RAGStoreStatus, ASTStoreStatus, CommandContext } from '../../shared/types/ipc-boundary';
import { ChatStream } from './ChatStream';
import { InputArea } from './InputArea';
import { Footer } from './Footer';
import { Sidebar } from './Sidebar';
import { LeftSidebar } from './LeftSidebar';
import { CommandPalette } from './CommandPalette';
import { ShortcutsHelp } from './ShortcutsHelp';
import { SessionHeader } from './SessionHeader';

/** Flatten every chain's messages for the center pane (chronological). */
function messagesFromSession(loaded: Session): Message[] {
  return loaded.chains.flatMap((chain) => [...chain.messages]);
}

type ToastSeverity = 'info' | 'warning' | 'error';
interface Toast {
  message: string;
  severity: ToastSeverity;
}

export function ChatView() {
  const session = useSession();
  const chat = useChat(session.activeSession?.id ?? null);
  const subagents = useSubagents(session.activeSession?.id ?? null);
  const todos = useTodos(session.activeSession?.id ?? null);
  const activity = useSessionActivity();

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [leftSidebarCollapsed, setLeftSidebarCollapsed] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [mcpServers, setMcpServers] = useState<MCPServerStatus[]>([]);
  const [ragStatus, setRagStatus] = useState<RAGStoreStatus | null>(null);
  const [astStatus, setAstStatus] = useState<ASTStoreStatus | null>(null);
  const [currentTheme, setCurrentTheme] = useState('default');
  const [currentPersonality, setCurrentPersonality] = useState('default');
  const [personalityNames, setPersonalityNames] = useState<string[]>([]);
  const [currentModel, setCurrentModel] = useState('');
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [maxContext, setMaxContext] = useState<number | null>(null);
  const [alwaysExpandToolGroups, setAlwaysExpandToolGroups] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Guards against out-of-order session:load responses overwriting a newer pick.
  const sessionSwitchGen = useRef(0);
  const didAutoSelect = useRef(false);

  useEffect(() => {
    const sessionId = session.activeSession?.id;
    if (!sessionId) return undefined;
    const markSeen = () => {
      if (document.visibilityState === 'visible') {
        void activity.markSeen(sessionId);
      }
    };
    markSeen();
    window.addEventListener('focus', markSeen);
    return () => window.removeEventListener('focus', markSeen);
  }, [session.activeSession?.id, activity.markSeen]);

  const toggleSidebar = useCallback(() => {
    setSidebarOpen((prev) => !prev);
  }, []);

  const toggleLeftSidebar = useCallback(() => {
    setLeftSidebarCollapsed((prev) => !prev);
  }, []);

  const togglePalette = useCallback(() => {
    setHelpOpen(false);
    setPaletteOpen((prev) => !prev);
  }, []);

  const toggleHelp = useCallback(() => {
    setPaletteOpen(false);
    setHelpOpen((prev) => !prev);
  }, []);

  const openSettings = useCallback(() => {
    window.dispatchEvent(new CustomEvent('orchid:open-settings'));
  }, []);

  useEffect(() => {
    async function loadConfig() {
      try {
        if (window.orchid?.config?.get) {
          const config = await window.orchid.config.get();
          if (config.theme) setCurrentTheme(config.theme);
          if (config.personality) setCurrentPersonality(config.personality);
          if (config.default_model) setCurrentModel(config.default_model);
          setAlwaysExpandToolGroups(Boolean(config.always_expand_tool_groups));
          // Same model list as config dropdowns (General / Tier Models)
          const { collectModelsFromProviders } = await import('../utils/models');
          setAvailableModels(
            collectModelsFromProviders(
              config.providers as Record<string, Record<string, unknown>>,
            ),
          );
        }
        if (window.orchid?.config?.listPersonalities) {
          const names = await window.orchid.config.listPersonalities();
          setPersonalityNames(names);
        }
      } catch {
        // Non-fatal
      }
    }
    loadConfig();
  }, []);

  // Prefer live config updates after Settings save (tool-group expand pref).
  useEffect(() => {
    const onConfigUpdated = (event: Event) => {
      const detail = (event as CustomEvent<Record<string, unknown>>).detail;
      if (detail && typeof detail.always_expand_tool_groups === 'boolean') {
        setAlwaysExpandToolGroups(detail.always_expand_tool_groups);
      }
    };
    window.addEventListener('orchid:config-updated', onConfigUpdated);
    return () => window.removeEventListener('orchid:config-updated', onConfigUpdated);
  }, []);

  // Keep composer model label in sync when switching sessions
  useEffect(() => {
    if (session.activeSession?.model) {
      setCurrentModel(session.activeSession.model);
    }
  }, [session.activeSession?.id, session.activeSession?.model]);

  // Refresh personality list + models when the palette opens
  useEffect(() => {
    if (!paletteOpen) return;
    let cancelled = false;
    if (window.orchid?.config?.listPersonalities) {
      window.orchid.config.listPersonalities().then((names) => {
        if (!cancelled) setPersonalityNames(names);
      }).catch(() => { /* non-fatal */ });
    }
    if (window.orchid?.config?.get) {
      window.orchid.config.get().then((config) => {
        if (cancelled) return;
        void import('../utils/models').then(({ collectModelsFromProviders }) => {
          if (cancelled) return;
          setAvailableModels(
            collectModelsFromProviders(
              config.providers as Record<string, Record<string, unknown>>,
            ),
          );
        });
      }).catch(() => { /* non-fatal */ });
    }
    return () => { cancelled = true; };
  }, [paletteOpen]);

  const applySessionMessages = useCallback(
    (loadedSession: Session | null) => {
      if (!loadedSession) {
        chat.setMessages([]);
        return;
      }
      chat.setMessages(messagesFromSession(loadedSession));
    },
    [chat],
  );

  const handleSessionSelect = useCallback(
    async (id: string) => {
      // Skip no-op re-select of the already active session (still allow
      // re-click to refresh if desired — always reload for correctness).
      const gen = ++sessionSwitchGen.current;

      // Optimistically clear the pane so stale messages never linger while
      // the next session loads (or if load fails).
      chat.setMessages([]);

      const loadedSession = await session.load(id);
      // A newer click/create won the race — drop this result.
      if (gen !== sessionSwitchGen.current) {
        return;
      }
      if (!loadedSession) {
        console.error('Failed to load session:', id);
        return;
      }
      applySessionMessages(loadedSession);

      // Returning to a running session needs the main process's latest state,
      // not only persisted chain messages. The snapshot's sequence lets the
      // hook reject delayed events that were already included in this view.
      const snapshot = await chat.getSnapshot(loadedSession.id);
      if (gen !== sessionSwitchGen.current) {
        return;
      }
      chat.hydrateSnapshot(snapshot);
    },
    [session, chat, applySessionMessages],
  );

  // New chat: enter draft mode (no disk file). Session is created on first send.
  const handleSessionCreate = useCallback(async () => {
    const gen = ++sessionSwitchGen.current;
    chat.setMessages([]);
    await session.enterDraft();
    if (gen !== sessionSwitchGen.current) {
      return;
    }
    // Ensure empty pane after draft clear (enterDraft does not load messages).
    applySessionMessages(null);
  }, [session, chat, applySessionMessages]);

  // Auto-select the most recent session on first list load so the UI isn't
  // stuck with an empty pane while sessions exist in the sidebar.
  useEffect(() => {
    if (didAutoSelect.current) return;
    if (session.activeSession) {
      didAutoSelect.current = true;
      return;
    }
    if (session.listState.status !== 'ready' && session.listState.status !== 'partial') {
      return;
    }
    const first = session.listState.sessions[0];
    if (!first) {
      didAutoSelect.current = true;
      return;
    }
    didAutoSelect.current = true;
    void handleSessionSelect(first.id);
  }, [session.listState, session.activeSession, handleSessionSelect]);

  // When the active session is deleted, clear the chat pane and open another.
  const handleSessionDelete = useCallback(
    async (id: string) => {
      const wasActive = session.activeSession?.id === id;
      await session.deleteSession(id);
      if (!wasActive) return;

      const gen = ++sessionSwitchGen.current;
      chat.setMessages([]);

      // Re-fetch the list after delete (closure listState may be stale).
      try {
        const remaining = window.orchid?.session?.list
          ? await window.orchid.session.list()
          : [];
        if (gen !== sessionSwitchGen.current) return;
        if (remaining[0]) {
          void handleSessionSelect(remaining[0].id);
        }
      } catch {
        // Non-fatal — pane already cleared
      }
    },
    [session, chat, handleSessionSelect],
  );

  const notify = useCallback((message: string, severity: ToastSeverity = 'info') => {
    console.log(`[${severity.toUpperCase()}] ${message}`);
    if (severity === 'error') {
      console.error(message);
    }
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ message, severity });
    toastTimer.current = setTimeout(() => setToast(null), 4500);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  // null workspace = still loading; allow send (main process still gates).
  // unbound/missing = block in UI (R3).
  const workspaceBound =
    session.workspace == null || session.workspace.status === 'valid';

  const handlePickProjectDir = useCallback(async () => {
    const startsDraft = Boolean(session.activeSession?.chains.length);
    const info = await session.pickProjectDir();
    if (info?.status === 'valid' && info.cwd) {
      if (startsDraft) {
        ++sessionSwitchGen.current;
        chat.setMessages([]);
        applySessionMessages(null);
        notify(`New chat in project: ${info.cwd}`, 'info');
      } else {
        notify(`Project folder: ${info.cwd}`, 'info');
      }
    }
  }, [session, chat, applySessionMessages, notify]);

  const handleSend = useCallback(
    async (message: string) => {
      // UI gate (R3): reinforce main-process unbound_workspace rejection.
      if (!workspaceBound) {
        notify(
          'Choose a project folder before sending a message.',
          'warning',
        );
        void handlePickProjectDir();
        return;
      }
      const preferredModel =
        session.activeSession?.model || currentModel || undefined;
      await chat.send(message, {
        ...(preferredModel ? { model: preferredModel } : {}),
        ...(session.activeSession?.id
          ? { sessionId: session.activeSession.id }
          : {}),
      });
    },
    [
      chat,
      session.activeSession?.id,
      session.activeSession?.model,
      currentModel,
      workspaceBound,
      notify,
      handlePickProjectDir,
    ],
  );

  const handleRetry = useCallback(async () => {
    // Re-send the last user message after an error
    const lastUser = [...chat.messages]
      .reverse()
      .find((m) => m.role === 'user' && !m.hidden && Boolean(m.content?.trim()));
    if (!lastUser?.content) return;
    chat.clearError();
    await handleSend(lastUser.content);
  }, [chat, handleSend]);

  const sessionSwitchHandlers = useMemo(() => {
    const handlers: Record<string, (event: KeyboardEvent) => void> = {};
    for (let n = 1; n <= 9; n++) {
      handlers[`session.switch.${n}`] = () => {
        const list =
          session.listState.status === 'ready' || session.listState.status === 'partial'
            ? session.listState.sessions
            : [];
        const target = list[n - 1];
        if (target) void handleSessionSelect(target.id);
      };
    }
    return handlers;
  }, [session.listState, handleSessionSelect]);

  const shortcutHandlers = useMemo(
    () => ({
      'palette.toggle': () => togglePalette(),
      'shortcuts.help': () => toggleHelp(),
      'settings.open': () => openSettings(),
      'session.new': () => {
        void handleSessionCreate();
      },
      'inspector.toggle': () => toggleSidebar(),
      'sessionsRail.toggle': () => toggleLeftSidebar(),
      ...sessionSwitchHandlers,
    }),
    [
      togglePalette,
      toggleHelp,
      openSettings,
      handleSessionCreate,
      toggleSidebar,
      toggleLeftSidebar,
      sessionSwitchHandlers,
    ],
  );

  const shortcutGate = useCallback(
    (id: string) => {
      // Always allow palette / help toggles (they close themselves).
      if (id === 'palette.toggle' || id === 'shortcuts.help') return true;
      // Suppress other globals while overlays own the keyboard.
      if (paletteOpen || helpOpen) return false;
      return true;
    },
    [paletteOpen, helpOpen],
  );

  useGlobalShortcuts({
    handlers: shortcutHandlers,
    isEnabled: shortcutGate,
  });

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

  const handleIndexAST = useCallback(async () => {
    if (!window.orchid?.ast?.index) {
      throw new Error('AST IPC is not available');
    }
    const result = await window.orchid.ast.index();
    await refreshIndex();
    if (result?.errors && result.errors.length > 0) {
      throw new Error(result.errors[0] ?? 'AST indexing reported errors');
    }
  }, [refreshIndex]);

  useEffect(() => {
    refreshMCP();
    refreshIndex();
  }, [refreshMCP, refreshIndex]);

  // Re-fetch RAG/AST status when the active workspace changes (counts are
  // project-scoped; no manual reload control in the inspector).
  const workspaceCwd = session.activeSession?.cwd ?? null;
  useEffect(() => {
    void refreshIndex();
  }, [workspaceCwd, refreshIndex]);

  // MCP starts in the background after the window opens, so the first status
  // snapshot often lands on "starting". Poll until every server leaves that
  // state (connected / failed / unavailable) so the right sidebar updates.
  useEffect(() => {
    const stillStarting = mcpServers.some((s) => s.status === 'starting');
    if (!stillStarting) return;
    const id = setInterval(() => {
      void refreshMCP();
    }, 1500);
    return () => clearInterval(id);
  }, [mcpServers, refreshMCP]);

  // After a turn completes (or session switches), refresh subagents so chain
  // footers pick up token usage written into subagent_chains.
  useEffect(() => {
    if (chat.status !== 'idle') return;
    if (!session.activeSession?.id) return;
    void subagents.refresh();
  }, [chat.status, chat.messages.length, session.activeSession?.id, subagents.refresh]);

  const commandContext: CommandContext = {
    onCreateSession: handleSessionCreate,
    onLoadSession: handleSessionSelect,
    onDeleteSession: session.deleteSession,
    onRenameSession: session.rename,
    getActiveSessionId: () => session.activeSession?.id ?? null,
    getActiveSessionName: () => session.activeSession?.name ?? null,
    onSetTheme: async (name: string) => {
      setCurrentTheme(name);
      // Live apply in App (applyTheme + persist). Avoid importing App here (circular).
      window.dispatchEvent(
        new CustomEvent('orchid:set-theme', { detail: { theme: name } }),
      );
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
    onSetModel: async (model: string) => {
      setCurrentModel(model);
      const sessionId = session.activeSession?.id;
      if (sessionId) {
        try {
          await session.changeModel(sessionId, model);
        } catch (err) {
          console.error('Failed to change session model:', err);
          notify(
            err instanceof Error ? err.message : 'Failed to change model',
            'error',
          );
        }
      } else {
        // No session yet — persist as default model for next session
        try {
          if (window.orchid?.config?.save) {
            await window.orchid.config.save({ updates: { default_model: model } });
          }
        } catch {
          // Non-fatal
        }
      }
    },
    getAvailableModels: () => availableModels,
    getCurrentModel: () =>
      session.activeSession?.model || currentModel || '',
    onOpenSettings: () => {
      openSettings();
    },
    onPickProjectDir: handlePickProjectDir,
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
        throw err;
      }
    },
    onNotify: notify,
    onClose: () => setPaletteOpen(false),
  };

  const model = session.activeSession?.model ?? currentModel ?? '';

  useEffect(() => {
    if (!model || !window.orchid?.config?.modelMetadata) {
      setMaxContext(null);
      return;
    }
    let cancelled = false;
    window.orchid.config.modelMetadata(model).then((meta) => {
      if (!cancelled) setMaxContext(meta?.max_input_tokens ?? null);
    }).catch(() => {
      if (!cancelled) setMaxContext(null);
    });
    return () => { cancelled = true; };
  }, [model]);

  const sessions =
    session.listState.status === 'ready' || session.listState.status === 'partial'
      ? session.listState.sessions
      : [];

  const leftCol = leftSidebarCollapsed ? '56px' : '260px';
  const rightCol = sidebarOpen ? '300px' : '48px';

  return (
    <div
      className="app-frame grid h-screen min-h-0 overflow-hidden bg-base-100 text-base-content"
      style={{ gridTemplateColumns: `${leftCol} minmax(460px, 1fr) ${rightCol}` }}
    >
      <LeftSidebar
        activeSessionId={session.activeSession?.id ?? null}
        isCollapsed={leftSidebarCollapsed}
        onOpenSettings={openSettings}
        onPickProjectDir={() => {
          void handlePickProjectDir();
        }}
        projectPickerCreatesDraft={Boolean(session.activeSession?.chains.length)}
        onRefreshSessions={session.refresh}
        onSessionCreate={handleSessionCreate}
        onSessionDelete={handleSessionDelete}
        onSessionSelect={handleSessionSelect}
        activities={activity.activities}
        onStopSession={(sessionId) => {
          void chat.stop(sessionId);
        }}
        onToggle={toggleLeftSidebar}
        sessionListState={session.listState}
        workspace={session.workspace}
      />

      <main className="main-pane min-h-0 min-w-0 overflow-hidden">
        {toast && (
          <div
            className={`command-toast command-toast-${toast.severity}`}
            role="status"
            aria-live="polite"
          >
            <span className="command-toast-message">{toast.message}</span>
            <button
              type="button"
              className="command-toast-dismiss"
              onClick={() => setToast(null)}
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        )}
        <SessionHeader
          session={session.activeSession}
          workspace={session.workspace}
        />
        <ChatStream
          messages={chat.messages}
          streamingContent={chat.streamingContent}
          toolBlocks={chat.toolBlocks}
          streamSegments={chat.streamSegments}
          status={chat.status}
          error={chat.error}
          usage={chat.usage}
          subagents={subagents.subagents}
          sessionChains={session.activeSession?.chains ?? []}
          sessionId={session.activeSession?.id ?? null}
          onClearError={chat.clearError}
          onOpenSettings={openSettings}
          onPickProjectDir={
            workspaceBound
              ? undefined
              : () => {
                  void handlePickProjectDir();
                }
          }
          workspaceUnbound={!workspaceBound}
          onRetry={handleRetry}
          elapsedSeconds={chat.elapsedSeconds}
          interrupted={chat.interrupted}
          alwaysExpandToolGroups={alwaysExpandToolGroups}
        />
        <InputArea
          status={chat.status}
          model={model}
          interruptState={chat.interruptState}
          onSend={handleSend}
          onCancel={chat.cancel}
          commandContext={commandContext}
          sessions={sessions}
          currentTheme={currentTheme}
          currentPersonality={currentPersonality}
          personalityNames={personalityNames}
          workspaceBound={workspaceBound}
          onPickProjectDir={() => {
            void handlePickProjectDir();
          }}
        />
        <Footer
          elapsedSeconds={chat.elapsedSeconds}
          isStreaming={chat.status === 'streaming'}
          interruptState={chat.interruptState}
          usage={chat.usage}
          maxContext={maxContext}
          messages={chat.messages}
        />
      </main>

      <Sidebar
        isOpen={sidebarOpen}
        onToggle={toggleSidebar}
        title={session.activeSession?.name ?? 'Orchid'}
        subagentState={subagents.state}
        onRefreshSubagents={subagents.refresh}
        selectedSubagentId={subagents.selectedId}
        onSelectSubagent={subagents.select}
        getSubagentDetail={subagents.getDetail}
        todoState={todos.state}
        onRefreshTodos={todos.refresh}
        mcpServers={mcpServers}
        ragStatus={ragStatus}
        astStatus={astStatus}
        onIndexRAG={handleIndexRAG}
        onIndexAST={handleIndexAST}
        onRefreshIndex={refreshIndex}
        usage={chat.usage}
        cumulativeUsage={chat.cumulativeUsage}
        maxContext={maxContext}
        messages={chat.messages}
        cwd={session.workspace?.cwd ?? chat.cwd}
      />

      <CommandPalette
        isOpen={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        context={commandContext}
        sessions={sessions}
        currentTheme={currentTheme}
        currentPersonality={currentPersonality}
        personalityNames={personalityNames}
      />

      <ShortcutsHelp isOpen={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  );
}
