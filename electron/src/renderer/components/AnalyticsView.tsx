import { Suspense, lazy, useState, useCallback, useRef } from 'react';
import { useFocusTrap, useGlobalShortcuts } from '../keyboard';
import { useSession } from '../hooks/useSession';
import type { UseSessionActivityReturn } from '../hooks/useSessionActivity';
import { useTimeRange } from '../hooks/useTimeRange';
import { emitOrchidEvent } from '../utils/events';
import type { Notify } from '../utils/notify';
import { LeftSidebar } from './LeftSidebar';
import { Button } from './ui/Button';
import { StateMessage } from './ui/StateMessage';
import { Tabs } from './ui/Tabs';
import { OverviewTab } from './analytics/OverviewTab';
import { TimeRangeSelector } from './analytics/TimeRangeSelector';

type AnalyticsTab = 'overview' | 'sessions' | 'models' | 'tools' | 'subagents' | 'context';

const TAB_ITEMS: ReadonlyArray<{ id: AnalyticsTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'models', label: 'Models & Providers' },
  { id: 'tools', label: 'Tools' },
  { id: 'subagents', label: 'Subagents' },
  { id: 'context', label: 'Context' },
];

const SessionsTab = lazy(() => import('./analytics/SessionsTab').then((m) => ({ default: m.SessionsTab })));
const ModelsProvidersTab = lazy(() => import('./analytics/ModelsProvidersTab').then((m) => ({ default: m.ModelsProvidersTab })));
const ToolsTab = lazy(() => import('./analytics/ToolsTab').then((m) => ({ default: m.ToolsTab })));
const SubagentsTab = lazy(() => import('./analytics/SubagentsTab').then((m) => ({ default: m.SubagentsTab })));
const ContextTab = lazy(() => import('./analytics/ContextTab').then((m) => ({ default: m.ContextTab })));

interface AnalyticsViewProps {
  onClose: () => void;
  onOpenSettings?: () => void;
  onNotify: Notify;
  activity: UseSessionActivityReturn;
}

export function AnalyticsView({ onClose, onOpenSettings, onNotify, activity }: AnalyticsViewProps) {
  const session = useSession();
  const [activeTab, setActiveTab] = useState<AnalyticsTab>('overview');
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const timeRange = useTimeRange();

  useFocusTrap({ enabled: true, containerRef: rootRef });

  useGlobalShortcuts({
    handlers: {
      'config.close': () => {
        onClose();
      },
    },
  });

  const handleSessionSelect = useCallback(
    (id: string) => {
      emitOrchidEvent('orchid:select-session', { id });
      onClose();
    },
    [onClose],
  );

  const handleSessionCreate = useCallback(async () => {
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

  const renderTab = useCallback(() => {
    switch (activeTab) {
      case 'overview':
        return <OverviewTab timeRange={timeRange.resolved} />;
      case 'sessions':
        return (
          <Suspense fallback={<StateMessage kind="loading" title="Loading Sessions…" />}>
            <SessionsTab timeRange={timeRange.resolved} />
          </Suspense>
        );
      case 'models':
        return (
          <Suspense fallback={<StateMessage kind="loading" title="Loading Models…" />}>
            <ModelsProvidersTab timeRange={timeRange.resolved} />
          </Suspense>
        );
      case 'tools':
        return (
          <Suspense fallback={<StateMessage kind="loading" title="Loading Tools…" />}>
            <ToolsTab timeRange={timeRange.resolved} />
          </Suspense>
        );
      case 'subagents':
        return (
          <Suspense fallback={<StateMessage kind="loading" title="Loading Subagents…" />}>
            <SubagentsTab timeRange={timeRange.resolved} />
          </Suspense>
        );
      case 'context':
        return (
          <Suspense fallback={<StateMessage kind="loading" title="Loading Context…" />}>
            <ContextTab timeRange={timeRange.resolved} />
          </Suspense>
        );
    }
  }, [activeTab, timeRange.resolved]);

  return (
    <div
      ref={rootRef}
      className="config-shell grid h-screen min-h-0 overflow-hidden bg-base-100 text-base-content"
      role="dialog"
      aria-label="Analytics"
    >
      <LeftSidebar
        activeSessionId={session.activeSession?.id ?? null}
        selectedProjectPath={
          session.activeSession?.cwd ??
          (session.workspace?.status === 'valid' ? session.workspace.cwd : null)
        }
        isCollapsed={leftCollapsed}
        activeView="analytics"
        onOpenSettings={onOpenSettings ?? (() => {})}
        onOpenAnalytics={() => {}}
        onPickProjectDir={() => {
          void session.pickProjectDir();
        }}
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
        onSessionSelect={handleSessionSelect}
        activities={activity.activities}
        onStopSession={handleStopSession}
        onToggle={() => setLeftCollapsed((prev) => !prev)}
        sessionListState={session.listState}
        workspace={session.workspace}
      />

      <main className="flex min-h-0 min-w-0 flex-col bg-base-100">
        <header className="config-main-header">
          <div className="config-main-header-text">
            <h1 className="truncate">Analytics</h1>
            <p className="truncate">
              Usage insights — cost, tokens, tools, subagents, and context.
            </p>
          </div>
          <div className="config-main-header-actions">
            <Button variant="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        </header>

        <Tabs
          items={TAB_ITEMS}
          value={activeTab}
          onValueChange={(id) => setActiveTab(id as AnalyticsTab)}
          variant="boxed"
          className="config-tabs bg-base-200"
          itemClassName="config-tab"
          activeItemClassName="config-tab-active"
          aria-label="Analytics sections"
        />

        <TimeRangeSelector timeRange={timeRange} />

        <div className="config-body">
          <div key={activeTab} className="orchid-view-enter">
            {renderTab()}
          </div>
        </div>

        <footer className="orchid-shortcut-bar">
          <span className="orchid-shortcut-bar-item">
            <span>Esc</span>
            <span>close</span>
          </span>
          <span className="config-footer-meta">
            Data from local accounting ledger
          </span>
        </footer>
      </main>
    </div>
  );
}
