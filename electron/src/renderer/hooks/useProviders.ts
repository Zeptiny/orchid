/**
 * Connection-centred provider state for renderer surfaces.
 *
 * Shared module cache so Chat, Onboarding, and Config tabs reuse one overview
 * instead of each mounting with status:'loading' and an independent IPC fetch.
 * Works only with the redacted provider IPC API — never credentials or drivers.
 */
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type {
  ProviderConnectionCreateMessage,
  ProviderConnectionIdMessage,
  ProviderConnectionUpdateMessage,
  ProviderConnectionView,
  ProviderDisconnectMessage,
  ProviderModelOption,
  ProviderMutationResult,
  ProviderOverview,
  ProviderStatusRefreshMessage,
  ProviderStatusView,
  ProviderSubmitApiKeyMessage,
} from '../../shared/types/ipc';
import { emitOrchidEvent } from '../utils/events';

export type ProviderLoadStatus = 'loading' | 'ready' | 'error';

export interface ProvidersState {
  readonly status: ProviderLoadStatus;
  readonly overview: ProviderOverview | null;
  readonly error: string | null;
}

export interface UseProvidersReturn {
  readonly state: ProvidersState;
  readonly overview: ProviderOverview | null;
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly hasUsableConnection: boolean;
  /**
   * Shared model catalog for the full overview (null until ensureModelList
   * has resolved at least once for the current overview epoch).
   */
  readonly modelOptions: readonly ProviderModelOption[] | null;
  readonly refresh: () => Promise<ProviderOverview | null>;
  /**
   * Ensures overview is ready and the shared model list is populated.
   * Resolves with the catalog (possibly empty). Coalesces concurrent callers.
   */
  readonly ensureModelList: () => Promise<readonly ProviderModelOption[]>;
  readonly clearError: () => void;
  readonly createConnection: (
    message: ProviderConnectionCreateMessage,
  ) => Promise<ProviderMutationResult>;
  readonly updateConnection: (
    message: ProviderConnectionUpdateMessage,
  ) => Promise<ProviderMutationResult>;
  /** One-shot secret write. The result is redacted and contains no key/handle. */
  readonly submitApiKey: (message: ProviderSubmitApiKeyMessage) => Promise<ProviderMutationResult>;
  readonly validateConnection: (
    message: ProviderConnectionIdMessage,
  ) => Promise<ProviderMutationResult>;
  readonly disableConnection: (
    message: ProviderConnectionIdMessage,
  ) => Promise<ProviderMutationResult>;
  readonly enableConnection: (
    message: ProviderConnectionIdMessage,
  ) => Promise<ProviderMutationResult>;
  readonly disconnectConnection: (
    message: ProviderDisconnectMessage,
  ) => Promise<ProviderMutationResult>;
  readonly modelList: (
    message?: ProviderConnectionIdMessage,
  ) => Promise<readonly ProviderModelOption[]>;
  readonly refreshStatus: (
    message: ProviderStatusRefreshMessage,
  ) => Promise<ProviderStatusView | null>;
}

const INITIAL_STATE: ProvidersState = {
  status: 'loading',
  overview: null,
  error: null,
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Provider setup could not be completed.';
}

function unavailableApiError(): Error {
  return new Error('The provider connection API is not available in this build.');
}

function announceProviderUpdate(): void {
  emitOrchidEvent('orchid:providers-updated');
}

// ── Shared store (one overview for all useProviders() callers) ───────────────

type Listener = () => void;

interface SharedSnapshot {
  readonly state: ProvidersState;
  readonly modelOptions: readonly ProviderModelOption[] | null;
}

let sharedState: ProvidersState = INITIAL_STATE;
/** Full model catalog for current overview epoch; null = not fetched yet. */
let sharedModelOptions: readonly ProviderModelOption[] | null = null;
/** Stable snapshot for useSyncExternalStore (Object.is between emits). */
let cachedSnapshot: SharedSnapshot = {
  state: sharedState,
  modelOptions: sharedModelOptions,
};
let overviewEpoch = 0;
let modelListEpoch = -1;
let inFlightRefresh: Promise<ProviderOverview | null> | null = null;
let inFlightModelList: Promise<readonly ProviderModelOption[]> | null = null;
let bootstrapped = false;
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener();
}

function rebuildSnapshot(): void {
  cachedSnapshot = { state: sharedState, modelOptions: sharedModelOptions };
  emit();
}

function setSharedState(next: ProvidersState | ((previous: ProvidersState) => ProvidersState)): void {
  const previous = sharedState;
  sharedState = typeof next === 'function' ? next(previous) : next;
  if (sharedState === previous) return;
  rebuildSnapshot();
}

