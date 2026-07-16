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
  const acceptedRef = useRef<WorkingSetSnapshot>(EMPTY);

  const applySnapshot = useCallback((next: WorkingSetSnapshot, epoch: number): boolean => {
    if (epoch < epochRef.current) return false;
    epochRef.current = epoch;
    acceptedRef.current = next;
    setSnapshot(next);
    setReady(true);
    return true;
  }, []);

  const refresh = useCallback(async () => {
    if (!window.orchid?.session?.getWorkingSet) {
      setReady(true);
      return acceptedRef.current;
    }
    const epoch = ++epochRef.current;
    try {
      const next = await window.orchid.session.getWorkingSet();
      if (!applySnapshot(next, epoch)) return acceptedRef.current;
      return next;
    } catch {
      if (epoch >= epochRef.current) setReady(true);
      return acceptedRef.current;
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
    if (!window.orchid?.session?.openOrFocusTab) return acceptedRef.current;
    const epoch = ++epochRef.current;
    try {
      const next = await window.orchid.session.openOrFocusTab({ id });
      if (!applySnapshot(next, epoch)) return acceptedRef.current;
      return next;
    } catch {
      return acceptedRef.current;
    }
  }, [applySnapshot]);

  const closeTab = useCallback(async (id: string) => {
    if (!window.orchid?.session?.closeTab) return acceptedRef.current;
    const epoch = ++epochRef.current;
    try {
      const next = await window.orchid.session.closeTab({ id });
      if (!applySnapshot(next, epoch)) return acceptedRef.current;
      return next;
    } catch {
      return acceptedRef.current;
    }
  }, [applySnapshot]);

  const removeTab = useCallback(async (id: string) => {
    if (!window.orchid?.session?.removeTab) return acceptedRef.current;
    const epoch = ++epochRef.current;
    try {
      const next = await window.orchid.session.removeTab({ id });
      if (!applySnapshot(next, epoch)) return acceptedRef.current;
      return next;
    } catch {
      return acceptedRef.current;
    }
  }, [applySnapshot]);

  const setFocus = useCallback(async (id: string | null) => {
    if (!window.orchid?.session?.setTabFocus) return acceptedRef.current;
    const epoch = ++epochRef.current;
    try {
      const next = await window.orchid.session.setTabFocus({ id });
      if (!applySnapshot(next, epoch)) return acceptedRef.current;
      return next;
    } catch {
      return acceptedRef.current;
    }
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
