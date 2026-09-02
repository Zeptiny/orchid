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
import { useBackgroundCommands } from '../hooks/useBackgroundCommands';
import { useDebugRequests } from '../hooks/useDebugRequests';
import { useInspectorHydration } from '../hooks/useInspectorHydration';
import { useSubagents } from '../hooks/useSubagents';
import { useTodos } from '../hooks/useTodos';
import type { UseSessionActivityReturn } from '../hooks/useSessionActivity';
import { useSessionTabs } from '../hooks/useSessionTabs';
import { useMachines } from '../hooks/useMachines';
import { useProviders } from '../hooks/useProviders';
import { useMessageQueue } from '../hooks/useMessageQueue';
import { useResponsiveShell } from '../hooks/use-responsive-shell';
import { useTrustPrompt } from '../hooks/useTrustPrompt';
import { useTrustSendReplay, type UseTrustSendReplayReturn } from '../hooks/useTrustSendReplay';
import { providerModelOptionKey, providerModelOptionLabel } from '../utils/provider-selection';
import { onOrchidEvent } from '../utils/events';
import { resolveOrchidNavigate } from '../utils/navigate-shell';
import { sumChainUsage } from '../../shared/types/chain';
import { sumUsages } from '../../shared/usage';
import type { ModelSelection } from '../../shared/types/provider';
import type { Config, SessionSummary } from '../../shared/types/ipc-boundary';
import type { Notify } from '../utils/notify';
import { ChatStream } from './ChatStream';
import { DeferredSurface } from './deferred-surface';
import { LeftSidebar } from './LeftSidebar';
import { Sidebar } from './Sidebar';
import { StateMessage } from './ui/StateMessage';
import { buildChatStreamProps, buildInspectorProps, buildSessionsRailProps } from './chatview/chat-view-surface-props';
import { ChatViewComposer } from './chatview/chat-view-composer';
import { ChatViewOverlayStack } from './chatview/chat-view-overlay-stack';
import { ChatViewTabStrip } from './chatview/chat-view-tab-strip';
import { MachineConnectionBanner } from './chatview/machine-connection-banner';
import { SessionCloseConfirmDialog } from './chatview/session-close-confirm-dialog';
import { visibleSessionSummaries } from './chatview/chat-view-selectors';
import { useChatViewCommandContext } from './chatview/use-chat-view-command-context';
import { useChatViewComposer } from './chatview/use-chat-view-composer';
import { useChatViewConfig } from './chatview/use-chat-view-config';
import { useChatViewIndexStatus } from './chatview/use-chat-view-index-status';
import { useChatViewModels } from './chatview/use-chat-view-models';
import { useChatViewMachineScope } from './chatview/use-chat-view-machine-scope';
import { useChatViewSessionActions } from './chatview/use-chat-view-session-actions';
import { useChatViewSessionSurfaces } from './chatview/use-chat-view-session-surfaces';
import { useChatViewShortcuts } from './chatview/use-chat-view-shortcuts';
import { useChatViewSurfaces } from './chatview/use-chat-view-surfaces';
import { useChatViewTabRestore } from './chatview/use-chat-view-tab-restore';
import { useMCPStartingPolling } from './chatview/use-mcp-starting-polling';
import { useSeenMessages } from './chatview/use-seen-messages';
import { useSubagentTurnRefresh } from './chatview/use-subagent-turn-refresh';

const ProjectConfigView = lazy(() => import('./ProjectConfigView').then((module) => ({
  default: module.ProjectConfigView,
})));
const SubagentView = lazy(() => import('./SubagentView').then((module) => ({
  default: module.SubagentView,
})));

interface ChatViewProps {
  /** False while a full-window surface owns presentation. */
  isVisible?: boolean;
  /** App-owned effective configuration loaded once during renderer startup. */
  bootstrapConfig?: Config | null;
  /** App-level notification surface shared by chat and settings. */
  onNotify: Notify;
  /** Shared session activity state (owned by AppReady). */
  activity: UseSessionActivityReturn;
}