function setSharedModelOptions(next: readonly ProviderModelOption[] | null): void {
  if (sharedModelOptions === next) return;
  sharedModelOptions = next;
  rebuildSnapshot();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): SharedSnapshot {
  return cachedSnapshot;
}

function invalidateModelList(): void {
  modelListEpoch = -1;
  // Keep in-flight promise; its epoch check will no-op on publish.
  if (sharedModelOptions !== null) {
    sharedModelOptions = null;
    rebuildSnapshot();
  } else {
    modelListEpoch = -1;
  }
}

async function refreshShared(): Promise<ProviderOverview | null> {
  if (!window.orchid?.providers?.list) {
    const error = unavailableApiError();
    setSharedState((previous) => ({
      ...previous,
      status: previous.overview ? 'ready' : 'error',
      error: errorMessage(error),
    }));
    return null;
  }

  if (inFlightRefresh) return inFlightRefresh;

  const epoch = ++overviewEpoch;
  invalidateModelList();
  setSharedState((previous) => ({
    ...previous,
    status: previous.overview ? 'ready' : 'loading',
    error: null,
  }));

  const flightHolder: { current: Promise<ProviderOverview | null> | null } = { current: null };
  const flight = (async () => {
    try {
      const overview = await window.orchid!.providers!.list();
      if (epoch === overviewEpoch) {
        setSharedState({ status: 'ready', overview, error: null });
      }
      return overview;
    } catch (error) {
      if (epoch === overviewEpoch) {
        setSharedState((previous) => ({
          ...previous,
          status: previous.overview ? 'ready' : 'error',
          error: errorMessage(error),
        }));
      }
      return null;
    } finally {
      if (inFlightRefresh === flightHolder.current) inFlightRefresh = null;
    }
  })();
  flightHolder.current = flight;
  inFlightRefresh = flight;

  return flight;
}

async function ensureModelListShared(): Promise<readonly ProviderModelOption[]> {
  if (!window.orchid?.providers?.modelList) {
    setSharedModelOptions([]);
    modelListEpoch = overviewEpoch;
    return [];
  }

  if (sharedModelOptions != null && modelListEpoch === overviewEpoch) {
    return sharedModelOptions;
  }
  if (inFlightModelList) return inFlightModelList;

  const flightHolder: { current: Promise<readonly ProviderModelOption[]> | null } = { current: null };
  const flight = (async () => {
    try {
      if (!sharedState.overview) {
        await refreshShared();
      }
      // Capture epoch only after overview is current so a cold refresh does not
      // discard a successful modelList write.
      const epoch = overviewEpoch;
      if (!window.orchid?.providers?.modelList) {
        if (epoch === overviewEpoch) {
          setSharedModelOptions([]);
          modelListEpoch = overviewEpoch;
        }
        return [];
      }
      const options = await window.orchid.providers.modelList();
      if (epoch === overviewEpoch) {
        setSharedModelOptions(options);
        modelListEpoch = overviewEpoch;
        return options;
      }
      // Overview changed mid-flight — retry against the new epoch.
      return ensureModelListShared();
    } catch {
      // Leave modelOptions null so callers can retry; do not cache [] as success.
      return sharedModelOptions ?? [];
    } finally {
      if (inFlightModelList === flightHolder.current) inFlightModelList = null;
    }
  })();
  flightHolder.current = flight;
  inFlightModelList = flight;

  return flight;
}

function ensureBootstrapped(): void {
  if (bootstrapped) return;
  bootstrapped = true;
  void refreshShared();
}

function applyMutationToShared(result: ProviderMutationResult): void {
  overviewEpoch += 1;
  invalidateModelList();
  announceProviderUpdate();
  setSharedState((previous) => {
    if (!previous.overview) return previous;
    const hasConnection = previous.overview.connections.some(
      (connection) => connection.id === result.connection.id,
    );
    const connections: readonly ProviderConnectionView[] = hasConnection
      ? previous.overview.connections.map((connection) =>
          connection.id === result.connection.id ? result.connection : connection,
        )
      : [...previous.overview.connections, result.connection];
    return {
      status: 'ready',
      error: null,
      overview: { ...previous.overview, connections },
    };
  });
}

function applyStatusToShared(observation: ProviderStatusView): void {
  // Status observations do not change the model catalog — keep modelListEpoch.
  announceProviderUpdate();
  setSharedState((previous) => {
    if (!previous.overview) return previous;
    const hasObservation = previous.overview.statuses.some(
      (status) => status.providerId === observation.providerId
        && status.connectionId === observation.connectionId,
    );
    const statuses = hasObservation
      ? previous.overview.statuses.map((status) =>
          status.providerId === observation.providerId && status.connectionId === observation.connectionId
            ? observation
            : status,
        )
      : [...previous.overview.statuses, observation];
    return {
      status: 'ready',
      error: null,
      overview: { ...previous.overview, statuses },
    };
  });
}

