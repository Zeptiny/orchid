/**
 * useConfigDraft — owns the ConfigView draft lifecycle: loads the merged
 * config, definitions, and permission scopes, accumulates edits as a patch
 * (global draft plus per-project permission drafts), and runs the staged
 * save pipeline (settings → global permissions → project permissions).
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import type { DefinitionsListResult } from '../../shared/types/definitions';
import type { Config, PermissionRule } from '../../shared/types/ipc-boundary';
import type {
  ConfigPatch,
  ConfigPatchMap,
  PermissionConfigScope,
  PermissionConfigScopes,
} from '../../shared/types/ipc';
import { applyConfigDraft, mergeConfigDraft } from '../utils/config-draft';
import {
  hasProjectPermissionDrafts,
  LatestRequestGuard,
  mergeProjectPermissionDraft,
  persistConfigSnapshot,
  reconcileConfigDraft,
  reconcileMapDraft,
  reconcileProjectPermissionDraft,
  SaveStartGuard,
  type ConfigPersistenceAPI,
  type ConfigSaveResult,
  type ConfigSaveSnapshot,
  type ConfigSaveStage,
  type ProjectPermissionDrafts,
} from '../utils/config-save';
import { withMapDeletionTombstones } from '../utils/config-tombstones';
import { emitOrchidEvent } from '../utils/events';
import type { UseProvidersReturn } from './useProviders';

type Setter<V> = Dispatch<SetStateAction<V>>;

/** All draft-owned state setters, bundled as a stable object for module helpers. */
interface ConfigDraftSetters {
  setLoading: Setter<boolean>;
  setSaving: Setter<boolean>;
  setError: Setter<string | null>;
  setOriginalConfig: Setter<Config | null>;
  setDraft: Setter<ConfigPatch>;
  setPermissionScope: Setter<PermissionConfigScope>;
  setPermissionScopes: Setter<PermissionConfigScopes | null>;
  setProjectScopeLoading: Setter<boolean>;
  setProjectPermissionDrafts: Setter<ProjectPermissionDrafts>;
  setPersonalities: Setter<string[]>;
  setDefinitions: Setter<DefinitionsListResult | null>;
  setDefsLoading: Setter<boolean>;
  setShowRestartDialog: Setter<boolean>;
}

const PARTIAL_SAVE_MESSAGE =
  'Available changes were saved, but project drafts for other workspaces remain unsaved. Switch back to each project to save them.';

const REFRESH_AFTER_SAVE_MESSAGE =
  'Configuration was saved, but refreshed values could not be loaded.';

function applyPermissionPatch(
  current: Record<string, PermissionRule>,
  patch: ConfigPatchMap<PermissionRule>,
): Record<string, PermissionRule> {
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value == null) delete next[key];
    else next[key] = value;
  }
  return next;
}

function reconcilePermissionDraft(
  current: ConfigPatch,
  persisted: ConfigPatchMap<PermissionRule>,
): ConfigPatch {
  const remaining = reconcileMapDraft(current.permissions ?? {}, persisted);
  const next = { ...current };
  if (Object.keys(remaining).length === 0) delete next.permissions;
  else next.permissions = remaining;
  return next;
}

/** Draft permission map owned by the active project directory, if any. */
function projectPermissionDraftFor(
  projectDir: string | null | undefined,
  drafts: ProjectPermissionDrafts,
): ConfigPatchMap<PermissionRule> {
  if (projectDir == null) return {};
  return drafts[projectDir] ?? {};
}

interface ProjectDraftTarget {
  projectDir: string;
  permissionUpdates: ConfigPatchMap<PermissionRule>;
}

/** Project draft writes are dropped while scope data is loading or unmapped. */
function resolveProjectDraftTarget(input: {
  projectScopeLoading: boolean;
  projectDir: string | null | undefined;
  permissionUpdates: ConfigPatchMap<PermissionRule> | undefined;
}): ProjectDraftTarget | null {
  const { projectScopeLoading, projectDir, permissionUpdates } = input;
  if (projectScopeLoading || !projectDir || !permissionUpdates) return null;
  return { projectDir, permissionUpdates };
}

