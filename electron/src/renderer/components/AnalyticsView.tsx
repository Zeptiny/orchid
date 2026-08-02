import { Suspense, lazy, useState, useCallback, useRef, useEffect } from 'react';
import { useFocusTrap } from '../keyboard';
import { Button } from './ui/Button';
import { StateMessage } from './ui/StateMessage';
import { OverviewTab } from './analytics/OverviewTab';

type AnalyticsTab = 'overview' | 'sessions' | 'models' | 'tools' | 'subagents' | 'context';

const TABS: ReadonlyArray<{ id: AnalyticsTab; label: string }> = [
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
}

export function AnalyticsView({ onClose }: AnalyticsViewProps) {
  const [activeTab, setActiveTab] = useState<AnalyticsTab>('overview');
  const rootRef = useRef<HTMLDivElement>(null);

  useFocusTrap({ enabled: true, containerRef: rootRef });

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const renderTab = useCallback(() => {
    switch (activeTab) {
      case 'overview':
        return <OverviewTab />;
      case 'sessions':
        return (
          <Suspense fallback={<StateMessage kind="loading" title="Loading Sessions…" />}>
            <SessionsTab />
          </Suspense>
        );
      case 'models':
        return (
          <Suspense fallback={<StateMessage kind="loading" title="Loading Models…" />}>
            <ModelsProvidersTab />
          </Suspense>
        );
      case 'tools':
        return (
          <Suspense fallback={<StateMessage kind="loading" title="Loading Tools…" />}>
            <ToolsTab />
          </Suspense>
        );
      case 'subagents':
        return (
          <Suspense fallback={<StateMessage kind="loading" title="Loading Subagents…" />}>
            <SubagentsTab />
          </Suspense>
        );
      case 'context':
        return (
          <Suspense fallback={<StateMessage kind="loading" title="Loading Context…" />}>
            <ContextTab />
          </Suspense>
        );
    }
  }, [activeTab]);

  return (
    <div ref={rootRef} className="analytics-shell absolute inset-0 z-50 flex bg-base-100 text-base-content" role="dialog" aria-label="Analytics">
      <div className="flex w-48 flex-col border-r border-base-300 bg-base-200/50">
        <div className="px-4 py-3 text-sm font-bold uppercase tracking-wide text-base-content/60">Analytics</div>
        <nav className="flex-1 space-y-1 px-2">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              className={`w-full rounded-md px-3 py-2 text-left text-sm transition-colors ${
                activeTab === tab.id
                  ? 'bg-primary/15 text-primary font-medium'
                  : 'text-base-content/70 hover:bg-base-300/50'
              }`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-base-300 px-4 py-2">
          <span className="text-sm text-base-content/60">{TABS.find((t) => t.id === activeTab)?.label}</span>
          <Button variant="ghost" size="xs" onClick={onClose} aria-label="Close analytics">✕</Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          {renderTab()}
        </div>
      </div>
    </div>
  );
}