/** Test-only access to the shared cache (not for product code). */
export const __providersCacheTest = {
  reset(): void {
    sharedState = INITIAL_STATE;
    sharedModelOptions = null;
    cachedSnapshot = { state: sharedState, modelOptions: sharedModelOptions };
    overviewEpoch = 0;
    modelListEpoch = -1;
    inFlightRefresh = null;
    inFlightModelList = null;
    bootstrapped = false;
    listeners.clear();
  },
  getState: () => sharedState,
  getModelOptions: () => sharedModelOptions,
  getSnapshot,
  refresh: refreshShared,
  ensureModelList: ensureModelListShared,
  subscribe,
};

/**
 * Keeps provider settings, onboarding, and model selection synchronised after
 * mutations without exposing a broad renderer-side persistence API.
 */
export function useProviders(): UseProvidersReturn {
  ensureBootstrapped();
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const state = snapshot.state;
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const setActionError = useCallback((error: unknown) => {
    if (!mountedRef.current) return;
    setSharedState((previous) => ({
      ...previous,
      status: previous.overview ? 'ready' : 'error',
      error: errorMessage(error),
    }));
  }, []);

  const refresh = useCallback(async (): Promise<ProviderOverview | null> => {
    return refreshShared();
  }, []);

  const ensureModelList = useCallback(async (): Promise<readonly ProviderModelOption[]> => {
    return ensureModelListShared();
  }, []);

  const applyMutation = useCallback((result: ProviderMutationResult) => {
    applyMutationToShared(result);
  }, []);

  const runMutation = useCallback(
    async <T>(
      operation: (providers: NonNullable<typeof window.orchid>['providers']) => Promise<T>,
      onSuccess?: (value: T) => void,
    ): Promise<T> => {
      if (!window.orchid?.providers) {
        const error = unavailableApiError();
        setActionError(error);
        throw error;
      }
      try {
        const value = await operation(window.orchid.providers);
        onSuccess?.(value);
        return value;
      } catch (error) {
        setActionError(error);
        throw error;
      }
    },
    [setActionError],
  );

  const createConnection = useCallback(
    (message: ProviderConnectionCreateMessage) =>
      runMutation((providers) => providers.create(message), applyMutation),
    [applyMutation, runMutation],
  );

  const updateConnection = useCallback(
    (message: ProviderConnectionUpdateMessage) =>
      runMutation((providers) => providers.update(message), applyMutation),
    [applyMutation, runMutation],
  );

  const submitApiKey = useCallback(
    (message: ProviderSubmitApiKeyMessage) =>
      runMutation((providers) => providers.submitApiKey(message), applyMutation),
    [applyMutation, runMutation],
  );

  const validateConnection = useCallback(
    (message: ProviderConnectionIdMessage) =>
      runMutation((providers) => providers.validate(message), applyMutation),
    [applyMutation, runMutation],
  );

  const disableConnection = useCallback(
    (message: ProviderConnectionIdMessage) =>
      runMutation((providers) => providers.disable(message), applyMutation),
    [applyMutation, runMutation],
  );

  const enableConnection = useCallback(
    (message: ProviderConnectionIdMessage) =>
      runMutation((providers) => providers.enable(message), applyMutation),
    [applyMutation, runMutation],
  );

  const disconnectConnection = useCallback(
    (message: ProviderDisconnectMessage) =>
      runMutation((providers) => providers.disconnect(message), applyMutation),
    [applyMutation, runMutation],
  );

  const modelList = useCallback(
    (message?: ProviderConnectionIdMessage) =>
      runMutation((providers) => providers.modelList(message)),
    [runMutation],
  );

  const refreshStatus = useCallback(
    (message: ProviderStatusRefreshMessage) =>
      runMutation(
        (providers) => providers.refreshStatus(message),
        (observation) => {
          if (observation) applyStatusToShared(observation);
        },
      ),
    [runMutation],
  );

  const clearError = useCallback(() => {
    if (!mountedRef.current) return;
    setSharedState((previous) => ({ ...previous, error: null }));
  }, []);

  const hasUsableConnection = useMemo(
    () => state.overview?.connections.some((connection) => connection.health === 'ready') ?? false,
    [state.overview],
  );

  return {
    state,
    overview: state.overview,
    isLoading: state.status === 'loading',
    error: state.error,
    hasUsableConnection,
    modelOptions: snapshot.modelOptions,
    refresh,
    ensureModelList,
    clearError,
    createConnection,
    updateConnection,
    submitApiKey,
    validateConnection,
    disableConnection,
    enableConnection,
    disconnectConnection,
    modelList,
    refreshStatus,
  };
}