function personalityNames(result: DefinitionsListResult): string[] {
  // Effective personality names for General dropdown (unique across scopes)
  return Array.from(
    new Set(result.personalities.map((p) => p.name)),
  ).sort((a, b) => a.localeCompare(b));
}

async function fetchPermissionScopes(
  guard: LatestRequestGuard,
  setters: ConfigDraftSetters,
): Promise<boolean> {
  const generation = guard.begin();
  setters.setProjectScopeLoading(true);
  setters.setPermissionScope('global');
  try {
    const scopes = await window.orchid?.config?.permissionScopes?.();
    if (!guard.isCurrent(generation) || !scopes) return false;
    setters.setPermissionScopes(scopes);
    return true;
  } catch {
    if (guard.isCurrent(generation)) {
      setters.setError('Failed to refresh project permission settings.');
    }
    return false;
  } finally {
    if (guard.isCurrent(generation)) setters.setProjectScopeLoading(false);
  }
}

async function fetchDefinitions(
  setters: ConfigDraftSetters,
  opts?: { silent?: boolean },
): Promise<void> {
  if (!window.orchid?.definitions?.list) {
    setters.setDefsLoading(false);
    return;
  }
  try {
    const result = await window.orchid.definitions.list();
    setters.setDefinitions(result);
    setters.setPersonalities(personalityNames(result));
  } catch (err) {
    // Keep previous cache; always surface the failure so silent refresh isn't invisible.
    const msg =
      err instanceof Error
        ? err.message
        : 'Failed to load skills, agents, and personalities.';
    setters.setError(opts?.silent ? `Definitions refresh failed: ${msg}` : msg);
  } finally {
    setters.setDefsLoading(false);
  }
}

async function loadInitialConfig(
  providers: UseProvidersReturn,
  setters: ConfigDraftSetters,
  isCancelled: () => boolean,
): Promise<void> {
  try {
    if (!window.orchid?.config?.get) throw new Error('Configuration API is not available.');
    const [config] = await Promise.all([
      window.orchid.config.get(),
      // Warm provider + model caches so Providers / Tier Models tabs
      // can switch without an intermediate empty frame.
      providers.ensureModelList().catch(() => undefined),
    ]);
    if (!isCancelled()) {
      setters.setOriginalConfig(config);
      setters.setLoading(false);
    }
  } catch {
    if (!isCancelled()) {
      setters.setError('Failed to load configuration.');
      setters.setLoading(false);
    }
  }
}

function requireConfigPersistenceApi(): ConfigPersistenceAPI {
  const config = window.orchid?.config;
  if (!config?.save) throw new Error('Configuration API is not available.');
  const savePermissionScope = config.savePermissionScope;
  if (!savePermissionScope) throw new Error('Permission configuration API is not available.');
  return { save: config.save, savePermissionScope };
}

function projectSaveEntry(
  projectDir: string | null,
  draft: ConfigPatchMap<PermissionRule> | undefined,
): ConfigSaveSnapshot['project'] {
  if (!projectDir || !draft || Object.keys(draft).length === 0) return undefined;
  return { projectDir, updates: draft };
}

function retainedProjectDirs(
  drafts: ProjectPermissionDrafts,
  activeProjectDir: string | null,
): string[] {
  return Object.entries(drafts)
    .filter(([projectDir, projectDraft]) => (
      projectDir !== activeProjectDir && Object.keys(projectDraft).length > 0
    ))
    .map(([projectDir]) => projectDir);
}

/** Immutable save plan: one snapshot plus the reconciliation inputs. */
interface ConfigSaveTransaction {
  snapshot: ConfigSaveSnapshot;
  ordinaryUpdates: ConfigPatch;
  ordinaryDraftSnapshot: ConfigPatch;
  globalPermissionUpdates: ConfigPatchMap<PermissionRule> | undefined;
  globalDraftSnapshot: ConfigPatchMap<PermissionRule> | undefined;
  activeProjectDir: string | null;
  activeProjectDraft: ConfigPatchMap<PermissionRule> | undefined;
}