export function ChatView({ isVisible = true, bootstrapConfig = null, onNotify, activity }: ChatViewProps) {
  const session = useSession();
  const workspaceCwd = session.workspace?.cwd ?? session.activeSession?.cwd ?? null;
  const subagents = useSubagents(session.activeSession?.id ?? null);
  /**
   * Esc keeps the third interrupt layer reachable while the session owns
   * queued/running subagents, even when no main-agent turn is live (#145).
   * Memoized on the group arrays' contents so the composer prop stays stable.
   */
  const hasRunningSubagents = useMemo(
    () => subagents.groups.running.length > 0 || subagents.groups.queued.length > 0,
    [subagents.groups.running, subagents.groups.queued],
  );
  const todos = useTodos(
    session.activeSession?.id ?? null,
    session.activeSession?.todoStore.tasks ?? null,
  );
  const tabs = useSessionTabs();
  const providers = useProviders();
  const machines = useMachines();
  // The native folder picker is a local-machine capability: a remote host's
  // workspace binds through typed paths, never through a local dialog.
  const canPickProjectDir = machines.isActiveMachineLocal;
  // Queue ownership follows the visible session: teardown paths (delete /
  // workspace rebind / switch) change this key and drop stale queued messages
  // instead of firing them into another session.
  const messageQueue = useMessageQueue(session.activeSession?.id ?? null);
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
  const commands = useBackgroundCommands(
    session.activeSession?.id ?? null,
    sidebarOpen,
  );
  const surfaces = useChatViewSurfaces();
  const {
    paletteOpen,
    setPaletteOpen,
    closeConfirmId,
    draftTabVisible,
    setDraftTabVisible,
    composerDraftKey,
    contentMode,
    setContentMode,
    projectConfigDir,
    setProjectConfigDir,
    inspectorFocusSection,
    setInspectorFocusSection,
    subagentOpenRequest,
    openSubagentView,
    closeConfirmRef,
    closeConfirmCancelRef,
    togglePalette,
    toggleHelp,
    closePalette,
    declineCloseConfirm,
    clearInspectorFocusSection,
    openSettings,
    openAnalytics,
    openProviderSettings,
  } = surfaces;
  const notify = onNotify;

  // Workspace-scoped status refreshes (declared early so the trust grant
  // callback can re-run them once a project becomes trusted).
  const index = useChatViewIndexStatus({ workspaceCwd });
  const { refreshMCP, refreshIndex } = index;

  // Trusted-projects prompt: explicit interactions (bind result, send failure,
  // badge click) call openFor; granting re-resolves workspace + gated services.
  // useTrustSendReplay owns the #148 stash/replay/restore flow for gated sends
  // (the ref bridges onGranted to the hook declared just below it).
  const trustSendRef = useRef<UseTrustSendReplayReturn | null>(null);
  const trustPrompt = useTrustPrompt({
    onGranted: () => {
      void session.getWorkspace();
      void refreshMCP();
      void refreshIndex();
      // Replay the trust-gated send (if any).
      trustSendRef.current?.onGranted();
    },
  });
  const trustSend = useTrustSendReplay({
    openFor: trustPrompt.openFor,
    decline: trustPrompt.decline,
    restoreBatch: messageQueue.restoreBatch,
    cwd: workspaceCwd,
    activeSessionId: session.activeSession?.id ?? null,
  });
  trustSendRef.current = trustSend;

  const sessionUsage = useMemo(() => {
    const usages = session.activeSession?.chains.map(sumChainUsage) ?? [];
    return {
      total: sumUsages(usages),
      latest: usages.findLast((usage) => usage != null) ?? null,
    };
  }, [session.activeSession?.chains]);

  // Surface trust failures that happen outside the dialog (e.g. the trust
  // lookup itself failed). While the dialog is open its own alert shows the
  // error, so notify only when no prompt is showing, then clear once consumed.
  useEffect(() => {
    if (trustPrompt.error == null || trustPrompt.pending != null) return;
    notify(trustPrompt.error, 'error');
    trustPrompt.clearError();
  }, [trustPrompt.error, trustPrompt.pending, notify, trustPrompt.clearError]);

  const chat = useChat(session.activeSession?.id ?? null, {
    persistedSessionUsage: sessionUsage.total,
    latestPersistedUsage: sessionUsage.latest,
    onUntrustedProject: trustSend.onUntrustedProject,
  });
  const { setMessages, beginSessionSwitch, hydrateSnapshot } = chat;

  // Debug request captures (inspector Requests section). Polls only while the
  // inspector is open; paces at the subagents tick while a turn is streaming.
  const debugRequests = useDebugRequests(
    session.activeSession?.id ?? null,
    sidebarOpen,
    chat.status === 'streaming',
  );

  const chatContentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = chatContentRef.current;
    if (!element) return;
    if (contentMode === 'subagents') element.setAttribute('inert', '');
    else element.removeAttribute('inert');
  }, [contentMode, projectConfigDir]);

  // The composer paints the session's selection, or the configured default in
  // draft mode; this is the one selection the shell owns outright.
  const [currentSelection, setCurrentSelection] = useState<ModelSelection | null>(null);
  const models = useChatViewModels({
    providers,
    activeSessionId: session.activeSession?.id ?? null,
    activeSessionSelection: session.activeSession?.selection ?? null,
    changeModel: session.changeModel,
    currentSelection,
    setCurrentSelection,
    isSwitchingSession: chat.isSwitchingSession,
  });
  const { availableProviderModels, chatProviderModels, providerModelDetails } = models;

  useSeenMessages({
    sessionId: session.activeSession?.id,
    markSeen: activity.markSeen,
  });

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
  }, [openLeftSidebar, openSidebar, setInspectorFocusSection]);

  const config = useChatViewConfig({ paletteOpen });
  const {
    defaultSelection,
    setDefaultSelection,
    setCurrentTheme,
    setCurrentPersonality,
    setAlwaysExpandToolGroups,
  } = config;

  useEffect(() => {
    if (!bootstrapConfig) return;
    if (bootstrapConfig.theme) setCurrentTheme(bootstrapConfig.theme);
    if (bootstrapConfig.personality) setCurrentPersonality(bootstrapConfig.personality);
    setDefaultSelection(bootstrapConfig.default_model ?? null);
    setAlwaysExpandToolGroups(Boolean(bootstrapConfig.always_expand_tool_groups));
  }, [
    bootstrapConfig,
    setCurrentTheme,
    setCurrentPersonality,
    setDefaultSelection,
    setAlwaysExpandToolGroups,
  ]);

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

  // Compaction rewrites the durable chains while the live tail still holds
  // every pre-compaction segment/tool. Without a reset those re-render below
  // the compacted stub + summary (flagged content un-hidden, duplicated, and
  // after the turn ends stranded below the chain footer) until the session is
  // re-entered. Reset as soon as the rewrite lands; preserved content
  // re-renders from the chains the compaction reload brings in.
  const activeSessionIdRef = useRef(session.activeSession?.id ?? null);
  activeSessionIdRef.current = session.activeSession?.id ?? null;
  useEffect(() => {
    const unsubscribe = window.orchid?.session?.onCompaction?.((event) => {
      if (event.sessionId && event.sessionId === activeSessionIdRef.current) {
        chat.resetLiveTail();
      }
    });
    return () => unsubscribe?.();
  }, [chat.resetLiveTail]);

  const switchActions = useChatViewSessionSurfaces({
    session,
    chat: { setMessages, beginSessionSwitch, hydrateSnapshot },
    todos,
    messageQueue,
    surfaces,
    notify,
    openTrustPrompt: trustPrompt.openFor,
  });
  const { handleSessionSelect, handleLoadHistoryPage } = switchActions;

  useEffect(() => {
    return onOrchidEvent('orchid:select-session', (detail) => {
      if (!detail.id) return;
      void handleSessionSelect(detail.id);
    });
  }, [handleSessionSelect]);

  useChatViewTabRestore({
    session,
    tabs,
    sessionSwitchGeneration: switchActions.sessionSwitchGeneration,
    selectSession: handleSessionSelect,
    enterDraftMode: switchActions.enterDraftMode,
    setDraftTabVisible,
  });

  const machineScope = useChatViewMachineScope({
    session,
    providers,
    machines,
    canPickProjectDir,
    chatStatus: chat.status,
    streamStartTime: chat.streamStartTime,
    enterDraftMode: switchActions.enterDraftMode,
    selectSession: handleSessionSelect,
  });

  const sessionActions = useChatViewSessionActions({
    session,
    chat,
    tabs,
    activity,
    messageQueue,
    surfaces,
    notify,
    selectSession: handleSessionSelect,
    enterDraftMode: switchActions.enterDraftMode,
  });

  const providerModelByKey = useMemo(
    () => new Map(chatProviderModels.map((option) => [providerModelOptionKey(option), option])),
    [chatProviderModels],
  );
  const availableModelKeys = useMemo(
    () => availableProviderModels.map(providerModelOptionKey),
    [availableProviderModels],
  );

  const handleSelectProviderModel = useCallback(async (key: string) => {
    const option = providerModelByKey.get(key);
    const modelUnavailable = !option || !option.available;
    if (modelUnavailable) {
      notify('That connection and model are not available. Reconnect it or choose another model.', 'warning');
      return;
    }
    const selection: ModelSelection = {
      connectionId: option.selection.connectionId,
      modelId: option.selection.modelId,
    };
    setCurrentSelection(selection);
    const activeSessionId = session.activeSession?.id;
    if (activeSessionId) {
      await session.changeModel(activeSessionId, selection, providerModelOptionLabel(option));
      return;
    }
    // Draft mode: the pick clears the overrides the previous draft carried.
    try {
      await window.orchid?.session?.setReasoningEffort({ effort: null });
    } catch {
      // Non-fatal — draft override remains
    }
    try {
      await window.orchid?.session?.setServiceTier({ tier: null });
    } catch {
      // Non-fatal — draft tier remains
    }
  }, [notify, providerModelByKey, session]);

  // null workspace = still loading; allow send (main process still gates).
  // unbound/missing = block in UI (R3).
  const workspaceBound =
    session.workspace == null || session.workspace.status === 'valid';

  const composer = useChatViewComposer({
    chat,
    session,
    messageQueue,
    trustSend,
    notify,
    canPickProjectDir,
    activeMachineLabel: machines.activeMachineLabel,
    workspaceBound,
    providerAvailable: models.providerAvailable,
    modelSelected: models.modelSelected,
    preferredSelection: models.preferredSelection,
    onPickProjectDir: switchActions.handlePickProjectDir,
  });

  useChatViewShortcuts({
    isVisible,
    openSessionIds: tabs.snapshot.openSessionIds,
    overlayOwnsKeyboard: surfaces.overlayOwnsKeyboard,
    closeConfirmActive: closeConfirmId != null,
    closeConfirmRef,
    closeConfirmCancelRef,
    dismissCloseConfirm: declineCloseConfirm,
    togglePalette,
    toggleHelp,
    openSettings,
    createSession: switchActions.handleSessionCreateClick,
    closeFocusedTab: sessionActions.handleCloseFocusedTab,
    toggleInspector: toggleSidebar,
    toggleSessionsRail: toggleLeftSidebar,
    selectSessionTab: sessionActions.handleTabSelect,
  });

  const commandContext = useChatViewCommandContext({
    session,
    notify,
    onCreateSession: switchActions.handleSessionCreate,
    onLoadSession: handleSessionSelect,
    onDeleteSession: sessionActions.handleSessionDelete,
    onSelectModel: handleSelectProviderModel,
    onPickProjectDir: switchActions.handlePickProjectDir,
    onIndexRAG: index.onIndexRAG,
    onIndexAST: index.onIndexAST,
    onOpenSettings: openSettings,
    onClosePalette: closePalette,
    applyTheme: config.applyTheme,
    applyPersonality: config.applyPersonality,
    availableModelKeys,
    currentModelKey: models.providerPickerValue,
    refreshIndex,
  });

  useInspectorHydration({
    enabled: sidebarOpen,
    workspaceKey: workspaceCwd,
    refreshMCP,
    refreshIndex,
  });

  useMCPStartingPolling({
    enabled: sidebarOpen,
    servers: index.mcpServers,
    workspaceKey: workspaceCwd,
    refresh: refreshMCP,
  });

  useSubagentTurnRefresh({
    sessionId: session.activeSession?.id ?? null,
    status: chat.status,
    refresh: subagents.refresh,
  });

  const sessions: SessionSummary[] = visibleSessionSummaries(session.listState);
  const railProps = buildSessionsRailProps({
    session,
    activities: activity.activities,
    collapsed: leftSidebarCollapsed,
    overlay: leftOverlay,
    canPickProjectDir,
    machine: machines.activeMachine,
    switchActions,
    sessionActions,
    openSettings,
    openAnalytics,
    onToggle: toggleLeftSidebar,
  });
  const streamProps = buildChatStreamProps({
    chat,
    subagents,
    session,
    alwaysExpandToolGroups: config.alwaysExpandToolGroups,
    workspaceBound,
    canPickProjectDir,
    onPickProjectDir: switchActions.handlePickProjectDirClick,
    onOpenSettings: openSettings,
    onRetry: composer.handleRetry,
    onLoadHistoryPage: handleLoadHistoryPage,
  });
  const inspectorProps = buildInspectorProps({
    open: sidebarOpen,
    overlay: rightOverlay,
    onToggle: toggleSidebar,
    subagents,
    todos,
    commands,
    debugRequests,
    index,
    chat,
    sessionId: session.activeSession?.id ?? null,
    maxContext: models.maxContext,
    focusSection: inspectorFocusSection,
    onFocusSectionConsumed: clearInspectorFocusSection,
    onOpenSubagentView: openSubagentView,
  });

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
        <LeftSidebar {...railProps} />
      </DeferredSurface>

      <main className="main-pane min-h-0 min-w-0 overflow-hidden">
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
                void switchActions.handleProjectSessionCreate(dir);
              }}
              onClose={() => setProjectConfigDir(null)}
            />
          </Suspense>
        ) : (
          <>
            <ChatViewTabStrip
              tabs={tabs.snapshot}
              sessions={sessions}
              activities={activity.activities}
              showDraft={draftTabVisible && !session.activeSession}
              session={session.activeSession}
              workspace={session.workspace}
              onSelect={sessionActions.handleTabSelect}
              onSelectDraft={sessionActions.handleSelectDraftTab}
              onClose={sessionActions.requestCloseTab}
              onCloseDraft={sessionActions.handleCloseDraftTab}
              onRename={sessionActions.handleSessionRename}
            />
            {closeConfirmId ? (
              <SessionCloseConfirmDialog
                containerRef={closeConfirmRef}
                initialFocusRef={closeConfirmCancelRef}
                onCancel={declineCloseConfirm}
                onConfirm={() => {
                  const id = closeConfirmId;
                  declineCloseConfirm();
                  void sessionActions.performCloseTab(id);
                }}
              />
            ) : null}
            <div
              ref={chatContentRef}
              className={contentMode === 'subagents' ? 'orchid-chat-content-preserved orchid-chat-content-hidden' : 'orchid-chat-content-preserved orchid-view-enter'}
              aria-hidden={contentMode === 'subagents' ? true : undefined}
            >
              <MachineConnectionBanner
                machineLabel={machines.activeMachineLabel}
                status={machineScope.activeMachineStatus}
                disconnected={machineScope.remoteDisconnected}
                liveTurnStartedAt={machineScope.resumedLiveTurnStartedAt}
                reconnecting={machineScope.reconnectingMachine}
                onReconnect={() => void machineScope.handleMachineReconnect()}
              />
              <DeferredSurface isVisible={chatSurfaceVisible}>
                <ChatStream
                  isVisible={chatSurfaceVisible}
                  key={session.activeSession?.id ?? 'draft'}
                  {...streamProps}
                />
              </DeferredSurface>
              <ChatViewComposer
                isVisible={isVisible}
                composerDraftKey={composerDraftKey}
                chat={chat}
                session={session}
                models={models}
                config={config}
                messageQueue={messageQueue}
                composer={composer}
                trustSend={trustSend}
                commandContext={commandContext}
                sessions={sessions}
                workspaceBound={workspaceBound}
                canPickProjectDir={canPickProjectDir}
                onPickProjectDir={switchActions.handlePickProjectDirClick}
                onOpenProviders={openProviderSettings}
                hasRunningSubagents={hasRunningSubagents}
                isViewActive={!isVisible || contentMode === 'subagents'}
              />
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
                  <SubagentView subagents={subagents} openRequest={subagentOpenRequest} modelDetails={providerModelDetails} onBackToChat={() => setContentMode('chat')} />
                </DeferredSurface>
                </Suspense>
              </div>
            ) : null}
          </>
        )}
      </main>

      <DeferredSurface isVisible={isVisible}>
        <Sidebar {...inspectorProps} />
      </DeferredSurface>

      <ChatViewOverlayStack
        paletteOpen={paletteOpen}
        setPaletteOpen={setPaletteOpen}
        helpOpen={surfaces.helpOpen}
        setHelpOpen={surfaces.setHelpOpen}
        commandContext={commandContext}
        sessions={sessions}
        config={config}
        models={models}
        trustPrompt={trustPrompt}
        onDeclineTrust={trustSend.onDecline}
      />
    </div>
  );
}
