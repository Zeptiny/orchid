import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';

const RIGHT_PANEL_OVERLAY_QUERY = '(max-width: 1019px)';
const LEFT_PANEL_OVERLAY_QUERY = '(max-width: 859px)';

interface ResponsiveShellInput {
  rightConstrained: boolean;
  leftConstrained: boolean;
  rightExpandedPreference: boolean;
  leftCollapsedPreference: boolean;
  rightOverlayOpen: boolean;
  leftOverlayOpen: boolean;
}

interface ResponsiveShellLayout {
  rightOpen: boolean;
  leftCollapsed: boolean;
  rightOverlay: boolean;
  leftOverlay: boolean;
  rightTrack: '300px' | '48px';
  leftTrack: '260px' | '56px';
}

interface ResponsiveShellState extends ResponsiveShellLayout {
  toggleRight: () => void;
  toggleLeft: () => void;
  openRight: () => void;
  openLeft: () => void;
}

function useMediaQuery(query: string): boolean {
  const mediaQuery = useMemo(
    () => (
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia(query)
        : null
    ),
    [query],
  );
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!mediaQuery) return () => {};
      mediaQuery.addEventListener('change', onStoreChange);
      return () => mediaQuery.removeEventListener('change', onStoreChange);
    },
    [mediaQuery],
  );
  const getSnapshot = useCallback(() => mediaQuery?.matches ?? false, [mediaQuery]);

  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

/** Resolve visible panels and grid tracks without mutating wide-screen preferences. */
export function resolveResponsiveShell(input: ResponsiveShellInput): ResponsiveShellLayout {
  const rightOpen = input.rightConstrained
    ? input.rightOverlayOpen
    : input.rightExpandedPreference;
  const leftCollapsed = input.leftConstrained
    ? !input.leftOverlayOpen
    : input.leftCollapsedPreference;

  return {
    rightOpen,
    leftCollapsed,
    rightOverlay: input.rightConstrained,
    leftOverlay: input.leftConstrained,
    rightTrack: input.rightConstrained || !rightOpen ? '48px' : '300px',
    leftTrack: input.leftConstrained || leftCollapsed ? '56px' : '260px',
  };
}

/** Own responsive overlay state while preserving the user's wide-screen panel choices. */
export function useResponsiveShell(): ResponsiveShellState {
  const rightConstrained = useMediaQuery(RIGHT_PANEL_OVERLAY_QUERY);
  const leftConstrained = useMediaQuery(LEFT_PANEL_OVERLAY_QUERY);
  const [rightExpandedPreference, setRightExpandedPreference] = useState(true);
  const [leftCollapsedPreference, setLeftCollapsedPreference] = useState(false);
  const [rightOverlayOpen, setRightOverlayOpen] = useState(false);
  const [leftOverlayOpen, setLeftOverlayOpen] = useState(false);

  useEffect(() => {
    setRightOverlayOpen(false);
  }, [rightConstrained]);

  useEffect(() => {
    setLeftOverlayOpen(false);
  }, [leftConstrained]);

  const toggleRight = useCallback(() => {
    if (rightConstrained) {
      setLeftOverlayOpen(false);
      setRightOverlayOpen((open) => !open);
      return;
    }
    setRightExpandedPreference((expanded) => !expanded);
  }, [rightConstrained]);

  const toggleLeft = useCallback(() => {
    if (leftConstrained) {
      setRightOverlayOpen(false);
      setLeftOverlayOpen((open) => !open);
      return;
    }
    setLeftCollapsedPreference((collapsed) => !collapsed);
  }, [leftConstrained]);

  const openRight = useCallback(() => {
    if (rightConstrained) {
      setLeftOverlayOpen(false);
      setRightOverlayOpen(true);
      return;
    }
    setRightExpandedPreference(true);
  }, [rightConstrained]);

  const openLeft = useCallback(() => {
    if (leftConstrained) {
      setRightOverlayOpen(false);
      setLeftOverlayOpen(true);
      return;
    }
    setLeftCollapsedPreference(false);
  }, [leftConstrained]);

  return {
    ...resolveResponsiveShell({
      rightConstrained,
      leftConstrained,
      rightExpandedPreference,
      leftCollapsedPreference,
      rightOverlayOpen,
      leftOverlayOpen,
    }),
    toggleRight,
    toggleLeft,
    openRight,
    openLeft,
  };
}
