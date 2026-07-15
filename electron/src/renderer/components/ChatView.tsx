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
import { useSessionTabs } from '../hooks/useSessionTabs';
import { useProviders } from '../hooks/useProviders';
import {
  providerModelOptionDisplayName,
  providerModelOptionKey,
  providerModelOptionLabel,
  selectionMatchesOption,
} from '../utils/provider-selection';
import { isTextGenerationModel } from '../utils/models';
import { useGlobalShortcuts } from '../keyboard';
import type { ModelSelection } from '../../shared/types/provider';
import { flattenSessionMessages, type Session } from '../../shared/types/session';
import type { MCPServerStatus, RAGStoreStatus, ASTStoreStatus, CommandContext } from '../../shared/types/ipc-boundary';
import type { ProviderModelOption } from '../../shared/types/ipc';
import { ChatStream } from './ChatStream';
import { InputArea } from './InputArea';
import { Footer } from './Footer';
import { Sidebar } from './Sidebar';
import { LeftSidebar } from './LeftSidebar';
import { CommandPalette } from './CommandPalette';
import { ShortcutsHelp } from './ShortcutsHelp';
import { SessionHeader } from './session-header';
import { SessionTabBar } from './SessionTabBar';

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
  const tabs = useSessionTabs();
  const providers = useProviders();

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [leftSidebarCollapsed, setLeftSidebarCollapsed] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [closeConfirmId, setCloseConfirmId] = useState<string | null>(null);
  const [draftTabVisible, setDraftTabVisible] = useState(false);
  const [composerDraftKey, setComposerDraftKey] = useState(0);
  const [mcpServers, setMcpServers] = useState<MCPServerStatus[]>([]);
  const [ragStatus, setRagStatus] = useState<RAGStoreStatus | null>(null);
  const [astStatus, setAstStatus] = useState<ASTStoreStatus | null>(null);
  const [currentTheme, setCurrentTheme] = useState('default');
  const [currentPersonality, setCurrentPersonality] = useState('default');
  const [personalityNames, setPersonalityNames] = useState<string[]>([]);
  const [currentSelection, setCurrentSelection] = useState<ModelSelection | null>(null);
  const [providerModelOptions, setProviderModelOptions] = useState<readonly ProviderModelOption[]>([]);
  const [maxContext, setMaxContext] = useState<number | null>(null);
  const [alwaysExpandToolGroups, setAlwaysExpandToolGroups] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Guards against out-of-order session:load responses overwriting a newer pick.
  const sessionSwitchGen = useRef(0);
  const didBootstrapTabs = useRef(false);

  const connectionStateSignature = useMemo(
    () => providers.overview?.connections
      .map((connection) => `${connection.id}:${connection.health}:${connection.modelIds.join(',')}`)
      .sort()
      .join('|') ?? '',
    [providers.overview?.connections],
  );

  useEffect(() => {
    if (!providers.overview) {
      setProviderModelOptions([]);
      return;
    }
    let cancelled = false;
    void providers.modelList().then((options) => {
      if (!cancelled) setProviderModelOptions(options);
    }).catch(() => {
      if (!cancelled) setProviderModelOptions([]);
    });
    return () => { cancelled = true; };
  }, [connectionStateSignature, providers.modelList, providers.overview]);

  useEffect(() => {
    const refreshProviders = () => {
      void providers.refresh();
    };
    window.addEventListener('orchid:providers-updated', refreshProviders);
    return () => window.removeEventListener('orchid:providers-updated', refreshProviders);
  }, [providers.refresh]);

  useEffect(() => {
    const applyCreatedSelection = (event: Event) => {
      const selection = (event as CustomEvent<{ selection?: ModelSelection }>).detail?.selection;
      if (!selection) return;
      setCurrentSelection({
        connectionId: selection.connectionId,
        modelId: selection.modelId,
      });
      if (session.activeSession?.id) {
        void session.changeModel(session.activeSession.id, selection, selection.modelId);
      }
      void providers.refresh();
    };
    window.addEventListener('orchid:provider-selection-created', applyCreatedSelection);
    return () => window.removeEventListener('orchid:provider-selection-created', applyCreatedSelection);
  }, [providers.refresh, session.activeSession?.id, session.changeModel]);

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
          if (config.default_model) {
            setCurrentSelection(config.default_model);
          }
          setAlwaysExpandToolGroups(Boolean(config.always_expand_tool_groups));
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
      if (detail && 'default_model' in detail) {
        setCurrentSelection(detail.default_model as ModelSelection | null);
      }
    };
    window.addEventListener('orchid:config-updated', onConfigUpdated);
    return () => window.removeEventListener('orchid:config-updated', onConfigUpdated);
  }, []);

  // Keep composer model label in sync when switching sessions
  useEffect(() => {
    setCurrentSelection(session.activeSession?.selection ?? null);
  }, [session.activeSession?.id, session.activeSession?.selection, session.activeSession?.modelLabel]);

  // Refresh personality list when the palette opens.
  useEffect(() => {
    if (!paletteOpen) return;
    let cancelled = false;
    if (window.orchid?.config?.listPersonalities) {
      window.orchid.config.listPersonalities().then((names) => {
        if (!cancelled) setPersonalityNames(names);
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
      chat.setMessages(flattenSessionMessages(loadedSession));
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

  const enterDraftMode = useCallback(async (opts?: { clearComposer?: boolean }) => {
    const gen = ++sessionSwitchGen.current;
    chat.setMessages([]);
    await session.enterDraft();
    if (gen !== sessionSwitchGen.current) return;
    applySessionMessages(null);
    setDraftTabVisible(true);
    if (opts?.clearComposer) {
      setComposerDraftKey((k) => k + 1);
    }
  }, [session, chat, applySessionMessages]);

  // New chat: draft in the currently selected project. Never open a folder
  // picker here — inherit session.cwd → workspace.cwd → sticky default.
  // Without a bound project, stay draft-unbound until the user picks a folder.
  const handleSessionCreate = useCallback(async () => {
    const gen = ++sessionSwitchGen.current;
    const inheritCwd =
      session.activeSession?.cwd?.trim() ||
      (session.workspace?.status === 'valid' ? session.workspace.cwd : null);
    if (inheritCwd) {
      const workspace = await session.setWorkspace(inheritCwd);
      if (gen !== sessionSwitchGen.current) return;
      if (!workspace?.cwd) {
        applySessionMessages(null);
        return;
      }
    }
    await enterDraftMode({ clearComposer: true });
  }, [session, enterDraftMode, applySessionMessages]);

  // Project-row New Chat: make that project the window's draft workspace, then
  // clear selection. The first message creates a new session there while any
  // previous conversation keeps running in its own project.
  const handleProjectSessionCreate = useCallback(async (projectDir: string) => {
    const gen = ++sessionSwitchGen.current;
    const workspace = await session.setWorkspace(projectDir);
    if (!workspace?.cwd || gen !== sessionSwitchGen.current) return;
    await enterDraftMode({ clearComposer: true });
    setToast({
      severity: 'info',
      message: `New chat in project: ${workspace.cwd}`,
    });
  }, [session, enterDraftMode]);

  // Project header click: select the project itself (draft bound to it) without
  // loading the first session in that group.
  const handleProjectSelect = useCallback(async (projectDir: string) => {
    const gen = ++sessionSwitchGen.current;
    const workspace = await session.setWorkspace(projectDir);
    if (!workspace?.cwd || gen !== sessionSwitchGen.current) return;
    await enterDraftMode({ clearComposer: true });
  }, [session, enterDraftMode]);

  // Restore durable open tabs (or empty draft) instead of auto-picking library[0].
  useEffect(() => {
    if (didBootstrapTabs.current) return;
    if (!tabs.ready) return;
    if (
      session.listState.status !== 'ready' &&
      session.listState.status !== 'partial' &&
      session.listState.status !== 'empty'
    ) {
      return;
    }
    // User already navigated before restore finished — do not clobber.
    if (sessionSwitchGen.current > 0 || session.activeSession) {
      didBootstrapTabs.current = true;
      return;
    }

    didBootstrapTabs.current = true;
    const openIds = tabs.snapshot.openSessionIds;
    const focusId =
      tabs.snapshot.focusedSessionId && openIds.includes(tabs.snapshot.focusedSessionId)
        ? tabs.snapshot.focusedSessionId
        : tabs.snapshot.mruSessionIds.find((id) => openIds.includes(id)) ?? openIds[0] ?? null;
    if (focusId) {
      void handleSessionSelect(focusId);
      setDraftTabVisible(false);
      return;
    }
    void enterDraftMode();
  }, [tabs.ready, tabs.snapshot, session.listState, session.activeSession, handleSessionSelect, enterDraftMode]);

  useEffect(() => {
    if (session.activeSession?.id) {
      setDraftTabVisible(false);
    }
  }, [session.activeSession?.id]);

  const isLiveSession = useCallback(
    (id: string) => {
      // Prefer activity store; also treat focused streaming chat as live so
      // confirm still fires if the activity broadcast has not arrived yet.
      const a = activity.activities.find((row) => row.sessionId === id);
      if (a && (a.state === 'working' || a.state === 'waiting' || a.state === 'needs_attention')) {
        return true;
      }
      if (a?.canCancel) return true;
      // Focused session currently streaming — cover activity broadcast lag.
      if (session.activeSession?.id === id && chat.status === 'streaming') {
        return true;
      }
      return false;
    },
    [activity.activities, session.activeSession?.id, chat.status],
  );

  const focusAfterWorkingSet = useCallback(
    async (snapshot: { focusedSessionId: string | null; openSessionIds: readonly string[] }) => {
      const nextId = snapshot.focusedSessionId;
      if (nextId) {
        setDraftTabVisible(false);
        await handleSessionSelect(nextId);
        return;
      }
      await enterDraftMode();
    },
    [handleSessionSelect, enterDraftMode],
  );

  const performCloseTab = useCallback(
    async (id: string) => {
      const wasFocused = session.activeSession?.id === id;
      const snapshot = await tabs.closeTab(id);
      if (wasFocused) {
        await focusAfterWorkingSet(snapshot);
      }
    },
    [tabs, session.activeSession?.id, focusAfterWorkingSet],
  );

  const requestCloseTab = useCallback(
    (id: string) => {
      if (isLiveSession(id)) {
        setCloseConfirmId(id);
        return;
      }
      void performCloseTab(id);
    },
    [isLiveSession, performCloseTab],
  );

  // When the active session is deleted, follow MRU among remaining open tabs.
  const handleSessionDelete = useCallback(
    async (id: string) => {
      const wasActive = session.activeSession?.id === id;
      await session.deleteSession(id);
      const snapshot = await tabs.refresh();
      if (!wasActive) return;

      const gen = ++sessionSwitchGen.current;
      chat.setMessages([]);
      if (gen !== sessionSwitchGen.current) return;
      await focusAfterWorkingSet(snapshot);
    },
    [session, chat, tabs, focusAfterWorkingSet],
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

  const availableProviderModels = useMemo(
    () => providerModelOptions.filter((option) => option.available && isTextGenerationModel(option.model)),
    [providerModelOptions],
  );
  const chatProviderModels = useMemo(
    () => providerModelOptions.filter((option) => isTextGenerationModel(option.model)),
    [providerModelOptions],
  );
  const providerModelByKey = useMemo(
    () => new Map(chatProviderModels.map((option) => [providerModelOptionKey(option), option])),
    [chatProviderModels],
  );
  const providerModelLabels = useMemo(
    () => Object.fromEntries(chatProviderModels.map((option) => [
      providerModelOptionKey(option),
      providerModelOptionDisplayName(option),
    ])),
    [chatProviderModels],
  );
  const providerModelDetails = useMemo(
    () => Object.fromEntries(chatProviderModels.map((option) => [providerModelOptionKey(option), option])),
    [chatProviderModels],
  );
  const preferredSelection = session.activeSession?.selection ?? currentSelection;
  const selectedProviderModel = preferredSelection
    ? chatProviderModels.find((option) => selectionMatchesOption(preferredSelection, option)) ?? null
    : null;
  const providerAvailable = providers.hasUsableConnection;
  const modelSelected = selectedProviderModel?.available === true;
  const providerPickerValue = selectedProviderModel ? providerModelOptionKey(selectedProviderModel) : '';

  const handlePickProjectDir = useCallback(async () => {
    const startsDraft = Boolean(session.activeSession?.chains.length);
    const info = await session.pickProjectDir();
    if (info?.status === 'valid' && info.cwd) {
      if (startsDraft) {
        ++sessionSwitchGen.current;
        chat.setMessages([]);
        applySessionMessages(null);
        setDraftTabVisible(true);
        setComposerDraftKey((k) => k + 1);
        notify(`New chat in project: ${info.cwd}`, 'info');
      } else {
        notify(`Project folder: ${info.cwd}`, 'info');
      }
    }
  }, [session, chat, applySessionMessages, notify]);

  const handleSelectProviderModel = useCallback(async (key: string) => {
    const option = providerModelByKey.get(key);
    if (!option || !option.available) {
      notify('That connection and model are not available. Reconnect it or choose another model.', 'warning');
      return;
    }
    const selection: ModelSelection = {
      connectionId: option.selection.connectionId,
      modelId: option.selection.modelId,
    };
    setCurrentSelection(selection);
    if (session.activeSession?.id) {
      await session.changeModel(
        session.activeSession.id,
        selection,
        providerModelOptionLabel(option),
      );
    }
  }, [notify, providerModelByKey, session]);

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
      if (!providerAvailable) {
        notify('Connect a provider in Settings before sending a message.', 'warning');
        window.dispatchEvent(new CustomEvent('orchid:open-settings', { detail: { tab: 'providers' } }));
        return;
      }
      if (!preferredSelection || !modelSelected) {
        notify('Select a ready connection and model before sending a message.', 'warning');
        return;
      }
      await chat.send(message, {
        ...(preferredSelection ? { model: preferredSelection } : {}),
        ...(session.activeSession?.id
          ? { sessionId: session.activeSession.id }
          : { draftGeneration: session.draftGeneration }),
      });
    },
    [
      chat,
      session.activeSession?.id,
      session.activeSession?.selection,
      session.draftGeneration,
      currentSelection,
      workspaceBound,
      providerAvailable,
      modelSelected,
      preferredSelection,
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
        const targetId = tabs.snapshot.openSessionIds[n - 1];
        if (targetId) {
          setDraftTabVisible(false);
          void handleSessionSelect(targetId);
        }
      };
    }
    return handlers;
  }, [tabs.snapshot.openSessionIds, handleSessionSelect]);

  const leaveDraftToOpenTab = useCallback(async () => {
    const openIds = tabs.snapshot.openSessionIds;
    if (openIds.length === 0) {
      // Empty working set: draft is the only surface — keep it visible.
      setDraftTabVisible(true);
      return;
    }
    const mru = tabs.snapshot.mruSessionIds.find((id) => openIds.includes(id));
    const nextId = mru ?? openIds[openIds.length - 1] ?? openIds[0];
    setDraftTabVisible(false);
    setComposerDraftKey((k) => k + 1);
    await handleSessionSelect(nextId);
  }, [tabs.snapshot, handleSessionSelect]);

  const handleCloseFocusedTab = useCallback(() => {
    if (draftTabVisible && !session.activeSession) {
      void leaveDraftToOpenTab();
      return;
    }
    const id = session.activeSession?.id ?? tabs.snapshot.focusedSessionId;
    if (id) requestCloseTab(id);
  }, [
    draftTabVisible,
    session.activeSession,
    tabs.snapshot.focusedSessionId,
    requestCloseTab,
    leaveDraftToOpenTab,
  ]);

  const shortcutHandlers = useMemo(
    () => ({
      'palette.toggle': () => togglePalette(),
      'shortcuts.help': () => toggleHelp(),
      'settings.open': () => openSettings(),
      'session.new': () => {
        void handleSessionCreate();
      },
      'session.tab.close': () => {
        handleCloseFocusedTab();
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
      handleCloseFocusedTab,
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
    onSetModel: handleSelectProviderModel,
    getAvailableModels: () => availableProviderModels.map(providerModelOptionKey),
    getCurrentModel: () => providerPickerValue,
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

  const model = session.activeSession?.selection?.modelId ?? currentSelection?.modelId ?? '';

  useEffect(() => {
    if (selectedProviderModel) {
      setMaxContext(selectedProviderModel.model.limits?.contextTokens ?? null);
      return;
    }
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
  }, [model, selectedProviderModel]);

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
        selectedProjectPath={
          session.activeSession?.cwd ??
          (session.workspace?.status === 'valid' ? session.workspace.cwd : null)
        }
        isCollapsed={leftSidebarCollapsed}
        onOpenSettings={openSettings}
        onPickProjectDir={() => {
          void handlePickProjectDir();
        }}
        projectPickerCreatesDraft={Boolean(session.activeSession?.chains.length)}
        onRefreshSessions={session.refresh}
        onSessionCreate={() => {
          void handleSessionCreate();
        }}
        onProjectSessionCreate={(projectDir) => {
          void handleProjectSessionCreate(projectDir);
        }}
        onProjectSelect={(projectDir) => {
          void handleProjectSelect(projectDir);
        }}
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
        <SessionTabBar
          openSessionIds={tabs.snapshot.openSessionIds}
          focusedSessionId={tabs.snapshot.focusedSessionId}
          sessions={
            session.listState.status === 'ready' || session.listState.status === 'partial'
              ? session.listState.sessions
              : []
          }
          activities={activity.activities}
          showDraft={draftTabVisible && !session.activeSession}
          draftLabel="New chat"
          draftProjectName={
            session.workspace?.cwd
              ? session.workspace.cwd.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? null
              : null
          }
          onSelect={(id) => {
            setDraftTabVisible(false);
            void handleSessionSelect(id);
          }}
          onSelectDraft={() => {
            void enterDraftMode();
          }}
          onClose={requestCloseTab}
          onCloseDraft={() => {
            void leaveDraftToOpenTab();
          }}
        />
        <SessionHeader
          session={session.activeSession}
          workspace={session.workspace}
        />
        {closeConfirmId ? (
          <div className="session-tab-confirm" role="alertdialog" aria-modal="true">
            <div className="session-tab-confirm-card">
              <p className="session-tab-confirm-text">
                This session is still running. Close the tab and keep the agent working in the background?
              </p>
              <div className="session-tab-confirm-actions">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setCloseConfirmId(null)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => {
                    const id = closeConfirmId;
                    setCloseConfirmId(null);
                    if (id) void performCloseTab(id);
                  }}
                >
                  Close tab
                </button>
              </div>
            </div>
          </div>
        ) : null}
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
          key={composerDraftKey}
          status={chat.status}
          model={providerPickerValue}
          modelLabels={providerModelLabels}
          modelDetails={providerModelDetails}
          interruptState={chat.interruptState}
          onSend={handleSend}
          onCancel={chat.cancel}
          commandContext={commandContext}
          sessions={sessions}
          currentTheme={currentTheme}
          currentPersonality={currentPersonality}
          personalityNames={personalityNames}
          workspaceBound={workspaceBound}
          providerAvailable={providerAvailable}
          modelSelected={modelSelected}
          onOpenProviders={() => {
            window.dispatchEvent(new CustomEvent('orchid:open-settings', { detail: { tab: 'providers' } }));
          }}
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
