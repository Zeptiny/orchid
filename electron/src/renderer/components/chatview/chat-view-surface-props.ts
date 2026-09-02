/**
 * Projections from the shell's assembled state onto the props of its memoized
 * surfaces (sessions rail, transcript, inspector). Keeping the mapping here
 * leaves `ChatView` with wiring only: every value still reaches the same child,
 * so the panels bail out of re-renders on exactly the same prop identities.
 */
import type { ComponentProps } from 'react';
import { hasPersistedChains } from './chat-view-selectors';
import type { ChatStream } from '../ChatStream';
import type { LeftSidebar } from '../LeftSidebar';
import type { Sidebar } from '../Sidebar';
import type { SessionActivity } from '../../../shared/types/ipc-boundary';
import type { MachineRecord } from '../../../shared/types/machine';
import type { UseBackgroundCommandsReturn } from '../../hooks/useBackgroundCommands';
import type { UseChatReturn } from '../../hooks/useChat';
import type { UseDebugRequestsReturn } from '../../hooks/useDebugRequests';
import type { UseSubagentsReturn } from '../../hooks/useSubagents';
import type { UseSessionReturn } from '../../hooks/useSession';
import type { UseTodosReturn } from '../../hooks/useTodos';
import type { UseChatViewIndexStatusReturn } from './use-chat-view-index-status';
import type { UseChatViewSessionActionsReturn } from './use-chat-view-session-actions';
import type { UseChatViewSessionSurfacesReturn } from './use-chat-view-session-surfaces';

export interface ChatViewRailModel {
  readonly session: UseSessionReturn;
  readonly activities: readonly SessionActivity[];
  readonly collapsed: boolean;
  readonly overlay: boolean;
  /** The native folder picker is a local-machine capability. */
  readonly canPickProjectDir: boolean;
  readonly machine: MachineRecord | null;
  readonly switchActions: UseChatViewSessionSurfacesReturn;
  readonly sessionActions: UseChatViewSessionActionsReturn;
  readonly openSettings: () => void;
  readonly openAnalytics: () => void;
  readonly onToggle: () => void;
}

/** Sessions rail: library, workspace chip, activity rows, and project rows. */
export function buildSessionsRailProps(
  model: ChatViewRailModel,
): ComponentProps<typeof LeftSidebar> {
  const { session, switchActions, sessionActions } = model;
  const showsMachineChip = model.machine != null && !model.canPickProjectDir;
  const boundWorkspaceCwd = session.workspace?.status === 'valid' ? session.workspace.cwd : null;
  return {
    activeSessionId: session.activeSession?.id ?? null,
    selectedProjectPath: session.activeSession?.cwd ?? boundWorkspaceCwd,
    isCollapsed: model.collapsed,
    isOverlay: model.overlay,
    onOpenSettings: model.openSettings,
    onOpenAnalytics: model.openAnalytics,
    onPickProjectDir: model.canPickProjectDir ? switchActions.handlePickProjectDirClick : undefined,
    projectPickerCreatesDraft: hasPersistedChains(session.activeSession),
    onRefreshSessions: session.refresh,
    onSessionCreate: switchActions.handleSessionCreateClick,
    onProjectSessionCreate: switchActions.handleProjectSessionCreateClick,
    onProjectSelect: switchActions.handleProjectSelect,
    onProjectDelete: sessionActions.handleProjectDelete,
    onSessionDelete: sessionActions.handleSessionDelete,
    onSessionDeleteError: sessionActions.handleSessionDeleteError,
    deletingSessionIds: session.pendingDeleteIds,
    onSessionSelect: switchActions.handleSessionSelect,
    onSessionRename: sessionActions.handleSessionRename,
    activities: model.activities,
    onStopSession: sessionActions.handleStopSession,
    onToggle: model.onToggle,
    sessionListState: session.listState,
    workspace: session.workspace,
    machineLabel: showsMachineChip ? model.machine?.label ?? null : null,
    onTrustBadgeClick: switchActions.handleTrustBadgeClick,
  };
}

