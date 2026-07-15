import { useCallback, useEffect, useState } from 'react';
import type { WorkingSetSnapshot } from '../../shared/types/ipc';

const EMPTY: WorkingSetSnapshot = {
  openSessionIds: [],
  focusedSessionId: null,
  mruSessionIds: [],
};

export interface UseSessionTabsReturn {
  snapshot: WorkingSetSnapshot;
  ready: boolean;
  refresh: () => Promise<WorkingSetSnapshot>;
  openOrFocus: (id: string) => Promise<WorkingSetSnapshot>;
  closeTab: (id: string) => Promise<WorkingSetSnapshot>;
  removeTab: (id: string) => Promise<WorkingSetSnapshot>;
  setFocus: (id: string | null) => Promise<WorkingSetSnapshot>;
}

export function useSessionTabs(): UseSessionTabsReturn {
  const [snapshot, setSnapshot] = useState<WorkingSetSnapshot>(EMPTY);
  const [ready, setReady] = useState(false);

  const refresh = useCallback(async () => {
    if (!window.orchid?.session?.getWorkingSet) {
      setReady(true);
      return EMPTY;
    }
    try {
      const next = await window.orchid.session.getWorkingSet();
      setSnapshot(next);
      setReady(true);
      return next;
    } catch {
      setReady(true);
      return EMPTY;
    }
  }, []);

  useEffect(() => {
    void refresh();
    if (!window.orchid?.session?.onWorkingSetChanged) return undefined;
    return window.orchid.session.onWorkingSetChanged((event) => {
      setSnapshot(event.snapshot);
      setReady(true);
    });
  }, [refresh]);

  const openOrFocus = useCallback(async (id: string) => {
    if (!window.orchid?.session?.openOrFocusTab) return EMPTY;
    const next = await window.orchid.session.openOrFocusTab({ id });
    setSnapshot(next);
    return next;
  }, []);

  const closeTab = useCallback(async (id: string) => {
    if (!window.orchid?.session?.closeTab) return EMPTY;
    const next = await window.orchid.session.closeTab({ id });
    setSnapshot(next);
    return next;
  }, []);

  const removeTab = useCallback(async (id: string) => {
    if (!window.orchid?.session?.removeTab) return EMPTY;
    const next = await window.orchid.session.removeTab({ id });
    setSnapshot(next);
    return next;
  }, []);

  const setFocus = useCallback(async (id: string | null) => {
    if (!window.orchid?.session?.setTabFocus) return EMPTY;
    const next = await window.orchid.session.setTabFocus({ id });
    setSnapshot(next);
    return next;
  }, []);

  return {
    snapshot,
    ready,
    refresh,
    openOrFocus,
    closeTab,
    removeTab,
    setFocus,
  };
}