function buildSaveTransaction(input: {
  draft: ConfigPatch;
  originalConfig: Config | null;
  permissionScopes: PermissionConfigScopes | null;
  projectPermissionDrafts: ProjectPermissionDrafts;
  projectScopeLoading: boolean;
}): ConfigSaveTransaction {
  const {
    draft,
    originalConfig,
    permissionScopes,
    projectPermissionDrafts,
    projectScopeLoading,
  } = input;
  const updates = withMapDeletionTombstones(draft, originalConfig);
  const { permissions: globalPermissionUpdates, ...ordinaryUpdates } = updates;
  const { permissions: globalDraftSnapshot, ...ordinaryDraftSnapshot } = draft;
  const activeProjectDir = projectScopeLoading ? null : permissionScopes?.projectDir ?? null;
  const activeProjectDraft = activeProjectDir == null
    ? undefined
    : projectPermissionDrafts[activeProjectDir];
  return {
    snapshot: {
      ordinary: ordinaryUpdates,
      globalPermissions: globalPermissionUpdates,
      project: projectSaveEntry(activeProjectDir, activeProjectDraft),
      retainedProjectDirs: retainedProjectDirs(projectPermissionDrafts, activeProjectDir),
    },
    ordinaryUpdates,
    ordinaryDraftSnapshot,
    globalPermissionUpdates,
    globalDraftSnapshot,
    activeProjectDir,
    activeProjectDraft,
  };
}

function applySettingsStage(
  transaction: ConfigSaveTransaction,
  setters: ConfigDraftSetters,
): void {
  const { ordinaryUpdates, ordinaryDraftSnapshot } = transaction;
  setters.setOriginalConfig((current) => current
    ? applyConfigDraft(current, ordinaryUpdates)
    : current);
  setters.setDraft((current) => reconcileConfigDraft(current, ordinaryDraftSnapshot));
  if (typeof ordinaryUpdates.theme === 'string') {
    emitOrchidEvent('orchid:set-theme', { theme: ordinaryUpdates.theme, persist: false });
  }
}

function applyGlobalPermissionsStage(
  transaction: ConfigSaveTransaction,
  setters: ConfigDraftSetters,
): void {
  const { globalPermissionUpdates, globalDraftSnapshot } = transaction;
  if (!globalPermissionUpdates) return;
  setters.setOriginalConfig((current) => current
    ? applyConfigDraft(current, { permissions: globalPermissionUpdates })
    : current);
  setters.setPermissionScopes((current) => current
    ? {
        ...current,
        global: applyPermissionPatch(current.global, globalPermissionUpdates),
      }
    : current);
  setters.setDraft((current) => reconcilePermissionDraft(
    current,
    globalDraftSnapshot ?? globalPermissionUpdates,
  ));
}

function applyProjectPermissionsStage(
  transaction: ConfigSaveTransaction,
  setters: ConfigDraftSetters,
): void {
  const { activeProjectDir, activeProjectDraft } = transaction;
  if (!activeProjectDir || !activeProjectDraft) return;
  setters.setPermissionScopes((current) => current?.projectDir === activeProjectDir
    ? {
        ...current,
        project: applyPermissionPatch(current.project, activeProjectDraft),
      }
    : current);
  setters.setProjectPermissionDrafts((current) => reconcileProjectPermissionDraft(
    current,
    activeProjectDir,
    activeProjectDraft,
  ));
}

function createSaveStageHandler(
  transaction: ConfigSaveTransaction,
  setters: ConfigDraftSetters,
): (stage: ConfigSaveStage) => void {
  return (stage) => {
    if (stage === 'settings') {
      applySettingsStage(transaction, setters);
    } else if (stage === 'global permissions') {
      applyGlobalPermissionsStage(transaction, setters);
    } else {
      applyProjectPermissionsStage(transaction, setters);
    }
  };
}

function saveFailureMessage(result: ConfigSaveResult): string {
  return result.completedStages.length > 0
    ? `Some changes were saved, but ${result.failedStage} could not be saved. Unsaved changes were retained.`
    : `Failed to save ${result.failedStage}. Unsaved changes were retained.`;
}

