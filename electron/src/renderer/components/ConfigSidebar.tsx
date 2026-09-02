/**
 * ConfigSidebar — the global session sidebar rendered next to the settings
 * panes. Selecting a session hands control back to ChatView; picking a
 * project or creating a session enters a draft bound to that workspace.
 */
import { useCallback } from 'react';
import type { UseSessionActivityReturn } from '../hooks/useSessionActivity';
import { useMachines } from '../hooks/useMachines';
import type { UseSessionReturn } from '../hooks/useSession';
import type { Notify } from '../utils/notify';
import { LeftSidebar } from './LeftSidebar';

interface ConfigSidebarProps {
  session: UseSessionReturn;
  activity: UseSessionActivityReturn;
  isCollapsed: boolean;
  onToggleCollapsed: () => void;
  onOpenAnalytics?: () => void;
  onSelectSession: (id: string) => void;
  onNotify: Notify;
}

export function ConfigSidebar({
  session,
  activity,
  isCollapsed,
  onToggleCollapsed,
  onOpenAnalytics,
  onSelectSession,
  onNotify,
}: ConfigSidebarProps) {
  const machines = useMachines();

  const handleSessionCreate = useCallback(async () => {
    // Draft in the currently selected project — do not open a folder picker.
    const inheritCwd =
      session.activeSession?.cwd?.trim() ||
      (session.workspace?.status === 'valid' ? session.workspace.cwd : null);
    if (inheritCwd) {
      await session.setWorkspace(inheritCwd);
    }
    await session.enterDraft();
  }, [session]);

  const handleProjectSelect = useCallback(async (projectDir: string) => {
    await session.setWorkspace(projectDir);
    await session.enterDraft();
  }, [session]);

  const handleProjectSessionCreate = useCallback(async (projectDir: string) => {
    await session.setWorkspace(projectDir);
    await session.enterDraft();
  }, [session]);

  const handleStopSession = useCallback((sessionId: string) => {
    void window.orchid?.chat?.stop?.({ sessionId });
  }, []);

  const handleSessionDeleteError = useCallback((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    onNotify(`Delete failed: ${message}`, 'error');
  }, [onNotify]);

  return (
    <LeftSidebar
      activeSessionId={session.activeSession?.id ?? null}
      selectedProjectPath={
        session.activeSession?.cwd ??
        (session.workspace?.status === 'valid' ? session.workspace.cwd : null)
      }
      isCollapsed={isCollapsed}
      activeView="settings"
      onOpenSettings={() => {}}
      onOpenAnalytics={onOpenAnalytics}
      onPickProjectDir={machines.isActiveMachineLocal ? () => {
        void session.pickProjectDir();
      } : undefined}
      onRefreshSessions={session.refresh}
      onSessionCreate={() => {
        void handleSessionCreate();
      }}
      onProjectSelect={(projectDir) => {
        void handleProjectSelect(projectDir);
      }}
      onProjectSessionCreate={(projectDir) => {
        void handleProjectSessionCreate(projectDir);
      }}
      onSessionDelete={session.deleteSession}
      onSessionDeleteError={handleSessionDeleteError}
      deletingSessionIds={session.pendingDeleteIds}
      onSessionSelect={onSelectSession}
      activities={activity.activities}
      onStopSession={handleStopSession}
      onToggle={onToggleCollapsed}
      sessionListState={session.listState}
      workspace={session.workspace}
    />
  );
}
