/**
 * ChatView — main chat layout combining ChatStream, InputArea, Footer, Sidebar.
 *
 * Iteration 012 three-panel shell: left sessions | center chat | right inspector.
 */
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useChat } from '../hooks/useChat';
import { useSession } from '../hooks/useSession';
import { useSubagents } from '../hooks/useSubagents';
import { useTodos } from '../hooks/useTodos';
import { useSessionActivity } from '../hooks/useSessionActivity';
import { useSessionTabs } from '../hooks/useSessionTabs';
import { useProviders } from '../hooks/useProviders';
import { useMessageQueue } from '../hooks/useMessageQueue';
import { useQueueAutoFire } from '../hooks/useQueueAutoFire';
import { useResponsiveShell } from '../hooks/use-responsive-shell';
import {
  providerModelOptionDisplayName,
  providerModelOptionKey,
  providerModelOptionLabel,
  selectionMatchesOption,
} from '../utils/provider-selection';
import { isTextGenerationModel } from '../utils/models';
import { emitOrchidEvent, onOrchidEvent } from '../utils/events';
import { resolveOrchidNavigate } from '../utils/navigate-shell';
import { useFocusTrap, useGlobalShortcuts } from '../keyboard';
import type { ModelSelection } from '../../shared/types/provider';
import { flattenSessionMessages, type Session } from '../../shared/types/session';
import type {
  ASTStoreStatus,
  CommandContext,
  Config,
  MCPServerStatus,
  RAGStoreStatus,
} from '../../shared/types/ipc-boundary';
import type { ProviderModelOption, SessionOpenResult } from '../../shared/types/ipc';
import { ChatStream } from './ChatStream';
import { DeferredSurface } from './deferred-surface';
import { InputArea } from './InputArea';
import { MessageQueue } from './MessageQueue';
import { Footer } from './Footer';
import { Sidebar } from './Sidebar';
import { LeftSidebar } from './LeftSidebar';
import { CommandPalette } from './CommandPalette';
import { ShortcutsHelp } from './ShortcutsHelp';
import { SessionHeader } from './session-header';
import { SessionTabBar } from './SessionTabBar';
import { Alert, type AlertTone } from './ui/Alert';
import { Button } from './ui/Button';
import { StateMessage } from './ui/StateMessage';
import type { SubagentOpenRequest } from './SubagentView';

const ProjectConfigView = lazy(() => import('./ProjectConfigView').then((module) => ({
  default: module.ProjectConfigView,
})));
const SubagentView = lazy(() => import('./SubagentView').then((module) => ({
  default: module.SubagentView,
})));

type ToastSeverity = 'info' | 'warning' | 'error';
interface Toast {
  message: string;
  severity: ToastSeverity;
}

interface ChatViewProps {
  /** False while a full-window surface owns presentation. */
  isVisible?: boolean;
  /** App-owned effective configuration loaded once during renderer startup. */
  bootstrapConfig?: Config | null;
}