/** Reload canonical config + scopes after a save; true when the refresh failed. */
async function refreshConfigAfterSave(input: {
  completedStages: readonly ConfigSaveStage[];
  fallbackScopes: PermissionConfigScopes | null;
  guard: LatestRequestGuard;
  setters: ConfigDraftSetters;
}): Promise<boolean> {
  const { completedStages, fallbackScopes, guard, setters } = input;
  const configApi = window.orchid?.config;
  if (!configApi?.get || completedStages.length === 0) return false;
  const refreshGeneration = guard.begin();
  setters.setProjectScopeLoading(true);
  try {
    const [fresh, scopes] = await Promise.all([
      configApi.get(),
      configApi.permissionScopes?.() ?? Promise.resolve(fallbackScopes),
    ]);
    setters.setOriginalConfig({ ...fresh, permissions: fresh.permissions });
    emitOrchidEvent('orchid:config-updated', fresh);
    if (guard.isCurrent(refreshGeneration) && scopes) {
      setters.setPermissionScopes(scopes);
    }
  } catch {
    return true;
  } finally {
    if (guard.isCurrent(refreshGeneration)) {
      setters.setProjectScopeLoading(false);
    }
  }
  return false;
}

/** Everything the ConfigView shell needs from the draft owner. */
export interface ConfigDraftOwner {
  loading: boolean;
  saving: boolean;
  error: string | null;
  setError: Setter<string | null>;
  isDirty: boolean;
  originalConfig: Config | null;
  draft: ConfigPatch;
  definitions: DefinitionsListResult | null;
  defsLoading: boolean;
  personalities: string[];
  loadDefinitions: (opts?: { silent?: boolean }) => Promise<void>;
  permissionScope: PermissionConfigScope;
  /** Effective config for the permissions pane (project scope swaps layers). */
  permissionConfig: Config | null;
  setPermissionScope: Setter<PermissionConfigScope>;
  permissionScopes: PermissionConfigScopes | null;
  projectScopeLoading: boolean;
  projectPermissionDrafts: ProjectPermissionDrafts;
  updateDraft: (updates: ConfigPatch) => void;
  updateProjectPermissionDraft: (updates: ConfigPatch) => void;
  handleSave: () => Promise<boolean>;
  discardDraft: () => void;
  showRestartDialog: boolean;
  dismissRestartDialog: () => void;
}

