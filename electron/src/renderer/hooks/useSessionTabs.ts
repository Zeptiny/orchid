import { useCallback, useEffect, useRef, useState } from 'react';
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
  const epochRef = useRef(0);

  const applySnapshot = useCallback((next: WorkingSetSnapshot, epoch: number) => {
    if (epoch < epochRef.current) return;
    epochRef.current = epoch;
    setSnapshot(next);
    setReady(true);
  }, []);

  const refresh = useCallback(async () => {
    if (!window.orchid?.session?.getWorkingSet) {
      setReady(true);
      return EMPTY;
    }
    const epoch = ++epochRef.current;
    try {
      const next = await window.orchid.session.getWorkingSet();
      applySnapshot(next, epoch);
      return next;
    } catch {
      if (epoch >= epochRef.current) setReady(true);
      return EMPTY;
    }
  }, [applySnapshot]);

  useEffect(() => {
    void refresh();
    if (!window.orchid?.session?.onWorkingSetChanged) return undefined;
    return window.orchid.session.onWorkingSetChanged((event) => {
      applySnapshot(event.snapshot, ++epochRef.current);
    });
  }, [refresh, applySnapshot]);

  const openOrFocus = useCallback(async (id: string) => {
    if (!window.orchid?.session?.openOrFocusTab) return EMPTY;
    const epoch = ++epochRef.current;
    const next = await window.orchid.session.openOrFocusTab({ id });
    applySnapshot(next, epoch);
    return next;
  }, [applySnapshot]);

  const closeTab = useCallback(async (id: string) => {
    if (!window.orchid?.session?.closeTab) return EMPTY;
    const epoch = ++epochRef.current;
    const next = await window.orchid.session.closeTab({ id });
    applySnapshot(next, epoch);
    return next;
  }, [applySnapshot]);

  const removeTab = useCallback(async (id: string) => {
    if (!window.orchid?.session?.removeTab) return EMPTY;
    const epoch = ++epochRef.current;
    const next = await window.orchid.session.removeTab({ id });
    applySnapshot(next, epoch);
    return next;
  }, [applySnapshot]);

  const setFocus = useCallback(async (id: string | null) => {
    if (!window.orchid?.session?.setTabFocus) return EMPTY;
    const epoch = ++epochRef.current;
    const next = await window.orchid.session.setTabFocus({ id });
    applySnapshot(next, epoch);
    return next;
  }, [applySnapshot]);

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
