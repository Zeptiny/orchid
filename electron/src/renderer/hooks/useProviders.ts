/**
 * Connection-centred provider state for renderer surfaces.
 *
 * This hook deliberately works only with the redacted provider IPC API. It
 * never receives credential handles, reusable secret values, or driver-owned
 * endpoint configuration.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  readonly refresh: () => Promise<ProviderOverview | null>;
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

/** Notify independent renderer surfaces without putting provider data in an event. */
function announceProviderUpdate(): void {
  window.dispatchEvent(new CustomEvent('orchid:providers-updated'));
}

/**
 * Keeps provider settings, onboarding, and model selection synchronised after
 * mutations without exposing a broad renderer-side persistence API.
 */
export function useProviders(): UseProvidersReturn {
  const [state, setState] = useState<ProvidersState>(INITIAL_STATE);
  const mountedRef = useRef(true);
  /** Invalidates stale list responses after a successful mutation. */
  const overviewEpochRef = useRef(0);

  useEffect(() => {
    // React development StrictMode mounts, cleans up, and mounts effects once
    // more. Resetting here keeps asynchronous IPC state updates live then.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const setActionError = useCallback((error: unknown) => {
    if (!mountedRef.current) return;
    setState((previous) => ({
      ...previous,
      status: previous.overview ? 'ready' : 'error',
      error: errorMessage(error),
    }));
  }, []);

  const refresh = useCallback(async (): Promise<ProviderOverview | null> => {
    if (!window.orchid?.providers?.list) {
      const error = unavailableApiError();
      setActionError(error);
      return null;
    }

    const epoch = ++overviewEpochRef.current;
    if (mountedRef.current) {
      setState((previous) => ({
        ...previous,
        status: previous.overview ? 'ready' : 'loading',
        error: null,
      }));
    }

    try {
      const overview = await window.orchid.providers.list();
      if (mountedRef.current && epoch === overviewEpochRef.current) {
        setState({ status: 'ready', overview, error: null });
      }
      return overview;
    } catch (error) {
      if (mountedRef.current && epoch === overviewEpochRef.current) {
        setState((previous) => ({
          ...previous,
          status: previous.overview ? 'ready' : 'error',
          error: errorMessage(error),
        }));
      }
      return null;
    }
  }, [setActionError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const applyMutation = useCallback((result: ProviderMutationResult) => {
    overviewEpochRef.current += 1;
    announceProviderUpdate();
    if (!mountedRef.current) return;
    setState((previous) => {
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
          overviewEpochRef.current += 1;
          if (observation) announceProviderUpdate();
          if (!observation || !mountedRef.current) return;
          setState((previous) => {
            if (!previous.overview) return previous;
            const hasObservation = previous.overview.statuses.some(
              (status) => status.providerId === observation.providerId,
            );
            const statuses = hasObservation
              ? previous.overview.statuses.map((status) =>
                  status.providerId === observation.providerId ? observation : status,
                )
              : [...previous.overview.statuses, observation];
            return {
              status: 'ready',
              error: null,
              overview: { ...previous.overview, statuses },
            };
          });
        },
      ),
    [runMutation],
  );

  const clearError = useCallback(() => {
    if (!mountedRef.current) return;
    setState((previous) => ({ ...previous, error: null }));
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
    refresh,
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
