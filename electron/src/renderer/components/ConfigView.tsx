import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ComponentType, LazyExoticComponent } from 'react';
import type { DefinitionsListResult } from '../../shared/types/definitions';
import type { Config } from '../../shared/types/ipc-boundary';
import { ConfigMainPane } from './ConfigMainPane';
import { ConfigSidebar } from './ConfigSidebar';
import {
  renderTab,
  TABS,
  type ConfigTabComponents,
  type ConfigTabPaneProps,
  type TabId,
} from './ConfigTabPanes';
import { useConfigDraft, type ConfigDraftOwner } from '../hooks/useConfigDraft';
import { useProviders, type UseProvidersReturn } from '../hooks/useProviders';
import { useSession } from '../hooks/useSession';
import type { UseSessionActivityReturn } from '../hooks/useSessionActivity';
import { useFocusTrap, useGlobalShortcuts } from '../keyboard';
import { applyConfigDraft } from '../utils/config-draft';
import { emitOrchidEvent } from '../utils/events';
import type { Notify } from '../utils/notify';
import { Button } from './ui/Button';
import { DialogSurface } from './ui/DialogSurface';
import { StateMessage } from './ui/StateMessage';

type LoadableComponent = ComponentType<any>; // eslint-disable-line @typescript-eslint/no-explicit-any

interface PreloadableLazyComponent<T extends LoadableComponent>
  extends LazyExoticComponent<T> {
  preload: () => Promise<{ default: T }>;
}

function lazyWithPreload<T extends LoadableComponent>(
  loadModule: () => Promise<{ default: T }>,
): PreloadableLazyComponent<T> {
  let promise: Promise<{ default: T }> | null = null;
  const load = () => {
    promise ??= loadModule();
    return promise;
  };
  return Object.assign(lazy(load), { preload: load });
}

const AgentsTab = lazyWithPreload(() => import('./Preferences/AgentsTab').then((module) => ({
  default: module.AgentsTab,
})));
const GeneralTab = lazyWithPreload(() => import('./Preferences/GeneralTab').then((module) => ({
  default: module.GeneralTab,
})));
const MCPServersTab = lazyWithPreload(() => import('./Preferences/MCPServersTab').then((module) => ({
  default: module.MCPServersTab,
})));
const PermissionsTab = lazyWithPreload(() => import('./Preferences/PermissionsTab').then((module) => ({
  default: module.PermissionsTab,
})));
const PersonalitiesTab = lazyWithPreload(() => import('./Preferences/PersonalitiesTab').then((module) => ({
  default: module.PersonalitiesTab,
})));
const ProvidersTab = lazyWithPreload(() => import('./Preferences/ProvidersTab').then((module) => ({
  default: module.ProvidersTab,
})));
const RAGTab = lazyWithPreload(() => import('./Preferences/RAGTab').then((module) => ({
  default: module.RAGTab,
})));
const SharedPromptsTab = lazyWithPreload(() => import('./Preferences/SharedPromptsTab').then((module) => ({
  default: module.SharedPromptsTab,
})));
const SkillsTab = lazyWithPreload(() => import('./Preferences/SkillsTab').then((module) => ({
  default: module.SkillsTab,
})));
const TierModelsTab = lazyWithPreload(() => import('./Preferences/TierModelsTab').then((module) => ({
  default: module.TierModelsTab,
})));
const SubagentsTab = lazyWithPreload(() => import('./Preferences/SubagentsTab').then((module) => ({
  default: module.SubagentsTab,
})));
const AgentsMdTab = lazyWithPreload(() => import('./Preferences/AgentsMdTab').then((module) => ({
  default: module.AgentsMdTab,
})));
const TrustedProjectsTab = lazyWithPreload(() => import('./Preferences/TrustedProjectsTab').then((module) => ({
  default: module.TrustedProjectsTab,
})));
const MachinesTab = lazyWithPreload(() => import('./Preferences/MachinesTab').then((module) => ({
  default: module.MachinesTab,
})));
const CompactionTab = lazyWithPreload(() => import('./Preferences/CompactionTab').then((module) => ({
  default: module.CompactionTab,
})));

