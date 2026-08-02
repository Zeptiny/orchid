import { useCallback, useEffect, useState } from 'react';

interface AnalyticsDataState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

export function useAnalytics<T>(
  fetcher: () => Promise<T>,
  deps: ReadonlyArray<unknown> = [],
): AnalyticsDataState<T> & { refresh: () => void } {
  const [state, setState] = useState<AnalyticsDataState<T>>({
    data: null,
    loading: true,
    error: null,
  });
  const [refreshKey, setRefreshKey] = useState(0);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;
    setState((prev) => ({ ...prev, loading: true, error: null }));
    fetcher()
      .then((data) => {
        if (!cancelled) setState({ data, loading: false, error: null });
      })
      .catch((err) => {
        if (!cancelled) {
          setState({ data: null, loading: false, error: err instanceof Error ? err.message : String(err) });
        }
      });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey, ...deps]);

  return { ...state, refresh };
}