export interface ChatViewStreamModel {
  readonly chat: UseChatReturn;
  readonly subagents: UseSubagentsReturn;
  readonly session: UseSessionReturn;
  readonly alwaysExpandToolGroups: boolean;
  readonly workspaceBound: boolean;
  readonly canPickProjectDir: boolean;
  readonly onPickProjectDir: () => void;
  readonly onOpenSettings: () => void;
  readonly onRetry: () => Promise<void>;
  readonly onLoadHistoryPage: (chainIndex: number) => Promise<void>;
}

/** Transcript surface; visibility is owned by the deferred surface wrapper. */
export function buildChatStreamProps(
  model: ChatViewStreamModel,
): Omit<ComponentProps<typeof ChatStream>, 'isVisible'> {
  const { chat, subagents, session } = model;
  const offersProjectPicker = !model.workspaceBound && model.canPickProjectDir;
  return {
    messages: chat.messages,
    streamingContent: chat.streamingContent,
    toolBlocks: chat.toolBlocks,
    streamSegments: chat.streamSegments,
    streamRevision: chat.streamRevision,
    status: chat.status,
    error: chat.error,
    usage: chat.usage,
    currentTurnUsage: chat.currentTurnUsage,
    subagentUsage: subagents.usageSummary,
    subagents: subagents.subagents,
    sessionChains: session.activeSession?.chains ?? [],
    sessionId: session.activeSession?.id ?? null,
    onClearError: chat.clearError,
    onOpenSettings: model.onOpenSettings,
    onPickProjectDir: offersProjectPicker ? model.onPickProjectDir : undefined,
    workspaceUnbound: !model.workspaceBound,
    onRetry: model.onRetry,
    streamStartTime: chat.streamStartTime,
    interrupted: chat.interrupted,
    alwaysExpandToolGroups: model.alwaysExpandToolGroups,
    onLoadHistoryPage: model.onLoadHistoryPage,
    compactionProgress: chat.compactionProgress,
  };
}

export interface ChatViewInspectorModel {
  readonly open: boolean;
  readonly overlay: boolean;
  readonly onToggle: () => void;
  readonly subagents: UseSubagentsReturn;
  readonly todos: UseTodosReturn;
  readonly commands: UseBackgroundCommandsReturn;
  readonly debugRequests: UseDebugRequestsReturn;
  readonly index: UseChatViewIndexStatusReturn;
  readonly chat: UseChatReturn;
  readonly sessionId: string | null;
  readonly maxContext: number | null;
  readonly focusSection: string | null;
  readonly onFocusSectionConsumed: () => void;
  readonly onOpenSubagentView: (id?: string) => void;
}

/** Right inspector: subagents, todos, commands, requests, index, and context. */
export function buildInspectorProps(
  model: ChatViewInspectorModel,
): ComponentProps<typeof Sidebar> {
  const { subagents, todos, commands, debugRequests, index, chat } = model;
  return {
    isOpen: model.open,
    isOverlay: model.overlay,
    onToggle: model.onToggle,
    subagentState: subagents.state,
    onRefreshSubagents: subagents.refresh,
    selectedSubagentId: subagents.selectedId,
    onSelectSubagent: subagents.select,
    getSubagentDetail: subagents.getDetail,
    onOpenSubagentView: model.onOpenSubagentView,
    todoState: todos.state,
    onRefreshTodos: todos.refresh,
    commandsState: commands.state,
    onRefreshCommands: commands.refresh,
    requestsState: debugRequests.state,
    onRefreshRequests: debugRequests.refresh,
    onShowMoreRequests: debugRequests.showMore,
    selectedRequestId: debugRequests.selectedId,
    onSelectRequest: debugRequests.select,
    requestCapture: debugRequests.capture,
    onRetryRequestCapture: debugRequests.retryCapture,
    sessionId: model.sessionId,
    mcpServers: index.mcpServers,
    ragStatus: index.ragStatus,
    astStatus: index.astStatus,
    autoRefreshing: index.autoRefreshing,
    onIndexRAG: index.onIndexRAG,
    onIndexAST: index.onIndexAST,
    onRefreshIndex: index.refreshIndex,
    usage: chat.usage,
    cumulativeUsage: chat.cumulativeUsage,
    maxContext: model.maxContext,
    messages: chat.messages,
    streamingThinkingChars: Math.floor(chat.streamingUnaccountedThinkingChars / 500) * 500 || undefined,
    focusSection: model.focusSection,
    onFocusSectionConsumed: model.onFocusSectionConsumed,
  };
}
