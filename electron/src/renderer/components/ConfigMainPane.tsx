/**
 * ConfigMainPane — the configuration main column shell: header with save /
 * close, the error banner, the section tab bar, the tab content (children),
 * and the shortcut footer.
 */
import type { ReactNode } from 'react';
import type { ConfigTabItem, TabId } from './ConfigTabPanes';
import { Keycaps } from './Keycaps';
import { Alert } from './ui/Alert';
import { Button } from './ui/Button';
import { StatusBadge } from './ui/StatusBadge';
import { Tabs } from './ui/Tabs';

interface ConfigMainPaneProps {
  isDirty: boolean;
  saving: boolean;
  error: string | null;
  tabItems: readonly ConfigTabItem[];
  activeTab: TabId;
  onDismissError: () => void;
  onSave: () => void;
  onClose: () => void;
  onTabChange: (id: string) => void;
  children: ReactNode;
}

export function ConfigMainPane({
  isDirty,
  saving,
  error,
  tabItems,
  activeTab,
  onDismissError,
  onSave,
  onClose,
  onTabChange,
  children,
}: ConfigMainPaneProps) {
  return (
    <main className="flex min-h-0 min-w-0 flex-col bg-base-100">
      <header className="config-main-header">
        <div className="config-main-header-text">
          <h1 className="truncate">Configuration</h1>
          <p className="truncate">
            Global app settings from merged defaults, home config, project config, and env overrides.
          </p>
        </div>
        <div className="config-main-header-actions">
          {isDirty && (
            <StatusBadge tone="warning" size="sm" outline>
              Unsaved
            </StatusBadge>
          )}
          <Button
            variant="primary"
            size="sm"
            onClick={onSave}
            disabled={!isDirty || saving}
            loading={saving}
          >
            Save
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </header>

      {error && (
        <Alert
          tone="error"
          className="orchid-state-enter rounded-none py-2.5 text-sm"
          icon="alert"
          iconSize={14}
          action={
            <Button variant="ghost" size="xs" onClick={onDismissError}>
              Dismiss
            </Button>
          }
        >
          {error}
        </Alert>
      )}

      <Tabs
        items={tabItems}
        value={activeTab}
        onValueChange={onTabChange}
        variant="boxed"
        className="config-tabs bg-base-200"
        itemClassName="config-tab"
        activeItemClassName="config-tab-active"
        aria-label="Configuration sections"
      />

      {children}

      <footer className="config-footer-bar orchid-shortcut-bar">
        <span className="orchid-shortcut-bar-item">
          <Keycaps chord={{ key: 's', mod: true }} size="xs" />
          <span>save</span>
        </span>
        <span className="orchid-shortcut-bar-item">
          <Keycaps chord="Esc" size="xs" />
          <span>close</span>
        </span>
        <span className="config-footer-meta">
          Config layers: defaults, home, project, env
        </span>
      </footer>
    </main>
  );
}