const TAB_COMPONENTS = {
  general: GeneralTab,
  permissions: PermissionsTab,
  'trusted-projects': TrustedProjectsTab,
  providers: ProvidersTab,
  machines: MachinesTab,
  mcp: MCPServersTab,
  'tier-models': TierModelsTab,
  rag: RAGTab,
  'agents-md': AgentsMdTab,
  subagents: SubagentsTab,
  compaction: CompactionTab,
  skills: SkillsTab,
  agents: AgentsTab,
  personalities: PersonalitiesTab,
  'shared-prompts': SharedPromptsTab,
} satisfies ConfigTabComponents;

interface TabPrefetchData {
  providers: UseProvidersReturn;
  definitions: DefinitionsListResult | null;
  loadDefinitions: (opts?: { silent?: boolean }) => Promise<void>;
}

function tabNeedsModelList(tab: TabId): boolean {
  return tab === 'tier-models' || tab === 'rag';
}

const DEFINITION_TABS: readonly TabId[] = [
  'skills',
  'agents',
  'personalities',
  'shared-prompts',
];

function tabNeedsDefinitions(tab: TabId): boolean {
  return DEFINITION_TABS.includes(tab);
}

async function prefetchTabData(tab: TabId, data: TabPrefetchData): Promise<void> {
  const { providers, definitions, loadDefinitions } = data;
  if (tab === 'providers') {
    if (!providers.overview) await providers.refresh();
  } else if (tabNeedsModelList(tab)) {
    await providers.ensureModelList();
  } else if (tabNeedsDefinitions(tab)) {
    if (!definitions) await loadDefinitions({ silent: true });
  }
}

interface ConfigViewProps {
  onClose: () => void;
  initialTab?: TabId;
  onNotify: Notify;
  onOpenAnalytics?: () => void;
  activity: UseSessionActivityReturn;
}

/** Pane props assembled from the draft owner for the active tab renderer. */
function buildTabPaneProps(
  config: Config,
  draft: ConfigDraftOwner,
  onNotify: Notify,
): ConfigTabPaneProps {
  return {
    config,
    updateDraft: draft.updateDraft,
    personalities: draft.personalities,
    definitions: draft.definitions,
    reloadDefinitions: draft.loadDefinitions,
    permission: {
      config: draft.permissionConfig ?? config,
      scope: draft.permissionScope,
      projectDir: draft.permissionScopes?.projectDir ?? null,
      inheritedPermissions: draft.permissionScopes?.global ?? {},
      projectLoading: draft.projectScopeLoading,
      onScopeChange: draft.setPermissionScope,
      updateDraft: draft.permissionScope === 'project'
        ? draft.updateProjectPermissionDraft
        : draft.updateDraft,
    },
    onNotify,
  };
}

/** Unsaved/restart dialog coordination: close intents, save-and-close, discard. */
function useConfigDialogFlow(onClose: () => void, draft: ConfigDraftOwner) {
  const {
    discardDraft,
    dismissRestartDialog,
    handleSave,
    isDirty,
    showRestartDialog,
  } = draft;
  const [showUnsavedDialog, setShowUnsavedDialog] = useState(false);

  const requestClose = useCallback(() => {
    if (isDirty) {
      setShowUnsavedDialog(true);
      return;
    }
    onClose();
  }, [isDirty, onClose]);

  const hideUnsavedDialog = useCallback(() => setShowUnsavedDialog(false), []);

  const handleCloseShortcut = useCallback(() => {
    if (showUnsavedDialog) {
      hideUnsavedDialog();
      return;
    }
    if (showRestartDialog) {
      dismissRestartDialog();
      return;
    }
    requestClose();
  }, [
    showUnsavedDialog,
    hideUnsavedDialog,
    showRestartDialog,
    dismissRestartDialog,
    requestClose,
  ]);

  const handleSaveAndClose = useCallback(async () => {
    if (await handleSave()) onClose();
  }, [handleSave, onClose]);

  const handleDiscardAndClose = useCallback(() => {
    discardDraft();
    onClose();
  }, [discardDraft, onClose]);

  const handleReturnToChat = useCallback(() => {
    dismissRestartDialog();
    onClose();
  }, [dismissRestartDialog, onClose]);

  return {
    dismissRestartDialog,
    handleCloseShortcut,
    handleDiscardAndClose,
    handleReturnToChat,
    handleSaveAndClose,
    hideUnsavedDialog,
    requestClose,
    showRestartDialog,
    showUnsavedDialog,
  };
}