export function ChatView({ isVisible = true, bootstrapConfig = null }: ChatViewProps) {
  const session = useSession();
  const chat = useChat(session.activeSession?.id ?? null);
  const subagents = useSubagents(session.activeSession?.id ?? null);
  const todos = useTodos(session.activeSession?.id ?? null);
  const activity = useSessionActivity();
  const tabs = useSessionTabs();
  const providers = useProviders();
  const messageQueue = useMessageQueue();

  const {
    rightOpen: sidebarOpen,
    leftCollapsed: leftSidebarCollapsed,
    rightOverlay,
    leftOverlay,
    rightTrack,
    leftTrack,
    toggleRight: toggleSidebar,
    toggleLeft: toggleLeftSidebar,
    openRight: openSidebar,
    openLeft: openLeftSidebar,
  } = useResponsiveShell();
  const [paletteOpen, setPaletteOpen] = useState(false);
  /** One-shot inspector section focus from command-palette navigation. */
  const [inspectorFocusSection, setInspectorFocusSection] = useState<string | null>(null);
  const [closeConfirmId, setCloseConfirmId] = useState<string | null>(null);
  const closeConfirmRef = useRef<HTMLDivElement>(null);
  const closeConfirmCancelRef = useRef<HTMLButtonElement>(null);
  const [draftTabVisible, setDraftTabVisible] = useState(false);
  const [composerDraftKey, setComposerDraftKey] = useState(0);
  const [mcpServers, setMcpServers] = useState<MCPServerStatus[]>([]);
  const [ragStatus, setRagStatus] = useState<RAGStoreStatus | null>(null);
  const [astStatus, setAstStatus] = useState<ASTStoreStatus | null>(null);
  const [currentTheme, setCurrentTheme] = useState('default');
  const [currentPersonality, setCurrentPersonality] = useState('default');
  const [personalityNames, setPersonalityNames] = useState<string[]>([]);
  const [currentSelection, setCurrentSelection] = useState<ModelSelection | null>(null);
  /** Configured default model for new chats / draft mode. */
  const [defaultSelection, setDefaultSelection] = useState<ModelSelection | null>(null);
  const [providerModelOptions, setProviderModelOptions] = useState<readonly ProviderModelOption[]>([]);
  const [maxContext, setMaxContext] = useState<number | null>(null);
  const [alwaysExpandToolGroups, setAlwaysExpandToolGroups] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [contentMode, setContentMode] = useState<'chat' | 'subagents'>('chat');
  const [projectConfigDir, setProjectConfigDir] = useState<string | null>(null);
  const [subagentOpenRequest, setSubagentOpenRequest] = useState<SubagentOpenRequest>({ generation: 0, id: null });
  const chatContentRef = useRef<HTMLDivElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const element = chatContentRef.current;
    if (!element) return;
    if (contentMode === 'subagents') element.setAttribute('inert', '');
    else element.removeAttribute('inert');
  }, [contentMode, projectConfigDir]);

  const openSubagentView = useCallback((id?: string) => {
    setSubagentOpenRequest((previous) => ({ generation: previous.generation + 1, id: id ?? null }));
    setContentMode('subagents');
  }, []);

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

  // Shared catalog — never blank mid-switch; only update when a full list arrives.
  useEffect(() => {
    if (providers.modelOptions != null) {
      setProviderModelOptions(providers.modelOptions);
    }
  }, [providers.modelOptions]);

  useEffect(() => {
    void providers.ensureModelList();
  }, [connectionStateSignature, providers.ensureModelList]);

  useEffect(() => {
    return onOrchidEvent('orchid:providers-updated', () => {
      void providers.refresh().then(() => providers.ensureModelList());
    });
  }, [providers.refresh, providers.ensureModelList]);

  useEffect(() => {
    return onOrchidEvent('orchid:provider-selection-created', (detail) => {
      const selection = detail.selection;
      if (!selection) return;
      setCurrentSelection({
        connectionId: selection.connectionId,
        modelId: selection.modelId,
      });
      if (session.activeSession?.id) {
        void session.changeModel(session.activeSession.id, selection, selection.modelId);
      }
      void providers.refresh();
    });
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

  useEffect(() => {
    return onOrchidEvent('orchid:navigate', (detail) => {
      const action = resolveOrchidNavigate(detail.section);
      if (action.kind === 'noop') return;
      if (action.kind === 'sessions') {
        openLeftSidebar();
        return;
      }
      openSidebar();
      setInspectorFocusSection(action.section);
    });
  }, [openLeftSidebar, openSidebar]);

  const togglePalette = useCallback(() => {
    setHelpOpen(false);
    setPaletteOpen((prev) => !prev);
  }, []);

  const toggleHelp = useCallback(() => {
    setPaletteOpen(false);
    setHelpOpen((prev) => !prev);
  }, []);

  const openSettings = useCallback(() => {
    emitOrchidEvent('orchid:open-settings');
  }, []);

  useEffect(() => {
    if (!bootstrapConfig) return;
    if (bootstrapConfig.theme) setCurrentTheme(bootstrapConfig.theme);
    if (bootstrapConfig.personality) setCurrentPersonality(bootstrapConfig.personality);
    setDefaultSelection(bootstrapConfig.default_model ?? null);
    setAlwaysExpandToolGroups(Boolean(bootstrapConfig.always_expand_tool_groups));
  }, [bootstrapConfig]);

  useEffect(() => {
    if (!window.orchid?.config?.listPersonalities) return;
    window.orchid.config.listPersonalities()
      .then(setPersonalityNames)
      .catch(() => { /* Non-fatal */ });
  }, []);

  useEffect(() => {
    return onOrchidEvent('orchid:config-updated', (detail) => {
      if (detail && typeof detail.always_expand_tool_groups === 'boolean') {
        setAlwaysExpandToolGroups(detail.always_expand_tool_groups);
      }
      if (detail && 'default_model' in detail) {
        setDefaultSelection(detail.default_model as ModelSelection | null);
      }
    });
  }, []);

  // Keep composer model in sync with the active session. In draft mode (no
  // active session), restore the configured default so new chats are ready.
  useEffect(() => {
    if (session.activeSession) {
      setCurrentSelection(session.activeSession.selection ?? null);
      return;
    }
    setCurrentSelection(defaultSelection);
  }, [
    session.activeSession?.id,
    session.activeSession?.selection,
    session.activeSession?.modelLabel,
    defaultSelection,
  ]);

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
        subagents.applyFromSession([]);
        todos.applyFromSession([]);
        return;
      }
      chat.setMessages(flattenSessionMessages(loadedSession));
      subagents.applyFromSession(loadedSession.subagentChains);
      todos.applyFromSession(loadedSession.todoStore.tasks);
    },
    [chat.setMessages, subagents.applyFromSession, todos.applyFromSession],
  );

  const handleSessionSelect = useCallback(
    async (id: string) => {
      setProjectConfigDir(null);
      // Already focused this session (not draft) — skip full reload to avoid flicker.
      if (session.activeSession?.id === id && !draftTabVisible) {
        return;
      }

      const gen = ++sessionSwitchGen.current;

      // Rebind stream affinity immediately so previous-session events cannot
      // repopulate the pane — but keep painting the previous session until
      // the full target payload is ready (no intermediate empty/zero state).
      chat.beginSessionSwitch(id);

      // Single round-trip: activate the session and fetch its full view payload
      // (session + flattened messages + live snapshot + workspace) at once.
      // Replaces the prior peek + chat:snapshot + activate sequence.
      let result: SessionOpenResult | null = null;
      try {
        result = await session.open(id);
      } catch {
        // result stays null on failure — handled by the !result guard below.
      }
      if (gen !== sessionSwitchGen.current) return;

      if (!result || !result.session) {
        // Could not load (missing/corrupt) — keep the previous paint and release
        // the switch hold without blanking the pane.
        chat.hydrateSnapshot(null);
        return;
      }

      setDraftTabVisible(false);
      messageQueue.clearQueue();
      // Commit once: sidebar lists from the session, chat (messages + live) via
      // hydrate. hydrateSnapshot owns the single message replace (no double set).
      subagents.applyFromSession(result.session.subagentChains);
      todos.applyFromSession(result.session.todoStore.tasks);
      chat.hydrateSnapshot({
        sessionId: result.session.id,
        messages: result.messages,
        live: result.live,
      });
    },
    [session, chat.beginSessionSwitch, chat.hydrateSnapshot, subagents.applyFromSession, todos.applyFromSession, draftTabVisible, messageQueue.clearQueue],
  );

  useEffect(() => {
    return onOrchidEvent('orchid:select-session', (detail) => {
      if (!detail.id) return;
      void handleSessionSelect(detail.id);
    });
  }, [handleSessionSelect]);

  const enterDraftMode = useCallback(async (opts?: { clearComposer?: boolean }) => {
    setProjectConfigDir(null);
    const gen = ++sessionSwitchGen.current;
    chat.beginSessionSwitch(null);
    messageQueue.clearQueue();
    await session.enterDraft();
    if (gen !== sessionSwitchGen.current) return;
    applySessionMessages(null);
    setDraftTabVisible(true);
    if (opts?.clearComposer) {
      setComposerDraftKey((k) => k + 1);
    }
  }, [session, chat.beginSessionSwitch, applySessionMessages, messageQueue.clearQueue]);

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

  const handleProjectSelect = useCallback((projectDir: string) => {
    setProjectConfigDir(projectDir);
  }, []);

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
    [session, chat.setMessages, tabs.refresh, focusAfterWorkingSet],
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

  const handleSessionRename = useCallback(
    async (id: string, name: string) => {
      try {
        await session.rename(id, name);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        notify(`Rename failed: ${message}`, 'error');
      }
    },
    [session, notify],
  );

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
        chat.beginSessionSwitch(null);
        applySessionMessages(null);
        setDraftTabVisible(true);
        setComposerDraftKey((k) => k + 1);
        notify(`New chat in project: ${info.cwd}`, 'info');
      } else {
        notify(`Project folder: ${info.cwd}`, 'info');
      }
    }
  }, [session, chat.beginSessionSwitch, applySessionMessages, notify]);

  // Stable prop wrappers for the memoized LeftSidebar. Inline arrows here would
  // give the rail a fresh identity every render and defeat React.memo, so the
  // whole sidebar re-rendered on each streamed token / activity broadcast.
  const handleSessionCreateClick = useCallback(() => {
    void handleSessionCreate();
  }, [handleSessionCreate]);
  const handleProjectSessionCreateClick = useCallback((projectDir: string) => {
    void handleProjectSessionCreate(projectDir);
  }, [handleProjectSessionCreate]);
  const handlePickProjectDirClick = useCallback(() => {
    void handlePickProjectDir();
  }, [handlePickProjectDir]);
  const handleStopSession = useCallback((sessionId: string) => {
    void chat.stop(sessionId);
  }, [chat.stop]);

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
      if (chat.isSwitchingSession) return;
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
        emitOrchidEvent('orchid:open-settings', { tab: 'providers' });
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
      chat.send,
      chat.isSwitchingSession,
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

  const handleQueue = useCallback(
    (text: string) => {
      const trigger = messageQueue.addToQueue(text);
      const sessionId = session.activeSession?.id;
      // Only next-request messages stop the chain early; chain-end messages
      // queue without signaling so the current run continues to its natural end.
      if (trigger === 'next-request' && chat.status === 'streaming' && sessionId) {
        void window.orchid?.chat?.queueNext({ sessionId })?.catch(() => {});
      }
    },
    [messageQueue.addToQueue, chat.status, session.activeSession?.id],
  );

  useQueueAutoFire(
    chat.status,
    messageQueue.consumeNext,
    messageQueue.restoreBatch,
    messageQueue.editingId,
    handleSend,
  );

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

  // Stable prop wrappers for the memoized tab bar / composer / inspector.
  // Inline arrows would hand those components a fresh identity every render and
  // defeat React.memo, re-rendering them on each streamed token.
  const handleTabSelect = useCallback((id: string) => {
    setDraftTabVisible(false);
    void handleSessionSelect(id);
  }, [handleSessionSelect]);
  const handleSelectDraftTab = useCallback(() => {
    void enterDraftMode();
  }, [enterDraftMode]);
  const handleCloseDraftTab = useCallback(() => {
    void leaveDraftToOpenTab();
  }, [leaveDraftToOpenTab]);
  const handleOpenProviders = useCallback(() => {
    emitOrchidEvent('orchid:open-settings', { tab: 'providers' });
  }, []);
  const handleFocusSectionConsumed = useCallback(() => {
    setInspectorFocusSection(null);
  }, []);

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
      if (!isVisible) return false;
      // Always allow palette / help toggles (they close themselves).
      if (id === 'palette.toggle' || id === 'shortcuts.help') return true;
      // Suppress other globals while overlays own the keyboard.
      if (paletteOpen || helpOpen || closeConfirmId) return false;
      return true;
    },
    [isVisible, paletteOpen, helpOpen, closeConfirmId],
  );

  useGlobalShortcuts({
    handlers: shortcutHandlers,
    isEnabled: shortcutGate,
  });

  useFocusTrap({
    enabled: closeConfirmId != null,
    containerRef: closeConfirmRef,
    initialFocusRef: closeConfirmCancelRef,
  });

  useEffect(() => {
    if (!closeConfirmId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setCloseConfirmId(null);
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [closeConfirmId]);

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
  }, [refreshMCP]);

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

  // Memoized so the composer, footer, and command palette (all memoized) are
  // not invalidated on every render — previously a fresh object each render
  // forced those subtrees to re-render on every streamed token.
  const commandContext: CommandContext = useMemo(() => ({
    onCreateSession: handleSessionCreate,
    onLoadSession: handleSessionSelect,
    onDeleteSession: session.deleteSession,
    onRenameSession: session.rename,
    getActiveSessionId: () => session.activeSession?.id ?? null,
    getActiveSessionName: () => session.activeSession?.name ?? null,
    onSetTheme: async (name: string) => {
      setCurrentTheme(name);
      emitOrchidEvent('orchid:set-theme', { theme: name });
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
  }), [
    handleSessionCreate,
    handleSessionSelect,
    session,
    handleSelectProviderModel,
    availableProviderModels,
    providerPickerValue,
    openSettings,
    handlePickProjectDir,
    handleIndexRAG,
    handleIndexAST,
    refreshIndex,
    notify,
  ]);

  useEffect(() => {
    if (selectedProviderModel) {
      setMaxContext(selectedProviderModel.model.limits?.contextTokens ?? null);
      return;
    }
    if (!chat.isSwitchingSession) setMaxContext(null);
  }, [selectedProviderModel, chat.isSwitchingSession]);

  const sessions =
    session.listState.status === 'ready' || session.listState.status === 'partial'
      ? session.listState.sessions
      : [];

  // Runtime shell tracks — CSS custom properties (exceptions.css .app-frame).
  const shellStyle = {
    ['--orchid-shell-left' as string]: leftTrack,
    ['--orchid-shell-right' as string]: rightTrack,
  };
  const chatSurfaceVisible = isVisible && contentMode === 'chat';

  return (
    <div
      className="app-frame grid h-screen min-h-0 overflow-hidden bg-base-100 text-base-content"
      style={shellStyle}
    >
      <DeferredSurface isVisible={isVisible}>
        <LeftSidebar
        activeSessionId={session.activeSession?.id ?? null}
        selectedProjectPath={
          session.activeSession?.cwd ??
          (session.workspace?.status === 'valid' ? session.workspace.cwd : null)
        }
        isCollapsed={leftSidebarCollapsed}
        isOverlay={leftOverlay}
        onOpenSettings={openSettings}
        onPickProjectDir={handlePickProjectDirClick}
        projectPickerCreatesDraft={Boolean(session.activeSession?.chains.length)}
        onRefreshSessions={session.refresh}
        onSessionCreate={handleSessionCreateClick}
        onProjectSessionCreate={handleProjectSessionCreateClick}
        onProjectSelect={handleProjectSelect}
        onSessionDelete={handleSessionDelete}
        onSessionSelect={handleSessionSelect}
        onSessionRename={handleSessionRename}
        activities={activity.activities}
        onStopSession={handleStopSession}
        onToggle={toggleLeftSidebar}
        sessionListState={session.listState}
        workspace={session.workspace}
        />
      </DeferredSurface>

      <main className="main-pane min-h-0 min-w-0 overflow-hidden">
        {toast && (
          <Alert
            tone={toast.severity as AlertTone}
            variant="soft"
            className={`command-toast command-toast-${toast.severity} orchid-state-enter py-2 text-sm`}
            role="status"
            aria-live="polite"
            action={
              <Button variant="ghost" size="xs" shape="circle" onClick={() => setToast(null)} aria-label="Dismiss">
                ×
              </Button>
            }
          >
            <span className="command-toast-message min-w-0 flex-1">{toast.message}</span>
          </Alert>
        )}
        {projectConfigDir ? (
          <Suspense
            fallback={(
              <StateMessage
                kind="loading"
                title="Loading project settings…"
                className="min-h-0 flex-1"
                role="status"
                aria-live="polite"
              />
            )}
          >
            <ProjectConfigView
              projectDir={projectConfigDir}
              onNewChat={(dir) => {
                setProjectConfigDir(null);
                void handleProjectSessionCreate(dir);
              }}
              onClose={() => setProjectConfigDir(null)}
            />
          </Suspense>
        ) : (
          <>
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
          onSelect={handleTabSelect}
          onSelectDraft={handleSelectDraftTab}
          onClose={requestCloseTab}
          onCloseDraft={handleCloseDraftTab}
          onRename={handleSessionRename}
        />
        <SessionHeader
          session={session.activeSession}
          workspace={session.workspace}
        />
        {closeConfirmId ? (
          <div
            ref={closeConfirmRef}
            className="session-tab-confirm orchid-overlay-enter"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="session-tab-confirm-title"
            aria-describedby="session-tab-confirm-desc"
          >
            <div className="session-tab-confirm-card orchid-dialog-enter border border-base-300 bg-base-100 shadow-lg">
              <p id="session-tab-confirm-title" className="session-tab-confirm-text font-semibold">
                Close running session tab?
              </p>
              <p id="session-tab-confirm-desc" className="session-tab-confirm-text session-tab-confirm-desc text-base-content/80">
                This session is still running. Close the tab and keep the agent working in the background?
              </p>
              <div className="session-tab-confirm-actions">
                <Button
                  ref={closeConfirmCancelRef}
                  variant="ghost"
                  size="sm"
                  onClick={() => setCloseConfirmId(null)}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => {
                    const id = closeConfirmId;
                    setCloseConfirmId(null);
                    if (id) void performCloseTab(id);
                  }}
                >
                  Close tab
                </Button>
              </div>
            </div>
          </div>
        ) : null}
        <div
          ref={chatContentRef}
          className={contentMode === 'subagents' ? 'orchid-chat-content-preserved orchid-chat-content-hidden' : 'orchid-chat-content-preserved orchid-view-enter'}
          aria-hidden={contentMode === 'subagents' ? true : undefined}
        >
        <DeferredSurface isVisible={chatSurfaceVisible}>
          <ChatStream
            isVisible={chatSurfaceVisible}
            messages={chat.messages}
            streamingContent={chat.streamingContent}
            toolBlocks={chat.toolBlocks}
            streamSegments={chat.streamSegments}
            streamRevision={chat.streamRevision}
            status={chat.status}
            error={chat.error}
            usage={chat.usage}
            currentTurnUsage={chat.currentTurnUsage}
            subagentUsage={subagents.usageSummary}
            subagents={subagents.subagents}
            sessionChains={session.activeSession?.chains ?? []}
            sessionId={session.activeSession?.id ?? null}
            onClearError={chat.clearError}
            onOpenSettings={openSettings}
            onPickProjectDir={workspaceBound ? undefined : handlePickProjectDirClick}
            workspaceUnbound={!workspaceBound}
            onRetry={handleRetry}
            streamStartTime={chat.streamStartTime}
            interrupted={chat.interrupted}
            alwaysExpandToolGroups={alwaysExpandToolGroups}
          />
        </DeferredSurface>
        <MessageQueue
          queue={messageQueue.queue}
          editingId={messageQueue.editingId}
          onRemove={messageQueue.removeFromQueue}
          onReorder={messageQueue.reorderQueue}
          onStartEditing={messageQueue.startEditing}
          onUpdateEditingText={messageQueue.updateEditingText}
          onFinishEditing={messageQueue.finishEditing}
          onCancelEditing={messageQueue.cancelEditing}
          onChangeTrigger={messageQueue.changeTrigger}
        />
        <InputArea
          key={composerDraftKey}
          sessionId={session.activeSession?.id ?? null}
          status={chat.status}
          model={providerPickerValue}
          modelLabels={providerModelLabels}
          modelDetails={providerModelDetails}
          interruptState={chat.interruptState}
          onSend={handleSend}
          onCancel={chat.cancel}
          onQueue={handleQueue}
          commandContext={commandContext}
          sessions={sessions}
          currentTheme={currentTheme}
          currentPersonality={currentPersonality}
          personalityNames={personalityNames}
          workspaceBound={workspaceBound}
          providerAvailable={providerAvailable}
          modelSelected={modelSelected}
          onOpenProviders={handleOpenProviders}
          onPickProjectDir={handlePickProjectDirClick}
          isViewActive={!isVisible || contentMode === 'subagents'}
        />
        <DeferredSurface isVisible={isVisible}>
          <Footer
            isVisible={isVisible}
            streamStartTime={chat.streamStartTime}
            isStreaming={chat.status === 'streaming'}
            interruptState={chat.interruptState}
            usage={chat.usage}
            maxContext={maxContext}
            messages={chat.messages}
            streamingThinkingChars={Math.floor(chat.streamingThinking.length / 500) * 500 || undefined}
            model={providerPickerValue}
            modelLabels={providerModelLabels}
            modelDetails={providerModelDetails}
            commandContext={commandContext}
            sessionId={session.activeSession?.id ?? null}
          />
        </DeferredSurface>
        </div>
        {contentMode === 'subagents' ? (
          <div className="orchid-view-enter flex min-h-0 flex-1 flex-col">
            <Suspense
              fallback={(
                <StateMessage
                  kind="loading"
                  title="Loading subagent view…"
                  className="min-h-0 flex-1"
                  role="status"
                  aria-live="polite"
                />
              )}
            >
            <DeferredSurface isVisible={isVisible}>
              <SubagentView subagents={subagents} openRequest={subagentOpenRequest} onBackToChat={() => setContentMode('chat')} />
            </DeferredSurface>
            </Suspense>
          </div>
        ) : null}
          </>
        )}
      </main>

      <DeferredSurface isVisible={isVisible}>
        <Sidebar
          isOpen={sidebarOpen}
          isOverlay={rightOverlay}
          onToggle={toggleSidebar}
          subagentState={subagents.state}
          onRefreshSubagents={subagents.refresh}
          selectedSubagentId={subagents.selectedId}
          onSelectSubagent={subagents.select}
          getSubagentDetail={subagents.getDetail}
          onOpenSubagentView={openSubagentView}
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
          streamingThinkingChars={Math.floor(chat.streamingThinking.length / 500) * 500 || undefined}
          focusSection={inspectorFocusSection}
          onFocusSectionConsumed={handleFocusSectionConsumed}
        />
      </DeferredSurface>

      <CommandPalette
        isOpen={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        context={commandContext}
        sessions={sessions}
        currentTheme={currentTheme}
        currentPersonality={currentPersonality}
        personalityNames={personalityNames}
        modelLabels={providerModelLabels}
        modelDetails={providerModelDetails}
      />

      <ShortcutsHelp isOpen={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  );
}