export function useConfigDraft(providers: UseProvidersReturn): ConfigDraftOwner {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [originalConfig, setOriginalConfig] = useState<Config | null>(null);
  const [draft, setDraft] = useState<ConfigPatch>({});
  const [permissionScope, setPermissionScope] = useState<PermissionConfigScope>('global');
  const [permissionScopes, setPermissionScopes] = useState<PermissionConfigScopes | null>(null);
  const [projectScopeLoading, setProjectScopeLoading] = useState(true);
  const [projectPermissionDrafts, setProjectPermissionDrafts] = useState<ProjectPermissionDrafts>({});
  const [personalities, setPersonalities] = useState<string[]>([]);
  /**
   * Cached skills/agents/personalities for definition tabs.
   * Loaded once when Config opens so tab switches never flash a spinner.
   */
  const [definitions, setDefinitions] = useState<DefinitionsListResult | null>(null);
  const [defsLoading, setDefsLoading] = useState(true);
  const [showRestartDialog, setShowRestartDialog] = useState(false);
  const permissionScopeRequests = useRef(new LatestRequestGuard());
  const saveStartGuard = useRef(new SaveStartGuard());

  const setters = useMemo<ConfigDraftSetters>(() => ({
    setLoading,
    setSaving,
    setError,
    setOriginalConfig,
    setDraft,
    setPermissionScope,
    setPermissionScopes,
    setProjectScopeLoading,
    setProjectPermissionDrafts,
    setPersonalities,
    setDefinitions,
    setDefsLoading,
    setShowRestartDialog,
  }), []);

  const refreshPermissionScopes = useCallback(
    () => fetchPermissionScopes(permissionScopeRequests.current, setters),
    [setters],
  );

  const loadDefinitions = useCallback(
    (opts?: { silent?: boolean }) => fetchDefinitions(setters, opts),
    [setters],
  );

  useEffect(() => {
    let cancelled = false;
    setters.setLoading(true);
    setters.setError(null);
    setters.setDraft({});
    setters.setProjectPermissionDrafts({});

    // Prefetch definitions in parallel with config so Skills/Agents/Personalities
    // are ready before the user switches tabs.
    void loadInitialConfig(providers, setters, () => cancelled);
    void refreshPermissionScopes();
    void loadDefinitions();
    return () => {
      cancelled = true;
      permissionScopeRequests.current.invalidate();
    };
  }, [loadDefinitions, providers.ensureModelList, refreshPermissionScopes]);

  // Refresh when workspace binding changes; drop in-progress definition edits.
  useEffect(() => {
    const unsub = window.orchid?.session?.onWorkspaceChanged?.(() => {
      emitOrchidEvent('orchid:definitions-workspace-changed');
      void loadDefinitions({ silent: true });
      void refreshPermissionScopes();
    });
    return () => {
      unsub?.();
    };
  }, [loadDefinitions, refreshPermissionScopes]);

  const isDirty = Object.keys(draft).length > 0 || hasProjectPermissionDrafts(
    projectPermissionDrafts,
  );

  const permissionConfig = useMemo(() => {
    if (!originalConfig) return null;
    const base = applyConfigDraft(originalConfig, draft);
    if (permissionScope === 'global') return base;
    return applyConfigDraft(
      { ...base, permissions: permissionScopes?.project ?? {} },
      {
        permissions: projectPermissionDraftFor(
          permissionScopes?.projectDir,
          projectPermissionDrafts,
        ),
      },
    );
  }, [originalConfig, draft, permissionScope, permissionScopes, projectPermissionDrafts]);

  const updateDraft = useCallback((updates: ConfigPatch) => {
    setDraft((prev) => mergeConfigDraft(prev, updates));
  }, []);

  const updateProjectPermissionDraft = useCallback((updates: ConfigPatch) => {
    const target = resolveProjectDraftTarget({
      projectScopeLoading,
      projectDir: permissionScopes?.projectDir,
      permissionUpdates: updates.permissions,
    });
    if (!target) return;
    setProjectPermissionDrafts((current) => mergeProjectPermissionDraft(
      current,
      target.projectDir,
      target.permissionUpdates,
    ));
  }, [permissionScopes?.projectDir, projectScopeLoading]);

  const handleSave = useCallback(async (): Promise<boolean> => {
    if (!isDirty) return true;
    if (!saveStartGuard.current.tryStart()) return false;
    setSaving(true);
    setError(null);

    try {
      const api = requireConfigPersistenceApi();
      const transaction = buildSaveTransaction({
        draft,
        originalConfig,
        permissionScopes,
        projectPermissionDrafts,
        projectScopeLoading,
      });
      const result = await persistConfigSnapshot(
        transaction.snapshot,
        api,
        createSaveStageHandler(transaction, setters),
      );

      if (result.failedStage) {
        setError(saveFailureMessage(result));
        return false;
      }
      if (!result.ok) {
        setError(PARTIAL_SAVE_MESSAGE);
        return false;
      }

      const refreshFailed = await refreshConfigAfterSave({
        completedStages: result.completedStages,
        fallbackScopes: permissionScopes,
        guard: permissionScopeRequests.current,
        setters,
      });
      if (refreshFailed) setError(REFRESH_AFTER_SAVE_MESSAGE);
      if ('mcp_servers' in transaction.ordinaryUpdates) setShowRestartDialog(true);
      return true;
    } catch {
      setError('Failed to save configuration. Please try again.');
      return false;
    } finally {
      saveStartGuard.current.finish();
      setSaving(false);
    }
  }, [
    draft,
    isDirty,
    originalConfig,
    permissionScopes,
    projectPermissionDrafts,
    projectScopeLoading,
    setters,
  ]);

  const discardDraft = useCallback(() => {
    setDraft({});
    setProjectPermissionDrafts({});
  }, []);

  const dismissRestartDialog = useCallback(() => setShowRestartDialog(false), []);

  return {
    loading,
    saving,
    error,
    setError,
    isDirty,
    originalConfig,
    draft,
    definitions,
    defsLoading,
    personalities,
    loadDefinitions,
    permissionScope,
    permissionConfig,
    setPermissionScope,
    permissionScopes,
    projectScopeLoading,
    projectPermissionDrafts,
    updateDraft,
    updateProjectPermissionDraft,
    handleSave,
    discardDraft,
    showRestartDialog,
    dismissRestartDialog,
  };
}