export function ConfigView({ onClose, initialTab = 'general', onNotify, onOpenAnalytics, activity }: ConfigViewProps) {
  const session = useSession();
  const providers = useProviders();
  const rootRef = useRef<HTMLDivElement>(null);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  /** Tab currently painted — only advances after target tab data is ready. */
  const [activeTab, setActiveTab] = useState<TabId>(initialTab);
  const [pendingTab, setPendingTab] = useState<TabId | null>(null);
  const tabSwitchGen = useRef(0);

  useFocusTrap({
    enabled: true,
    containerRef: rootRef,
  });

  useEffect(() => {
    tabSwitchGen.current += 1;
    setActiveTab(initialTab);
    setPendingTab(null);
  }, [initialTab]);

  const draftOwner = useConfigDraft(providers);
  const { error, handleSave, isDirty, loading, saving, setError } = draftOwner;
  const {
    dismissRestartDialog,
    handleCloseShortcut,
    handleDiscardAndClose,
    handleReturnToChat,
    handleSaveAndClose,
    hideUnsavedDialog,
    requestClose,
    showRestartDialog,
    showUnsavedDialog,
  } = useConfigDialogFlow(onClose, draftOwner);

  const currentConfig = useMemo(() => {
    if (!draftOwner.originalConfig) return null;
    return applyConfigDraft(draftOwner.originalConfig, draftOwner.draft);
  }, [draftOwner.originalConfig, draftOwner.draft]);

  const tabItems = useMemo(
    () => TABS.map((tab) => ({ ...tab, ariaBusy: pendingTab === tab.id })),
    [pendingTab],
  );

  /**
   * Switch tabs only after the target surface's data is ready — keep painting
   * the previous tab (no spinner / empty intermediate state).
   */
  const requestTab = useCallback(async (tab: TabId) => {
    if (tab === activeTab && pendingTab == null) return;
    const gen = ++tabSwitchGen.current;
    setPendingTab(tab);

    // Still switch after either failure — the tab will show its own error/empty content.
    await Promise.allSettled([
      TAB_COMPONENTS[tab].preload(),
      prefetchTabData(tab, {
        providers,
        definitions: draftOwner.definitions,
        loadDefinitions: draftOwner.loadDefinitions,
      }),
    ]);

    if (gen !== tabSwitchGen.current) return;
    setActiveTab(tab);
    setPendingTab(null);
  }, [
    activeTab,
    pendingTab,
    providers,
    draftOwner.definitions,
    draftOwner.loadDefinitions,
  ]);

  useGlobalShortcuts({
    handlers: {
      'config.save': () => {
        void handleSave();
      },
      'config.close': handleCloseShortcut,
    },
  });

  const handleSessionSelect = useCallback(
    (id: string) => {
      emitOrchidEvent('orchid:select-session', { id });
      onClose();
    },
    [onClose],
  );

  return (
    <div
      ref={rootRef}
      className="config-shell grid h-screen min-h-0 overflow-hidden bg-base-100 text-base-content"
    >
      <ConfigSidebar
        session={session}
        activity={activity}
        isCollapsed={leftCollapsed}
        onToggleCollapsed={() => setLeftCollapsed((prev) => !prev)}
        onOpenAnalytics={onOpenAnalytics}
        onSelectSession={handleSessionSelect}
        onNotify={onNotify}
      />

      <ConfigMainPane
        isDirty={isDirty}
        saving={saving}
        error={error}
        tabItems={tabItems}
        activeTab={activeTab}
        onDismissError={() => setError(null)}
        onSave={handleSave}
        onClose={requestClose}
        onTabChange={(id) => { void requestTab(id as TabId); }}
      >
        <ConfigTabContent
          activeTab={activeTab}
          currentConfig={currentConfig}
          loading={loading}
          draft={draftOwner}
          onNotify={onNotify}
        />
      </ConfigMainPane>

      <ConfigUnsavedChangesDialog
        isOpen={showUnsavedDialog}
        onClose={hideUnsavedDialog}
        onSaveAndClose={handleSaveAndClose}
        onDiscardAndClose={handleDiscardAndClose}
      />

      <ConfigRestartRequiredDialog
        isOpen={showRestartDialog}
        onDismiss={dismissRestartDialog}
        onReturnToChat={handleReturnToChat}
      />
    </div>
  );
}

interface ConfigTabContentProps {
  activeTab: TabId;
  currentConfig: Config | null;
  loading: boolean;
  draft: ConfigDraftOwner;
  onNotify: Notify;
}

function ConfigTabContent({
  activeTab,
  currentConfig,
  loading,
  draft,
  onNotify,
}: ConfigTabContentProps) {
  return (
    <div className="config-body">
      <div key={activeTab} className="orchid-view-enter">
        {loading ? (
          <StateMessage kind="loading" title="Loading configuration…" />
        ) : currentConfig ? (
          <Suspense
            fallback={(
              <StateMessage
                kind="loading"
                title="Loading settings section…"
                className="min-h-48"
                role="status"
                aria-live="polite"
              />
            )}
          >
            {renderTab(
              activeTab,
              buildTabPaneProps(currentConfig, draft, onNotify),
              TAB_COMPONENTS,
            )}
          </Suspense>
        ) : (
          <StateMessage kind="warning" title="Configuration could not be loaded." />
        )}
      </div>
    </div>
  );
}

interface ConfigUnsavedChangesDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSaveAndClose: () => Promise<void>;
  onDiscardAndClose: () => void;
}

function ConfigUnsavedChangesDialog({
  isOpen,
  onClose,
  onSaveAndClose,
  onDiscardAndClose,
}: ConfigUnsavedChangesDialogProps) {
  const saveButtonRef = useRef<HTMLButtonElement>(null);

  return (
    <DialogSurface
      isOpen={isOpen}
      onClose={onClose}
      labelledBy="config-unsaved-title"
      describedBy="config-unsaved-desc"
      initialFocusRef={saveButtonRef}
      variant="modal"
      closeOnBackdrop={false}
    >
      <h2 id="config-unsaved-title" className="text-lg font-semibold">
        Unsaved changes
      </h2>
      <p id="config-unsaved-desc" className="py-3 text-sm text-base-content/70">
        Save your configuration changes before returning to chat?
      </p>
      <div className="modal-action">
        <Button
          ref={saveButtonRef}
          variant="primary"
          onClick={() => { void onSaveAndClose(); }}
        >
          Save
        </Button>
        <Button variant="error" onClick={onDiscardAndClose}>
          Discard
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </DialogSurface>
  );
}

interface ConfigRestartRequiredDialogProps {
  isOpen: boolean;
  onDismiss: () => void;
  onReturnToChat: () => void;
}

function ConfigRestartRequiredDialog({
  isOpen,
  onDismiss,
  onReturnToChat,
}: ConfigRestartRequiredDialogProps) {
  const returnButtonRef = useRef<HTMLButtonElement>(null);

  return (
    <DialogSurface
      isOpen={isOpen}
      onClose={onDismiss}
      labelledBy="config-restart-title"
      describedBy="config-restart-desc"
      initialFocusRef={returnButtonRef}
      variant="modal"
      closeOnBackdrop={false}
    >
      <h2 id="config-restart-title" className="text-lg font-semibold">
        Restart required
      </h2>
      <p id="config-restart-desc" className="py-3 text-sm text-base-content/70">
        MCP server changes require an application restart to take effect.
      </p>
      <div className="modal-action">
        <Button ref={returnButtonRef} variant="primary" onClick={onReturnToChat}>
          Return to chat
        </Button>
        <Button variant="ghost" onClick={onDismiss}>
          Later
        </Button>
      </div>
    </DialogSurface>
  );
}
